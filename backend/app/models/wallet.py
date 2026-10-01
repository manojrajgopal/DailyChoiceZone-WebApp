"""
Gift cards, store credit, and how either paid for an order.

Every amount is an integer in minor units (paise), like billing.

## Balances move only with a ledger entry

A gift card's `balance` and a customer's store-credit `balance` are kept on
the row so checkout can lock and read one number — but every change to either
is written, in the same transaction, as an append-only transaction carrying
the amount and the balance after it. The sum of a card's transactions is its
balance; nothing changes one without the other.

## Tenders

Gift cards, store credit and reward points are *tenders*: they pay part of an
order's invoice, like cash would. They don't change the invoice — its lines,
tax and total are what was sold — only how much is left for the gateway to
collect. `OrderTender` records each one, and what of it has gone back since
(a cancellation or a refund), which is what keeps a reversal from returning
the same money twice.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import BusinessId


class GiftCard(Base):
    """
    A gift card. Its code is never stored: only a keyed hash of it, to find the
    card, and the last four characters, to show it.
    """

    __tablename__ = "gift_cards"
    __table_args__ = (
        Index("ix_gift_cards_status_created", "status", "created_at"),
        Index("ix_gift_cards_recipient_email", "recipient_email"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    code_last4: Mapped[str] = mapped_column(String(4), nullable=False)
    # pending (awaiting payment) | active | used | expired | disabled | refunded | cancelled
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    initial_amount: Mapped[int] = mapped_column(BigInteger, nullable=False)
    balance: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="INR")
    # purchase | admin
    source: Mapped[str] = mapped_column(String(20), nullable=False, default="purchase")
    purchaser_id: Mapped[Optional[str]] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="SET NULL"), nullable=True, index=True
    )
    sender_name: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    recipient_name: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    recipient_email: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    # Plain text, shown as text.
    message: Mapped[str] = mapped_column(Text, nullable=False, default="")
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    delivered_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    activated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # The purchase's own payment, for a card bought through the gateway.
    gateway_order_id: Mapped[Optional[str]] = mapped_column(String(60), nullable=True, index=True)
    gateway_payment_id: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)
    paid_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    issued_by: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True)
    status_reason: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    transactions: Mapped[List["GiftCardTransaction"]] = relationship(
        back_populates="gift_card", order_by="GiftCardTransaction.id"
    )


class GiftCardTransaction(Base):
    """Every movement on a gift card. Append-only."""

    __tablename__ = "gift_card_transactions"
    __table_args__ = (UniqueConstraint("idempotency_key", name="ux_gift_card_txn_key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    gift_card_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("gift_cards.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    # issue | redeem | restore | refund-restore | expire | disable | enable | refund | adjust
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    amount: Mapped[int] = mapped_column(BigInteger, nullable=False)  # signed
    balance_after: Mapped[int] = mapped_column(BigInteger, nullable=False)
    order_id: Mapped[Optional[str]] = mapped_column(BusinessId, ForeignKey("orders.id", ondelete="RESTRICT"), nullable=True, index=True)
    refund_id: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True)
    note: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    admin_id: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True)
    # Set for movements that must happen once (a redemption per order, a
    # restore per refund): a repeat is refused by the unique index.
    idempotency_key: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    gift_card: Mapped[GiftCard] = relationship(back_populates="transactions")


class StoreCreditAccount(Base):
    """A customer's store-credit balance, kept with its ledger."""

    __tablename__ = "store_credit_accounts"

    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="RESTRICT"), primary_key=True
    )
    balance: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    lifetime_credited: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    lifetime_spent: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class StoreCreditTransaction(Base):
    """Every movement of store credit. Append-only."""

    __tablename__ = "store_credit_transactions"
    __table_args__ = (
        UniqueConstraint("idempotency_key", name="ux_store_credit_txn_key"),
        Index("ix_store_credit_txn_customer_created", "customer_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="RESTRICT"), nullable=False
    )
    # grant | goodwill | promotion | refund | gift-card-refund | redeem | restore | revoke | adjust
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    amount: Mapped[int] = mapped_column(BigInteger, nullable=False)  # signed
    balance_after: Mapped[int] = mapped_column(BigInteger, nullable=False)
    reason: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    order_id: Mapped[Optional[str]] = mapped_column(BusinessId, ForeignKey("orders.id", ondelete="RESTRICT"), nullable=True, index=True)
    refund_id: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True)
    admin_id: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True)
    admin_name: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    idempotency_key: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class OrderTender(Base):
    """What a gift card, store credit or reward points paid towards an order."""

    __tablename__ = "order_tenders"
    __table_args__ = (UniqueConstraint("order_id", "tender_key", name="ux_order_tender"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_id: Mapped[str] = mapped_column(BusinessId, ForeignKey("orders.id", ondelete="CASCADE"), nullable=False, index=True)
    # gift_card | store_credit | points
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    # "gift_card:<id>", "store_credit" or "points" — one row each per order.
    tender_key: Mapped[str] = mapped_column(String(40), nullable=False)
    gift_card_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("gift_cards.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    # Minor units it paid, and points spent (points tenders only).
    amount: Mapped[int] = mapped_column(BigInteger, nullable=False)
    points: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # What has gone back since, by cancellation or refund.
    reversed_amount: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    reversed_points: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
