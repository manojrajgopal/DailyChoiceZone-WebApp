"""
Marking a payment paid, and everything that follows from it.

Four records move together when money arrives: the payment, the invoice, the
order's payment status, and the order's own status. Doing that in four places
is how a system comes to hold a paid invoice against an unpaid order, so it
happens here and nowhere else.

## Why this is idempotent

Two things race to settle the same payment, by design:

- the **browser**, which returns from Razorpay Checkout and calls `/verify`;
- the **webhook**, which Razorpay delivers server-to-server, retries on
  failure, and may deliver more than once for one payment.

Both are wanted. The browser path is what makes the confirmation page correct
immediately; the webhook is what makes the order correct when the shopper
closes the tab on the payment screen. Neither may double-count, so settling a
payment that is already settled is a no-op that returns the same answer.

## What is authoritative

The gateway. Every function here takes its status, amount and instrument from a
`PaymentResult` that came from Razorpay — over a verified signature, or read
straight back from the API. Nothing a client sent about money is read.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import Invoice, Order, OrderEvent, Payment, PaymentEvent
from app.services.payments import PaymentResult, get_provider

logger = logging.getLogger(__name__)

# A payment in one of these has already had its outcome recorded.
SETTLED = ("paid", "refunded", "partially-refunded")


def get_payment(db: Session, payment_id: str, *, customer_id: Optional[str] = None) -> Payment:
    """
    Fetch a payment, optionally checking it belongs to a given customer.

    A mismatch reads as "not found" rather than "forbidden", because "that
    exists but is not yours" is itself a fact worth not disclosing.
    """
    payment = db.get(Payment, payment_id)
    if payment is None or (customer_id and payment.customer_id != customer_id):
        raise NotFoundError(f"No payment '{payment_id}'.", error_code="PAYMENT_NOT_FOUND")
    return payment


def verify_and_settle(db: Session, payment: Payment, payload: dict) -> Payment:
    """
    The browser has come back from Checkout. Find out whether it is true.

    `payload` holds the three opaque references Checkout produced. The order id
    the signature is checked against comes from **our** record, not from the
    payload, so a client cannot present a real signature for a different order.
    """
    if payment.status in SETTLED:
        # Already settled — very likely by the webhook, which often wins.
        return payment

    provider = get_provider()
    reference = payment.provider_reference or payment.transaction_id

    result = provider.verify(reference, payload)

    if not result.ok:
        _apply_failed(db, payment, result)
        db.commit()
        raise ValidationError(
            result.failure_reason or "The payment could not be verified.",
            error_code="PAYMENT_UNVERIFIED",
        )

    return apply_result(db, payment, result)


def apply_result(db: Session, payment: Payment, result: PaymentResult) -> Payment:
    """
    Record a gateway outcome against a payment, and commit.

    The one door. `verify_and_settle` and the webhook both come through here,
    which is what keeps the two paths from disagreeing.
    """
    if result.status in ("paid", "authorized"):
        _apply_paid(db, payment, result)
    elif result.status == "failed":
        _apply_failed(db, payment, result)
    else:
        # Still pending. Nothing to record beyond the reference, if the gateway
        # has given us a better one than the order id we started with.
        _adopt_reference(payment, result)

    db.commit()
    db.refresh(payment)
    return payment


# --------------------------------------------------------------------- paid


def _apply_paid(db: Session, payment: Payment, result: PaymentResult) -> None:
    if payment.status in SETTLED:
        return

    # The gateway's amount must be the amount owed. A payment that verifies for
    # less is not a paid order, and one for more is a problem of its own.
    if result.amount is not None and result.amount != payment.amount:
        logger.error(
            "Payment %s: gateway reports %s but %s is owed — refusing to settle.",
            payment.id,
            result.amount,
            payment.amount,
        )
        raise ConflictError(
            "The amount paid does not match the amount owed.",
            error_code="PAYMENT_AMOUNT_MISMATCH",
        )

    now = datetime.utcnow()
    authorized_only = result.status == "authorized"

    _adopt_reference(payment, result)
    if result.instrument_hint:
        payment.instrument_hint = result.instrument_hint

    payment.status = "authorized" if authorized_only else "paid"
    payment.events.append(
        PaymentEvent(
            status="succeeded",
            note="Authorised, awaiting capture." if authorized_only else "Authorised and captured.",
            occurred_at=now,
        )
    )

    if authorized_only:
        # Money held, not taken. The order is not paid for yet.
        return

    payment.captured_at = now

    invoice = db.get(Invoice, payment.invoice_id)
    if invoice is not None:
        invoice.amount_paid = payment.amount
        invoice.payment_status = "paid"
        invoice.payment_id = payment.id
        if invoice.status != "cancelled":
            invoice.status = "paid"

    order = db.get(Order, payment.order_id)
    if order is not None:
        order.payment_status = "paid"

        # An order awaiting a prepaid gateway is not confirmed yet — see
        # `place_order`. Payment is what confirms it.
        if order.status == "pending":
            order.status = "confirmed"
            order.events.append(
                OrderEvent(
                    status="confirmed",
                    note="Payment received.",
                    actor="system",
                    occurred_at=now,
                )
            )


# ------------------------------------------------------------------- failed


def _apply_failed(db: Session, payment: Payment, result: PaymentResult) -> None:
    """
    Record a refusal without cancelling anything.

    A failed attempt is not a failed order: the shopper can try again with
    another card, and Razorpay opens a fresh payment against the same order.
    Cancelling here would take the stock back from somebody still paying.
    """
    if payment.status in SETTLED:
        return

    now = datetime.utcnow()
    payment.status = "failed"
    payment.events.append(
        PaymentEvent(
            status="failed",
            note=result.failure_reason or "Declined by the provider.",
            occurred_at=now,
        )
    )

    invoice = db.get(Invoice, payment.invoice_id)
    if invoice is not None:
        invoice.payment_status = "failed"

    order = db.get(Order, payment.order_id)
    if order is not None:
        order.payment_status = "failed"


def _adopt_reference(payment: Payment, result: PaymentResult) -> None:
    """
    Take the gateway's payment id as the transaction reference.

    Until a payment exists, `transaction_id` holds the gateway's *order* id,
    because that is all there is. Once there is a payment id it replaces it: a
    refund is issued against the payment, so that is the reference worth
    keeping. The order id stays in `provider_reference`.
    """
    if result.provider_reference and not payment.provider_reference:
        payment.provider_reference = result.provider_reference

    if result.transaction_id and result.transaction_id != payment.transaction_id:
        if not payment.provider_reference:
            payment.provider_reference = payment.transaction_id
        payment.transaction_id = result.transaction_id


# ----------------------------------------------------------------- qr codes


def open_qr(db: Session, payment: Payment) -> dict:
    """
    Mint a single-use QR code worth exactly this invoice.

    Its `notes` carry our payment id, and that is what binds an otherwise
    free-standing QR payment back to this order — see `settle_qr`.
    """
    invoice = db.get(Invoice, payment.invoice_id)
    order = db.get(Order, payment.order_id)
    if invoice is None or order is None:
        raise NotFoundError("That payment has no invoice.", error_code="INVOICE_NOT_FOUND")

    from app.services import billing as billing_service

    business = (billing_service.billing_config(db) or {}).get("business") or {}

    return get_provider().create_qr(
        amount=invoice.grand_total,
        name=business.get("storeName") or business.get("legalName") or "Payment",
        description=f"Order {order.order_number}",
        notes={"paymentId": payment.id, "orderId": order.id},
    )


def qr_poster_url(qr_id: str) -> str:
    """Where the gateway serves this code's image. See `qr_image`."""
    return get_provider().qr_poster_url(qr_id)


def settle_qr(db: Session, payment: Payment, qr_id: str) -> Payment:
    """
    Has anybody scanned it?

    Read from the gateway with the secret key, so the answer is the gateway's
    and not a claim from the page that is polling.

    Two things must hold before a scan settles this order, and they are what
    stop one QR paying for another: the payment must have **captured**, and the
    QR's notes must name *this* payment. The amount is checked by
    `_apply_paid`, as for every other rail.
    """
    if payment.status in SETTLED:
        return payment

    for entity in get_provider().qr_payments(qr_id):
        if entity.get("status") != "captured":
            continue

        notes = entity.get("notes") or {}
        if notes.get("paymentId") != payment.id:
            logger.warning(
                "QR %s produced a payment for %s, not %s — ignoring.",
                qr_id,
                notes.get("paymentId"),
                payment.id,
            )
            continue

        return apply_result(
            db,
            payment,
            PaymentResult(
                ok=True,
                transaction_id=entity.get("id", payment.transaction_id),
                status="paid",
                instrument_hint=_hint(entity),
                amount=entity.get("amount"),
            ),
        )

    return payment


def abandon_qr(qr_id: str) -> None:
    """Close a code nobody used, so it cannot be scanned later."""
    provider = get_provider()
    closer = getattr(provider, "close_qr", None)
    if closer:
        closer(qr_id)


# ------------------------------------------------------------------ webhook


def settle_from_webhook(db: Session, event: str, entity: dict) -> Optional[Payment]:
    """
    Apply a verified webhook delivery.

    The signature is checked by the route before this is called; by here the
    delivery is known to be Razorpay's. Returns the payment it touched, or
    `None` when the delivery is about something this system does not track —
    which is not an error, and must still be answered with a 200 or Razorpay
    will retry it forever.
    """
    # A QR payment has no gateway order, so its link back to us is the note
    # we minted the code with.
    noted = (entity.get("notes") or {}).get("paymentId")
    payment = db.get(Payment, noted) if noted else None

    if payment is None:
        reference = entity.get("order_id") or entity.get("id")
        if not reference:
            return None
        payment = _find_by_reference(db, reference)
    if payment is None:
        logger.info("Razorpay webhook %s: no payment for reference %s", event, reference)
        return None

    if event == "payment.captured":
        result = PaymentResult(
            ok=True,
            transaction_id=entity.get("id", payment.transaction_id),
            status="paid",
            instrument_hint=_hint(entity),
            provider_reference=entity.get("order_id"),
            amount=entity.get("amount"),
        )
    elif event == "payment.authorized":
        result = PaymentResult(
            ok=True,
            transaction_id=entity.get("id", payment.transaction_id),
            status="authorized",
            instrument_hint=_hint(entity),
            provider_reference=entity.get("order_id"),
            amount=entity.get("amount"),
        )
    elif event == "qr_code.credited":
        # A scan. The entity here is the payment the QR produced; the notes
        # are what tie it back to this order, exactly as in `settle_qr`.
        if (entity.get("notes") or {}).get("paymentId") not in (None, payment.id):
            logger.warning("QR webhook names a different payment — ignoring.")
            return None

        result = PaymentResult(
            ok=True,
            transaction_id=entity.get("id", payment.transaction_id),
            status="paid",
            instrument_hint=_hint(entity),
            amount=entity.get("amount"),
        )
    elif event == "payment.failed":
        result = PaymentResult(
            ok=False,
            transaction_id=entity.get("id", payment.transaction_id),
            status="failed",
            provider_reference=entity.get("order_id"),
            failure_reason=entity.get("error_description") or "Declined by the provider.",
        )
    else:
        return None

    return apply_result(db, payment, result)


def _find_by_reference(db: Session, reference: str) -> Optional[Payment]:
    """
    Locate a payment by any gateway reference it might be known by.

    Before settlement `transaction_id` is the gateway order id; after, it is
    the payment id and the order id has moved to `provider_reference`. A
    webhook may arrive either side of that, so both columns are searched.
    """
    return db.execute(
        select(Payment).where(
            (Payment.transaction_id == reference) | (Payment.provider_reference == reference)
        )
    ).scalars().first()


def _hint(entity: dict) -> str:
    """Delegate to the provider's own mapping, so there is one of them."""
    from app.services.payments.razorpay import instrument_hint

    return instrument_hint(entity)


def gateway_handoff(
    db: Session, order: Order, invoice: Invoice, payment: Payment
) -> Optional[dict]:
    """
    What the browser needs to open the gateway, or `None` if it does not.

    `None` means the payment is already settled — cash on delivery, or a
    provider that takes the money synchronously — and the shopper goes straight
    to the confirmation page.

    Everything here is either public or already the shopper's own: the
    publishable key id, the gateway's order reference, the amount they are
    about to be asked for, and their own name and email to prefill the form.
    **No secret, and no signature.** A signature produced here would be a
    signature the browser could replay; the only signature in this flow is the
    one Razorpay generates and this server checks.

    The amount is sent because Checkout displays it, not because it decides it.
    Razorpay charges what the gateway order says, which was set from the
    invoice — so a tampered figure here changes the label on the payment sheet
    and nothing else, and `settlement` refuses a payment whose amount does not
    match the invoice anyway.
    """
    if payment.status in ("paid", "authorized") or payment.method == "cod":
        return None

    if settings.PAYMENT_PROVIDER != "razorpay":
        return None

    # The name on the payment sheet. Taken from the billing document, so it
    # reads as the store the shopper is buying from rather than as whatever the
    # gateway account happens to be called.
    from app.services import billing as billing_service

    business = (billing_service.billing_config(db) or {}).get("business") or {}

    return {
        "provider": "razorpay",
        "keyId": settings.RAZOR_KEY_ID,
        "merchantName": business.get("storeName") or business.get("legalName") or "",
        "orderReference": payment.provider_reference or payment.transaction_id,
        "paymentId": payment.id,
        "amount": invoice.grand_total,
        "currency": invoice.currency,
        "name": order.customer_name,
        "email": order.customer_email,
        "phone": order.shipping_phone,
        "description": f"Order {order.order_number}",
    }


