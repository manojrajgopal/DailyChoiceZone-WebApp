"""
Referrals, flash sales and bundles.

## Referrals

Every customer can have one `ReferralCode`. A new customer who signs up with
it gets a `Referral` row — one per referred customer, enforced by a unique key,
so nobody can be referred twice. The rewards are paid only when the referred
customer's first qualifying order is paid (or delivered, depending on the
programme settings), through the store-credit or points ledger with an
idempotency key per referral and side: paying the same reward twice is refused
by the database, not just by the code.

## Flash sales

A `FlashSale` is a time window; its `FlashSaleItem`s each give one product a
sale price, an optional number of units sold at that price and an optional
limit per customer. A unit sold at the sale price is a `FlashSaleClaim`, tied
to the order and following its stock: reserved while a prepaid order waits for
the gateway, consumed once paid, released if the order is cancelled or never
paid. How many units are left at the sale price is always counted from the
claims, under a lock on the item — never a counter that can drift.

## Bundles

A `Bundle` has no stock of its own. It is a set of `BundleItem`s (a product and
how many of it), and how many bundles can be sold is the smallest of each
component's available stock divided by its quantity. A bundle in the bag is a
`CartBundle`; at checkout it becomes ordinary order lines, one per component,
with the bundle price shared across them — so stock, tax, returns and refunds
work on each component exactly as they do for any other line.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import BusinessId

# ---------------------------------------------------------------- referrals


class ReferralCode(Base):
    """A customer's own code to share. One per customer."""

    __tablename__ = "referral_codes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    code: Mapped[str] = mapped_column(String(16), nullable=False, unique=True)
    # Switched off by the store (abuse). The customer can't earn with it.
    disabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class Referral(Base):
    """
    One referred customer.

    status: pending (signed up, no qualifying order yet) | review (held for a
    person to check) | rewarded | rejected | reversed (rewards taken back after
    the qualifying order was cancelled or returned) | expired.
    """

    __tablename__ = "referrals"
    __table_args__ = (
        Index("ix_referrals_referrer_status", "referrer_id", "status"),
        Index("ix_referrals_status_created", "status", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    referrer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False
    )
    # Unique: a customer is referred once, whatever happens next.
    referee_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    code: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    # Why it is held or was refused, for the person reviewing it.
    flags: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    # A keyed hash of the sign-up address, never the address itself.
    signup_ip_hash: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    qualifying_order_id: Mapped[Optional[str]] = mapped_column(
        BusinessId, ForeignKey("orders.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # store_credit (paise) | points
    reward_type: Mapped[str] = mapped_column(String(20), nullable=False, default="store_credit")
    referrer_reward: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    referee_reward: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # What could not be taken back on a reversal because it was already spent.
    reversal_shortfall: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    note: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    decided_by: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True)
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    qualified_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    rewarded_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    reversed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


# -------------------------------------------------------------- flash sales


class FlashSale(Base):
    """
    status is what the store set: draft | published | cancelled. Whether a
    published sale is upcoming, live or over is worked out from its times.
    """

    __tablename__ = "flash_sales"
    __table_args__ = (Index("ix_flash_sales_window", "status", "starts_at", "ends_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")
    starts_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    ends_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    # Whether a coupon can be used on an order with this sale's items in it.
    allow_coupons: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    # When customers with a sale item in their wishlist were told it started.
    announced_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_by: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    items: Mapped[List["FlashSaleItem"]] = relationship(
        back_populates="sale", cascade="all, delete-orphan", order_by="FlashSaleItem.position"
    )


class FlashSaleItem(Base):
    __tablename__ = "flash_sale_items"
    __table_args__ = (
        UniqueConstraint("sale_id", "product_id", name="uq_flash_sale_product"),
        Index("ix_flash_sale_items_product", "product_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    sale_id: Mapped[int] = mapped_column(Integer, ForeignKey("flash_sales.id", ondelete="CASCADE"), nullable=False)
    product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="CASCADE"), nullable=False
    )
    # Rupees, like the product's own price.
    sale_price: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    # Units offered at the sale price. NULL: as many as are in stock.
    stock_limit: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # Units one customer may buy at the sale price. NULL: no limit.
    per_customer_limit: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # When its sale units ran out and the store team was told.
    sold_out_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    sale: Mapped[FlashSale] = relationship(back_populates="items")


class FlashSaleClaim(Base):
    """Units of one order bought at a flash sale price. state: reserved | consumed | released."""

    __tablename__ = "flash_sale_claims"
    __table_args__ = (
        UniqueConstraint("order_id", "item_id", name="uq_flash_claim_order_item"),
        Index("ix_flash_claims_item_state", "item_id", "state"),
        Index("ix_flash_claims_customer_item", "customer_id", "item_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    sale_id: Mapped[int] = mapped_column(Integer, ForeignKey("flash_sales.id", ondelete="CASCADE"), nullable=False,
                                         index=True)
    item_id: Mapped[int] = mapped_column(Integer, ForeignKey("flash_sale_items.id", ondelete="CASCADE"),
                                         nullable=False)
    product_id: Mapped[str] = mapped_column(BusinessId, nullable=False)
    order_id: Mapped[str] = mapped_column(BusinessId, ForeignKey("orders.id", ondelete="CASCADE"), nullable=False)
    customer_id: Mapped[str] = mapped_column(BusinessId, nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    # Paise: the sale price and the regular price at the time of the order.
    unit_price: Mapped[int] = mapped_column(Integer, nullable=False)
    regular_price: Mapped[int] = mapped_column(Integer, nullable=False)
    state: Mapped[str] = mapped_column(String(20), nullable=False, default="reserved")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


# ------------------------------------------------------------------ bundles


class Bundle(Base):
    """
    pricing: fixed (the bundle costs `price`) | percent (the components' total
    less `discount_percent`). status: draft | active | archived.
    """

    __tablename__ = "bundles"
    __table_args__ = (Index("ix_bundles_status", "status"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    slug: Mapped[str] = mapped_column(String(160), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    image: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    pricing: Mapped[str] = mapped_column(String(10), nullable=False, default="fixed")
    price: Mapped[Optional[float]] = mapped_column(Numeric(12, 2), nullable=True)
    discount_percent: Mapped[Optional[float]] = mapped_column(Numeric(5, 2), nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")
    starts_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    ends_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    max_per_order: Mapped[int] = mapped_column(Integer, nullable=False, default=5)
    created_by: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    items: Mapped[List["BundleItem"]] = relationship(
        back_populates="bundle", cascade="all, delete-orphan", order_by="BundleItem.position"
    )


class BundleItem(Base):
    __tablename__ = "bundle_items"
    __table_args__ = (UniqueConstraint("bundle_id", "product_id", name="uq_bundle_product"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    bundle_id: Mapped[int] = mapped_column(Integer, ForeignKey("bundles.id", ondelete="CASCADE"), nullable=False)
    # RESTRICT: a product that is part of a bundle can't be deleted from under it.
    product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    bundle: Mapped[Bundle] = relationship(back_populates="items")


class CartBundle(Base):
    """
    A bundle in the bag, with the size and colour chosen for each component.
    `selection_key` identifies the choices, so the same bundle with the same
    choices is one line and with different choices is another.
    """

    __tablename__ = "cart_bundles"
    __table_args__ = (
        UniqueConstraint("customer_id", "bundle_id", "selection_key", name="uq_cart_bundle_selection"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    bundle_id: Mapped[int] = mapped_column(Integer, ForeignKey("bundles.id", ondelete="CASCADE"), nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    # [{"productId", "size", "color"}], one per component.
    selections: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    selection_key: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    bundle: Mapped[Bundle] = relationship()
