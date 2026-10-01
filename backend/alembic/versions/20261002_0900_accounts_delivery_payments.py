"""Account recovery, email verification, pincodes, abandoned carts, payment
reconciliation and webhook monitoring

New tables:

- `customer_tokens` — one-time links for email verification and password
  reset. Only a SHA-256 of each token is stored, never the token itself.
- `delivery_pincodes` — where the store delivers, managed in the portal.
- `cart_recoveries` — the life of each signed-in cart: active, abandoned,
  reminded, recovered.
- `webhook_event_attempts` — every processing attempt of a webhook event,
  including replays from the portal.
- `payment_reconciliations` and `payment_reconciliation_events` — what a
  comparison with the gateway found, and every review action on it.

New **nullable** columns (every existing row keeps NULL or the default):

- `customers.email_verified_at`, `customers.password_changed_at`
- `webhook_events`: status, attempts, duplicates, timings, error, related ids
  and a sanitised payload. Rows written before this keep status "processed" —
  that is what their existence meant until now.

Safe to run again after an interruption: every table, column and index is
created only if it is missing.

Revision ID: 3e7a9c1d5b24
Revises: 8b4d2f6a1c93
Create Date: 2026-10-02 09:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "3e7a9c1d5b24"
down_revision: Union[str, None] = "8b4d2f6a1c93"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ID = sa.String(20)
MONEY = sa.BigInteger()


def _inspector():
    return sa.inspect(op.get_bind())


def _has_table(name: str) -> bool:
    return _inspector().has_table(name)


def _columns(table: str) -> set:
    return {c["name"] for c in _inspector().get_columns(table)}


def _indexes(table: str) -> set:
    return {i["name"] for i in _inspector().get_indexes(table)}


def _add_column(table: str, column: sa.Column) -> None:
    if column.name not in _columns(table):
        op.add_column(table, column)


def _create_index(name: str, table: str, columns: list, unique: bool = False) -> None:
    if name not in _indexes(table):
        op.create_index(name, table, columns, unique=unique)


def _create_table(name: str, *columns) -> None:
    if not _has_table(name):
        op.create_table(name, *columns)


def upgrade() -> None:
    # --------------------------------------------------------- customers
    _add_column("customers", sa.Column("email_verified_at", sa.DateTime(), nullable=True))
    _add_column("customers", sa.Column("password_changed_at", sa.DateTime(), nullable=True))

    _create_table(
        "customer_tokens",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
        # email-verification | password-reset
        sa.Column("purpose", sa.String(30), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        # The address the link was issued for: changing it voids the link.
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("used_at", sa.DateTime(), nullable=True),
        # used | superseded | expired — why it stopped working, for support.
        sa.Column("revoked_reason", sa.String(20), nullable=False, server_default=""),
    )
    _create_index("ux_customer_tokens_hash", "customer_tokens", ["token_hash"], unique=True)
    _create_index("ix_customer_tokens_customer_purpose", "customer_tokens", ["customer_id", "purpose"])
    _create_index("ix_customer_tokens_expires", "customer_tokens", ["expires_at"])

    # --------------------------------------------------------- pincodes
    _create_table(
        "delivery_pincodes",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("pincode", sa.String(6), nullable=False),
        sa.Column("city", sa.String(120), nullable=False, server_default=""),
        sa.Column("district", sa.String(120), nullable=False, server_default=""),
        sa.Column("state", sa.String(120), nullable=False, server_default=""),
        sa.Column("serviceable", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("cod_available", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("express_available", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("min_days", sa.Integer(), nullable=True),
        sa.Column("max_days", sa.Integer(), nullable=True),
        # Minor units. NULL: the store's standard fee applies.
        sa.Column("delivery_fee", MONEY, nullable=True),
        # For a future courier integration: whose network covers it.
        sa.Column("courier", sa.String(60), nullable=False, server_default=""),
        sa.Column("notes", sa.String(255), nullable=False, server_default=""),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    _create_index("ux_delivery_pincodes_pincode", "delivery_pincodes", ["pincode"], unique=True)
    _create_index("ix_delivery_pincodes_state", "delivery_pincodes", ["state"])

    # --------------------------------------------------- abandoned carts
    _create_table(
        "cart_recoveries",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
        # active | abandoned | recovered | expired | converted
        sa.Column("status", sa.String(20), nullable=False, server_default="active"),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("last_activity_at", sa.DateTime(), nullable=False),
        sa.Column("abandoned_at", sa.DateTime(), nullable=True),
        sa.Column("item_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cart_value", MONEY, nullable=False, server_default="0"),
        sa.Column("items", sa.JSON(), nullable=True),
        sa.Column("reminders_sent", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_reminder_at", sa.DateTime(), nullable=True),
        sa.Column("token_hash", sa.String(64), nullable=True),
        sa.Column("clicked_at", sa.DateTime(), nullable=True),
        sa.Column("recovered_at", sa.DateTime(), nullable=True),
        sa.Column("recovered_order_id", ID, sa.ForeignKey("orders.id", ondelete="SET NULL"), nullable=True),
        sa.Column("recovered_value", MONEY, nullable=True),
        sa.Column("closed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    _create_index("ix_cart_recoveries_customer_status", "cart_recoveries", ["customer_id", "status"])
    _create_index("ix_cart_recoveries_status_activity", "cart_recoveries", ["status", "last_activity_at"])
    _create_index("ux_cart_recoveries_token", "cart_recoveries", ["token_hash"], unique=True)

    # ------------------------------------------------------- webhooks
    _add_column("webhook_events", sa.Column("status", sa.String(20), nullable=False, server_default="processed"))
    _add_column("webhook_events", sa.Column("attempts", sa.Integer(), nullable=False, server_default="1"))
    _add_column("webhook_events", sa.Column("duplicates", sa.Integer(), nullable=False, server_default="0"))
    _add_column("webhook_events", sa.Column("last_duplicate_at", sa.DateTime(), nullable=True))
    _add_column("webhook_events", sa.Column("started_at", sa.DateTime(), nullable=True))
    _add_column("webhook_events", sa.Column("completed_at", sa.DateTime(), nullable=True))
    _add_column("webhook_events", sa.Column("error", sa.String(500), nullable=False, server_default=""))
    _add_column("webhook_events", sa.Column("order_id", sa.String(40), nullable=True))
    _add_column("webhook_events", sa.Column("payment_id", sa.String(40), nullable=True))
    _add_column("webhook_events", sa.Column("gateway_payment_id", sa.String(60), nullable=True))
    _add_column("webhook_events", sa.Column("refund_id", sa.String(60), nullable=True))
    _add_column("webhook_events", sa.Column("payload", sa.JSON(), nullable=True))
    _create_index("ix_webhook_events_status_received", "webhook_events", ["status", "received_at"])
    _create_index("ix_webhook_events_event", "webhook_events", ["event"])
    _create_index("ix_webhook_events_gateway_payment", "webhook_events", ["gateway_payment_id"])

    _create_table(
        "webhook_event_attempts",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("event_id", sa.String(64), sa.ForeignKey("webhook_events.event_id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        # delivery | redelivery | replay
        sa.Column("trigger", sa.String(20), nullable=False),
        sa.Column("admin_id", sa.String(20), nullable=True),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        # processed | ignored | failed
        sa.Column("outcome", sa.String(20), nullable=False, server_default=""),
        sa.Column("result", sa.String(120), nullable=False, server_default=""),
        sa.Column("error", sa.String(500), nullable=False, server_default=""),
    )
    _create_index("ix_webhook_event_attempts_event", "webhook_event_attempts", ["event_id"])

    # ------------------------------------------------- reconciliation
    _create_table(
        "payment_reconciliations",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("payment_id", ID, sa.ForeignKey("payments.id", ondelete="SET NULL"), nullable=True),
        sa.Column("gateway_payment_id", sa.String(60), nullable=True),
        sa.Column("order_id", ID, sa.ForeignKey("orders.id", ondelete="SET NULL"), nullable=True),
        sa.Column("order_number", sa.String(30), nullable=False, server_default=""),
        # matched | mismatch | missing-locally | missing-externally | requires-review
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("issues", sa.JSON(), nullable=True),
        sa.Column("summary", sa.String(500), nullable=False, server_default=""),
        sa.Column("local", sa.JSON(), nullable=True),
        sa.Column("gateway", sa.JSON(), nullable=True),
        sa.Column("amount", MONEY, nullable=True),
        sa.Column("currency", sa.String(3), nullable=False, server_default="INR"),
        sa.Column("paid_at", sa.DateTime(), nullable=True),
        sa.Column("checked_at", sa.DateTime(), nullable=False),
        sa.Column("check_count", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("check_error", sa.String(300), nullable=False, server_default=""),
        # open | resolved
        sa.Column("resolution", sa.String(20), nullable=False, server_default="open"),
        sa.Column("resolved_by", sa.String(20), nullable=True),
        sa.Column("resolved_at", sa.DateTime(), nullable=True),
        sa.Column("resolution_note", sa.String(1000), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    _create_index("ux_payment_reconciliations_payment", "payment_reconciliations", ["payment_id"], unique=True)
    _create_index("ux_payment_reconciliations_gateway", "payment_reconciliations", ["gateway_payment_id"],
                  unique=True)
    _create_index("ix_payment_reconciliations_status", "payment_reconciliations", ["status", "resolution"])
    _create_index("ix_payment_reconciliations_checked", "payment_reconciliations", ["checked_at"])

    _create_table(
        "payment_reconciliation_events",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("reconciliation_id", sa.Integer(),
                  sa.ForeignKey("payment_reconciliations.id", ondelete="CASCADE"), nullable=False),
        # checked | status | resolved | reopened | note
        sa.Column("action", sa.String(20), nullable=False),
        sa.Column("from_value", sa.String(40), nullable=False, server_default=""),
        sa.Column("to_value", sa.String(40), nullable=False, server_default=""),
        sa.Column("note", sa.String(1000), nullable=False, server_default=""),
        sa.Column("admin_id", sa.String(20), nullable=True),
        sa.Column("admin_name", sa.String(120), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    _create_index("ix_payment_reconciliation_events_rec", "payment_reconciliation_events", ["reconciliation_id"])


def downgrade() -> None:
    for table in ("payment_reconciliation_events", "payment_reconciliations", "webhook_event_attempts",
                  "cart_recoveries", "delivery_pincodes", "customer_tokens"):
        if _has_table(table):
            op.drop_table(table)
    for index in ("ix_webhook_events_status_received", "ix_webhook_events_event",
                  "ix_webhook_events_gateway_payment"):
        if index in _indexes("webhook_events"):
            op.drop_index(index, table_name="webhook_events")
    for column in ("payload", "refund_id", "gateway_payment_id", "payment_id", "order_id", "error",
                   "completed_at", "started_at", "last_duplicate_at", "duplicates", "attempts", "status"):
        if column in _columns("webhook_events"):
            op.drop_column("webhook_events", column)
    for column in ("password_changed_at", "email_verified_at"):
        if column in _columns("customers"):
            op.drop_column("customers", column)
