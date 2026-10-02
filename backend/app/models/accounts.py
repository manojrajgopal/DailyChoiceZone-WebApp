"""
One-time account links, and the life of a signed-in customer's cart.

## Tokens

Email verification and password reset are the same thing at the storage level:
a random secret sent by email, good once, for a limited time. Only the SHA-256
of the secret is stored — a database dump alone can't be turned into working
links — alongside the address it was sent to, so changing the email voids it.

## Cart recovery

A cart has no row of its own (see `CartItem`): it is the lines a customer has.
`CartRecovery` is the lifecycle *around* those lines — when they were last
touched, whether the cart was abandoned, which reminders went out, and whether
an order followed. There is at most one open row per customer.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import JSON, BigInteger, DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import BusinessId


class CustomerToken(Base):
    __tablename__ = "customer_tokens"
    # Indexes the migrations create, declared so `create_all` (the tests) builds the same
    # schema and autogenerate never proposes dropping them.
    __table_args__ = (
        Index("ix_customer_tokens_customer_purpose", "customer_id", "purpose"),
        Index("ix_customer_tokens_expires", "expires_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False
    )
    # email-verification | password-reset
    purpose: Mapped[str] = mapped_column(String(30), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    used_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # used | superseded | expired
    revoked_reason: Mapped[str] = mapped_column(String(20), nullable=False, default="")


class CartRecovery(Base):
    __tablename__ = "cart_recoveries"
    # Indexes the migrations create, declared so `create_all` (the tests) builds the same
    # schema and autogenerate never proposes dropping them.
    __table_args__ = (
        Index("ix_cart_recoveries_customer_status", "customer_id", "status"),
        Index("ix_cart_recoveries_status_activity", "status", "last_activity_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False
    )
    # active | abandoned | recovered | expired | converted
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    started_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    last_activity_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    abandoned_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    item_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Minor units, at the prices when it was abandoned.
    cart_value: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    # What was in it then: [{productId, name, size, color, quantity, unitPrice, image}]
    items: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    reminders_sent: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_reminder_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # SHA-256 of the recovery link's token. The token itself is only in the email.
    token_hash: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, unique=True)
    clicked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    recovered_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    recovered_order_id: Mapped[Optional[str]] = mapped_column(
        BusinessId, ForeignKey("orders.id", ondelete="SET NULL"), nullable=True
    )
    recovered_value: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    closed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
