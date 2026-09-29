"""Photographs per colour

`product_images.color` ties an image to one of the product's colours, by the
colour's name. An empty value means the image stands for the product in every
colour — which is what every image stored so far is, so the column is added
with a server default of "" and no existing row changes meaning.

The index serves the one new lookup: a product's images for a given colour.

Additive only: nothing is dropped, renamed or rewritten.

Revision ID: 6b2e1d9c4a70
Revises: 3f7c9a1e5d20
Create Date: 2026-09-29 16:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "6b2e1d9c4a70"
down_revision: Union[str, None] = "3f7c9a1e5d20"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "product_images",
        sa.Column("color", sa.String(length=60), nullable=False, server_default=""),
    )
    op.create_index("ix_product_images_color", "product_images", ["product_id", "color"])


def downgrade() -> None:
    op.drop_index("ix_product_images_color", table_name="product_images")
    op.drop_column("product_images", "color")
