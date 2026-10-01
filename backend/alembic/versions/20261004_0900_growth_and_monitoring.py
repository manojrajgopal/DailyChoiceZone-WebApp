"""Referrals, flash sales, bundles, analytics events, audit logs and health
monitoring

New tables:

- `referral_codes`, `referrals` — each customer's code, and each referred
  customer with the state of their rewards.
- `flash_sales`, `flash_sale_items`, `flash_sale_claims` — timed sale prices,
  and the units sold at them, tied to orders.
- `bundles`, `bundle_items`, `cart_bundles` — bundles made of existing
  products, and bundles in a customer's bag.
- `analytics_events` — visits, product views, bag additions and checkout
  starts, for the conversion funnel.
- `audit_logs` — who did what in the portal. Append-only.
- `job_heartbeats`, `health_snapshots` — background-job runs, and the history
  of health checks.

New columns, defaulting so every existing row reads as it did: flash-sale and
bundle details on `order_items`; bundle details on `invoice_items`.

Safe to run again after an interruption: every table, column and index is
created only if it is missing.

Revision ID: 8b4c1e7f2a93
Revises: 6d2f8b3e9a71
Create Date: 2026-10-04 09:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "8b4c1e7f2a93"
down_revision: Union[str, None] = "6d2f8b3e9a71"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ID = sa.String(20)


def _inspector():
    return sa.inspect(op.get_bind())


def _has_table(name: str) -> bool:
    return _inspector().has_table(name)


def _columns(table: str) -> set:
    return {c["name"] for c in _inspector().get_columns(table)}


def _indexes(table: str) -> set:
    inspector = _inspector()
    names = {i["name"] for i in inspector.get_indexes(table)}
    names |= {u["name"] for u in inspector.get_unique_constraints(table)}
    return names


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
    # ------------------------------------------------------------ referrals
    _create_table(
        "referral_codes",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("code", sa.String(16), nullable=False),
        sa.Column("disabled", sa.Boolean, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.UniqueConstraint("customer_id", name="uq_referral_codes_customer"),
        sa.UniqueConstraint("code", name="uq_referral_codes_code"),
    )
    _create_table(
        "referrals",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("referrer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("referee_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("code", sa.String(16), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("flags", sa.JSON, nullable=False),
        sa.Column("signup_ip_hash", sa.String(64), nullable=False, server_default=""),
        sa.Column("qualifying_order_id", ID, sa.ForeignKey("orders.id", ondelete="SET NULL"), nullable=True),
        sa.Column("reward_type", sa.String(20), nullable=False, server_default="store_credit"),
        sa.Column("referrer_reward", sa.Integer, nullable=False, server_default="0"),
        sa.Column("referee_reward", sa.Integer, nullable=False, server_default="0"),
        sa.Column("reversal_shortfall", sa.Integer, nullable=False, server_default="0"),
        sa.Column("note", sa.String(300), nullable=False, server_default=""),
        sa.Column("decided_by", ID, nullable=True),
        sa.Column("expires_at", sa.DateTime, nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("qualified_at", sa.DateTime, nullable=True),
        sa.Column("rewarded_at", sa.DateTime, nullable=True),
        sa.Column("reversed_at", sa.DateTime, nullable=True),
        sa.Column("updated_at", sa.DateTime, nullable=False),
        sa.UniqueConstraint("referee_id", name="uq_referrals_referee"),
    )
    _create_index("ix_referrals_referrer_status", "referrals", ["referrer_id", "status"])
    _create_index("ix_referrals_status_created", "referrals", ["status", "created_at"])
    _create_index("ix_referrals_qualifying_order_id", "referrals", ["qualifying_order_id"])

    # ---------------------------------------------------------- flash sales
    _create_table(
        "flash_sales",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("description", sa.String(500), nullable=False, server_default=""),
        sa.Column("status", sa.String(20), nullable=False, server_default="draft"),
        sa.Column("starts_at", sa.DateTime, nullable=False),
        sa.Column("ends_at", sa.DateTime, nullable=False),
        sa.Column("allow_coupons", sa.Boolean, nullable=False, server_default="0"),
        sa.Column("created_by", ID, nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("updated_at", sa.DateTime, nullable=False),
    )
    _create_index("ix_flash_sales_window", "flash_sales", ["status", "starts_at", "ends_at"])
    _create_table(
        "flash_sale_items",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("sale_id", sa.Integer, sa.ForeignKey("flash_sales.id", ondelete="CASCADE"), nullable=False),
        sa.Column("product_id", ID, sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
        sa.Column("sale_price", sa.Numeric(12, 2), nullable=False),
        sa.Column("stock_limit", sa.Integer, nullable=True),
        sa.Column("per_customer_limit", sa.Integer, nullable=True),
        sa.Column("position", sa.Integer, nullable=False, server_default="0"),
        sa.UniqueConstraint("sale_id", "product_id", name="uq_flash_sale_product"),
    )
    _create_index("ix_flash_sale_items_product", "flash_sale_items", ["product_id"])
    _create_table(
        "flash_sale_claims",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("sale_id", sa.Integer, sa.ForeignKey("flash_sales.id", ondelete="CASCADE"), nullable=False),
        sa.Column("item_id", sa.Integer, sa.ForeignKey("flash_sale_items.id", ondelete="CASCADE"), nullable=False),
        sa.Column("product_id", ID, nullable=False),
        sa.Column("order_id", ID, sa.ForeignKey("orders.id", ondelete="CASCADE"), nullable=False),
        sa.Column("customer_id", ID, nullable=False),
        sa.Column("quantity", sa.Integer, nullable=False),
        sa.Column("unit_price", sa.Integer, nullable=False),
        sa.Column("regular_price", sa.Integer, nullable=False),
        sa.Column("state", sa.String(20), nullable=False, server_default="reserved"),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("updated_at", sa.DateTime, nullable=False),
        sa.UniqueConstraint("order_id", "item_id", name="uq_flash_claim_order_item"),
    )
    _create_index("ix_flash_sale_claims_sale_id", "flash_sale_claims", ["sale_id"])
    _create_index("ix_flash_claims_item_state", "flash_sale_claims", ["item_id", "state"])
    _create_index("ix_flash_claims_customer_item", "flash_sale_claims", ["customer_id", "item_id"])

    # -------------------------------------------------------------- bundles
    _create_table(
        "bundles",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("slug", sa.String(160), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text, nullable=False),
        sa.Column("image", sa.String(500), nullable=False, server_default=""),
        sa.Column("pricing", sa.String(10), nullable=False, server_default="fixed"),
        sa.Column("price", sa.Numeric(12, 2), nullable=True),
        sa.Column("discount_percent", sa.Numeric(5, 2), nullable=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="draft"),
        sa.Column("starts_at", sa.DateTime, nullable=True),
        sa.Column("ends_at", sa.DateTime, nullable=True),
        sa.Column("max_per_order", sa.Integer, nullable=False, server_default="5"),
        sa.Column("created_by", ID, nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("updated_at", sa.DateTime, nullable=False),
        sa.UniqueConstraint("slug", name="uq_bundles_slug"),
    )
    _create_index("ix_bundles_status", "bundles", ["status"])
    _create_table(
        "bundle_items",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("bundle_id", sa.Integer, sa.ForeignKey("bundles.id", ondelete="CASCADE"), nullable=False),
        sa.Column("product_id", ID, sa.ForeignKey("products.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("quantity", sa.Integer, nullable=False, server_default="1"),
        sa.Column("position", sa.Integer, nullable=False, server_default="0"),
        sa.UniqueConstraint("bundle_id", "product_id", name="uq_bundle_product"),
    )
    _create_index("ix_bundle_items_product_id", "bundle_items", ["product_id"])
    _create_table(
        "cart_bundles",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("bundle_id", sa.Integer, sa.ForeignKey("bundles.id", ondelete="CASCADE"), nullable=False),
        sa.Column("quantity", sa.Integer, nullable=False, server_default="1"),
        sa.Column("selections", sa.JSON, nullable=False),
        sa.Column("selection_key", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("updated_at", sa.DateTime, nullable=False),
        sa.UniqueConstraint("customer_id", "bundle_id", "selection_key", name="uq_cart_bundle_selection"),
    )
    _create_index("ix_cart_bundles_customer_id", "cart_bundles", ["customer_id"])

    # ------------------------------------------------- order and invoice lines
    _add_column("order_items", sa.Column("regular_unit_price", sa.Numeric(12, 2), nullable=True))
    _add_column("order_items", sa.Column("flash_sale_id", sa.Integer, nullable=True))
    _add_column("order_items", sa.Column("bundle_id", sa.Integer, nullable=True))
    _add_column("order_items", sa.Column("bundle_name", sa.String(200), nullable=False, server_default=""))
    _add_column("order_items", sa.Column("bundle_group", sa.String(40), nullable=False, server_default=""))
    _add_column("order_items", sa.Column("bundle_quantity", sa.Integer, nullable=False, server_default="0"))
    _create_index("ix_order_items_flash_sale_id", "order_items", ["flash_sale_id"])
    _create_index("ix_order_items_bundle_id", "order_items", ["bundle_id"])
    _add_column("invoice_items", sa.Column("bundle_name", sa.String(200), nullable=False, server_default=""))
    _add_column("invoice_items", sa.Column("bundle_group", sa.String(40), nullable=False, server_default=""))
    _add_column("invoice_items", sa.Column("bundle_quantity", sa.Integer, nullable=False, server_default="0"))

    # ------------------------------------------------------------ analytics
    _create_table(
        "analytics_events",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("occurred_at", sa.DateTime, nullable=False),
        sa.Column("event", sa.String(30), nullable=False),
        sa.Column("visitor_id", sa.String(64), nullable=False, server_default=""),
        sa.Column("customer_id", ID, nullable=True),
        sa.Column("product_id", ID, nullable=True),
        sa.Column("quantity", sa.Integer, nullable=False, server_default="0"),
        sa.Column("source", sa.String(60), nullable=False, server_default=""),
        sa.Column("device", sa.String(10), nullable=False, server_default=""),
    )
    _create_index("ix_analytics_events_kind_time", "analytics_events", ["event", "occurred_at"])
    _create_index("ix_analytics_events_product", "analytics_events", ["product_id", "event", "occurred_at"])
    _create_index("ix_analytics_events_visitor", "analytics_events", ["visitor_id", "event", "occurred_at"])
    _create_index("ix_analytics_events_customer_id", "analytics_events", ["customer_id"])

    # ---------------------------------------------------------------- audit
    _create_table(
        "audit_logs",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("occurred_at", sa.DateTime, nullable=False),
        sa.Column("actor_type", sa.String(20), nullable=False, server_default="admin"),
        sa.Column("actor_id", ID, nullable=True),
        sa.Column("actor_name", sa.String(120), nullable=False, server_default=""),
        sa.Column("actor_email", sa.String(255), nullable=False, server_default=""),
        sa.Column("actor_role", sa.String(40), nullable=False, server_default=""),
        sa.Column("action", sa.String(80), nullable=False),
        sa.Column("resource_type", sa.String(40), nullable=False, server_default=""),
        sa.Column("resource_id", sa.String(80), nullable=False, server_default=""),
        sa.Column("summary", sa.String(300), nullable=False, server_default=""),
        sa.Column("outcome", sa.String(20), nullable=False, server_default="success"),
        sa.Column("status_code", sa.Integer, nullable=True),
        sa.Column("error_code", sa.String(60), nullable=False, server_default=""),
        sa.Column("changes", sa.JSON, nullable=True),
        sa.Column("details", sa.JSON, nullable=True),
        sa.Column("ip_address", sa.String(64), nullable=False, server_default=""),
        sa.Column("user_agent", sa.String(300), nullable=False, server_default=""),
        sa.Column("request_id", sa.String(40), nullable=False, server_default=""),
    )
    _create_index("ix_audit_logs_occurred", "audit_logs", ["occurred_at"])
    _create_index("ix_audit_logs_actor", "audit_logs", ["actor_id", "occurred_at"])
    _create_index("ix_audit_logs_resource", "audit_logs", ["resource_type", "resource_id"])
    _create_index("ix_audit_logs_action", "audit_logs", ["action", "occurred_at"])
    _create_index("ix_audit_logs_request_id", "audit_logs", ["request_id"])

    # --------------------------------------------------------------- health
    _create_table(
        "job_heartbeats",
        sa.Column("name", sa.String(60), primary_key=True),
        sa.Column("interval_seconds", sa.Integer, nullable=False, server_default="60"),
        sa.Column("last_started_at", sa.DateTime, nullable=True),
        sa.Column("last_finished_at", sa.DateTime, nullable=True),
        sa.Column("last_success_at", sa.DateTime, nullable=True),
        sa.Column("last_error", sa.String(500), nullable=False, server_default=""),
        sa.Column("last_error_at", sa.DateTime, nullable=True),
        sa.Column("last_duration_ms", sa.Integer, nullable=False, server_default="0"),
        sa.Column("runs", sa.Integer, nullable=False, server_default="0"),
        sa.Column("failures", sa.Integer, nullable=False, server_default="0"),
        sa.Column("consecutive_failures", sa.Integer, nullable=False, server_default="0"),
    )
    _create_table(
        "health_snapshots",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("checked_at", sa.DateTime, nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("checks", sa.JSON, nullable=False),
        sa.Column("duration_ms", sa.Integer, nullable=False, server_default="0"),
    )
    _create_index("ix_health_snapshots_checked_at", "health_snapshots", ["checked_at"])


def downgrade() -> None:
    for table, names in (
        ("invoice_items", ("bundle_name", "bundle_group", "bundle_quantity")),
        ("order_items", ("regular_unit_price", "flash_sale_id", "bundle_id", "bundle_name", "bundle_group",
                         "bundle_quantity")),
    ):
        for index in ("ix_order_items_flash_sale_id", "ix_order_items_bundle_id"):
            if table == "order_items" and index in _indexes(table):
                op.drop_index(index, table_name=table)
        for name in names:
            if name in _columns(table):
                op.drop_column(table, name)
    for name in (
        "health_snapshots", "job_heartbeats", "audit_logs", "analytics_events",
        "cart_bundles", "bundle_items", "bundles",
        "flash_sale_claims", "flash_sale_items", "flash_sales",
        "referrals", "referral_codes",
    ):
        if _has_table(name):
            op.drop_table(name)
