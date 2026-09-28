"""configuration baseline

Put a first version of each configuration document in the database, so a fresh
installation has a working store: a currency to print prices in, a tax
treatment, a menu, and the lists the two applications render.

**Insert-if-absent, never update.** A store that has already been configured
keeps every value it has — this migration is for the rows that do not exist
yet. Running it against a live database changes nothing.

Revision ID: 8c41d2f5b907
Revises: 49a8ba39a143
Create Date: 2026-09-28 10:00:00.000000
"""

from datetime import datetime
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.config_defaults import initial_documents

revision: str = "8c41d2f5b907"
down_revision: Union[str, None] = "49a8ba39a143"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Described here rather than imported from the model, so the migration keeps
# working if the model later gains or loses a column.
documents = sa.table(
    "setting_documents",
    sa.column("key", sa.String),
    sa.column("value", sa.JSON),
    sa.column("created_at", sa.DateTime),
    sa.column("updated_at", sa.DateTime),
)


def upgrade() -> None:
    connection = op.get_bind()

    existing = {
        row[0] for row in connection.execute(sa.select(documents.c.key))
    }

    now = datetime.utcnow()
    rows = [
        {"key": key, "value": value, "created_at": now, "updated_at": now}
        for key, value in initial_documents().items()
        if key not in existing
    ]

    if rows:
        connection.execute(documents.insert(), rows)


def downgrade() -> None:
    """
    Deliberately empty.

    Removing a store's configuration would leave it unable to price anything,
    and the rows may have been edited since it was installed. There is nothing
    safe to undo.
    """
