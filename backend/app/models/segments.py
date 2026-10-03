"""
Customer segmentation: the precomputed per-customer metrics, saved segments,
their materialised membership and their history. See
docs/customer-segmentation.md.

Money is in paise (BIGINT), as in billing. Every metrics column has a server
default so a bare "mark this customer dirty" upsert can create the row.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import BusinessId

Money = BigInteger


def _zero():
    return mapped_column(Integer, nullable=False, default=0, server_default="0")


def _money():
    return mapped_column(Money, nullable=False, default=0, server_default="0")


def _no():
    return mapped_column(Boolean, nullable=False, default=False, server_default="0")


class CustomerMetrics(Base):
    """
    One row per customer, refreshed by the `segments` job (and on demand), so
    nothing on a page load ever aggregates orders. See §3 of the docs for what
    each figure counts.
    """

    __tablename__ = "customer_metrics"
    __table_args__ = (
        Index("ix_customer_metrics_refreshed", "refreshed_at"),
        Index("ix_customer_metrics_dirty", "dirty"),
        Index("ix_customer_metrics_orders", "total_orders"),
        Index("ix_customer_metrics_spend", "total_spend"),
        Index("ix_customer_metrics_last_order", "last_order_at"),
        Index("ix_customer_metrics_rfm", "rfm_label"),
        Index("ix_customer_metrics_city", "city"),
        Index("ix_customer_metrics_membership", "membership_status"),
    )

    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), primary_key=True
    )

    # --- shopping ---------------------------------------------------------
    total_orders: Mapped[int] = _zero()
    kept_orders: Mapped[int] = _zero()
    total_spend: Mapped[int] = _money()
    average_order_value: Mapped[int] = _money()
    first_order_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_order_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    cancelled_orders: Mapped[int] = _zero()
    returned_orders: Mapped[int] = _zero()
    refunded_orders: Mapped[int] = _zero()
    return_requests: Mapped[int] = _zero()
    coupon_uses: Mapped[int] = _zero()
    has_active_cart: Mapped[bool] = _no()
    has_abandoned_cart: Mapped[bool] = _no()
    abandoned_carts: Mapped[int] = _zero()

    # --- products ---------------------------------------------------------
    wishlist_items: Mapped[int] = _zero()
    products_viewed_90d: Mapped[int] = _zero()
    categories_viewed_90d: Mapped[int] = _zero()
    # Category ids of products bought in non-cancelled orders.
    purchased_category_ids: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)

    # --- membership and loyalty -------------------------------------------
    # active | expired | cancelled | none
    membership_status: Mapped[str] = mapped_column(String(12), nullable=False, default="none", server_default="none")
    membership_plan_id: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True)
    membership_ends_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    points_balance: Mapped[int] = _zero()
    store_credit_balance: Mapped[int] = _money()
    gift_card_orders: Mapped[int] = _zero()
    gift_card_spend: Mapped[int] = _money()

    # --- marketing ----------------------------------------------------------
    was_referred: Mapped[bool] = _no()
    referral_count: Mapped[int] = _zero()
    email_opt_in: Mapped[bool] = _no()
    sms_opt_in: Mapped[bool] = _no()
    whatsapp_opt_in: Mapped[bool] = _no()
    campaigns_received: Mapped[int] = _zero()
    campaign_opens: Mapped[int] = _zero()
    campaign_clicks: Mapped[int] = _zero()
    last_engaged_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # --- where -------------------------------------------------------------
    city: Mapped[str] = mapped_column(String(120), nullable=False, default="", server_default="")
    state: Mapped[str] = mapped_column(String(120), nullable=False, default="", server_default="")
    pincode: Mapped[str] = mapped_column(String(12), nullable=False, default="", server_default="")

    # --- RFM ---------------------------------------------------------------
    recency_score: Mapped[int] = _zero()
    frequency_score: Mapped[int] = _zero()
    monetary_score: Mapped[int] = _zero()
    # champions | loyal | potential | new | at-risk | hibernating | lost | no-orders
    rfm_label: Mapped[str] = mapped_column(String(20), nullable=False, default="no-orders", server_default="no-orders")

    # --- bookkeeping -------------------------------------------------------
    # Set by the change hook; cleared by a refresh that started after it.
    dirty: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="1")
    marked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    refreshed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class Segment(Base):
    """A saved, rule-based group of customers. Defaults are ordinary rows (`kind="default"`)."""

    __tablename__ = "segments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    slug: Mapped[str] = mapped_column(String(140), nullable=False, unique=True)
    description: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    # all | any
    match: Mapped[str] = mapped_column(String(3), nullable=False, default="all")
    rules: Mapped[list] = mapped_column(JSON, nullable=False)
    # default | custom
    kind: Mapped[str] = mapped_column(String(10), nullable=False, default="custom")
    # active | archived
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="active", index=True)
    member_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_calculated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_by: Mapped[str] = mapped_column(String(40), nullable=False, default="system")
    updated_by: Mapped[str] = mapped_column(String(40), nullable=False, default="system")
    archived_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class SegmentMember(Base):
    """A customer in a segment, as of its last calculation."""

    __tablename__ = "segment_members"

    segment_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("segments.id", ondelete="CASCADE"), primary_key=True
    )
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    added_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class SegmentEvent(Base):
    """
    A segment's history: created, updated, rules-changed, recalculated,
    archived, restored, exported. Append-only.
    """

    __tablename__ = "segment_events"
    __table_args__ = (Index("ix_segment_events_segment_time", "segment_id", "occurred_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    segment_id: Mapped[int] = mapped_column(Integer, ForeignKey("segments.id", ondelete="CASCADE"), nullable=False)
    action: Mapped[str] = mapped_column(String(20), nullable=False)
    # An admin id, or "system".
    actor: Mapped[str] = mapped_column(String(40), nullable=False, default="system")
    actor_name: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    details: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
