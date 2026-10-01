"""
Product engagement: back-in-stock and price-drop alerts, the comparison list,
and customer questions with the store's answers.

## One active alert per customer and product

`active_key` is 1 while an alert is active and NULL otherwise, and it is part
of a unique index. MySQL treats NULLs as distinct, so any number of notified or
unsubscribed alerts can sit beside the one active alert, and a second active
alert for the same thing is refused by the database rather than by a check
that two requests could both pass.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import BusinessId


class StockAlert(Base):
    """'Tell me when it's back.' One-shot: notified once, then the customer can subscribe again."""

    __tablename__ = "stock_alerts"
    __table_args__ = (
        UniqueConstraint("customer_id", "product_id", "size", "color", "active_key", name="ux_stock_alerts_active"),
        Index("ix_stock_alerts_product_status", "product_id", "status"),
        Index("ix_stock_alerts_status_created", "status", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    product_id: Mapped[str] = mapped_column(BusinessId, ForeignKey("products.id", ondelete="CASCADE"), nullable=False)
    # The variant they wanted. Stock is held per product, so availability is the
    # product's; the size and colour are remembered for the email and the link.
    size: Mapped[str] = mapped_column(String(30), nullable=False, default="", server_default="")
    color: Mapped[str] = mapped_column(String(60), nullable=False, default="", server_default="")
    # active | notified | unsubscribed
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    active_key: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    notified_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    unsubscribed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # Sends tried, and why the last one couldn't go (email not set up, the
    # customer turned these emails off). Delivery failures after a send is
    # accepted are in the email log, under `stock-alert-<id>`.
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    last_attempt_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_error: Mapped[str] = mapped_column(String(300), nullable=False, default="", server_default="")


class PriceChange(Base):
    """
    A change to a product's selling price, as the price-drop alerts saw it.

    Written only when the selling price itself moves — a new compare-at price,
    description or stock level is not a price change.
    """

    __tablename__ = "product_price_changes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Minor units.
    old_price: Mapped[int] = mapped_column(BigInteger, nullable=False)
    new_price: Mapped[int] = mapped_column(BigInteger, nullable=False)
    old_original_price: Mapped[int] = mapped_column(BigInteger, nullable=False)
    new_original_price: Mapped[int] = mapped_column(BigInteger, nullable=False)
    changed_by: Mapped[str] = mapped_column(String(40), nullable=False, default="system")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    alerts_notified: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")


class PriceAlert(Base):
    """
    'Tell me when it's cheaper' — any drop below the price when they asked, or
    at or below a price they chose. One-shot, like a stock alert.
    """

    __tablename__ = "price_alerts"
    __table_args__ = (
        UniqueConstraint("customer_id", "product_id", "active_key", name="ux_price_alerts_active"),
        Index("ix_price_alerts_product_status", "product_id", "status"),
        Index("ix_price_alerts_status_created", "status", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    product_id: Mapped[str] = mapped_column(BusinessId, ForeignKey("products.id", ondelete="CASCADE"), nullable=False)
    # any | target
    mode: Mapped[str] = mapped_column(String(10), nullable=False, default="any")
    # Minor units. The selling price when they subscribed; and their target.
    baseline_price: Mapped[int] = mapped_column(BigInteger, nullable=False)
    target_price: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    # active | notified | unsubscribed
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    active_key: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    notified_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    notified_price: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    unsubscribed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    last_attempt_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_error: Mapped[str] = mapped_column(String(300), nullable=False, default="", server_default="")

    notifications: Mapped[List["PriceAlertNotification"]] = relationship(
        back_populates="alert", cascade="all, delete-orphan", order_by="PriceAlertNotification.id"
    )


class PriceAlertNotification(Base):
    """
    One email about one price change to one alert. The unique pair is what
    keeps a price change processed twice (a retry, two admins saving at once)
    from emailing twice.
    """

    __tablename__ = "price_alert_notifications"
    __table_args__ = (UniqueConstraint("alert_id", "price_change_id", name="ux_price_alert_notification"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    alert_id: Mapped[int] = mapped_column(Integer, ForeignKey("price_alerts.id", ondelete="CASCADE"), nullable=False)
    price_change_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("product_price_changes.id", ondelete="SET NULL"), nullable=True
    )
    from_price: Mapped[int] = mapped_column(BigInteger, nullable=False)
    to_price: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # queued | not-sent | resent
    outcome: Mapped[str] = mapped_column(String(20), nullable=False, default="queued")
    note: Mapped[str] = mapped_column(String(300), nullable=False, default="", server_default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    alert: Mapped[PriceAlert] = relationship(back_populates="notifications")


class ComparisonItem(Base):
    """A product on a signed-in customer's comparison list. Guests keep theirs in the browser."""

    __tablename__ = "comparison_items"
    __table_args__ = (UniqueConstraint("customer_id", "product_id", name="ux_comparison_product"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    product_id: Mapped[str] = mapped_column(BusinessId, ForeignKey("products.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class ProductQuestion(Base):
    """
    A customer's question about a product. Nothing is shown until a moderator
    approves it; the text is stored as plain text and rendered as text.
    """

    __tablename__ = "product_questions"
    __table_args__ = (
        Index("ix_product_questions_product_status", "product_id", "status", "created_at"),
        Index("ix_product_questions_status_created", "status", "created_at"),
        Index("ix_product_questions_duplicate", "customer_id", "product_id", "body_hash"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    product_id: Mapped[str] = mapped_column(BusinessId, ForeignKey("products.id", ondelete="CASCADE"), nullable=False)
    customer_id: Mapped[Optional[str]] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="SET NULL"), nullable=True
    )
    # What the storefront shows as the asker: first name and initial.
    author_name: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    size: Mapped[str] = mapped_column(String(30), nullable=False, default="", server_default="")
    color: Mapped[str] = mapped_column(String(60), nullable=False, default="", server_default="")
    body: Mapped[str] = mapped_column(Text, nullable=False)
    # SHA-256 of the normalised text, so asking the same thing twice is caught.
    body_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    # pending | approved | rejected
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    rejection_reason: Mapped[str] = mapped_column(String(300), nullable=False, default="", server_default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    moderated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    moderated_by: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True)

    answer: Mapped[Optional["ProductAnswer"]] = relationship(
        back_populates="question", cascade="all, delete-orphan", uselist=False, lazy="selectin"
    )
    events: Mapped[List["ProductQuestionEvent"]] = relationship(
        back_populates="question", cascade="all, delete-orphan", order_by="ProductQuestionEvent.id"
    )


class ProductAnswer(Base):
    """The store's answer. One per question; shown once published on an approved question."""

    __tablename__ = "product_answers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    question_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("product_questions.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    published: Mapped[bool] = mapped_column(nullable=False, default=False)
    admin_id: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True)
    # Shown as "Answered by <name>"; the store's name when left blank.
    admin_name: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    published_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    question: Mapped[ProductQuestion] = relationship(back_populates="answer")


class ProductQuestionEvent(Base):
    """Moderation history: who approved, rejected, answered or edited, and when."""

    __tablename__ = "product_question_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    question_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("product_questions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # asked | approved | rejected | answered | answer-edited | answer-unpublished | edited
    action: Mapped[str] = mapped_column(String(30), nullable=False)
    note: Mapped[str] = mapped_column(String(500), nullable=False, default="", server_default="")
    admin_id: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True)
    admin_name: Mapped[str] = mapped_column(String(120), nullable=False, default="", server_default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    question: Mapped[ProductQuestion] = relationship(back_populates="events")
