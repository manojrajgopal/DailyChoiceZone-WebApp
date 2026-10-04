"""Indexes for exact ID filters (docs/id-lookup.md)

List screens filter by ID with equality (`filters.id_condition`). These
columns are compared that way but had no index, so each filter read the whole
table:

- `notification_deliveries.reference`: the message log's reference box.
- `email_log.reference`: the email history's order or request number.
- `referrals.code`: the referrals list's code box.
- `payment_reconciliations.order_number`: the reconciliation list's order box.
- `webhook_events.order_id`, `.payment_id`, `.refund_id`: the webhook log's
  ID boxes. `gateway_payment_id` already has one.
- `purchase_orders.supplier_reference`: the purchase order list's
  supplier-reference box.

Indexes only: no column, row or constraint changes. Safe to run again after an
interruption, because each index is created only if missing.

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-10-08 14:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f6a7b8c9d0e1"
down_revision: Union[str, None] = "e5f6a7b8c9d0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

INDEXES = [
    ("ix_notification_deliveries_reference", "notification_deliveries", ["reference"]),
    ("ix_email_log_reference", "email_log", ["reference"]),
    ("ix_referrals_code", "referrals", ["code"]),
    ("ix_payment_reconciliations_order_number", "payment_reconciliations", ["order_number"]),
    ("ix_webhook_events_order_id", "webhook_events", ["order_id"]),
    ("ix_webhook_events_payment_id", "webhook_events", ["payment_id"]),
    ("ix_webhook_events_refund_id", "webhook_events", ["refund_id"]),
    ("ix_purchase_orders_supplier_reference", "purchase_orders", ["supplier_reference"]),
]


def _indexes(table: str) -> set:
    inspector = sa.inspect(op.get_bind())
    return {i["name"] for i in inspector.get_indexes(table)}


def upgrade() -> None:
    for name, table, columns in INDEXES:
        if name not in _indexes(table):
            op.create_index(name, table, columns)


def downgrade() -> None:
    # Only for a deliberate rollback by a person; startup only ever upgrades.
    for name, table, _columns in reversed(INDEXES):
        if name in _indexes(table):
            op.drop_index(name, table_name=table)
