"""Catalogue: categories, collections, products and the stock ledger."""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
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


class Category(Base, TimestampMixin):
    """A department. `groups` holds the mega-menu structure the frontend renders."""

    __tablename__ = "categories"

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    slug: Mapped[str] = mapped_column(String(80), nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    image: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    display_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    featured: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # The navigation groups are presentation, not relational data — nothing
    # joins on a menu heading. A child table here would buy nothing and cost a
    # join on every page load.
    groups: Mapped[list] = mapped_column(JSON, nullable=False, default=list)

    products: Mapped[List["Product"]] = relationship(back_populates="category")


class Collection(Base, TimestampMixin):
    """A curated edit — a hand-picked set of products."""

    __tablename__ = "collections"

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    slug: Mapped[str] = mapped_column(String(80), nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    tagline: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    image: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    featured: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    items: Mapped[List["CollectionProduct"]] = relationship(
        back_populates="collection",
        cascade="all, delete-orphan",
        order_by="CollectionProduct.position",
    )


class CollectionProduct(Base):
    """
    Membership of a collection.

    A join table with its own surrogate key and a `position`, because the order
    a collection presents its products in is editorial and has to be storable.
    """

    __tablename__ = "collection_products"
    __table_args__ = (
        UniqueConstraint("collection_id", "product_id", name="uq_collection_product"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    collection_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("collections.id", ondelete="CASCADE"), nullable=False, index=True
    )
    product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    collection: Mapped["Collection"] = relationship(back_populates="items")
    product: Mapped["Product"] = relationship()


class Product(Base, TimestampMixin):
    """
    One product record, customer fields and management fields together.

    The frontend deliberately models this as a single record — `AdminProduct =
    Product & ProductManagement` — with the customer payload being a projection
    of it. Splitting it into two tables here would recreate the divergence that
    model exists to prevent.

    **Stock lives here, not in a separate inventory table.** A second table
    holding a second copy of the quantity is two numbers that can disagree;
    the ledger of *changes* is what earns its own table (`StockAdjustment`).
    """

    __tablename__ = "products"
    __table_args__ = (
        Index("ix_products_listing", "status", "category_id"),
        Index("ix_products_flags", "is_new", "is_trending", "is_best_seller", "is_featured"),
    )

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    slug: Mapped[str] = mapped_column(String(160), nullable=False, unique=True, index=True)
    sku: Mapped[str] = mapped_column(String(60), nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, index=True)
    brand: Mapped[str] = mapped_column(String(120), nullable=False, index=True)

    category_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("categories.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    # The subcategory is a slug within the category's own `groups`, not a row
    # of its own — it has no attributes beyond a name the category already holds.
    subcategory: Mapped[str] = mapped_column(String(80), nullable=False, default="", index=True)

    # Money in whole rupees, matching the catalogue. Numeric rather than Float:
    # a price that drifts by a fraction of a paisa is a price nobody can
    # reconcile. Billing works in minor units and converts at its boundary.
    price: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    original_price: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    # Derived from the two prices on write, stored so the database can filter
    # and sort on it without recomputing per row.
    discount: Mapped[int] = mapped_column(Integer, nullable=False, default=0, index=True)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="INR")

    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    material: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    care: Mapped[str] = mapped_column(Text, nullable=False, default="")

    rating: Mapped[float] = mapped_column(Numeric(3, 2), nullable=False, default=0)
    review_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    is_new: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_trending: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_best_seller: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_featured: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # --- management ------------------------------------------------------
    # active | draft | out-of-stock | archived. Only active and out-of-stock
    # are ever shown to a customer; that is what makes Draft mean anything.
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active", index=True)
    stock: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    reserved_stock: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    low_stock_threshold: Mapped[int] = mapped_column(Integer, nullable=False, default=8)
    barcode: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    tax_rate_percent: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False, default=5)
    meta_title: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    meta_description: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    updated_by: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True)

    category: Mapped["Category"] = relationship(back_populates="products")

    # `lazy="selectin"` issues one extra query per relationship for the whole
    # result set rather than one per row — the difference between 4 queries and
    # 400 when listing a page of products.
    images: Mapped[List["ProductImage"]] = relationship(
        back_populates="product",
        cascade="all, delete-orphan",
        order_by="ProductImage.position",
        lazy="selectin",
    )
    colors: Mapped[List["ProductColor"]] = relationship(
        back_populates="product",
        cascade="all, delete-orphan",
        order_by="ProductColor.position",
        lazy="selectin",
    )
    sizes: Mapped[List["ProductSize"]] = relationship(
        back_populates="product",
        cascade="all, delete-orphan",
        order_by="ProductSize.position",
        lazy="selectin",
    )
    specifications: Mapped[List["ProductSpecification"]] = relationship(
        back_populates="product",
        cascade="all, delete-orphan",
        order_by="ProductSpecification.position",
        lazy="selectin",
    )
    tags: Mapped[List["ProductTag"]] = relationship(
        back_populates="product",
        cascade="all, delete-orphan",
        lazy="selectin",
    )

    @property
    def available_stock(self) -> int:
        """What can actually be sold: on hand minus what is already spoken for."""
        return max(0, self.stock - self.reserved_stock)


class ProductImage(Base):
    __tablename__ = "product_images"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    url: Mapped[str] = mapped_column(String(500), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    product: Mapped["Product"] = relationship(back_populates="images")


class ProductColor(Base):
    __tablename__ = "product_colors"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    hex: Mapped[str] = mapped_column(String(9), nullable=False, default="#000000")
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    product: Mapped["Product"] = relationship(back_populates="colors")


class ProductSize(Base):
    __tablename__ = "product_sizes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    label: Mapped[str] = mapped_column(String(30), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    product: Mapped["Product"] = relationship(back_populates="sizes")


class ProductSpecification(Base):
    __tablename__ = "product_specifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    label: Mapped[str] = mapped_column(String(80), nullable=False)
    value: Mapped[str] = mapped_column(String(255), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    product: Mapped["Product"] = relationship(back_populates="specifications")


class ProductTag(Base):
    """A search and merchandising keyword. Indexed, because search joins on it."""

    __tablename__ = "product_tags"
    __table_args__ = (UniqueConstraint("product_id", "tag", name="uq_product_tag"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    tag: Mapped[str] = mapped_column(String(60), nullable=False, index=True)

    product: Mapped["Product"] = relationship(back_populates="tags")


class StockAdjustment(Base):
    """
    Every change to a product's stock, append-only.

    The quantity itself lives on the product; this is the record of how it got
    there. Keeping both the reason and the resulting level means a stock query
    can be answered without replaying the whole ledger, while the ledger still
    explains any level you ask about.
    """

    __tablename__ = "stock_adjustments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # restock | correction | damaged | return | stocktake | sale
    reason: Mapped[str] = mapped_column(String(30), nullable=False)
    quantity_before: Mapped[int] = mapped_column(Integer, nullable=False)
    quantity_after: Mapped[int] = mapped_column(Integer, nullable=False)
    delta: Mapped[int] = mapped_column(Integer, nullable=False)
    note: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    # An admin id, or "system" when an order moved it.
    actor: Mapped[str] = mapped_column(String(40), nullable=False, default="system")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)

    product: Mapped["Product"] = relationship()
