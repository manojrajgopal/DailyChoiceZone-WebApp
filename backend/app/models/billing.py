"""Billing: invoices, payments, refunds and credit notes.

**Every amount in this module is an integer in the currency's minor unit** —
paise for INR. Not rupees, and never a float. `0.1 + 0.2` is not `0.3` in
binary floating point, and a hundredth of a rupee lost per line becomes an
invoice that does not add up. `BigInteger` because 2^31 paise is only about
₹21 crore, which a busy year would pass.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Boolean,
    Index,
    Integer,
    JSON,
    Numeric,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import BusinessId, TimestampMixin

Money = BigInteger


class Invoice(Base, TimestampMixin):
    """The demand for payment against an order."""

    __tablename__ = "invoices"
    __table_args__ = (
        Index("ix_invoices_customer_issued", "customer_id", "issued_at"),
        Index("ix_invoices_status", "status", "payment_status"),
    )

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    # Sequential and human-facing, e.g. "DCZ-INV-2026-000001". The uniqueness
    # constraint is the point: a duplicate invoice number is a bookkeeping
    # problem that outlives the session that caused it.
    invoice_number: Mapped[str] = mapped_column(
        String(40), nullable=False, unique=True, index=True
    )

    order_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("orders.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    order_number: Mapped[str] = mapped_column(String(30), nullable=False)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    customer_name: Mapped[str] = mapped_column(String(160), nullable=False)
    customer_email: Mapped[str] = mapped_column(String(255), nullable=False)

    # draft | issued | paid | overdue | cancelled
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="issued")
    issued_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    due_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    # --- the parties, as they stood when it was issued --------------------
    # Copied onto the invoice, not referenced: a document of record must keep
    # the addresses it was issued against, whatever the customer edits later.
    billing_address: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    shipping_address: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    # The state tax was charged against. Stored, not re-derived: a sale is
    # taxed by where it went at the time, and an address edited later must not
    # silently restate it.
    place_of_supply: Mapped[str] = mapped_column(String(120), nullable=False, default="")

    # --- the money, component by component --------------------------------
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="INR")
    item_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    subtotal: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    product_discount: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    coupon_code: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    coupon_discount: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    member_discount: Mapped[int] = mapped_column(Money, nullable=False, default=0, server_default="0")
    shipping: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    other_charges: Mapped[int] = mapped_column(Money, nullable=False, default=0)

    taxable_amount: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    # intra-state | inter-state | none
    tax_mode: Mapped[str] = mapped_column(String(20), nullable=False, default="none")
    tax_rate_percent: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False, default=0)
    cgst: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    sgst: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    igst: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    total_tax: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    prices_include_tax: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    grand_total: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    # Paid towards `grand_total` by gift cards, store credit and reward points.
    # They don't change what was sold or its tax — only what the gateway
    # collects: `payment.amount = grand_total - tenders`.
    gift_card_amount: Mapped[int] = mapped_column(Money, nullable=False, default=0, server_default="0")
    store_credit_amount: Mapped[int] = mapped_column(Money, nullable=False, default=0, server_default="0")
    points_amount: Mapped[int] = mapped_column(Money, nullable=False, default=0, server_default="0")
    points_redeemed: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    amount_paid: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    amount_refunded: Mapped[int] = mapped_column(Money, nullable=False, default=0)

    payment_id: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True, index=True)
    payment_method: Mapped[str] = mapped_column(String(30), nullable=False, default="card")
    payment_status: Mapped[str] = mapped_column(String(30), nullable=False, default="pending")

    notes: Mapped[str] = mapped_column(Text, nullable=False, default="")
    terms: Mapped[str] = mapped_column(Text, nullable=False, default="")

    items: Mapped[List["InvoiceItem"]] = relationship(
        back_populates="invoice", cascade="all, delete-orphan", lazy="selectin"
    )


class InvoiceItem(Base):
    """
    A line on an invoice, with its own tax.

    Tax is computed per line rather than once on the total, because rates vary
    by category and an invoice has to show the tax against each item. The line
    taxes sum exactly to the invoice's — the order-level coupon is apportioned
    across lines by largest remainder so nothing is lost to rounding.
    """

    __tablename__ = "invoice_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    invoice_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("invoices.id", ondelete="CASCADE"), nullable=False, index=True
    )
    product_id: Mapped[str] = mapped_column(BusinessId, nullable=False, index=True)

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    sku: Mapped[str] = mapped_column(String(60), nullable=False, default="")
    hsn: Mapped[str] = mapped_column(String(12), nullable=False, default="")
    size: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)
    color: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)

    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    unit_price: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    line_subtotal: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    discount: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    taxable_amount: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    tax_rate_percent: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False, default=0)
    cgst: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    sgst: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    igst: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    tax: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    line_total: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    # Set when the line is a component of a bundle: see `OrderItem`.
    bundle_name: Mapped[str] = mapped_column(String(200), nullable=False, default="", server_default="")
    bundle_group: Mapped[str] = mapped_column(String(40), nullable=False, default="", server_default="")
    bundle_quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")

    invoice: Mapped["Invoice"] = relationship(back_populates="items")


class Payment(Base, TimestampMixin):
    """
    Money taken against an invoice.

    **No instrument is stored.** `instrument_hint` is a masked remnant of the
    kind a gateway returns *after* processing — "•••• 4242". No card number,
    expiry, CVV, UPI PIN, bank credential or gateway secret is ever written
    here, and none may be added.
    """

    __tablename__ = "payments"
    __table_args__ = (Index("ix_payments_status_created", "status", "created_at"),)

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    transaction_id: Mapped[str] = mapped_column(
        String(60), nullable=False, unique=True, index=True
    )

    order_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("orders.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    order_number: Mapped[str] = mapped_column(String(30), nullable=False, default="")
    invoice_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("invoices.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    invoice_number: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    customer_name: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    customer_email: Mapped[str] = mapped_column(String(255), nullable=False, default="")

    amount: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    refunded_amount: Mapped[int] = mapped_column(Money, nullable=False, default=0)

    # upi | card | debit-card | netbanking | cod | wallet
    method: Mapped[str] = mapped_column(String(30), nullable=False, default="card")
    # pending | authorized | paid | failed | refunded | partially-refunded
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="pending", index=True)
    # Which integration handled it: "mock" until a real one is wired in.
    provider: Mapped[str] = mapped_column(String(40), nullable=False, default="mock")
    # The provider's own reference for the order/intent, for reconciliation.
    provider_reference: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)

    instrument_hint: Mapped[str] = mapped_column(String(60), nullable=False, default="")

    # A Razorpay Payment Link raised for this payment, if one was. Its webhook
    # names the link, and this is how that finds its way back here.
    payment_link_id: Mapped[Optional[str]] = mapped_column(String(60), nullable=True, index=True)

    created_at_utc: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    captured_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    events: Mapped[List["PaymentEvent"]] = relationship(
        back_populates="payment",
        cascade="all, delete-orphan",
        order_by="PaymentEvent.occurred_at",
        lazy="selectin",
    )


class PaymentEvent(Base):
    """One step in a payment's life. Append-only."""

    __tablename__ = "payment_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    payment_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("payments.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # initiated | processing | authorized | succeeded | failed | refunded
    status: Mapped[str] = mapped_column(String(30), nullable=False)
    note: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    payment: Mapped["Payment"] = relationship(back_populates="events")


class Refund(Base, TimestampMixin):
    """
    Money going back.

    A refund is a *request* first and a movement of money second, which is why
    it is its own record rather than a flag on the payment: it can be raised,
    sit in processing and be rejected without anything moving. Only a completed
    refund adjusts the payment and the invoice.
    """

    __tablename__ = "refunds"

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    refund_number: Mapped[str] = mapped_column(String(40), nullable=False, unique=True, index=True)

    order_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("orders.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    order_number: Mapped[str] = mapped_column(String(30), nullable=False, default="")
    invoice_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("invoices.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    invoice_number: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    payment_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("payments.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    customer_name: Mapped[str] = mapped_column(String(160), nullable=False, default="")

    amount: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    # How `amount` goes back, for an order partly paid by gift card, store
    # credit or points: this much through the gateway, the rest to those
    # tenders, in the proportion they paid. NULL on refunds raised before
    # tenders existed, which went wholly through the gateway.
    gateway_amount: Mapped[Optional[int]] = mapped_column(Money, nullable=True)
    tender_amount: Mapped[int] = mapped_column(Money, nullable=False, default=0, server_default="0")
    # Free text, for the team's own records. `reason_code` is what customers see
    # (as a label) and what reports group by. See docs/refunds.md.
    reason: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    # requested | processing | completed | failed | cancelled — and `rejected`,
    # kept for refunds turned down at approval (and the ones raised before
    # approval existed). See `services/refunds.STATUSES`.
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="requested", index=True)

    requested_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    processed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    credit_note_id: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True)

    # Razorpay's own refund id (`rfnd_…`). Refunds are asynchronous — the
    # gateway answers `pending` and reports `processed` or `failed` later, by
    # webhook — and this is the only thing that webhook can be matched on.
    gateway_reference: Mapped[Optional[str]] = mapped_column(
        String(60), nullable=True, index=True
    )
    # An admin id, or "customer".
    initiated_by: Mapped[str] = mapped_column(String(40), nullable=False, default="customer")

    # ---- partial refunds (docs/refunds.md) -------------------------------
    # How the payment's share goes back: `original` (the gateway; for cash on
    # delivery, a bank/UPI transfer the team makes and records) or
    # `store-credit`. Gift card, store credit and points shares always go back
    # to the tender that paid them.
    method: Mapped[str] = mapped_column(String(20), nullable=False, default="original", server_default="original")
    reason_code: Mapped[str] = mapped_column(String(30), nullable=False, default="other", server_default="other")
    # For the team only. Never in a customer view, an email or the gateway.
    internal_note: Mapped[str] = mapped_column(String(1000), nullable=False, default="", server_default="")
    # Sent by the client; the same key again is the same refund.
    idempotency_key: Mapped[Optional[str]] = mapped_column(String(80), nullable=True, unique=True, index=True)
    # What of `amount` is the delivery fee, and the tax inside it (paise).
    shipping_amount: Mapped[int] = mapped_column(Money, nullable=False, default=0, server_default="0")
    tax_amount: Mapped[int] = mapped_column(Money, nullable=False, default=0, server_default="0")
    # The coupon/member discount the refunded units carried — already netted out
    # of `amount`, kept so the adjustment is visible.
    discount_amount: Mapped[int] = mapped_column(Money, nullable=False, default=0, server_default="0")
    # Above the approval threshold, raised by someone without `refunds-large`.
    requires_approval: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    approved_by: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    approved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # A bank transfer's UTR, for a cash-on-delivery refund paid back by hand.
    manual_reference: Mapped[str] = mapped_column(String(120), nullable=False, default="", server_default="")
    failure_reason: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")
    # Gateway attempts, and when the background job should next look at it.
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    last_attempt_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    next_check_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, index=True)
    # Whether the payment's share and the tenders' share have been booked
    # against the payment, the invoice and the tenders. Each is applied once,
    # and the payment's is undone if the gateway later fails the refund.
    gateway_settled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    tenders_settled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    completed_effects: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")

    items: Mapped[List["RefundItem"]] = relationship(
        back_populates="refund", cascade="all, delete-orphan", lazy="selectin"
    )


class RefundItem(Base):
    """
    A per-item refund line. Empty for a whole-order amount refund.

    Lines raised through the calculation (`services/refunds.calculate`) name
    the order line and the invoice line they refund and carry its share of
    the discount and tax, so a later refund knows what is left of each.
    """

    __tablename__ = "refund_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    refund_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("refunds.id", ondelete="CASCADE"), nullable=False, index=True
    )
    product_id: Mapped[str] = mapped_column(BusinessId, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    amount: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    order_item_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("order_items.id", ondelete="SET NULL"), nullable=True, index=True
    )
    invoice_item_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("invoice_items.id", ondelete="SET NULL"), nullable=True
    )
    discount: Mapped[int] = mapped_column(Money, nullable=False, default=0, server_default="0")
    taxable_amount: Mapped[int] = mapped_column(Money, nullable=False, default=0, server_default="0")
    tax_rate_percent: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False, default=0, server_default="0")
    cgst: Mapped[int] = mapped_column(Money, nullable=False, default=0, server_default="0")
    sgst: Mapped[int] = mapped_column(Money, nullable=False, default=0, server_default="0")
    igst: Mapped[int] = mapped_column(Money, nullable=False, default=0, server_default="0")
    tax: Mapped[int] = mapped_column(Money, nullable=False, default=0, server_default="0")

    refund: Mapped["Refund"] = relationship(back_populates="items")


class CreditNote(Base, TimestampMixin):
    """
    The document that reduces an invoice's value, carrying the tax adjustment.

    Its tax is recomputed from the credited amount rather than copied off the
    invoice, so a partial credit carries the right proportion and the note
    reconciles with the document it offsets.
    """

    __tablename__ = "credit_notes"

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    credit_note_number: Mapped[str] = mapped_column(
        String(40), nullable=False, unique=True, index=True
    )

    invoice_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("invoices.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    invoice_number: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    order_id: Mapped[str] = mapped_column(BusinessId, nullable=False, index=True)
    order_number: Mapped[str] = mapped_column(String(30), nullable=False, default="")
    customer_id: Mapped[str] = mapped_column(BusinessId, nullable=False, index=True)
    customer_name: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    refund_id: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True)

    reason: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    amount: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    tax: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    total: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    # The tax, split the way the invoice charged it (see `invoices.credit_note_tax`).
    tax_mode: Mapped[str] = mapped_column(String(20), nullable=False, default="none", server_default="none")
    cgst: Mapped[int] = mapped_column(Money, nullable=False, default=0, server_default="0")
    sgst: Mapped[int] = mapped_column(Money, nullable=False, default=0, server_default="0")
    igst: Mapped[int] = mapped_column(Money, nullable=False, default=0, server_default="0")

    issued_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    # draft | issued | cancelled
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="issued")


class WebhookEvent(Base):
    """
    A gateway webhook delivery that has already been processed.

    Keyed by Razorpay's `x-razorpay-event-id`. Razorpay documents duplicate
    deliveries as *expected* — the same event can arrive more than once, and it
    retries anything that does not answer 2xx within five seconds — so every
    delivery is looked up here first and a second one is acknowledged without
    being applied twice.

    Written in the same transaction as whatever the event changed. If applying
    it fails, the row is rolled back with the change and the retry is processed
    properly, rather than being recorded as done when it was not.
    """

    __tablename__ = "webhook_events"
    # Indexes the migrations create, declared so `create_all` (the tests) builds the same
    # schema and autogenerate never proposes dropping them.
    __table_args__ = (
        Index("ix_webhook_events_gateway_payment", "gateway_payment_id"),
        Index("ix_webhook_events_status_received", "status", "received_at"),
    )

    event_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    event: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
    # What processing it concluded, for the audit trail: "settled PAY012",
    # "ignored", "refunded late payment".
    result: Mapped[str] = mapped_column(String(60), nullable=False, default="", server_default="")
    received_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    # ---- monitoring (see `services/webhooks.py`)
    # received | processing | processed | failed | retrying | ignored
    # A duplicate delivery isn't a new row; it's counted in `duplicates`.
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="processed", server_default="processed")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    duplicates: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    last_duplicate_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    error: Mapped[str] = mapped_column(String(500), nullable=False, default="", server_default="")
    order_id: Mapped[Optional[str]] = mapped_column(String(40), nullable=True, index=True)
    payment_id: Mapped[Optional[str]] = mapped_column(String(40), nullable=True, index=True)
    gateway_payment_id: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)
    refund_id: Mapped[Optional[str]] = mapped_column(String(60), nullable=True, index=True)
    # The fields processing reads — ids, amounts, statuses — never the
    # customer's contact, card, bank or UPI details.
    payload: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    attempt_log: Mapped[List["WebhookEventAttempt"]] = relationship(
        back_populates="webhook_event", cascade="all, delete-orphan", order_by="WebhookEventAttempt.id",
    )


class WebhookEventAttempt(Base):
    """One try at processing a webhook event: a delivery, a redelivery, or a replay from the portal."""

    __tablename__ = "webhook_event_attempts"
    # Indexes the migrations create, declared so `create_all` (the tests) builds the same
    # schema and autogenerate never proposes dropping them.
    __table_args__ = (Index("ix_webhook_event_attempts_event", "event_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("webhook_events.event_id", ondelete="CASCADE"), nullable=False
    )
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    # delivery | redelivery | replay
    trigger: Mapped[str] = mapped_column(String(20), nullable=False)
    admin_id: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # processed | ignored | failed
    outcome: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    result: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    error: Mapped[str] = mapped_column(String(500), nullable=False, default="")

    webhook_event: Mapped[WebhookEvent] = relationship(back_populates="attempt_log")
