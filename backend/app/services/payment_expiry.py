"""
Releasing the stock held by orders nobody paid for.

A prepaid order holds its items for `PAYMENT_WINDOW_SECONDS` (plus
`PAYMENT_GRACE_SECONDS`). When that runs out the order is cancelled, the hold is
released, any QR codes minted for it are closed at the gateway, and a payment
that turns up afterwards is refunded rather than allowed to confirm it — see
`settlement.expire_payment` and `settlement._apply_paid`.

## Two ways the deadline is enforced, deliberately

**Lazily**, whenever anybody looks: the payment session, the QR poll and every
settlement check the deadline before acting. That covers the shopper who is
still on the page.

**Here**, on a timer, for the one who is not. Somebody who closes the tab
never polls again, and without a sweep their order would hold stock forever —
which is exactly the state this system was in before holds existed.

## What it will never touch

Only orders that are `pending`, `reserved` and past a deadline that is *set*.
Every order placed before holds existed has no deadline, so it can never be
selected. A paid order has released its hold into a sale and has no deadline
either. And `expire_payment` re-checks all of it under a row lock, so a payment
settling at the same instant always wins.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import Order, Payment

logger = logging.getLogger(__name__)

# Per pass. A backlog larger than this is cleared over a few passes rather than
# in one long transaction that holds locks the storefront is waiting on.
BATCH = 100


def sweep(db: Session, now: Optional[datetime] = None) -> int:
    """
    Expire every order whose hold has lapsed. Returns how many it cancelled.

    Each order is its own transaction, so one that fails — a gateway timeout
    while closing its QR code, say — is logged and left for the next pass
    rather than rolling back every other expiry in the batch.
    """
    from app.services.settlement import expire_payment

    now = now or datetime.utcnow()
    deadline = now - timedelta(seconds=settings.PAYMENT_GRACE_SECONDS)

    candidates = db.execute(
        select(Order.id)
        .where(
            Order.stock_state == "reserved",
            Order.status == "pending",
            Order.payment_expires_at.is_not(None),
            Order.payment_expires_at <= deadline,
        )
        .order_by(Order.payment_expires_at)
        .limit(BATCH)
    ).scalars().all()

    cancelled = 0
    for order_id in candidates:
        payment = db.execute(
            select(Payment).where(Payment.order_id == order_id)
        ).scalars().first()
        if payment is None:
            continue

        try:
            if expire_payment(db, payment, reason="Payment not received within the time allowed."):
                cancelled += 1
        except Exception:  # noqa: BLE001 - one bad order must not stop the rest
            db.rollback()
            logger.exception("Could not expire order %s; will retry next pass.", order_id)

    if cancelled:
        logger.info("Released the stock held by %s unpaid order(s).", cancelled)
    return cancelled


def _sweep_once() -> None:
    from app.core.database import SessionLocal

    db = SessionLocal()
    try:
        sweep(db)
    finally:
        db.close()


async def run_forever() -> None:
    """
    The background loop started by the app's lifespan.

    The sweep itself is synchronous database work, so it runs in a worker
    thread; the event loop keeps serving requests while it does. Any failure
    is logged and the loop carries on — a sweeper that dies quietly is the
    failure mode that leaves stock held indefinitely.
    """
    interval = max(5, settings.PAYMENT_SWEEP_SECONDS)
    logger.info("Payment expiry sweeper running every %ss.", interval)

    while True:
        try:
            await asyncio.to_thread(_sweep_once)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Payment expiry sweep failed; retrying next interval.")
        await asyncio.sleep(interval)
