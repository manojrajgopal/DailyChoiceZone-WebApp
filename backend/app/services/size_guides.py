"""
Size guides: reusable size tables for any kind of product.

A guide is a table the store defines — its own columns, its own rows — so it
works as well for rings (ring size, circumference, diameter) and shoes (UK,
US, EU, foot length) as for shirts (chest, waist, length). See
`models.discovery.SizeGuide` for the shape.

## Which guide a product shows

    the product's own guide        (assigned on the product)
        ↓ otherwise, if the product comes in sizes
    its category's guide
        ↓ otherwise
    the store's default guide

An inactive guide is skipped at every step, as if it weren't assigned. A
product with no sizes shows a category or default guide only if it has been
given one of its own — a lamp shouldn't show the clothing chart.

## Sizes on the product and in the guide

The guide's rows are matched to the product's sizes by label (case and spacing
ignored). The response says which rows the product is sold in, and which of
the product's sizes the guide doesn't cover, so the portal can warn and the
storefront can highlight the size the shopper picked.

## Units

Measurements are stored in the guide's own unit and converted on the way out
with exact factors (1 in = 2.54 cm, by definition) through `Decimal`, rounded
once, at the end, to one decimal place — so 92 cm reads 36.2 in, never a
value that drifted through a float.

## "Find my size", later

Measurement cells are numbers (`{min, max}`), not text, which is what a future
size finder would compare a shopper's measurements against. Nothing about the
shopper is collected here.
"""

from __future__ import annotations

import logging
import re
from decimal import ROUND_HALF_UP, Decimal
from typing import Iterable, List, Optional, Tuple

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import (
    Category,
    Product,
    ProductSizeGuide,
    SizeGuide,
    SizeGuideCategory,
)
from app.models.discovery import SIZE_GUIDE_KINDS, SIZE_GUIDE_UNITS
from app.utils.ids import next_id

logger = logging.getLogger(__name__)

STATUSES = ("active", "inactive")
COLUMN_TYPES = ("measurement", "text")
MAX_COLUMNS = 12
MAX_ROWS = 60
MAX_INSTRUCTIONS = 20
_KEY = re.compile(r"^[a-z0-9][a-z0-9_-]{0,29}$")
_RANGE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(?:[-–—]|to)\s*(\d+(?:\.\d+)?)\s*$")
# Upper bounds, in each unit, for a measurement that is plausible on a person
# or a product someone wears: catches a slipped decimal point.
MAX_MEASUREMENT = {"cm": Decimal("500"), "in": Decimal("200"), "mm": Decimal("5000")}

# How many millimetres in one of each unit — exact.
_MM = {"mm": Decimal("1"), "cm": Decimal("10"), "in": Decimal("25.4")}

# Starting columns the editor offers for each kind. Only a suggestion: the
# store can rename, remove and add.
TEMPLATES = {
    "clothing": [
        {"key": "chest", "label": "Chest", "type": "measurement"},
        {"key": "waist", "label": "Waist", "type": "measurement"},
        {"key": "hip", "label": "Hip", "type": "measurement"},
        {"key": "shoulder", "label": "Shoulder", "type": "measurement"},
        {"key": "length", "label": "Length", "type": "measurement"},
    ],
    "footwear": [
        {"key": "uk", "label": "UK", "type": "text"},
        {"key": "us", "label": "US", "type": "text"},
        {"key": "eu", "label": "EU", "type": "text"},
        {"key": "foot-length", "label": "Foot length", "type": "measurement"},
    ],
    "ring": [
        {"key": "circumference", "label": "Finger circumference", "type": "measurement"},
        {"key": "diameter", "label": "Diameter", "type": "measurement"},
    ],
    "general": [],
}


def _normal(label: str) -> str:
    return re.sub(r"\s+", "", str(label or "")).lower()


# ------------------------------------------------------------- conversion


def convert(value: Decimal | float | int, from_unit: str, to_unit: str) -> Decimal:
    """`value` in `from_unit`, exactly, in `to_unit`. Not rounded."""
    if from_unit not in _MM or to_unit not in _MM:
        raise ValidationError("Units must be cm, in or mm.", error_code="INVALID_UNIT")
    amount = value if isinstance(value, Decimal) else Decimal(str(value))
    if from_unit == to_unit:
        return amount
    return amount * _MM[from_unit] / _MM[to_unit]


def rounded(value: Decimal, unit: str) -> float:
    """Rounded once, for display: whole millimetres, otherwise one decimal place."""
    step = Decimal("1") if unit == "mm" else Decimal("0.1")
    return float(value.quantize(step, rounding=ROUND_HALF_UP))


def _cell_in(cell: dict, from_unit: str, to_unit: str) -> dict:
    out = {"min": rounded(convert(cell["min"], from_unit, to_unit), to_unit)}
    if cell.get("max") is not None:
        out["max"] = rounded(convert(cell["max"], from_unit, to_unit), to_unit)
    return out


# ------------------------------------------------------------- validation


def _text(payload: dict, key: str, *, required: bool = False, limit: int = 255, label: str = "") -> str:
    value = str(payload.get(key) or "").strip()
    if required and not value:
        raise ValidationError(f"{label or key.capitalize()} is required.", error_code="SIZE_GUIDE_INVALID")
    if len(value) > limit:
        raise ValidationError(f"{label or key.capitalize()} can be at most {limit} characters.",
                              error_code="SIZE_GUIDE_INVALID")
    return value


def _number(raw, *, where: str, unit: str) -> Decimal:
    try:
        value = Decimal(str(raw).strip())
    except Exception:  # noqa: BLE001 — InvalidOperation and friends
        raise ValidationError(f"{where}: '{raw}' is not a number.", error_code="SIZE_GUIDE_INVALID_VALUE") from None
    if not value.is_finite() or value <= 0:
        raise ValidationError(f"{where}: measurements must be greater than zero.",
                              error_code="SIZE_GUIDE_INVALID_VALUE")
    if value > MAX_MEASUREMENT[unit]:
        raise ValidationError(f"{where}: {value} {unit} looks too large — check the unit and the decimal point.",
                              error_code="SIZE_GUIDE_INVALID_VALUE")
    if value.as_tuple().exponent < -2:
        raise ValidationError(f"{where}: use at most two decimal places.", error_code="SIZE_GUIDE_INVALID_VALUE")
    return value


def _measurement(raw, *, where: str, unit: str) -> Optional[dict]:
    """A cell as `{min, max?}`: from a number, "92", "92-96", or {min, max}."""
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return None
    if isinstance(raw, dict):
        low = raw.get("min")
        high = raw.get("max")
        if low in (None, ""):
            raise ValidationError(f"{where}: a range needs at least a minimum.", error_code="SIZE_GUIDE_INVALID_VALUE")
        low_value = _number(low, where=where, unit=unit)
        high_value = _number(high, where=where, unit=unit) if high not in (None, "") else None
    elif isinstance(raw, (int, float)) and not isinstance(raw, bool):
        low_value, high_value = _number(raw, where=where, unit=unit), None
    elif isinstance(raw, str):
        match = _RANGE.match(raw)
        if match:
            low_value = _number(match.group(1), where=where, unit=unit)
            high_value = _number(match.group(2), where=where, unit=unit)
        else:
            low_value, high_value = _number(raw, where=where, unit=unit), None
    else:
        raise ValidationError(f"{where}: '{raw}' is not a measurement.", error_code="SIZE_GUIDE_INVALID_VALUE")
    if high_value is not None and high_value < low_value:
        raise ValidationError(f"{where}: the range's end is smaller than its start.",
                              error_code="SIZE_GUIDE_INVALID_VALUE")
    cell = {"min": float(low_value)}
    if high_value is not None and high_value != low_value:
        cell["max"] = float(high_value)
    return cell


def clean(payload: dict, *, existing: Optional[SizeGuide] = None) -> dict:
    """A guide's fields, validated. Raises on the first problem, naming the cell."""
    def pick(key, default=None):
        if key in payload:
            return payload[key]
        if existing is not None:
            return getattr(existing, {"isDefault": "is_default"}.get(key, key))
        return default

    name = _text({"name": pick("name", "")}, "name", required=True, limit=120, label="Name")
    kind = str(pick("kind", "general") or "general")
    if kind not in SIZE_GUIDE_KINDS:
        raise ValidationError("Choose a kind: clothing, footwear, ring or general.", error_code="SIZE_GUIDE_INVALID")
    unit = str(pick("unit", "") or "")
    if unit not in SIZE_GUIDE_UNITS:
        raise ValidationError("Choose the unit the measurements are in: cm, in or mm.",
                              error_code="SIZE_GUIDE_MISSING_UNIT")
    status = str(pick("status", "active") or "active")
    if status not in STATUSES:
        raise ValidationError("Status must be active or inactive.", error_code="SIZE_GUIDE_INVALID")

    raw_columns = pick("columns", []) or []
    if not isinstance(raw_columns, list) or not raw_columns:
        raise ValidationError("Add at least one column.", error_code="SIZE_GUIDE_MISSING_COLUMNS")
    if len(raw_columns) > MAX_COLUMNS:
        raise ValidationError(f"A guide can have at most {MAX_COLUMNS} columns.", error_code="SIZE_GUIDE_INVALID")
    columns, keys, labels = [], set(), set()
    for index, column in enumerate(raw_columns, start=1):
        if not isinstance(column, dict):
            raise ValidationError(f"Column {index} is not valid.", error_code="SIZE_GUIDE_INVALID")
        label = str(column.get("label") or "").strip()
        if not label or len(label) > 40:
            raise ValidationError(f"Column {index} needs a name of up to 40 characters.",
                                  error_code="SIZE_GUIDE_MISSING_COLUMNS")
        key = str(column.get("key") or "").strip().lower() or re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
        if not _KEY.match(key):
            raise ValidationError(f"Column '{label}': the key may use lower-case letters, digits, - and _.",
                                  error_code="SIZE_GUIDE_INVALID")
        if key in keys or label.lower() in labels:
            raise ValidationError(f"Column '{label}' appears twice.", error_code="SIZE_GUIDE_DUPLICATE_COLUMN")
        kind_of = str(column.get("type") or "measurement")
        if kind_of not in COLUMN_TYPES:
            raise ValidationError(f"Column '{label}': type must be measurement or text.",
                                  error_code="SIZE_GUIDE_INVALID")
        keys.add(key)
        labels.add(label.lower())
        columns.append({"key": key, "label": label, "type": kind_of, "required": column.get("required", True) is not False})

    raw_rows = pick("rows", []) or []
    if not isinstance(raw_rows, list) or not raw_rows:
        raise ValidationError("Add at least one size.", error_code="SIZE_GUIDE_MISSING_ROWS")
    if len(raw_rows) > MAX_ROWS:
        raise ValidationError(f"A guide can have at most {MAX_ROWS} sizes.", error_code="SIZE_GUIDE_INVALID")
    rows, sizes = [], set()
    for index, row in enumerate(raw_rows, start=1):
        if not isinstance(row, dict):
            raise ValidationError(f"Size {index} is not valid.", error_code="SIZE_GUIDE_INVALID")
        size = str(row.get("size") or "").strip()
        if not size or len(size) > 30:
            raise ValidationError(f"Row {index} needs a size name of up to 30 characters.",
                                  error_code="SIZE_GUIDE_MISSING_SIZE")
        if _normal(size) in sizes:
            raise ValidationError(f"Size '{size}' is listed twice.", error_code="SIZE_GUIDE_DUPLICATE_SIZE")
        sizes.add(_normal(size))
        given = row.get("values") or {}
        if not isinstance(given, dict):
            raise ValidationError(f"Size '{size}': values are not valid.", error_code="SIZE_GUIDE_INVALID")
        values = {}
        for column in columns:
            where = f"Size '{size}', {column['label']}"
            raw = given.get(column["key"])
            if column["type"] == "measurement":
                cell = _measurement(raw, where=where, unit=unit)
            else:
                cell = str(raw).strip()[:30] if raw not in (None, "") else None
            if cell is None:
                if column["required"]:
                    raise ValidationError(f"{where}: a value is required.", error_code="SIZE_GUIDE_MISSING_VALUE")
                continue
            values[column["key"]] = cell
        unknown = set(given) - keys
        if unknown:
            raise ValidationError(f"Size '{size}' has values for columns that don't exist: {', '.join(sorted(unknown))}.",
                                  error_code="SIZE_GUIDE_INVALID")
        rows.append({"size": size, "values": values})

    raw_instructions = pick("instructions", []) or []
    if not isinstance(raw_instructions, list) or len(raw_instructions) > MAX_INSTRUCTIONS:
        raise ValidationError(f"Up to {MAX_INSTRUCTIONS} measuring instructions.", error_code="SIZE_GUIDE_INVALID")
    instructions = []
    for index, step in enumerate(raw_instructions, start=1):
        if not isinstance(step, dict):
            raise ValidationError(f"Instruction {index} is not valid.", error_code="SIZE_GUIDE_INVALID")
        title = str(step.get("title") or "").strip()
        body = str(step.get("body") or "").strip()
        if not title or len(title) > 80 or not body or len(body) > 1000:
            raise ValidationError(f"Instruction {index} needs a title (up to 80 characters) and text (up to 1,000).",
                                  error_code="SIZE_GUIDE_INVALID")
        column_key = str(step.get("column") or "").strip().lower()
        if column_key and column_key not in keys:
            raise ValidationError(f"Instruction '{title}' points at a column that doesn't exist.",
                                  error_code="SIZE_GUIDE_INVALID")
        instructions.append({"title": title, "body": body, "column": column_key})

    return {
        "name": name,
        "kind": kind,
        "unit": unit,
        "status": status,
        "description": _text({"d": pick("description", "")}, "d", limit=2000, label="Description"),
        "notes": _text({"n": pick("notes", "")}, "n", limit=2000, label="Notes"),
        "columns": columns,
        "rows": rows,
        "instructions": instructions,
        "is_default": bool(pick("isDefault", False)),
    }


# ------------------------------------------------------------- writing


def create(db: Session, payload: dict, *, actor: str = "") -> SizeGuide:
    values = clean(payload)
    if _name_taken(db, values["name"]):
        raise ConflictError(f"A size guide called '{values['name']}' already exists.", error_code="DUPLICATE")
    guide = SizeGuide(id=next_id(db, SizeGuide, "size_guide"), updated_by=actor, **values)
    db.add(guide)
    db.flush()
    if guide.is_default:
        _only_default(db, guide.id)
    return guide


def update(db: Session, guide_id: str, payload: dict, *, actor: str = "") -> SizeGuide:
    guide = get(db, guide_id)
    values = clean(payload, existing=guide)
    if _name_taken(db, values["name"], ignore=guide.id):
        raise ConflictError(f"A size guide called '{values['name']}' already exists.", error_code="DUPLICATE")
    for key, value in values.items():
        setattr(guide, key, value)
    guide.updated_by = actor
    db.flush()
    if guide.is_default:
        _only_default(db, guide.id)
    return guide


def _name_taken(db: Session, name: str, *, ignore: Optional[str] = None) -> bool:
    statement = select(SizeGuide.id).where(func.lower(SizeGuide.name) == name.lower())
    if ignore:
        statement = statement.where(SizeGuide.id != ignore)
    return db.execute(statement.limit(1)).first() is not None


def _only_default(db: Session, guide_id: str) -> None:
    for other in db.execute(select(SizeGuide).where(SizeGuide.is_default.is_(True),
                                                    SizeGuide.id != guide_id)).scalars():
        other.is_default = False


def delete(db: Session, guide_id: str) -> dict:
    """Remove a guide and its assignments. Products and categories fall back down the chain."""
    guide = get(db, guide_id)
    usage = usage_of(db, guide.id)
    db.delete(guide)
    db.flush()
    return usage


def get(db: Session, guide_id: str) -> SizeGuide:
    guide = db.get(SizeGuide, guide_id)
    if guide is None:
        raise NotFoundError("No such size guide.", error_code="SIZE_GUIDE_NOT_FOUND")
    return guide


def usage_of(db: Session, guide_id: str) -> dict:
    products = db.execute(select(func.count()).select_from(ProductSizeGuide)
                          .where(ProductSizeGuide.size_guide_id == guide_id)).scalar_one()
    categories = db.execute(select(func.count()).select_from(SizeGuideCategory)
                            .where(SizeGuideCategory.size_guide_id == guide_id)).scalar_one()
    return {"products": int(products), "categories": int(categories)}


def set_categories(db: Session, guide_id: str, category_ids: Iterable[str]) -> dict:
    """
    The categories this guide is the default for — the whole set, replacing it.

    A category has one guide, so a category moved here from another guide is
    moved, and the result names how many were.
    """
    guide = get(db, guide_id)
    wanted = list(dict.fromkeys(str(c) for c in category_ids if c))
    found = set(db.execute(select(Category.id).where(Category.id.in_(wanted))).scalars()) if wanted else set()
    missing = [c for c in wanted if c not in found]
    if missing:
        raise ValidationError(f"Unknown categories: {', '.join(missing)}.", error_code="CATEGORY_NOT_FOUND")
    current = {row.category_id: row for row in db.execute(
        select(SizeGuideCategory).where(or_(SizeGuideCategory.size_guide_id == guide.id,
                                            SizeGuideCategory.category_id.in_(wanted or [""])))).scalars()}
    moved = 0
    for category_id, row in current.items():
        if category_id not in wanted and row.size_guide_id == guide.id:
            db.delete(row)
    for category_id in wanted:
        row = current.get(category_id)
        if row is None:
            db.add(SizeGuideCategory(category_id=category_id, size_guide_id=guide.id))
        elif row.size_guide_id != guide.id:
            row.size_guide_id = guide.id
            moved += 1
    db.flush()
    return {"categories": wanted, "movedFromOtherGuides": moved}


def assign_products(db: Session, guide_id: str, product_ids: Iterable[str], *, mode: str = "add") -> dict:
    """Give products this guide (`add`), take it away (`remove`), or make it exactly these (`replace`)."""
    guide = get(db, guide_id)
    if mode not in ("add", "remove", "replace"):
        raise ValidationError("Mode must be add, remove or replace.", error_code="INVALID_MODE")
    wanted = list(dict.fromkeys(str(p) for p in product_ids if p))[:500]
    found = set(db.execute(select(Product.id).where(Product.id.in_(wanted))).scalars()) if wanted else set()
    missing = [p for p in wanted if p not in found]
    if missing:
        raise ValidationError(f"Unknown products: {', '.join(missing[:10])}.", error_code="PRODUCT_NOT_FOUND")
    existing = {row.product_id: row for row in db.execute(
        select(ProductSizeGuide).where(or_(ProductSizeGuide.product_id.in_(wanted or [""]),
                                           ProductSizeGuide.size_guide_id == guide.id))).scalars()}
    added = removed = 0
    if mode == "remove":
        for pid in wanted:
            row = existing.get(pid)
            if row is not None and row.size_guide_id == guide.id:
                db.delete(row)
                removed += 1
    else:
        if mode == "replace":
            for pid, row in existing.items():
                if row.size_guide_id == guide.id and pid not in wanted:
                    db.delete(row)
                    removed += 1
        for pid in wanted:
            row = existing.get(pid)
            if row is None:
                db.add(ProductSizeGuide(product_id=pid, size_guide_id=guide.id))
                added += 1
            elif row.size_guide_id != guide.id:
                row.size_guide_id = guide.id
                added += 1
    db.flush()
    return {"added": added, "removed": removed, **usage_of(db, guide.id)}


def set_for_product(db: Session, product_id: str, guide_id: Optional[str]) -> Optional[SizeGuide]:
    """A product's own guide, or none (`guide_id` None) to fall back to its category's."""
    if db.get(Product, product_id) is None:
        raise NotFoundError("No such product.", error_code="PRODUCT_NOT_FOUND")
    row = db.get(ProductSizeGuide, product_id)
    if not guide_id:
        if row is not None:
            db.delete(row)
            db.flush()
        return None
    guide = get(db, guide_id)
    if row is None:
        db.add(ProductSizeGuide(product_id=product_id, size_guide_id=guide.id))
    else:
        row.size_guide_id = guide.id
    db.flush()
    return guide


# ------------------------------------------------------------- reading


def resolve(db: Session, product: Product) -> Tuple[Optional[SizeGuide], str]:
    """The guide `product` shows and where it came from: product | category | default | none."""
    own = db.execute(
        select(SizeGuide).join(ProductSizeGuide, ProductSizeGuide.size_guide_id == SizeGuide.id)
        .where(ProductSizeGuide.product_id == product.id)
    ).scalar_one_or_none()
    if own is not None and own.status == "active":
        return own, "product"
    if not product.sizes:
        return None, "none"
    by_category = db.execute(
        select(SizeGuide).join(SizeGuideCategory, SizeGuideCategory.size_guide_id == SizeGuide.id)
        .where(SizeGuideCategory.category_id == product.category_id, SizeGuide.status == "active")
    ).scalar_one_or_none()
    if by_category is not None:
        return by_category, "category"
    default = db.execute(
        select(SizeGuide).where(SizeGuide.is_default.is_(True), SizeGuide.status == "active").limit(1)
    ).scalar_one_or_none()
    if default is not None:
        return default, "default"
    return None, "none"


def size_match(guide: SizeGuide, product_sizes: List[str]) -> dict:
    guide_sizes = [row["size"] for row in guide.rows or []]
    in_guide = {_normal(s) for s in guide_sizes}
    offered = {_normal(s) for s in product_sizes}
    return {
        "productSizes": product_sizes,
        "guideSizes": guide_sizes,
        # The product's sizes the guide has no row for: the portal warns.
        "missingFromGuide": [s for s in product_sizes if _normal(s) not in in_guide],
        # Rows for sizes this product isn't sold in: shown, not highlighted.
        "notOffered": [s for s in guide_sizes if _normal(s) not in offered] if product_sizes else [],
        "consistent": bool(product_sizes) and all(_normal(s) in in_guide for s in product_sizes),
    }


def view(guide: SizeGuide, *, unit: Optional[str] = None, product_sizes: Optional[List[str]] = None,
         source: Optional[str] = None) -> dict:
    """
    A guide for the storefront, in `unit` if asked (measurements converted
    exactly, then rounded once). Each measurement cell carries the stored
    value too, so the browser can convert again without compounding rounding.
    """
    target = unit or guide.unit
    if target not in SIZE_GUIDE_UNITS:
        raise ValidationError("Units must be cm, in or mm.", error_code="INVALID_UNIT")
    measurement_keys = {c["key"] for c in guide.columns or [] if c.get("type") == "measurement"}
    offered = {_normal(s) for s in (product_sizes or [])}
    rows = []
    for row in guide.rows or []:
        values = {}
        for key, cell in (row.get("values") or {}).items():
            values[key] = _cell_in(cell, guide.unit, target) if key in measurement_keys and isinstance(cell, dict) \
                else cell
        rows.append({"size": row["size"], "values": values,
                     "stored": {k: v for k, v in (row.get("values") or {}).items() if k in measurement_keys},
                     "offered": (_normal(row["size"]) in offered) if product_sizes else True})
    out = {
        "id": guide.id,
        "name": guide.name,
        "kind": guide.kind,
        "description": guide.description,
        "unit": target,
        "storedUnit": guide.unit,
        "units": ["cm", "in"] if guide.unit in ("cm", "in") else [guide.unit, "cm", "in"],
        "columns": guide.columns or [],
        "rows": rows,
        "instructions": guide.instructions or [],
        "notes": guide.notes,
    }
    if source is not None:
        out["source"] = source
    if product_sizes is not None:
        out["sizeMatch"] = size_match(guide, product_sizes)
    return out


def for_product(db: Session, product: Product, *, unit: Optional[str] = None) -> Optional[dict]:
    try:
        guide, source = resolve(db, product)
    except Exception:  # noqa: BLE001 — a broken guide must not take the product page down
        logger.exception("Could not resolve the size guide for %s", product.id)
        return None
    if guide is None:
        return None
    return view(guide, unit=unit, product_sizes=[s.label for s in product.sizes], source=source)


def admin_view(db: Session, guide: SizeGuide, *, with_products: bool = False) -> dict:
    out = {
        "id": guide.id, "name": guide.name, "kind": guide.kind, "description": guide.description,
        "unit": guide.unit, "columns": guide.columns or [], "rows": guide.rows or [],
        "instructions": guide.instructions or [], "notes": guide.notes, "status": guide.status,
        "isDefault": guide.is_default, "categoryIds": [c.category_id for c in guide.categories],
        "createdAt": guide.created_at, "updatedAt": guide.updated_at, "updatedBy": guide.updated_by,
        **usage_of(db, guide.id),
    }
    if with_products:
        rows = db.execute(
            select(Product.id, Product.name, Product.status)
            .join(ProductSizeGuide, ProductSizeGuide.product_id == Product.id)
            .where(ProductSizeGuide.size_guide_id == guide.id).order_by(Product.name).limit(500)
        ).all()
        out["assignedProducts"] = [{"id": pid, "name": name, "status": status} for pid, name, status in rows]
    return out


def search(db: Session, *, q: str = "", status: str = "", kind: str = "", page: int = 1,
           page_size: int = 25) -> Tuple[List[SizeGuide], int]:
    conditions = []
    if q.strip():
        conditions.append(SizeGuide.name.ilike(f"%{q.strip()}%"))
    if status in STATUSES:
        conditions.append(SizeGuide.status == status)
    if kind in SIZE_GUIDE_KINDS:
        conditions.append(SizeGuide.kind == kind)
    total = db.execute(select(func.count()).select_from(SizeGuide).where(*conditions)).scalar_one()
    rows = db.execute(select(SizeGuide).where(*conditions).order_by(SizeGuide.name)
                      .offset((max(1, page) - 1) * page_size).limit(page_size)).scalars().all()
    return list(rows), int(total)
