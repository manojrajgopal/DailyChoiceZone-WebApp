"""Order events record the whole transition (docs/order-fulfilment.md)

Every status change now says where the order came from, which part of the
system moved it, why, and which record it concerns:

- `order_events.from_status`: the status before the change ("" for the
  first event, and for every event written before this migration).
- `order_events.source`: admin | packing | shipment | payment | customer |
  system ("" for older events).
- `order_events.reason`: why, when the move needed one (a cancellation after
  picking started, a repack, a return to origin).
- `order_events.related_type` / `related_id`: the packing job or shipment the
  change came from.

Columns only, each with a server default, so existing rows stay as they are:
no row is rewritten or deleted. Safe to run again after an interruption,
because each column is added only if missing.

Revision ID: a7b8c9d0e1f2
Revises: f6a7b8c9d0e1
Create Date: 2026-10-09 09:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a7b8c9d0e1f2"
down_revision: Union[str, None] = "f6a7b8c9d0e1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMNS = [
    ("from_status", 20),
    ("source", 20),
    ("reason", 300),
    ("related_type", 20),
    ("related_id", 40),
]


def _columns() -> set:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns("order_events")}


def upgrade() -> None:
    present = _columns()
    for name, length in COLUMNS:
        if name not in present:
            op.add_column("order_events", sa.Column(name, sa.String(length), nullable=False, server_default=""))


def downgrade() -> None:
    # Only for a deliberate rollback by a person; startup only ever upgrades.
    present = _columns()
    for name, _length in reversed(COLUMNS):
        if name in present:
            op.drop_column("order_events", name)
