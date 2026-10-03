"""
Drawing a shipping label from its snapshot.

`FORMATS` is the registry of label sizes. Each names its page and the box on
that page the label is drawn in; the layout is one design measured on a
4 x 6 inch label and scaled into the box, so a new size is one entry here.

One page per package ("Package 2 of 3"), each carrying the AWB as a Code 39
barcode. The PDF is drawn from the snapshot alone (no database reads), so an
old label version renders exactly as it was first printed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Tuple

from app.services.fulfilment import pdf as P

BASE_WIDTH = 101.6  # the 4 x 6 inch design the layout is measured on


@dataclass(frozen=True)
class LabelFormat:
    key: str
    name: str
    page: Tuple[float, float]  # page width, height in mm
    box: Tuple[float, float, float]  # x, y, width of the label on the page (height follows at 1.5 x width)


FORMATS: Dict[str, LabelFormat] = {
    "thermal-4x6": LabelFormat("thermal-4x6", "Thermal 4 x 6 in", (101.6, 152.4), (0, 0, 101.6)),
    "standard": LabelFormat("standard", "Standard A6", (105.0, 148.0), (3.0, 0, 98.6)),
    "a4": LabelFormat("a4", "A4 sheet (one label per page)", (210.0, 297.0), (30.0, 20.0, 150.0)),
}


def formats() -> List[dict]:
    return [{"key": f.key, "name": f.name, "widthMm": f.page[0], "heightMm": f.page[1]} for f in FORMATS.values()]


class _Pen:
    """Draws in label units (mm on a 4 x 6 in label), scaled into the format's box."""

    def __init__(self, pdf, fmt: LabelFormat):
        self.pdf = pdf
        self.x0, self.y0, width = fmt.box
        self.s = width / BASE_WIDTH
        self.width = BASE_WIDTH

    def at(self, x, y):
        self.pdf.set_xy(self.x0 + x * self.s, self.y0 + y * self.s)

    def font(self, size, style=""):
        self.pdf.set_font("Helvetica", style, size * self.s)

    def cell(self, x, y, w, h, value, *, size=8, style="", align="L", border=0, limit=None):
        self.at(x, y)
        self.font(size, style)
        self.pdf.cell(w * self.s, h * self.s, P.text(value, limit), border=border, align=align)

    def lines(self, x, y, w, h, values, *, size=8, style="", limit=60) -> float:
        """One cell per value (each truncated to a line). Returns the y after the last."""
        for value in values:
            if not value:
                continue
            self.cell(x, y, w, h, value, size=size, style=style, limit=limit)
            y += h
        return y

    def rule(self, y, x1=4, x2=BASE_WIDTH - 4, width=0.3):
        self.pdf.set_line_width(width * self.s)
        self.pdf.line(self.x0 + x1 * self.s, self.y0 + y * self.s, self.x0 + x2 * self.s, self.y0 + y * self.s)

    def rect(self, x, y, w, h, fill=False):
        self.pdf.set_line_width(0.4 * self.s)
        self.pdf.rect(self.x0 + x * self.s, self.y0 + y * self.s, w * self.s, h * self.s,
                      style="DF" if fill else "D")

    def barcode(self, value, x, y, w, h):
        data = P.code39_text(value)
        if not data:
            return
        # Code 39: about 16 narrow-bar widths a character, start and stop included.
        # fpdf2 takes the wide-bar width (3 narrow).
        chars = len(data) + 2
        wide = min(1.2, (w * self.s) / (chars * 16 / 3))
        self.pdf.code39(f"*{data}*", x=self.x0 + x * self.s, y=self.y0 + y * self.s, w=wide, h=h * self.s)


def _address(block: dict) -> List[str]:
    line1 = block.get("line1") or ""
    line2 = block.get("line2") or ""
    city = ", ".join(part for part in (block.get("city"), block.get("state")) if part)
    return [line1, line2, city]


def _dims(pkg: dict) -> str:
    dims = [pkg.get("lengthCm"), pkg.get("widthCm"), pkg.get("heightCm")]
    if any(d is None for d in dims):
        return ""
    return " x ".join(f"{float(d):g}" for d in dims) + " cm"


def _weight(grams) -> str:
    if not grams:
        return ""
    return f"{int(grams) / 1000:.2f} kg"


def _page(pen: _Pen, snap: dict, pkg: dict, index: int, count: int) -> None:
    ship = snap.get("shipment") or {}
    buyer = snap.get("buyer") or {}
    seller = snap.get("seller") or {}
    W = pen.width

    # Courier and service.
    pen.cell(4, 4, 62, 7, ship.get("courierName") or "Courier", size=12, style="B", limit=30)
    pen.cell(66, 4, W - 70, 7, ship.get("service") or "", size=9, align="R", limit=20)
    pen.rule(12)

    # Ship to.
    pen.cell(4, 14, 40, 4, "SHIP TO", size=7, style="B")
    pen.cell(4, 18.5, W - 8, 6, buyer.get("name") or "", size=11, style="B", limit=40)
    y = pen.lines(4, 25, W - 8, 4.6, _address(buyer), size=9, limit=55)
    pen.cell(4, y + 0.5, 60, 7, f"PIN {buyer.get('pincode') or ''}", size=14, style="B")
    pen.cell(60, y + 1.5, W - 64, 6, f"Ph: {buyer.get('phone') or ''}", size=9, align="R")
    pen.rule(y + 9)

    # AWB barcode.
    top = y + 11
    awb = ship.get("awb") or ""
    pen.barcode(awb, 6, top, W - 12, 13)
    pen.cell(4, top + 14, W - 8, 5, f"AWB {awb}", size=10, style="B", align="C")
    pen.rule(top + 21)

    # Payment.
    top += 23
    if snap.get("cod"):
        pen.pdf.set_fill_color(0, 0, 0)
        pen.pdf.set_text_color(255, 255, 255)
        pen.rect(4, top, W - 8, 9, fill=True)
        pen.cell(4, top + 1, W - 8, 7, f"COD - COLLECT {P.money(snap.get('codAmount') or 0)}", size=12, style="B",
                 align="C")
        pen.pdf.set_text_color(0, 0, 0)
        pen.pdf.set_fill_color(255, 255, 255)
    else:
        pen.rect(4, top, W - 8, 9)
        pen.cell(4, top + 1, W - 8, 7, "PREPAID - DO NOT COLLECT", size=12, style="B", align="C")

    # Order and package.
    top += 11
    pen.cell(4, top, 48, 4.5, f"Order {ship.get('orderNumber') or ''}", size=8, style="B")
    pen.cell(52, top, W - 56, 4.5, ship.get("number") or "", size=8, align="R")
    pen.cell(4, top + 4.5, 48, 4.5, f"Date {P.day(ship.get('orderDate'))}", size=8)
    pen.cell(52, top + 4.5, W - 56, 4.5, f"Value {P.money(snap.get('declaredValue') or 0)}", size=8, align="R")
    pen.cell(4, top + 10, 48, 6, f"Package {index} of {count}", size=11, style="B")
    pen.cell(52, top + 10.5, W - 56, 5, pkg.get("number") or "", size=8, align="R")
    detail = "  |  ".join(part for part in (_weight(pkg.get("weightGrams")), _dims(pkg), pkg.get("type") or "")
                          if part)
    pen.cell(4, top + 16, W - 8, 4.5, detail, size=8)
    pen.rule(top + 21.5)

    # Contents.
    top += 23
    pen.cell(4, top, 40, 4, "CONTENTS", size=7, style="B")
    items = pkg.get("items") or []
    shown = items[:2] if len(items) > 3 else items
    y = top + 4
    for item in shown:
        variant = " / ".join(v for v in (item.get("size"), item.get("color")) if v)
        name = item.get("name") or ""
        label = f"{item.get('sku') or '-'}  {name}" + (f" ({variant})" if variant else "")
        pen.cell(4, y, W - 22, 4, label, size=7, limit=62)
        pen.cell(W - 18, y, 14, 4, f"x {item.get('quantity') or 0}", size=7, align="R")
        y += 4
    if len(items) > len(shown):
        pen.cell(4, y, W - 8, 4, f"+ {len(items) - len(shown)} more line(s)", size=7)
    pen.rule(top + 18)

    # From (the return address).
    top += 19
    pen.cell(4, top, 50, 4, "FROM / RETURN TO", size=7, style="B")
    pen.cell(4, top + 4, W - 8, 4.5, seller.get("name") or "", size=8, style="B", limit=55)
    half = (W - 8) / 2
    pen.lines(4, top + 8.5, half + 6, 3.8, _address(seller), size=7, limit=38)
    pen.lines(W / 2 + 6, top + 8.5, half - 6, 3.8, [
        seller.get("pincode") and f"PIN {seller['pincode']}",
        seller.get("phone") and f"Ph: {seller['phone']}",
        seller.get("gstin") and f"GSTIN {seller['gstin']}",
    ], size=7, limit=30)

    # Footer.
    pen.cell(4, 148.2, W - 8, 3.2,
             f"Label v{snap.get('version') or 1}  |  {P.day(snap.get('generatedAt'))}  |  "
             f"{ship.get('providerCode') or ''}", size=6, align="C")


def render(snapshot: dict, format_key: str = "") -> bytes:
    """The label PDF: one page per package. Raises on a broken snapshot (the caller records the failure)."""
    fmt = FORMATS.get(format_key or snapshot.get("format") or "", FORMATS["thermal-4x6"])
    packages = list(snapshot.get("packages") or [])
    if not packages:
        raise ValueError("The label has no packages to print.")
    document = P.document(fmt.page, P.parse_iso(snapshot.get("generatedAt")))
    document.set_title(P.text(f"Label {snapshot.get('shipment', {}).get('awb', '')}"))
    _render_into(document, fmt, snapshot)
    return P.output(document)


def _render_into(document, fmt: LabelFormat, snapshot: dict) -> int:
    packages = list(snapshot.get("packages") or [])
    for index, package in enumerate(packages, start=1):
        document.add_page(format=fmt.page)
        pen = _Pen(document, fmt)
        if fmt.key == "a4":
            pen.rect(0, 0, BASE_WIDTH, 152.4)  # a cutting line round the label
        _page(pen, snapshot, package, index, len(packages))
        if snapshot.get("void"):
            _void(pen, str(snapshot["void"]))
    return len(packages)


def _void(pen: _Pen, word: str) -> None:
    """An old or cancelled version, stamped so it can't be mistaken for the live label."""
    pen.pdf.set_text_color(200, 0, 0)
    x, y = pen.x0 + 50.8 * pen.s, pen.y0 + 76 * pen.s
    with pen.pdf.rotation(40, x, y):
        pen.font(30, "B")
        width = pen.pdf.get_string_width(word)
        pen.pdf.text(x - width / 2, y, word)
    pen.pdf.set_text_color(0, 0, 0)


def render_many(snapshots: List[dict], format_key: str = "") -> bytes:
    """Several labels in one PDF, for printing a batch. Each keeps its own pages."""
    first = P.parse_iso(snapshots[0].get("generatedAt")) if snapshots else None
    default = FORMATS.get(format_key or (snapshots[0].get("format") if snapshots else ""), FORMATS["thermal-4x6"])
    document = P.document(default.page, first)
    document.set_title("Shipping labels")
    for snapshot in snapshots:
        # Each label keeps the format it was generated in (fpdf2 sizes each page).
        fmt = FORMATS.get(format_key or snapshot.get("format") or "", default)
        _render_into(document, fmt, snapshot)
    return P.output(document)
