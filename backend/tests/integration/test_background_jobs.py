"""
Things that run without a request: the background loops and their heartbeats,
the startup sequence, and the command-line backup tool.

The loops are run for real but with time removed: `asyncio.to_thread` runs the
pass inline and `asyncio.sleep` ends the loop after a set number of passes, so
a test sees the loop survive a failing pass, record it, and keep going.
Startup is tested with the MySQL-facing steps replaced, since the point is the
order and the switches, not whether a server is installed.
"""

from __future__ import annotations

import asyncio
import gzip
import importlib
import io

import pytest

from app.core.config import settings
from app.models import JobHeartbeat
from app.services import jobs

pytestmark = pytest.mark.integration


# ------------------------------------------------------------- heartbeats


class TestTracked:
    def test_success_records_a_run(self, db):
        calls = []
        jobs.tracked("unit_job", 30, lambda: calls.append(1))()
        db.expire_all()
        row = db.get(JobHeartbeat, "unit_job")
        assert calls == [1]
        assert row.runs == 1 and row.failures == 0 and row.consecutive_failures == 0
        assert row.interval_seconds == 30
        assert row.last_success_at is not None and row.last_finished_at is not None
        assert row.last_duration_ms >= 0

    def test_failure_is_recorded_and_raised(self, db):
        def boom():
            raise ValueError("disk full")

        with pytest.raises(ValueError):
            jobs.tracked("unit_job", 30, boom)()
        with pytest.raises(ValueError):
            jobs.tracked("unit_job", 30, boom)()
        db.expire_all()
        row = db.get(JobHeartbeat, "unit_job")
        assert row.runs == 2 and row.failures == 2 and row.consecutive_failures == 2
        assert row.last_error == "ValueError: disk full"
        assert row.last_error_at is not None and row.last_success_at is None

    def test_a_success_resets_the_consecutive_failures(self, db):
        with pytest.raises(RuntimeError):
            jobs.tracked("unit_job", 30, lambda: (_ for _ in ()).throw(RuntimeError("x")))()
        jobs.tracked("unit_job", 30, lambda: None)()
        db.expire_all()
        row = db.get(JobHeartbeat, "unit_job")
        assert row.consecutive_failures == 0 and row.failures == 1 and row.runs == 2

    def test_long_errors_are_cut(self, db):
        with pytest.raises(RuntimeError):
            jobs.tracked("unit_job", 30, lambda: (_ for _ in ()).throw(RuntimeError("e" * 900)))()
        db.expire_all()
        assert len(db.get(JobHeartbeat, "unit_job").last_error) == 500

    def test_a_heartbeat_that_cannot_be_saved_never_stops_the_job(self, monkeypatch):
        from app.core import database

        class Broken:
            info: dict = {}

            def get(self, *a):
                raise RuntimeError("database gone")

            def rollback(self):
                pass

            def close(self):
                pass

        monkeypatch.setattr(database, "SessionLocal", lambda: Broken())
        ran = []
        jobs.tracked("unit_job", 30, lambda: ran.append(True))()
        assert ran == [True]

    def test_every_expected_job_has_a_description(self):
        assert all(jobs.EXPECTED.values())
        assert len(jobs.EXPECTED) == 12


# ------------------------------------------------------------------ loops


LOOPS = [
    ("app.services.alerts", "alerts"),
    ("app.services.backups", "backups"),
    ("app.services.cart_recovery", "cart_recovery"),
    ("app.services.flash_sales", "flash_sales"),
    ("app.services.health", "health"),
    ("app.services.loyalty", "loyalty"),
    ("app.services.referrals", "referrals"),
    ("app.services.email.bounces", "email_bounces"),
    ("app.services.messaging.campaigns", "campaigns"),
    ("app.services.messaging.service", "notifications"),
    ("app.services.support.sla", "support_sla"),
    ("app.services.payment_expiry", "payment_expiry"),
]


def _drive(monkeypatch, module, passes: int):
    """Run `module.run_forever` for `passes` passes; return the sleeps it asked for."""
    sleeps = []

    async def to_thread(fn, *args):
        return fn(*args)

    async def sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) >= passes:
            raise asyncio.CancelledError

    monkeypatch.setattr(asyncio, "to_thread", to_thread)
    monkeypatch.setattr(asyncio, "sleep", sleep)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(module.run_forever())
    return sleeps


@pytest.mark.parametrize("path, job", LOOPS, ids=[job for _, job in LOOPS])
class TestLoops:
    def test_a_failing_pass_is_logged_recorded_and_the_loop_carries_on(self, db, monkeypatch, path, job):
        module = importlib.import_module(path)
        outcomes = iter([RuntimeError("first pass breaks"), None])

        def sweep_once():
            outcome = next(outcomes)
            if outcome:
                raise outcome

        monkeypatch.setattr(module, "_sweep_once", sweep_once)
        sleeps = _drive(monkeypatch, module, passes=2)
        assert len(sleeps) == 2 and all(s > 0 for s in sleeps)
        db.expire_all()
        row = db.get(JobHeartbeat, job)
        assert row.runs == 2 and row.failures == 1 and row.consecutive_failures == 0
        assert "first pass breaks" in row.last_error

    def test_cancellation_stops_the_loop(self, db, monkeypatch, path, job):
        module = importlib.import_module(path)

        def cancelled():
            raise asyncio.CancelledError

        monkeypatch.setattr(module, "_sweep_once", cancelled)

        async def to_thread(fn, *args):
            return fn(*args)

        monkeypatch.setattr(asyncio, "to_thread", to_thread)
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(module.run_forever())


class TestPaymentExpiryInterval:
    def test_interval_has_a_floor(self, db, monkeypatch):
        from app.services import payment_expiry

        monkeypatch.setattr(settings, "PAYMENT_SWEEP_SECONDS", 1)
        monkeypatch.setattr(payment_expiry, "_sweep_once", lambda: None)
        assert _drive(monkeypatch, payment_expiry, passes=1) == [5]

    def test_a_sweep_with_nothing_due_cancels_nothing(self, db):
        from app.services import payment_expiry

        assert payment_expiry.sweep(db) == 0


# ---------------------------------------------------------------- startup


class TestStartup:
    @pytest.fixture()
    def steps(self, monkeypatch):
        from app.core import startup

        seen = []
        monkeypatch.setattr(startup, "check_server_connection", lambda: seen.append("reach"))
        monkeypatch.setattr(startup, "create_database_if_missing", lambda: seen.append("create"))
        monkeypatch.setattr(startup, "run_migrations", lambda: seen.append("migrate"))
        return seen

    def test_all_three_steps_in_order(self, steps, monkeypatch):
        from app.core import startup

        monkeypatch.setattr(settings, "AUTO_CREATE_DATABASE", True)
        monkeypatch.setattr(settings, "AUTO_MIGRATE", True)
        startup.prepare_database()
        assert steps == ["reach", "create", "migrate"]

    def test_creation_and_migration_can_be_switched_off(self, steps, monkeypatch):
        from app.core import startup

        monkeypatch.setattr(settings, "AUTO_CREATE_DATABASE", False)
        monkeypatch.setattr(settings, "AUTO_MIGRATE", False)
        startup.prepare_database()
        assert steps == ["reach"]

    def test_an_unreachable_server_stops_everything(self, monkeypatch):
        from app.core import startup

        seen = []

        def unreachable():
            raise RuntimeError("Cannot reach MySQL")

        monkeypatch.setattr(startup, "check_server_connection", unreachable)
        monkeypatch.setattr(startup, "create_database_if_missing", lambda: seen.append("create"))
        with pytest.raises(RuntimeError):
            startup.prepare_database()
        assert seen == []

    def test_migrations_run_upgrade_to_head_only(self, monkeypatch):
        from app.core import startup

        calls = []
        monkeypatch.setattr(startup.command, "upgrade", lambda config, rev: calls.append(("upgrade", rev)))
        monkeypatch.setattr(startup.command, "downgrade", lambda *a: calls.append(("downgrade",)))
        startup.run_migrations()
        assert calls == [("upgrade", "head")]

    def test_alembic_config_points_at_the_configured_database(self):
        from app.core import startup

        config = startup._alembic_config()
        assert config.get_main_option("sqlalchemy.url") == settings.database_url
        assert config.get_main_option("script_location").endswith("alembic")


class TestDatabaseBootstrap:
    class Engine:
        def __init__(self, existing=None, fail=False):
            self.existing, self.fail, self.statements, self.disposed = existing, fail, [], False

        def connect(self):
            from sqlalchemy.exc import OperationalError

            if self.fail:
                raise OperationalError("SELECT 1", {}, Exception("Access denied"))
            return self

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, statement, params=None):
            self.statements.append(str(statement))
            return self

        def scalar(self):
            return self.existing

        def dispose(self):
            self.disposed = True

    def test_reachable_server(self, monkeypatch):
        from app.core import database

        engine = self.Engine()
        monkeypatch.setattr(database, "create_engine", lambda *a, **k: engine)
        database.check_server_connection()
        assert engine.disposed

    def test_unreachable_server_explains_what_to_check(self, monkeypatch):
        from app.core import database

        engine = self.Engine(fail=True)
        monkeypatch.setattr(database, "create_engine", lambda *a, **k: engine)
        with pytest.raises(RuntimeError) as caught:
            database.check_server_connection()
        message = str(caught.value)
        assert "Is the MySQL service running?" in message and "Access denied" in message
        assert engine.disposed

    def test_existing_database_is_left_alone(self, monkeypatch):
        from app.core import database

        engine = self.Engine(existing="daily_choice_zone")
        monkeypatch.setattr(database, "create_engine", lambda *a, **k: engine)
        assert database.create_database_if_missing() is False
        assert not any("CREATE DATABASE" in s for s in engine.statements)

    def test_missing_database_is_created_never_dropped(self, monkeypatch):
        from app.core import database

        engine = self.Engine(existing=None)
        monkeypatch.setattr(database, "create_engine", lambda *a, **k: engine)
        assert database.create_database_if_missing() is True
        assert any("CREATE DATABASE" in s and "utf8mb4" in s for s in engine.statements)
        assert not any("DROP" in s.upper() for s in engine.statements)

    def test_get_db_closes_the_session(self, monkeypatch):
        from app.core import database

        closed = []

        class Session:
            def close(self):
                closed.append(True)

        monkeypatch.setattr(database, "SessionLocal", Session)
        generator = database.get_db()
        next(generator)
        with pytest.raises(StopIteration):
            next(generator)
        assert closed == [True]


class TestLifespan:
    def test_production_with_unsafe_settings_refuses_to_start(self, monkeypatch):
        from app import main

        monkeypatch.setattr(settings, "ENVIRONMENT", "production")
        monkeypatch.setattr(main, "prepare_database", lambda: pytest.fail("must not reach the database"))

        async def start():
            async with main.lifespan(main.app):
                pass

        with pytest.raises(RuntimeError, match="Refusing to start in production"):
            asyncio.run(start())

    def test_development_starts_every_sweeper_and_stops_them(self, monkeypatch):
        from app import main

        monkeypatch.setattr(settings, "ENVIRONMENT", "development")
        monkeypatch.setattr(settings, "PAYMENT_PROVIDER", "razorpay")
        monkeypatch.setattr(main, "prepare_database", lambda: None)
        started = []
        for path, job in LOOPS:
            module = importlib.import_module(path)

            async def forever(job=job):
                started.append(job)
                await asyncio.Event().wait()

            monkeypatch.setattr(module, "run_forever", forever)

        async def start():
            async with main.lifespan(main.app):
                await asyncio.sleep(0)

        asyncio.run(start())
        assert sorted(started) == sorted(job for _, job in LOOPS)


# ------------------------------------------------------------ backup tool


SQL = "-- Table: customers\nINSERT INTO customers VALUES (1);\n-- Table: orders\n-- Dump completed: 2026-10-01\n"


def _write_backup(path, sql: str, key: bytes | None = None):
    from app.services import backups

    raw = gzip.compress(sql.encode())
    if key is None:
        path.write_bytes(raw)
        return
    buffer = io.BytesIO()
    writer = backups._EncryptingWriter(buffer, key)
    writer.write(raw)
    writer.close()
    path.write_bytes(buffer.getvalue())


class TestBackupTool:
    def test_verify_a_complete_backup(self, tmp_path, capsys):
        from app.tools import backup as tool

        path = tmp_path / "b.sql.gz"
        _write_backup(path, SQL)
        assert tool.main(["verify", str(path)]) == 0
        out = capsys.readouterr().out
        assert "tables  2" in out and "OK" in out and "sha256" in out

    def test_verify_an_incomplete_backup(self, tmp_path, capsys):
        from app.tools import backup as tool

        path = tmp_path / "b.sql.gz"
        _write_backup(path, "-- Table: customers\n")
        assert tool.main(["verify", str(path)]) == 1
        assert "INCOMPLETE" in capsys.readouterr().out

    def test_decrypt_an_encrypted_backup(self, tmp_path, monkeypatch):
        from app.services import backups
        from app.tools import backup as tool

        monkeypatch.setattr(settings, "BACKUP_ENCRYPTION_KEY", "a long random string")
        path, out = tmp_path / "b.sql.gz.enc", tmp_path / "out.sql"
        _write_backup(path, SQL, key=backups._key())
        assert path.read_bytes().startswith(backups.MAGIC)
        assert tool.main(["decrypt", str(path), str(out)]) == 0
        assert out.read_text(encoding="utf-8") == SQL

    def test_encrypted_backup_without_the_key(self, tmp_path, monkeypatch):
        from app.services import backups
        from app.tools import backup as tool

        path = tmp_path / "b.enc"
        _write_backup(path, SQL, key=b"k" * 32)
        monkeypatch.setattr(settings, "BACKUP_ENCRYPTION_KEY", "")
        with pytest.raises(backups.BackupError, match="set BACKUP_ENCRYPTION_KEY"):
            tool.verify(str(path))

    def test_encrypted_backup_with_the_wrong_key(self, tmp_path, monkeypatch):
        from app.services import backups
        from app.tools import backup as tool

        path = tmp_path / "b.enc"
        _write_backup(path, SQL, key=b"k" * 32)
        monkeypatch.setattr(settings, "BACKUP_ENCRYPTION_KEY", "not the key")
        with pytest.raises(backups.BackupError, match="wrong key"):
            tool.verify(str(path))

    def test_large_backup_spans_several_encrypted_chunks(self, tmp_path, monkeypatch):
        from app.services import backups
        from app.tools import backup as tool

        monkeypatch.setattr(backups, "CHUNK", 64)
        monkeypatch.setattr(settings, "BACKUP_ENCRYPTION_KEY", "key")
        sql = "".join(f"INSERT INTO t VALUES ({i});\n" for i in range(200)) + "-- Dump completed: x\n"
        path, out = tmp_path / "b.enc", tmp_path / "o.sql"
        _write_backup(path, sql, key=backups._key())
        tool.decrypt(str(path), str(out))
        assert out.read_text(encoding="utf-8") == sql

    @pytest.mark.parametrize("argv", [[], ["verify"], ["decrypt", "only-one"], ["restore", "x"]])
    def test_usage(self, argv, capsys):
        from app.tools import backup as tool

        assert tool.main(argv) == 2
        assert "python -m app.tools.backup" in capsys.readouterr().out
