"""
The product-discovery housekeeping job.

Forgets recently-viewed history past `RECENTLY_VIEWED_RETENTION_DAYS`. The
per-customer limit is kept on every write, so this only has to deal with
history nobody has added to in months. Recommendation rankings and pincode
answers need no job: they expire on their own and are cleared by the edits
that change them.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

INTERVAL_SECONDS = 6 * 3600


def sweep(db) -> dict:
    from app.services import recently_viewed

    return {"recentlyViewedRemoved": recently_viewed.sweep(db)}


def _sweep_once() -> None:
    from app.core.database import SessionLocal

    with SessionLocal() as db:
        try:
            result = sweep(db)
            if result["recentlyViewedRemoved"]:
                logger.info("Forgot %s old recently-viewed entries.", result["recentlyViewedRemoved"])
        except Exception:  # noqa: BLE001 — logged; the next pass tries again
            db.rollback()
            logger.exception("Recently-viewed clean-up failed; retrying next interval.")


async def run_forever() -> None:
    import asyncio

    logger.info("Product discovery housekeeping every %ss.", INTERVAL_SECONDS)
    while True:
        try:
            from app.services import jobs

            await asyncio.to_thread(jobs.tracked("discovery", INTERVAL_SECONDS, _sweep_once))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Product discovery housekeeping failed; retrying next interval.")
        await asyncio.sleep(INTERVAL_SECONDS)
