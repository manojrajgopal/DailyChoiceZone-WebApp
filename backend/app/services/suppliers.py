"""
The supplier directory and what each supplier provides.

Internal purchasing data, admin only: suppliers never sign in and nothing here
reaches the storefront. A supplier-product link records what the store *pays*
(paise, as in billing); it never touches what the store *charges* - the
product's selling price is the catalogue's alone.

See docs/shipping-and-suppliers.md, sections 5 and 6 ("Admin: suppliers").

Validation is done here, field by field, rather than by a request schema, so
every refusal carries its own `error_code` and the field it is about
(`details: {"field": ...}`), which is what the portal's forms consume.
"""

from __future__ import annotations

import math
import re
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import (
    AuditLog,
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
from app.utils.ids import next_id

STATUSES = ("active", "inactive", "archived")
LINK_STATUSES = ("active", "inactive")
TAX_TREATMENTS = ("registered", "unregistered", "composition", "overseas")
# Statuses in which a purchase order is still "open" (not finished, not cancelled).
OPEN_PO_STATUSES = ("draft", "submitted", "sent", "acknowledged", "partially-received")
SORTS = {"name", "code", "createdAt"}

MAX_PURCHASE_COST = Decimal("10000000")
MAX_QUANTITY = 1_000_000
HISTORY_LIMIT = 50
# Lead time and on-time rate are only meaningful with a few deliveries behind them.
MIN_POS_FOR_PERFORMANCE = 3

_CODE = re.compile(r"^[A-Z0-9-]{2,30}$")
_GSTIN = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")
_PAN = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$")
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$")
_PHONE_IN = re.compile(r"^[6-9][0-9]{9}$")
_PHONE_INTL = re.compile(r"^\+[1-9][0-9]{7,14}$")
_PINCODE = re.compile(r"^[1-9][0-9]{5}$")
_CURRENCY = re.compile(r"^[A-Z]{3}$")
_GST_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
# GST state codes in use: 01-38, 97 (other territory), 99 (centre jurisdiction).
_GST_STATES = {f"{n:02d}" for n in range(1, 39)} | {"97", "99"}

ADDRESS_FIELDS = (("line1", 200), ("line2", 200), ("city", 80), ("state", 80), ("country", 60), ("pincode", 12))


# ------------------------------------------------------------ field checks


def invalid(message: str, code: str, field: str, **extra) -> ValidationError:
    return ValidationError(message, error_code=code, details={"field": field, **extra})


def text(data: dict, key: str, *, max_len: int, label: str, required: bool = False,
         code: str = "INVALID_FIELD", default: str = "") -> str:
    """A trimmed string; None counts as empty. Anything else that isn't text is refused."""
    value = data.get(key, default)
    if value is None:
        value = ""
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise invalid(f"{label} must be text.", code, key)
    value = str(value).strip()
    if required and not value:
        raise invalid(f"{label} is required.", code if code != "INVALID_FIELD" else "FIELD_REQUIRED", key)
    if len(value) > max_len:
        raise invalid(f"{label} can be at most {max_len} characters.", code, key)
    return value


def integer(value: Any, *, field: str, label: str, minimum: int, maximum: int, code: str,
            allow_none: bool = False) -> Optional[int]:
    """A whole number in a range. Booleans and fractions are refused; "5" and 5.0 are accepted."""
    if value is None or value == "":
        if allow_none:
            return None
        raise invalid(f"{label} is required.", code, field)
    if isinstance(value, bool):
        raise invalid(f"{label} must be a whole number.", code, field)
    number: Optional[int] = None
    if isinstance(value, int):
        number = value
    elif isinstance(value, float) and math.isfinite(value) and value.is_integer():
        number = int(value)
    elif isinstance(value, str) and re.fullmatch(r"\s*-?[0-9]{1,9}\s*", value):
        number = int(value)
    if number is None:
        raise invalid(f"{label} must be a whole number.", code, field)
    if number < minimum or number > maximum:
        raise invalid(f"{label} must be between {minimum:,} and {maximum:,}.", code, field,
                      minimum=minimum, maximum=maximum)
    return number


def decimal(value: Any, *, field: str, label: str, code: str) -> Decimal:
    """A finite number (or numeric text) as an exact Decimal."""
    if value is None or value == "" or isinstance(value, bool):
        raise invalid(f"{label} is required.", code, field)
    if not isinstance(value, (int, float, str, Decimal)):
        raise invalid(f"{label} must be a number.", code, field)
    try:
        number = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        raise invalid(f"{label} must be a number.", code, field) from None
    if not number.is_finite():
        raise invalid(f"{label} must be a number.", code, field)
    return number


def money(value: Any, *, field: str, label: str, code: str) -> int:
    """Rupees on the wire, above zero and at most 1 crore, to paise."""
    amount = decimal(value, field=field, label=label, code=code)
    if amount <= 0 or amount > MAX_PURCHASE_COST:
        raise invalid(f"{label} must be above 0 and at most 10,000,000.", code, field)
    paise = billing.to_minor(amount)
    if paise <= 0:
        raise invalid(f"{label} must be at least 0.01.", code, field)
    return paise


def flag(value: Any, *, field: str, label: str, default: bool = False) -> bool:
    if value is None:
        return default
    if not isinstance(value, bool):
        raise invalid(f"{label} must be true or false.", "INVALID_FIELD", field)
    return value


def gstin_check_character(first14: str) -> str:
    """
    The 15th character of a GSTIN: the mod-36 checksum over the first 14.

    Each character's value in 0-9A-Z is multiplied by 1 and 2 alternately
    (1 for the first); each product contributes quotient + remainder of a
    division by 36; the check character is (36 - sum mod 36) mod 36.
    """
    total = 0
    for index, char in enumerate(first14):
        product = _GST_CHARS.index(char) * (2 if index % 2 else 1)
        total += product // 36 + product % 36
    return _GST_CHARS[(36 - total % 36) % 36]


def is_valid_gstin(value: str) -> bool:
    if not value or not _GSTIN.match(value) or value[:2] not in _GST_STATES:
        return False
    return gstin_check_character(value[:14]) == value[14]


def normalise_phone(value: str) -> str:
    """Spaces, hyphens, dots and brackets dropped: '+91 98765-43210' -> '+919876543210'."""
    return re.sub(r"[\s\-().]", "", value or "")


def is_valid_phone(value: str) -> bool:
    return bool(_PHONE_IN.match(value) or _PHONE_INTL.match(value))


def _address(value: Any, field: str) -> Optional[dict]:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise invalid("The address must be an object.", "INVALID_ADDRESS", field)
    out: Dict[str, str] = {}
    for key, limit in ADDRESS_FIELDS:
        part = value.get(key, "")
        if part is None:
            part = ""
        if isinstance(part, int) and not isinstance(part, bool) and key == "pincode":
            part = str(part)
        if not isinstance(part, str):
            raise invalid(f"The address {key} must be text.", "INVALID_ADDRESS", f"{field}.{key}")
        part = part.strip()
        if len(part) > limit:
            raise invalid(f"The address {key} can be at most {limit} characters.", "INVALID_ADDRESS",
                          f"{field}.{key}")
        out[key] = part
    if not out["country"] or out["country"].lower() == "india":
        out["country"] = "India"
    if out["country"] == "India" and out["pincode"] and not _PINCODE.match(out["pincode"]):
        raise invalid("An Indian pincode is 6 digits.", "INVALID_PINCODE", f"{field}.pincode")
    return out


def _blank_address() -> dict:
    return {"line1": "", "line2": "", "city": "", "state": "", "country": "India", "pincode": ""}


def validate_supplier(data: dict) -> dict:
    """
    A complete supplier (the stored one with the request laid over it, for an
    update), checked and normalised, as model attributes. `code` may be "" (to
    be generated).
    """
    code = text(data, "code", max_len=60, label="The code", code="INVALID_SUPPLIER_CODE").upper()
    if code and not _CODE.match(code):
        raise invalid("The code is 2-30 uppercase letters, digits and hyphens.", "INVALID_SUPPLIER_CODE", "code")

    name = text(data, "name", max_len=160, label="The name", required=True, code="NAME_REQUIRED")
    legal_name = text(data, "legalName", max_len=200, label="The legal name")
    contact_person = text(data, "contactPerson", max_len=120, label="The contact person")

    phone = normalise_phone(text(data, "phone", max_len=30, label="The phone number", code="INVALID_PHONE"))
    if phone and not is_valid_phone(phone):
        raise invalid("Enter a 10-digit Indian mobile number, or an international number starting with +.",
                      "INVALID_PHONE", "phone")

    email = text(data, "email", max_len=255, label="The email", code="INVALID_EMAIL").lower()
    if email and not _EMAIL.match(email):
        raise invalid("Enter a valid email address.", "INVALID_EMAIL", "email")

    website = text(data, "website", max_len=255, label="The website", code="INVALID_WEBSITE")
    if website:
        if not re.match(r"^https?://", website, re.IGNORECASE):
            website = f"https://{website}"
        if re.search(r"\s", website) or "." not in website.split("://", 1)[1] or len(website) > 255:
            raise invalid("Enter a valid website address.", "INVALID_WEBSITE", "website")

    tax_treatment = text(data, "taxTreatment", max_len=20, label="The tax treatment", code="INVALID_TAX_TREATMENT")
    gstin = text(data, "gstin", max_len=20, label="The GSTIN", code="INVALID_GSTIN").upper().replace(" ", "")
    pan = text(data, "pan", max_len=12, label="The PAN", code="INVALID_PAN").upper().replace(" ", "")
    if not tax_treatment:
        tax_treatment = "registered" if gstin else "unregistered"
    tax_treatment = tax_treatment.lower()
    if tax_treatment not in TAX_TREATMENTS:
        raise invalid("The tax treatment is registered, unregistered, composition or overseas.",
                      "INVALID_TAX_TREATMENT", "taxTreatment")
    if gstin and not is_valid_gstin(gstin):
        raise invalid("That GSTIN isn't valid. Check the 15 characters, including the last (check) one.",
                      "INVALID_GSTIN", "gstin")
    if tax_treatment == "registered" and not gstin:
        raise invalid("A GST-registered supplier needs a GSTIN.", "GSTIN_REQUIRED", "gstin")
    if pan and not _PAN.match(pan):
        raise invalid("A PAN is 5 letters, 4 digits and a letter (ABCDE1234F).", "INVALID_PAN", "pan")
    if pan and gstin and gstin[2:12] != pan:
        raise invalid("The PAN doesn't match the one inside the GSTIN (characters 3-12).", "PAN_GSTIN_MISMATCH",
                      "pan")

    business_type = text(data, "businessType", max_len=40, label="The business type").lower()

    billing_address = _address(data.get("billingAddress"), "billingAddress") or _blank_address()
    warehouse_address = _address(data.get("warehouseAddress"), "warehouseAddress")
    if warehouse_address is not None and not any(v for k, v in warehouse_address.items() if k != "country"):
        warehouse_address = None

    payment_terms = text(data, "paymentTerms", max_len=120, label="The payment terms")
    credit_days = integer(data.get("creditDays"), field="creditDays", label="Credit days", minimum=0, maximum=365,
                          code="INVALID_CREDIT_DAYS", allow_none=True)
    currency = (text(data, "currency", max_len=3, label="The currency", code="INVALID_CURRENCY") or "INR").upper()
    if not _CURRENCY.match(currency):
        raise invalid("The currency is a 3-letter code such as INR.", "INVALID_CURRENCY", "currency")
    notes = text(data, "notes", max_len=5000, label="The notes")

    return {
        "code": code, "name": name, "legal_name": legal_name, "contact_person": contact_person,
        "phone": phone, "email": email, "website": website, "gstin": gstin or None, "pan": pan or None,
        "business_type": business_type, "tax_treatment": tax_treatment, "billing_address": billing_address,
        "warehouse_address": warehouse_address, "payment_terms": payment_terms, "credit_days": credit_days,
        "currency": currency, "notes": notes,
    }


# ------------------------------------------------------------------- views


def _full_address(value: Optional[dict]) -> dict:
    out = _blank_address()
    out.update({k: (value or {}).get(k, out[k]) or out[k] for k in out})
    return out


def supplier_view(supplier: Supplier) -> dict:
    return {
        "id": supplier.id, "code": supplier.code, "name": supplier.name, "legalName": supplier.legal_name,
        "contactPerson": supplier.contact_person, "phone": supplier.phone, "email": supplier.email,
        "website": supplier.website, "status": supplier.status, "gstin": supplier.gstin or None,
        "pan": supplier.pan or None, "businessType": supplier.business_type,
        "taxTreatment": supplier.tax_treatment,
        "billingAddress": _full_address(supplier.billing_address),
        "warehouseAddress": _full_address(supplier.warehouse_address) if supplier.warehouse_address else None,
        "paymentTerms": supplier.payment_terms, "creditDays": supplier.credit_days,
        "currency": supplier.currency, "notes": supplier.notes,
        "createdAt": supplier.created_at, "updatedAt": supplier.updated_at, "createdBy": supplier.created_by,
    }


def _audit_view(supplier: Supplier) -> dict:
    view = supplier_view(supplier)
    for key in ("createdAt", "updatedAt", "createdBy", "id"):
        view.pop(key, None)
    return view


def _input_view(supplier: Supplier) -> dict:
    """The stored supplier in request shape, for laying an update over."""
    view = supplier_view(supplier)
    view["gstin"] = supplier.gstin or ""
    view["pan"] = supplier.pan or ""
    return view


def link_view(link: SupplierProduct, supplier_name: str, supplier_status: str, product_name: str,
              product_sku: str, product_status: str) -> dict:
    return {
        "id": link.id, "supplierId": link.supplier_id, "supplierName": supplier_name,
        "supplierStatus": supplier_status, "productId": link.product_id, "productName": product_name,
        "productSku": product_sku, "productStatus": product_status, "supplierSku": link.supplier_sku,
        "purchaseCost": billing.to_major(link.purchase_cost), "moq": link.moq, "leadTimeDays": link.lead_time_days,
        "status": link.status, "preferred": bool(link.preferred), "notes": link.notes,
        "createdAt": link.created_at, "updatedAt": link.updated_at,
    }


def _link_rows(db: Session, *conditions) -> List[dict]:
    """Links with their supplier and product names, in one query (no product images loaded)."""
    rows = db.execute(
        select(SupplierProduct, Supplier.name, Supplier.status, Product.name, Product.sku, Product.status)
        .join(Supplier, Supplier.id == SupplierProduct.supplier_id)
        .join(Product, Product.id == SupplierProduct.product_id)
        .where(*conditions)
        .order_by(SupplierProduct.preferred.desc(), Product.name, Supplier.name, SupplierProduct.id)
    ).all()
    return [link_view(*row) for row in rows]


# ---------------------------------------------------------------- lookups


def get_supplier(db: Session, supplier_id: Any) -> Supplier:
    supplier = db.get(Supplier, supplier_id) if isinstance(supplier_id, str) and supplier_id else None
    if supplier is None:
        raise NotFoundError("We couldn't find that supplier.", error_code="SUPPLIER_NOT_FOUND")
    return supplier


def get_link(db: Session, link_id: int) -> SupplierProduct:
    link = db.get(SupplierProduct, link_id)
    if link is None:
        raise NotFoundError("We couldn't find that supplier product.", error_code="SUPPLIER_PRODUCT_NOT_FOUND")
    return link


def _product(db: Session, product_id: Any) -> Product:
    product = db.get(Product, product_id) if isinstance(product_id, str) and product_id.strip() else None
    if product is None:
        raise NotFoundError("We couldn't find that product.", error_code="PRODUCT_NOT_FOUND",
                            details={"field": "productId"})
    return product


def _code_taken(db: Session, code: str, exclude_id: Optional[str] = None) -> bool:
    # The column's collation is case-insensitive and codes are stored upper-case,
    # so this equality is both indexed and case-blind.
    query = select(Supplier.id).where(Supplier.code == code)
    if exclude_id:
        query = query.where(Supplier.id != exclude_id)
    return db.execute(query.limit(1)).first() is not None


def _code_conflict() -> ConflictError:
    return ConflictError("Another supplier already uses that code.", error_code="SUPPLIER_CODE_TAKEN",
                         details={"field": "code"})


# --------------------------------------------------------------- suppliers


def list_suppliers(db: Session, *, q: str = "", status: str = "", sort: str = "name", page: int = 1,
                   page_size: int = 25) -> Tuple[List[dict], int, dict]:
    # `q` is a Supplier ID — `SUP001` or the supplier's code — matched exactly
    # (docs/id-lookup.md): never a name, GSTIN, contact, email or phone.
    from app.services.lookup.filters import id_condition

    conditions = []
    by_id = id_condition("supplier", q)
    if by_id is not None:
        conditions.append(by_id)

    counts = {s: 0 for s in STATUSES}
    for value, count in db.execute(
        select(Supplier.status, func.count()).where(*conditions).group_by(Supplier.status)
    ).all():
        counts[value] = int(count)

    status = status if status in STATUSES else ""
    filtered = conditions + ([Supplier.status == status] if status else [Supplier.status != "archived"])
    total = int(db.execute(select(func.count()).select_from(Supplier).where(*filtered)).scalar() or 0)

    order = {"code": [Supplier.code.asc()], "createdAt": [Supplier.created_at.desc(), Supplier.id.desc()]}.get(
        sort, [Supplier.name.asc(), Supplier.id.asc()])
    suppliers = db.execute(
        select(Supplier).where(*filtered).order_by(*order).offset((page - 1) * page_size).limit(page_size)
    ).scalars().all()

    ids = [s.id for s in suppliers]
    product_counts: Dict[str, int] = {}
    open_counts: Dict[str, int] = {}
    if ids:
        product_counts = dict(db.execute(
            select(SupplierProduct.supplier_id, func.count()).where(SupplierProduct.supplier_id.in_(ids))
            .group_by(SupplierProduct.supplier_id)).all())
        open_counts = dict(db.execute(
            select(PurchaseOrder.supplier_id, func.count())
            .where(PurchaseOrder.supplier_id.in_(ids), PurchaseOrder.status.in_(OPEN_PO_STATUSES))
            .group_by(PurchaseOrder.supplier_id)).all())

    items = [{**supplier_view(s), "productCount": int(product_counts.get(s.id, 0)),
              "openPoCount": int(open_counts.get(s.id, 0))} for s in suppliers]
    return items, total, counts


def _generated_code(db: Session, supplier_id: str) -> str:
    code, suffix = supplier_id, 1
    while _code_taken(db, code):
        suffix += 1
        code = f"{supplier_id}-{suffix}"
    return code


def create_supplier(db: Session, admin, payload: dict) -> Supplier:
    clean = validate_supplier(payload)
    status = text(payload, "status", max_len=12, label="The status", code="INVALID_STATUS").lower() or "active"
    if status not in ("active", "inactive"):
        raise invalid("A new supplier is active or inactive.", "INVALID_STATUS", "status")

    code = clean.pop("code")
    if code and _code_taken(db, code):
        raise _code_conflict()
    supplier_id = next_id(db, Supplier, "supplier")
    code = code or _generated_code(db, supplier_id)
    supplier = Supplier(id=supplier_id, code=code, status=status, created_by=admin.id, **clean)
    try:
        db.add(supplier)
        db.flush()
        audit.record(db, "supplier.create", resource_type="supplier", resource_id=supplier.id, actor=admin,
                     summary=f"Added supplier {supplier.name} ({supplier.code})",
                     changes=audit.diff({}, _audit_view(supplier)))
        db.commit()
    except IntegrityError:
        db.rollback()
        raise _code_conflict() from None
    db.refresh(supplier)
    return supplier


def update_supplier(db: Session, admin, supplier_id: str, payload: dict) -> Supplier:
    supplier = get_supplier(db, supplier_id)
    before = _audit_view(supplier)
    merged = {**_input_view(supplier), **{k: v for k, v in payload.items() if k not in ("id", "status")}}
    clean = validate_supplier(merged)
    code = clean.pop("code") or supplier.code
    if code != supplier.code and _code_taken(db, code, exclude_id=supplier.id):
        raise _code_conflict()
    supplier.code = code
    for key, value in clean.items():
        setattr(supplier, key, value)
    try:
        db.flush()
        after = _audit_view(supplier)
        changes = audit.diff(before, after)
        if changes:
            audit.record(db, "supplier.update", resource_type="supplier", resource_id=supplier.id, actor=admin,
                         summary=f"Updated supplier {supplier.name} ({supplier.code})", changes=changes)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise _code_conflict() from None
    db.refresh(supplier)
    return supplier


def open_po_count(db: Session, supplier_id: str) -> int:
    return int(db.execute(select(func.count()).select_from(PurchaseOrder).where(
        PurchaseOrder.supplier_id == supplier_id, PurchaseOrder.status.in_(OPEN_PO_STATUSES))).scalar() or 0)


def set_status(db: Session, admin, supplier_id: str, payload: dict) -> Supplier:
    supplier = get_supplier(db, supplier_id)
    status = text(payload, "status", max_len=12, label="The status", required=True, code="INVALID_STATUS").lower()
    if status not in STATUSES:
        raise invalid("The status is active, inactive or archived.", "INVALID_STATUS", "status")
    if status == supplier.status:
        return supplier
    if status == "archived":
        open_count = open_po_count(db, supplier.id)
        if open_count:
            raise ConflictError(
                f"This supplier has {open_count} open purchase order(s). Receive or cancel them before archiving.",
                error_code="SUPPLIER_HAS_OPEN_POS", details={"openPoCount": open_count})
    before = supplier.status
    supplier.status = status
    verb = {"active": "Activated", "inactive": "Deactivated", "archived": "Archived"}[status]
    if before == "archived" and status != "archived":
        verb = "Restored"
    audit.record(db, f"supplier.{'restore' if verb == 'Restored' else status}", resource_type="supplier",
                 resource_id=supplier.id, actor=admin, summary=f"{verb} supplier {supplier.name}",
                 changes=audit.diff({"status": before}, {"status": status}))
    db.commit()
    db.refresh(supplier)
    return supplier


# ---------------------------------------------------------- supplier detail


def _days(start: datetime, end: datetime) -> float:
    return (end - start).total_seconds() / 86400


def stats(db: Session, supplier_id: str) -> dict:
    """Figures from the supplier's real links, POs and receipts. Never estimated."""
    product_count, active_count = db.execute(
        select(func.count(), func.coalesce(func.sum(func.if_(SupplierProduct.status == "active", 1, 0)), 0))
        .where(SupplierProduct.supplier_id == supplier_id)).one()

    by_status = dict(db.execute(
        select(PurchaseOrder.status, func.count()).where(PurchaseOrder.supplier_id == supplier_id)
        .group_by(PurchaseOrder.status)).all())
    po_count = int(sum(by_status.values()))
    open_count = int(sum(by_status.get(s, 0) for s in OPEN_PO_STATUSES))

    committed = ("submitted", "sent", "acknowledged", "partially-received", "received")
    value = db.execute(select(func.coalesce(func.sum(PurchaseOrder.total), 0)).where(
        PurchaseOrder.supplier_id == supplier_id, PurchaseOrder.status.in_(committed))).scalar() or 0

    outstanding = db.execute(
        select(func.coalesce(func.sum(func.greatest(PurchaseOrderItem.quantity - PurchaseOrderItem.received_qty, 0)), 0))
        .join(PurchaseOrder, PurchaseOrder.id == PurchaseOrderItem.purchase_order_id)
        .where(PurchaseOrder.supplier_id == supplier_id,
               PurchaseOrder.status.in_(("submitted", "sent", "acknowledged", "partially-received")))
    ).scalar() or 0

    received = db.execute(
        select(PurchaseOrder.sent_at, PurchaseOrder.submitted_at, PurchaseOrder.expected_at,
               PurchaseOrder.received_at)
        .where(PurchaseOrder.supplier_id == supplier_id, PurchaseOrder.status == "received",
               PurchaseOrder.received_at.is_not(None))).all()
    # Never below zero: a receipt dated before the PO was marked sent (an order
    # placed by phone and entered afterwards) arrived "immediately", not early.
    lead_times = [max(0.0, _days(start, row.received_at)) for row in received
                  for start in [row.sent_at or row.submitted_at] if start is not None]
    average_lead = (round(sum(lead_times) / len(lead_times), 1)
                    if len(lead_times) >= MIN_POS_FOR_PERFORMANCE else None)
    with_expected = [row for row in received if row.expected_at is not None]
    on_time_rate = None
    if len(with_expected) >= MIN_POS_FOR_PERFORMANCE:
        on_time = sum(1 for row in with_expected if row.received_at.date() <= row.expected_at.date())
        on_time_rate = round(100.0 * on_time / len(with_expected), 1)

    return {
        "productCount": int(product_count or 0), "activeProductCount": int(active_count or 0),
        "poCount": po_count, "openPoCount": open_count, "receivedPoCount": int(by_status.get("received", 0)),
        "totalPurchaseValue": billing.to_major(int(value)), "outstandingQuantity": int(outstanding),
        "averageLeadTimeDays": average_lead, "onTimeRate": on_time_rate,
    }


def recent_deliveries(db: Session, supplier_id: str, limit: int = 5) -> List[dict]:
    rows = db.execute(
        select(GoodsReceipt, PurchaseOrder.po_number)
        .join(PurchaseOrder, PurchaseOrder.id == GoodsReceipt.purchase_order_id)
        .where(PurchaseOrder.supplier_id == supplier_id)
        .order_by(GoodsReceipt.received_at.desc(), GoodsReceipt.id.desc()).limit(limit)
    ).all()
    ids = [receipt.id for receipt, _ in rows]
    totals: Dict[int, tuple] = {}
    if ids:
        for receipt_id, rec, dmg, rej, acc in db.execute(
            select(GoodsReceiptItem.receipt_id, func.sum(GoodsReceiptItem.received_qty),
                   func.sum(GoodsReceiptItem.damaged_qty), func.sum(GoodsReceiptItem.rejected_qty),
                   func.sum(GoodsReceiptItem.accepted_qty))
            .where(GoodsReceiptItem.receipt_id.in_(ids)).group_by(GoodsReceiptItem.receipt_id)).all():
            totals[receipt_id] = (int(rec or 0), int(dmg or 0), int(rej or 0), int(acc or 0))
    out = []
    for receipt, po_number in rows:
        rec, dmg, rej, acc = totals.get(receipt.id, (0, 0, 0, 0))
        out.append({"id": receipt.id, "receiptNumber": receipt.receipt_number,
                    "purchaseOrderId": receipt.purchase_order_id, "poNumber": po_number,
                    "receivedAt": receipt.received_at, "receivedQty": rec, "damagedQty": dmg, "rejectedQty": rej,
                    "acceptedQty": acc, "createdBy": receipt.created_by})
    return out


def history(db: Session, supplier_id: str, limit: int = HISTORY_LIMIT) -> List[dict]:
    """The supplier's own audit trail (and its product links') plus its POs' events, newest first."""
    entries = db.execute(
        select(AuditLog.occurred_at, AuditLog.action, AuditLog.summary, AuditLog.actor_id, AuditLog.id)
        .where(AuditLog.outcome == "success",
               or_(and_(AuditLog.resource_type == "supplier", AuditLog.resource_id == supplier_id),
                   and_(AuditLog.resource_type == "supplier-product",
                        AuditLog.details["supplierId"].as_string() == supplier_id)))
        .order_by(AuditLog.occurred_at.desc(), AuditLog.id.desc()).limit(limit)
    ).all()
    events = db.execute(
        select(PurchaseOrderEvent.occurred_at, PurchaseOrderEvent.status, PurchaseOrderEvent.note,
               PurchaseOrderEvent.actor, PurchaseOrder.po_number, PurchaseOrderEvent.id)
        .join(PurchaseOrder, PurchaseOrder.id == PurchaseOrderEvent.purchase_order_id)
        .where(PurchaseOrder.supplier_id == supplier_id)
        .order_by(PurchaseOrderEvent.occurred_at.desc(), PurchaseOrderEvent.id.desc()).limit(limit)
    ).all()
    from app.services.purchasing import STATUS_LABELS

    merged = [{"at": row.occurred_at, "action": row.action, "summary": row.summary, "actor": row.actor_id or ""}
              for row in entries]
    for row in events:
        summary = f"{row.po_number}: {STATUS_LABELS.get(row.status, row.status)}"
        if row.note:
            summary = f"{summary} - {row.note}"
        merged.append({"at": row.occurred_at, "action": f"purchase-order.{row.status}", "summary": summary[:300],
                       "actor": row.actor or ""})
    merged.sort(key=lambda entry: entry["at"], reverse=True)
    return merged[:limit]


def detail(db: Session, supplier_id: str) -> dict:
    supplier = get_supplier(db, supplier_id)
    return {**supplier_view(supplier), "stats": stats(db, supplier.id),
            "recentDeliveries": recent_deliveries(db, supplier.id), "history": history(db, supplier.id)}


# ------------------------------------------------------- supplier products


def supplier_products(db: Session, supplier_id: str) -> List[dict]:
    supplier = get_supplier(db, supplier_id)
    return _link_rows(db, SupplierProduct.supplier_id == supplier.id)


def product_suppliers(db: Session, product_id: str) -> List[dict]:
    product = _product(db, product_id)
    return _link_rows(db, SupplierProduct.product_id == product.id)


def one_link(db: Session, link_id: int) -> dict:
    rows = _link_rows(db, SupplierProduct.id == link_id)
    if not rows:
        raise NotFoundError("We couldn't find that supplier product.", error_code="SUPPLIER_PRODUCT_NOT_FOUND")
    return rows[0]


def _validate_link(data: dict) -> dict:
    status = text(data, "status", max_len=12, label="The status", code="INVALID_STATUS").lower() or "active"
    if status not in LINK_STATUSES:
        raise invalid("A supplier product is active or inactive.", "INVALID_STATUS", "status")
    return {
        "supplier_sku": text(data, "supplierSku", max_len=60, label="The supplier SKU"),
        "purchase_cost": money(data.get("purchaseCost"), field="purchaseCost", label="The purchase cost",
                               code="INVALID_PURCHASE_COST"),
        "moq": integer(data.get("moq", 1) if data.get("moq") is not None else 1, field="moq",
                       label="The minimum order quantity", minimum=1, maximum=MAX_QUANTITY, code="INVALID_MOQ"),
        "lead_time_days": integer(data.get("leadTimeDays"), field="leadTimeDays", label="The lead time",
                                  minimum=0, maximum=365, code="INVALID_LEAD_TIME", allow_none=True),
        "status": status,
        "preferred": flag(data.get("preferred"), field="preferred", label="Preferred"),
        "notes": text(data, "notes", max_len=1000, label="The notes"),
    }


def _link_audit(link: SupplierProduct) -> dict:
    return {"supplierSku": link.supplier_sku, "purchaseCost": billing.to_major(link.purchase_cost or 0),
            "moq": link.moq, "leadTimeDays": link.lead_time_days, "status": link.status,
            "preferred": bool(link.preferred), "notes": link.notes}


def _clear_other_preferred(db: Session, link: SupplierProduct) -> None:
    others = db.execute(select(SupplierProduct).where(
        SupplierProduct.product_id == link.product_id, SupplierProduct.id != link.id,
        SupplierProduct.preferred.is_(True))).scalars().all()
    for other in others:
        other.preferred = False


def _link_exists() -> ConflictError:
    return ConflictError("This supplier already has that product.", error_code="SUPPLIER_PRODUCT_EXISTS",
                         details={"field": "productId"})


def create_link(db: Session, admin, supplier_id: str, payload: dict) -> dict:
    supplier = get_supplier(db, supplier_id)
    if supplier.status == "archived":
        raise ConflictError("An archived supplier can't take new products.", error_code="SUPPLIER_INACTIVE")
    product_id = payload.get("productId")
    if not isinstance(product_id, str) or not product_id.strip():
        raise invalid("Choose a product.", "PRODUCT_REQUIRED", "productId")
    product = _product(db, product_id.strip())
    if product.status == "archived":
        raise ValidationError("An archived product can't be linked to a supplier.", error_code="PRODUCT_ARCHIVED",
                              details={"field": "productId"})
    clean = _validate_link(payload)
    if db.execute(select(SupplierProduct.id).where(SupplierProduct.supplier_id == supplier.id,
                                                   SupplierProduct.product_id == product.id)).first():
        raise _link_exists()

    link = SupplierProduct(supplier_id=supplier.id, product_id=product.id, **clean)
    try:
        db.add(link)
        db.flush()
        if link.preferred:
            _clear_other_preferred(db, link)
        audit.record(db, "supplier-product.create", resource_type="supplier-product", resource_id=link.id,
                     actor=admin, summary=f"Linked {product.name} to supplier {supplier.name}",
                     changes=audit.diff({}, _link_audit(link)),
                     details={"supplierId": supplier.id, "productId": product.id})
        db.commit()
    except IntegrityError:
        db.rollback()
        raise _link_exists() from None
    return one_link(db, link.id)


def update_link(db: Session, admin, link_id: int, payload: dict) -> dict:
    link = get_link(db, link_id)
    before = _link_audit(link)
    current = {"supplierSku": link.supplier_sku, "purchaseCost": billing.to_major(link.purchase_cost),
               "moq": link.moq, "leadTimeDays": link.lead_time_days, "status": link.status,
               "preferred": bool(link.preferred), "notes": link.notes}
    allowed = {k: v for k, v in payload.items() if k in current}
    clean = _validate_link({**current, **allowed})
    for key, value in clean.items():
        setattr(link, key, value)
    db.flush()
    if link.preferred:
        _clear_other_preferred(db, link)
    changes = audit.diff(before, _link_audit(link))
    if changes:
        supplier = db.get(Supplier, link.supplier_id)
        product_name = db.execute(select(Product.name).where(Product.id == link.product_id)).scalar() or ""
        audit.record(db, "supplier-product.update", resource_type="supplier-product", resource_id=link.id,
                     actor=admin, summary=f"Updated {product_name} for supplier {supplier.name}", changes=changes,
                     details={"supplierId": link.supplier_id, "productId": link.product_id})
    db.commit()
    return one_link(db, link.id)


def delete_link(db: Session, admin, link_id: int) -> None:
    link = get_link(db, link_id)
    supplier = db.get(Supplier, link.supplier_id)
    product_name = db.execute(select(Product.name).where(Product.id == link.product_id)).scalar() or ""
    audit.record(db, "supplier-product.delete", resource_type="supplier-product", resource_id=link.id, actor=admin,
                 summary=f"Removed {product_name} from supplier {supplier.name}",
                 changes=audit.diff(_link_audit(link), {}),
                 details={"supplierId": link.supplier_id, "productId": link.product_id})
    db.delete(link)
    db.commit()
