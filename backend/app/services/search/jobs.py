"""
The `search` background job (every 10 minutes). See docs/search-and-filters.md, section 8.

1. Recompute today's and yesterday's `search_daily_stats`.
2. Mark conversions for recent clicks.
3. Every 6 hours, or while the dictionary is empty: rebuild the term
   dictionary, every product's `search_text` and `units_sold`.
4. Drop raw search rows past the retention; the aggregates stay.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from app.core.config import settings

logger = logging.getLogger(__name__)

INTERVAL_SECONDS = 600
REBUILD_EVERY = timedelta(hours=6)


def rebuild(db: Session, now: Optional[datetime] = None) -> dict:
    """Dictionary, search text and units sold, for the whole catalogue. Commits."""
    from app.services.search import dictionary, index, settings as search_settings

    now = now or datetime.utcnow()
    counts = index.rebuild(db)
    counts["terms"] = dictionary.rebuild(db)
    search_settings.mark_rebuilt(db, now)
    db.commit()
    return counts


def _rebuild_due(db: Session, now: datetime) -> bool:
    from app.services.search import dictionary, settings as search_settings

    last = search_settings.document(db).get("lastRebuildAt")
    if not last or dictionary.size(db) == 0:
        return True
    try:
        return datetime.fromisoformat(last) <= now - REBUILD_EVERY
    except ValueError:
        return True


def sweep(db: Session, now: Optional[datetime] = None) -> dict:
    """One pass. Returns what it did, for the heartbeat and the tests."""
    from app.services.search import analytics

    now = now or datetime.utcnow()
    converted = analytics.mark_conversions(db, now)
    terms = analytics.aggregate_day(db, now.date()) + analytics.aggregate_day(db, (now - timedelta(days=1)).date())
    purged = analytics.purge(db, int(getattr(settings, "SEARCH_LOG_RETENTION_DAYS", 180) or 0), now)
    db.commit()
    rebuilt = False
    if _rebuild_due(db, now):
        rebuild(db, now)
        rebuilt = True
    return {"converted": converted, "aggregated": terms, "purged": purged, "rebuilt": rebuilt}


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

    logger.info("Search analytics and the search index refreshed every %ss.", INTERVAL_SECONDS)
    while True:
        try:
            await asyncio.to_thread(jobs.tracked("search", INTERVAL_SECONDS, _sweep_once))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Search sweep failed; retrying next interval.")
        await asyncio.sleep(INTERVAL_SECONDS)
