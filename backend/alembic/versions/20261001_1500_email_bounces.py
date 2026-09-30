"""Email bounces

Two **nullable** columns on `email_log`: `provider_id` (the id Gmail returned
for the sent message, used to match a bounce notice to it) and `bounced_at`
(when a bounce turned a "sent" email into "failed"). Existing rows keep NULL;
nothing is changed or removed.

Safe to run again: each column is added only if it is missing.

Revision ID: 8b4d2f6a1c93
Revises: 5c1e8a7d3f20
Create Date: 2026-10-01 15:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "8b4d2f6a1c93"
down_revision: Union[str, None] = "5c1e8a7d3f20"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _columns() -> set:
    return {column["name"] for column in sa.inspect(op.get_bind()).get_columns("email_log")}


def upgrade() -> None:
    existing = _columns()
    if "provider_id" not in existing:
        op.add_column("email_log", sa.Column("provider_id", sa.String(100), nullable=True))
    if "bounced_at" not in existing:
        op.add_column("email_log", sa.Column("bounced_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    existing = _columns()
    if "bounced_at" in existing:
        op.drop_column("email_log", "bounced_at")
    if "provider_id" in existing:
        op.drop_column("email_log", "provider_id")
