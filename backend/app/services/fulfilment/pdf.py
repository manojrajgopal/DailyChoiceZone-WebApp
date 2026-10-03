"""
Small helpers shared by the packing slip and the shipping label (fpdf2).

**Text.** The PDFs use fpdf2's built-in Helvetica, which is Latin-1 only. No
font file is bundled: a label must render on any machine without assets, and
the same bytes from the same snapshot. So text goes through `text()`, which
maps common typography (dashes, quotes) to ASCII and anything else outside
Latin-1 to "?", and money is printed as "Rs. 1,234.50" rather than with the
rupee sign (which Latin-1 lacks).

**Determinism.** Every document's creation date is set from the data it
prints (the label's `generatedAt`), so the same snapshot always gives the
same bytes.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Optional

from fpdf import FPDF

_REPLACE = {
    "–": "-", "—": "-", "−": "-", "‘": "'", "’": "'", "“": '"', "”": '"',
    "…": "...", "₹": "Rs.", " ": " ", "•": "-", "×": "x",
}

_CODE39 = re.compile(r"[^0-9A-Z\-. $/+%]")


def text(value, limit: Optional[int] = None) -> str:
    """Printable with the core fonts: typography to ASCII, anything else outside Latin-1 to '?'."""
    raw = "" if value is None else str(value)
    for char, replacement in _REPLACE.items():
        raw = raw.replace(char, replacement)
    raw = " ".join(raw.split())
    out = raw.encode("latin-1", "replace").decode("latin-1")
    if limit is not None and len(out) > limit:
        out = out[: max(0, limit - 3)] + "..."
    return out


def money(paise: int) -> str:
    """Rs. 12,34,567.50: Indian digit grouping, integer arithmetic only."""
    paise = int(paise or 0)
    sign = "-" if paise < 0 else ""
    rupees, rest = divmod(abs(paise), 100)
    digits = str(rupees)
    if len(digits) > 3:
        head, tail = digits[:-3], digits[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        digits = ",".join(groups + [tail])
    return f"{sign}Rs. {digits}.{rest:02d}"


def code39_text(value: str) -> str:
    """What a Code 39 barcode can carry: upper case, digits and - . $ / + % and space."""
    return _CODE39.sub("", (value or "").upper())


def document(page, created: Optional[datetime] = None) -> FPDF:
    """A new document with a fixed creation date, no automatic page breaks, millimetres."""
    pdf = FPDF(unit="mm", format=page)
    pdf.set_auto_page_break(False)
    pdf.set_margins(0, 0, 0)
    when = created or datetime(2026, 1, 1)
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    pdf.set_creation_date(when)
    pdf.set_creator("Daily Choice Zone")
    pdf.set_producer("Daily Choice Zone")
    return pdf


def output(pdf: FPDF) -> bytes:
    return bytes(pdf.output())


def parse_iso(value) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", ""))
    except ValueError:
        return None


def day(value) -> str:
    when = parse_iso(value)
    return f"{when.day} {when:%b %Y}" if when else ""
