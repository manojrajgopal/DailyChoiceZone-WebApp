"""Flash sale notices: when a sale was announced, and when an item sold out

New nullable columns, so every existing row reads as it did:
`flash_sales.announced_at`, `flash_sale_items.sold_out_at`.

Revision ID: a1d3f5c7e9b2
Revises: 8b4c1e7f2a93
Create Date: 2026-10-04 12:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a1d3f5c7e9b2"
down_revision: Union[str, None] = "8b4c1e7f2a93"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _columns(table: str) -> set:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    if "announced_at" not in _columns("flash_sales"):
        op.add_column("flash_sales", sa.Column("announced_at", sa.DateTime, nullable=True))
    if "sold_out_at" not in _columns("flash_sale_items"):
        op.add_column("flash_sale_items", sa.Column("sold_out_at", sa.DateTime, nullable=True))


def downgrade() -> None:
    if "sold_out_at" in _columns("flash_sale_items"):
        op.drop_column("flash_sale_items", "sold_out_at")
    if "announced_at" in _columns("flash_sales"):
        op.drop_column("flash_sales", "announced_at")
