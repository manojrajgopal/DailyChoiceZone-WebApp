"""The paid membership programme (named in settings; "Choice Circle" by default)."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import BusinessId


class MembershipPlan(Base):
    """
    One plan an administrator offers — monthly, quarterly, yearly, two years —
    with its price and the benefits it carries. Plans are retired, not
    deleted, once somebody has bought one, so a member's record keeps making
    sense.
    """

    __tablename__ = "membership_plans"

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    description: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    duration_months: Mapped[int] = mapped_column(Integer, nullable=False)
    price: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    # Shown struck through beside the price, e.g. twelve monthly payments.
    compare_at_price: Mapped[Optional[float]] = mapped_column(Numeric(12, 2), nullable=True)

    # --- benefits ---------------------------------------------------------
    free_delivery: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Free standard deliveries per membership month; None means unlimited.
    free_deliveries_per_month: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # Extra percentage off every order, after any coupon.
    member_discount_percent: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False, default=0)
    # Days added to the return window for orders placed as a member.
    extra_return_days: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    early_access: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    priority_support: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # A one-line highlight, e.g. "Best value".
    badge: Mapped[str] = mapped_column(String(40), nullable=False, default="")

    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class CustomerMembership(Base):
    """
    One purchase of a plan by a customer.

    The benefits are **copied** here when the membership is bought, so editing
    a plan later never changes what an existing member paid for.
    """

    __tablename__ = "customer_memberships"

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    plan_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("membership_plans.id", ondelete="RESTRICT"), nullable=False
    )
    plan_name: Mapped[str] = mapped_column(String(80), nullable=False)
    duration_months: Mapped[int] = mapped_column(Integer, nullable=False)
    # pending (awaiting payment) | active | expired | cancelled
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="pending", index=True)
    starts_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    ends_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, index=True)
    amount: Mapped[int] = mapped_column(Integer, nullable=False)  # minor units
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="INR")
    benefits: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)

    gateway_order_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    gateway_payment_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    paid_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
