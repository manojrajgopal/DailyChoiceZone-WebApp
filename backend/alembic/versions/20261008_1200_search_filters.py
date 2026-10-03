"""Search & filters: product attributes, the search index and dictionary, search analytics

New tables:

- `product_attributes`, `product_attribute_options`, `product_attribute_values`:
  store-defined attributes (select / multi / number / boolean), their options,
  and each product's values, indexed for filters, facets and number ranges.
- `product_search_index`: one row per product with the denormalised
  `search_text` and the precomputed `units_sold` (best-selling sort).
- `search_terms`: the "did you mean" dictionary.
- `search_queries`, `search_clicks`, `search_daily_stats`: the search log,
  click-through and conversions, and their daily aggregates.

New indexes on existing tables (no column changes, no data changes):
`products (price)`, `(rating)`, `(created_at)`, `(status, price)`,
`(status, created_at)`; `product_sizes (label, product_id)`;
`product_colors (name, product_id)`.

Purely additive. Safe to run again after an interruption: every table and
index is created only if it is missing.

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-10-08 12:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d4e5f6a7b8c9"
down_revision: Union[str, None] = "c3d4e5f6a7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ID = sa.String(20)

# Indexes added to tables that already exist.
EXISTING_TABLE_INDEXES = (
    ("ix_products_price", "products", ["price"]),
    ("ix_products_rating", "products", ["rating"]),
    ("ix_products_created_at", "products", ["created_at"]),
    ("ix_products_status_price", "products", ["status", "price"]),
    ("ix_products_status_created", "products", ["status", "created_at"]),
    ("ix_product_sizes_label", "product_sizes", ["label", "product_id"]),
    ("ix_product_colors_name", "product_colors", ["name", "product_id"]),
)


def _inspector():
    return sa.inspect(op.get_bind())


def _has_table(name: str) -> bool:
    return _inspector().has_table(name)


def _indexes(table: str) -> set:
    inspector = _inspector()
    names = {i["name"] for i in inspector.get_indexes(table)}
    names |= {u["name"] for u in inspector.get_unique_constraints(table)}
    return names


def _create_index(name: str, table: str, columns: list, unique: bool = False) -> None:
    if name not in _indexes(table):
        op.create_index(name, table, columns, unique=unique)


def _create_table(name: str, *columns) -> None:
    if not _has_table(name):
        op.create_table(name, *columns)


def _now():
    return sa.text("CURRENT_TIMESTAMP")


def upgrade() -> None:
    for name, table, columns in EXISTING_TABLE_INDEXES:
        _create_index(name, table, columns)

    _create_table(
        "product_attributes",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("code", sa.String(40), nullable=False, unique=True),
        sa.Column("label", sa.String(80), nullable=False),
        sa.Column("type", sa.String(12), nullable=False),
        sa.Column("unit", sa.String(20), nullable=False, server_default=""),
        sa.Column("filterable", sa.Boolean, nullable=False, server_default="1"),
        sa.Column("searchable", sa.Boolean, nullable=False, server_default="1"),
        sa.Column("position", sa.Integer, nullable=False, server_default="0"),
        sa.Column("status", sa.String(12), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=_now()),
        sa.Column("updated_at", sa.DateTime, nullable=False, server_default=_now()),
    )
    _create_index("ix_product_attributes_status_position", "product_attributes", ["status", "position"])

    _create_table(
        "product_attribute_options",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("attribute_id", sa.Integer, sa.ForeignKey("product_attributes.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("value", sa.String(120), nullable=False),
        sa.Column("label", sa.String(120), nullable=False),
        sa.Column("position", sa.Integer, nullable=False, server_default="0"),
        sa.UniqueConstraint("attribute_id", "value", name="uq_product_attribute_options_value"),
    )
    _create_index("ix_product_attribute_options_attribute_id", "product_attribute_options", ["attribute_id"])

    _create_table(
        "product_attribute_values",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("product_id", ID, sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
        sa.Column("attribute_id", sa.Integer, sa.ForeignKey("product_attributes.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("value", sa.String(160), nullable=False),
        sa.Column("value_normalized", sa.String(160), nullable=False),
        sa.Column("value_number", sa.Numeric(14, 4), nullable=True),
        sa.UniqueConstraint("product_id", "attribute_id", "value_normalized", name="uq_product_attribute_values"),
    )
    _create_index("ix_product_attribute_values_product_id", "product_attribute_values", ["product_id"])
    _create_index("ix_product_attribute_values_lookup", "product_attribute_values",
                  ["attribute_id", "value_normalized", "product_id"])
    _create_index("ix_product_attribute_values_number", "product_attribute_values", ["attribute_id", "value_number"])

    _create_table(
        "product_search_index",
        sa.Column("product_id", ID, sa.ForeignKey("products.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("search_text", sa.String(1000), nullable=False, server_default=""),
        sa.Column("units_sold", sa.Integer, nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime, nullable=False, server_default=_now()),
    )
    _create_index("ix_product_search_index_units_sold", "product_search_index", ["units_sold"])

    _create_table(
        "search_terms",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("term", sa.String(80), nullable=False, unique=True),
        sa.Column("length", sa.Integer, nullable=False),
        sa.Column("kind", sa.String(12), nullable=False, server_default="name"),
        sa.Column("frequency", sa.Integer, nullable=False, server_default="1"),
        sa.Column("updated_at", sa.DateTime, nullable=False, server_default=_now()),
    )
    _create_index("ix_search_terms_length", "search_terms", ["length"])

    _create_table(
        "search_queries",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("term", sa.String(200), nullable=False),
        sa.Column("results_count", sa.Integer, nullable=False),
        sa.Column("zero_results", sa.Boolean, nullable=False),
        sa.Column("corrected_term", sa.String(200), nullable=False, server_default=""),
        sa.Column("visitor_hash", sa.String(64), nullable=False, server_default=""),
        sa.Column("customer_id", ID, nullable=True),
        sa.Column("filters", sa.String(255), nullable=False, server_default=""),
        sa.Column("sort", sa.String(20), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime, nullable=False),
    )
    _create_index("ix_search_queries_created_at", "search_queries", ["created_at"])
    _create_index("ix_search_queries_term_time", "search_queries", ["term", "created_at"])
    _create_index("ix_search_queries_visitor_time", "search_queries", ["visitor_hash", "created_at"])

    _create_table(
        "search_clicks",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("search_id", sa.Integer, sa.ForeignKey("search_queries.id", ondelete="CASCADE"), nullable=False),
        sa.Column("product_id", ID, sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column("visitor_hash", sa.String(64), nullable=False, server_default=""),
        sa.Column("customer_id", ID, nullable=True),
        sa.Column("converted", sa.Boolean, nullable=False, server_default="0"),
        sa.Column("converted_at", sa.DateTime, nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.UniqueConstraint("search_id", "product_id", name="uq_search_clicks_product"),
    )
    _create_index("ix_search_clicks_product_id", "search_clicks", ["product_id"])
    _create_index("ix_search_clicks_created_at", "search_clicks", ["created_at"])

    _create_table(
        "search_daily_stats",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("day", sa.Date, nullable=False),
        sa.Column("term", sa.String(200), nullable=False),
        sa.Column("searches", sa.Integer, nullable=False),
        sa.Column("zero_results", sa.Integer, nullable=False),
        sa.Column("clicked_searches", sa.Integer, nullable=False),
        sa.Column("clicks", sa.Integer, nullable=False),
        sa.Column("conversions", sa.Integer, nullable=False),
        sa.Column("avg_results", sa.Numeric(10, 2), nullable=False),
        sa.UniqueConstraint("day", "term", name="uq_search_daily_stats_day_term"),
    )
    _create_index("ix_search_daily_stats_day", "search_daily_stats", ["day"])


def downgrade() -> None:
    # Children before parents. Only for a deliberate rollback by a person;
    # startup only ever upgrades.
    for table in (
        "search_daily_stats", "search_clicks", "search_queries", "search_terms", "product_search_index",
        "product_attribute_values", "product_attribute_options", "product_attributes",
    ):
        if _has_table(table):
            op.drop_table(table)
    for name, table, _columns in EXISTING_TABLE_INDEXES:
        if name in _indexes(table):
            op.drop_index(name, table_name=table)
