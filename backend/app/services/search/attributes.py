"""
Product attributes: the definitions (with their options) and each product's values.

An attribute's `code` is what storefront URLs use (`attr.material=steel`), so
it is fixed once any product has a value, as is its `type`; the label, unit,
flags, position and option labels can change at any time. An option a product
uses can't be removed, and neither can an attribute: archive it instead.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Dict, List, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import Product, ProductAttribute, ProductAttributeOption, ProductAttributeValue
from app.utils.ids import slugify

TYPES = ("select", "multi", "number", "boolean")
STATUSES = ("active", "archived")
CODE = re.compile(r"^[a-z][a-z0-9_]{1,39}$")
MAX_OPTIONS = 200
MAX_MULTI_VALUES = 30
MAX_NUMBER = 1_000_000_000


# ----------------------------------------------------------------- reading


def _usage(db: Session, attribute_ids: List[int]) -> Dict[int, int]:
    if not attribute_ids:
        return {}
    return dict(db.execute(
        select(ProductAttributeValue.attribute_id, func.count(func.distinct(ProductAttributeValue.product_id)))
        .where(ProductAttributeValue.attribute_id.in_(attribute_ids))
        .group_by(ProductAttributeValue.attribute_id)
    ).all())


def view(attribute: ProductAttribute, product_count: int = 0) -> dict:
    return {
        "id": attribute.id, "code": attribute.code, "label": attribute.label, "type": attribute.type,
        "unit": attribute.unit, "filterable": attribute.filterable, "searchable": attribute.searchable,
        "position": attribute.position, "status": attribute.status,
        "options": [{"id": o.id, "value": o.value, "label": o.label, "position": o.position}
                    for o in attribute.options],
        "productCount": product_count,
        "createdAt": attribute.created_at, "updatedAt": attribute.updated_at,
    }


def list_attributes(db: Session, status: str = "all") -> List[dict]:
    statement = select(ProductAttribute).order_by(ProductAttribute.position, ProductAttribute.label,
                                                  ProductAttribute.id)
    if status in STATUSES:
        statement = statement.where(ProductAttribute.status == status)
    rows = list(db.execute(statement).scalars())
    usage = _usage(db, [a.id for a in rows])
    return [view(a, usage.get(a.id, 0)) for a in rows]


def get(db: Session, attribute_id: int) -> ProductAttribute:
    attribute = db.get(ProductAttribute, attribute_id)
    if attribute is None:
        raise NotFoundError("That attribute doesn't exist.", error_code="ATTRIBUTE_NOT_FOUND")
    return attribute


def get_view(db: Session, attribute_id: int) -> dict:
    attribute = get(db, attribute_id)
    return view(attribute, _usage(db, [attribute.id]).get(attribute.id, 0))


# ----------------------------------------------------------------- writing


def _clean_options(options, existing: Optional[List[ProductAttributeOption]] = None) -> List[dict]:
    if not isinstance(options, list):
        raise ValidationError("Options must be a list.", error_code="INVALID_OPTIONS")
    if len(options) > MAX_OPTIONS:
        raise ValidationError(f"At most {MAX_OPTIONS} options.", error_code="INVALID_OPTIONS")
    by_id = {o.id: o for o in existing or []}
    cleaned, seen = [], set()
    for position, option in enumerate(options):
        label = " ".join(str(option.get("label") or "").split())[:120]
        if not label:
            raise ValidationError("Every option needs a label.", error_code="INVALID_OPTIONS")
        option_id = option.get("id")
        if option_id is not None and option_id not in by_id:
            raise ValidationError("An option in the list doesn't belong to this attribute.",
                                  error_code="INVALID_OPTIONS")
        if option_id is not None:
            value = by_id[option_id].value  # a rename keeps the value products and URLs use
        else:
            value = slugify(str(option.get("value") or label))[:120]
        if not value:
            raise ValidationError(f"“{label}” needs letters or digits.", error_code="INVALID_OPTIONS")
        if value in seen:
            raise ValidationError(f"“{label}” is in the list twice.", error_code="DUPLICATE_OPTION")
        seen.add(value)
        cleaned.append({"id": option_id, "value": value, "label": label, "position": position})
    return cleaned


def create(db: Session, data: dict) -> ProductAttribute:
    code = (data.get("code") or "").strip().lower()
    if not CODE.match(code):
        raise ValidationError("The code is 2–40 lower-case letters, digits or _, starting with a letter.",
                              error_code="INVALID_ATTRIBUTE_CODE")
    if db.execute(select(ProductAttribute.id).where(ProductAttribute.code == code)).first():
        raise ConflictError(f"An attribute with the code “{code}” already exists.",
                            error_code="ATTRIBUTE_CODE_TAKEN")
    kind = data.get("type")
    if kind not in TYPES:
        raise ValidationError("The type is select, multi, number or boolean.", error_code="INVALID_ATTRIBUTE_TYPE")
    label = " ".join((data.get("label") or "").split())
    if not label:
        raise ValidationError("The attribute needs a label.", error_code="ATTRIBUTE_LABEL_REQUIRED")
    options = data.get("options") or []
    if options and kind not in ("select", "multi"):
        raise ValidationError("Only select and multi attributes have options.", error_code="OPTIONS_NOT_ALLOWED")
    attribute = ProductAttribute(
        code=code, label=label[:80], type=kind, unit=(data.get("unit") or "").strip()[:20],
        filterable=data.get("filterable", True) is not False, searchable=data.get("searchable", True) is not False,
        position=int(data.get("position") or 0), status=_status(data.get("status") or "active"),
    )
    attribute.options = [ProductAttributeOption(value=o["value"], label=o["label"], position=o["position"])
                         for o in _clean_options(options)]
    db.add(attribute)
    db.flush()
    return attribute


def _status(value: str) -> str:
    if value not in STATUSES:
        raise ValidationError("The status is active or archived.", error_code="INVALID_ATTRIBUTE_STATUS")
    return value


def update(db: Session, attribute_id: int, data: dict) -> ProductAttribute:
    attribute = get(db, attribute_id)
    used = _usage(db, [attribute.id]).get(attribute.id, 0) > 0

    if "code" in data and data["code"] is not None and data["code"] != attribute.code:
        code = data["code"].strip().lower()
        if used:
            raise ConflictError("The code can't change once products use this attribute.",
                                error_code="ATTRIBUTE_IN_USE")
        if not CODE.match(code):
            raise ValidationError("The code is 2–40 lower-case letters, digits or _, starting with a letter.",
                                  error_code="INVALID_ATTRIBUTE_CODE")
        if db.execute(select(ProductAttribute.id).where(ProductAttribute.code == code,
                                                        ProductAttribute.id != attribute.id)).first():
            raise ConflictError(f"An attribute with the code “{code}” already exists.",
                                error_code="ATTRIBUTE_CODE_TAKEN")
        attribute.code = code
    if "type" in data and data["type"] is not None and data["type"] != attribute.type:
        if data["type"] not in TYPES:
            raise ValidationError("The type is select, multi, number or boolean.",
                                  error_code="INVALID_ATTRIBUTE_TYPE")
        if used:
            raise ConflictError("The type can't change once products use this attribute.",
                                error_code="ATTRIBUTE_IN_USE")
        attribute.type = data["type"]
        if attribute.type not in ("select", "multi"):
            attribute.options = []
    if data.get("label") is not None:
        label = " ".join(data["label"].split())
        if not label:
            raise ValidationError("The attribute needs a label.", error_code="ATTRIBUTE_LABEL_REQUIRED")
        attribute.label = label[:80]
    if data.get("unit") is not None:
        attribute.unit = data["unit"].strip()[:20]
    for flag in ("filterable", "searchable"):
        if data.get(flag) is not None:
            setattr(attribute, flag, bool(data[flag]))
    if data.get("position") is not None:
        attribute.position = int(data["position"])
    if data.get("status") is not None:
        attribute.status = _status(data["status"])

    if data.get("options") is not None:
        if data["options"] and attribute.type not in ("select", "multi"):
            raise ValidationError("Only select and multi attributes have options.",
                                  error_code="OPTIONS_NOT_ALLOWED")
        cleaned = _clean_options(data["options"], attribute.options)
        kept_ids = {o["id"] for o in cleaned if o["id"] is not None}
        removed = [o for o in attribute.options if o.id not in kept_ids]
        if removed:
            in_use = db.execute(
                select(ProductAttributeValue.value_normalized).where(
                    ProductAttributeValue.attribute_id == attribute.id,
                    ProductAttributeValue.value_normalized.in_([o.value for o in removed])).limit(1)
            ).scalar_one_or_none()
            if in_use:
                label = next(o.label for o in removed if o.value == in_use)
                raise ConflictError(f"“{label}” is set on products, so it can't be removed. "
                                    "Take it off those products first.", error_code="OPTION_IN_USE")
        by_id = {o.id: o for o in attribute.options}
        new_options = []
        for option in cleaned:
            if option["id"] is not None:
                row = by_id[option["id"]]
                row.label, row.position = option["label"], option["position"]
                new_options.append(row)
            else:
                new_options.append(ProductAttributeOption(value=option["value"], label=option["label"],
                                                          position=option["position"]))
        attribute.options = new_options
        # Labels shown on products follow a renamed option.
        for row in new_options:
            if row.id is not None:
                db.execute(
                    ProductAttributeValue.__table__.update()
                    .where(ProductAttributeValue.attribute_id == attribute.id,
                           ProductAttributeValue.value_normalized == row.value)
                    .values(value=row.label[:160])
                )
    db.flush()
    return attribute


def delete(db: Session, attribute_id: int) -> None:
    attribute = get(db, attribute_id)
    if _usage(db, [attribute.id]).get(attribute.id, 0):
        raise ConflictError("Products use this attribute, so it can't be deleted. Archive it instead.",
                            error_code="ATTRIBUTE_IN_USE")
    db.delete(attribute)
    db.flush()


# --------------------------------------------------------- product values


def _product(db: Session, product_id: str) -> Product:
    product = db.get(Product, product_id)
    if product is None:
        raise NotFoundError(f"No product with id '{product_id}'.", error_code="PRODUCT_NOT_FOUND")
    return product


def product_values(db: Session, product_id: str) -> dict:
    _product(db, product_id)
    attributes = list(db.execute(
        select(ProductAttribute).where(ProductAttribute.status == "active")
        .order_by(ProductAttribute.position, ProductAttribute.label, ProductAttribute.id)
    ).scalars())
    values: Dict[int, List[ProductAttributeValue]] = {}
    for row in db.execute(select(ProductAttributeValue).where(ProductAttributeValue.product_id == product_id)
                          .order_by(ProductAttributeValue.id)).scalars():
        values.setdefault(row.attribute_id, []).append(row)
    out = []
    for attribute in attributes:
        rows = values.get(attribute.id, [])
        if attribute.type == "multi":
            positions = {o.value: o.position for o in attribute.options}
            value = sorted((r.value_normalized for r in rows), key=lambda v: positions.get(v, 10**6))
        elif not rows:
            value = None
        elif attribute.type == "number":
            number = float(rows[0].value_number) if rows[0].value_number is not None else None
            value = int(number) if number is not None and number.is_integer() else number
        elif attribute.type == "boolean":
            value = rows[0].value_normalized == "true"
        else:
            value = rows[0].value_normalized
        out.append({"id": attribute.id, "code": attribute.code, "label": attribute.label, "type": attribute.type,
                    "unit": attribute.unit,
                    "options": [{"id": o.id, "value": o.value, "label": o.label, "position": o.position}
                                for o in attribute.options],
                    "value": value})
    return {"productId": product_id, "attributes": out}


def _number(raw, label: str) -> Decimal:
    if isinstance(raw, bool) or not isinstance(raw, (int, float, str)):
        raise ValidationError(f"{label} needs a number.", error_code="INVALID_ATTRIBUTE_VALUE")
    try:
        number = Decimal(str(raw).strip())
    except InvalidOperation:
        raise ValidationError(f"{label} needs a number.", error_code="INVALID_ATTRIBUTE_VALUE") from None
    if not number.is_finite() or abs(number) > MAX_NUMBER:
        raise ValidationError(f"{label} is out of range.", error_code="INVALID_ATTRIBUTE_VALUE")
    return number.quantize(Decimal("0.0001"))


def _rows_for(attribute: ProductAttribute, raw) -> List[dict]:
    """The value rows `raw` means for `attribute`; [] clears it."""
    if raw is None or raw == [] or raw == "":
        return []
    label = attribute.label
    if attribute.type in ("select", "multi"):
        options = {o.value: o for o in attribute.options}
        if attribute.type == "select":
            if not isinstance(raw, str):
                raise ValidationError(f"{label} takes one option.", error_code="INVALID_ATTRIBUTE_VALUE")
            chosen = [raw]
        else:
            if isinstance(raw, str):
                raw = [raw]
            if not isinstance(raw, list) or not all(isinstance(v, str) for v in raw):
                raise ValidationError(f"{label} takes a list of options.", error_code="INVALID_ATTRIBUTE_VALUE")
            chosen = list(dict.fromkeys(raw))
            if len(chosen) > MAX_MULTI_VALUES:
                raise ValidationError(f"{label} takes at most {MAX_MULTI_VALUES} options.",
                                      error_code="INVALID_ATTRIBUTE_VALUE")
        unknown = [v for v in chosen if v not in options]
        if unknown:
            raise ValidationError(f"“{unknown[0][:40]}” isn't one of {label}'s options.",
                                  error_code="INVALID_ATTRIBUTE_VALUE")
        return [{"value": options[v].label[:160], "value_normalized": v, "value_number": None} for v in chosen]
    if attribute.type == "boolean":
        if not isinstance(raw, bool):
            raise ValidationError(f"{label} is yes or no.", error_code="INVALID_ATTRIBUTE_VALUE")
        return [{"value": "Yes" if raw else "No", "value_normalized": "true" if raw else "false",
                 "value_number": None}]
    number = _number(raw, label)
    text = format(number.normalize(), "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return [{"value": text[:160], "value_normalized": text[:160], "value_number": number}]


def set_product_values(db: Session, product_id: str, values: dict) -> List[str]:
    """Apply `{code: value}`; only the codes sent change. Doesn't commit. Returns the codes changed."""
    if not isinstance(values, dict):
        raise ValidationError("Values are a map of attribute codes.", error_code="INVALID_ATTRIBUTE_VALUE")
    if len(values) > 200:
        raise ValidationError("Too many attributes at once.", error_code="INVALID_ATTRIBUTE_VALUE")
    _product(db, product_id)
    attributes = {a.code: a for a in db.execute(
        select(ProductAttribute).where(ProductAttribute.code.in_(list(values.keys())))).scalars()}
    unknown = [code for code in values if code not in attributes]
    if unknown:
        raise ValidationError(f"There's no attribute “{str(unknown[0])[:40]}”.", error_code="UNKNOWN_ATTRIBUTE")
    planned = {code: _rows_for(attributes[code], raw) for code, raw in values.items()}
    changed = []
    for code, rows in planned.items():
        attribute = attributes[code]
        existing = list(db.execute(select(ProductAttributeValue).where(
            ProductAttributeValue.product_id == product_id,
            ProductAttributeValue.attribute_id == attribute.id)).scalars())
        before = sorted((r.value_normalized, str(r.value_number)) for r in existing)
        after = sorted((r["value_normalized"], str(r["value_number"])) for r in rows)
        if before == after:
            continue
        for row in existing:
            db.delete(row)
        db.flush()
        for row in rows:
            db.add(ProductAttributeValue(product_id=product_id, attribute_id=attribute.id, **row))
        changed.append(code)
    db.flush()
    return changed

