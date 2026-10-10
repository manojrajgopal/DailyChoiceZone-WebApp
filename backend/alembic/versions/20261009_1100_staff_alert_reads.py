"""Staff alerts: read per administrator, and who may see each one

- `notifications.permission`: the permission an administrator's role must
  cover to see the item in the tray. NULL (every existing row) is everyone.
- `notification_reads`: one row per administrator per item they've read, so
  one admin reading an alert no longer marks it read for the whole team.
  Items already marked read stay read for everyone (`notifications.read`).

Additive only. Safe to run again: each change is made only if missing.

Revision ID: c9d0e1f2a3b4
Revises: b8c9d0e1f2a3
Create Date: 2026-10-09 11:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c9d0e1f2a3b4"
down_revision: Union[str, None] = "b8c9d0e1f2a3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {c["name"] for c in inspector.get_columns("notifications")}
    if "permission" not in columns:
        op.add_column("notifications", sa.Column("permission", sa.String(40), nullable=True))
    if "notification_reads" not in inspector.get_table_names():
        op.create_table(
            "notification_reads",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("notification_id", sa.String(40),
                      sa.ForeignKey("notifications.id", ondelete="CASCADE"), nullable=False),
            sa.Column("admin_id", sa.String(20), nullable=False),
            sa.Column("read_at", sa.DateTime(), nullable=False),
            sa.UniqueConstraint("notification_id", "admin_id", name="uq_notification_read"),
        )
        op.create_index("ix_notification_reads_notification_id", "notification_reads", ["notification_id"])
        op.create_index("ix_notification_reads_admin_id", "notification_reads", ["admin_id"])


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "notification_reads" in inspector.get_table_names():
        op.drop_table("notification_reads")
    if "permission" in {c["name"] for c in inspector.get_columns("notifications")}:
        op.drop_column("notifications", "permission")
