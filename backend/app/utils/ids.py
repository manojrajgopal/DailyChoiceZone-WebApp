"""Human-readable business identifiers."""

from __future__ import annotations

import re
from typing import Optional

from sqlalchemy import Integer, func, select
from sqlalchemy.orm import Session

# One prefix per business entity. Kept together so a new entity cannot
# accidentally reuse a prefix that already means something else.
PREFIXES = {
    "product": "PRD",
    "category": "CAT",
    "collection": "COL",
    "customer": "CUS",
    "order": "ORD",
    "invoice": "INV",
    "payment": "PAY",
    "refund": "RFN",
    "credit_note": "CRN",
    "coupon": "CPN",
    "review": "REV",
    "banner": "BNR",
    "admin_user": "ADM",
    "address": "ADR",
    "section": "SEC",
}

_PATTERN = re.compile(r"^([A-Z]{3})(\d+)$")

# Three digits covers a demo catalogue and grows past it without a format
# change — PRD1000 simply follows PRD999.
_WIDTH = 3


def build_id_for(prefix: str, number: int) -> str:
    """
    The one place an id's text is decided.

    The seeder and `next_id` both go through here. When they did not, the seed
    numbered invoices to four digits and `next_id` to three, the two series
    interleaved, and the first order placed after a seed collided with a
    seeded invoice.
    """
    return f"{prefix}{number:0{_WIDTH}d}"


def build_id(entity: str, number: int) -> str:
    return build_id_for(PREFIXES[entity], number)


def parse_number(identifier: str) -> Optional[int]:
    """The numeric part of an id, or None if it is not one of ours."""
    match = _PATTERN.match(identifier or "")
    return int(match.group(2)) if match else None


def next_id(db: Session, model, entity: str) -> str:
    """
    The next free id for a table.

    Derived from the highest existing id rather than a counter, so it stays
    correct after a seed, a restore, or a manual insert — and so nothing has to
    be kept in sync.

    The ordering is *numeric*, on the digits after the prefix, because MySQL
    compares strings lexically and would otherwise decide PRD99 outranks
    PRD100. Comparing by length first would be enough while every id is padded
    to the same width — and would go wrong the moment one is not, which is
    exactly the bug this replaced.

    **Not safe under concurrent inserts.** Two requests reading the same maximum
    will build the same id and the second will fail its unique constraint. That
    is the correct failure — a duplicate id is worse than a rejected request —
    and the fix when write volume warrants it is a per-entity counter row
    updated inside the transaction.
    """
    prefix = PREFIXES[entity]
    digits = func.cast(func.substr(model.id, len(prefix) + 1), Integer)

    highest = db.execute(
        select(func.max(digits)).where(model.id.like(f"{prefix}%"))
    ).scalar()

    return build_id(entity, (highest or 0) + 1)


def slugify(value: str) -> str:
    """A URL-safe slug, matching the frontend's own `slugify`."""
    text = value.lower().replace("&", "and")
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")
