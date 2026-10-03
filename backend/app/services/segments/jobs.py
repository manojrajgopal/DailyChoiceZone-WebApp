"""
The `segments` background job: seed the default segments, refresh the metrics
of changed customers (and their segment memberships), and run the periodic
full refresh. See docs/customer-segmentation.md, section 7.
"""

from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from app.core.config import settings

logger = logging.getLogger(__name__)


def interval() -> int:
    return max(60, int(settings.SEGMENTS_JOB_INTERVAL_SECONDS or 600))


def sweep(db: Session) -> dict:
    """One pass. Returns what it did, for the heartbeat and the tests."""
    from app.services.segments import metrics, service

    seeded = service.ensure_defaults(db)
    if metrics.full_refresh_due(db):
        result = service.refresh_everything(db)
        return {"seeded": seeded, "refreshed": result["refreshed"], "full": True, "segments": result["segments"]}
    ids = metrics.refresh_dirty(db)
    segments = service.recalculate_active(db, customer_ids=ids) if ids else 0
    return {"seeded": seeded, "refreshed": len(ids), "full": False, "segments": segments}


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

    seconds = interval()
    logger.info("Customer segments refreshed every %ss.", seconds)
    while True:
        try:
            await asyncio.to_thread(jobs.tracked("segments", seconds, _sweep_once))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Segments sweep failed; retrying next interval.")
        await asyncio.sleep(seconds)
