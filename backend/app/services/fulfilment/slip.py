"""
The packing slip: an A4 page that goes in the box.

Store details and return information come from the store settings
(`store.general`, `store.contact`, `store.returns`) and the GSTIN from the
tax settings. Prices are optional (`showPrices`), since a gift shouldn't
carry them. Drawn on request from the job as it is now; nothing is stored.
"""

from __future__ import annotations

from datetime import datetime
from typing import List

from sqlalchemy.orm import Session

from app.models import Order
from app.models.fulfilment import PackingJob
from app.services import billing
from app.services.fulfilment import pdf as P

PAGE = (210.0, 297.0)
LEFT, RIGHT = 14.0, 196.0


def _rows(job: PackingJob, order: Order) -> List[dict]:
    """What is in each package, or the order's lines while nothing is packed yet."""
    items = {item.id: item for item in order.items}
    lines = {line.id: line for line in job.lines}
    packages = [p for p in job.packages if p.removed_at is None]
    out = []
    if packages:
        for package in packages:
            for entry in package.items:
                line = lines.get(entry.line_id)
                item = items.get(line.order_item_id) if line is not None else None
                if item is not None:
                    out.append({"package": package.package_number, "item": item, "quantity": entry.quantity})
        return out
    for line in job.lines:
        item = items.get(line.order_item_id)
        if item is not None:
            out.append({"package": "", "item": item, "quantity": line.quantity})
    return out


def render(db: Session, job: PackingJob, *, show_prices: bool) -> bytes:
    order = db.get(Order, job.order_id)
    store = billing.store_settings(db)
    general, contact, returns = store.get("general") or {}, store.get("contact") or {}, store.get("returns") or {}
    gstin = billing.tax_config(db).get("gstin") or (store.get("tax") or {}).get("gstin") or ""
    when = job.packed_at or job.updated_at or datetime.utcnow()
    pdf = P.document(PAGE, when)
    pdf.set_title(P.text(f"Packing slip {order.order_number}"))
    pdf.add_page()

    def put(x, y, w, h, value, size=9, style="", align="L", limit=None):
        pdf.set_xy(x, y)
        pdf.set_font("Helvetica", style, size)
        pdf.cell(w, h, P.text(value, limit), align=align)

    # Store.
    put(LEFT, 14, 110, 8, general.get("storeName") or "", 16, "B", limit=45)
    address = ", ".join(v for v in (contact.get("addressLine"), contact.get("city"), contact.get("state"),
                                    contact.get("pincode")) if v)
    put(LEFT, 22, 120, 5, address, 8, limit=90)
    put(LEFT, 27, 120, 5, "  |  ".join(v for v in (contact.get("phone"), contact.get("email"),
                                                   gstin and f"GSTIN {gstin}") if v), 8, limit=95)
    put(130, 14, RIGHT - 130, 8, "PACKING SLIP", 14, "B", "R")
    put(130, 22, RIGHT - 130, 5, f"Order {order.order_number}", 9, "B", "R")
    put(130, 27, RIGHT - 130, 5, f"Ordered {P.day(order.placed_at)}", 8, align="R")
    put(130, 32, RIGHT - 130, 5, f"Packed {P.day(job.packed_at)}" if job.packed_at else "Not packed yet", 8,
        align="R")
    pdf.set_line_width(0.3)
    pdf.line(LEFT, 39, RIGHT, 39)

    # Ship to.
    put(LEFT, 42, 80, 5, "SHIP TO", 7, "B")
    y = 47
    for value in (order.shipping_name or order.customer_name, order.shipping_line1, order.shipping_line2,
                  ", ".join(v for v in (order.shipping_city, order.shipping_state) if v)
                  + (f" - {order.shipping_pincode}" if order.shipping_pincode else ""),
                  order.shipping_phone and f"Phone {order.shipping_phone}"):
        if value:
            put(LEFT, y, 100, 5, value, 9, "B" if y == 47 else "", limit=60)
            y += 5
    packages = [p for p in job.packages if p.removed_at is None]
    put(120, 42, RIGHT - 120, 5, "PACKAGES", 7, "B")
    put(120, 47, RIGHT - 120, 5, ", ".join(p.package_number for p in packages) or "-", 8, limit=60)
    put(120, 52, RIGHT - 120, 5, f"{len(packages)} package(s)  |  {order.item_count} item(s)", 8)
    put(120, 57, RIGHT - 120, 5, f"Delivery: {order.delivery_method}", 8)

    # Lines.
    top = max(y, 64) + 4
    columns = [("Package", 36), ("SKU", 28), ("Item", 62 if show_prices else 96), ("Variant", 28), ("Qty", 12)]
    if show_prices:
        columns += [("Price", 16), ("Total", 18)]
    pdf.set_fill_color(235, 235, 235)
    x = LEFT
    for title, width in columns:
        pdf.set_xy(x, top)
        pdf.set_font("Helvetica", "B", 8)
        pdf.cell(width, 7, title, fill=True, align="R" if title in ("Qty", "Price", "Total") else "L")
        x += width
    row_y = top + 7
    rows = _rows(job, order)
    for index, row in enumerate(rows):
        if row_y > 250:
            pdf.add_page()
            row_y = 20
        item = row["item"]
        variant = " / ".join(v for v in (item.size, item.color) if v)
        unit = billing.to_minor(item.unit_price or 0)
        values = [row["package"], item.sku or "", item.name, variant, str(row["quantity"])]
        if show_prices:
            values += [P.money(unit).replace("Rs. ", ""), P.money(unit * row["quantity"]).replace("Rs. ", "")]
        x = LEFT
        for (title, width), value in zip(columns, values):
            pdf.set_xy(x, row_y)
            pdf.set_font("Helvetica", "", 8)
            pdf.cell(width, 6, P.text(value, int(width / 1.7)),
                     align="R" if title in ("Qty", "Price", "Total") else "L")
            x += width
        row_y += 6
        pdf.set_draw_color(220, 220, 220)
        pdf.line(LEFT, row_y, RIGHT, row_y)
        pdf.set_draw_color(0, 0, 0)
    if show_prices:
        put(LEFT, row_y + 3, RIGHT - LEFT, 6, f"Order total {P.money(billing.to_minor(order.total or 0))} "
                                              f"(paid: {order.payment_status.replace('-', ' ')})", 9, "B", "R")

    # Returns.
    pdf.line(LEFT, 262, RIGHT, 262)
    put(LEFT, 264, 80, 5, "RETURNS", 7, "B")
    window = returns.get("windowDays")
    text = (f"Returns are accepted within {window} days of delivery. " if window else "") + \
        (returns.get("policyNote") or "")
    pdf.set_xy(LEFT, 269)
    pdf.set_font("Helvetica", "", 8)
    pdf.multi_cell(RIGHT - LEFT, 4.5, P.text(text or "See our returns policy online.", 300))
    put(LEFT, 282, RIGHT - LEFT, 5, "Questions? " + "  |  ".join(v for v in (contact.get("email"), contact.get("phone"),
                                                                            contact.get("supportHours")) if v), 8,
        limit=120)
    return P.output(pdf)


def filename(order: Order) -> str:
    return f"packing-slip-{order.order_number}.pdf"
