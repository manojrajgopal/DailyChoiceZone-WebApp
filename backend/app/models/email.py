"""Outgoing email: the sending account, customers' choices, and a log."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import BusinessId


class EmailAccount(Base):
    """
    The account the store sends from. One row is active at a time.

    `credentials` is encrypted (see `services/email/crypto.py`); it is never
    returned to the browser, only masked hints of it.
    """

    __tablename__ = "email_accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # gmail-oauth | smtp
    provider: Mapped[str] = mapped_column(String(20), nullable=False)
    sender_email: Mapped[str] = mapped_column(String(255), nullable=False)
    sender_name: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    reply_to: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    credentials: Mapped[str] = mapped_column(Text, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)
    verified_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    updated_by: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class CustomerEmailPreference(Base):
    """A customer's own on/off for one kind of email, where the store allows it."""

    __tablename__ = "customer_email_preferences"

    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), primary_key=True
    )
    email_type: Mapped[str] = mapped_column(String(40), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class EmailLog(Base):
    __tablename__ = "email_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    email_type: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    recipient: Mapped[str] = mapped_column(String(255), nullable=False)
    subject: Mapped[str] = mapped_column(String(255), nullable=False)
    # sent | failed
    status: Mapped[str] = mapped_column(String(12), nullable=False, index=True)
    error: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    reference: Mapped[str] = mapped_column(String(40), nullable=False, default="", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    # The provider's id for the sent message (Gmail's), used to match a bounce
    # notice to it; and when a bounce turned a "sent" into "failed".
    provider_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    bounced_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # The template it was written from, and its record in notification_deliveries.
    template_key: Mapped[str] = mapped_column(String(60), nullable=False, default="", server_default="")
    delivery_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True, index=True)
