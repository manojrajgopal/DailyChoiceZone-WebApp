"""Invoices, payments, refunds and credit notes."""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import Select, and_, func, or_, select
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
from app.services.payments import get_provider
from app.utils.ids import next_id


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

    if search:
        # Every word must match something, so more words narrow rather than
        # widen — which is what a person typing two words expects.
        for word in search.split():
            pattern = f"%{word}%"
            conditions.append(
                or_(
                    Invoice.invoice_number.like(pattern),
                    Invoice.order_number.like(pattern),
                    Invoice.customer_name.like(pattern),
                    Invoice.customer_email.like(pattern),
                )
            )

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

    if search:
        for word in search.split():
            pattern = f"%{word}%"
            conditions.append(
                or_(
                    Payment.transaction_id.like(pattern),
                    Payment.order_number.like(pattern),
                    Payment.invoice_number.like(pattern),
                    Payment.customer_name.like(pattern),
                    Payment.customer_email.like(pattern),
                )
            )

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
        conditions.append(Refund.status == status)

    if search:
        for word in search.split():
            pattern = f"%{word}%"
            conditions.append(
                or_(
                    Refund.refund_number.like(pattern),
                    Refund.order_number.like(pattern),
                    Refund.invoice_number.like(pattern),
                    Refund.customer_name.like(pattern),
                    Refund.reason.like(pattern),
                )
            )

    if conditions:
        statement = statement.where(and_(*conditions))

    return list(
        db.execute(statement.order_by(Refund.requested_at.desc())).unique().scalars().all()
    )


def get_refund(db: Session, refund_id: str) -> Refund:
    refund = db.execute(
        select(Refund).options(selectinload(Refund.items)).where(Refund.id == refund_id)
    ).unique().scalar_one_or_none()

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
) -> Refund:
    """
    Raise a refund.

    **Over-refunding is refused against what the *payment* has left**, not what
    the invoice was worth: two partial refunds that each look reasonable can
    together exceed what was actually collected.

    A refund is a request first and a movement of money second, which is why
    only a `completed` one touches the payment and the invoice.
    """
    invoice = get_invoice(db, invoice_id)

    payment = db.execute(
        select(Payment).where(Payment.invoice_id == invoice.id)
    ).scalar_one_or_none()

    if payment is None:
        raise ConflictError("This invoice has no payment to refund against.",
                            error_code="NO_PAYMENT")

    if amount <= 0:
        raise ValidationError("Enter a refund amount above zero.", error_code="INVALID_AMOUNT")

    if not reason.strip():
        raise ValidationError("Give a reason for the refund.", error_code="REASON_REQUIRED")

    # What can go back: the gateway's part, plus — for an order paid partly
    # with gift cards, store credit or points — what those have left to
    # return. The refund is shared between them in the proportion they paid.
    from app.services import tenders

    tendered = tender_split and tenders.tender_total(invoice) > 0
    available = refundable_amount(payment) + (tenders.unreversed(db, invoice.order_id) if tendered else 0)
    if tendered and payment.status in ("pending", "failed") and invoice.status != "paid":
        available = 0
    if available <= 0:
        raise ConflictError(
            "Nothing has been collected on this order yet."
            if payment.status == "pending"
            else "This payment has already been refunded in full.",
            error_code="NOTHING_TO_REFUND",
        )

    if amount > available:
        raise ConflictError(
            "That is more than is left to refund on this payment.",
            error_code="REFUND_EXCEEDS_PAYMENT",
        )

    gateway_amount, tender_amount = (
        tenders.split_refund(db, invoice, payment, amount) if tendered else (amount, 0)
    )

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
        reason=reason.strip(),
        status=status,
        requested_at=now,
        processed_at=now if status == "completed" else None,
        initiated_by=initiated_by,
    )

    refund.items = [
        RefundItem(
            product_id=line["productId"],
            name=line.get("name", ""),
            quantity=line.get("quantity", 1),
            amount=line.get("amount", 0),
        )
        for line in (lines or [])
    ]

    db.add(refund)

    if status == "completed":
        _settle_refund(db, refund, payment, invoice)

    db.commit()
    db.refresh(refund)
    return refund


def _settle_refund(db: Session, refund: Refund, payment: Payment, invoice: Invoice) -> None:
    """
    Send the money back through the provider and adjust both records.

    ## What the refund's status means afterwards

    A real gateway refunds **asynchronously**. Razorpay answers `pending` at
    once and reports `processed` or `failed` later, by webhook — and a failure
    can come days afterwards. So the refund is left `processing`, not
    `completed`, until the gateway says so; only a gateway that confirms on the
    spot produces `completed` here.

    The amount is counted against the payment **now**, while it is still
    processing. That is what stops a second refund being raised against money
    already on its way back: `refundable_amount` sees it. If the gateway later
    fails it, `apply_refund_outcome` hands the amount back.

    The gateway's own refund id is kept, because that id is the only thing its
    webhook can be matched on.
    """
    # Cash collected on delivery never passed through the gateway, so there is
    # no transaction to reverse: the store pays it back directly (bank
    # transfer or UPI) and this records that it has.
    # Only the gateway's part goes back through it; the rest goes back to gift
    # cards, store credit and points below. Refunds raised before tenders
    # existed went wholly through the gateway.
    gateway_part = refund.amount if refund.gateway_amount is None else refund.gateway_amount

    direct = not payment.transaction_id or payment.provider == "internal"
    if gateway_part <= 0 or direct:
        reference, outcome = None, "completed"
    else:
        result = get_provider().refund(payment.transaction_id, gateway_part, refund.reason)
        if not result.ok:
            raise ConflictError(
                "The payment provider declined this refund. Please try again or contact support.",
                error_code="PROVIDER_REFUSED",
            )
        reference, outcome = result.reference, result.status

    now = datetime.utcnow()
    refund.gateway_reference = reference or None

    if outcome == "completed":
        refund.status = "completed"
        refund.processed_at = now
    else:
        refund.status = "processing"
        refund.processed_at = None

    if gateway_part > 0:
        payment.refunded_amount = min(payment.amount, payment.refunded_amount + gateway_part)
        payment.status = (
            "refunded" if payment.refunded_amount >= payment.amount else "partially-refunded"
        )
        payment.events.append(
            PaymentEvent(
                status="refunded",
                note=(
                    f"{'Full' if payment.status == 'refunded' else 'Partial'} refund "
                    f"{'paid back directly' if direct else 'sent' if refund.status == 'completed' else 'initiated'}"
                    f" — {refund.reason}."
                ),
                occurred_at=now,
            )
        )

    # The tenders' share: back to the gift cards, store credit and points.
    from app.services import loyalty, tenders

    tenders.reverse_for_refund(db, refund)

    invoice.amount_refunded += refund.amount
    tendered = tenders.tender_total(invoice) > 0
    if tendered:
        invoice.payment_status = "refunded" if invoice.amount_refunded >= invoice.grand_total else "partially-refunded"
    else:
        invoice.payment_status = payment.status

    from app.services.email.notifications import notify_refund

    notify_refund(db, refund, invoice.customer_email)

    order = db.get(Order, invoice.order_id)
    fully = invoice.amount_refunded >= invoice.grand_total if tendered else payment.status == "refunded"
    if order and fully:
        order.payment_status = "refunded"
        # A referral reward this order earned doesn't stand on a refunded order.
        from app.services import referrals

        referrals.on_order_reversed(db, order, reason=f"Order {order.order_number} refunded")

    # Points the order earned go back in proportion to what has been refunded.
    if order is not None and invoice.grand_total > 0:
        loyalty.reverse_for_order(db, order, fraction=invoice.amount_refunded / invoice.grand_total,
                                  refund_id=refund.id, reason=f"Refund {refund.refund_number}")


def apply_refund_outcome(db: Session, gateway_reference: str, outcome: str) -> Optional[Refund]:
    """
    The gateway has finished with a refund. Record how it ended.

    `processed` completes it. `failed` is the one that matters: the money did
    not go back, so the amount counted against the payment when the refund
    was initiated is returned to it, the payment's status is recomputed, and
    the order is no longer shown as refunded. Idempotent — Razorpay delivers
    webhooks more than once — so a refund already in its final state is left
    alone.
    """
    refund = db.execute(
        select(Refund).where(Refund.gateway_reference == gateway_reference).with_for_update()
    ).scalar_one_or_none()
    if refund is None:
        return None

    if refund.status in ("completed", "failed"):
        return refund

    now = datetime.utcnow()

    if outcome == "processed":
        refund.status = "completed"
        refund.processed_at = now
        return refund

    if outcome != "failed":
        return refund

    refund.status = "failed"
    payment = db.get(Payment, refund.payment_id)
    invoice = db.get(Invoice, refund.invoice_id)

    # Only the gateway's part failed; a share already returned to gift cards,
    # store credit or points stands.
    gateway_part = refund.amount if refund.gateway_amount is None else refund.gateway_amount

    if payment is not None:
        payment.refunded_amount = max(0, payment.refunded_amount - gateway_part)
        payment.status = (
            "paid"
            if payment.refunded_amount == 0
            else "refunded"
            if payment.refunded_amount >= payment.amount
            else "partially-refunded"
        )
        payment.events.append(
            PaymentEvent(
                status="refund-failed",
                note=f"Refund {refund.refund_number} failed at the gateway; the amount is still held.",
                occurred_at=now,
            )
        )

    if invoice is not None:
        invoice.amount_refunded = max(0, invoice.amount_refunded - gateway_part)
        if payment is not None:
            invoice.payment_status = payment.status

    order = db.get(Order, refund.order_id)
    if order is not None and payment is not None and order.payment_status == "refunded":
        order.payment_status = payment.status

    return refund


def set_refund_status(db: Session, refund_id: str, status: str) -> Refund:
    """Move a refund along. Completing one settles it; rejecting leaves the money put."""
    refund = get_refund(db, refund_id)

    if refund.status == "completed":
        raise ConflictError("This refund is already complete.", error_code="REFUND_COMPLETE")

    # A refund the gateway is already working on must not be sent again.
    # Completing it here would call the gateway a second time and return the
    # money twice; its outcome arrives by webhook instead.
    if refund.status == "processing":
        raise ConflictError(
            "This refund is already on its way; the gateway will confirm it.",
            error_code="REFUND_IN_PROGRESS",
        )

    if status == "completed":
        payment = db.get(Payment, refund.payment_id)
        invoice = db.get(Invoice, refund.invoice_id)

        if payment is None or invoice is None:
            raise ConflictError("The invoice or payment for this refund is missing.",
                                error_code="REFUND_ORPHANED")

        gateway_part = refund.amount if refund.gateway_amount is None else refund.gateway_amount
        if gateway_part > refundable_amount(payment):
            raise ConflictError("That is more than is left to refund on this payment.",
                                error_code="REFUND_EXCEEDS_PAYMENT")

        _settle_refund(db, refund, payment, invoice)
    else:
        refund.status = status

    db.commit()
    db.refresh(refund)
    return refund


# ------------------------------------------------------------ credit notes


def list_credit_notes(db: Session, *, order_id: Optional[str] = None) -> List[CreditNote]:
    statement = select(CreditNote).order_by(CreditNote.issued_at.desc())
    if order_id:
        statement = statement.where(CreditNote.order_id == order_id)
    return list(db.execute(statement).scalars().all())


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

    Its tax is **recomputed from the credited amount**, not copied off the
    invoice, so a partial credit carries the right proportion and the note
    reconciles with the document it offsets.
    """
    invoice = get_invoice(db, invoice_id)

    if total <= 0:
        raise ValidationError("Enter an amount above zero.", error_code="INVALID_AMOUNT")
    if total > invoice.grand_total:
        raise ValidationError("A credit note cannot exceed the invoice it offsets.",
                              error_code="CREDIT_EXCEEDS_INVOICE")
    if not reason.strip():
        raise ValidationError("Give a reason for the credit note.", error_code="REASON_REQUIRED")

    now = datetime.utcnow()
    from app.core import numbering

    credit_note_number = numbering.next_yearly(db, numbering.CREDIT_NOTE, CreditNote.credit_note_number, now)

    tax = billing.calculate_tax(total, invoice.place_of_supply, None, billing.tax_config(db))

    note = CreditNote(
        id=next_id(db, CreditNote, "credit_note"),
        credit_note_number=credit_note_number,
        invoice_id=invoice.id,
        invoice_number=invoice.invoice_number,
        order_id=invoice.order_id,
        order_number=invoice.order_number,
        customer_id=invoice.customer_id,
        customer_name=invoice.customer_name,
        refund_id=refund_id,
        reason=reason.strip(),
        amount=tax["taxableAmount"],
        tax=tax["totalTax"],
        total=total,
        issued_at=now,
        status=status,
    )

    db.add(note)

    if refund_id:
        refund = db.get(Refund, refund_id)
        if refund:
            refund.credit_note_id = note.id

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
