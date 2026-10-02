"""
Document numbers: the format of every number the store issues, fixed in code.

Orders, invoices, refunds, credit notes, SKUs and support requests are quoted
by customers, printed on tax documents and matched against bank statements.
Letting anyone change a prefix, a starting number or a length breaks every one
of those: a new series can collide with an old one, a tax series stops being
continuous, and an emptied prefix produced a real refund numbered `-2026-22`.
So none of it is configuration any more — not in the portal, not through the
API. `billing.billing_config` shows these values; saving settings refuses to
change them.

## Lengths grow

`min_digits` is a minimum, never a cap: the 1,000,000th invoice is
`DCZ-INV-2026-1000000`, not a truncated or colliding number. That is also why
the highest number so far is always read **numerically** (see `highest`) — a
text comparison ranks `…999999` above `…1000000` and sends the series back.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Dict, Optional

from sqlalchemy import Integer, func, select
from sqlalchemy.orm import Session

from app.core.errors import ValidationError


@dataclass(frozen=True)
class Series:
    prefix: str
    min_digits: int
    start: int = 1

    def yearly(self, year: int, number: int) -> str:
        """`DCZ-INV-2026-000214` — the year, then the running number, at least `min_digits` long."""
        return f"{self.prefix}-{year}-{number:0{self.min_digits}d}"


# The formats already in use, so every existing series simply continues.
ORDER_PREFIX = "DCZ"
ORDER_START = 10001  # DCZ10001, DCZ10002 … DCZ100000 …
INVOICE = Series("DCZ-INV", min_digits=6)
REFUND = Series("DCZ-RF", min_digits=5)
CREDIT_NOTE = Series("DCZ-CN", min_digits=5)
SKU_PREFIX = "DCZ"  # DCZ-AC0140
SKU_MIN_DIGITS = 4
TICKET = Series("DCZ", min_digits=6)  # DCZ-2026-000001
SHIPMENT = Series("DCZ-SH", min_digits=6)  # DCZ-SH-2026-000001
PURCHASE_ORDER = Series("DCZ-PO", min_digits=6)  # DCZ-PO-2026-000001
GOODS_RECEIPT = Series("DCZ-GRN", min_digits=6)  # DCZ-GRN-2026-000001


def highest(db: Session, column, *, prefix: Optional[str] = None, lock: bool = True) -> int:
    """
    The largest running number in `column` — the digits after the last "-" (or
    after `prefix`, for a number with no separator) — compared as a number.

    A locking read: under MySQL it sees rows committed a moment ago and holds
    the range, so two writers cannot both take the same next number.
    """
    if prefix is not None:
        suffix = func.substr(column, len(prefix) + 1)
        condition = [column.like(f"{prefix}%")]
    else:
        suffix = func.substring_index(column, "-", -1)
        condition = []
    statement = select(func.max(func.cast(suffix, Integer))).where(
        *condition, suffix.regexp_match("^[0-9]+$")
    )
    if lock:
        statement = statement.with_for_update()
    return int(db.execute(statement).scalar() or 0)


def next_yearly(db: Session, series: Series, column, issued: datetime) -> str:
    """The next number in a yearly series, continuing from the highest ever issued."""
    return series.yearly(issued.year, max(series.start, highest(db, column) + 1))


# ------------------------------------------------------------- settings guard

#: What the billing settings document may not change, section by section.
LOCKED_BILLING = {
    "order": {"prefix": ORDER_PREFIX, "startNumber": ORDER_START},
    "invoice": {"prefix": INVOICE.prefix, "startNumber": INVOICE.start, "padding": INVOICE.min_digits},
    "refund": {"prefix": REFUND.prefix, "startNumber": REFUND.start, "padding": REFUND.min_digits},
    "creditNote": {"prefix": CREDIT_NOTE.prefix, "startNumber": CREDIT_NOTE.start, "padding": CREDIT_NOTE.min_digits},
    "sku": {"prefix": SKU_PREFIX},
}


def with_locked(document: dict) -> dict:
    """The billing document as read: whatever is stored, with the fixed numbering on top."""
    out = dict(document or {})
    for section, fields in LOCKED_BILLING.items():
        out[section] = {**(out.get(section) or {}), **fields}
    return out


def strip_locked(payload: dict) -> dict:
    """
    A billing document on its way to being saved, minus the numbering fields.

    A screen that loaded the document sends them back unchanged, and those are
    simply dropped. A different value is refused rather than ignored, so a
    caller never believes it changed a number format.
    """
    out: Dict[str, object] = {}
    for section, value in (payload or {}).items():
        fixed = LOCKED_BILLING.get(section)
        if fixed is None or not isinstance(value, dict):
            out[section] = value
            continue
        for field, locked_value in fixed.items():
            if field in value and value[field] != locked_value:
                raise ValidationError(
                    "Document number formats are fixed and can't be changed.",
                    error_code="NUMBERING_LOCKED",
                    details={"section": section, "field": field},
                )
        remaining = {k: v for k, v in value.items() if k not in fixed}
        if remaining or section not in ("order", "sku"):
            out[section] = remaining
    return out


def describe() -> list:
    """The formats, for a read-only panel in the portal."""
    year = datetime.utcnow().year
    return [
        {"key": "order", "label": "Orders", "example": f"{ORDER_PREFIX}{ORDER_START}"},
        {"key": "invoice", "label": "Invoices", "example": INVOICE.yearly(year, 1)},
        {"key": "creditNote", "label": "Credit notes", "example": CREDIT_NOTE.yearly(year, 1)},
        {"key": "refund", "label": "Refunds", "example": REFUND.yearly(year, 1)},
        {"key": "ticket", "label": "Support requests", "example": TICKET.yearly(year, 1)},
        {"key": "shipment", "label": "Shipments", "example": SHIPMENT.yearly(year, 1)},
        {"key": "purchaseOrder", "label": "Purchase orders", "example": PURCHASE_ORDER.yearly(year, 1)},
        {"key": "goodsReceipt", "label": "Goods receipts", "example": GOODS_RECEIPT.yearly(year, 1)},
        {"key": "sku", "label": "Generated SKUs", "example": f"{SKU_PREFIX}-AC{1:0{SKU_MIN_DIGITS}d}"},
    ]
