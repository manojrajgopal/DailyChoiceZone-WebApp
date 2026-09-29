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
from datetime import datetime, timedelta
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


# ---------------------------------------------------------------- locking
#
# Three things can try to settle one payment at the same moment: the browser's
# verify call, the gateway's webhook, and the expiry sweeper. Without a lock two
# of them can read "pending" together and both act — confirm an order the
# sweeper is cancelling, or record the same payment twice.
#
# So every writer re-reads the payment **under a row lock** before deciding
# anything, and the second one waits for the first to commit and then sees what
# it did. `populate_existing` matters: without it SQLAlchemy would hand back the
# copy already in the session, stale, rather than the row just locked.


def _lock_payment(db: Session, payment_id: str) -> Payment:
    return db.execute(
        select(Payment)
        .where(Payment.id == payment_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one()


def _lock_order(db: Session, order_id: str) -> Optional[Order]:
    return db.execute(
        select(Order)
        .where(Order.id == order_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()


# ----------------------------------------------------------------- window


def window_closed(order: Optional[Order], now: Optional[datetime] = None) -> bool:
    """
    Past the point a new payment may be *started* for this order.

    Only orders holding stock have a window. An order placed before windows
    existed, a cash-on-delivery order, and a paid one all return False.
    """
    if order is None or order.stock_state != "reserved" or order.payment_expires_at is None:
        return False
    return (now or datetime.utcnow()) >= order.payment_expires_at


def hold_lapsed(order: Optional[Order], now: Optional[datetime] = None) -> bool:
    """
    Past the window *and* the grace after it: the hold is released.

    A payment completing after this is refunded, not accepted. See
    `PAYMENT_GRACE_SECONDS` for why the two moments differ.
    """
    if order is None or order.stock_state != "reserved" or order.payment_expires_at is None:
        return False
    deadline = order.payment_expires_at + timedelta(seconds=settings.PAYMENT_GRACE_SECONDS)
    return (now or datetime.utcnow()) >= deadline


def require_open_window(order: Optional[Order]) -> None:
    """Refuse to start a new payment on an order whose window has closed."""
    if window_closed(order):
        raise ConflictError(
            "The time to pay for this order has run out, and the items have been "
            "released. Please place the order again.",
            error_code="PAYMENT_WINDOW_CLOSED",
        )


# ----------------------------------------------------------------- verify


def verify_and_settle(db: Session, payment: Payment, payload: dict) -> Payment:
    """
    The browser has come back from Checkout. Find out whether it is true.

    `payload` holds the three opaque references Checkout produced. The order id
    the signature is checked against comes from **our** record, not from the
    payload, so a client cannot present a real signature for a different order.

    ## Why an expired window does not stop verification

    It would be simpler to refuse outright once the window has closed — and
    wrong. Refusing to *look* does not undo a payment that happened; it only
    means nobody notices it. So the gateway is always asked, and what it says
    decides: a real payment arriving too late is refunded by `_apply_paid`,
    rather than kept with the order cancelled.
    """
    if payment.status in SETTLED:
        # Already settled — very likely by the webhook, which often wins.
        return payment

    provider = get_provider()
    reference = payment.provider_reference or payment.transaction_id

    result = provider.verify(reference, payload)

    if not result.ok:
        payment = _lock_payment(db, payment.id)
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

    The one door. The browser's verify call, the webhook, and the QR poll all
    come through here, under the same lock, which is what keeps them from
    disagreeing or acting twice.
    """
    payment = _lock_payment(db, payment.id)

    if result.status in ("paid", "authorized"):
        _apply_paid(db, payment, result)
    elif result.status == "failed":
        _apply_failed(db, payment, result)
    else:
        # Still pending. Nothing to record beyond the reference, if the gateway
        # has given us a better one than the order id we started with.
        if payment.status not in SETTLED and payment.status != "expired":
            _adopt_reference(payment, result)

    codes = list(getattr(payment, "_qr_to_close", ()))
    db.commit()

    # Codes are closed at the gateway after commit. A network call that fails
    # must not roll back a settlement that is already correct.
    for qr_id in codes:
        abandon_qr(qr_id)

    db.refresh(payment)
    return payment


# --------------------------------------------------------------------- paid


def _apply_paid(db: Session, payment: Payment, result: PaymentResult) -> None:
    incoming = result.transaction_id or ""
    now = datetime.utcnow()

    # --- already paid ---------------------------------------------------
    #
    # The same gateway payment reported twice — the browser and the webhook,
    # or a redelivered webhook — is expected and changes nothing. A *different*
    # captured payment for an order that is already paid is not expected at
    # all: the customer has been charged twice. It is refunded, automatically.
    if payment.status in SETTLED:
        if (
            incoming.startswith("pay_")
            and incoming != payment.transaction_id
            and result.status == "paid"
        ):
            _refund_stray(db, payment, result, why="duplicate")
        return

    order = _lock_order(db, payment.order_id)

    # --- too late -------------------------------------------------------
    #
    # An order that has been cancelled, or whose hold has lapsed, is not
    # confirmed by a payment that turns up afterwards — its stock may already
    # belong to somebody else. The money is sent back instead of kept.
    if payment.status == "expired" or (order is not None and order.status == "cancelled"):
        if result.status == "paid":
            _refund_stray(db, payment, result, why="late")
        return

    if order is not None and hold_lapsed(order, now):
        expire_payment(
            db, payment, reason="Payment window closed before the payment arrived.", commit=False
        )
        if result.status == "paid":
            _refund_stray(db, payment, result, why="late")
        return

    # --- the amount and currency must be what is owed ------------------
    #
    # A signature proves the payment belongs to the order. It says nothing
    # about how much was paid, and a gateway order can be paid in part.
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

    invoice = db.get(Invoice, payment.invoice_id)
    expected_currency = (invoice.currency if invoice is not None else None) or "INR"
    if result.currency and result.currency.upper() != expected_currency.upper():
        logger.error(
            "Payment %s: paid in %s but the invoice is in %s — refusing to settle.",
            payment.id,
            result.currency,
            expected_currency,
        )
        raise ConflictError(
            "The payment was made in the wrong currency.",
            error_code="PAYMENT_CURRENCY_MISMATCH",
        )

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
        # Money held, not taken. Razorpay refunds an uncaptured authorisation
        # on its own after a while, so nothing is fulfilled on the strength of
        # one — the order waits for the capture.
        return

    payment.captured_at = now

    if invoice is not None:
        invoice.amount_paid = payment.amount
        invoice.payment_status = "paid"
        invoice.payment_id = payment.id
        if invoice.status != "cancelled":
            invoice.status = "paid"

    if order is not None:
        order.payment_status = "paid"

        # The hold becomes a sale. Until this moment nothing had left the shelf.
        if order.stock_state == "reserved":
            from app.services import products as product_service

            for item in order.items:
                product_service.commit_reservation(db, item.product_id, item.quantity, order.id)
            order.stock_state = "consumed"
            order.payment_expires_at = None

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
            from app.services import email as email_service
            from app.services.email.notifications import notify_payment

            email_service.notify_order(db, order, "confirmed")
            notify_payment(db, order, payment.amount)

    # Every code minted for this payment is now spent. Close them, so none can
    # be scanned again — see `apply_result`.
    payment._qr_to_close = _issued_qr_ids(payment)


def _refund_stray(db: Session, payment: Payment, result: PaymentResult, *, why: str) -> None:
    """
    Send back money that must not be kept: a second payment, or a late one.

    Idempotent. The gateway payment id is recorded on the payment's timeline
    when it is refunded, and a redelivered webhook that names it again is
    recognised and left alone — refunding a payment twice is not something the
    gateway will do, but it is not something to ask it to try either.
    """
    stray = result.transaction_id or ""
    if not stray.startswith("pay_"):
        return

    marker = f"[{stray}]"
    if any(marker in (event.note or "") for event in payment.events):
        return

    now = datetime.utcnow()
    label = "A second payment" if why == "duplicate" else "A payment after the window closed"
    outcome = get_provider().refund(
        stray, result.amount or payment.amount, f"Automatic refund: {why} payment"
    )

    if outcome.ok:
        note = f"{label} {marker} was refunded automatically ({outcome.reference})."
        logger.warning("Payment %s: %s", payment.id, note)
    else:
        # Recorded where somebody will see it. The money is owed; the gateway
        # would not return it on its own.
        note = f"{label} {marker} could not be refunded automatically — refund it manually."
        logger.error("Payment %s: %s (%s)", payment.id, note, outcome.failure_reason)

    payment.events.append(
        PaymentEvent(
            status="refunded" if outcome.ok else "refund-due",
            note=note,
            occurred_at=now,
        )
    )


# ----------------------------------------------------------------- expiry


def expire_payment(
    db: Session, payment: Payment, *, reason: str = "Payment window closed.", commit: bool = True
) -> bool:
    """
    Cancel an unpaid order whose window has run out, and release its hold.

    Refuses to touch anything that is paid, anything not holding stock, and
    anything no longer pending — so a payment settling at the same instant
    wins, and nothing placed before holds existed can ever be affected.
    Returns whether it cancelled.
    """
    payment = _lock_payment(db, payment.id)
    order = _lock_order(db, payment.order_id)

    if payment.status in SETTLED or payment.status == "authorized":
        return False
    if order is None or order.status != "pending" or order.stock_state != "reserved":
        return False

    from app.services.orders import return_stock

    now = datetime.utcnow()
    return_stock(db, order, note="Payment window closed")

    order.status = "cancelled"
    order.payment_status = "expired"
    order.payment_expires_at = None
    order.events.append(
        OrderEvent(status="cancelled", note=reason, actor="system", occurred_at=now)
    )

    payment.status = "expired"
    payment.events.append(PaymentEvent(status="expired", note=reason, occurred_at=now))

    invoice = db.get(Invoice, payment.invoice_id)
    if invoice is not None:
        invoice.status = "cancelled"
        invoice.payment_status = "expired"

    codes = _issued_qr_ids(payment)

    if commit:
        db.commit()
        for qr_id in codes:
            abandon_qr(qr_id)
    else:
        payment._qr_to_close = codes

    return True


def _issued_qr_ids(payment: Payment) -> list:
    """Every QR code minted for this payment, from its own timeline."""
    return [
        event.note.split(" ", 1)[0]
        for event in payment.events
        if event.status == "qr-issued" and event.note
    ]


# ------------------------------------------------------------------- failed


def _apply_failed(db: Session, payment: Payment, result: PaymentResult) -> None:
    """
    Record a refusal without cancelling anything.

    A failed attempt is not a failed order: the shopper can try again with
    another card, and Razorpay opens a fresh payment against the same order.
    Cancelling here would take the stock back from somebody still paying.

    Webhooks arrive out of order — Razorpay documents it — so a `failed` for an
    earlier attempt can land after a later attempt succeeded. A settled or
    expired payment ignores it.
    """
    if payment.status in SETTLED or payment.status == "expired":
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

    ## One live code per payment

    Every earlier code for this payment is closed at the gateway before a new
    one is minted. Without that, pressing "show my QR code" twice leaves two
    codes that can both be paid — and a shopper who scans the old one after
    paying the new one is charged twice.

    ## The code dies with the window

    `close_by` is set to the order's own deadline, so Razorpay itself stops the
    code accepting payment when the hold is due to lapse. Razorpay's minimum is
    two minutes from now; with less than that left, the deadline is honoured by
    the sweeper instead, and anything paid late is refunded.
    """
    payment = _lock_payment(db, payment.id)
    invoice = db.get(Invoice, payment.invoice_id)
    order = db.get(Order, payment.order_id)
    if invoice is None or order is None:
        raise NotFoundError("That payment has no invoice.", error_code="INVOICE_NOT_FOUND")

    if payment.status in SETTLED:
        raise ConflictError("That payment is already settled.", error_code="ALREADY_PAID")
    if payment.status == "expired":
        raise ConflictError(
            "The time to pay for this order has run out.", error_code="PAYMENT_WINDOW_CLOSED"
        )
    require_open_window(order)

    previous = _issued_qr_ids(payment)

    from app.services import billing as billing_service

    business = (billing_service.billing_config(db) or {}).get("business") or {}

    close_by = None
    if order.payment_expires_at is not None:
        # Razorpay refuses a close_by under two minutes away; a little over
        # keeps a request that takes a moment from being rejected for it.
        earliest = datetime.utcnow() + timedelta(seconds=130)
        close_by = max(order.payment_expires_at, earliest)

    code = get_provider().create_qr(
        amount=invoice.grand_total,
        name=business.get("storeName") or business.get("legalName") or "Payment",
        description=f"Order {order.order_number}",
        notes={"paymentId": payment.id, "orderId": order.id},
        close_by=close_by,
    )

    # Recorded on the payment's own timeline, which is where `_issued_qr_ids`
    # reads it back from to close every code when the payment settles or
    # expires. No separate table: the timeline is already the audit trail.
    payment.events.append(
        PaymentEvent(
            status="qr-issued",
            note=f"{code['id']} issued for scan-to-pay.",
            occurred_at=datetime.utcnow(),
        )
    )
    db.commit()

    for qr_id in previous:
        abandon_qr(qr_id)

    if order.payment_expires_at is not None:
        code["expiresAt"] = order.payment_expires_at.isoformat() + "Z"
    return code


def qr_poster_url(qr_id: str) -> str:
    """Where the gateway serves this code's image. See `qr_image`."""
    return get_provider().qr_poster_url(qr_id)


def settle_qr(db: Session, payment: Payment, qr_id: str) -> Payment:
    """
    Has anybody scanned it?

    Read from the gateway with the secret key, so the answer is the gateway's
    and not a claim from the page that is polling.

    Three things must hold before a scan settles this order, and they are what
    stop one QR paying for another: the code must be one **we issued for this
    payment**, the payment must have **captured**, and the QR's notes must name
    *this* payment. Amount, currency, lateness and duplicates are then judged by
    `apply_result`, exactly as for every other rail.

    Also where a lapsed window is noticed while somebody is watching: if the
    hold has run out and nothing was paid, the order is expired here rather
    than waiting for the sweeper.
    """
    if payment.status in SETTLED:
        return payment

    # Only codes minted for this payment. Without this, a caller could poll
    # someone else's code id against their own payment and learn about it.
    if qr_id not in _issued_qr_ids(payment):
        raise NotFoundError("No such code for this payment.", error_code="QR_NOT_FOUND")

    for entity in get_provider().qr_payments(qr_id):
        if entity.get("status") != "captured":
            continue

        notes = entity.get("notes") or {}
        if notes.get("paymentId") not in (None, payment.id):
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
                currency=entity.get("currency"),
            ),
        )

    order = db.get(Order, payment.order_id)
    if hold_lapsed(order):
        expire_payment(db, payment)
        db.refresh(payment)

    return payment


def abandon_qr(qr_id: str) -> None:
    """Close a code nobody used, so it cannot be scanned later."""
    provider = get_provider()
    closer = getattr(provider, "close_qr", None)
    if closer:
        closer(qr_id)


# ------------------------------------------------------------------ webhook


# Events this system acts on. Everything else is acknowledged and ignored —
# Razorpay retries any non-2xx for a day and then disables the webhook, so an
# event we do not model must never be answered with an error.
PAYMENT_EVENTS = {
    "payment.captured",
    "payment.authorized",
    "payment.failed",
    "order.paid",
    "qr_code.credited",
    "payment_link.paid",
}
REFUND_EVENTS = {"refund.processed", "refund.failed"}


def settle_from_webhook(db: Session, body: dict) -> str:
    """
    Apply a verified webhook delivery. Returns a short account of what it did.

    The signature has been checked and the event de-duplicated by the route
    before this runs; by here the delivery is known to be Razorpay's and new.

    Every payment event is reduced to one question — *which of our payments is
    this, and what did the gateway say about it?* — and handed to
    `apply_result`, the same door the browser's verify call goes through. So a
    webhook cannot settle a payment in a way the browser could not, and the
    amount, currency, lateness and duplicate checks apply to both.
    """
    event = body.get("event", "")
    payload = body.get("payload") or {}

    if event in REFUND_EVENTS:
        refund = (payload.get("refund") or {}).get("entity") or {}
        reference = refund.get("id")
        if not reference:
            return "ignored: refund with no id"

        from app.services import invoices as invoice_service

        outcome = "processed" if event == "refund.processed" else "failed"
        updated = invoice_service.apply_refund_outcome(db, reference, outcome)
        db.commit()
        return f"refund {updated.refund_number} {updated.status}" if updated else "ignored: unknown refund"

    if event not in PAYMENT_EVENTS:
        return "ignored"

    entity = (payload.get("payment") or {}).get("entity") or {}
    if not entity:
        return "ignored: no payment entity"

    # A membership purchase: no order or invoice behind it, just the plan.
    membership_id = (entity.get("notes") or {}).get("membershipId")
    if membership_id:
        from app.services import membership as membership_service

        return membership_service.settle_from_gateway(db, membership_id, entity)

    payment = _payment_for(db, event, entity, payload)
    if payment is None:
        logger.info("Razorpay webhook %s: no payment of ours for %s", event, entity.get("id"))
        return "ignored: not ours"

    # What the gateway said. `order.paid`, `qr_code.credited` and
    # `payment_link.paid` all carry a captured payment; the payment's own
    # status is read rather than assumed, so an event whose entity says
    # otherwise is not mistaken for money.
    gateway_status = entity.get("status", "")
    if event == "payment.failed" or gateway_status == "failed":
        status = "failed"
    elif event == "payment.authorized" or gateway_status == "authorized":
        status = "authorized"
    elif gateway_status == "captured":
        status = "paid"
    else:
        return f"ignored: payment {gateway_status or 'without a status'}"

    result = PaymentResult(
        ok=status != "failed",
        transaction_id=entity.get("id", payment.transaction_id),
        status=status,
        instrument_hint=_hint(entity),
        provider_reference=entity.get("order_id"),
        failure_reason=entity.get("error_description") or None,
        amount=entity.get("amount"),
        currency=entity.get("currency"),
    )

    settled = apply_result(db, payment, result)
    return f"{event} -> {settled.id} {settled.status}"


def _payment_for(db: Session, event: str, entity: dict, payload: dict) -> Optional[Payment]:
    """
    Which of our payments a gateway payment belongs to.

    Tried in the order that is hardest to forge:

    1. A Payment Link's `reference_id`, which we set to our own payment id.
    2. The gateway order id, for Checkout payments — ours to match because we
       created that gateway order and recorded it.
    3. The `paymentId` note, for QR payments, which have no gateway order.

    Each candidate is then checked against the others it carries: a QR payment
    whose notes name a different payment than its code was minted for is
    refused rather than credited to either.
    """
    if event == "payment_link.paid":
        link = (payload.get("payment_link") or {}).get("entity") or {}
        reference = link.get("reference_id")
        payment = db.get(Payment, reference) if reference else None
        if payment is not None and payment.payment_link_id and link.get("id") != payment.payment_link_id:
            logger.warning("Payment link %s does not match payment %s", link.get("id"), payment.id)
            return None
        return payment

    order_id = entity.get("order_id")
    if order_id:
        payment = _find_by_reference(db, order_id)
        if payment is not None:
            return payment

    noted = (entity.get("notes") or {}).get("paymentId")
    if noted:
        payment = db.get(Payment, noted)
        if payment is not None and event == "qr_code.credited":
            # Only a code we issued for this payment may pay it.
            qr = (payload.get("qr_code") or {}).get("entity") or {}
            if qr.get("id") and qr["id"] not in _issued_qr_ids(payment):
                logger.warning("QR %s was not issued for payment %s", qr.get("id"), payment.id)
                return None
        return payment

    # A payment we recorded by its gateway id already — a redelivery after
    # settlement, or a late event for a payment already known.
    return _find_by_reference(db, entity.get("id", "")) if entity.get("id") else None


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

    # A closed window hands out nothing to pay with. The order is either
    # already cancelled or about to be, and a payment started now would only be
    # refunded.
    if payment.status == "expired" or window_closed(order):
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
        # When the window closes, so the page can count down to it and tell
        # Checkout to shut at the same moment. The server remains the authority:
        # a browser timer pauses in a background tab, and this is only advice.
        "expiresAt": (order.payment_expires_at.isoformat() + "Z") if order.payment_expires_at else None,
        "secondsLeft": (
            max(0, int((order.payment_expires_at - datetime.utcnow()).total_seconds()))
            if order.payment_expires_at
            else None
        ),
    }




# ------------------------------------------------------------ payment links

# How long a payment link stays payable. Razorpay's floor is fifteen minutes and
# its ceiling six months; a day gives a customer time to act on an SMS without
# leaving a way to pay for an order long after it has shipped.
PAYMENT_LINK_HOURS = 24


def open_payment_link(db: Session, payment: Payment) -> dict:
    """
    Raise a Razorpay Payment Link for an order that is confirmed but unpaid.

    Only for orders that have already **taken** their stock — cash on
    delivery, in practice. A checkout order still holding stock has a
    five-minute window, and a link cannot live less than fifteen, so offering
    one there would guarantee late payments. Such orders are refused.

    One link per payment: an open link is returned as it is rather than
    replaced, and Razorpay enforces `reference_id` unique besides.
    """
    payment = _lock_payment(db, payment.id)
    order = db.get(Order, payment.order_id)
    invoice = db.get(Invoice, payment.invoice_id)
    if order is None or invoice is None:
        raise NotFoundError("That payment has no order.", error_code="ORDER_NOT_FOUND")

    if payment.status in SETTLED or order.payment_status == "paid":
        raise ConflictError("This order is already paid.", error_code="ALREADY_PAID")
    if order.status in ("cancelled", "returned", "delivered"):
        raise ConflictError(
            f"A {order.status} order cannot be paid by link.", error_code="ORDER_NOT_PAYABLE"
        )
    if order.stock_state != "consumed":
        raise ConflictError(
            "This order is still in checkout; it can be paid from the payment page.",
            error_code="ORDER_IN_CHECKOUT",
        )

    provider = get_provider()
    if not hasattr(provider, "create_payment_link"):
        raise ConflictError(
            "Payment links need a live payment gateway.", error_code="PROVIDER_UNSUPPORTED"
        )

    if payment.payment_link_id:
        raise ConflictError(
            "A payment link has already been sent for this order.", error_code="LINK_EXISTS"
        )

    link = provider.create_payment_link(
        amount=invoice.grand_total,
        currency=invoice.currency or "INR",
        reference_id=payment.id,
        description=f"Order {order.order_number}",
        customer={
            "name": order.customer_name,
            "email": order.customer_email,
            "contact": order.shipping_phone,
        },
        expire_by=datetime.utcnow() + timedelta(hours=PAYMENT_LINK_HOURS),
        callback_url=f"{settings.STOREFRONT_URL.rstrip('/')}/order-success?order={order.order_number}",
    )

    payment.payment_link_id = link["id"]
    payment.events.append(
        PaymentEvent(
            status="link-sent",
            note=f"Payment link {link['id']} sent to the customer.",
            occurred_at=datetime.utcnow(),
        )
    )
    db.commit()
    return link


def settle_payment_link_callback(db: Session, params: dict) -> Optional[Payment]:
    """
    The customer came back from a Payment Link. Find out whether it is true.

    The signature is checked with the API secret first; then the payment is
    read back from the gateway, because a signed callback says the link was
    paid, not how much or in what currency. `reference_id` must be one of our
    payments *and* that payment's recorded link, so a signed callback for one
    order cannot settle another.
    """
    provider = get_provider()
    if not hasattr(provider, "verify_payment_link_signature"):
        return None

    if not provider.verify_payment_link_signature(params):
        logger.warning("Payment link callback: signature rejected")
        raise ValidationError("The payment could not be verified.", error_code="PAYMENT_UNVERIFIED")

    payment = db.get(Payment, params.get("razorpay_payment_link_reference_id", ""))
    if payment is None or payment.payment_link_id != params.get("razorpay_payment_link_id"):
        raise NotFoundError("No such payment link.", error_code="LINK_NOT_FOUND")

    if params.get("razorpay_payment_link_status") != "paid":
        return payment

    fetched = provider.fetch(params.get("razorpay_payment_id", ""))
    if fetched is None:
        return payment

    return apply_result(db, payment, fetched)
