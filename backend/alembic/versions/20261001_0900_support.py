"""Customer support centre

Tickets and their conversation (messages, attachments, audit events, links,
feedback), the configuration that routes them (departments, roles, teams,
agents, the category tree, email templates, help articles, canned replies)
and customer notifications.

New tables, plus one **nullable** column on `notifications` (`admin_id`, the
administrator a tray item is meant for — NULL, as every existing row stays,
means everybody). Nothing existing is changed or removed.

The starting configuration is installed only where a table is still empty —
see `app/support_defaults.py`. It contains no people and no email addresses.

## Safe to run again after an interruption

MySQL commits each CREATE TABLE as it runs, so a run that failed part-way
(an early version of the defaults installer did) leaves its tables behind
without recording the revision, and a plain re-run would stop at "table
already exists". Each table, column and index here is therefore created only
if it is missing; the tables such a run left are the same ones, and empty.

Revision ID: 5c1e8a7d3f20
Revises: 7e3b9d1a4c52
Create Date: 2026-10-01 09:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "5c1e8a7d3f20"
down_revision: Union[str, None] = "7e3b9d1a4c52"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ID = sa.String(20)


def _exists(name: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(name)


def _create_table(name: str, *columns) -> None:
    """Create a table unless an interrupted earlier run already did."""
    if not _exists(name):
        op.create_table(name, *columns)


def upgrade() -> None:
    _create_table(
        "support_departments",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(80), nullable=False, unique=True),
        sa.Column("description", sa.String(255), nullable=False, server_default=""),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    _create_table(
        "support_roles",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(80), nullable=False, unique=True),
        sa.Column("description", sa.String(255), nullable=False, server_default=""),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    _create_table(
        "support_teams",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(80), nullable=False, unique=True),
        sa.Column("department_id", sa.Integer(), sa.ForeignKey("support_departments.id", ondelete="SET NULL"),
                  nullable=True, index=True),
        sa.Column("description", sa.String(255), nullable=False, server_default=""),
        sa.Column("notify_email", sa.String(255), nullable=False, server_default=""),
        sa.Column("assignment", sa.String(20), nullable=False, server_default="round-robin"),
        sa.Column("customer_selectable", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("last_assigned_agent_id", sa.Integer(), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    _create_table(
        "support_agents",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("admin_user_id", ID, sa.ForeignKey("admin_users.id", ondelete="SET NULL"),
                  nullable=True, unique=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("email", sa.String(255), nullable=False, unique=True),
        sa.Column("phone", sa.String(20), nullable=False, server_default=""),
        sa.Column("photo_url", sa.String(500), nullable=False, server_default=""),
        sa.Column("role_id", sa.Integer(), sa.ForeignKey("support_roles.id", ondelete="SET NULL"),
                  nullable=True, index=True),
        sa.Column("team_id", sa.Integer(), sa.ForeignKey("support_teams.id", ondelete="SET NULL"),
                  nullable=True, index=True),
        sa.Column("specialization", sa.String(160), nullable=False, server_default=""),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true(), index=True),
        sa.Column("available", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("is_lead", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("show_to_customers", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("notify_email", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("notify_portal", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    _create_table(
        "support_categories",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("parent_id", sa.Integer(), sa.ForeignKey("support_categories.id", ondelete="CASCADE"),
                  nullable=True, index=True),
        sa.Column("level", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("slug", sa.String(120), nullable=False),
        sa.Column("description", sa.String(255), nullable=False, server_default=""),
        sa.Column("icon", sa.String(40), nullable=False, server_default=""),
        sa.Column("contact_type", sa.String(20), nullable=False, server_default=""),
        sa.Column("form", sa.String(20), nullable=False, server_default=""),
        sa.Column("team_id", sa.Integer(), sa.ForeignKey("support_teams.id", ondelete="SET NULL"), nullable=True),
        sa.Column("priority", sa.String(10), nullable=False, server_default=""),
        sa.Column("sla_hours", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("customer_choice", sa.String(10), nullable=False, server_default=""),
        sa.Column("choice_team_ids", sa.JSON(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("parent_id", "slug", name="uq_support_category_slug"),
    )
    _create_table(
        "support_tickets",
        sa.Column("id", ID, primary_key=True),
        sa.Column("number", sa.String(30), nullable=False, unique=True, index=True),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("email", sa.String(255), nullable=False, index=True),
        sa.Column("phone", sa.String(20), nullable=False, server_default=""),
        sa.Column("access_key", sa.String(255), nullable=False, server_default=""),
        sa.Column("channel", sa.String(10), nullable=False, server_default="form"),
        sa.Column("contact_type", sa.String(20), nullable=False, server_default="support", index=True),
        sa.Column("category_id", sa.Integer(), sa.ForeignKey("support_categories.id", ondelete="SET NULL"),
                  nullable=True, index=True),
        sa.Column("subcategory_id", sa.Integer(), sa.ForeignKey("support_categories.id", ondelete="SET NULL"),
                  nullable=True, index=True),
        sa.Column("issue_id", sa.Integer(), sa.ForeignKey("support_categories.id", ondelete="SET NULL"),
                  nullable=True, index=True),
        sa.Column("category_label", sa.String(120), nullable=False, server_default=""),
        sa.Column("subcategory_label", sa.String(120), nullable=False, server_default=""),
        sa.Column("issue_label", sa.String(120), nullable=False, server_default=""),
        sa.Column("subject", sa.String(200), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("order_id", ID, sa.ForeignKey("orders.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("product_id", ID, sa.ForeignKey("products.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("membership_id", ID, sa.ForeignKey("customer_memberships.id", ondelete="SET NULL"), nullable=True),
        sa.Column("priority", sa.String(10), nullable=False, server_default="medium", index=True),
        sa.Column("team_id", sa.Integer(), sa.ForeignKey("support_teams.id", ondelete="SET NULL"),
                  nullable=True, index=True),
        sa.Column("agent_id", sa.Integer(), sa.ForeignKey("support_agents.id", ondelete="SET NULL"),
                  nullable=True, index=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="submitted", index=True),
        sa.Column("feature_stage", sa.String(20), nullable=False, server_default=""),
        sa.Column("response_due_at", sa.DateTime(), nullable=True),
        sa.Column("resolve_due_at", sa.DateTime(), nullable=True, index=True),
        sa.Column("first_response_at", sa.DateTime(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(), nullable=True),
        sa.Column("closed_at", sa.DateTime(), nullable=True),
        sa.Column("reopened_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("escalation_level", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("escalations_applied", sa.JSON(), nullable=False),
        sa.Column("sla_warned", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("sla_breached", sa.Boolean(), nullable=False, server_default=sa.false(), index=True),
        sa.Column("merged_into_id", ID, sa.ForeignKey("support_tickets.id", ondelete="SET NULL"), nullable=True),
        sa.Column("customer_unread", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("agent_unread", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("customer_typing_at", sa.DateTime(), nullable=True),
        sa.Column("agent_typing_at", sa.DateTime(), nullable=True),
        sa.Column("last_message_at", sa.DateTime(), nullable=True),
        sa.Column("last_message_preview", sa.String(200), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False, index=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False, index=True),
    )
    _create_table(
        "ticket_messages",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("ticket_id", ID, sa.ForeignKey("support_tickets.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("kind", sa.String(10), nullable=False),
        sa.Column("author_admin_id", sa.String(20), nullable=True),
        sa.Column("author_agent_id", sa.Integer(), nullable=True),
        sa.Column("author_name", sa.String(160), nullable=False, server_default=""),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("read_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    _create_table(
        "ticket_attachments",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("ticket_id", ID, sa.ForeignKey("support_tickets.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("message_id", sa.Integer(), sa.ForeignKey("ticket_messages.id", ondelete="SET NULL"),
                  nullable=True, index=True),
        sa.Column("file_name", sa.String(200), nullable=False),
        sa.Column("content_type", sa.String(100), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("storage_key", sa.String(300), nullable=False),
        sa.Column("internal", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("uploaded_by", sa.String(10), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    _create_table(
        "ticket_events",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("ticket_id", ID, sa.ForeignKey("support_tickets.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("kind", sa.String(30), nullable=False),
        sa.Column("from_value", sa.String(160), nullable=False, server_default=""),
        sa.Column("to_value", sa.String(160), nullable=False, server_default=""),
        sa.Column("note", sa.String(500), nullable=False, server_default=""),
        sa.Column("actor_kind", sa.String(10), nullable=False),
        sa.Column("actor_id", sa.String(20), nullable=False, server_default=""),
        sa.Column("actor_name", sa.String(160), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False, index=True),
    )
    _create_table(
        "ticket_links",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("ticket_id", ID, sa.ForeignKey("support_tickets.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("other_id", ID, sa.ForeignKey("support_tickets.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("kind", sa.String(10), nullable=False, server_default="related"),
        sa.Column("created_by", sa.String(160), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("ticket_id", "other_id", name="uq_ticket_link"),
    )
    _create_table(
        "ticket_feedback",
        sa.Column("ticket_id", ID, sa.ForeignKey("support_tickets.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("rating", sa.Integer(), nullable=False),
        sa.Column("comment", sa.String(1000), nullable=False, server_default=""),
        sa.Column("agent_id", sa.Integer(), nullable=True, index=True),
        sa.Column("customer_id", sa.String(20), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, index=True),
    )
    _create_table(
        "support_articles",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("slug", sa.String(200), nullable=False, unique=True),
        sa.Column("summary", sa.String(300), nullable=False, server_default=""),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("category_ids", sa.JSON(), nullable=False),
        sa.Column("keywords", sa.String(300), nullable=False, server_default=""),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("views", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("helpful", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("not_helpful", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    _create_table(
        "support_canned_responses",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("category_id", sa.Integer(), sa.ForeignKey("support_categories.id", ondelete="SET NULL"),
                  nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    _create_table(
        "support_email_templates",
        sa.Column("key", sa.String(40), primary_key=True),
        sa.Column("audience", sa.String(10), nullable=False),
        sa.Column("label", sa.String(120), nullable=False),
        sa.Column("subject", sa.String(200), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    _create_table(
        "customer_notifications",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("kind", sa.String(30), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("body", sa.String(500), nullable=False, server_default=""),
        sa.Column("href", sa.String(255), nullable=False, server_default=""),
        sa.Column("read", sa.Boolean(), nullable=False, server_default=sa.false(), index=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, index=True),
    )

    # Existing rows keep NULL: meant for every administrator, as before.
    inspector = sa.inspect(op.get_bind())
    if "admin_id" not in {c["name"] for c in inspector.get_columns("notifications")}:
        op.add_column("notifications", sa.Column("admin_id", sa.String(20), nullable=True))
    if "ix_notifications_admin_id" not in {i["name"] for i in inspector.get_indexes("notifications")}:
        op.create_index("ix_notifications_admin_id", "notifications", ["admin_id"])

    from app.support_defaults import install

    install(op.get_bind())


def downgrade() -> None:
    op.drop_index("ix_notifications_admin_id", table_name="notifications")
    op.drop_column("notifications", "admin_id")
    for name in (
        "customer_notifications", "support_email_templates", "support_canned_responses",
        "support_articles", "ticket_feedback", "ticket_links", "ticket_events",
        "ticket_attachments", "ticket_messages", "support_tickets", "support_categories",
        "support_agents", "support_teams", "support_roles", "support_departments",
    ):
        op.drop_table(name)
