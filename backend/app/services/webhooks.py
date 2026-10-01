"""
Razorpay webhook processing, and a record of every event good enough to
monitor and, when one failed, replay.

## One row per event, claimed before it's applied

    delivery ─▶ claim (processing) ─▶ settle ─▶ processed | ignored
                                         └──▶ failed (the error kept, 500 back
                                              so Razorpay retries)
    redelivery of a failed event ─▶ retrying ─▶ ...
    redelivery of anything else  ─▶ acknowledged, counted in `duplicates`

The claim is its own small commit, so two deliveries of one event racing each
other meet at the primary key: one applies it, the other is the duplicate.
Settlement is idempotent in its own right (`apply_result` refuses to settle a
payment twice), so the one window left — settled, then the process dies before
the row says so — resolves itself: the row is left `processing`, goes stale,
and the next delivery or a replay re-runs it harmlessly.

## What's kept of the event

Enough to understand and replay it: ids, amounts, currencies, statuses, the
error Razorpay gave and our own notes. Never the customer's email, phone,
card, account or full UPI address — see `_clean`.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import WebhookEvent, WebhookEventAttempt

logger = logging.getLogger(__name__)

STATUSES = ("processing", "retrying", "processed", "ignored", "failed")
#: A claim this old belongs to a process that never finished.
STALE_AFTER = timedelta(minutes=5)

# ---------------------------------------------------------------- cleaning

_SAFE_KEYS = {
    "id", "entity", "amount", "amount_paid", "amount_due", "amount_refunded", "currency", "status",
    "order_id", "payment_id", "invoice_id", "reference_id", "receipt", "method", "captured", "refund_status",
    "international", "fee", "tax", "error_code", "error_description", "error_reason", "error_source",
    "error_step", "created_at", "speed_processed", "speed_requested", "bank", "wallet", "attempts",
    "payments_amount_received", "payments_count_received", "close_by", "closed_at", "usage", "type",
}
_SAFE_NOTES = {"paymentId", "orderId", "membershipId", "giftCardId", "orderNumber", "invoiceId", "reason"}
_ENTITIES = ("payment", "order", "refund", "payment_link", "qr_code")


def _clean_entity(entity: Any) -> dict:
    if not isinstance(entity, dict):
        return {}
    out = {k: v for k, v in entity.items() if k in _SAFE_KEYS and not isinstance(v, (dict, list))}
    notes = entity.get("notes")
    if isinstance(notes, dict):
        out["notes"] = {k: str(v)[:80] for k, v in notes.items() if k in _SAFE_NOTES}
    card = entity.get("card")
    if isinstance(card, dict) and card.get("network"):
        # The network alone: no digits, no name, no issuer details.
        out["card"] = {"network": str(card["network"])[:30]}
    vpa = entity.get("vpa")
    if isinstance(vpa, str) and "@" in vpa:
        # The handle is the bank, not the person — the same masking the
        # payment's own instrument hint uses.
        out["vpa"] = "•••••@" + vpa.split("@", 1)[1][:40]
    return out


def clean(body: dict) -> dict:
    """The event with everything personal taken out; what's left still settles."""
    payload = body.get("payload") if isinstance(body.get("payload"), dict) else {}
    kept = {}
    for name in _ENTITIES:
        wrapper = payload.get(name)
        if isinstance(wrapper, dict) and isinstance(wrapper.get("entity"), dict):
            kept[name] = {"entity": _clean_entity(wrapper["entity"])}
    return {
        "entity": body.get("entity", "event"),
        "event": str(body.get("event", ""))[:60],
        "contains": [str(c)[:30] for c in (body.get("contains") or [])][:10],
        "created_at": body.get("created_at"),
        "payload": kept,
    }


def _related(db: Session, body: dict) -> dict:
    """Which of our records the event is about, for filtering and the detail page."""
    from app.models import Payment

    payload = body.get("payload") or {}
    payment_entity = (payload.get("payment") or {}).get("entity") or {}
    refund_entity = (payload.get("refund") or {}).get("entity") or {}
    gateway_payment_id = payment_entity.get("id") or refund_entity.get("payment_id")
    related = {"gateway_payment_id": (gateway_payment_id or None), "refund_id": refund_entity.get("id") or None,
               "payment_id": None, "order_id": None}
    ours = None
    if gateway_payment_id:
        ours = db.execute(select(Payment).where(Payment.transaction_id == gateway_payment_id).limit(1)).scalar_one_or_none()
    if ours is None:
        noted = (payment_entity.get("notes") or {}).get("paymentId")
        ours = db.get(Payment, noted) if noted else None
    if ours is None and payment_entity.get("order_id"):
        ours = db.execute(select(Payment).where(Payment.provider_reference == payment_entity["order_id"]).limit(1)
                          ).scalar_one_or_none()
    if ours is not None:
        related["payment_id"] = ours.id
        related["order_id"] = ours.order_id
    for key in ("gateway_payment_id", "refund_id"):
        if related[key]:
            related[key] = str(related[key])[:60]
    return related


def _describe(error: BaseException) -> str:
    """The error, for an admin: its type and message, never a traceback or a request."""
    text = getattr(error, "message", None) or str(error) or ""
    return f"{type(error).__name__}: {text}"[:500]


# ---------------------------------------------------------------- processing


def event_id_for(header: str, raw: bytes) -> str:
    """Razorpay's id when it sends one; otherwise one derived from the exact signed bytes."""
    header = (header or "").strip()[:64]
    return header or "body-" + hashlib.sha256(raw).hexdigest()[:40]


def _claim(db: Session, event_id: str, event: str, trigger: str, admin_id: Optional[str]):
    """
    Take the event for processing, or say why not. Returns (row, attempt) or
    (row, None) for a duplicate.
    """
    now = datetime.utcnow()
    row = db.execute(select(WebhookEvent).where(WebhookEvent.event_id == event_id).with_for_update()
                     ).scalar_one_or_none()
    if row is None:
        row = WebhookEvent(event_id=event_id, event=event, result="", received_at=now, status="processing",
                           attempts=1, duplicates=0, started_at=now, error="")
        db.add(row)
        try:
            db.flush()
        except IntegrityError:
            # The same event, delivered twice at once: the other one has it.
            db.rollback()
            return _claim(db, event_id, event, trigger, admin_id)
    else:
        stale = row.status in ("processing", "retrying") and (row.started_at or row.received_at) < now - STALE_AFTER
        if row.status != "failed" and not stale:
            if trigger == "replay":
                db.rollback()
                raise ConflictError("Only a failed event can be replayed.", error_code="WEBHOOK_NOT_FAILED")
            row.duplicates = (row.duplicates or 0) + 1
            row.last_duplicate_at = now
            db.commit()
            return row, None
        row.status = "retrying"
        row.attempts = (row.attempts or 0) + 1
        row.started_at = now
        row.completed_at = None
    attempt = WebhookEventAttempt(event_id=event_id, number=row.attempts, trigger=trigger, admin_id=admin_id,
                                  started_at=now, outcome="", result="", error="")
    db.add(attempt)
    db.commit()
    return row, attempt


def process(db: Session, event_id: str, body: dict, *, trigger: str = "delivery",
            admin_id: Optional[str] = None) -> dict:
    """
    Apply a verified event once. A failure is recorded and re-raised, so the
    webhook answers 500 and Razorpay delivers it again.
    """
    from app.services import settlement

    event = str(body.get("event", ""))[:60]
    row, attempt = _claim(db, event_id, event, trigger, admin_id)
    if attempt is None:
        logger.info("Razorpay webhook %s (%s): duplicate, acknowledged", event, event_id)
        return {"handled": False, "event": event, "duplicate": True}
    if trigger == "delivery" and row.attempts > 1:
        attempt.trigger = "redelivery"

    attempt_id = attempt.id
    try:
        result = settlement.settle_from_webhook(db, body)
    except Exception as error:  # recorded and re-raised, never swallowed
        db.rollback()
        now = datetime.utcnow()
        row = db.get(WebhookEvent, event_id)
        attempt = db.get(WebhookEventAttempt, attempt_id)
        first_failure = row.status != "failed"
        row.status = "failed"
        row.error = _describe(error)
        if first_failure:
            from app.services import inbox

            inbox.staff(db, "webhook", f"Payment webhook failed: {event}", row.error[:200],
                        "/admin/payments/webhooks?status=failed", permission="payments")
        row.completed_at = now
        row.payload = clean(body)
        attempt.outcome, attempt.error, attempt.finished_at = "failed", row.error, now
        try:
            for key, value in _related(db, body).items():
                setattr(row, key, value)
        except Exception:  # noqa: BLE001 — the ids are a nicety; the failure record isn't
            logger.exception("Could not link webhook %s to its payment", event_id)
        db.commit()
        logger.error("Razorpay webhook %s (%s) failed: %s", event, event_id, type(error).__name__)
        raise

    now = datetime.utcnow()
    row = db.get(WebhookEvent, event_id)
    attempt = db.get(WebhookEventAttempt, attempt_id)
    outcome = "ignored" if result.startswith("ignored") else "processed"
    row.status = outcome
    row.result = result[:60]
    row.error = ""
    row.completed_at = now
    row.payload = clean(body)
    for key, value in _related(db, body).items():
        setattr(row, key, value)
    attempt.outcome, attempt.result, attempt.finished_at = outcome, result[:120], now
    db.commit()
    logger.info("Razorpay webhook %s (%s): %s", event, event_id, result)
    return {"handled": outcome == "processed", "event": event}


def replay(db: Session, event_id: str, admin_id: str) -> dict:
    """
    Run a failed event again from what was kept of it. The same idempotent
    path as a delivery: a payment already settled stays settled once.
    """
    row = db.get(WebhookEvent, event_id)
    if row is None:
        raise NotFoundError("No such webhook event.", error_code="WEBHOOK_NOT_FOUND")
    if row.status != "failed":
        raise ConflictError("Only a failed event can be replayed.", error_code="WEBHOOK_NOT_FAILED")
    if not row.payload:
        raise ValidationError("This event was recorded before payloads were kept, so it can't be replayed. "
                              "Resend it from the Razorpay dashboard.", error_code="WEBHOOK_NO_PAYLOAD")
    body = dict(row.payload)
    try:
        return process(db, event_id, body, trigger="replay", admin_id=admin_id)
    except (ConflictError, NotFoundError, ValidationError):
        raise
    except Exception:  # noqa: BLE001 — recorded on the row by `process`; the admin sees the outcome
        db.rollback()
        fresh = db.get(WebhookEvent, event_id)
        return {"handled": False, "event": fresh.event, "failed": True, "error": fresh.error}


# ------------------------------------------------------------------ admin


def view(row: WebhookEvent, *, detail: bool = False) -> dict:
    out = {
        "eventId": row.event_id, "event": row.event, "status": row.status, "result": row.result,
        "error": row.error, "receivedAt": row.received_at, "startedAt": row.started_at,
        "completedAt": row.completed_at, "attempts": row.attempts, "duplicates": row.duplicates,
        "lastDuplicateAt": row.last_duplicate_at, "orderId": row.order_id, "paymentId": row.payment_id,
        "gatewayPaymentId": row.gateway_payment_id, "refundId": row.refund_id,
        "replayable": row.status == "failed" and bool(row.payload),
        "durationMs": (int((row.completed_at - row.started_at).total_seconds() * 1000)
                       if row.completed_at and row.started_at else None),
    }
    if detail:
        from app.models import Order

        out["payload"] = row.payload
        order = None
        if row.order_id:
            session = Session.object_session(row)
            order = session.get(Order, row.order_id) if session else None
        out["orderNumber"] = order.order_number if order else None
        out["attemptLog"] = [
            {"number": a.number, "trigger": a.trigger, "adminId": a.admin_id, "startedAt": a.started_at,
             "finishedAt": a.finished_at, "outcome": a.outcome, "result": a.result, "error": a.error}
            for a in row.attempt_log
        ]
    return out


def search(db: Session, *, status: str = "", event: str = "", q: str = "", since: Optional[datetime] = None,
           page: int = 1, page_size: int = 25) -> tuple:
    conditions = []
    if status in STATUSES:
        conditions.append(WebhookEvent.status == status)
    elif status == "duplicates":
        conditions.append(WebhookEvent.duplicates > 0)
    if event:
        conditions.append(WebhookEvent.event == event)
    if since:
        conditions.append(WebhookEvent.received_at >= since)
    text = (q or "").strip()
    if text:
        from app.models import Order

        orders = select(Order.id).where(Order.order_number == text)
        conditions.append(or_(WebhookEvent.event_id == text, WebhookEvent.payment_id == text,
                              WebhookEvent.gateway_payment_id == text, WebhookEvent.refund_id == text,
                              WebhookEvent.order_id == text, WebhookEvent.order_id.in_(orders)))
    total = db.execute(select(func.count()).select_from(WebhookEvent).where(*conditions)).scalar_one()
    rows = db.execute(select(WebhookEvent).where(*conditions)
                      .order_by(WebhookEvent.received_at.desc(), WebhookEvent.event_id)
                      .offset((max(1, page) - 1) * page_size).limit(page_size)).scalars().all()
    events = [e for (e,) in db.execute(select(WebhookEvent.event).distinct().order_by(WebhookEvent.event)).all()]
    return [view(r) for r in rows], total, events


def get(db: Session, event_id: str) -> WebhookEvent:
    row = db.get(WebhookEvent, event_id)
    if row is None:
        raise NotFoundError("No such webhook event.", error_code="WEBHOOK_NOT_FOUND")
    return row


def metrics(db: Session, *, since: Optional[datetime] = None) -> dict:
    conditions = [WebhookEvent.received_at >= since] if since else []
    by_status = dict(db.execute(select(WebhookEvent.status, func.count()).where(*conditions)
                                .group_by(WebhookEvent.status)).all())
    total = sum(by_status.values())
    duplicates = db.execute(select(func.coalesce(func.sum(WebhookEvent.duplicates), 0)).where(*conditions)).scalar_one()
    retried = db.execute(select(func.count()).select_from(WebhookEvent).where(*conditions, WebhookEvent.attempts > 1)
                         ).scalar_one()
    failing_now = db.execute(select(func.count()).select_from(WebhookEvent).where(WebhookEvent.status == "failed")
                             ).scalar_one()
    last = db.execute(select(func.max(WebhookEvent.received_at))).scalar_one()
    return {
        "total": total,
        "processed": by_status.get("processed", 0),
        "ignored": by_status.get("ignored", 0),
        "failed": by_status.get("failed", 0),
        "inProgress": by_status.get("processing", 0) + by_status.get("retrying", 0),
        "duplicates": int(duplicates or 0),
        "retried": retried,
        "failingNow": failing_now,
        "lastReceivedAt": last,
        "successRate": round(100 * (by_status.get("processed", 0) + by_status.get("ignored", 0)) / total, 1)
        if total else None,
    }
