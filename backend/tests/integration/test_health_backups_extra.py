"""
System health and database backups, the edges: each check's healthy,
degraded, unhealthy and unknown states; the overall verdict; the backup
storage back-ends (a private folder and a fake S3), the encryption format, the
verification that refuses a bad file, the schedule and retention rules, the
signed download links, and the background sweeps.

Nothing here reaches the network or a real database dump: Razorpay's ping is
replaced, the S3 client is an in-memory fake, and the dump step is stubbed or
fed a fake connection. Backup files go to a temporary folder.
"""

from __future__ import annotations

import contextlib
import gzip
import io
import os
import secrets
import time
from collections import namedtuple
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from app.core import rate_limit
from app.core.config import settings
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import (
    AuditLog,
    DatabaseBackup,
    EmailLog,
    JobHeartbeat,
    Notification,
    NotificationDelivery,
    SettingDocument,
    WebhookEvent,
)
from app.services import backups, health

pytestmark = pytest.mark.integration

Usage = namedtuple("Usage", "total used free")


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def vault(tmp_path, monkeypatch):
    """Backups go to a temporary folder, encrypted with a test key."""
    monkeypatch.setattr(settings, "BACKUP_STORAGE", "local")
    monkeypatch.setattr(settings, "BACKUP_LOCAL_DIR", str(tmp_path / "backups"))
    monkeypatch.setattr(settings, "BACKUP_ENCRYPTION_KEY", "test-backup-key-0123456789")
    return tmp_path / "backups"


class FakeS3:
    """An in-memory bucket with the handful of calls the services make."""

    def __init__(self):
        self.objects = {}
        self.fail_delete = False
        self.fail_head_bucket = False

    def put_object(self, Bucket, Key, Body, **extra):
        self.objects[Key] = Body.read()
        self.last_put = {"Bucket": Bucket, "Key": Key, **extra}

    def get_object(self, Bucket, Key):
        return {"Body": io.BytesIO(self.objects[Key])}

    def head_object(self, Bucket, Key):
        if Key not in self.objects:
            raise KeyError(Key)
        return {"ContentLength": len(self.objects[Key])}

    def delete_object(self, Bucket, Key):
        if self.fail_delete:
            raise RuntimeError("access denied")
        self.objects.pop(Key, None)

    def generate_presigned_url(self, operation, Params, ExpiresIn):
        return f"https://bucket.example.com/{Params['Key']}?expires={ExpiresIn}"

    def head_bucket(self, Bucket):
        if self.fail_head_bucket:
            raise RuntimeError("no such bucket")
        return {}


@pytest.fixture()
def s3(monkeypatch, tmp_path):
    from app.services import storage

    fake = FakeS3()
    monkeypatch.setattr(storage, "_client", lambda *a, **k: fake)
    monkeypatch.setattr(settings, "BACKUP_STORAGE", "s3")
    monkeypatch.setattr(settings, "BACKUP_S3_BUCKET", "dcz-backups-test")
    monkeypatch.setattr(settings, "BACKUP_S3_PREFIX", "database-backups")
    monkeypatch.setattr(settings, "AWS_ACCESS_KEY_ID", "AKIATESTKEY")
    monkeypatch.setattr(settings, "AWS_SECRET_ACCESS_KEY", "test-secret-access-key")
    monkeypatch.setattr(settings, "BACKUP_ENCRYPTION_KEY", "test-backup-key-0123456789")
    return fake


def fake_dump(connection, out):
    """A small but complete dump: one table, its rows, the closing line."""
    out.write("-- Daily Choice Zone database backup\n-- Table: products\n")
    out.write("INSERT INTO `products` VALUES ('" + secrets.token_hex(120) + "');\n")
    out.write(f"{backups.FOOTER} 1 tables, 3 rows\n")
    return 1, 3


def make(db, *, started, tier="daily", status="succeeded", trigger="scheduled", storage="local", vault=None):
    reference = f"BKP-X-{started:%Y%m%d%H%M%S}-{tier}-{secrets.token_hex(2)}"
    location = f"{reference}.sql.gz.enc"
    if vault is not None and status == "succeeded":
        vault.mkdir(parents=True, exist_ok=True)
        (vault / location).write_bytes(b"x" * 100)
    row = DatabaseBackup(reference=reference, trigger=trigger, tier=tier, status=status, database_name="t",
                         storage=storage, location=location, size_bytes=100, checksum_sha256="0" * 64,
                         encrypted=True, tables=1, rows=1, started_at=started, completed_at=started, error="")
    db.add(row)
    db.flush()
    return row


def save_backup_settings(db, **values):
    conf = {**backups.DEFAULTS, **values}
    row = db.get(SettingDocument, "backups")
    if row is None:
        db.add(SettingDocument(key="backups", value=conf))
    else:
        row.value = conf
    db.flush()


def login(client, email, password="Admin@123"):
    response = client.post("/api/admin/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}


# =================================================================== health


class TestDatabaseAndSchemaChecks:
    def test_a_database_that_does_not_answer_is_unhealthy(self):
        class Down:
            def execute(self, *a, **k):
                raise RuntimeError("connection refused")

        result = health.check_database(Down())
        assert result == {"status": "unhealthy", "message": "The database isn't answering."}

    def test_a_slow_database_is_degraded(self, db, monkeypatch):
        monkeypatch.setattr(health, "_timed", lambda fn: (fn(), 1500))
        result = health.check_database(db)
        assert result["status"] == "degraded" and result["latencyMs"] == 1500

    def test_the_schema_heads_are_read_from_the_migration_scripts(self):
        heads = health._heads()
        assert heads and all(isinstance(h, str) and h for h in heads)

    def test_a_schema_at_the_head_is_healthy_and_one_behind_is_degraded(self, monkeypatch):
        class Versions:
            def __init__(self, rows):
                self.rows = rows

            def execute(self, *a, **k):
                return SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: self.rows))

        monkeypatch.setattr(health, "_heads", lambda: ["abc123"])
        assert health.check_migrations(Versions(["abc123"]))["status"] == "healthy"
        behind = health.check_migrations(Versions(["old000"]))
        assert behind["status"] == "degraded" and "migration" in behind["message"]

    def test_readiness_is_refused_while_the_database_is_down(self, monkeypatch, db):
        monkeypatch.setattr(health, "check_database", lambda db: {"status": "unhealthy", "message": "down"})
        ready, payload = health.readiness(db)
        assert ready is False and payload == {"status": "not-ready", "database": "unhealthy", "schema": "unknown"}


class TestPaymentsCheck:
    @pytest.fixture()
    def razorpay(self, monkeypatch):
        monkeypatch.setattr(settings, "PAYMENT_PROVIDER", "razorpay")
        monkeypatch.setattr(settings, "RAZOR_KEY_ID", "rzp_test_abc")
        monkeypatch.setattr(settings, "RAZOR_KEY_SECRET", "secret-xyz")
        monkeypatch.setattr(settings, "RAZOR_WEBHOOK_SECRET", "whsec")

    def test_test_payments_are_fine_in_development_but_not_in_production(self, db, monkeypatch):
        assert health.check_payments(db)["status"] == "healthy"
        monkeypatch.setattr(settings, "ENVIRONMENT", "production")
        assert health.check_payments(db)["status"] == "degraded"

    def test_no_provider_is_unknown(self, db, monkeypatch):
        monkeypatch.setattr(settings, "PAYMENT_PROVIDER", "")
        result = health.check_payments(db)
        assert result["status"] == "unknown" and result["facts"]["provider"] == "none"

    def test_razorpay_without_keys_is_unhealthy(self, db, monkeypatch):
        monkeypatch.setattr(settings, "PAYMENT_PROVIDER", "razorpay")
        monkeypatch.setattr(settings, "RAZOR_KEY_ID", "")
        monkeypatch.setattr(settings, "RAZOR_KEY_SECRET", "")
        assert health.check_payments(db)["status"] == "unhealthy"

    def test_razorpay_refusing_the_keys_is_unhealthy(self, db, razorpay, monkeypatch):
        monkeypatch.setattr(health, "_ping_razorpay", lambda: (False, 40))
        result = health.check_payments(db, deep=True)
        assert result["status"] == "unhealthy" and result["latencyMs"] == 40
        assert result["facts"]["mode"] == "test" and result["facts"]["webhookSecretSet"] is True

    def test_a_missing_webhook_secret_is_degraded(self, db, razorpay, monkeypatch):
        monkeypatch.setattr(settings, "RAZOR_WEBHOOK_SECRET", "")
        result = health.check_payments(db)
        assert result["status"] == "degraded" and "webhook secret" in result["message"]

    def test_failed_webhooks_in_the_last_day_are_degraded(self, db, razorpay):
        now = datetime.utcnow()
        for index in range(2):
            db.add(WebhookEvent(event_id=f"evt_fail_{index}", event="payment.captured", result="", received_at=now,
                                status="failed", attempts=1, duplicates=0, started_at=now, error="boom"))
        db.flush()
        result = health.check_payments(db)
        assert result["status"] == "degraded" and result["message"].startswith("2 payment webhooks failed")
        assert result["facts"]["failedWebhooks24h"] == 2

    def test_configured_and_answering_is_healthy(self, db, razorpay, monkeypatch):
        monkeypatch.setattr(settings, "RAZOR_KEY_ID", "rzp_live_abc")
        monkeypatch.setattr(health, "_ping_razorpay", lambda: (True, 12))
        result = health.check_payments(db, deep=True)
        assert result["status"] == "healthy" and result["message"].endswith("and answering.")
        assert result["facts"]["mode"] == "live"
        assert "rzp_live_abc" not in str(result) and "secret-xyz" not in str(result)

    def test_the_ping_sends_the_keys_only_in_the_header(self, monkeypatch, razorpay):
        import urllib.request

        seen = {}

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def urlopen(request, timeout):
            seen["url"], seen["auth"], seen["timeout"] = request.full_url, request.headers["Authorization"], timeout
            return Response()

        monkeypatch.setattr(urllib.request, "urlopen", urlopen)
        ok, latency = health._ping_razorpay()
        assert ok is True and latency >= 0
        assert seen["url"].startswith("https://api.razorpay.com/") and "secret" not in seen["url"]
        assert seen["auth"].startswith("Basic ") and seen["timeout"] == 5

    def test_a_ping_that_fails_reports_not_ok(self, monkeypatch, razorpay):
        import urllib.request

        def urlopen(request, timeout):
            raise OSError("network unreachable")

        monkeypatch.setattr(urllib.request, "urlopen", urlopen)
        ok, _ = health._ping_razorpay()
        assert ok is False


class TestEmailCheck:
    @pytest.fixture()
    def account(self, monkeypatch):
        from app.services import email as email_service

        monkeypatch.setattr(email_service, "active_account", lambda db: SimpleNamespace(provider="smtp"))

    def log(self, db, status, count):
        for _ in range(count):
            db.add(EmailLog(email_type="order", recipient="a@example.com", subject="s", status=status,
                            created_at=datetime.utcnow()))
        db.flush()

    def test_mostly_failing_is_unhealthy(self, db, account):
        self.log(db, "sent", 2)
        self.log(db, "failed", 3)
        result = health.check_email(db)
        assert result["status"] == "unhealthy" and result["message"].startswith("3 of 5")
        assert result["facts"]["provider"] == "smtp"

    def test_some_failing_is_degraded(self, db, account):
        self.log(db, "sent", 4)
        self.log(db, "failed", 1)
        assert health.check_email(db)["status"] == "degraded"

    def test_all_sent_is_healthy(self, db, account):
        self.log(db, "sent", 1)
        result = health.check_email(db)
        assert result["status"] == "healthy" and "1 email sent" in result["message"]


class TestStorageAndDisk:
    @pytest.fixture()
    def configured(self, monkeypatch):
        from app.services import storage

        fake = FakeS3()
        monkeypatch.setattr(storage, "is_configured", lambda: True)
        monkeypatch.setattr(storage, "_client", lambda *a, **k: fake)
        return fake

    def test_unconfigured_storage_is_degraded(self, monkeypatch):
        from app.services import storage

        monkeypatch.setattr(storage, "is_configured", lambda: False)
        assert health.check_storage(deep=True)["status"] == "degraded"

    def test_configured_storage_is_healthy_without_a_call(self, configured):
        configured.fail_head_bucket = True  # not asked
        assert health.check_storage()["message"] == "File storage is configured."

    def test_a_deep_check_reaches_the_bucket(self, configured):
        result = health.check_storage(deep=True)
        assert result["status"] == "healthy" and "latencyMs" in result

    def test_an_unreachable_bucket_is_unhealthy(self, configured):
        configured.fail_head_bucket = True
        assert health.check_storage(deep=True)["status"] == "unhealthy"

    @pytest.mark.parametrize("free, status", [(50, "healthy"), (8, "degraded"), (3, "unhealthy")])
    def test_disk_space_thresholds(self, monkeypatch, free, status):
        monkeypatch.setattr(health.shutil, "disk_usage", lambda path: Usage(100 * 1024 ** 3, 0, free * 1024 ** 3))
        result = health.check_disk()
        assert result["status"] == status and result["facts"]["freePercent"] == float(free)

    def test_unreadable_disk_is_unknown(self, monkeypatch):
        def broken(path):
            raise OSError("no such device")

        monkeypatch.setattr(health.shutil, "disk_usage", broken)
        assert health.check_disk()["status"] == "unknown"


class TestJobsBackupsAndMessagingChecks:
    def test_a_job_whose_last_run_failed_is_degraded(self, db, monkeypatch):
        monkeypatch.setattr(settings, "PAYMENT_PROVIDER", "razorpay")
        now = datetime.utcnow()
        db.add(JobHeartbeat(name="alerts", interval_seconds=120, last_started_at=now, last_success_at=now,
                            runs=5, failures=1, consecutive_failures=1, last_error="Boom: x", last_duration_ms=10))
        db.flush()
        result = health.check_jobs(db, now)
        jobs = {j["name"]: j for j in result["jobs"]}
        assert jobs["alerts"]["status"] == "degraded" and jobs["alerts"]["message"] == "Its last run failed."
        # With real payments the expiry sweeper matters, and it hasn't run.
        assert jobs["payment_expiry"]["status"] == "unknown"
        assert result["status"] == "degraded" and "late" in result["message"]

    def test_backups_switched_off_are_degraded(self, db):
        save_backup_settings(db, enabled=False)
        result = health.check_backups(db)
        assert result["status"] == "degraded" and result["facts"]["schedule"] == "off"

    def test_no_backup_yet_is_unknown(self, db):
        assert health.check_backups(db)["status"] == "unknown"

    def test_a_failed_last_backup_is_unhealthy(self, db):
        make(db, started=datetime.utcnow() - timedelta(days=2))
        make(db, started=datetime.utcnow() - timedelta(hours=1), status="failed")
        assert health.check_backups(db)["status"] == "unhealthy"

    def test_an_old_last_backup_is_degraded_and_a_fresh_one_healthy(self, db):
        old = make(db, started=datetime.utcnow() - timedelta(days=3))
        assert health.check_backups(db)["status"] == "degraded"
        old.completed_at = datetime.utcnow()
        db.flush()
        assert health.check_backups(db)["status"] == "healthy"

    @pytest.fixture()
    def channels(self, monkeypatch):
        from app.services.messaging import service as messaging

        state = {"sms": {"enabled": False, "configured": False}, "whatsapp": {"enabled": False, "configured": True}}
        monkeypatch.setattr(messaging, "channel_status", lambda db: state)
        return state

    def delivery(self, db, status, key):
        now = datetime.utcnow()
        db.add(NotificationDelivery(idempotency_key=key, event="order_placed", channel="sms", status=status,
                                    created_at=now, updated_at=now))
        db.flush()

    def test_a_channel_on_without_a_provider_is_degraded(self, db, channels):
        channels["sms"]["enabled"] = True
        result = health.check_messaging(db)
        assert result["status"] == "degraded" and result["message"].startswith("sms is switched on")
        assert result["facts"]["sms"] == "on" and result["facts"]["whatsapp"] == "ready"

    def test_messages_given_up_on_are_degraded(self, db, channels):
        self.delivery(db, "dead", "health-dead-1")
        result = health.check_messaging(db)
        assert result["status"] == "degraded" and result["facts"]["gaveUp24h"] == 1
        assert result["facts"]["sms"] == "not set up"

    def test_messages_waiting_to_retry_are_still_healthy(self, db, channels):
        self.delivery(db, "failed", "health-retry-1")
        result = health.check_messaging(db)
        assert result["status"] == "healthy" and "1 waiting to retry" in result["message"]


class TestOverallAndRun:
    def test_the_verdict_weighs_each_check(self):
        assert health.overall({"payments": {"status": "unhealthy"}}) == "unhealthy"
        assert health.overall({"email": {"status": "unhealthy"}}) == "degraded"
        assert health.overall({"email": {"status": "unknown"}, "disk": {"status": "healthy"}}) == "healthy"
        assert health.overall({"database": {"status": "unhealthy"}, "disk": {"status": "healthy"}}) == "unhealthy"

    def test_with_the_database_down_nothing_else_that_needs_it_is_checked(self, db, monkeypatch):
        from app.services import storage

        monkeypatch.setattr(storage, "is_configured", lambda: False)
        monkeypatch.setattr(health, "check_database", lambda db: {"status": "unhealthy", "message": "down"})
        result = health.run(db)
        assert result["status"] == "unhealthy"
        for name in ("migrations", "payments", "email", "jobs", "backups", "messaging"):
            assert result["checks"][name]["status"] == "unknown"
            assert result["checks"][name]["message"] == "Can't be checked while the database is down."
        assert result["checks"]["database"]["label"] == "Database"

    def test_a_check_that_crashes_is_unknown_not_a_500(self, db, monkeypatch):
        from app.services import storage

        monkeypatch.setattr(storage, "is_configured", lambda: False)

        def crash(db):
            raise RuntimeError("bug")

        monkeypatch.setattr(health, "check_email", crash)
        result = health.run(db)
        assert result["checks"]["email"] == {"status": "unknown", "message": "This check couldn't run.",
                                             "label": "Email"}

    def test_the_sweep_records_one_snapshot(self, db, monkeypatch):
        from app.core import database
        from app.models import HealthSnapshot

        monkeypatch.setattr(database, "SessionLocal", lambda: contextlib.nullcontext(db))
        monkeypatch.setattr(health, "run", lambda db, deep=False: {
            "status": "healthy", "checkedAt": datetime.utcnow(), "durationMs": 1, "deep": False,
            "checks": {"database": {"status": "healthy", "message": "ok", "label": "Database"}}})
        health._sweep_once()
        assert db.query(HealthSnapshot).count() == 1

    def test_a_sweep_that_fails_rolls_back_and_raises(self, db, monkeypatch):
        from app.core import database

        monkeypatch.setattr(database, "SessionLocal", lambda: contextlib.nullcontext(db))

        def broken(db, deep=False):
            raise RuntimeError("no snapshot")

        monkeypatch.setattr(health, "run", broken)
        with pytest.raises(RuntimeError, match="no snapshot"):
            health._sweep_once()

    def test_uptime_counts_unhealthy_snapshots_against_it(self, db):
        from app.models import HealthSnapshot

        assert health.uptime(db) is None
        now = datetime.utcnow()
        for status in ("healthy", "healthy", "degraded", "unhealthy"):
            db.add(HealthSnapshot(checked_at=now, status=status, checks={}, duration_ms=1))
        db.flush()
        assert health.uptime(db) == 75.0


# ================================================================== backups


class TestBackupSettingsEndpoint:
    def test_saving_the_schedule_is_validated_and_audited(self, client, db, admin_auth):
        response = client.put("/api/admin/backups/settings", headers=admin_auth,
                              json={"frequency": "12h", "hour": 4, "keepManual": 3})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["message"] == "Backup settings saved."
        assert body["data"]["frequency"] == "12h" and body["data"]["keepManual"] == 3
        assert body["data"]["keepDailyDays"] == backups.DEFAULTS["keepDailyDays"]
        assert db.get(SettingDocument, "backups").value["hour"] == 4
        entry = db.query(AuditLog).filter_by(action="backups.settings").one()
        assert entry.changes["frequency"] == {"from": "daily", "to": "12h"}

        # A second save edits the same document.
        assert client.put("/api/admin/backups/settings", headers=admin_auth,
                          json={"enabled": False}).json()["data"]["frequency"] == "12h"

    @pytest.mark.parametrize("payload", [{"hour": "noon"}, {"hour": 24}, {"weekday": 7}, {"keepWeeklyWeeks": -1},
                                         {"keepManual": None}, {"frequency": "hourly"}])
    def test_bad_values_are_refused(self, client, admin_auth, payload):
        response = client.put("/api/admin/backups/settings", headers=admin_auth, json=payload)
        assert response.status_code == 422
        assert response.json()["error_code"] == "INVALID_SETTING"

    def test_only_the_backups_permission_may_change_it(self, client, db, admin, editor):
        response = client.put("/api/admin/backups/settings", headers=login(client, editor.email),
                              json={"enabled": False})
        assert response.status_code == 403
        assert db.get(SettingDocument, "backups") is None


class TestStorageBackends:
    def test_a_path_outside_the_folder_is_refused(self, tmp_path):
        store = backups.LocalStorage(str(tmp_path))
        with pytest.raises(backups.BackupError, match="outside"):
            store._path("../escape.sql")

    def test_the_local_folder(self, tmp_path, monkeypatch):
        store = backups.LocalStorage(str(tmp_path / "vault"))
        source = tmp_path / "upload.tmp"
        source.write_bytes(b"data")

        def no_chmod(*a):
            raise OSError("not supported")

        monkeypatch.setattr(backups.os, "chmod", no_chmod)
        store.put(str(source), "one.sql.gz")
        assert store.exists("one.sql.gz") and store.size("one.sql.gz") == 4 and not source.exists()
        assert store.download_url("one.sql.gz") is None
        store.delete("one.sql.gz")
        store.delete("one.sql.gz")  # already gone: not an error
        assert store.exists("one.sql.gz") is False

    def test_describing_a_folder_whose_disk_cannot_be_read(self, tmp_path, monkeypatch):
        def broken(path):
            raise OSError("gone")

        monkeypatch.setattr(backups.shutil, "disk_usage", broken)
        described = backups.LocalStorage(str(tmp_path)).describe()
        assert described["storage"] == "local" and described["freeBytes"] is None
        assert str(tmp_path) not in str(described)

    def test_choosing_a_backend(self, monkeypatch, s3):
        chosen = backups.storage()
        assert isinstance(chosen, backups.S3Storage) and chosen.prefix == "database-backups"
        assert chosen.describe() == {"storage": "s3", "location": "S3: database-backups/ (private)", "freeBytes": None}
        with pytest.raises(backups.BackupError, match="Unknown backup storage"):
            backups.storage("ftp")
        monkeypatch.setattr(settings, "BACKUP_S3_BUCKET", "")
        monkeypatch.setattr(settings, "AWS_S3_BUCKET", "")
        with pytest.raises(backups.BackupError, match="S3 backups need"):
            backups.storage("s3")

    def test_the_s3_backend_round_trip(self, s3, tmp_path):
        store = backups.storage("s3")
        source = tmp_path / "file.tmp"
        source.write_bytes(b"0123456789" * 30)
        store.put(str(source), "a.sql.gz")
        assert not source.exists()
        assert s3.last_put["ACL"] == "private" and s3.last_put["ServerSideEncryption"] == "AES256"
        assert "database-backups/a.sql.gz" in s3.objects
        assert store.exists("a.sql.gz") and store.size("a.sql.gz") == 300
        with store.open("a.sql.gz") as handle:
            assert handle.read() == b"0123456789" * 30
        assert "expires=300" in store.download_url("a.sql.gz")
        store.delete("a.sql.gz")
        assert store.exists("a.sql.gz") is False


class TestEncryptionFormat:
    def test_large_writes_are_split_into_chunks_and_read_back(self):
        key = b"k" * 32
        target = io.BytesIO()
        writer = backups._EncryptingWriter(target, key)
        payload = os.urandom(backups.CHUNK + 10)
        writer.write(payload)
        writer.close()
        writer.close()  # closing twice is harmless
        target.seek(0)
        assert target.read(len(backups.MAGIC)) == backups.MAGIC
        target.seek(0)
        chunks = list(backups.decrypt_stream(target, key))
        assert len(chunks) == 2 and b"".join(chunks) == payload

    def test_an_empty_encrypted_file_has_only_its_header(self):
        target = io.BytesIO()
        backups._EncryptingWriter(target, b"k" * 32).close()
        assert target.getvalue() == backups.MAGIC

    def test_an_unencrypted_file_passes_through(self):
        raw = gzip.compress(b"SELECT 1;\n")
        assert b"".join(backups.decrypt_stream(io.BytesIO(raw))) == raw

    def test_an_encrypted_file_needs_the_key(self, monkeypatch):
        monkeypatch.setattr(settings, "BACKUP_ENCRYPTION_KEY", "")
        with pytest.raises(backups.BackupError, match="set BACKUP_ENCRYPTION_KEY"):
            list(backups.decrypt_stream(io.BytesIO(backups.MAGIC + b"\x00\x00\x00\x10")))


class TestTheDump:
    def test_rows_are_written_in_batches_and_binary_as_hex(self):
        class Result:
            def __init__(self, rows=(), keys=(), scalar=None, one=None):
                self.rows, self._keys, self._scalar, self._one = list(rows), list(keys), scalar, one

            def __iter__(self):
                return iter(self.rows)

            def keys(self):
                return self._keys

            def scalar(self):
                return self._scalar

            def fetchone(self):
                return self._one

        class Connection:
            connection = SimpleNamespace(dbapi_connection=SimpleNamespace(escape=lambda v: repr(v)))

            def execution_options(self, **options):
                return self

            def execute(self, statement):
                sql = str(statement)
                if sql.startswith("SELECT DATABASE()"):
                    return Result(scalar="fake_db")
                if sql.startswith("SHOW FULL TABLES"):
                    return Result(rows=[("t`odd",)])
                if sql.startswith("SHOW CREATE TABLE"):
                    return Result(one=("t`odd", "CREATE TABLE `t``odd` (`id` int, `blob` blob)"))
                return Result(rows=[(i, b"\x01\xff") for i in range(250)], keys=["id", "blob"])

        out = io.StringIO()
        assert backups._dump(Connection(), out) == (1, 250)
        sql = out.getvalue()
        assert sql.count("INSERT INTO `t``odd` (`id`, `blob`) VALUES") == 2
        assert "X'01ff'" in sql and "-- Rows: 250" in sql
        assert sql.rstrip().endswith(f"{backups.FOOTER} 1 tables, 250 rows")


class TestVerification:
    @pytest.fixture()
    def plain(self, tmp_path, monkeypatch):
        monkeypatch.setattr(settings, "BACKUP_ENCRYPTION_KEY", "")
        return backups.LocalStorage(str(tmp_path))

    def store(self, plain, tmp_path, name, data: bytes) -> str:
        import hashlib

        (tmp_path / name).write_bytes(data)
        return hashlib.sha256(data).hexdigest()

    def test_a_tiny_file_is_not_a_backup(self, plain, tmp_path):
        checksum = self.store(plain, tmp_path, "tiny", b"x" * 10)
        with pytest.raises(backups.BackupError, match="too small"):
            backups._verify(plain, "tiny", checksum=checksum, tables=1)

    def test_a_file_without_its_closing_line_is_incomplete(self, plain, tmp_path):
        data = gzip.compress(("-- Table: a\n" + secrets.token_hex(200) + "\n").encode())
        checksum = self.store(plain, tmp_path, "cut", data)
        with pytest.raises(backups.BackupError, match="incomplete"):
            backups._verify(plain, "cut", checksum=checksum, tables=1)

    def test_a_file_missing_tables_is_refused(self, plain, tmp_path):
        data = gzip.compress(("-- Table: a\n" + secrets.token_hex(200) + f"\n{backups.FOOTER} 1 tables, 0 rows\n")
                             .encode())
        checksum = self.store(plain, tmp_path, "short", data)
        with pytest.raises(backups.BackupError, match="1 tables but 2 were dumped"):
            backups._verify(plain, "short", checksum=checksum, tables=2)
        backups._verify(plain, "short", checksum=checksum, tables=1)  # the right count passes


class TestMakingABackup:
    def test_a_backup_to_s3_is_stored_privately_verified_and_linked(self, client, db, admin, admin_auth, s3,
                                                                   monkeypatch):
        monkeypatch.setattr(backups, "_dump", fake_dump)
        row = backups.run_backup(db, trigger="manual", admin=admin)
        assert row.status == "succeeded", row.error
        assert row.storage == "s3" and row.encrypted and row.tables == 1 and row.rows == 3
        assert row.tier == "manual" and row.created_by == admin.id
        assert f"database-backups/{row.location}" in s3.objects
        link = client.post(f"/api/admin/backups/{row.id}/download", headers=admin_auth).json()["data"]
        assert link["url"].startswith("https://bucket.example.com/database-backups/")
        assert link["expiresIn"] == 300 and link["fileName"] == row.location
        # The API can stream it too, through a signed link.
        expires = int(time.time()) + 60
        token = f"{admin.id}.{expires}.{backups._download_signature(row.id, admin.id, expires)}"
        response = client.get(f"/api/admin/backups/{row.id}/file?token={token}")
        assert response.status_code == 200 and response.content.startswith(backups.MAGIC)
        assert response.headers["cache-control"] == "no-store"

    def test_a_dump_that_fails_is_recorded_and_leaves_no_temporary_file(self, db, admin, vault, tmp_path,
                                                                       monkeypatch):
        real_mkstemp = backups.tempfile.mkstemp
        scratch = tmp_path / "scratch"
        scratch.mkdir()
        monkeypatch.setattr(backups.tempfile, "mkstemp", lambda **kw: real_mkstemp(dir=str(scratch), **kw))

        def broken(connection, out):
            raise RuntimeError("table vanished mid-dump")

        monkeypatch.setattr(backups, "_dump", broken)
        row = backups.run_backup(db, trigger="scheduled")
        assert row.status == "failed" and "table vanished" in row.error and row.completed_at
        assert list(scratch.iterdir()) == []
        assert db.query(Notification).filter_by(kind="backup").count() == 1

    def test_the_failure_is_recorded_even_when_the_team_cannot_be_told(self, db, monkeypatch):
        from app.services import inbox

        row = make(db, started=datetime.utcnow(), status="failed")
        row.error = "disk full"
        db.commit()

        def broken(*a, **k):
            raise RuntimeError("inbox down")

        monkeypatch.setattr(inbox, "staff", broken)
        backups._alert_failure(db, row)  # logged, never raised
        db.expire_all()
        assert db.get(DatabaseBackup, row.id).status == "failed"

    def test_a_backup_through_its_own_connection(self, engine, tmp_path, monkeypatch):
        """
        Outside the test suite the session is bound to an engine, so the lock
        and the dump each take a connection of their own and the dump reads one
        consistent snapshot. The row it commits is removed again afterwards.
        """
        from sqlalchemy import delete
        from sqlalchemy.orm import Session

        monkeypatch.setattr(settings, "BACKUP_STORAGE", "local")
        monkeypatch.setattr(settings, "BACKUP_LOCAL_DIR", str(tmp_path / "own"))
        monkeypatch.setattr(settings, "BACKUP_ENCRYPTION_KEY", "")
        seen = []

        def dump(connection, out):
            seen.append(connection)
            return fake_dump(connection, out)

        monkeypatch.setattr(backups, "_dump", dump)
        session = Session(bind=engine)
        row_id = None
        try:
            row = backups.run_backup(session, trigger="manual")
            row_id = row.id
            assert row.status == "succeeded", row.error
            assert row.encrypted is False
            assert seen and seen[0] is not engine and seen[0].closed
            assert (tmp_path / "own" / row.location).exists()
        finally:
            if row_id is not None:
                session.execute(delete(DatabaseBackup).where(DatabaseBackup.id == row_id))
                session.commit()
            session.close()


class TestScheduleTiers:
    def test_a_weekly_schedule_makes_weekly_backups(self, db):
        conf = {**backups.DEFAULTS, "frequency": "weekly"}
        assert backups._tier(db, conf, datetime(2026, 10, 5, 10, 0)) == "weekly"

    def test_the_first_backup_on_the_chosen_day_is_weekly(self, db):
        conf = {**backups.DEFAULTS, "frequency": "daily", "weekday": 6}
        monday = datetime(2026, 10, 5, 10, 0)  # 15:30 IST, a Monday
        sunday = datetime(2026, 10, 11, 10, 0)
        assert backups._tier(db, conf, monday) == "daily"
        assert backups._tier(db, conf, sunday) == "weekly"
        make(db, started=sunday - timedelta(hours=2), tier="weekly")
        assert backups._tier(db, conf, sunday) == "daily"

    def test_the_next_weekly_run_is_on_the_chosen_day(self, db):
        save_backup_settings(db, frequency="weekly", weekday=6, hour=2)
        now = datetime(2026, 10, 5, 10, 0)
        assert backups.next_run(db, now) == datetime(2026, 10, 10, 20, 30)  # Sunday 02:00 IST

    def test_a_daily_run_missed_today_is_due_now(self, db):
        save_backup_settings(db, frequency="daily", hour=2)
        now = datetime(2026, 10, 5, 10, 0)
        assert backups.next_run(db, now) == now
        assert backups.due(db, now) is True

    def test_after_a_run_the_next_one_is_a_step_later(self, db):
        save_backup_settings(db, frequency="daily", hour=2)
        now = datetime(2026, 10, 5, 10, 0)
        make(db, started=datetime(2026, 10, 5, 9, 0))
        assert backups.next_run(db, now) == datetime(2026, 10, 5, 20, 30)
        assert backups.due(db, now) is False

    def test_manual_backups_do_not_move_the_schedule(self, db):
        save_backup_settings(db, frequency="6h")
        now = datetime(2026, 10, 5, 10, 0)
        make(db, started=now - timedelta(hours=1), trigger="manual", tier="manual")
        assert backups.next_run(db, now) == now


class TestRetentionEdges:
    def test_nothing_to_keep_removes_nothing(self, db):
        assert backups._apply_retention(db) == 0

    def test_manual_backups_beyond_the_limit_are_removed(self, db, admin, vault):
        now = datetime.utcnow()
        save_backup_settings(db, keepManual=1)
        newest = make(db, started=now - timedelta(hours=1), tier="daily", vault=vault)
        kept = make(db, started=now - timedelta(hours=2), tier="manual", trigger="manual", vault=vault)
        extra = make(db, started=now - timedelta(hours=3), tier="manual", trigger="manual", vault=vault)
        db.commit()
        assert backups._apply_retention(db, now=now) == 1
        db.expire_all()
        assert db.get(DatabaseBackup, extra.id).status == "deleted"
        assert db.get(DatabaseBackup, kept.id).status == "succeeded"
        assert db.get(DatabaseBackup, newest.id).status == "succeeded"

    def test_a_file_that_cannot_be_deleted_is_tried_again_later(self, db, s3):
        now = datetime.utcnow()
        make(db, started=now - timedelta(days=1), storage="s3")
        old = make(db, started=now - timedelta(days=30), storage="s3")
        db.commit()
        s3.fail_delete = True
        assert backups._apply_retention(db, now=now) == 0
        db.expire_all()
        assert db.get(DatabaseBackup, old.id).status == "succeeded"


class TestPortalAndLinks:
    def test_a_storage_problem_and_no_encryption_key_are_warnings(self, client, db, admin_auth, monkeypatch):
        monkeypatch.setattr(settings, "BACKUP_STORAGE", "s3")
        monkeypatch.setattr(settings, "BACKUP_S3_BUCKET", "")
        monkeypatch.setattr(settings, "AWS_S3_BUCKET", "")
        monkeypatch.setattr(settings, "BACKUP_ENCRYPTION_KEY", "")
        data = client.get("/api/admin/backups", headers=admin_auth).json()["data"]
        assert data["storageProblem"].startswith("S3 backups need")
        assert data["storage"] == {"storage": "s3", "location": "", "freeBytes": None}
        assert data["encrypted"] is False and len(data["warnings"]) == 2
        assert data["lastSuccess"] is None and data["running"] is None and data["kept"] == 0

    def test_history_filters_by_status(self, client, db, admin_auth, vault):
        now = datetime.utcnow()
        make(db, started=now - timedelta(hours=1), vault=vault)
        make(db, started=now - timedelta(hours=2), status="failed")
        make(db, started=now - timedelta(minutes=5), status="running")
        data = client.get("/api/admin/backups?status=failed", headers=admin_auth).json()["data"]
        assert [i["status"] for i in data["items"]] == ["failed"]
        assert data["counts"] == {"succeeded": 1, "failed": 1, "running": 1}
        assert data["running"]["status"] == "running" and data["lastFailure"]["status"] == "failed"
        assert data["pagination"]["total"] == 1

    # Regression: was a real bug, fixed alongside this test.
    def test_a_failed_manual_backup_answers_500_with_the_reason(self, client, db, admin_auth, vault, monkeypatch):
        def broken(connection, out):
            raise RuntimeError("dump failed")

        monkeypatch.setattr(backups, "_dump", broken)
        response = client.post("/api/admin/backups/run", headers=admin_auth)
        assert response.status_code == 500
        body = response.json()
        assert body["error_code"] == "BACKUP_FAILED" and "dump failed" in body["message"]
        assert body["data"]["status"] == "failed"

    def test_only_a_good_backup_has_a_download_link(self, client, db, admin_auth):
        failed = make(db, started=datetime.utcnow(), status="failed")
        for backup_id in (failed.id, 999999):
            response = client.post(f"/api/admin/backups/{backup_id}/download", headers=admin_auth)
            assert response.status_code == 404 and response.json()["error_code"] == "BACKUP_NOT_FOUND"

    def sign(self, backup_id, admin_id, expires=None):
        expires = expires or int(time.time()) + 60
        return f"{admin_id}.{expires}.{backups._download_signature(backup_id, admin_id, expires)}"

    def test_a_malformed_link_is_refused(self, db):
        for token in ("not-a-token", "a.b.c", "a.b"):
            with pytest.raises(NotFoundError) as error:
                backups.open_for_download(db, 1, token)
            assert error.value.error_code == "BACKUP_LINK_INVALID"

    def test_a_link_for_another_backup_is_refused(self, db, admin, vault):
        row = make(db, started=datetime.utcnow(), vault=vault)
        with pytest.raises(NotFoundError):
            backups.open_for_download(db, row.id + 1, self.sign(row.id, admin.id))

    def test_a_link_stops_working_when_its_admin_is_suspended_or_lacks_the_permission(self, db, admin, editor,
                                                                                     vault):
        row = make(db, started=datetime.utcnow(), vault=vault)
        handle, name = backups.open_for_download(db, row.id, self.sign(row.id, admin.id))
        handle.close()
        assert name == row.location
        with pytest.raises(NotFoundError) as error:
            backups.open_for_download(db, row.id, self.sign(row.id, editor.id))
        assert error.value.error_code == "BACKUP_LINK_INVALID"
        admin.status = "suspended"
        db.flush()
        with pytest.raises(NotFoundError):
            backups.open_for_download(db, row.id, self.sign(row.id, admin.id))

    def test_a_link_to_a_backup_deleted_since_is_refused(self, db, admin, vault):
        row = make(db, started=datetime.utcnow(), vault=vault)
        token = self.sign(row.id, admin.id)
        row.status = "deleted"
        db.flush()
        with pytest.raises(NotFoundError) as error:
            backups.open_for_download(db, row.id, token)
        assert error.value.error_code == "BACKUP_NOT_FOUND"


class TestSweep:
    def test_a_backup_left_running_is_failed_and_nothing_runs_when_off(self, db):
        stuck = make(db, started=datetime.utcnow() - timedelta(hours=5), status="running")
        save_backup_settings(db, enabled=False)
        assert backups.sweep(db) is None
        db.expire_all()
        row = db.get(DatabaseBackup, stuck.id)
        assert row.status == "failed" and row.error.startswith("Interrupted")

    def test_a_due_backup_is_run(self, db, monkeypatch):
        save_backup_settings(db, frequency="6h")
        calls = []
        monkeypatch.setattr(backups, "run_backup", lambda db: calls.append(1) or "made")
        assert backups.sweep(db) == "made" and calls == [1]

    def test_a_backup_already_running_elsewhere_is_left_alone(self, db, monkeypatch):
        save_backup_settings(db, frequency="6h")

        def busy(db):
            raise ConflictError("A backup is already running.", error_code="BACKUP_RUNNING")

        monkeypatch.setattr(backups, "run_backup", busy)
        assert backups.sweep(db) is None

    def test_the_background_pass_uses_its_own_session(self, db, monkeypatch):
        from app.core import database

        monkeypatch.setattr(database, "SessionLocal", lambda: contextlib.nullcontext(db))
        seen = []
        monkeypatch.setattr(backups, "sweep", lambda session: seen.append(session))
        backups._sweep_once()
        assert seen == [db]

        def broken(session):
            raise RuntimeError("sweep broke")

        monkeypatch.setattr(backups, "sweep", broken)
        with pytest.raises(RuntimeError, match="sweep broke"):
            backups._sweep_once()


class TestSettingsValidation:
    def test_whole_numbers_only(self, db, admin):
        with pytest.raises(ValidationError) as error:
            backups.save_settings(db, admin, {"keepDailyDays": "seven"})
        assert error.value.error_code == "INVALID_SETTING" and "whole number" in error.value.message
