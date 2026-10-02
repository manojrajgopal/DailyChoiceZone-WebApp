"""
The `shipping` background job: retry failed courier operations, refresh
tracking that is due, flag stuck shipments. See docs/shipping-and-suppliers.md,
section 8.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.shipping import Shipment, ShipmentEvent, ShippingProvider
from app.services.shipping.base import TERMINAL, ProviderError

logger = logging.getLogger(__name__)

INTERVAL_SECONDS = 300
REFRESH_BATCH = 50
RETRY_BATCH = 50


def _retry_due(db: Session, now: datetime) -> int:
    from app.services.shipping import service

    ids = list(db.execute(
        select(Shipment.id).where(Shipment.request_status == "failed", Shipment.last_error_transient.is_(True),
                                  Shipment.next_retry_at.is_not(None), Shipment.next_retry_at <= now,
                                  Shipment.retry_count < service.MAX_ATTEMPTS)
        .order_by(Shipment.next_retry_at).limit(RETRY_BATCH)
    ).scalars())
    done = 0
    for shipment_id in ids:
        try:
            service.retry(db, shipment_id, automatic=True)
            done += 1
        except Exception:  # noqa: BLE001 - one shipment must not stop the pass
            db.rollback()
            logger.exception("Retrying shipment %s failed", shipment_id)
    return done


def _refresh_due(db: Session, now: datetime) -> int:
    """Poll only what is due, never Manual, never a closed parcel, never a courier that is switched off."""
    from app.services.shipping import service

    ids = list(db.execute(
        select(Shipment.id).join(ShippingProvider, ShippingProvider.id == Shipment.provider_id)
        .where(ShippingProvider.active.is_(True), Shipment.provider_code != "manual", Shipment.awb.is_not(None),
               Shipment.status.not_in(TERMINAL), Shipment.next_sync_at.is_not(None), Shipment.next_sync_at <= now)
        .order_by(Shipment.next_sync_at).limit(REFRESH_BATCH)
    ).scalars())
    done = 0
    for shipment_id in ids:
        try:
            service.refresh(db, shipment_id, automatic=True)
            done += 1
        except ProviderError:
            # `refresh` has already pushed next_sync_at back; the courier is tried again later.
            db.rollback()
        except Exception:  # noqa: BLE001
            db.rollback()
            logger.exception("Refreshing shipment %s failed", shipment_id)
    return done


def _last_movement(db: Session, shipment: Shipment) -> Optional[datetime]:
    latest = db.execute(select(func.max(ShipmentEvent.occurred_at)).where(
        ShipmentEvent.shipment_id == shipment.id, ShipmentEvent.status != "")).scalar_one_or_none()
    # Not `updated_at`: polling touches that even when the parcel hasn't moved.
    return latest or shipment.created_at


def _flag_stuck(db: Session, now: datetime) -> int:
    from app.services.shipping import service

    cutoff = now - timedelta(days=service.STUCK_DAYS)
    candidates = list(db.execute(
        select(Shipment).where(Shipment.status.in_(service.IN_TRANSIT), Shipment.created_at <= cutoff)
    ).scalars())
    flagged = 0
    for shipment in candidates:
        if "stuck" in (shipment.alerts_sent or []):
            continue
        last = _last_movement(db, shipment)
        if last is None or last > cutoff:
            continue
        if service._alert(db, shipment, "stuck", f"Shipment {shipment.shipment_number} has stopped moving",
                          f"No courier update for {service.STUCK_DAYS} days while {shipment.status.replace('-', ' ')}. "
                          "Check with the courier."):
            flagged += 1
    db.commit()
    return flagged


def sweep(db: Session) -> dict:
    """One pass. Returns what it did, for the heartbeat and the tests."""
    now = datetime.utcnow().replace(microsecond=0)
    return {"retried": _retry_due(db, now), "refreshed": _refresh_due(db, now), "flagged": _flag_stuck(db, now)}


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

    logger.info("Shipments checked every %ss.", INTERVAL_SECONDS)
    while True:
        try:
            await asyncio.to_thread(jobs.tracked("shipping", INTERVAL_SECONDS, _sweep_once))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Shipping sweep failed; retrying next interval.")
        await asyncio.sleep(INTERVAL_SECONDS)
