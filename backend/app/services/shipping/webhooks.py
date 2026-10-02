"""
Courier webhooks: verify, de-duplicate, apply. See docs/shipping-and-suppliers.md, section 6.

| Case                     | Answer                                            |
|--------------------------|---------------------------------------------------|
| wrong or missing token   | 401, nothing processed or recorded                |
| body over 256 KB         | 413                                               |
| body not JSON            | 400                                               |
| unknown AWB              | 200, recorded `ignored` (so the courier stops)    |
| duplicate delivery       | 200 `duplicate`                                   |
| processing error         | 500, recorded `failed`, so a resend is retried    |

The token is checked before anything else is read: an unverified caller
can't learn which AWBs or deliveries exist. Only the courier's own fields are
stored (the adapter's `safe_payload`), never the customer's contact details.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Dict, Optional

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import AppError, NotFoundError
from app.models.shipping import Shipment, ShippingWebhookEvent
from app.services.shipping import registry
from app.services.shipping.base import Unsupported, WebhookEvent, WebhookRejected

logger = logging.getLogger(__name__)

MAX_BODY_BYTES = 256 * 1024


class WebhookUnverified(AppError):
    status_code = 401
    error_code = "WEBHOOK_UNVERIFIED"


class WebhookTooLarge(AppError):
    status_code = 413
    error_code = "WEBHOOK_TOO_LARGE"


class WebhookMalformed(AppError):
    status_code = 400
    error_code = "WEBHOOK_MALFORMED"


class WebhookFailed(AppError):
    status_code = 500
    error_code = "WEBHOOK_FAILED"


def _now() -> datetime:
    return datetime.utcnow().replace(microsecond=0)


def _find_shipment(db: Session, provider_id: int, event: WebhookEvent) -> Optional[Shipment]:
    conditions = []
    if event.awb:
        conditions.append(Shipment.awb == event.awb)
    if event.provider_shipment_id:
        conditions.append(Shipment.provider_shipment_id == event.provider_shipment_id)
    if event.reference:
        conditions.append(Shipment.shipment_number == event.reference)
    if not conditions:
        return None
    rows = list(db.execute(select(Shipment).where(Shipment.provider_id == provider_id, or_(*conditions))
                           .order_by(Shipment.id.desc())).scalars())
    # Prefer the AWB match: a reference can outlive a cancelled booking.
    for row in rows:
        if event.awb and row.awb == event.awb:
            return row
    return rows[0] if rows else None


def _claim(db: Session, code: str, event: WebhookEvent) -> tuple:
    """(row, duplicate?) — the delivery's record, created once per (provider, event key)."""
    existing = db.execute(select(ShippingWebhookEvent).where(
        ShippingWebhookEvent.provider_code == code, ShippingWebhookEvent.event_key == event.event_key[:80],
    ).with_for_update()).scalar_one_or_none()
    if existing is not None:
        existing.attempts = (existing.attempts or 0) + 1
        if existing.status in ("processed", "ignored"):
            db.commit()
            return existing, True
        return existing, False  # failed before: process it again
    row = ShippingWebhookEvent(provider_code=code, event_key=event.event_key[:80], status="failed", attempts=1,
                               payload=event.safe_payload or {}, received_at=_now())
    db.add(row)
    try:
        db.flush()
    except IntegrityError:
        # The same delivery is being handled by a concurrent request.
        db.rollback()
        return None, True
    return row, False


def handle(db: Session, code: str, headers: Dict[str, str], body: bytes) -> dict:
    """Process one delivery. Returns {"result": processed|ignored|duplicate}; raises the cases above."""
    cls = registry.adapter_class(code)
    if cls is None:
        raise NotFoundError("No such courier.", error_code="PROVIDER_NOT_FOUND")
    if len(body or b"") > MAX_BODY_BYTES:
        raise WebhookTooLarge("The webhook body is too large.")
    provider_row = registry.row_for(db, cls.code)
    adapter = registry.adapter_for(cls.code, provider_row)
    if not adapter.supports().get("webhook"):
        raise NotFoundError("This courier doesn't send webhooks.", error_code="WEBHOOK_UNSUPPORTED")
    try:
        if provider_row is None:
            raise WebhookRejected("Not configured.")
        event = adapter.parse_webhook(dict(headers or {}), body or b"")
    except WebhookRejected:
        logger.warning("%s webhook: token rejected", cls.code)
        raise WebhookUnverified("The webhook token is missing or wrong.") from None
    except Unsupported:
        raise NotFoundError("This courier doesn't send webhooks.", error_code="WEBHOOK_UNSUPPORTED") from None
    except ValueError:
        raise WebhookMalformed("The webhook body is not valid JSON.") from None

    record, duplicate = _claim(db, cls.code, event)
    if duplicate:
        return {"result": "duplicate"}
    record_id, attempts = record.id, record.attempts

    shipment = _find_shipment(db, provider_row.id, event)
    if shipment is None:
        record.status = "ignored"
        record.last_error = "No shipment has this AWB."
        record.processed_at = _now()
        db.commit()
        return {"result": "ignored"}

    record.shipment_id = shipment.id
    shipment_id = shipment.id
    from app.services.shipping import service

    try:
        # Commits the event record with the shipment's changes, in one go.
        record.status = "processed"
        record.last_error = ""
        record.processed_at = _now()
        service.apply_tracking(db, shipment, event, source="webhook")
    except Exception as error:  # noqa: BLE001 - recorded, then answered 500 so the courier resends
        db.rollback()
        logger.exception("%s webhook for shipment %s failed", cls.code, shipment_id)
        failed = db.get(ShippingWebhookEvent, record_id)
        if failed is None:  # the claim itself was rolled back: record it again
            failed = ShippingWebhookEvent(provider_code=cls.code, event_key=event.event_key[:80], attempts=1,
                                          payload=event.safe_payload or {}, received_at=_now())
            db.add(failed)
        failed.status = "failed"
        failed.attempts = attempts
        failed.shipment_id = shipment_id
        failed.last_error = f"{type(error).__name__}"[:500]
        failed.processed_at = None
        shipment = db.get(Shipment, shipment_id)
        if shipment is not None:
            service._alert(db, shipment, "webhook-failed", f"Courier update failed for {shipment.shipment_number}",
                           "A tracking update from the courier couldn't be applied. It will be applied when the "
                           "courier sends it again; you can also refresh tracking on the shipment.")
        db.commit()
        raise WebhookFailed("The update couldn't be applied. Please send it again.") from None
    return {"result": "processed"}
