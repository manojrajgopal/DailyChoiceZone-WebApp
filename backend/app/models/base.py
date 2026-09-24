"""Shared model pieces."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

# Business ids are `PRD001`-shaped: three letters plus digits. 20 characters
# leaves room to grow past six digits without a migration.
BusinessId = String(20)


class TimestampMixin:
    """
    `created_at` and `updated_at` on every table that has a lifecycle.

    Defaulted in the database rather than in Python, so a row inserted by a
    migration, a seed script or a direct SQL statement is stamped the same way
    as one inserted by the API.
    """

    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
