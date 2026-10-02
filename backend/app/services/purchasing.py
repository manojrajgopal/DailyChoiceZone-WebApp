"""
Purchase orders and goods receiving.

    draft -> submitted -> sent -> acknowledged -> partially-received -> received
      `--------`----------`----------`-> cancelled   (only before anything is received)

`sent -> partially-received` is allowed too (a supplier may never acknowledge),
and receiving is allowed from sent, acknowledged and partially-received.

Every total is worked out here, in paise, from the lines: what a request says
about money is never used except the unit cost and the rate it asks for. Tax is
exclusive of the cost (suppliers quote before GST): intra-state when the
supplier's billing state is the store's origin state (CGST + SGST, the halves
of the line's tax so they always add up), inter-state otherwise (IGST). A
supplier that can't charge GST - unregistered, overseas or under the
composition scheme (which issues a bill of supply) - gets none.

## Receiving

A receipt adds the accepted units (received - damaged - rejected) to stock
through `products.receive_stock`, which writes the stock ledger. The PO row
and its item rows are read **under a lock** first, so two receipts posted at
the same moment can't both see the same outstanding quantity and over-receive.
The client's `idempotencyKey` is unique on `goods_receipts`: the same key again
returns the PO unchanged; two requests racing with one key are settled by the
unique index (the loser rolls back and gets the winner's result).

See docs/shipping-and-suppliers.md, section 6 ("Admin: purchase orders").
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core import numbering
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import (
    Category,
    GoodsReceipt,
    GoodsReceiptItem,
    Product,
    PurchaseOrder,
    PurchaseOrderEvent,
    PurchaseOrderItem,
    Supplier,
    SupplierProduct,
)
from app.services import audit, billing
from app.services.suppliers import (
    MAX_QUANTITY,
    decimal,
    flag,
    integer,
    invalid,
    money,
    text,
)
from app.utils.dates import parse_dt
from app.utils.ids import next_id

STATUSES = ("draft", "submitted", "sent", "acknowledged", "partially-received", "received", "cancelled")
STATUS_LABELS = {
    "draft": "Draft", "submitted": "Submitted", "sent": "Sent", "acknowledged": "Acknowledged",
    "partially-received": "Partially received", "received": "Received", "cancelled": "Cancelled",
}
RECEIVABLE = ("sent", "acknowledged", "partially-received")
CANCELLABLE = ("draft", "submitted", "sent", "acknowledged")
# action -> (from, to, timestamp attribute)
TRANSITIONS = {
    "submit": ("draft", "submitted", "submitted_at"),
    "send": ("submitted", "sent", "sent_at"),
    "acknowledge": ("sent", "acknowledged", "acknowledged_at"),
}
NO_GST_TREATMENTS = ("unregistered", "overseas", "composition")
MAX_ITEMS = 200
MAX_TAX_RATE = Decimal("100")


# --------------------------------------------------------------------- tax


def tax_mode(supplier: Supplier, config: dict) -> str:
    """intra-state | inter-state | none, from the supplier's billing state (or GSTIN state code)."""
    if supplier.tax_treatment in NO_GST_TREATMENTS:
        return "none"
    if not config.get("enabled") or config.get("taxType") == "NONE":
        return "none"
    state = ((supplier.billing_address or {}).get("state") or "").strip()
    if not state and supplier.gstin and len(config.get("gstin") or "") >= 2:
        # No state on file: the GSTIN's first two digits are the state code, as are the store's.
        return "intra-state" if supplier.gstin[:2] == config["gstin"][:2] else "inter-state"
    return billing.tax_mode_for(state, config)


def default_rate(product_rate: Any, category: Optional[str], config: dict, mode: str) -> Decimal:
    """The product's own rate, else the tax settings' rate for its category."""
    if mode == "none":
        return Decimal("0")
    if product_rate is not None:
        return Decimal(str(product_rate))
    rates = billing.rates_for(category, config)
    if mode == "intra-state":
        return Decimal(str(rates.get("cgst", 0) or 0)) + Decimal(str(rates.get("sgst", 0) or 0))
    return Decimal(str(rates.get("igst", 0) or 0))


def line_amounts(quantity: int, unit_cost: int, rate: Decimal, mode: str) -> dict:
    """One line in paise: subtotal, tax (half-up), and the CGST/SGST halves that sum to it exactly."""
    subtotal = quantity * unit_cost
    tax = billing.percent_of(subtotal, float(rate)) if mode != "none" and rate > 0 else 0
    cgst = sgst = igst = 0
    if mode == "intra-state":
        cgst = int((Decimal(tax) / 2).to_integral_value(rounding=ROUND_HALF_UP))
        sgst = tax - cgst
    elif mode == "inter-state":
        igst = tax
    return {"subtotal": subtotal, "tax": tax, "cgst": cgst, "sgst": sgst, "igst": igst, "total": subtotal + tax}


def _recalculate(po: PurchaseOrder, mode: str) -> None:
    po.tax_mode = mode
    totals = {"subtotal": 0, "cgst": 0, "sgst": 0, "igst": 0, "tax": 0, "total": 0}
    for item in po.items:
        amounts = line_amounts(item.quantity, item.unit_cost, Decimal(str(item.tax_rate or 0)), mode)
        item.line_subtotal, item.line_tax, item.line_total = amounts["subtotal"], amounts["tax"], amounts["total"]
        for key in totals:
            totals[key] += amounts[key]
    po.subtotal, po.cgst, po.sgst, po.igst = totals["subtotal"], totals["cgst"], totals["sgst"], totals["igst"]
    po.tax_total, po.total = totals["tax"], totals["total"]


# ------------------------------------------------------------------- views


def _major(value: Optional[int]) -> float:
    return billing.to_major(int(value or 0))


def _date(value: Optional[datetime]) -> Optional[str]:
    return value.date().isoformat() if value else None


def _accepted(item) -> int:
    return max(0, item.received_qty - item.damaged_qty - item.rejected_qty)


def outstanding(item: PurchaseOrderItem) -> int:
    """Units still to arrive: ordered minus physically received (damaged and rejected included)."""
    return max(0, item.quantity - item.received_qty)


def has_receipts(po: PurchaseOrder) -> bool:
    return bool(po.receipts) or any(item.received_qty for item in po.items)


def actions(po: PurchaseOrder) -> dict:
    supplier_active = po.supplier is not None and po.supplier.status == "active"
    return {
        "edit": po.status == "draft",
        "submit": po.status == "draft" and bool(po.items) and supplier_active,
        "send": po.status == "submitted" and supplier_active,
        "acknowledge": po.status == "sent",
        "receive": po.status in RECEIVABLE,
        "cancel": po.status in CANCELLABLE and not has_receipts(po),
    }


def receipt_view(receipt: GoodsReceipt, names: Dict[int, str]) -> dict:
    return {
        "id": receipt.id, "receiptNumber": receipt.receipt_number, "receivedAt": receipt.received_at,
        "notes": receipt.notes, "overReceiptReason": receipt.over_receipt_reason,
        "createdBy": receipt.created_by, "createdAt": receipt.created_at,
        "items": [{"poItemId": line.purchase_order_item_id, "productId": line.product_id,
                   "name": names.get(line.purchase_order_item_id, ""), "receivedQty": line.received_qty,
                   "damagedQty": line.damaged_qty, "rejectedQty": line.rejected_qty,
                   "acceptedQty": line.accepted_qty, "note": line.note} for line in receipt.items],
    }


def _moq_warnings(db: Session, po: PurchaseOrder) -> List[dict]:
    if not po.items:
        return []
    moqs = dict(db.execute(select(SupplierProduct.product_id, SupplierProduct.moq).where(
        SupplierProduct.supplier_id == po.supplier_id,
        SupplierProduct.product_id.in_([item.product_id for item in po.items]))).all())
    return [
        {"code": "BELOW_MOQ", "productId": item.product_id, "poItemId": item.id, "moq": int(moqs[item.product_id]),
         "quantity": item.quantity,
         "message": f"{item.name}: {item.quantity} is below the supplier's minimum order of {moqs[item.product_id]}."}
        for item in po.items if item.product_id in moqs and item.quantity < moqs[item.product_id]
    ]


def po_view(db: Session, po: PurchaseOrder) -> dict:
    supplier = po.supplier
    names = {item.id: item.name for item in po.items}
    return {
        "id": po.id, "poNumber": po.po_number, "status": po.status,
        "statusLabel": STATUS_LABELS.get(po.status, po.status),
        "supplier": {"id": supplier.id, "code": supplier.code, "name": supplier.name, "status": supplier.status,
                     "state": (supplier.billing_address or {}).get("state", "") or "",
                     "taxTreatment": supplier.tax_treatment, "gstin": supplier.gstin or None},
        "currency": po.currency, "taxMode": po.tax_mode,
        "items": [{
            "id": item.id, "productId": item.product_id, "name": item.name, "sku": item.sku,
            "supplierSku": item.supplier_sku, "quantity": item.quantity, "unitCost": _major(item.unit_cost),
            "taxRate": float(item.tax_rate or 0), "lineSubtotal": _major(item.line_subtotal),
            "lineTax": _major(item.line_tax), "lineTotal": _major(item.line_total),
            "receivedQty": item.received_qty, "damagedQty": item.damaged_qty, "rejectedQty": item.rejected_qty,
            "acceptedQty": _accepted(item), "outstandingQty": outstanding(item),
        } for item in po.items],
        "subtotal": _major(po.subtotal), "cgst": _major(po.cgst), "sgst": _major(po.sgst), "igst": _major(po.igst),
        "taxTotal": _major(po.tax_total), "total": _major(po.total),
        "expectedAt": _date(po.expected_at), "supplierReference": po.supplier_reference, "notes": po.notes,
        "submittedAt": po.submitted_at, "sentAt": po.sent_at, "acknowledgedAt": po.acknowledged_at,
        "receivedAt": po.received_at, "cancelledAt": po.cancelled_at, "cancelReason": po.cancel_reason,
        "timeline": [{"status": e.status, "label": STATUS_LABELS.get(e.status, e.status), "note": e.note,
                      "actor": e.actor, "at": e.occurred_at} for e in po.events],
        "receipts": [receipt_view(r, names) for r in po.receipts],
        "actions": actions(po),
        "warnings": _moq_warnings(db, po) if po.status == "draft" else [],
        "createdAt": po.created_at, "updatedAt": po.updated_at, "createdBy": po.created_by,
    }


def _load(db: Session, po_id: Any, *, fresh: bool = False) -> PurchaseOrder:
    po = None
    if isinstance(po_id, str) and po_id:
        query = (select(PurchaseOrder).where(PurchaseOrder.id == po_id)
                 .options(selectinload(PurchaseOrder.items), selectinload(PurchaseOrder.events),
                          selectinload(PurchaseOrder.receipts).selectinload(GoodsReceipt.items),
                          selectinload(PurchaseOrder.supplier)))
        if fresh:
            query = query.execution_options(populate_existing=True)
        po = db.execute(query).scalar_one_or_none()
    if po is None:
        raise NotFoundError("We couldn't find that purchase order.", error_code="PO_NOT_FOUND")
    return po


def get(db: Session, po_id: str) -> dict:
    return po_view(db, _load(db, po_id))


def receipts(db: Session, po_id: str) -> List[dict]:
    po = _load(db, po_id)
    names = {item.id: item.name for item in po.items}
    return [receipt_view(r, names) for r in po.receipts]


# -------------------------------------------------------------------- list


def _day(value: str, field: str) -> Optional[datetime]:
    if not value:
        return None
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value.strip()):
        raise invalid("Use a date like 2026-10-15.", "INVALID_DATE", field)
    try:
        return datetime.strptime(value.strip(), "%Y-%m-%d")
    except ValueError:
        raise invalid("Use a date like 2026-10-15.", "INVALID_DATE", field) from None


def list_pos(db: Session, *, q: str = "", status: str = "", supplier: str = "", date_from: str = "",
             date_to: str = "", sort: str = "createdAt", page: int = 1,
             page_size: int = 25) -> Tuple[List[dict], int, dict]:
    start, end = _day(date_from, "from"), _day(date_to, "to")
    conditions = []
    term = (q or "").strip()
    if term:
        like = f"%{term}%"
        conditions.append(or_(PurchaseOrder.po_number.like(like), PurchaseOrder.supplier_reference.like(like),
                              Supplier.name.like(like), Supplier.code.like(like)))
    if supplier:
        conditions.append(PurchaseOrder.supplier_id == supplier)
    if start:
        conditions.append(PurchaseOrder.created_at >= start)
    if end:
        conditions.append(PurchaseOrder.created_at < end + timedelta(days=1))

    base = select(PurchaseOrder.status, func.count()).join(Supplier, Supplier.id == PurchaseOrder.supplier_id)
    counts = {s: 0 for s in STATUSES}
    for value, count in db.execute(base.where(*conditions).group_by(PurchaseOrder.status)).all():
        counts[value] = int(count)

    if status in STATUSES:
        conditions.append(PurchaseOrder.status == status)
    total = int(db.execute(select(func.count()).select_from(PurchaseOrder)
                           .join(Supplier, Supplier.id == PurchaseOrder.supplier_id).where(*conditions)).scalar() or 0)
    order = {
        "expectedAt": [PurchaseOrder.expected_at.is_(None), PurchaseOrder.expected_at.asc()],
        "total": [PurchaseOrder.total.desc()],
        "poNumber": [PurchaseOrder.po_number.desc()],
    }.get(sort, [PurchaseOrder.created_at.desc(), PurchaseOrder.id.desc()])
    rows = db.execute(
        select(PurchaseOrder, Supplier.name).join(Supplier, Supplier.id == PurchaseOrder.supplier_id)
        .where(*conditions).order_by(*order, PurchaseOrder.id.desc())
        .offset((page - 1) * page_size).limit(page_size)
    ).all()
    ids = [po.id for po, _ in rows]
    item_counts: Dict[str, int] = {}
    if ids:
        item_counts = dict(db.execute(select(PurchaseOrderItem.purchase_order_id, func.count())
                                      .where(PurchaseOrderItem.purchase_order_id.in_(ids))
                                      .group_by(PurchaseOrderItem.purchase_order_id)).all())
    items = [{
        "id": po.id, "poNumber": po.po_number, "status": po.status,
        "statusLabel": STATUS_LABELS.get(po.status, po.status), "supplierId": po.supplier_id,
        "supplierName": supplier_name, "itemCount": int(item_counts.get(po.id, 0)), "total": _major(po.total),
        "currency": po.currency, "expectedAt": _date(po.expected_at), "createdAt": po.created_at,
    } for po, supplier_name in rows]
    return items, total, counts


# ------------------------------------------------------------ create / edit


def _active_supplier(db: Session, supplier_id: Any) -> Supplier:
    if not isinstance(supplier_id, str) or not supplier_id.strip():
        raise invalid("Choose a supplier.", "SUPPLIER_REQUIRED", "supplierId")
    supplier = db.get(Supplier, supplier_id.strip())
    if supplier is None:
        raise NotFoundError("We couldn't find that supplier.", error_code="SUPPLIER_NOT_FOUND",
                            details={"field": "supplierId"})
    if supplier.status != "active":
        raise ConflictError(f"{supplier.name} is {supplier.status}; it can't take new purchase orders.",
                            error_code="SUPPLIER_INACTIVE", details={"field": "supplierId"})
    return supplier


def _validate(db: Session, payload: dict, supplier: Supplier) -> dict:
    """The lines and header of a PO body, checked; the products and links loaded in one query each."""
    raw_items = payload.get("items")
    if raw_items is None or raw_items == []:
        raise invalid("Add at least one product.", "NO_ITEMS", "items")
    if not isinstance(raw_items, list):
        raise invalid("The items must be a list.", "INVALID_ITEMS", "items")
    if len(raw_items) > MAX_ITEMS:
        raise invalid(f"A purchase order can have at most {MAX_ITEMS} lines.", "TOO_MANY_ITEMS", "items")

    seen = set()
    wanted = []
    for index, raw in enumerate(raw_items):
        if not isinstance(raw, dict):
            raise invalid("Each item must be an object.", "INVALID_ITEMS", f"items[{index}]")
        product_id = raw.get("productId")
        if not isinstance(product_id, str) or not product_id.strip():
            raise invalid("Choose a product for every line.", "PRODUCT_REQUIRED", f"items[{index}].productId")
        product_id = product_id.strip()
        if product_id in seen:
            raise invalid("Each product can appear only once; change the quantity instead.", "DUPLICATE_ITEM",
                          f"items[{index}].productId", productId=product_id)
        seen.add(product_id)
        wanted.append((index, product_id, raw))

    products = {row.id: row for row in db.execute(
        select(Product.id, Product.name, Product.sku, Product.status, Product.tax_rate_percent,
               Category.slug.label("category"))
        .join(Category, Category.id == Product.category_id, isouter=True)
        .where(Product.id.in_(list(seen)))).all()}
    links = {link.product_id: link for link in db.execute(select(SupplierProduct).where(
        SupplierProduct.supplier_id == supplier.id, SupplierProduct.product_id.in_(list(seen)))).scalars()}

    config = billing.tax_config(db)
    mode = tax_mode(supplier, config)
    lines = []
    for index, product_id, raw in wanted:
        product = products.get(product_id)
        if product is None:
            raise NotFoundError(f"We couldn't find product {product_id}.", error_code="PRODUCT_NOT_FOUND",
                                details={"field": f"items[{index}].productId", "productId": product_id})
        if product.status == "archived":
            raise ValidationError(f"{product.name} is archived and can't be ordered.", error_code="PRODUCT_ARCHIVED",
                                  details={"field": f"items[{index}].productId", "productId": product_id})
        quantity = integer(raw.get("quantity"), field=f"items[{index}].quantity", label="The quantity", minimum=1,
                           maximum=MAX_QUANTITY, code="INVALID_QUANTITY")
        link = links.get(product_id)
        if raw.get("unitCost") is None or raw.get("unitCost") == "":
            if link is None or not link.purchase_cost:
                raise invalid(f"Enter a unit cost for {product.name}: this supplier has no purchase cost for it.",
                              "UNIT_COST_REQUIRED", f"items[{index}].unitCost", productId=product_id)
            unit_cost = int(link.purchase_cost)
        else:
            unit_cost = money(raw.get("unitCost"), field=f"items[{index}].unitCost", label="The unit cost",
                              code="INVALID_UNIT_COST")
        if mode == "none":
            rate = Decimal("0")
        elif raw.get("taxRate") is None or raw.get("taxRate") == "":
            rate = default_rate(product.tax_rate_percent, product.category, config, mode)
        else:
            rate = decimal(raw.get("taxRate"), field=f"items[{index}].taxRate", label="The tax rate",
                           code="INVALID_TAX_RATE")
            if rate < 0 or rate > MAX_TAX_RATE:
                raise invalid("The tax rate is between 0 and 100 percent.", "INVALID_TAX_RATE",
                              f"items[{index}].taxRate")
        rate = rate.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        lines.append({"product_id": product_id, "name": product.name, "sku": product.sku,
                      "supplier_sku": link.supplier_sku if link else "", "quantity": quantity,
                      "unit_cost": unit_cost, "tax_rate": rate})

    expected = payload.get("expectedAt")
    expected_at = None
    if expected not in (None, ""):
        expected_at = parse_dt(expected) if isinstance(expected, str) else None
        if expected_at is None:
            raise invalid("Use a date like 2026-10-15.", "INVALID_DATE", "expectedAt")
        expected_at = datetime(expected_at.year, expected_at.month, expected_at.day)

    return {
        "lines": lines, "mode": mode, "expected_at": expected_at,
        "supplier_reference": text(payload, "supplierReference", max_len=60, label="The supplier reference"),
        "notes": text(payload, "notes", max_len=5000, label="The notes"),
    }


def _snapshot(po: PurchaseOrder) -> dict:
    return {
        "supplierId": po.supplier_id, "status": po.status, "expectedAt": _date(po.expected_at),
        "supplierReference": po.supplier_reference, "notes": po.notes, "total": _major(po.total),
        "items": {item.product_id: {"quantity": item.quantity, "unitCost": _major(item.unit_cost),
                                    "taxRate": float(item.tax_rate or 0)} for item in po.items},
    }


def _event(po: PurchaseOrder, status: str, actor: str, note: str = "", at: Optional[datetime] = None) -> None:
    po.events.append(PurchaseOrderEvent(status=status, note=(note or "")[:500], actor=(actor or "")[:40],
                                        occurred_at=at or datetime.utcnow()))


def create(db: Session, admin, payload: dict) -> PurchaseOrder:
    supplier = _active_supplier(db, payload.get("supplierId"))
    data = _validate(db, payload, supplier)
    now = datetime.utcnow()
    po = PurchaseOrder(
        id=next_id(db, PurchaseOrder, "purchase_order"),
        po_number=numbering.next_yearly(db, numbering.PURCHASE_ORDER, PurchaseOrder.po_number, now),
        supplier_id=supplier.id, status="draft", currency=supplier.currency or "INR",
        expected_at=data["expected_at"], supplier_reference=data["supplier_reference"], notes=data["notes"],
        created_by=admin.id,
    )
    po.supplier = supplier
    for line in data["lines"]:
        po.items.append(PurchaseOrderItem(**line))
    _recalculate(po, data["mode"])
    _event(po, "draft", admin.id, at=now)
    db.add(po)
    db.flush()
    audit.record(db, "purchase-order.create", resource_type="purchase-order", resource_id=po.id, actor=admin,
                 summary=f"Created purchase order {po.po_number} for {supplier.name}",
                 changes=audit.diff({}, _snapshot(po)), details={"supplierId": supplier.id})
    db.commit()
    return _load(db, po.id, fresh=True)


def update(db: Session, admin, po_id: str, payload: dict) -> PurchaseOrder:
    po = _load(db, po_id)
    if po.status != "draft":
        raise ConflictError("Only a draft purchase order can be edited.", error_code="PO_NOT_EDITABLE")
    supplier_id = payload.get("supplierId", po.supplier_id)
    supplier = po.supplier if supplier_id == po.supplier_id else _active_supplier(db, supplier_id)
    if supplier.status != "active":
        _active_supplier(db, supplier.id)  # raises SUPPLIER_INACTIVE
    merged = {"items": [{"productId": i.product_id, "quantity": i.quantity, "unitCost": _major(i.unit_cost),
                         "taxRate": float(i.tax_rate)} for i in po.items],
              "expectedAt": _date(po.expected_at), "supplierReference": po.supplier_reference, "notes": po.notes}
    merged.update({k: v for k, v in payload.items() if k in merged})
    data = _validate(db, merged, supplier)
    before = _snapshot(po)

    po.supplier_id, po.supplier, po.currency = supplier.id, supplier, supplier.currency or "INR"
    po.expected_at, po.supplier_reference, po.notes = (data["expected_at"], data["supplier_reference"],
                                                       data["notes"])
    # Lines matched by product: updated in place, removed, or added - never
    # deleted and re-inserted, which the (po, product) unique index would refuse
    # inside one flush.
    existing = {item.product_id: item for item in po.items}
    keep = {line["product_id"] for line in data["lines"]}
    for item in list(po.items):
        if item.product_id not in keep:
            po.items.remove(item)
    for line in data["lines"]:
        item = existing.get(line["product_id"])
        if item is None:
            po.items.append(PurchaseOrderItem(**line))
        else:
            for key, value in line.items():
                setattr(item, key, value)
    _recalculate(po, data["mode"])
    db.flush()
    changes = audit.diff(before, _snapshot(po))
    if changes:
        audit.record(db, "purchase-order.update", resource_type="purchase-order", resource_id=po.id, actor=admin,
                     summary=f"Edited purchase order {po.po_number}", changes=changes,
                     details={"supplierId": po.supplier_id})
    db.commit()
    return _load(db, po.id, fresh=True)


# --------------------------------------------------------------- transitions


def _note(payload: dict) -> str:
    return text(payload or {}, "note", max_len=500, label="The note")


def _transition_error(po: PurchaseOrder, action: str) -> ConflictError:
    return ConflictError(f"A {STATUS_LABELS.get(po.status, po.status).lower()} purchase order can't be {action}.",
                         error_code="INVALID_PO_TRANSITION", details={"status": po.status, "action": action})


def _locked_po(db: Session, po_id: str) -> PurchaseOrder:
    """The PO row under a lock, refreshed from the database (see `products.lock_products`)."""
    db.flush()
    po = db.execute(select(PurchaseOrder).where(PurchaseOrder.id == po_id).with_for_update()
                    .execution_options(populate_existing=True)).scalar_one_or_none()
    if po is None:
        raise NotFoundError("We couldn't find that purchase order.", error_code="PO_NOT_FOUND")
    return po


def transition(db: Session, admin, po_id: str, action: str, payload: dict) -> PurchaseOrder:
    source, target, stamp = TRANSITIONS[action]
    _load(db, po_id)
    note = _note(payload)
    po = _locked_po(db, po_id)
    if po.status != source:
        raise _transition_error(po, {"submit": "submitted", "send": "sent", "acknowledge": "acknowledged"}[action])
    if action in ("submit", "send") and po.supplier.status != "active":
        raise ConflictError(f"{po.supplier.name} is {po.supplier.status}; activate the supplier first.",
                            error_code="SUPPLIER_INACTIVE")
    if action == "submit" and not po.items:
        raise invalid("Add at least one product.", "NO_ITEMS", "items")
    now = datetime.utcnow()
    po.status = target
    setattr(po, stamp, now)
    _event(po, target, admin.id, note, at=now)
    audit.record(db, f"purchase-order.{action}", resource_type="purchase-order", resource_id=po.id, actor=admin,
                 summary=f"Purchase order {po.po_number}: {STATUS_LABELS[target].lower()}",
                 changes=audit.diff({"status": source}, {"status": target}),
                 details={"supplierId": po.supplier_id, "note": note} if note else {"supplierId": po.supplier_id})
    db.commit()
    return _load(db, po.id, fresh=True)


def cancel(db: Session, admin, po_id: str, payload: dict) -> PurchaseOrder:
    _load(db, po_id)
    reason = text(payload or {}, "reason", max_len=300, label="The reason", required=True, code="REASON_REQUIRED")
    po = _locked_po(db, po_id)
    received = db.execute(select(func.count()).select_from(GoodsReceipt)
                          .where(GoodsReceipt.purchase_order_id == po.id)).scalar() or 0
    if received or po.status in ("partially-received", "received"):
        raise ConflictError("Goods have already been received against this purchase order; it can't be cancelled.",
                            error_code="PO_HAS_RECEIPTS")
    if po.status not in CANCELLABLE:
        raise _transition_error(po, "cancelled")
    before = po.status
    now = datetime.utcnow()
    po.status, po.cancelled_at, po.cancel_reason = "cancelled", now, reason
    _event(po, "cancelled", admin.id, reason, at=now)
    audit.record(db, "purchase-order.cancel", resource_type="purchase-order", resource_id=po.id, actor=admin,
                 summary=f"Cancelled purchase order {po.po_number}: {reason}"[:300],
                 changes=audit.diff({"status": before}, {"status": "cancelled"}),
                 details={"supplierId": po.supplier_id, "reason": reason})
    db.commit()
    return _load(db, po.id, fresh=True)


# ----------------------------------------------------------------- receiving


def _receipt_by_key(db: Session, key: str) -> Optional[GoodsReceipt]:
    return db.execute(select(GoodsReceipt).where(GoodsReceipt.idempotency_key == key)).scalar_one_or_none()


def _replay(db: Session, receipt: GoodsReceipt, po_id: str) -> PurchaseOrder:
    if receipt.purchase_order_id != po_id:
        raise ConflictError("That idempotency key was already used for another purchase order.",
                            error_code="IDEMPOTENCY_KEY_REUSED", details={"field": "idempotencyKey"})
    return _load(db, po_id, fresh=True)


def _received_at(value: Any, now: datetime) -> datetime:
    if value in (None, ""):
        return now
    parsed = parse_dt(value) if isinstance(value, str) else None
    if parsed is None:
        raise invalid("Use a date like 2026-10-15.", "INVALID_DATE", "receivedAt")
    date_only = isinstance(value, str) and re.fullmatch(r"\s*\d{4}-\d{2}-\d{2}\s*", value) is not None
    if parsed.date() > now.date() or (not date_only and parsed > now + timedelta(minutes=5)):
        raise invalid("The receiving date can't be in the future.", "RECEIVED_AT_IN_FUTURE", "receivedAt")
    if date_only and parsed.date() == now.date():
        return now
    return parsed


def _receipt_lines(payload: dict) -> List[dict]:
    raw_items = payload.get("items")
    if raw_items is None or raw_items == []:
        raise invalid("Enter what was received.", "NO_ITEMS", "items")
    if not isinstance(raw_items, list):
        raise invalid("The items must be a list.", "INVALID_ITEMS", "items")
    if len(raw_items) > MAX_ITEMS:
        raise invalid(f"A receipt can have at most {MAX_ITEMS} lines.", "TOO_MANY_ITEMS", "items")
    lines, seen = [], set()
    for index, raw in enumerate(raw_items):
        if not isinstance(raw, dict):
            raise invalid("Each item must be an object.", "INVALID_ITEMS", f"items[{index}]")
        item_id = integer(raw.get("poItemId"), field=f"items[{index}].poItemId", label="The PO line", minimum=1,
                          maximum=2_147_483_647, code="UNKNOWN_PO_ITEM")
        if item_id in seen:
            raise invalid("Each PO line can appear only once.", "DUPLICATE_ITEM", f"items[{index}].poItemId")
        seen.add(item_id)
        counts = {}
        for key in ("receivedQty", "damagedQty", "rejectedQty"):
            value = raw.get(key)
            counts[key] = integer(0 if value in (None, "") else value, field=f"items[{index}].{key}",
                                  label="The quantity", minimum=0, maximum=MAX_QUANTITY, code="INVALID_QUANTITY")
        if counts["damagedQty"] + counts["rejectedQty"] > counts["receivedQty"]:
            raise invalid("Damaged and rejected units can't be more than the units received.",
                          "INVALID_RECEIPT_QUANTITIES", f"items[{index}].damagedQty", poItemId=item_id)
        lines.append({"index": index, "item_id": item_id, **counts,
                      "note": text(raw, "note", max_len=300, label="The note")})
    if not any(line["receivedQty"] > 0 for line in lines):
        raise invalid("Enter at least one received quantity above zero.", "NOTHING_RECEIVED", "items")
    return [line for line in lines if line["receivedQty"] > 0]


def receive(db: Session, admin, po_id: str, payload: dict) -> PurchaseOrder:
    from app.services import products as product_service

    key = text(payload, "idempotencyKey", max_len=80, label="The idempotency key", required=True,
               code="IDEMPOTENCY_KEY_REQUIRED")
    earlier = _receipt_by_key(db, key)
    if earlier is not None:
        return _replay(db, earlier, po_id)

    _load(db, po_id)
    now = datetime.utcnow()
    received_at = _received_at(payload.get("receivedAt"), now)
    notes = text(payload, "notes", max_len=1000, label="The notes")
    allow_over = flag(payload.get("allowOverReceipt"), field="allowOverReceipt", label="Allow over-receipt")
    over_reason = text(payload, "overReceiptReason", max_len=300, label="The over-receipt reason")
    lines = _receipt_lines(payload)

    # Under a lock from here: the PO, then its lines, then (in receive_stock) the
    # products in id order. Everything below reads the rows as committed.
    po = _locked_po(db, po_id)
    items = {item.id: item for item in db.execute(
        select(PurchaseOrderItem).where(PurchaseOrderItem.purchase_order_id == po.id)
        .order_by(PurchaseOrderItem.id).with_for_update().execution_options(populate_existing=True)).scalars()}
    if po.status not in RECEIVABLE:
        raise _transition_error(po, "received")

    over = []
    for line in lines:
        item = items.get(line["item_id"])
        if item is None:
            raise invalid("That line isn't on this purchase order.", "UNKNOWN_PO_ITEM",
                          f"items[{line['index']}].poItemId", poItemId=line["item_id"])
        line["item"] = item
        if line["receivedQty"] > outstanding(item):
            over.append({"poItemId": item.id, "productId": item.product_id, "outstanding": outstanding(item),
                         "received": line["receivedQty"]})
    if over and not allow_over:
        raise ValidationError("More than is outstanding was entered. Tick 'allow over-receipt' and give a reason "
                              "to accept it.", error_code="OVER_RECEIPT",
                              details={"field": "items", "lines": over})
    if over and not over_reason:
        raise ValidationError("Give a reason for receiving more than was ordered.", error_code="OVER_RECEIPT",
                              details={"field": "overReceiptReason", "lines": over})

    statuses = dict(db.execute(select(Product.id, Product.status).where(
        Product.id.in_([line["item"].product_id for line in lines]))).all())
    for line in lines:
        if statuses.get(line["item"].product_id) == "archived":
            raise ValidationError(f"{line['item'].name} is archived; restore it before receiving stock.",
                                  error_code="PRODUCT_ARCHIVED",
                                  details={"field": f"items[{line['index']}].poItemId",
                                           "productId": line["item"].product_id})

    stocked: List[str] = []
    try:
        number = numbering.next_yearly(db, numbering.GOODS_RECEIPT, GoodsReceipt.receipt_number, now)
        receipt = GoodsReceipt(receipt_number=number, purchase_order_id=po.id, received_at=received_at,
                               notes=notes, idempotency_key=key, over_receipt_reason=over_reason if over else "",
                               created_by=admin.id)
        db.add(receipt)
        db.flush()  # the idempotency key's unique index decides a race here
        totals = {"received": 0, "damaged": 0, "rejected": 0, "accepted": 0}
        for line in sorted(lines, key=lambda l: (l["item"].product_id, l["item"].id)):
            item = line["item"]
            accepted = line["receivedQty"] - line["damagedQty"] - line["rejectedQty"]
            item.received_qty += line["receivedQty"]
            item.damaged_qty += line["damagedQty"]
            item.rejected_qty += line["rejectedQty"]
            receipt.items.append(GoodsReceiptItem(
                purchase_order_item_id=item.id, product_id=item.product_id, received_qty=line["receivedQty"],
                damaged_qty=line["damagedQty"], rejected_qty=line["rejectedQty"], accepted_qty=accepted,
                note=line["note"]))
            if accepted > 0:
                product_service.receive_stock(db, item.product_id, quantity=accepted, reason="purchase-receipt",
                                              note=f"Purchase order {po.po_number}, goods receipt {number}",
                                              actor=admin.id)
                stocked.append(item.product_id)
            totals["received"] += line["receivedQty"]
            totals["damaged"] += line["damagedQty"]
            totals["rejected"] += line["rejectedQty"]
            totals["accepted"] += accepted

        before = po.status
        complete = all(item.received_qty >= item.quantity for item in items.values())
        po.status = "received" if complete else "partially-received"
        if complete:
            # When the goods arrived (the latest receipt's date), not when they
            # were entered: a receipt can be backdated, and the supplier's lead
            # time and on-time rate are worked out from this.
            latest = db.execute(select(func.max(GoodsReceipt.received_at))
                                .where(GoodsReceipt.purchase_order_id == po.id)).scalar()
            po.received_at = max(latest or received_at, received_at)
        summary = (f"Goods receipt {number}: {totals['received']} received, {totals['accepted']} accepted"
                   + (f", {totals['damaged']} damaged" if totals["damaged"] else "")
                   + (f", {totals['rejected']} rejected" if totals["rejected"] else ""))
        _event(po, po.status, admin.id, summary, at=now)
        audit.record(db, "goods-receipt.create", resource_type="goods-receipt", resource_id=number, actor=admin,
                     summary=f"{po.po_number}: {summary}"[:300],
                     changes=audit.diff({"status": before}, {"status": po.status}),
                     details={"supplierId": po.supplier_id, "purchaseOrderId": po.id, "receiptNumber": number,
                              **totals, **({"overReceiptReason": over_reason} if over else {})})
        db.commit()
    except IntegrityError:
        db.rollback()
        winner = _receipt_by_key(db, key)
        if winner is not None:
            return _replay(db, winner, po_id)
        raise ConflictError("This receipt couldn't be saved because of a conflicting change. Please try again.",
                            error_code="RECEIPT_CONFLICT") from None

    from app.services import alerts

    for product_id in dict.fromkeys(stocked):
        alerts.process_product(db, product_id)
    return _load(db, po_id, fresh=True)
