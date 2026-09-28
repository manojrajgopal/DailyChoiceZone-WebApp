"""Reading dates that arrive as text."""

from __future__ import annotations

from datetime import datetime
from typing import Optional


def parse_dt(value: Optional[str]) -> Optional[datetime]:
    """
    ISO-8601 to a naive UTC datetime, or None if it is not a date.

    Naive because MySQL's DATETIME has no zone: storing an aware value has the
    driver silently drop the offset, which is how a timestamp ends up five and
    a half hours out. Everything is UTC by convention.

    Accepts a plain `2026-09-28` as well as a full timestamp, because a date
    input sends the former and a coupon's window is set from one.
    """
    if not value:
        return None

    text = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        try:
            parsed = datetime.fromisoformat(f"{text}T00:00:00")
        except ValueError:
            return None

    return (
        parsed.replace(tzinfo=None)
        if parsed.tzinfo is None
        else parsed.astimezone().replace(tzinfo=None)
    )
