"""
Product discovery: recently viewed, saved for later, product relationships,
size guides, and the per-product delivery rules behind "check availability".

See docs/product-discovery.md.

## Why these are tables of their own

Every one of them is new information. Nothing here repeats a number another
table already holds:

- stock stays on `products` (one number, one place), and availability is
  computed from it at read time;
- the pincode coverage stays in `delivery_pincodes`; a product's own delivery
  rules only *narrow* what that table allows;
- a saved-for-later line keeps the price it was saved at only to say "the
  price dropped" — the bag and checkout always price from the catalogue.

None of them adds a column to an existing table, so a server running before
the migration keeps working exactly as it did.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import BusinessId, TimestampMixin


# ------------------------------------------------------------ recently viewed


class RecentlyViewedProduct(Base):
    """
    A product a signed-in customer looked at, most recent view only.

    One row per customer and product — the unique constraint is the
    de-duplication, so viewing a product again moves it to the front instead of
    adding a second entry. Guests keep their history in the browser and it is
    merged into these rows when they sign in (`services.recently_viewed.merge`).

    Deleting a product deletes its rows (CASCADE): there is nothing to show for
    a product that no longer exists. A product that is merely unpublished keeps
    its row and is filtered out on read, so it reappears if it is published
    again.
    """

    __tablename__ = "recently_viewed_products"
    __table_args__ = (
        UniqueConstraint("customer_id", "product_id", name="uq_recently_viewed_product"),
        # "This customer's history, newest first" — the only way it is read.
        Index("ix_recently_viewed_customer_time", "customer_id", "viewed_at"),
        # The retention sweep.
        Index("ix_recently_viewed_time", "viewed_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False
    )
    product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # The colour/size on screen at the last view, so the link reopens it.
    color: Mapped[str] = mapped_column(String(60), nullable=False, default="", server_default="")
    size: Mapped[str] = mapped_column(String(30), nullable=False, default="", server_default="")
    # Where the view came from: search, category, recommendation, … ("" unknown).
    source: Mapped[str] = mapped_column(String(40), nullable=False, default="", server_default="")
    view_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    first_viewed_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    viewed_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    product: Mapped["Product"] = relationship(lazy="noload")  # noqa: F821


# ------------------------------------------------------------ saved for later


class SavedCartItem(Base, TimestampMixin):
    """
    A bag line put aside: "not now", as opposed to the wishlist's "some day".

    Keyed like a bag line — customer, product, size, colour — so saving the
    same variant twice merges quantities instead of creating a second row, and
    moving it back lands on the matching bag line.

    `saved_unit_price` is what the line cost when it was saved, in minor units.
    It is **never** used to price anything: moving a line back to the bag goes
    through the bag's own add-to-bag checks and today's price. It exists only
    to tell the customer "the price dropped from ₹X to ₹Y".
    """

    __tablename__ = "saved_cart_items"
    __table_args__ = (
        UniqueConstraint("customer_id", "product_id", "size", "color", name="uq_saved_cart_variant"),
        Index("ix_saved_cart_customer_time", "customer_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False
    )
    product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Empty string rather than NULL, for the same reason as `CartItem`: MySQL
    # treats NULLs as distinct in a unique index.
    size: Mapped[str] = mapped_column(String(30), nullable=False, default="", server_default="")
    color: Mapped[str] = mapped_column(String(60), nullable=False, default="", server_default="")
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    saved_unit_price: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")

    product: Mapped["Product"] = relationship(lazy="selectin")  # noqa: F821


# ------------------------------------------------------- related products


RELATIONSHIP_TYPES = ("related", "frequently-bought-together", "similar", "alternative", "accessory")


class ProductRelationship(Base, TimestampMixin):
    """
    A relationship an administrator set between two products.

    Directional: "PRD001 → PRD007 (accessory)" says what to show on PRD001's
    page. The portal can add the reverse at the same time. One row per pair
    and type; `position` is the editorial order within a type, and `active`
    switches a row off without losing it.

    A product never relates to itself — refused by the service, because MySQL
    does not allow a CHECK constraint on a column with a cascading foreign key.
    """

    __tablename__ = "product_relationships"
    __table_args__ = (
        UniqueConstraint("product_id", "related_product_id", "type", name="uq_product_relationship"),
        Index("ix_product_relationships_lookup", "product_id", "type", "active", "position"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="CASCADE"), nullable=False
    )
    related_product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # related | frequently-bought-together | similar | alternative | accessory
    type: Mapped[str] = mapped_column(String(30), nullable=False, default="related")
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="1")
    created_by: Mapped[str] = mapped_column(String(40), nullable=False, default="", server_default="")

    related: Mapped["Product"] = relationship(  # noqa: F821
        foreign_keys=[related_product_id], lazy="noload"
    )


# ------------------------------------------------------------- size guides


SIZE_GUIDE_KINDS = ("clothing", "footwear", "ring", "general")
SIZE_GUIDE_UNITS = ("cm", "in", "mm")


class SizeGuide(Base, TimestampMixin):
    """
    A size table, reusable across products.

    `columns` and `rows` are one document edited whole in the portal — nothing
    joins on a cell, and a child table per cell would turn every save into a
    delete-and-reinsert of dozens of rows for no query anyone runs:

        columns: [{"key": "chest", "label": "Chest", "type": "measurement"},
                  {"key": "uk",    "label": "UK",    "type": "text"}]
        rows:    [{"size": "M", "values": {"chest": {"min": 96, "max": 101}, "uk": "8"}}]

    A `measurement` cell is `{min, max?}` in the guide's `unit`; a `text` cell
    is a string (shoe sizes, labels). Numbers stay numbers, which is what lets
    the storefront convert units exactly and what a future "find my size"
    would compare against.

    Which guide a product shows: its own assignment (`ProductSizeGuide`), else
    its category's (`SizeGuideCategory`), else the guide marked default.
    """

    __tablename__ = "size_guides"

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    # clothing | footwear | ring | general — a hint for the editor's starting
    # columns and the storefront's wording; it never restricts the columns.
    kind: Mapped[str] = mapped_column(String(20), nullable=False, default="general")
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # cm | in | mm — the unit the measurements are stored in.
    unit: Mapped[str] = mapped_column(String(4), nullable=False, default="cm")
    columns: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    rows: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    # [{"title": "Chest", "body": "Measure around the fullest part…", "column": "chest"}]
    instructions: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # active | inactive. An inactive guide is shown nowhere, whatever points at it.
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="active", index=True)
    # The store-wide fallback. At most one, kept so by the service.
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    updated_by: Mapped[str] = mapped_column(String(40), nullable=False, default="", server_default="")

    categories: Mapped[List["SizeGuideCategory"]] = relationship(
        back_populates="guide", cascade="all, delete-orphan", lazy="selectin"
    )


class SizeGuideCategory(Base):
    """A category's guide. One per category — the primary key says so."""

    __tablename__ = "size_guide_categories"

    category_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("categories.id", ondelete="CASCADE"), primary_key=True
    )
    size_guide_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("size_guides.id", ondelete="CASCADE"), nullable=False, index=True
    )

    guide: Mapped["SizeGuide"] = relationship(back_populates="categories")


class ProductSizeGuide(Base):
    """A product's own guide, overriding its category's. One per product."""

    __tablename__ = "product_size_guides"

    product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="CASCADE"), primary_key=True
    )
    size_guide_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("size_guides.id", ondelete="CASCADE"), nullable=False, index=True
    )


# ---------------------------------------------------- delivery, per product


class ProductDeliveryProfile(Base):
    """
    A product's own delivery rules, where it has any.

    No row means "no restrictions of its own": the pincode table and the
    store's settings decide alone. A row can only *take away* — switch off cash
    on delivery for a high-value piece, express for something oversized, or
    add handling days before dispatch for a made-to-order item.
    """

    __tablename__ = "product_delivery_profiles"

    product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="CASCADE"), primary_key=True
    )
    cod_allowed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="1")
    express_allowed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="1")
    # Business days to get it ready before it ships. NULL: the store's default.
    dispatch_days: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # Shown to the customer when a rule stops delivery (e.g. "Fragile — not
    # shipped to remote areas").
    note: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")
    updated_by: Mapped[str] = mapped_column(String(40), nullable=False, default="", server_default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    exclusions: Mapped[List["ProductDeliveryExclusion"]] = relationship(
        cascade="all, delete-orphan", lazy="selectin",
        primaryjoin="ProductDeliveryProfile.product_id == foreign(ProductDeliveryExclusion.product_id)",
        order_by="ProductDeliveryExclusion.id",
    )


EXCLUSION_KINDS = ("pincode", "prefix", "state")


class ProductDeliveryExclusion(Base):
    """
    Somewhere one product is not delivered.

    `pincode` matches one pincode, `prefix` every pincode starting with the
    digits (a postal region: "79" is the North-East), `state` a state by name as
    the pincode table records it.
    """

    __tablename__ = "product_delivery_exclusions"
    __table_args__ = (
        UniqueConstraint("product_id", "kind", "value", name="uq_product_delivery_exclusion"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # pincode | prefix | state
    kind: Mapped[str] = mapped_column(String(10), nullable=False)
    value: Mapped[str] = mapped_column(String(120), nullable=False)
    reason: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")
