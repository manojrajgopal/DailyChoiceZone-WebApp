"""Product discovery: recently viewed, saved for later, product relationships, size guides, delivery rules

New tables:

- `recently_viewed_products`: a signed-in customer's browsing history, one row
  per customer and product, newest first by `(customer_id, viewed_at)`.
- `saved_cart_items`: bag lines put aside ("saved for later"), keyed like a
  bag line (customer, product, size, colour).
- `product_relationships`: store-chosen related / similar / frequently bought
  together / alternative / accessory products, ordered per type.
- `size_guides`, `size_guide_categories`, `product_size_guides`: reusable size
  tables, a category's guide, a product's own guide.
- `product_delivery_profiles`, `product_delivery_exclusions`: a product's own
  delivery rules (no COD, no express, handling days, places it isn't sent to).

Purely additive: no existing table or column changes, and no data is written.
Safe to run again after an interruption: every table and index is created only
if it is missing. See docs/product-discovery.md.

Revision ID: 7c1f4e2a9b35
Revises: d7f9b1c3e5a7
Create Date: 2026-10-07 09:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "7c1f4e2a9b35"
down_revision: Union[str, None] = "d7f9b1c3e5a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ID = sa.String(20)

TABLES = (
    "product_delivery_exclusions",
    "product_delivery_profiles",
    "product_size_guides",
    "size_guide_categories",
    "size_guides",
    "product_relationships",
    "saved_cart_items",
    "recently_viewed_products",
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
    # --- recently viewed --------------------------------------------------
    _create_table(
        "recently_viewed_products",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("product_id", ID, sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
        sa.Column("color", sa.String(60), nullable=False, server_default=""),
        sa.Column("size", sa.String(30), nullable=False, server_default=""),
        sa.Column("source", sa.String(40), nullable=False, server_default=""),
        sa.Column("view_count", sa.Integer, nullable=False, server_default="1"),
        sa.Column("first_viewed_at", sa.DateTime, nullable=False),
        sa.Column("viewed_at", sa.DateTime, nullable=False),
        sa.UniqueConstraint("customer_id", "product_id", name="uq_recently_viewed_product"),
    )
    _create_index("ix_recently_viewed_customer_time", "recently_viewed_products", ["customer_id", "viewed_at"])
    _create_index("ix_recently_viewed_time", "recently_viewed_products", ["viewed_at"])
    _create_index("ix_recently_viewed_products_product_id", "recently_viewed_products", ["product_id"])

    # --- saved for later --------------------------------------------------
    _create_table(
        "saved_cart_items",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("product_id", ID, sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
        sa.Column("size", sa.String(30), nullable=False, server_default=""),
        sa.Column("color", sa.String(60), nullable=False, server_default=""),
        sa.Column("quantity", sa.Integer, nullable=False, server_default="1"),
        sa.Column("saved_unit_price", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=_now()),
        sa.Column("updated_at", sa.DateTime, nullable=False, server_default=_now()),
        sa.UniqueConstraint("customer_id", "product_id", "size", "color", name="uq_saved_cart_variant"),
    )
    _create_index("ix_saved_cart_customer_time", "saved_cart_items", ["customer_id", "created_at"])
    _create_index("ix_saved_cart_items_product_id", "saved_cart_items", ["product_id"])

    # --- product relationships --------------------------------------------
    _create_table(
        "product_relationships",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("product_id", ID, sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
        sa.Column("related_product_id", ID, sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
        sa.Column("type", sa.String(30), nullable=False),
        sa.Column("position", sa.Integer, nullable=False, server_default="0"),
        sa.Column("active", sa.Boolean, nullable=False, server_default="1"),
        sa.Column("created_by", sa.String(40), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=_now()),
        sa.Column("updated_at", sa.DateTime, nullable=False, server_default=_now()),
        sa.UniqueConstraint("product_id", "related_product_id", "type", name="uq_product_relationship"),
    )
    _create_index("ix_product_relationships_lookup", "product_relationships",
                  ["product_id", "type", "active", "position"])
    _create_index("ix_product_relationships_related_product_id", "product_relationships", ["related_product_id"])

    # --- size guides -------------------------------------------------------
    _create_table(
        "size_guides",
        sa.Column("id", ID, primary_key=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("description", sa.Text, nullable=False),
        sa.Column("unit", sa.String(4), nullable=False),
        sa.Column("columns", sa.JSON, nullable=False),
        sa.Column("rows", sa.JSON, nullable=False),
        sa.Column("instructions", sa.JSON, nullable=False),
        sa.Column("notes", sa.Text, nullable=False),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("is_default", sa.Boolean, nullable=False, server_default="0"),
        sa.Column("updated_by", sa.String(40), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=_now()),
        sa.Column("updated_at", sa.DateTime, nullable=False, server_default=_now()),
    )
    _create_index("ix_size_guides_status", "size_guides", ["status"])
    _create_table(
        "size_guide_categories",
        sa.Column("category_id", ID, sa.ForeignKey("categories.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("size_guide_id", ID, sa.ForeignKey("size_guides.id", ondelete="CASCADE"), nullable=False),
    )
    _create_index("ix_size_guide_categories_size_guide_id", "size_guide_categories", ["size_guide_id"])
    _create_table(
        "product_size_guides",
        sa.Column("product_id", ID, sa.ForeignKey("products.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("size_guide_id", ID, sa.ForeignKey("size_guides.id", ondelete="CASCADE"), nullable=False),
    )
    _create_index("ix_product_size_guides_size_guide_id", "product_size_guides", ["size_guide_id"])

    # --- a product's own delivery rules -----------------------------------
    _create_table(
        "product_delivery_profiles",
        sa.Column("product_id", ID, sa.ForeignKey("products.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("cod_allowed", sa.Boolean, nullable=False, server_default="1"),
        sa.Column("express_allowed", sa.Boolean, nullable=False, server_default="1"),
        sa.Column("dispatch_days", sa.Integer, nullable=True),
        sa.Column("note", sa.String(255), nullable=False, server_default=""),
        sa.Column("updated_by", sa.String(40), nullable=False, server_default=""),
        sa.Column("updated_at", sa.DateTime, nullable=False, server_default=_now()),
    )
    _create_table(
        "product_delivery_exclusions",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("product_id", ID, sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(10), nullable=False),
        sa.Column("value", sa.String(120), nullable=False),
        sa.Column("reason", sa.String(255), nullable=False, server_default=""),
        sa.UniqueConstraint("product_id", "kind", "value", name="uq_product_delivery_exclusion"),
    )
    _create_index("ix_product_delivery_exclusions_product_id", "product_delivery_exclusions", ["product_id"])


def downgrade() -> None:
    # Children before parents. Only these new tables: nothing that existed
    # before this revision is touched.
    for name in TABLES:
        if _has_table(name):
            op.drop_table(name)
