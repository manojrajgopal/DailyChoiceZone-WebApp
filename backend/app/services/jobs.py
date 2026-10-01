"""
Heartbeats for the background jobs.

Each job's loop runs its pass through `tracked`, which records when it
started, when it finished, how long it took and whether it failed — in the
database, so the health check (and any other server process) can see a job
that has stopped running or keeps failing. Recording a heartbeat never stops
the job itself: if the database is what's broken, the job's own error is the
one that's raised.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Callable

from app.models import JobHeartbeat

logger = logging.getLogger(__name__)

# Every loop the application starts, with how often it runs — so the health
# check knows what to expect even before a job has run once.
EXPECTED = {
    "payment_expiry": "Unpaid orders' payment windows",
    "support_sla": "Support SLAs and auto-close",
    "email_bounces": "Email bounce check",
    "cart_recovery": "Abandoned-cart reminders",
    "alerts": "Stock and price alerts",
    "loyalty": "Reward points and gift card expiry",
    "flash_sales": "Flash sale announcements",
    "referrals": "Referral expiry",
    "health": "Health checks",
}


def _save(name: str, interval: int, **changes) -> None:
    from app.core.database import SessionLocal

    db = SessionLocal()
    try:
        row = db.get(JobHeartbeat, name)
        if row is None:
            row = JobHeartbeat(name=name, interval_seconds=interval, runs=0, failures=0, consecutive_failures=0,
                               last_error="", last_duration_ms=0)
            db.add(row)
        row.interval_seconds = interval
        for key, value in changes.items():
            if key.startswith("add_"):
                setattr(row, key[4:], (getattr(row, key[4:]) or 0) + value)
            else:
                setattr(row, key, value)
        db.commit()
    except Exception:  # noqa: BLE001 — a heartbeat must never stop the job
        db.rollback()
        logger.warning("Could not record the heartbeat for job %s", name, exc_info=True)
    finally:
        # The test suite hands every caller its one session; closing it there
        # would detach the test's own objects.
        if not db.info.get("test_session"):
            db.close()


def tracked(name: str, interval: int, fn: Callable[[], None]) -> Callable[[], None]:
    """`fn`, recording its run under `name`. Errors are recorded, then raised."""

    def run() -> None:
        started = datetime.utcnow()
        clock = time.monotonic()
        _save(name, interval, last_started_at=started)
        try:
            fn()
        except Exception as error:
            _save(name, interval, last_finished_at=datetime.utcnow(),
                  last_duration_ms=int((time.monotonic() - clock) * 1000),
                  last_error=f"{type(error).__name__}: {error}"[:500], last_error_at=datetime.utcnow(),
                  add_runs=1, add_failures=1, add_consecutive_failures=1)
            raise
        finished = datetime.utcnow()
        _save(name, interval, last_finished_at=finished, last_success_at=finished,
              last_duration_ms=int((time.monotonic() - clock) * 1000), add_runs=1, consecutive_failures=0)

    return run
