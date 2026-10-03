"""
Search and filters: dynamic product attributes, the typo dictionary, and the
search log behind the analytics. See docs/search-and-filters.md.

## Attributes

A `ProductAttribute` is a property the store defines once (material, capacity,
dishwasher safe) with a `type`: `select` (one option), `multi` (several
options), `number` (a value with a unit, filtered as a range) or `boolean`.
`select` and `multi` attributes have `ProductAttributeOption`s. A product's
values are `ProductAttributeValue` rows: one per option for `multi`, otherwise
one. `value_normalized` is what filters and facets group on; `value_number` is
the number a range compares.

## Search log

A `SearchQuery` is one search a shopper ran (page 1 of a result list), with the
normalised term and how many products it found. A `SearchClick` is a product
opened from those results, at its position; `converted` is set by the job when
that product reached the same customer's bag or an order soon after. The
`SearchDailyStat` rows are the per-day, per-term aggregates the admin report
reads. No IP addresses, user agents or raw terms are kept.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import List, Optional

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import BusinessId, TimestampMixin

# ---------------------------------------------------------------- attributes


class ProductAttribute(Base, TimestampMixin):
    """A property products can have, defined once by the store."""

    __tablename__ = "product_attributes"
    __table_args__ = (Index("ix_product_attributes_status_position", "status", "position"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # Lower-case letters, digits and `_`: it appears in storefront URLs (`attr.material=steel`).
    code: Mapped[str] = mapped_column(String(40), nullable=False, unique=True)
    label: Mapped[str] = mapped_column(String(80), nullable=False)
    # select | multi | number | boolean
    type: Mapped[str] = mapped_column(String(12), nullable=False)
    unit: Mapped[str] = mapped_column(String(20), nullable=False, default="", server_default="")
    filterable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="1")
    searchable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="1")
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    # active | archived
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="active", server_default="active")

    options: Mapped[List["ProductAttributeOption"]] = relationship(
        back_populates="attribute",
        cascade="all, delete-orphan",
        order_by="ProductAttributeOption.position",
        lazy="selectin",
    )


class ProductAttributeOption(Base):
    """One choice of a `select` or `multi` attribute."""

    __tablename__ = "product_attribute_options"
    __table_args__ = (UniqueConstraint("attribute_id", "value", name="uq_product_attribute_options_value"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    attribute_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("product_attributes.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # The normalised slug: what URLs, filters and facets use.
    value: Mapped[str] = mapped_column(String(120), nullable=False)
    label: Mapped[str] = mapped_column(String(120), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")

    attribute: Mapped["ProductAttribute"] = relationship(back_populates="options")


class ProductAttributeValue(Base):
    """A product's value for one attribute (one row per chosen option for `multi`)."""

    __tablename__ = "product_attribute_values"
    __table_args__ = (
        UniqueConstraint("product_id", "attribute_id", "value_normalized", name="uq_product_attribute_values"),
        # Filters and facets: "products whose material is steel", grouped counts per value.
        Index("ix_product_attribute_values_lookup", "attribute_id", "value_normalized", "product_id"),
        # Number ranges.
        Index("ix_product_attribute_values_number", "attribute_id", "value_number"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    attribute_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("product_attributes.id", ondelete="CASCADE"), nullable=False
    )
    # What a person reads ("Stainless steel", "750", "Yes").
    value: Mapped[str] = mapped_column(String(160), nullable=False)
    value_normalized: Mapped[str] = mapped_column(String(160), nullable=False)
    value_number: Mapped[Optional[float]] = mapped_column(Numeric(14, 4), nullable=True)

    attribute: Mapped["ProductAttribute"] = relationship()


# ------------------------------------------------------------ search index


class ProductSearchIndex(Base):
    """
    What search and the best-selling sort need that `products` doesn't hold.

    One row per product, kept beside `products` rather than as columns on it:
    the product row is read by the cart, checkout and every order screen, and
    none of them need these. A product without a row yet (just created, or
    before the first rebuild) is still found by its own columns and sorts as
    nothing sold.
    """

    __tablename__ = "product_search_index"

    product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="CASCADE"), primary_key=True
    )
    # Lower case: the category and collection names, colours, specification
    # values and searchable attribute values.
    search_text: Mapped[str] = mapped_column(String(1000), nullable=False, default="", server_default="")
    # Units on orders that went ahead (not cancelled, not awaiting payment).
    units_sold: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0", index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now())


# ---------------------------------------------------------------- dictionary


class SearchTerm(Base):
    """A word the catalogue contains, for "did you mean". Rebuilt by the `search` job."""

    __tablename__ = "search_terms"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    term: Mapped[str] = mapped_column(String(80), nullable=False, unique=True)
    length: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    # name | brand | category | tag | attribute
    kind: Mapped[str] = mapped_column(String(12), nullable=False, default="name", server_default="name")
    # How many products use it: ties between equally close corrections go to the commoner word.
    frequency: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now())


# ---------------------------------------------------------------- analytics


class SearchQuery(Base):
    """One search a shopper ran."""

    __tablename__ = "search_queries"
    __table_args__ = (
        Index("ix_search_queries_term_time", "term", "created_at"),
        Index("ix_search_queries_visitor_time", "visitor_hash", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    term: Mapped[str] = mapped_column(String(200), nullable=False)
    results_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    zero_results: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # The dictionary's correction, when the term found nothing and the correction did.
    corrected_term: Mapped[str] = mapped_column(String(200), nullable=False, default="", server_default="")
    visitor_hash: Mapped[str] = mapped_column(String(64), nullable=False, default="", server_default="")
    customer_id: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True)
    # Which filter dimensions were in use, e.g. "brand,category,price".
    filters: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")
    sort: Mapped[str] = mapped_column(String(20), nullable=False, default="", server_default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)

    clicks: Mapped[List["SearchClick"]] = relationship(back_populates="search", cascade="all, delete-orphan")


class SearchClick(Base):
    """A product opened from a search's results."""

    __tablename__ = "search_clicks"
    __table_args__ = (UniqueConstraint("search_id", "product_id", name="uq_search_clicks_product"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    search_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("search_queries.id", ondelete="CASCADE"), nullable=False
    )
    product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # 1-based, over the whole result list.
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    visitor_hash: Mapped[str] = mapped_column(String(64), nullable=False, default="", server_default="")
    customer_id: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True)
    converted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    converted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)

    search: Mapped["SearchQuery"] = relationship(back_populates="clicks")


class SearchDailyStat(Base):
    """Per day and term: searches, zero-result searches, clicks, conversions."""

    __tablename__ = "search_daily_stats"
    __table_args__ = (UniqueConstraint("day", "term", name="uq_search_daily_stats_day_term"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    day: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    term: Mapped[str] = mapped_column(String(200), nullable=False)
    searches: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    zero_results: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Searches with at least one click (so CTR can't exceed 100%), and total converted clicks.
    clicked_searches: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    clicks: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    conversions: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    avg_results: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False, default=0)
