"""Outgoing email

`email_accounts` (the store's sending account, credentials encrypted),
`customer_email_preferences` (each customer's own on/off per email type) and
`email_log` (what was sent, or why it was not).

New tables only.

Revision ID: 7e3b9d1a4c52
Revises: 2a8f5e3c9b14
Create Date: 2026-09-30 12:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "7e3b9d1a4c52"
down_revision: Union[str, None] = "2a8f5e3c9b14"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "email_accounts",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("provider", sa.String(20), nullable=False),
        sa.Column("sender_email", sa.String(255), nullable=False),
        sa.Column("sender_name", sa.String(120), nullable=False, server_default=""),
        sa.Column("reply_to", sa.String(255), nullable=False, server_default=""),
        sa.Column("credentials", sa.Text(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("verified_at", sa.DateTime(), nullable=True),
        sa.Column("updated_by", sa.String(40), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_email_accounts_active", "email_accounts", ["active"])

    op.create_table(
        "customer_email_preferences",
        sa.Column("customer_id", sa.String(20), sa.ForeignKey("customers.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("email_type", sa.String(40), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )

    op.create_table(
        "email_log",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("email_type", sa.String(40), nullable=False),
        sa.Column("recipient", sa.String(255), nullable=False),
        sa.Column("subject", sa.String(255), nullable=False),
        sa.Column("status", sa.String(12), nullable=False),
        sa.Column("error", sa.String(500), nullable=False, server_default=""),
        sa.Column("reference", sa.String(40), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_email_log_email_type", "email_log", ["email_type"])
    op.create_index("ix_email_log_status", "email_log", ["status"])
    op.create_index("ix_email_log_created_at", "email_log", ["created_at"])


def downgrade() -> None:
    op.drop_table("email_log")
    op.drop_table("customer_email_preferences")
    op.drop_table("email_accounts")
