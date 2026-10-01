"""Multi-channel notifications, marketing campaigns, reorders and database backups

New tables:

- `notification_deliveries` — every message on every channel (email, SMS,
  WhatsApp, in-app), with an idempotency key, retries and provider references.
- `notification_templates` — the store's own wording for each event, per
  channel.
- `channel_preferences` — customers' consent per channel and category
  (marketing is opt-in).
- `marketing_campaigns`, `campaign_recipients` — campaigns and who each one
  went to, unique per campaign, customer and channel.
- `reorder_events` — customers putting a past order back in their bag.
- `database_backups` — every backup, its checksum and where it is kept.

New nullable columns on `email_log` so an email can be tied to its template
and its delivery record; existing rows read as they did.

Safe to run again after an interruption: every table, column and index is
created only if it is missing.

Revision ID: c4e6a8b0d2f1
Revises: a1d3f5c7e9b2
Create Date: 2026-10-05 09:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c4e6a8b0d2f1"
down_revision: Union[str, None] = "a1d3f5c7e9b2"
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
    _create_table(
        "marketing_campaigns",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("description", sa.String(500), nullable=False, server_default=""),
        sa.Column("kind", sa.String(30), nullable=False, server_default="promotional"),
        sa.Column("status", sa.String(12), nullable=False, server_default="draft"),
        sa.Column("channels", sa.JSON, nullable=False),
        sa.Column("audience", sa.JSON, nullable=False),
        sa.Column("content", sa.JSON, nullable=False),
        sa.Column("coupon_code", sa.String(40), nullable=False, server_default=""),
        sa.Column("starts_at", sa.DateTime, nullable=True),
        sa.Column("ends_at", sa.DateTime, nullable=True),
        sa.Column("scheduled_at", sa.DateTime, nullable=True),
        sa.Column("launch_key", sa.String(64), nullable=True),
        sa.Column("launched_at", sa.DateTime, nullable=True),
        sa.Column("launched_by", ID, nullable=True),
        sa.Column("completed_at", sa.DateTime, nullable=True),
        sa.Column("content_updated_at", sa.DateTime, nullable=True),
        sa.Column("tested_at", sa.DateTime, nullable=True),
        sa.Column("recipients_total", sa.Integer, nullable=False, server_default="0"),
        sa.Column("last_error", sa.String(500), nullable=False, server_default=""),
        sa.Column("created_by", ID, nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("updated_at", sa.DateTime, nullable=False),
        sa.UniqueConstraint("launch_key", name="uq_marketing_campaigns_launch_key"),
    )
    _create_index("ix_marketing_campaigns_due", "marketing_campaigns", ["status", "scheduled_at"])

    _create_table(
        "notification_deliveries",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("idempotency_key", sa.String(160), nullable=False),
        sa.Column("event", sa.String(60), nullable=False),
        sa.Column("channel", sa.String(12), nullable=False),
        sa.Column("category", sa.String(15), nullable=False, server_default="transactional"),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="SET NULL"), nullable=True),
        sa.Column("recipient", sa.String(255), nullable=False, server_default=""),
        sa.Column("template_key", sa.String(60), nullable=False, server_default=""),
        sa.Column("provider", sa.String(30), nullable=False, server_default=""),
        sa.Column("status", sa.String(12), nullable=False, server_default="queued"),
        sa.Column("payload", sa.JSON, nullable=True),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("max_attempts", sa.Integer, nullable=False, server_default="5"),
        sa.Column("next_attempt_at", sa.DateTime, nullable=True),
        sa.Column("last_error", sa.String(500), nullable=False, server_default=""),
        sa.Column("provider_message_id", sa.String(120), nullable=True),
        sa.Column("campaign_id", sa.Integer, sa.ForeignKey("marketing_campaigns.id", ondelete="SET NULL"), nullable=True),
        sa.Column("reference", sa.String(60), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("sent_at", sa.DateTime, nullable=True),
        sa.Column("delivered_at", sa.DateTime, nullable=True),
        sa.Column("failed_at", sa.DateTime, nullable=True),
        sa.Column("updated_at", sa.DateTime, nullable=False),
        sa.UniqueConstraint("idempotency_key", name="uq_notification_deliveries_key"),
    )
    for name, columns in (
        ("ix_notification_deliveries_due", ["status", "next_attempt_at"]),
        ("ix_notification_deliveries_created", ["created_at"]),
        ("ix_notification_deliveries_customer", ["customer_id", "created_at"]),
        ("ix_notification_deliveries_event", ["event", "created_at"]),
        ("ix_notification_deliveries_provider_ref", ["provider_message_id"]),
        ("ix_notification_deliveries_campaign_id", ["campaign_id"]),
    ):
        _create_index(name, "notification_deliveries", columns)

    _create_table(
        "notification_templates",
        sa.Column("key", sa.String(60), primary_key=True),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default="1"),
        sa.Column("email_subject", sa.String(255), nullable=False, server_default=""),
        sa.Column("email_heading", sa.String(200), nullable=False, server_default=""),
        sa.Column("email_body", sa.Text, nullable=False),
        sa.Column("email_cta_label", sa.String(60), nullable=False, server_default=""),
        sa.Column("sms_text", sa.String(500), nullable=False, server_default=""),
        sa.Column("whatsapp_template", sa.String(120), nullable=False, server_default=""),
        sa.Column("whatsapp_language", sa.String(12), nullable=False, server_default="en"),
        sa.Column("whatsapp_variables", sa.JSON, nullable=False),
        sa.Column("in_app_title", sa.String(200), nullable=False, server_default=""),
        sa.Column("in_app_body", sa.String(500), nullable=False, server_default=""),
        sa.Column("updated_by", sa.String(120), nullable=False, server_default=""),
        sa.Column("updated_at", sa.DateTime, nullable=False),
    )

    _create_table(
        "channel_preferences",
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("channel", sa.String(12), primary_key=True),
        sa.Column("category", sa.String(15), primary_key=True),
        sa.Column("enabled", sa.Boolean, nullable=False),
        sa.Column("source", sa.String(20), nullable=False, server_default="account"),
        sa.Column("updated_at", sa.DateTime, nullable=False),
    )

    _create_table(
        "campaign_recipients",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("campaign_id", sa.Integer, sa.ForeignKey("marketing_campaigns.id", ondelete="CASCADE"), nullable=False),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("channel", sa.String(12), nullable=False),
        sa.Column("status", sa.String(12), nullable=False, server_default="queued"),
        sa.Column("token", sa.String(32), nullable=False),
        sa.Column("delivery_id", sa.BigInteger, nullable=True),
        sa.Column("opened_at", sa.DateTime, nullable=True),
        sa.Column("clicked_at", sa.DateTime, nullable=True),
        sa.Column("unsubscribed_at", sa.DateTime, nullable=True),
        sa.Column("replied_at", sa.DateTime, nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.UniqueConstraint("campaign_id", "customer_id", "channel", name="uq_campaign_recipient"),
        sa.UniqueConstraint("token", name="uq_campaign_recipients_token"),
    )
    _create_index("ix_campaign_recipients_status", "campaign_recipients", ["campaign_id", "status"])
    _create_index("ix_campaign_recipients_customer_id", "campaign_recipients", ["customer_id"])
    _create_index("ix_campaign_recipients_delivery_id", "campaign_recipients", ["delivery_id"])

    _create_table(
        "reorder_events",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("order_id", ID, sa.ForeignKey("orders.id", ondelete="CASCADE"), nullable=False),
        sa.Column("items_requested", sa.Integer, nullable=False, server_default="0"),
        sa.Column("items_added", sa.Integer, nullable=False, server_default="0"),
        sa.Column("items", sa.JSON, nullable=False),
        sa.Column("created_at", sa.DateTime, nullable=False),
    )
    _create_index("ix_reorder_events_customer", "reorder_events", ["customer_id", "created_at"])
    _create_index("ix_reorder_events_order_id", "reorder_events", ["order_id"])
    _create_index("ix_reorder_events_created_at", "reorder_events", ["created_at"])

    _create_table(
        "database_backups",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("reference", sa.String(40), nullable=False),
        sa.Column("trigger", sa.String(12), nullable=False, server_default="scheduled"),
        sa.Column("tier", sa.String(10), nullable=False, server_default="daily"),
        sa.Column("status", sa.String(12), nullable=False, server_default="running"),
        sa.Column("database_name", sa.String(120), nullable=False, server_default=""),
        sa.Column("storage", sa.String(10), nullable=False, server_default="local"),
        sa.Column("location", sa.String(500), nullable=False, server_default=""),
        sa.Column("size_bytes", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("checksum_sha256", sa.String(64), nullable=False, server_default=""),
        sa.Column("encrypted", sa.Boolean, nullable=False, server_default="0"),
        sa.Column("tables", sa.Integer, nullable=False, server_default="0"),
        sa.Column("rows", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("verified_at", sa.DateTime, nullable=True),
        sa.Column("error", sa.String(1000), nullable=False, server_default=""),
        sa.Column("started_at", sa.DateTime, nullable=False),
        sa.Column("completed_at", sa.DateTime, nullable=True),
        sa.Column("deleted_at", sa.DateTime, nullable=True),
        sa.Column("created_by", ID, nullable=True),
        sa.UniqueConstraint("reference", name="uq_database_backups_reference"),
    )
    _create_index("ix_database_backups_status", "database_backups", ["status", "started_at"])

    _add_column("email_log", sa.Column("template_key", sa.String(60), nullable=False, server_default=""))
    _add_column("email_log", sa.Column("delivery_id", sa.BigInteger, nullable=True))
    _create_index("ix_email_log_delivery_id", "email_log", ["delivery_id"])


def downgrade() -> None:
    if "ix_email_log_delivery_id" in _indexes("email_log"):
        op.drop_index("ix_email_log_delivery_id", table_name="email_log")
    for name in ("template_key", "delivery_id"):
        if name in _columns("email_log"):
            op.drop_column("email_log", name)
    for name in ("database_backups", "reorder_events", "campaign_recipients", "channel_preferences",
                 "notification_templates", "notification_deliveries", "marketing_campaigns"):
        if _has_table(name):
            op.drop_table(name)
