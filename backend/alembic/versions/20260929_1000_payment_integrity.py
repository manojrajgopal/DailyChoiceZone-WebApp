"""payment integrity

The columns a real payment gateway needs and a synchronous mock never did.

- ``orders.stock_state`` — whether an order *consumed* its stock or is only
  *holding* it while a payment is pending. Every existing order consumed stock
  at creation, which is exactly what the default says, so no existing row
  changes meaning.
- ``orders.payment_expires_at`` — when an unpaid order's hold runs out. Null
  for every existing order, and the expiry sweeper only ever looks at rows where
  it is set, so no order placed before this migration can be cancelled by it.
- ``payments.payment_link_id`` — a Razorpay Payment Link raised for an order,
  so the link's webhook can find the payment it belongs to.
- ``refunds.gateway_reference`` — Razorpay's own refund id. Refunds are
  asynchronous: the gateway answers ``pending`` and says ``processed`` or
  ``failed`` later, by webhook, and without the id there is nothing to match
  that webhook to.
- ``webhook_events`` — every delivery already processed, keyed by Razorpay's
  ``x-razorpay-event-id``. Razorpay documents duplicate deliveries as expected
  behaviour; this is what makes the second one a no-op.

**Additive only.** Nothing is dropped, nothing is rewritten, and ``downgrade``
removes only what this revision added.

Revision ID: 3f7c9a1e5d20
Revises: 8c41d2f5b907
Create Date: 2026-09-29 10:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "3f7c9a1e5d20"
down_revision: Union[str, None] = "8c41d2f5b907"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "orders",
        sa.Column(
            "stock_state",
            sa.String(length=12),
            nullable=False,
            # Every order that exists today consumed its stock when it was
            # placed. The server default says so for all of them at once.
            server_default="consumed",
        ),
    )
    op.add_column("orders", sa.Column("payment_expires_at", sa.DateTime(), nullable=True))
    op.create_index("ix_orders_payment_expiry", "orders", ["stock_state", "payment_expires_at"])

    op.add_column("payments", sa.Column("payment_link_id", sa.String(length=60), nullable=True))
    op.create_index("ix_payments_payment_link_id", "payments", ["payment_link_id"])

    op.add_column("refunds", sa.Column("gateway_reference", sa.String(length=60), nullable=True))
    op.create_index("ix_refunds_gateway_reference", "refunds", ["gateway_reference"])

    op.create_table(
        "webhook_events",
        sa.Column("event_id", sa.String(length=64), primary_key=True),
        sa.Column("event", sa.String(length=60), nullable=False),
        sa.Column("result", sa.String(length=60), nullable=False, server_default=""),
        sa.Column("received_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("webhook_events")

    op.drop_index("ix_refunds_gateway_reference", table_name="refunds")
    op.drop_column("refunds", "gateway_reference")

    op.drop_index("ix_payments_payment_link_id", table_name="payments")
    op.drop_column("payments", "payment_link_id")

    op.drop_index("ix_orders_payment_expiry", table_name="orders")
    op.drop_column("orders", "payment_expires_at")
    op.drop_column("orders", "stock_state")
