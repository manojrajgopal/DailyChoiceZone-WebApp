"""Orders, their lines, and the timeline of what happened to them."""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import BusinessId, TimestampMixin


class Order(Base, TimestampMixin):
    """
    A placed order.

    Addresses are **copied onto the order**, not referenced. An order is a
    record of what was agreed at a moment in time; if it pointed at a saved
    address, editing that address would silently rewrite where a delivered
    parcel was sent. The same reasoning applies to line prices — see
    `OrderItem`.
    """

    __tablename__ = "orders"
    __table_args__ = (
        Index("ix_orders_customer_placed", "customer_id", "placed_at"),
        Index("ix_orders_status", "status", "payment_status"),
    )

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    # The reference a customer quotes on a support call, e.g. "DCZ10241".
    order_number: Mapped[str] = mapped_column(
        String(30), nullable=False, unique=True, index=True
    )

    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    # Denormalised so the orders list renders without joining customers, and so
    # the order still reads correctly if the customer later changes their name.
    customer_name: Mapped[str] = mapped_column(String(160), nullable=False)
    customer_email: Mapped[str] = mapped_column(String(255), nullable=False)

    placed_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)

    # pending | confirmed | processing | shipped | delivered | cancelled | returned
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    # paid | pending | cod-pending | failed | refunded
    payment_status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    payment_method: Mapped[str] = mapped_column(String(40), nullable=False, default="")

    delivery_method: Mapped[str] = mapped_column(String(30), nullable=False, default="standard")
    delivery_fee: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    expected_delivery: Mapped[str] = mapped_column(String(60), nullable=False, default="")
    tracking_number: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)

    # --- totals, as agreed at checkout ------------------------------------
    item_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    subtotal: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    catalogue_savings: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    coupon_code: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    coupon_discount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    tax_amount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    total: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)

    # --- the address it actually shipped to -------------------------------
    shipping_name: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    shipping_phone: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    shipping_line1: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    shipping_line2: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    shipping_city: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    shipping_state: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    shipping_pincode: Mapped[str] = mapped_column(String(12), nullable=False, default="")
    shipping_country: Mapped[str] = mapped_column(String(80), nullable=False, default="India")

    items: Mapped[List["OrderItem"]] = relationship(
        back_populates="order", cascade="all, delete-orphan", lazy="selectin"
    )
    events: Mapped[List["OrderEvent"]] = relationship(
        back_populates="order",
        cascade="all, delete-orphan",
        order_by="OrderEvent.occurred_at",
        lazy="selectin",
    )


class OrderItem(Base):
    """
    A line on an order.

    **`unit_price` is the price at the time of purchase**, and the name, SKU and
    image are copied too. An order's value must never be recomputed from the
    current catalogue: a repriced product would silently rewrite last month's
    revenue, and a deleted one would erase the line entirely.

    `product_id` is kept alongside so the line can still reach the product it
    refers to — the relationship is by id, the record is a snapshot.
    """

    __tablename__ = "order_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("orders.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # RESTRICT, not CASCADE: deleting a product must never delete the history of
    # having sold it. The product service archives rather than deletes when a
    # product has been ordered.
    product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="RESTRICT"), nullable=False, index=True
    )

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    sku: Mapped[str] = mapped_column(String(60), nullable=False, default="")
    slug: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    brand: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    image: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    size: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)
    color: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)

    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    unit_price: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    line_total: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)

    order: Mapped["Order"] = relationship(back_populates="items")


class OrderEvent(Base):
    """
    One entry in an order's history. Append-only.

    Never derived from the current status: "it is delivered" and "it was
    confirmed, then shipped two days later" answer different questions, and
    support needs the second one.
    """

    __tablename__ = "order_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("orders.id", ondelete="CASCADE"), nullable=False, index=True
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # An admin id, or "system" / "customer".
    actor: Mapped[str] = mapped_column(String(40), nullable=False, default="system")
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    order: Mapped["Order"] = relationship(back_populates="events")
