"""
The `auth` background job (hourly): delete one-time codes, OAuth trips and
signed-in sessions long past any use. Nothing live is touched: limits only
count the last day of codes, and a session is kept a month after it ends so
the customer's device list and the audit trail can still explain it.
"""

from __future__ import annotations

import logging

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

INTERVAL_SECONDS = 3600


def sweep(db: Session) -> dict:
    from app.services import otp, sessions
    from app.services.identity import oauth

    result = {"codes": otp.cleanup(db), "oauthStates": oauth.cleanup(db), "sessions": sessions.cleanup(db)}
    db.commit()
    return result


def _sweep_once() -> None:
    from app.core.database import SessionLocal

    with SessionLocal() as db:
        try:
            sweep(db)
        except Exception:
            db.rollback()
            raise


async def run_forever() -> None:
    import asyncio

    from app.services import jobs

    logger.info("Expired sign-in codes, trips and sessions cleaned every %ss.", INTERVAL_SECONDS)
    while True:
        try:
            await asyncio.to_thread(jobs.tracked("auth", INTERVAL_SECONDS, _sweep_once))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Sign-in cleanup failed; retrying next interval.")
        await asyncio.sleep(INTERVAL_SECONDS)
