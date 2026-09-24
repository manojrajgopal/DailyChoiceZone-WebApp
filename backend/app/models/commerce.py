"""Coupons, reviews, banners, homepage sections and the admin side."""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    JSON,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import BusinessId, TimestampMixin


class Coupon(Base, TimestampMixin):
    """A discount code. Validation happens in the service — never in the browser."""

    __tablename__ = "coupons"

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    code: Mapped[str] = mapped_column(String(40), nullable=False, unique=True, index=True)
    description: Mapped[str] = mapped_column(String(255), nullable=False, default="")

    # percent | flat | free-shipping
    type: Mapped[str] = mapped_column(String(20), nullable=False, default="percent")
    value: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    min_subtotal: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    # Cap on a percentage discount. NULL means uncapped, which is different
    # from zero — zero would mean the coupon is worth nothing.
    max_discount: Mapped[Optional[float]] = mapped_column(Numeric(12, 2), nullable=True)

    starts_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    ends_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    usage_limit: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    usage_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    per_customer_limit: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)

    usages: Mapped[List["CouponUsage"]] = relationship(
        back_populates="coupon", cascade="all, delete-orphan"
    )


class CouponUsage(Base):
    """
    One redemption.

    Its own table rather than a counter on the coupon, because "how many times
    has *this customer* used it" is a question a counter cannot answer — and
    per-customer limits are the commonest thing a coupon needs to enforce.
    """

    __tablename__ = "coupon_usages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    coupon_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("coupons.id", ondelete="CASCADE"), nullable=False, index=True
    )
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    order_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("orders.id", ondelete="CASCADE"), nullable=False, index=True
    )
    discount_amount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    used_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    coupon: Mapped["Coupon"] = relationship(back_populates="usages")


class Review(Base, TimestampMixin):
    """
    A product review, with its moderation state.

    Only `approved` reviews reach a product page — that is what makes the
    moderation queue mean something rather than being a form that changes
    nothing.
    """

    __tablename__ = "reviews"
    __table_args__ = (
        UniqueConstraint("product_id", "customer_id", "title", name="uq_review_once"),
    )

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Nullable: the seeded demo reviews predate the customers who would have
    # written them, and a review whose author was deleted is still a review.
    customer_id: Mapped[Optional[str]] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="SET NULL"), nullable=True, index=True
    )

    author: Mapped[str] = mapped_column(String(120), nullable=False)
    rating: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    body: Mapped[str] = mapped_column(Text, nullable=False, default="")
    verified_purchase: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # pending | approved | rejected
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending", index=True)
    submitted_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)


class Banner(Base, TimestampMixin):
    """A promotional message. The storefront's rotating strip reads these."""

    __tablename__ = "banners"

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    subtitle: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    image: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    button_text: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    button_link: Mapped[str] = mapped_column(String(255), nullable=False, default="")

    starts_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    ends_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    display_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class HomepageSection(Base, TimestampMixin):
    """
    One row of the homepage: what it is, and whether it is switched on.

    Both halves live here. The *definition* — which merchandising query it
    runs, what it is called — and the *editorial state* an administrator
    changes. They were two files in the frontend and joined by id, which is a
    join this table makes unnecessary.

    `config` carries the fields only one kind of section has: a "view all"
    link on a rail, the image and alignment on an editorial split. A column
    per variant would be mostly-NULL columns; the renderer reads them by name
    either way.
    """

    __tablename__ = "homepage_sections"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    type: Mapped[str] = mapped_column(String(40), nullable=False)
    title: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    subtitle: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    source: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    item_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    config: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    display_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0, index=True)


class AdminUser(Base, TimestampMixin):
    """
    Someone who can sign in to the portal.

    `permissions` is a JSON array rather than a roles/permissions pair of
    tables: there are three roles and a fixed permission vocabulary, and two
    join tables to express that would be schema for its own sake.
    """

    __tablename__ = "admin_users"

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)

    name: Mapped[str] = mapped_column(String(160), nullable=False)
    # super-admin | admin | staff
    role: Mapped[str] = mapped_column(String(30), nullable=False, default="staff", index=True)
    permissions: Mapped[list] = mapped_column(JSON, nullable=False, default=list)

    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active", index=True)
    last_login_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class Notification(Base):
    """An item in the portal's notification tray."""

    __tablename__ = "notifications"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    kind: Mapped[str] = mapped_column(String(30), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    body: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    href: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    read: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)


class SettingDocument(Base, TimestampMixin):
    """
    A whole configuration document, stored under a key.

    Store settings, billing config and tax config are each read and written
    entire, by one person, a handful of times a year. Exploding them into
    columns would mean a migration every time a field is added, to buy querying
    nobody does.
    """

    __tablename__ = "setting_documents"

    key: Mapped[str] = mapped_column(String(40), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
