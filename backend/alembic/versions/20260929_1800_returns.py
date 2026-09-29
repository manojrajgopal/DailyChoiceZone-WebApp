"""Returns and replacements

- `products.is_returnable` / `products.is_replaceable`: whether a product may be
  sent back for a refund, or exchanged for the same item. Both default to
  true — the storefront already promises returns on every product — so no
  existing product changes behaviour.
- `order_items.is_returnable` / `order_items.is_replaceable`: the same, copied
  onto each order line at purchase. The promise made at checkout is the one
  that counts, even if the product's setting changes later. Existing lines
  default to true, matching what those customers were told.
- `return_requests`, `return_request_items`, `return_events`: the requests
  themselves, their items and their history.

Additive only: nothing is dropped, renamed or rewritten.

Revision ID: 9d4c2b7e1f36
Revises: 6b2e1d9c4a70
Create Date: 2026-09-29 18:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "9d4c2b7e1f36"
down_revision: Union[str, None] = "6b2e1d9c4a70"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

BUSINESS_ID = sa.String(length=20)


def upgrade() -> None:
    for table in ("products", "order_items"):
        op.add_column(
            table,
            sa.Column("is_returnable", sa.Boolean(), nullable=False, server_default=sa.true()),
        )
        op.add_column(
            table,
            sa.Column("is_replaceable", sa.Boolean(), nullable=False, server_default=sa.true()),
        )

    op.create_table(
        "return_requests",
        sa.Column("id", BUSINESS_ID, primary_key=True),
        sa.Column("order_id", BUSINESS_ID, sa.ForeignKey("orders.id", ondelete="CASCADE"), nullable=False),
        sa.Column("customer_id", BUSINESS_ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("order_number", sa.String(30), nullable=False, server_default=""),
        sa.Column("customer_name", sa.String(160), nullable=False, server_default=""),
        sa.Column("kind", sa.String(12), nullable=False),
        sa.Column("status", sa.String(24), nullable=False, server_default="requested"),
        sa.Column("reason", sa.String(120), nullable=False),
        sa.Column("comment", sa.String(1000), nullable=False, server_default=""),
        sa.Column("resolution_note", sa.String(500), nullable=False, server_default=""),
        sa.Column("refund_id", sa.String(40), nullable=True),
        sa.Column("amount", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_return_requests_order_id", "return_requests", ["order_id"])
    op.create_index("ix_return_requests_customer_id", "return_requests", ["customer_id"])
    op.create_index("ix_return_requests_status", "return_requests", ["status"])

    op.create_table(
        "return_request_items",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("request_id", BUSINESS_ID, sa.ForeignKey("return_requests.id", ondelete="CASCADE"), nullable=False),
        sa.Column("order_item_id", sa.Integer(), sa.ForeignKey("order_items.id", ondelete="CASCADE"), nullable=False),
        sa.Column("product_id", BUSINESS_ID, nullable=False),
        sa.Column("name", sa.String(200), nullable=False, server_default=""),
        sa.Column("image", sa.String(500), nullable=False, server_default=""),
        sa.Column("size", sa.String(30), nullable=True),
        sa.Column("color", sa.String(60), nullable=True),
        sa.Column("quantity", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("amount", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_return_request_items_request_id", "return_request_items", ["request_id"])
    op.create_index("ix_return_request_items_order_item_id", "return_request_items", ["order_item_id"])

    op.create_table(
        "return_events",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("request_id", BUSINESS_ID, sa.ForeignKey("return_requests.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("note", sa.String(500), nullable=False, server_default=""),
        sa.Column("actor", sa.String(40), nullable=False, server_default="system"),
        sa.Column("occurred_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_return_events_request_id", "return_events", ["request_id"])


def downgrade() -> None:
    op.drop_table("return_events")
    op.drop_table("return_request_items")
    op.drop_table("return_requests")
    for table in ("order_items", "products"):
        op.drop_column(table, "is_replaceable")
        op.drop_column(table, "is_returnable")
