"""
Payment reconciliation: our payments, compared with what Razorpay says.

**Read-only towards money.** A run fetches from the gateway, compares, and
records what it found in `payment_reconciliations` — it never settles, refunds,
cancels or edits a payment, invoice or order. A discrepancy is for a person to
look into; they close it with a note, and every step is in the audit trail.

## What is compared

For each of our Razorpay payments created in the range, and each gateway
payment in the range:

    amount-mismatch            the gateway captured a different amount
    currency-mismatch          ... in a different currency
    status-mismatch            one side says paid, the other doesn't
    payment-not-reflected      the gateway captured it; our payment isn't paid
    order-not-updated          our payment is paid; its order doesn't say so
    paid-without-payment       an order marked paid with no payment behind it
    refund-mismatch            refunded amounts disagree
    duplicate-payment          more than one captured payment for one of ours
    missing-at-gateway         paid here, nothing captured there
    missing-locally            captured there, no payment of ours
    webhook-failed             a webhook about this payment failed to process
    gateway-unreachable        this payment couldn't be checked (not "matched")

A row is `matched` only when the gateway answered and every check agreed.

## Idempotent

One row per payment (or per gateway payment we don't have), updated in place.
Re-running changes a row only if the evidence changed, and each change is an
event. A resolved row stays resolved while the evidence is the same; if it
changes, the row is reopened automatically with the reason.
"""

from __future__ import annotations

import calendar
import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional

from sqlalchemy import false, func, or_, select
from sqlalchemy.orm import Session
from starlette import status as http_status

from app.core.errors import AppError, NotFoundError, ValidationError
from app.models import Order, Payment, PaymentReconciliation, PaymentReconciliationEvent, WebhookEvent

logger = logging.getLogger(__name__)

SETTLED = ("paid", "refunded", "partially-refunded")
MAX_RANGE_DAYS = 31
STATUSES = ("matched", "mismatch", "missing-locally", "missing-externally", "requires-review")

MISMATCH = {"amount-mismatch", "currency-mismatch", "status-mismatch", "payment-not-reflected",
            "order-not-updated", "paid-without-payment", "refund-mismatch", "duplicate-payment"}
LABELS = {
    "amount-mismatch": "Amount differs from the gateway",
    "currency-mismatch": "Currency differs from the gateway",
    "status-mismatch": "Status differs from the gateway",
    "payment-not-reflected": "Captured at the gateway, not paid here",
    "order-not-updated": "Payment paid, order not marked paid",
    "paid-without-payment": "Order marked paid with no payment",
    "refund-mismatch": "Refunded amount differs",
    "duplicate-payment": "More than one captured payment",
    "missing-at-gateway": "Paid here, not captured at the gateway",
    "missing-locally": "Captured at the gateway, no payment here",
    "webhook-failed": "A webhook for this payment failed",
    "gateway-unreachable": "The gateway couldn't be asked",
}


class GatewayUnavailable(AppError):
    status_code = http_status.HTTP_502_BAD_GATEWAY
    error_code = "GATEWAY_UNAVAILABLE"


def gateway():
    """The Razorpay client, or a clear refusal. Replaced in tests."""
    from app.core.config import settings

    if settings.PAYMENT_PROVIDER != "razorpay":
        raise ValidationError("Reconciliation compares with Razorpay, which isn't the active payment provider.",
                              error_code="RECONCILIATION_UNAVAILABLE")
    from app.services.payments import get_provider

    return get_provider()


def _epoch(dt: datetime) -> int:
    return calendar.timegm(dt.utctimetuple())


def _store_currency(db: Session) -> str:
    from app.services import billing

    return ((billing.billing_config(db).get("currency") or {}).get("code") or "INR").upper()


# -------------------------------------------------------------- snapshots


def _local(payment: Payment, order: Optional[Order]) -> dict:
    return {
        "paymentId": payment.id, "status": payment.status, "amount": payment.amount,
        "refunded": payment.refunded_amount, "method": payment.method,
        "transactionId": payment.transaction_id, "reference": payment.provider_reference,
        "orderNumber": payment.order_number, "orderPaymentStatus": order.payment_status if order else None,
        "createdAt": payment.created_at_utc.isoformat() if payment.created_at_utc else None,
    }


def _remote(entity: dict) -> dict:
    """The fields compared — no contact, card or account details."""
    return {
        "id": entity.get("id"), "status": entity.get("status"), "amount": entity.get("amount"),
        "refunded": entity.get("amount_refunded") or 0, "currency": entity.get("currency"),
        "orderId": entity.get("order_id"), "method": entity.get("method"),
        "createdAt": entity.get("created_at"),
    }


def _captured(entity: dict) -> bool:
    # A refunded payment was captured first; Razorpay reports it as `refunded`.
    return entity.get("status") in ("captured", "refunded")


# ---------------------------------------------------------------- compare


def compare(payment: Payment, order: Optional[Order], entities: List[dict], currency: str,
            failed_webhooks: int = 0) -> List[str]:
    """
    The issues between one of our payments and the gateway payments that
    belong to it. Pure: no database, no gateway.
    """
    issues: List[str] = []
    captured = [e for e in entities if _captured(e)]
    ours_paid = payment.status in SETTLED

    if len(captured) > 1:
        issues.append("duplicate-payment")
    main = next((e for e in captured if e.get("id") == payment.transaction_id), None) or (captured[0] if captured else None)

    if main is None:
        if ours_paid:
            authorised = any(e.get("status") == "authorized" for e in entities)
            issues.append("status-mismatch" if authorised else "missing-at-gateway")
    else:
        if not ours_paid:
            issues.append("payment-not-reflected")
        if int(main.get("amount") or 0) != int(payment.amount or 0):
            issues.append("amount-mismatch")
        if str(main.get("currency") or "").upper() != currency:
            issues.append("currency-mismatch")
        if int(main.get("amount_refunded") or 0) != int(payment.refunded_amount or 0):
            issues.append("refund-mismatch")

    if ours_paid and order is not None and order.payment_status not in ("paid", "refunded"):
        issues.append("order-not-updated")
    if failed_webhooks:
        issues.append("webhook-failed")
    return issues


def _status_for(issues: List[str], *, local: bool, remote: bool) -> str:
    if not local:
        return "missing-locally"
    if "missing-at-gateway" in issues:
        return "missing-externally"
    if any(i in MISMATCH for i in issues):
        return "mismatch"
    if issues:
        return "requires-review"
    return "matched"


def _summary(issues: List[str]) -> str:
    return "; ".join(LABELS.get(i, i) for i in issues)[:500] if issues else "Matches the gateway."


# ----------------------------------------------------------------- record


def _find(db: Session, *, payment_id: Optional[str] = None, gateway_id: Optional[str] = None,
          order_id: Optional[str] = None) -> Optional[PaymentReconciliation]:
    if payment_id:
        row = db.execute(select(PaymentReconciliation).where(PaymentReconciliation.payment_id == payment_id)
                         ).scalar_one_or_none()
        if row is not None:
            return row
    if gateway_id:
        row = db.execute(select(PaymentReconciliation).where(
            PaymentReconciliation.gateway_payment_id == gateway_id)).scalar_one_or_none()
        if row is not None:
            return row
    if order_id and not payment_id and not gateway_id:
        return db.execute(select(PaymentReconciliation).where(
            PaymentReconciliation.order_id == order_id, PaymentReconciliation.payment_id.is_(None),
            PaymentReconciliation.gateway_payment_id.is_(None))).scalar_one_or_none()
    return None


def _record(db: Session, *, payment: Optional[Payment] = None, order: Optional[Order] = None,
            entity: Optional[dict] = None, issues: List[str], local: Optional[dict], remote: Optional[dict],
            error: str = "", now: datetime) -> PaymentReconciliation:
    gateway_id = (entity or {}).get("id") or None
    row = _find(db, payment_id=payment.id if payment else None, gateway_id=gateway_id,
                order_id=order.id if order else None)
    status = _status_for(issues, local=payment is not None or order is not None, remote=entity is not None)
    if "gateway-unreachable" in issues:
        status = "requires-review"
    summary = _summary(issues) if not error else f"Couldn't check: {error}"[:500]
    if row is None:
        row = PaymentReconciliation(created_at=now, check_count=0, resolution="open", resolution_note="")
        db.add(row)
        previous_status, previous_issues = "", None
    else:
        previous_status, previous_issues = row.status, sorted(row.issues or [])
    # Never replace a gateway id we already hold with an empty one.
    if gateway_id and not row.gateway_payment_id:
        other = _find(db, gateway_id=gateway_id)
        if other is None or other is row:
            row.gateway_payment_id = gateway_id
    row.payment_id = payment.id if payment else row.payment_id
    row.order_id = (payment.order_id if payment else None) or (order.id if order else None) or row.order_id
    row.order_number = (payment.order_number if payment else "") or (order.order_number if order else "") \
        or row.order_number or ""
    row.status, row.issues, row.summary = status, issues, summary
    row.local, row.gateway = local, remote
    row.amount = payment.amount if payment else (entity or {}).get("amount")
    row.currency = str((entity or {}).get("currency") or row.currency or "INR")[:3]
    row.paid_at = (payment.captured_at if payment else None) or row.paid_at
    row.checked_at, row.updated_at = now, now
    row.check_count = (row.check_count or 0) + 1
    row.check_error = error[:300]
    db.flush()

    changed = previous_status != status or previous_issues != sorted(issues)
    if changed:
        db.add(PaymentReconciliationEvent(reconciliation_id=row.id, action="checked", from_value=previous_status,
                                          to_value=status, note=summary[:1000], created_at=now))
        if row.resolution == "resolved" and status != "matched":
            # New evidence reopens it; what was resolved was a different finding.
            row.resolution = "open"
            db.add(PaymentReconciliationEvent(reconciliation_id=row.id, action="reopened", from_value="resolved",
                                              to_value="open", note="Reopened: the findings changed on a new check.",
                                              created_at=now))
    return row


def _failed_webhooks(db: Session, payment: Payment) -> int:
    ids = [i for i in (payment.transaction_id,) if i]
    return db.execute(select(func.count()).select_from(WebhookEvent).where(
        WebhookEvent.status == "failed",
        or_(WebhookEvent.payment_id == payment.id, WebhookEvent.gateway_payment_id.in_(ids) if ids else false()),
    )).scalar_one()


def _not_found(error) -> bool:
    """Razorpay answered, and the answer is "no such payment" — evidence, unlike an outage."""
    return getattr(error, "status", None) in (400, 404)


def _entities_for(client, payment: Payment, index: Dict[str, List[dict]]) -> List[dict]:
    """
    The gateway payments that belong to one of ours: from the listing, else
    asked for directly. Raises `RazorpayError` if the gateway couldn't answer.
    """
    from app.services.payments.razorpay import RazorpayError

    found: Dict[str, dict] = {}
    for key in (payment.transaction_id, payment.provider_reference, payment.id):
        for entity in index.get(key or "", []):
            found[entity["id"]] = entity
    if not found:
        if (payment.transaction_id or "").startswith("pay_"):
            try:
                found[payment.transaction_id] = client.payment_entity(payment.transaction_id)
            except RazorpayError as error:
                if not _not_found(error):
                    raise
        elif (payment.provider_reference or "").startswith("order_"):
            for entity in client.order_payment_entities(payment.provider_reference):
                found[entity["id"]] = entity
    return list(found.values())


def _index(entities: List[dict]) -> Dict[str, List[dict]]:
    index: Dict[str, List[dict]] = {}
    for entity in entities:
        keys = {entity.get("id"), entity.get("order_id"), (entity.get("notes") or {}).get("paymentId")}
        for key in keys - {None, ""}:
            index.setdefault(key, []).append(entity)
    return index


def _check_payment(db: Session, client, payment: Payment, index: Dict[str, List[dict]], currency: str,
                   now: datetime) -> PaymentReconciliation:
    from app.services.payments.razorpay import RazorpayError

    order = db.get(Order, payment.order_id) if payment.order_id else None
    try:
        entities = _entities_for(client, payment, index)
    except RazorpayError as problem:
        return _record(db, payment=payment, order=order, issues=["gateway-unreachable"],
                       local=_local(payment, order), remote=None, error=str(problem), now=now)
    issues = compare(payment, order, entities, currency, _failed_webhooks(db, payment))
    captured = [e for e in entities if _captured(e)]
    main = next((e for e in captured if e.get("id") == payment.transaction_id), None) \
        or (captured[0] if captured else (entities[-1] if entities else None))
    remote = _remote(main) if main else None
    if remote is not None and len(captured) > 1:
        remote["captured"] = [_remote(e) for e in captured]
    return _record(db, payment=payment, order=order, entity=main, issues=issues,
                   local=_local(payment, order), remote=remote, now=now)


# -------------------------------------------------------------------- run


def run(db: Session, start: datetime, end: datetime) -> dict:
    """Reconcile every Razorpay payment created in [start, end]. Returns what was found."""
    if end <= start:
        raise ValidationError("The end of the range must be after its start.", error_code="INVALID_RANGE")
    if end - start > timedelta(days=MAX_RANGE_DAYS):
        raise ValidationError(f"Reconcile at most {MAX_RANGE_DAYS} days at a time.", error_code="INVALID_RANGE")
    from app.services.payments.razorpay import RazorpayError

    client = gateway()
    try:
        # A little either side, so a payment created just across the boundary
        # on one side still finds its partner on the other.
        listed = client.payments_between(_epoch(start - timedelta(hours=1)), _epoch(end + timedelta(hours=1)))
    except RazorpayError as problem:
        raise GatewayUnavailable(f"Razorpay couldn't be reached: {problem}", error_code="GATEWAY_UNAVAILABLE") from None

    now = datetime.utcnow()
    currency = _store_currency(db)
    index = _index(listed)
    counts = {s: 0 for s in STATUSES}
    claimed: set = set()

    payments = db.execute(select(Payment).where(
        Payment.provider == "razorpay", Payment.created_at_utc >= start, Payment.created_at_utc < end,
    ).order_by(Payment.created_at_utc)).scalars().all()
    for payment in payments:
        row = _check_payment(db, client, payment, index, currency, now)
        counts[row.status] += 1
        for key in (payment.transaction_id, payment.provider_reference, payment.id):
            claimed.update(e["id"] for e in index.get(key or "", []))

    # Captured at the gateway, and nothing of ours accounts for it.
    for entity in listed:
        if entity.get("id") in claimed or not _captured(entity):
            continue
        created = entity.get("created_at")
        if isinstance(created, (int, float)) and not (_epoch(start) <= created < _epoch(end)):
            continue
        if (entity.get("notes") or {}).get("membershipId"):
            continue  # a membership purchase: settled against the membership, not a store payment
        row = _record(db, entity=entity, issues=["missing-locally"], local=None, remote=_remote(entity), now=now)
        counts[row.status] += 1

    # Orders marked paid with no payment of ours behind them.
    orphan_orders = db.execute(select(Order).where(
        Order.placed_at >= start, Order.placed_at < end, Order.payment_status == "paid",
        ~select(Payment.id).where(Payment.order_id == Order.id).exists(),
    )).scalars().all()
    for order in orphan_orders:
        row = _record(db, order=order, issues=["paid-without-payment"],
                      local={"orderNumber": order.order_number, "orderPaymentStatus": order.payment_status,
                             "method": order.payment_method},
                      remote=None, now=now)
        counts[row.status] += 1

    db.commit()
    checked = sum(counts.values())
    logger.info("Reconciled %s payment records (%s to %s)", checked, start, end)
    return {"checked": checked, "gatewayPayments": len(listed), "counts": counts,
            "from": start, "to": end, "ranAt": now}


def recheck(db: Session, row_id: int) -> PaymentReconciliation:
    """Check one record again, straight from the gateway."""
    row = get(db, row_id)
    client = gateway()
    now = datetime.utcnow()
    from app.services.payments.razorpay import RazorpayError

    if row.payment_id:
        payment = db.get(Payment, row.payment_id)
        if payment is not None:
            out = _check_payment(db, client, payment, {}, _store_currency(db), now)
            db.commit()
            return out
    if row.gateway_payment_id:
        try:
            entity = client.payment_entity(row.gateway_payment_id)
        except RazorpayError as problem:
            raise GatewayUnavailable(f"Razorpay couldn't be reached: {problem}") from None
        ours = db.execute(select(Payment).where(or_(
            Payment.transaction_id == entity.get("id"),
            Payment.provider_reference == (entity.get("order_id") or "-"),
        )).limit(1)).scalar_one_or_none()
        if ours is not None:
            out = _check_payment(db, client, ours, _index([entity]), _store_currency(db), now)
        else:
            issues = ["missing-locally"] if _captured(entity) else []
            out = _record(db, entity=entity, issues=issues, local=None, remote=_remote(entity), now=now)
        db.commit()
        return out
    if row.order_id:
        order = db.get(Order, row.order_id)
        if order is not None:
            has_payment = db.execute(select(Payment.id).where(Payment.order_id == order.id).limit(1)).first()
            issues = ["paid-without-payment"] if order.payment_status == "paid" and not has_payment else []
            out = _record(db, order=order, issues=issues,
                          local={"orderNumber": order.order_number, "orderPaymentStatus": order.payment_status,
                                 "method": order.payment_method}, remote=None, now=now)
            db.commit()
            return out
    raise ValidationError("There's nothing left to check this record against.", error_code="NOTHING_TO_CHECK")


# ------------------------------------------------------------ resolution


def _admin_event(db: Session, row: PaymentReconciliation, admin, action: str, from_value: str, to_value: str,
                 note: str) -> None:
    db.add(PaymentReconciliationEvent(reconciliation_id=row.id, action=action, from_value=from_value,
                                      to_value=to_value, note=note, admin_id=admin.id,
                                      admin_name=getattr(admin, "name", "") or getattr(admin, "email", ""),
                                      created_at=datetime.utcnow()))


def _note(note: str) -> str:
    note = (note or "").strip()
    if len(note) < 5:
        raise ValidationError("Add a note saying what was found or done (at least 5 characters).",
                              error_code="NOTE_REQUIRED")
    return note[:1000]


def resolve(db: Session, row_id: int, admin, note: str) -> PaymentReconciliation:
    """
    Close a finding. Records *that a person reviewed it* — it doesn't change
    the payment, and doesn't make a mismatch "matched".
    """
    note = _note(note)
    row = get(db, row_id, lock=True)
    if row.resolution == "resolved":
        raise ValidationError("This is already resolved.", error_code="ALREADY_RESOLVED")
    if row.status == "matched":
        raise ValidationError("A matched payment has nothing to resolve.", error_code="NOTHING_TO_RESOLVE")
    now = datetime.utcnow()
    row.resolution, row.resolved_by, row.resolved_at, row.resolution_note = "resolved", admin.id, now, note
    row.updated_at = now
    _admin_event(db, row, admin, "resolved", "open", "resolved", note)
    db.commit()
    return row


def reopen(db: Session, row_id: int, admin, note: str) -> PaymentReconciliation:
    note = _note(note)
    row = get(db, row_id, lock=True)
    if row.resolution != "resolved":
        raise ValidationError("This isn't resolved.", error_code="NOT_RESOLVED")
    row.resolution, row.updated_at = "open", datetime.utcnow()
    _admin_event(db, row, admin, "reopened", "resolved", "open", note)
    db.commit()
    return row


# ------------------------------------------------------------------ admin


def get(db: Session, row_id: int, *, lock: bool = False) -> PaymentReconciliation:
    query = select(PaymentReconciliation).where(PaymentReconciliation.id == row_id)
    row = db.execute(query.with_for_update() if lock else query).scalar_one_or_none()
    if row is None:
        raise NotFoundError("No such reconciliation record.", error_code="RECONCILIATION_NOT_FOUND")
    return row


def view(row: PaymentReconciliation, *, detail: bool = False) -> dict:
    from app.services import billing

    out = {
        "id": row.id, "paymentId": row.payment_id, "gatewayPaymentId": row.gateway_payment_id,
        "orderId": row.order_id, "orderNumber": row.order_number, "status": row.status,
        "issues": [{"code": i, "label": LABELS.get(i, i)} for i in (row.issues or [])],
        "summary": row.summary, "amount": billing.to_major(row.amount) if row.amount is not None else None,
        "currency": row.currency, "paidAt": row.paid_at, "checkedAt": row.checked_at,
        "checkCount": row.check_count, "checkError": row.check_error, "resolution": row.resolution,
        "resolvedAt": row.resolved_at, "resolutionNote": row.resolution_note,
    }
    if detail:
        out["local"], out["gateway"] = row.local, row.gateway
        out["events"] = [{"action": e.action, "from": e.from_value, "to": e.to_value, "note": e.note,
                          "adminName": e.admin_name, "at": e.created_at} for e in row.events]
    return out


def search(db: Session, *, status: str = "", resolution: str = "", q: str = "",
           start: Optional[datetime] = None, end: Optional[datetime] = None,
           page: int = 1, page_size: int = 25) -> tuple:
    conditions = []
    if status in STATUSES:
        conditions.append(PaymentReconciliation.status == status)
    elif status == "issues":
        conditions.append(PaymentReconciliation.status != "matched")
    if resolution in ("open", "resolved"):
        conditions.append(PaymentReconciliation.resolution == resolution)
    if start:
        conditions.append(PaymentReconciliation.checked_at >= start)
    if end:
        conditions.append(PaymentReconciliation.checked_at < end)
    text = (q or "").strip()
    if text:
        conditions.append(or_(PaymentReconciliation.payment_id == text,
                              PaymentReconciliation.gateway_payment_id == text,
                              PaymentReconciliation.order_number == text))
    total = db.execute(select(func.count()).select_from(PaymentReconciliation).where(*conditions)).scalar_one()
    rows = db.execute(select(PaymentReconciliation).where(*conditions)
                      .order_by(PaymentReconciliation.checked_at.desc(), PaymentReconciliation.id.desc())
                      .offset((max(1, page) - 1) * page_size).limit(page_size)).scalars().all()
    counts = dict(db.execute(select(PaymentReconciliation.status, func.count())
                             .where(PaymentReconciliation.resolution == "open")
                             .group_by(PaymentReconciliation.status)).all())
    last = db.execute(select(func.max(PaymentReconciliation.checked_at))).scalar_one()
    return [view(r) for r in rows], total, {"open": counts, "lastCheckedAt": last}
