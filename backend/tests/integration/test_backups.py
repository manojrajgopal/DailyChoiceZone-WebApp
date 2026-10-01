"""
Database backups: made, encrypted, stored privately, verified by reading them
back, kept by tier and deleted when they expire (never the newest good one),
failures recorded and reported, and only the right people can reach them.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.core import rate_limit
from app.models import DatabaseBackup, Notification
from app.services import backups

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def vault(tmp_path, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "BACKUP_STORAGE", "local")
    monkeypatch.setattr(settings, "BACKUP_LOCAL_DIR", str(tmp_path / "backups"))
    monkeypatch.setattr(settings, "BACKUP_ENCRYPTION_KEY", "test-backup-key-0123456789")
    return tmp_path / "backups"


def make(db, *, started, tier="daily", status="succeeded", vault=None):
    reference = f"BKP-TEST-{started:%Y%m%d%H%M%S}-{tier}"
    location = f"{reference}.sql.gz.enc"
    if vault is not None and status == "succeeded":
        vault.mkdir(parents=True, exist_ok=True)
        (vault / location).write_bytes(b"x" * 100)
    row = DatabaseBackup(reference=reference, trigger="scheduled", tier=tier, status=status, database_name="t",
                         storage="local", location=location, size_bytes=100, checksum_sha256="0" * 64,
                         encrypted=True, tables=1, rows=1, started_at=started, completed_at=started)
    db.add(row)
    db.flush()
    return row


class TestMaking:
    def test_a_backup_is_made_encrypted_verified_and_readable(self, db, catalogue, vault):
        row = backups.run_backup(db, trigger="manual")
        assert row.status == "succeeded", row.error
        assert row.encrypted and row.tables > 50 and row.rows > 0 and row.verified_at
        stored = vault / row.location
        assert stored.exists() and stored.stat().st_size == row.size_bytes
        assert stored.read_bytes().startswith(backups.MAGIC)  # encrypted, not plain gzip
        with open(stored, "rb") as handle:
            sql = "".join(backups.sql_lines(handle))
        assert "CREATE TABLE `products`" in sql and "Cotton Kurta" in sql
        assert sql.rstrip().splitlines()[-1].startswith(backups.FOOTER)

    def test_the_file_never_contains_the_database_password(self, db, catalogue, vault):
        from app.core.config import settings

        row = backups.run_backup(db, trigger="manual")
        with open(vault / row.location, "rb") as handle:
            sql = "".join(backups.sql_lines(handle))
        if settings.DATABASE_PASSWORD and len(settings.DATABASE_PASSWORD) > 3:
            assert settings.DATABASE_PASSWORD not in sql

    def test_a_wrong_key_cannot_read_it(self, db, catalogue, vault, monkeypatch):
        from app.core.config import settings

        row = backups.run_backup(db, trigger="manual")
        monkeypatch.setattr(settings, "BACKUP_ENCRYPTION_KEY", "another-key")
        with pytest.raises(backups.BackupError):
            with open(vault / row.location, "rb") as handle:
                list(backups.sql_lines(handle))

    def test_a_tampered_file_fails_verification(self, db, catalogue, vault):
        row = backups.run_backup(db, trigger="manual")
        path = vault / row.location
        data = bytearray(path.read_bytes())
        data[-5] ^= 0xFF
        path.write_bytes(bytes(data))
        with pytest.raises(backups.BackupError):
            backups._verify(backups.storage(), row.location, checksum=row.checksum_sha256, tables=row.tables)

    def test_a_failure_is_recorded_and_the_team_told(self, db, admin, vault, monkeypatch):
        def broken():
            raise backups.BackupError("The disk is full.")

        monkeypatch.setattr(backups, "storage", lambda name=None: broken())
        row = backups.run_backup(db, trigger="manual")
        assert row.status == "failed" and "disk is full" in row.error
        assert db.query(Notification).filter_by(kind="backup").count() == 1

    def test_the_lock_is_released_so_the_next_backup_runs(self, db, catalogue, vault):
        """A lock left held made every later backup "already running"."""
        first = backups.run_backup(db, trigger="manual")
        second = backups.run_backup(db, trigger="manual")
        assert first.status == second.status == "succeeded"
        assert first.reference != second.reference

    def test_only_one_runs_at_a_time(self, db, vault):
        from sqlalchemy import create_engine, text

        from app.core.config import settings

        database = db.get_bind().engine.url.database
        name = f"{backups.LOCK_NAME}:{database}"
        other = create_engine(f"{settings.server_url}/{database}").connect()
        try:
            assert other.execute(text("SELECT GET_LOCK(:n, 0)"), {"n": name}).scalar() == 1
            from app.core.errors import ConflictError

            with pytest.raises(ConflictError):
                backups.run_backup(db, trigger="manual")
        finally:
            other.execute(text("SELECT RELEASE_LOCK(:n)"), {"n": name})
            other.close()


class TestScheduleAndRetention:
    def test_the_schedule(self, db, admin):
        now = datetime(2026, 10, 5, 10, 0)  # 15:30 IST
        backups.save_settings(db, admin, {"frequency": "6h"})
        assert backups.next_run(db, now) == now  # nothing yet: due now
        make(db, started=now - timedelta(hours=2))
        db.query(DatabaseBackup).update({"trigger": "scheduled"})
        assert backups.next_run(db, now) == now + timedelta(hours=4)
        backups.save_settings(db, admin, {"frequency": "daily", "hour": 2})
        assert backups.next_run(db, now) == datetime(2026, 10, 5, 20, 30)  # 02:00 IST tomorrow
        backups.save_settings(db, admin, {"enabled": False})
        assert backups.next_run(db, now) is None

    def test_settings_are_validated(self, db, admin):
        from app.core.errors import ValidationError

        with pytest.raises(ValidationError):
            backups.save_settings(db, admin, {"frequency": "hourly"})
        with pytest.raises(ValidationError):
            backups.save_settings(db, admin, {"keepDailyDays": 0})

    def test_retention_keeps_by_tier_and_never_the_newest_good_one(self, db, admin, vault):
        now = datetime.utcnow()
        backups.save_settings(db, admin, {"keepDailyDays": 7, "keepWeeklyWeeks": 2})
        fresh = make(db, started=now - timedelta(days=1), vault=vault)
        old_daily = make(db, started=now - timedelta(days=10), vault=vault)
        weekly_kept = make(db, started=now - timedelta(days=10), tier="weekly", vault=vault)
        weekly_old = make(db, started=now - timedelta(days=20), tier="weekly", vault=vault)
        failed = make(db, started=now - timedelta(days=30), status="failed")
        db.commit()
        assert backups._apply_retention(db, now=now) == 2
        db.expire_all()
        status = {r.id: r.status for r in db.query(DatabaseBackup).all()}
        assert status[fresh.id] == "succeeded" and status[weekly_kept.id] == "succeeded"
        assert status[old_daily.id] == "deleted" and status[weekly_old.id] == "deleted"
        assert status[failed.id] == "failed"
        assert not (vault / old_daily.location).exists() and (vault / fresh.location).exists()

    def test_the_only_good_backup_is_kept_however_old(self, db, admin, vault):
        now = datetime.utcnow()
        only = make(db, started=now - timedelta(days=400), vault=vault)
        db.commit()
        assert backups._apply_retention(db, now=now) == 0
        db.expire_all()
        assert db.get(DatabaseBackup, only.id).status == "succeeded"


class TestPortal:
    def test_status_history_and_a_manual_backup(self, client, db, catalogue, admin_auth, vault):
        response = client.post("/api/admin/backups/run", headers=admin_auth)
        assert response.status_code == 200, response.text
        data = client.get("/api/admin/backups", headers=admin_auth).json()["data"]
        assert data["lastSuccess"]["status"] == "succeeded" and data["kept"] == 1 and data["encrypted"]
        assert data["items"][0]["checksum"] and data["nextRun"]
        assert "password" not in str(data).lower()

    def test_downloads_need_a_fresh_signed_link(self, client, db, catalogue, admin_auth, vault):
        backup_id = client.post("/api/admin/backups/run", headers=admin_auth).json()["data"]["id"]
        link = client.post(f"/api/admin/backups/{backup_id}/download", headers=admin_auth).json()["data"]
        assert link["expiresIn"] == 300
        url = link["url"]
        assert client.get(f"/api/admin/backups/{backup_id}/file?token=forged.1.abc").status_code == 404
        file = client.get(url)
        assert file.status_code == 200 and file.content.startswith(backups.MAGIC)
        token = url.split("token=")[1]
        admin_id, _, signature = token.split(".")
        expired = f"{admin_id}.{int(datetime.utcnow().timestamp()) - 10}.{signature}"
        assert client.get(f"/api/admin/backups/{backup_id}/file?token={expired}").status_code == 404

    def test_backups_are_the_super_admins_unless_granted(self, client, db, admin, editor, auth):
        token = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"}).json()
        headers = {"Authorization": f"Bearer {token['data']['token']['accessToken']}"}
        assert client.get("/api/admin/backups", headers=headers).status_code == 403
        assert client.post("/api/admin/backups/run", headers=headers).status_code == 403
        assert client.get("/api/admin/backups", headers=auth).status_code == 403
        from app.core.permissions import permissions_for

        assert "backups" not in permissions_for("admin")
