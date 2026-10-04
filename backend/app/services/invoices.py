"""Invoices, payments, refunds and credit notes."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import List, Optional

from sqlalchemy import Select, and_, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import (
    CreditNote,
    Invoice,
    Order,
    Payment,
    PaymentEvent,
    Refund,
    RefundItem,
)
from app.services import billing
from app.services.lookup.filters import any_id_condition
from app.services.payments import get_provider
from app.utils.ids import next_id

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------- invoices


def _invoice_query() -> Select:
    return select(Invoice).options(selectinload(Invoice.items))


def list_invoices(
    db: Session,
    *,
    customer_id: Optional[str] = None,
    order_id: Optional[str] = None,
    search: Optional[str] = None,
    status: Optional[str] = None,
    payment_status: Optional[str] = None,
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    min_amount: Optional[int] = None,
) -> List[Invoice]:
    statement = _invoice_query()
    conditions = []

    if customer_id:
        conditions.append(Invoice.customer_id == customer_id)
    if order_id:
        conditions.append(Invoice.order_id == order_id)
    if status and status != "all":
        conditions.append(Invoice.status == status)
    if payment_status and payment_status != "all":
        conditions.append(Invoice.payment_status == payment_status)
    if date_from:
        conditions.append(Invoice.issued_at >= date_from)
    if date_to:
        conditions.append(Invoice.issued_at <= date_to)
    if min_amount is not None:
        conditions.append(Invoice.grand_total >= min_amount)

    # `search` is an ID, matched exactly (docs/id-lookup.md): the invoice's
    # own (DCZ-INV-2026-000001 / INV001) or its order's (DCZ10241 / ORD001).
    # A customer's name or email is not an ID and matches nothing.
    by_id = any_id_condition(search, ("invoice", None, None), ("order", Invoice.order_id, Order.id))
    if by_id is not None:
        conditions.append(by_id)

    if conditions:
        statement = statement.where(and_(*conditions))

    return list(
        db.execute(statement.order_by(Invoice.issued_at.desc())).unique().scalars().all()
    )


def get_invoice(db: Session, invoice_id: str, *, customer_id: Optional[str] = None) -> Invoice:
    invoice = db.execute(
        _invoice_query().where(Invoice.id == invoice_id)
    ).unique().scalar_one_or_none()

    # "Not yours" reads as "not found": whether an invoice exists is itself
    # something a stranger should not be able to discover.
    if invoice is None or (customer_id and invoice.customer_id != customer_id):
        raise NotFoundError(f"No invoice '{invoice_id}'.", error_code="INVOICE_NOT_FOUND")

    return invoice


def get_invoice_by_order(db: Session, order_id: str) -> Optional[Invoice]:
    return db.execute(
        _invoice_query().where(Invoice.order_id == order_id)
    ).unique().scalar_one_or_none()


def amount_due(invoice: Invoice) -> int:
    return max(0, invoice.grand_total - invoice.amount_paid - invoice.amount_refunded)


def is_overdue(invoice: Invoice, now: Optional[datetime] = None) -> bool:
    """
    Derived, never stored.

    An invoice becomes overdue while nobody is looking, and no job runs
    overnight to relabel it — so a stored flag would be wrong by morning.
    """
    if invoice.status in ("paid", "cancelled"):
        return False
    if invoice.amount_paid >= invoice.grand_total:
        return False
    return invoice.due_at < (now or datetime.utcnow())


def mark_paid(db: Session, invoice_id: str, amount: Optional[int] = None) -> Invoice:
    """
    Record a settlement.

    Accepts a partial payment, because part-paid is a real state. The status
    follows the arithmetic rather than being passed in — two sources of truth
    for "is this paid" is how they come to disagree.
    """
    invoice = get_invoice(db, invoice_id)
    outstanding = invoice.grand_total - invoice.amount_paid
    settled = min(outstanding, amount if amount is not None else outstanding)

    invoice.amount_paid += max(0, settled)
    fully = invoice.amount_paid >= invoice.grand_total

    invoice.status = "paid" if fully else ("issued" if invoice.status == "draft" else invoice.status)
    invoice.payment_status = "paid" if fully else "pending"

    payment = db.execute(
        select(Payment).where(Payment.invoice_id == invoice.id)
    ).scalar_one_or_none()

    now = datetime.utcnow()
    if payment and fully and payment.status == "pending":
        payment.status = "paid"
        payment.captured_at = now
        payment.events.append(
            PaymentEvent(status="succeeded", note="Marked as received.", occurred_at=now)
        )

    order = db.get(Order, invoice.order_id)
    if order and fully:
        order.payment_status = "paid"

    db.commit()
    db.refresh(invoice)
    return invoice


# ---------------------------------------------------------------- payments


def list_payments(
    db: Session,
    *,
    customer_id: Optional[str] = None,
    order_id: Optional[str] = None,
    search: Optional[str] = None,
    status: Optional[str] = None,
    method: Optional[str] = None,
) -> List[Payment]:
    statement = select(Payment).options(selectinload(Payment.events))
    conditions = []

    if customer_id:
        conditions.append(Payment.customer_id == customer_id)
    if order_id:
        conditions.append(Payment.order_id == order_id)
    if status and status != "all":
        conditions.append(Payment.status == status)
    if method and method != "all":
        conditions.append(Payment.method == method)

    # An ID, exactly: the Payment ID or gateway transaction id, the Order ID
    # or the Invoice ID. Names and emails match nothing.
    by_id = any_id_condition(
        search,
        ("payment", None, None),
        ("order", Payment.order_id, Order.id),
        ("invoice", Payment.invoice_id, Invoice.id),
    )
    if by_id is not None:
        conditions.append(by_id)

    if conditions:
        statement = statement.where(and_(*conditions))

    return list(
        db.execute(statement.order_by(Payment.created_at_utc.desc())).unique().scalars().all()
    )


def get_payment(db: Session, payment_id: str) -> Payment:
    payment = db.execute(
        select(Payment).options(selectinload(Payment.events)).where(Payment.id == payment_id)
    ).unique().scalar_one_or_none()

    if payment is None:
        raise NotFoundError(f"No payment '{payment_id}'.", error_code="PAYMENT_NOT_FOUND")

    return payment


def refundable_amount(payment: Payment) -> int:
    if payment.status in ("failed", "pending"):
        return 0
    return max(0, payment.amount - payment.refunded_amount)


def capture_payment(db: Session, payment_id: str) -> Payment:
    """Settle a pending payment — a courier collecting cash, a transfer landing."""
    payment = get_payment(db, payment_id)
    # Only money still owed can be received. Capturing a refunded (or failed)
    # payment flipped it back to "paid" and reset the invoice as if the money
    # given back had been collected again.
    if payment.status not in ("pending", "authorized"):
        raise ConflictError(
            f"This payment is {payment.status}; only a pending payment can be marked as received.",
            error_code="PAYMENT_NOT_CAPTURABLE",
        )
    now = datetime.utcnow()

    payment.status = "paid"
    payment.captured_at = now
    payment.events.append(
        PaymentEvent(status="succeeded", note="Marked as received.", occurred_at=now)
    )

    invoice = db.get(Invoice, payment.invoice_id)
    if invoice:
        invoice.amount_paid = invoice.grand_total
        invoice.status = "paid"
        invoice.payment_status = "paid"

    order = db.get(Order, payment.order_id)
    if order:
        order.payment_status = "paid"

    db.commit()
    db.refresh(payment)
    return payment


# ----------------------------------------------------------------- refunds
#
# The money side of every refund — the portal's, a return's, a cancellation's —
# lives here, in one place. `services/refunds.py` works out *what* a refund of
# some lines, quantities and shipping comes to; this records it and moves it.
# See docs/refunds.md for the lifecycle.

#: Every status a refund can have. `rejected` is kept for refunds turned down
#: at approval (and the ones raised before approval existed); `cancelled` is a
#: refund withdrawn before any money moved.
REFUND_STATUSES = ("requested", "processing", "completed", "failed", "cancelled", "rejected")
#: The ones that hold money: counted against what is left to refund, so a
#: refund waiting for approval can't be refunded a second time meanwhile.
ACTIVE_REFUND_STATUSES = ("requested", "processing", "completed")
FINAL_REFUND_STATUSES = ("completed", "cancelled", "rejected")
#: Older clients sent "pending" for a refund that waits; it always meant this.
REFUND_STATUS_ALIASES = {"pending": "requested"}
REFUND_METHODS = ("original", "store-credit")
REASON_CODES = (
    "customer-requested", "wrong-product", "damaged", "defective", "missing-item", "price-adjustment",
    "duplicate-payment", "cancellation", "return-approved", "other",
)


class RefundNotRecordedYet(ConflictError):
    """
    A refund webhook for one of our payments that names no refund we have.

    Almost always the gateway answering faster than we committed. Raised so
    the webhook is answered with an error and Razorpay delivers it again (and
    the webhook monitor keeps it, replayable) — never acknowledged and lost.
    """

    error_code = "REFUND_NOT_RECORDED_YET"


def normalise_refund_status(status: Optional[str]) -> str:
    value = REFUND_STATUS_ALIASES.get((status or "").strip(), (status or "").strip())
    if value not in REFUND_STATUSES:
        raise ValidationError(f"'{status}' isn't a refund status.", error_code="INVALID_STATUS",
                              details={"allowed": list(REFUND_STATUSES)})
    return value


def payment_share(refund: Refund) -> int:
    """What of a refund is the payment's (gateway or cash) part. Old refunds were all payment."""
    return refund.amount if refund.gateway_amount is None else refund.gateway_amount


def _collected(payment: Optional[Payment]) -> int:
    if payment is None or payment.status in ("failed", "pending"):
        return 0
    return payment.amount


def _is_direct(payment: Payment) -> bool:
    # A COD payment under a real gateway still carries a `COD-<order>`
    # reference that the gateway has never seen, so the method decides too.
    return not payment.transaction_id or payment.provider == "internal" or payment.method == "cod"


def list_refunds(
    db: Session,
    *,
    customer_id: Optional[str] = None,
    order_id: Optional[str] = None,
    status: Optional[str] = None,
    search: Optional[str] = None,
) -> List[Refund]:
    statement = select(Refund).options(selectinload(Refund.items))
    conditions = []

    if customer_id:
        conditions.append(Refund.customer_id == customer_id)
    if order_id:
        conditions.append(Refund.order_id == order_id)
    if status and status != "all":
        conditions.append(Refund.status == REFUND_STATUS_ALIASES.get(status, status))

    # An ID, exactly: the Refund ID (number, RFD001 or gateway reference),
    # the Order ID or the Invoice ID. A name or a reason is not an ID.
    by_id = any_id_condition(
        search,
        ("refund", None, None),
        ("order", Refund.order_id, Order.id),
        ("invoice", Refund.invoice_id, Invoice.id),
    )
    if by_id is not None:
        conditions.append(by_id)

    if conditions:
        statement = statement.where(and_(*conditions))

    return list(
        db.execute(statement.order_by(Refund.requested_at.desc())).unique().scalars().all()
    )


def get_refund(db: Session, refund_id: str, *, lock: bool = False) -> Refund:
    query = select(Refund).options(selectinload(Refund.items)).where(Refund.id == refund_id)
    if lock:
        query = query.with_for_update()
    refund = db.execute(query).unique().scalar_one_or_none()

    if refund is None:
        raise NotFoundError(f"No refund '{refund_id}'.", error_code="REFUND_NOT_FOUND")

    return refund


def _next_refund_number(db: Session, issued: datetime, sequence: int) -> str:
    """
    A refund's reference, in the store's own series.

    Same reasoning as the invoice number: one writer, one counter, a format
    nobody can change. `sequence` is the floor the caller worked out; the
    locked numeric read of the highest issued number decides.
    """
    from app.core import numbering

    return numbering.REFUND.yearly(issued.year, max(sequence, numbering.highest(db, Refund.refund_number) + 1))


def refund_rooms(db: Session, invoice: Invoice, payment: Optional[Payment], *, exclude_id: Optional[str] = None,
                 tender_split: bool = True) -> dict:
    """
    What is still left to refund on an order, by where it would go back.

    **Counted from the refunds themselves**, requested and processing as well
    as completed: a refund waiting for approval holds its money, so a second
    one can't be raised against the same rupees meanwhile. The payment's own
    `refunded_amount` is a second bound (it is what the gateway has been
    asked for), and the lower of the two wins.
    """
    from app.services import tenders

    rows = list(db.execute(select(Refund).where(
        Refund.invoice_id == invoice.id, Refund.status.in_(ACTIVE_REFUND_STATUSES))).scalars())
    rows = [row for row in rows if row.id != exclude_id]
    held_payment = sum(payment_share(row) for row in rows)
    unsent = sum(payment_share(row) for row in rows if not row.gateway_settled and row.method == "original")
    payment_room = 0
    if payment is not None:
        payment_room = max(0, min(_collected(payment) - held_payment, refundable_amount(payment) - unsent))
    tender_room = 0
    if tender_split and tenders.tender_total(invoice) > 0:
        unsettled = sum(row.tender_amount or 0 for row in rows if not row.tenders_settled)
        tender_room = max(0, tenders.unreversed(db, invoice.order_id) - unsettled)
    return {"payment": payment_room, "tenders": tender_room, "total": payment_room + tender_room,
            "held": held_payment + sum(row.tender_amount or 0 for row in rows)}


def split_refund(invoice: Invoice, amount: int, rooms: dict) -> tuple:
    """
    Share a refund between the payment and the tenders (gift cards, store
    credit, points) in the proportion they paid the invoice, within what each
    has left. Returns (payment_amount, tender_amount); they add up to `amount`.
    """
    from app.services import tenders

    tendered = tenders.tender_total(invoice)
    if not tendered or rooms["tenders"] <= 0:
        return amount, 0
    paid_by_payment = max(0, invoice.grand_total - tendered)
    share = (amount * paid_by_payment + invoice.grand_total // 2) // max(1, invoice.grand_total)
    share = min(share, rooms["payment"])
    tender_share = amount - share
    if tender_share > rooms["tenders"]:
        share += tender_share - rooms["tenders"]
        tender_share = rooms["tenders"]
    return share, tender_share


def _validate_lines(invoice: Invoice, amount: int, lines: List[dict]) -> List[RefundItem]:
    """
    Free-form lines, as the old portal and API sent them: each must be a
    product on this invoice, a whole quantity no more than was invoiced, and
    together worth no more than the refund.
    """
    invoiced: dict = {}
    for item in invoice.items:
        invoiced[item.product_id] = invoiced.get(item.product_id, 0) + item.quantity
    out, total = [], 0
    for line in lines:
        if not isinstance(line, dict):
            raise ValidationError("Each refund line must be an object.", error_code="INVALID_REFUND_LINES")
        product_id = str(line.get("productId") or "")
        try:
            quantity = int(line.get("quantity", 1))
            line_amount = int(line.get("amount", 0))
        except (TypeError, ValueError):
            raise ValidationError("Refund line quantities and amounts must be whole numbers.",
                                  error_code="INVALID_REFUND_LINES") from None
        if product_id not in invoiced:
            raise ValidationError(f"'{product_id}' isn't on this invoice.", error_code="INVALID_REFUND_LINES")
        if not 1 <= quantity <= invoiced[product_id]:
            raise ValidationError(f"Refund between 1 and {invoiced[product_id]} of {product_id}.",
                                  error_code="INVALID_REFUND_LINES")
        if line_amount < 0:
            raise ValidationError("A refund line can't be negative.", error_code="INVALID_REFUND_LINES")
        total += line_amount
        out.append(RefundItem(product_id=product_id, name=str(line.get("name", ""))[:200], quantity=quantity,
                              amount=line_amount))
    if total > amount:
        raise ValidationError("The lines add up to more than the refund.", error_code="INVALID_REFUND_LINES")
    return out


def find_by_idempotency_key(db: Session, key: Optional[str], *, lock: bool = False) -> Optional[Refund]:
    if not key:
        return None
    query = select(Refund).where(Refund.idempotency_key == key)
    if lock:
        query = query.with_for_update()
    return db.execute(query).scalar_one_or_none()


def create_refund(
    db: Session,
    *,
    invoice_id: str,
    amount: int,
    reason: str,
    lines: Optional[List[dict]] = None,
    initiated_by: str = "customer",
    status: str = "completed",
    tender_split: bool = True,
    method: str = "original",
    reason_code: str = "other",
    internal_note: str = "",
    idempotency_key: Optional[str] = None,
    items: Optional[List[RefundItem]] = None,
    shipping_amount: int = 0,
    tax_amount: int = 0,
    discount_amount: int = 0,
    requires_approval: bool = False,
    manual_reference: str = "",
) -> Refund:
    """
    Raise a refund, and — unless it is to wait (`status="requested"`) — send it.

    **Over-refunding is refused against what is left**, counted from every
    refund still holding money (requested, processing, completed), not only
    the completed ones: two partial refunds that each look reasonable can
    together exceed what was actually collected.

    **Recorded before it is sent.** The refund is committed as `processing`
    *before* the gateway is called. If the call times out after the gateway
    accepted it, the row is there to be reconciled — looked up at the gateway
    by its number before anything is sent again — instead of a retry
    refunding the customer twice.

    `idempotency_key`: the same key again returns the refund it made.
    """
    key = (idempotency_key or "").strip()[:80] or None
    existing = find_by_idempotency_key(db, key)
    if existing is not None:
        return _replayed(existing, invoice_id)

    status = normalise_refund_status(status)
    if status not in ("requested", "completed", "processing"):
        raise ValidationError("A new refund is either sent now or left requested.", error_code="INVALID_STATUS")
    if method not in REFUND_METHODS:
        raise ValidationError("Choose how the refund goes back.", error_code="INVALID_METHOD",
                              details={"allowed": list(REFUND_METHODS)})
    if reason_code not in REASON_CODES:
        raise ValidationError("Choose a reason from the list.", error_code="INVALID_REASON_CODE",
                              details={"allowed": list(REASON_CODES)})
    if amount is None or amount <= 0:
        raise ValidationError("Enter a refund amount above zero.", error_code="INVALID_AMOUNT")
    if not (reason or "").strip():
        raise ValidationError("Give a reason for the refund.", error_code="REASON_REQUIRED")

    # One refund decision per invoice at a time: the cap is read and the row
    # written under this lock, so two refunds sent at once can't both fit.
    db.execute(select(Invoice.id).where(Invoice.id == invoice_id).with_for_update())
    invoice = get_invoice(db, invoice_id)
    existing = find_by_idempotency_key(db, key, lock=True)
    if existing is not None:
        return _replayed(existing, invoice_id)

    payment = db.execute(
        select(Payment).where(Payment.invoice_id == invoice.id)
    ).scalar_one_or_none()

    if payment is None:
        raise ConflictError("This invoice has no payment to refund against.",
                            error_code="NO_PAYMENT")

    from app.services import tenders

    rooms = refund_rooms(db, invoice, payment, tender_split=tender_split)
    if tender_split and tenders.tender_total(invoice) > 0 and payment.status in ("pending", "failed") \
            and invoice.status != "paid":
        rooms = {"payment": 0, "tenders": 0, "total": 0, "held": rooms["held"]}
    if rooms["total"] <= 0:
        raise ConflictError(
            "Nothing has been collected on this order yet."
            if payment.status == "pending"
            else "This payment has already been refunded in full.",
            error_code="NOTHING_TO_REFUND",
        )

    if amount > rooms["total"]:
        raise ConflictError(
            "That is more than is left to refund on this payment.",
            error_code="REFUND_EXCEEDS_PAYMENT",
            details={"remaining": rooms["total"]},
        )

    refund_items = list(items) if items is not None else _validate_lines(invoice, amount, lines or [])
    gateway_amount, tender_amount = split_refund(invoice, amount, rooms)

    now = datetime.utcnow()
    sequence = db.execute(select(func.count()).select_from(Refund)).scalar_one() + 1

    refund = Refund(
        id=next_id(db, Refund, "refund"),
        refund_number=_next_refund_number(db, now, sequence),
        order_id=invoice.order_id,
        order_number=invoice.order_number,
        invoice_id=invoice.id,
        invoice_number=invoice.invoice_number,
        payment_id=payment.id,
        customer_id=invoice.customer_id,
        customer_name=invoice.customer_name,
        amount=amount,
        gateway_amount=gateway_amount,
        tender_amount=tender_amount,
        reason=reason.strip()[:255],
        status="requested" if status == "requested" else "processing",
        requested_at=now,
        processed_at=None,
        initiated_by=initiated_by,
        method=method,
        reason_code=reason_code,
        internal_note=(internal_note or "").strip()[:1000],
        idempotency_key=key,
        shipping_amount=max(0, int(shipping_amount or 0)),
        tax_amount=max(0, int(tax_amount or 0)),
        discount_amount=max(0, int(discount_amount or 0)),
        requires_approval=bool(requires_approval),
        manual_reference=(manual_reference or "").strip()[:120],
        failure_reason="",
        attempts=0,
        gateway_settled=False,
        tenders_settled=False,
        completed_effects=False,
    )
    refund.items = refund_items
    db.add(refund)

    from app.services import audit

    audit.record(db, "refund.created", resource_type="refund", resource_id=refund.id,
                 summary=f"Refund {refund.refund_number} of ₹{amount / 100:,.2f} raised on {invoice.order_number}",
                 details={"amount": amount, "method": method, "reasonCode": reason_code, "status": refund.status,
                          "requiresApproval": refund.requires_approval},
                 system=initiated_by in ("system", "customer"))
    try:
        db.commit()
    except IntegrityError:
        # The same idempotency key, sent twice at once: the other one made it.
        db.rollback()
        existing = find_by_idempotency_key(db, key)
        if existing is None:
            raise
        return _replayed(existing, invoice_id)

    if refund.status == "processing":
        dispatch_refund(db, refund.id)
    db.refresh(refund)
    return refund


def _replayed(refund: Refund, invoice_id: str) -> Refund:
    if refund.invoice_id != invoice_id:
        raise ConflictError("That idempotency key was already used for a different refund.",
                            error_code="IDEMPOTENCY_KEY_REUSED")
    refund._replayed = True
    return refund


# ---- moving the money ---------------------------------------------------


def dispatch_refund(db: Session, refund_id: str) -> Refund:
    """
    Send a `processing` refund on its way — and on every later attempt, the
    same door: the job's, a retry button's, a return's.

    The payment's share goes back by the refund's method: through the
    gateway, paid back directly (cash on delivery, or nothing through the
    gateway), or as store credit. The tenders' share goes back to the gift
    cards, store credit and points that paid. A gateway that refuses leaves the
    refund `failed` (committed) and raises `PROVIDER_REFUSED`; one that doesn't
    answer leaves it `processing`, to be looked up — never blindly resent.
    """
    refund = get_refund(db, refund_id, lock=True)
    if refund.status != "processing":
        return refund
    payment = db.get(Payment, refund.payment_id)
    invoice = db.get(Invoice, refund.invoice_id)
    if payment is None or invoice is None:
        raise ConflictError("The invoice or payment for this refund is missing.", error_code="REFUND_ORPHANED")

    share = payment_share(refund)
    if refund.gateway_settled or refund.method == "store-credit" or share <= 0 or _is_direct(payment):
        _book_payment_share(db, refund, payment, invoice)
        _book_tenders(db, refund, invoice)
        if refund.method == "store-credit" or share <= 0 or _is_direct(payment):
            _complete(db, refund, payment, invoice)
        _recompute_statuses(db, invoice, payment)
        db.commit()
        db.refresh(refund)
        return refund

    _send_to_gateway(db, refund, payment, invoice)
    db.refresh(refund)
    return refund


def _gateway_event(payment: Payment, status: str, note: str) -> None:
    payment.events.append(PaymentEvent(status=status, note=note[:500], occurred_at=datetime.utcnow()))


def _poll_minutes(db: Session) -> int:
    from app.services import refunds as refund_service

    return int(refund_service.settings(db)["pollMinutes"])


def _send_to_gateway(db: Session, refund: Refund, payment: Payment, invoice: Invoice) -> None:
    provider = get_provider()
    share = payment_share(refund)
    rupees = f"₹{share / 100:,.2f}"
    result = None

    # Sent before and never heard back: ask the gateway first. Retrying
    # without asking is how a timeout becomes a double refund.
    if refund.attempts > 0 and hasattr(provider, "find_refund"):
        try:
            found = provider.find_refund(payment.transaction_id, refund.refund_number)
        except Exception as error:  # noqa: BLE001 — the gateway couldn't be asked; nothing is resent
            logger.warning("Refund %s: the gateway couldn't be asked about it: %s", refund.refund_number, error)
            refund.failure_reason = "We couldn't reach the payment gateway to check this refund; we'll try again."
            refund.next_check_at = datetime.utcnow() + timedelta(minutes=_poll_minutes(db))
            _gateway_event(payment, "refund-unknown",
                           f"Refund {refund.refund_number}: the gateway couldn't be asked about it; not resent.")
            db.commit()
            return
        if found is not None and found.status != "rejected":
            result = found
            _gateway_event(payment, "refund-found",
                           f"Refund {refund.refund_number} was found at the gateway ({found.reference}); not resent.")

    if result is None:
        refund.attempts = (refund.attempts or 0) + 1
        refund.last_attempt_at = datetime.utcnow()
        _gateway_event(payment, "refund-sent",
                       f"Refund {refund.refund_number} of {rupees} sent to the gateway (attempt {refund.attempts}).")
        # Recorded before the call, so the attempt survives whatever happens to it.
        db.commit()
        result = provider.refund(
            payment.transaction_id, share, f"{refund.refund_number}: {refund.reason}"[:255],
            receipt=refund.refund_number, notes={"refundNumber": refund.refund_number, "refundId": refund.id},
        )
        refund = get_refund(db, refund.id, lock=True)
        payment = db.get(Payment, refund.payment_id)
        invoice = db.get(Invoice, refund.invoice_id)
        if refund.status != "processing":
            # Its webhook arrived while we waited for the answer, and settled it.
            db.commit()
            return

    now = datetime.utcnow()
    if result.ok:
        refund.gateway_reference = result.reference or refund.gateway_reference
        refund.failure_reason = ""
        _book_payment_share(db, refund, payment, invoice)
        _book_tenders(db, refund, invoice)
        if result.status == "completed":
            _complete(db, refund, payment, invoice)
        else:
            refund.next_check_at = now + timedelta(minutes=_poll_minutes(db))
            from app.services.email.notifications import notify_refund

            notify_refund(db, refund, invoice.customer_email)
        _recompute_statuses(db, invoice, payment)
        db.commit()
        return

    if result.status == "unknown":
        refund.failure_reason = "The payment gateway didn't confirm this refund. It is checked before any retry."
        refund.next_check_at = now + timedelta(minutes=_poll_minutes(db))
        _gateway_event(payment, "refund-unknown",
                       f"Refund {refund.refund_number}: no answer from the gateway ({result.failure_reason}).")
        db.commit()
        return

    _fail(db, refund, result.failure_reason or "The payment gateway declined this refund.")
    db.commit()
    raise ConflictError(
        "The payment provider declined this refund. Please try again or contact support.",
        error_code="PROVIDER_REFUSED",
    )


def _book_payment_share(db: Session, refund: Refund, payment: Payment, invoice: Invoice) -> None:
    """The payment's share, booked once: against the payment (or as store credit) and the invoice."""
    if refund.gateway_settled:
        return
    share = payment_share(refund)
    now = datetime.utcnow()
    if share > 0:
        if refund.method == "store-credit":
            from app.services import store_credit

            store_credit.credit_customer(
                db, refund.customer_id, kind="refund", amount=share, key=f"refund:{refund.id}:store-credit",
                order_id=refund.order_id, refund_id=refund.id, reason=f"Refund {refund.refund_number}",
            )
            # The gateway never sees it, so the payment's own refunded amount
            # (which reconciliation checks against the gateway's) is untouched.
            _gateway_event(payment, "store-credit",
                           f"Refund {refund.refund_number}: ₹{share / 100:,.2f} given as store credit — {refund.reason}.")
        else:
            direct = _is_direct(payment)
            payment.refunded_amount = min(payment.amount, payment.refunded_amount + share)
            payment.status = "refunded" if payment.refunded_amount >= payment.amount else "partially-refunded"
            reference = f" (ref {refund.manual_reference})" if refund.manual_reference else ""
            payment.events.append(PaymentEvent(
                status="refunded",
                note=(
                    f"{'Full' if payment.status == 'refunded' else 'Partial'} refund "
                    f"{'paid back directly' if direct else 'initiated'}{reference} — {refund.reason}."
                )[:500],
                occurred_at=now,
            ))
        invoice.amount_refunded += share
    refund.gateway_settled = True


def _book_tenders(db: Session, refund: Refund, invoice: Invoice) -> None:
    """The tenders' share, back to the gift cards, store credit and points. Once."""
    if refund.tenders_settled:
        return
    from app.services import tenders

    if refund.tender_amount:
        tenders.reverse_for_refund(db, refund)
        invoice.amount_refunded += refund.tender_amount
    refund.tenders_settled = True


def _recompute_statuses(db: Session, invoice: Invoice, payment: Optional[Payment]) -> None:
    """
    The invoice's and order's payment status, from the amounts — never set
    piecemeal, which is how a failed refund used to leave an order "refunded".
    """
    if payment is not None and payment.status in ("paid", "refunded", "partially-refunded"):
        if payment.refunded_amount <= 0:
            payment.status = "paid"
        elif payment.refunded_amount >= payment.amount:
            payment.status = "refunded"
        else:
            payment.status = "partially-refunded"

    collected = _collected(payment) > 0 or invoice.status == "paid"
    if invoice.amount_refunded <= 0:
        invoice.payment_status = "paid" if collected else (payment.status if payment else invoice.payment_status)
    elif invoice.amount_refunded >= invoice.grand_total:
        invoice.payment_status = "refunded"
    else:
        invoice.payment_status = "partially-refunded"

    order = db.get(Order, invoice.order_id)
    if order is None:
        return
    if invoice.payment_status == "refunded":
        order.payment_status = "refunded"
    elif order.payment_status == "refunded":
        order.payment_status = "paid"


def _complete(db: Session, refund: Refund, payment: Payment, invoice: Invoice) -> None:
    """
    Done: the money is back. Its side effects follow once — the customer told,
    the points this order earned taken back in proportion, a referral reward
    reversed when the order is refunded in full, a credit note if the store
    issues them automatically.
    """
    now = datetime.utcnow()
    refund.status = "completed"
    refund.processed_at = refund.processed_at or now
    refund.failure_reason = ""
    refund.next_check_at = None
    if refund.completed_effects:
        return
    refund.completed_effects = True

    from app.services.email.notifications import notify_refund

    notify_refund(db, refund, invoice.customer_email)

    from app.services import loyalty

    _recompute_statuses(db, invoice, payment)
    order = db.get(Order, invoice.order_id)
    if order is not None and invoice.payment_status == "refunded":
        # A referral reward this order earned doesn't stand on a refunded order.
        from app.services import referrals

        referrals.on_order_reversed(db, order, reason=f"Order {order.order_number} refunded")

    # Points the order earned go back in proportion to what has been refunded.
    if order is not None and invoice.grand_total > 0:
        loyalty.reverse_for_order(db, order, fraction=invoice.amount_refunded / invoice.grand_total,
                                  refund_id=refund.id, reason=f"Refund {refund.refund_number}")

    from app.services import refunds as refund_service

    if refund_service.settings(db)["autoCreditNote"] and refund.credit_note_id is None:
        try:
            with db.begin_nested():
                _issue_credit_note(db, invoice, refund.amount, f"Refund {refund.refund_number}", refund=refund)
        except (ValidationError, ConflictError) as error:
            logger.warning("Refund %s: no automatic credit note: %s", refund.refund_number, error)


def _fail(db: Session, refund: Refund, reason: str) -> None:
    """
    The gateway did not send the money back. What that undoes, and what not:

    - **The payment's share is handed back** to the payment and the invoice
      (it was counted when the gateway accepted the refund), so the room to
      refund comes back and a retry can send it.
    - **The invoice's and the order's payment status are recomputed** from
      the amounts — an order is no longer shown refunded when it isn't.
    - **Reward points**: taken back only when a refund completes, so a failed
      one has taken nothing. A refund that completed and is then reported
      failed has its clawback given back.
    - **The tenders' share stands.** It went back to gift cards, store credit
      and points inside this system and did not fail; taking it back again
      would punish the customer for the gateway's failure. A retry sends only
      the payment's share (each tender reversal is keyed to the refund, so it
      never happens twice).
    """
    if refund.status in FINAL_REFUND_STATUSES and refund.status != "completed":
        return
    payment = db.get(Payment, refund.payment_id)
    invoice = db.get(Invoice, refund.invoice_id)
    share = payment_share(refund)
    now = datetime.utcnow()

    refund.status = "failed"
    refund.failure_reason = (reason or "The refund failed.")[:255]
    refund.next_check_at = None

    if refund.gateway_settled and share > 0 and refund.method == "original":
        if payment is not None:
            payment.refunded_amount = max(0, payment.refunded_amount - share)
        if invoice is not None:
            invoice.amount_refunded = max(0, invoice.amount_refunded - share)
        refund.gateway_settled = False

    if payment is not None:
        _gateway_event(payment, "refund-failed",
                       f"Refund {refund.refund_number} failed at the gateway; the amount is still held.")

    if refund.completed_effects:
        _undo_clawback(db, refund)
        refund.completed_effects = False

    if invoice is not None:
        _recompute_statuses(db, invoice, payment)

    from app.services import inbox

    inbox.staff(db, "refund", f"Refund {refund.refund_number} failed",
                f"{refund.order_number}: {refund.failure_reason}", f"/admin/billing/refunds?status=failed",
                permission="refunds")
    from app.services import audit

    audit.record(db, "refund.failed", resource_type="refund", resource_id=refund.id,
                 summary=f"Refund {refund.refund_number} failed", details={"reason": refund.failure_reason},
                 system=True)
    logger.warning("Refund %s failed: %s (at %s)", refund.refund_number, refund.failure_reason, now)


def _undo_clawback(db: Session, refund: Refund) -> None:
    from app.models import LoyaltyTransaction
    from app.services import loyalty

    taken = db.execute(select(LoyaltyTransaction).where(
        LoyaltyTransaction.idempotency_key == f"reverse:{refund.order_id}:{refund.id}")).scalar_one_or_none()
    if taken is not None and taken.points < 0:
        loyalty.grant(db, refund.customer_id, -taken.points, kind="restored",
                      reason=f"Refund {refund.refund_number} failed, so its points are given back",
                      key=f"refund-failed:{refund.id}")


def apply_refund_outcome(db: Session, gateway_reference: str, outcome: str, *,
                         entity: Optional[dict] = None) -> Optional[Refund]:
    """
    The gateway has finished with a refund. Record how it ended.

    `processed` completes it — and books it first, when the webhook beat us
    to recording that the gateway accepted it. `failed` fails it (see `_fail`
    for what that undoes). Idempotent — Razorpay delivers webhooks more than
    once — so a refund already in its final state is left alone.

    Matched on the gateway's refund id; failing that, on the refund number
    and id we sent in `notes` (or as the receipt). A refund webhook for one
    of *our* payments that matches nothing raises `RefundNotRecordedYet`, so
    it is delivered again rather than ignored for ever.
    """
    refund = None
    if gateway_reference:
        refund = db.execute(
            select(Refund).where(Refund.gateway_reference == gateway_reference).with_for_update()
        ).scalar_one_or_none()

    entity = entity or {}
    if refund is None and entity:
        notes = entity.get("notes") if isinstance(entity.get("notes"), dict) else {}
        number = notes.get("refundNumber") or entity.get("receipt")
        refund_id = notes.get("refundId")
        if refund_id:
            refund = db.execute(select(Refund).where(Refund.id == str(refund_id)).with_for_update()
                                ).scalar_one_or_none()
        if refund is None and number:
            refund = db.execute(select(Refund).where(Refund.refund_number == str(number)).with_for_update()
                                ).scalar_one_or_none()
        payment_ref = entity.get("payment_id")
        if refund is not None and payment_ref:
            owner = db.get(Payment, refund.payment_id)
            if owner is None or owner.transaction_id != payment_ref:
                refund = None  # notes that don't belong to this payment are not trusted
        if refund is None and payment_ref:
            ours = db.execute(select(Payment).where(Payment.transaction_id == payment_ref)).scalar_one_or_none()
            if ours is not None:
                waiting = list(db.execute(select(Refund).where(
                    Refund.payment_id == ours.id, Refund.status == "processing",
                    Refund.gateway_reference.is_(None)).with_for_update()).scalars())
                same = [r for r in waiting if entity.get("amount") in (None, payment_share(r))]
                if len(same) == 1:
                    refund = same[0]
                else:
                    raise RefundNotRecordedYet(
                        f"Refund {gateway_reference} for payment {payment_ref} isn't recorded here yet.")
        if refund is not None and gateway_reference and not refund.gateway_reference:
            refund.gateway_reference = gateway_reference

    if refund is None:
        return None

    if refund.status in ("completed", "failed", "cancelled", "rejected"):
        return refund

    if outcome == "processed":
        payment = db.get(Payment, refund.payment_id)
        invoice = db.get(Invoice, refund.invoice_id)
        if refund.status == "requested" or payment is None or invoice is None:
            return refund
        _book_payment_share(db, refund, payment, invoice)
        _book_tenders(db, refund, invoice)
        _complete(db, refund, payment, invoice)
        _recompute_statuses(db, invoice, payment)
        return refund

    if outcome != "failed":
        return refund

    _fail(db, refund, "The payment gateway reported this refund as failed.")
    return refund


def check_refund(db: Session, refund_id: str) -> Refund:
    """
    Find out where a `processing` refund has got to — the job's pass, and the
    "check now" button. Accepted at the gateway: asks it for the refund's
    state. Never confirmed (a timeout): looks it up by its number, and only
    sends it when the gateway has no such refund.
    """
    refund = get_refund(db, refund_id, lock=True)
    if refund.status != "processing":
        return refund
    payment = db.get(Payment, refund.payment_id)
    invoice = db.get(Invoice, refund.invoice_id)
    if payment is None or invoice is None:
        return refund
    if not refund.gateway_settled:
        return dispatch_refund(db, refund.id)

    provider = get_provider()
    fetch = getattr(provider, "fetch_refund", None)
    if refund.gateway_reference and fetch is not None:
        result = fetch(payment.transaction_id, refund.gateway_reference)
        if result is not None and result.status == "completed":
            _complete(db, refund, payment, invoice)
            _recompute_statuses(db, invoice, payment)
        elif result is not None and result.status == "rejected":
            _fail(db, refund, result.failure_reason or "The payment gateway reported this refund as failed.")
        else:
            refund.next_check_at = datetime.utcnow() + timedelta(minutes=_poll_minutes(db))
    else:
        refund.next_check_at = datetime.utcnow() + timedelta(minutes=_poll_minutes(db))
    db.commit()
    db.refresh(refund)
    return refund


def set_refund_status(db: Session, refund_id: str, status: str) -> Refund:
    """
    Move a refund along by hand. Completing a requested (or failed) one sends
    it; rejecting or cancelling one leaves the money put. Processing and
    failed are the gateway's to set, never a person's.
    """
    status = normalise_refund_status(status)
    refund = get_refund(db, refund_id, lock=True)

    if refund.status == "completed":
        raise ConflictError("This refund is already complete.", error_code="REFUND_COMPLETE")

    # A refund the gateway is already working on must not be sent again.
    # Completing it here would call the gateway a second time and return the
    # money twice; its outcome arrives by webhook (or the refunds job) instead.
    if refund.status == "processing":
        raise ConflictError(
            "This refund is already on its way; the gateway will confirm it.",
            error_code="REFUND_IN_PROGRESS",
        )

    if refund.status in ("cancelled", "rejected"):
        raise ConflictError(f"This refund was {refund.status}; raise a new one instead.",
                            error_code="INVALID_TRANSITION")

    if status == "completed":
        payment = db.get(Payment, refund.payment_id)
        invoice = db.get(Invoice, refund.invoice_id)

        if payment is None or invoice is None:
            raise ConflictError("The invoice or payment for this refund is missing.",
                                error_code="REFUND_ORPHANED")

        rooms = refund_rooms(db, invoice, payment, exclude_id=refund.id)
        if payment_share(refund) > rooms["payment"] or (
                not refund.tenders_settled and (refund.tender_amount or 0) > rooms["tenders"]):
            raise ConflictError("That is more than is left to refund on this payment.",
                                error_code="REFUND_EXCEEDS_PAYMENT")

        refund.status = "processing"
        refund.failure_reason = ""
        db.commit()
        return dispatch_refund(db, refund.id)

    if status in ("rejected", "cancelled"):
        refund.status = status
        refund.processed_at = datetime.utcnow()
        refund.next_check_at = None
        db.commit()
        db.refresh(refund)
        return refund

    raise ConflictError(f"A {refund.status} refund can't be moved to {status} by hand.",
                        error_code="INVALID_TRANSITION")


# ------------------------------------------------------------ credit notes


def list_credit_notes(db: Session, *, order_id: Optional[str] = None, q: Optional[str] = None) -> List[CreditNote]:
    """
    Every credit note, or one order's. `q` is an ID, matched exactly: the
    credit note's own, its invoice's or its order's (docs/id-lookup.md).
    """
    statement = select(CreditNote).order_by(CreditNote.issued_at.desc())
    if order_id:
        statement = statement.where(CreditNote.order_id == order_id)
    by_id = any_id_condition(
        q,
        ("credit_note", None, None),
        ("invoice", CreditNote.invoice_id, Invoice.id),
        ("order", CreditNote.order_id, Order.id),
    )
    if by_id is not None:
        statement = statement.where(by_id)
    return list(db.execute(statement).scalars().all())


def _split_tax(total_tax: int, mode: str) -> dict:
    if mode == "inter-state":
        return {"cgst": 0, "sgst": 0, "igst": total_tax}
    if mode == "intra-state":
        from decimal import ROUND_HALF_UP, Decimal

        cgst = int((Decimal(total_tax) / 2).to_integral_value(rounding=ROUND_HALF_UP))
        return {"cgst": cgst, "sgst": total_tax - cgst, "igst": 0}
    return {"cgst": 0, "sgst": 0, "igst": 0}


def credit_note_tax(invoice: Invoice, total: int, refund: Optional[Refund] = None) -> dict:
    """
    The tax inside a credit of `total`, **at the rates the invoice charged**.

    A refund raised through the calculation already carries each line's tax
    (CGST/SGST/IGST as invoiced); those are used as they are. Anything else —
    an amount-only credit, a goodwill adjustment — is shared across the
    invoice's lines (and its untaxed delivery fee) in proportion to what each
    was invoiced at, by largest remainder, and each share's tax is backed out
    at that line's own rate. Never at the store's default rate: an order of a
    5% kurta and an 18% pair of earbuds has two rates, and its credit note must
    too.
    """
    mode = invoice.tax_mode or "none"
    out = {"taxableAmount": 0, "cgst": 0, "sgst": 0, "igst": 0, "totalTax": 0, "mode": mode}
    remaining = total
    if refund is not None and refund.items and total == refund.amount and any(i.order_item_id for i in refund.items):
        for item in refund.items:
            out["cgst"] += item.cgst or 0
            out["sgst"] += item.sgst or 0
            out["igst"] += item.igst or 0
            out["totalTax"] += item.tax or 0
            remaining -= item.amount
        remaining -= refund.shipping_amount or 0
        remaining = max(0, remaining)

    if remaining > 0:
        lines = list(invoice.items)
        weights = [max(0, int(line.line_total)) for line in lines] + [max(0, int(invoice.shipping or 0))]
        parts = billing.allocate(remaining, weights) if sum(weights) > 0 else [0] * len(weights)
        for line, part in zip(lines, parts):
            if part <= 0 or not line.tax:
                continue
            _, tax = billing.tax_included_in(part, float(line.tax_rate_percent or 0))
            if line.igst and not line.cgst:
                split = {"cgst": 0, "sgst": 0, "igst": tax}
            elif line.cgst or line.sgst:
                split = _split_tax(tax, "intra-state")
            else:
                split = _split_tax(tax, mode)
            for key in ("cgst", "sgst", "igst"):
                out[key] += split[key]
            out["totalTax"] += tax
    out["taxableAmount"] = total - out["totalTax"]
    return out


def _issue_credit_note(db: Session, invoice: Invoice, total: int, reason: str, *,
                       refund: Optional[Refund] = None, status: str = "issued") -> CreditNote:
    credited = db.execute(
        select(func.coalesce(func.sum(CreditNote.total), 0)).where(
            CreditNote.invoice_id == invoice.id, CreditNote.status != "cancelled"
        )
    ).scalar_one()
    if total > invoice.grand_total - int(credited):
        raise ValidationError("A credit note cannot exceed the invoice it offsets.",
                              error_code="CREDIT_EXCEEDS_INVOICE")

    now = datetime.utcnow()
    from app.core import numbering

    credit_note_number = numbering.next_yearly(db, numbering.CREDIT_NOTE, CreditNote.credit_note_number, now)
    tax = credit_note_tax(invoice, total, refund)

    note = CreditNote(
        id=next_id(db, CreditNote, "credit_note"),
        credit_note_number=credit_note_number,
        invoice_id=invoice.id,
        invoice_number=invoice.invoice_number,
        order_id=invoice.order_id,
        order_number=invoice.order_number,
        customer_id=invoice.customer_id,
        customer_name=invoice.customer_name,
        refund_id=refund.id if refund is not None else None,
        reason=reason.strip()[:255],
        amount=tax["taxableAmount"],
        tax=tax["totalTax"],
        total=total,
        tax_mode=tax["mode"],
        cgst=tax["cgst"],
        sgst=tax["sgst"],
        igst=tax["igst"],
        issued_at=now,
        status=status,
    )
    db.add(note)
    db.flush()
    if refund is not None:
        refund.credit_note_id = note.id
    return note


def create_credit_note(
    db: Session,
    *,
    invoice_id: str,
    total: int,
    reason: str,
    refund_id: Optional[str] = None,
    status: str = "issued",
) -> CreditNote:
    """
    Issue a credit note.

    Its tax follows the invoice lines' own rates and CGST/SGST/IGST split —
    see `credit_note_tax` — so a partial credit carries the right proportion
    and the note reconciles with the document it offsets.
    """
    invoice = get_invoice(db, invoice_id)

    if total <= 0:
        raise ValidationError("Enter an amount above zero.", error_code="INVALID_AMOUNT")
    if not reason.strip():
        raise ValidationError("Give a reason for the credit note.", error_code="REASON_REQUIRED")
    if status not in ("draft", "issued"):
        raise ValidationError("A new credit note is a draft or issued.", error_code="INVALID_STATUS")

    refund = db.get(Refund, refund_id) if refund_id else None
    if refund_id and (refund is None or refund.invoice_id != invoice.id):
        raise ValidationError("That refund isn't against this invoice.", error_code="REFUND_NOT_ON_INVOICE")

    note = _issue_credit_note(db, invoice, total, reason, refund=refund, status=status)
    db.commit()
    db.refresh(note)
    return note


def set_credit_note_status(db: Session, note_id: str, status: str) -> CreditNote:
    """
    Issue a draft, or cancel an issued note.

    Never deleted: a numbered document that vanishes leaves a hole in a
    sequence somebody will eventually have to explain.
    """
    note = db.get(CreditNote, note_id)
    if note is None:
        raise NotFoundError("No such credit note.", error_code="CREDIT_NOTE_NOT_FOUND")

    note.status = status
    db.commit()
    db.refresh(note)
    return note
