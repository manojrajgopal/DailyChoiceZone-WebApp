"""
One pass of each background job (`_sweep_once`): it opens its own session,
runs its sweep, rolls back on failure, and always closes the session.

`test_background_jobs.py` drives the loops around these. Here the session is a
fake that records what was done to it, and the sweep is a stand-in, so each
job's wiring is checked without the work it wraps.
"""

from __future__ import annotations

import importlib

import pytest

from app.core import database


class FakeSession:
    def __init__(self):
        self.log = []
        self.info = {}

    def __enter__(self):
        self.log.append("open")
        return self

    def __exit__(self, *exc):
        self.log.append("close")
        return False

    def rollback(self):
        self.log.append("rollback")

    def close(self):
        self.log.append("close")


@pytest.fixture()
def session(monkeypatch):
    fake = FakeSession()
    monkeypatch.setattr(database, "SessionLocal", lambda: fake)
    return fake


# (module, the function(s) the pass calls, what a failure does: "logged" or "raised")
JOBS = [
    ("app.services.alerts", ["sweep"], "logged"),
    ("app.services.cart_recovery", ["sweep"], "logged"),
    ("app.services.email.bounces", ["sweep"], "logged"),
    ("app.services.flash_sales", ["sweep"], "raised"),
    ("app.services.referrals", ["expire_due"], "raised"),
    ("app.services.backups", ["sweep"], "raised"),
    ("app.services.messaging.service", ["sweep"], "raised"),
    ("app.services.messaging.campaigns", ["run_due"], "raised"),
    ("app.services.payment_expiry", ["sweep"], "raised"),
    ("app.services.shipping.jobs", ["sweep"], "raised"),
]


def _stub(monkeypatch, module, names, fail=False):
    calls = []

    def make(name):
        def stand_in(db, *args, **kwargs):
            calls.append((name, db))
            if fail:
                raise RuntimeError(f"{name} broke")
        return stand_in

    for name in names:
        monkeypatch.setattr(module, name, make(name))
    return calls


@pytest.mark.parametrize("path, names, on_failure", JOBS, ids=[j[0].rsplit(".", 1)[-1] for j in JOBS])
class TestOnePass:
    def test_runs_its_sweep_on_its_own_session_and_closes_it(self, monkeypatch, session, path, names, on_failure):
        module = importlib.import_module(path)
        if path.endswith("cart_recovery"):
            from app.services import accounts

            monkeypatch.setattr(accounts, "cleanup", lambda db: None)
        calls = _stub(monkeypatch, module, names)
        module._sweep_once()
        assert [name for name, _ in calls] == names
        assert all(db is session for _, db in calls)
        assert session.log[-1] == "close" and "rollback" not in session.log

    def test_a_failure_is_rolled_back_and_the_session_still_closed(self, monkeypatch, session, path, names,
                                                                   on_failure):
        module = importlib.import_module(path)
        _stub(monkeypatch, module, names, fail=True)
        if on_failure == "raised":
            with pytest.raises(RuntimeError):
                module._sweep_once()
        else:
            module._sweep_once()  # logged and swallowed: the loop carries on
        if not path.endswith("payment_expiry"):
            assert "rollback" in session.log
        assert session.log[-1] == "close"


class TestCartRecoveryPass:
    def test_spent_account_links_are_cleared_on_the_same_beat(self, monkeypatch, session):
        from app.services import accounts, cart_recovery

        order = []
        monkeypatch.setattr(cart_recovery, "sweep", lambda db: order.append("sweep"))
        monkeypatch.setattr(accounts, "cleanup", lambda db: order.append("cleanup"))
        cart_recovery._sweep_once()
        assert order == ["sweep", "cleanup"]


class TestLoyaltyPass:
    def test_each_housekeeping_step_runs_even_when_one_fails(self, monkeypatch, session):
        from app.services import gift_cards, loyalty

        ran = []

        def step(name, fail=False):
            def run(db):
                ran.append(name)
                if fail:
                    raise RuntimeError(name)
            return run

        monkeypatch.setattr(loyalty, "release_due", step("release", fail=True))
        monkeypatch.setattr(loyalty, "expire_due", step("expire"))
        monkeypatch.setattr(loyalty, "warn_expiring", step("warn", fail=True))
        monkeypatch.setattr(gift_cards, "expire_due", step("cards"))
        loyalty._sweep_once()
        assert ran == ["release", "expire", "warn", "cards"]
        assert session.log.count("rollback") == 2 and session.log[-1] == "close"


class TestHealthPass:
    def test_checks_then_records(self, monkeypatch, session):
        from app.services import health

        seen = []
        monkeypatch.setattr(health, "run", lambda db: {"overall": "ok"})
        monkeypatch.setattr(health, "record_and_alert", lambda db, result: seen.append(result))
        health._sweep_once()
        assert seen == [{"overall": "ok"}] and session.log[-1] == "close"

    def test_a_failing_check_is_raised_after_rollback(self, monkeypatch, session):
        from app.services import health

        monkeypatch.setattr(health, "run", lambda db: (_ for _ in ()).throw(RuntimeError("probe")))
        with pytest.raises(RuntimeError):
            health._sweep_once()
        assert "rollback" in session.log and session.log[-1] == "close"


class TestSlaPass:
    def test_sweeps_and_closes(self, monkeypatch, session):
        from app.services.support import sla

        seen = []
        monkeypatch.setattr(sla, "sweep", lambda db: seen.append(db))
        sla._sweep_once()
        assert seen == [session] and session.log == ["open", "close"]

    def test_a_failure_propagates_and_still_closes(self, monkeypatch, session):
        from app.services.support import sla

        monkeypatch.setattr(sla, "sweep", lambda db: (_ for _ in ()).throw(RuntimeError("x")))
        with pytest.raises(RuntimeError):
            sla._sweep_once()
        assert session.log[-1] == "close"
