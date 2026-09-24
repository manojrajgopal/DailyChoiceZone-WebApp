"""Customers, their addresses, and the cart and wishlist they own."""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import BusinessId, TimestampMixin


class Customer(Base, TimestampMixin):
    """
    A registered shopper.

    Authentication lives on this row rather than in a separate `users` table.
    There are exactly two kinds of account — customer and administrator — and
    they share no columns worth the join: a customer has addresses, orders and
    a wishlist; an admin has a role and a permission set.
    """

    __tablename__ = "customers"

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    # Never a password. bcrypt output, always.
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)

    first_name: Mapped[str] = mapped_column(String(80), nullable=False)
    last_name: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    phone: Mapped[str] = mapped_column(String(20), nullable=False, default="")

    # active | blocked. A blocked customer keeps their history and cannot sign in.
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active", index=True)
    joined_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now())
    last_login_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    addresses: Mapped[List["Address"]] = relationship(
        back_populates="customer", cascade="all, delete-orphan", lazy="selectin"
    )
    cart_items: Mapped[List["CartItem"]] = relationship(
        back_populates="customer", cascade="all, delete-orphan"
    )
    wishlist_items: Mapped[List["WishlistItem"]] = relationship(
        back_populates="customer", cascade="all, delete-orphan"
    )

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}".strip()


class Address(Base, TimestampMixin):
    """
    A saved delivery or billing address.

    Kept separate from the address *copied onto an order*: this one can be
    edited or deleted, and an order must keep the address it actually shipped
    to. See `Order.shipping_*`.
    """

    __tablename__ = "addresses"

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False, index=True
    )

    full_name: Mapped[str] = mapped_column(String(120), nullable=False)
    phone: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    line1: Mapped[str] = mapped_column(String(255), nullable=False)
    line2: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    city: Mapped[str] = mapped_column(String(120), nullable=False)
    state: Mapped[str] = mapped_column(String(120), nullable=False)
    pincode: Mapped[str] = mapped_column(String(12), nullable=False)
    country: Mapped[str] = mapped_column(String(80), nullable=False, default="India")
    # home | work — shown as a chip on the address card.
    type: Mapped[str] = mapped_column(String(20), nullable=False, default="home")
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    customer: Mapped["Customer"] = relationship(back_populates="addresses")


class CartItem(Base, TimestampMixin):
    """
    A line in a customer's cart.

    There is no separate `carts` table. A cart is "the rows belonging to this
    customer" — a parent row would hold nothing but a foreign key and a
    lifecycle nobody manages.

    The unique constraint is what makes "add to cart" idempotent per variant:
    the same product in two sizes is two lines, the same product in the same
    size added twice is one line with quantity two.
    """

    __tablename__ = "cart_items"
    __table_args__ = (
        UniqueConstraint("customer_id", "product_id", "size", "color", name="uq_cart_variant"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Empty string rather than NULL: MySQL treats NULLs as distinct in a unique
    # index, so a nullable column here would allow duplicate "no size" lines.
    size: Mapped[str] = mapped_column(String(30), nullable=False, default="")
    color: Mapped[str] = mapped_column(String(60), nullable=False, default="")
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    customer: Mapped["Customer"] = relationship(back_populates="cart_items")
    product: Mapped["Product"] = relationship(lazy="selectin")  # noqa: F821


class WishlistItem(Base, TimestampMixin):
    """A saved product. One row per customer and product — the constraint is the
    de-duplication, so "add twice" cannot create a second entry."""

    __tablename__ = "wishlist_items"
    __table_args__ = (
        UniqueConstraint("customer_id", "product_id", name="uq_wishlist_product"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )

    customer: Mapped["Customer"] = relationship(back_populates="wishlist_items")
    product: Mapped["Product"] = relationship(lazy="selectin")  # noqa: F821
