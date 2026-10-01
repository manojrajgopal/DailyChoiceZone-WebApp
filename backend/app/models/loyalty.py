"""
Reward points.

## A ledger, with lots

`LoyaltyTransaction` is the ledger: every point earned, spent, reversed,
expired or adjusted, append-only, with the spendable balance after it.

`LoyaltyLot` is where points live between being earned and being spent: each
earning (or manual credit) is a lot with its own date to become spendable
(points are *pending* until the order can no longer be returned) and its own
expiry. Spending takes from the lots that expire first, and
`LoyaltyRedemption` records which, so that a cancelled order puts the points
back into exactly the lots they came from — with their original expiry, not a
fresh one.

`LoyaltyAccount` is the row checkout locks. It holds the running totals, and
`debt`: points owed back when an order's points were reversed after they had
been spent. Debt is paid off from the next points that become spendable, and
nothing can be redeemed while it is owed — so returning an order never leaves
a customer with rewards for a purchase they didn't keep.

    spendable = Σ remaining of released, unexpired lots − debt
    pending   = Σ remaining of lots not yet released
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import BusinessId


class LoyaltyAccount(Base):
    __tablename__ = "loyalty_accounts"

    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="RESTRICT"), primary_key=True
    )
    debt: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    lifetime_earned: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    lifetime_redeemed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    lifetime_expired: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    lifetime_reversed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class LoyaltyTransaction(Base):
    """Every change to a customer's points. Append-only."""

    __tablename__ = "loyalty_transactions"
    __table_args__ = (
        UniqueConstraint("idempotency_key", name="ux_loyalty_txn_key"),
        Index("ix_loyalty_txn_customer_created", "customer_id", "created_at"),
        Index("ix_loyalty_txn_kind_created", "kind", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="RESTRICT"), nullable=False
    )
    # earned | redeemed | restored | reversed | expired | manual_credit | manual_debit | adjustment
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    points: Mapped[int] = mapped_column(Integer, nullable=False)  # signed
    # Spendable balance after this entry (may be negative while debt is owed).
    balance_after: Mapped[int] = mapped_column(Integer, nullable=False)
    order_id: Mapped[Optional[str]] = mapped_column(BusinessId, ForeignKey("orders.id", ondelete="RESTRICT"), nullable=True, index=True)
    refund_id: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True)
    reason: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    # For earned points: when they become spendable.
    available_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    admin_id: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True)
    admin_name: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    idempotency_key: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class LoyaltyLot(Base):
    """Points from one earning, and what of them is still unspent."""

    __tablename__ = "loyalty_lots"
    __table_args__ = (
        Index("ix_loyalty_lots_customer_expiry", "customer_id", "expires_at"),
        Index("ix_loyalty_lots_release", "released", "available_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="RESTRICT"), nullable=False
    )
    transaction_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("loyalty_transactions.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    order_id: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True, index=True)
    points: Mapped[int] = mapped_column(Integer, nullable=False)
    remaining: Mapped[int] = mapped_column(Integer, nullable=False)
    available_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    # Set when a pending lot becomes spendable (and any debt was paid from it).
    released: Mapped[bool] = mapped_column(nullable=False, default=False)
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    expiry_warned_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class LoyaltyRedemption(Base):
    """Which lots an order's redeemed points came from, and how many went back."""

    __tablename__ = "loyalty_redemptions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_id: Mapped[str] = mapped_column(BusinessId, ForeignKey("orders.id", ondelete="CASCADE"), nullable=False, index=True)
    lot_id: Mapped[int] = mapped_column(Integer, ForeignKey("loyalty_lots.id", ondelete="RESTRICT"), nullable=False)
    points: Mapped[int] = mapped_column(Integer, nullable=False)
    restored: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
