"""Product status follows stock (one-off repair)

Editing a product used to save its status and stock as sent, so a restocked
product could stay `out-of-stock` (shown as buyable, refused at checkout) and
an emptied one could stay `active`. The services now keep the two in step;
this brings existing rows into line with the same rule:

- `out-of-stock` with stock left after reservations -> `active`
- `active` with nothing left after reservations -> `out-of-stock`

Drafts and archived products are not touched. Only `status` is rewritten;
nothing is deleted. Running it again changes nothing.

Revision ID: b8c9d0e1f2a3
Revises: a7b8c9d0e1f2
Create Date: 2026-10-09 10:00:00.000000
"""

from typing import Sequence, Union

from alembic import op

revision: str = "b8c9d0e1f2a3"
down_revision: Union[str, None] = "a7b8c9d0e1f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "UPDATE products SET status = 'active' "
        "WHERE status = 'out-of-stock' AND stock > reserved_stock"
    )
    op.execute(
        "UPDATE products SET status = 'out-of-stock' "
        "WHERE status = 'active' AND stock <= reserved_stock"
    )


def downgrade() -> None:
    # A repair, not a schema change: the old, inconsistent statuses aren't worth restoring.
    pass
