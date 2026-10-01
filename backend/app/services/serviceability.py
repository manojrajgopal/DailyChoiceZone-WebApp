"""
Pincode serviceability: can we deliver there, how fast, for how much, and can
the customer pay cash on delivery?

The answers come from `delivery_pincodes`, which the store manages in the
portal — no real-world coverage is invented or bundled here. A pincode the
table doesn't list is decided by the `serviceability` settings document:

- `restrictToListed: false` (the default) — unlisted pincodes are delivered to
  at the store's standard fee and estimate, so a store with an empty table
  keeps working exactly as before;
- `restrictToListed: true` — only listed, serviceable pincodes can order.

An entry switched off (`active = false`) is ignored, as if it weren't listed.
An active entry with `serviceable = false` blocks the pincode outright.

The check runs twice: for the shopper's information (product page, checkout)
and again, **authoritatively**, when the order is placed — so a stale answer
in the browser can't get an order through.
"""

from __future__ import annotations

import copy
import csv
import io
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import List, Optional

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import DeliveryPincode, SettingDocument

# Indian PIN codes: six digits, never starting with 0.
PINCODE = re.compile(r"^[1-9][0-9]{5}$")

DEFAULTS = {"restrictToListed": False}

MAX_IMPORT_ROWS = 5000


# --------------------------------------------------------------- settings


def settings(db: Session) -> dict:
    stored = (db.get(SettingDocument, "serviceability") or SettingDocument(value={})).value or {}
    merged = copy.deepcopy(DEFAULTS)
    merged.update({k: v for k, v in stored.items() if k in DEFAULTS})
    return merged


def save_settings(db: Session, payload: dict) -> dict:
    out = settings(db)
    if "restrictToListed" in payload:
        out["restrictToListed"] = bool(payload["restrictToListed"])
    now = datetime.utcnow()
    row = db.get(SettingDocument, "serviceability")
    if row is None:
        db.add(SettingDocument(key="serviceability", value=out, created_at=now, updated_at=now))
    else:
        row.value = out
        row.updated_at = now
    db.commit()
    return out


# ------------------------------------------------------------------ check


def normalise(pincode: str) -> str:
    return re.sub(r"\s+", "", str(pincode or ""))


def valid(pincode: str) -> bool:
    return bool(PINCODE.match(normalise(pincode)))


def _business_days_from(days: int, start: Optional[datetime] = None) -> datetime:
    date = start or datetime.utcnow()
    remaining = max(0, days)
    while remaining > 0:
        date += timedelta(days=1)
        if date.weekday() < 5:
            remaining -= 1
    return date


def estimate_label(days: int) -> str:
    date = _business_days_from(days)
    return f"{date:%a}, {date.day} {date:%b}"


@dataclass
class Serviceability:
    pincode: str
    valid: bool
    serviceable: bool
    listed: bool
    reason: str = ""
    cod_available: bool = True
    express_available: bool = True
    min_days: Optional[int] = None
    max_days: Optional[int] = None
    # Minor units; None means the store's standard fee.
    delivery_fee: Optional[int] = None
    city: str = ""
    district: str = ""
    state: str = ""

    def view(self, db: Session) -> dict:
        from app.services import billing

        shipping = billing.store_settings(db).get("shipping") or {}
        fee = self.delivery_fee if self.delivery_fee is not None else billing.to_minor(shipping.get("standardFee", 0))
        threshold = shipping.get("freeDeliveryThreshold")
        estimate = None
        if self.serviceable:
            estimate = (
                estimate_label(self.max_days) if self.max_days
                else shipping.get("standardEstimate") or None
            )
        return {
            "pincode": self.pincode,
            "valid": self.valid,
            "serviceable": self.serviceable,
            "listed": self.listed,
            "reason": self.reason,
            "codAvailable": self.serviceable and self.cod_available,
            "expressAvailable": self.serviceable and self.express_available,
            "minDays": self.min_days,
            "maxDays": self.max_days,
            "estimate": estimate,
            # Rupees, before the free-delivery threshold, coupons or membership.
            "deliveryFee": billing.to_major(fee) if self.serviceable else None,
            "freeDeliveryThreshold": threshold,
            "city": self.city,
            "district": self.district,
            "state": self.state,
        }


def check(db: Session, pincode: str) -> Serviceability:
    code = normalise(pincode)
    if not PINCODE.match(code):
        return Serviceability(pincode=code, valid=False, serviceable=False, listed=False,
                              reason="Enter a valid 6-digit pincode.")
    row = db.execute(select(DeliveryPincode).where(DeliveryPincode.pincode == code)).scalar_one_or_none()
    if row is not None and row.active:
        if not row.serviceable:
            return Serviceability(pincode=code, valid=True, serviceable=False, listed=True,
                                  reason="Sorry, we don't deliver to this pincode yet.",
                                  city=row.city, district=row.district, state=row.state)
        return Serviceability(
            pincode=code, valid=True, serviceable=True, listed=True, cod_available=row.cod_available,
            express_available=row.express_available, min_days=row.min_days, max_days=row.max_days,
            delivery_fee=row.delivery_fee, city=row.city, district=row.district, state=row.state,
        )
    if settings(db)["restrictToListed"]:
        return Serviceability(pincode=code, valid=True, serviceable=False, listed=False,
                              reason="Sorry, we don't deliver to this pincode yet.")
    return Serviceability(pincode=code, valid=True, serviceable=True, listed=False)


def enforce(db: Session, pincode: str, *, payment_method: str, delivery_method: str) -> Serviceability:
    """The authoritative check at order time. Raises with a reason the customer can act on."""
    result = check(db, pincode)
    if not result.valid:
        raise ValidationError("Enter a valid 6-digit delivery pincode.", error_code="PINCODE_INVALID")
    if not result.serviceable:
        raise ConflictError(result.reason or "We don't deliver to this pincode yet.",
                            error_code="PINCODE_NOT_SERVICEABLE")
    if payment_method == "cod" and not result.cod_available:
        raise ConflictError("Cash on delivery isn't available for this pincode. Please choose another payment method.",
                            error_code="COD_UNAVAILABLE")
    if delivery_method == "express" and not result.express_available:
        raise ConflictError("Express delivery isn't available for this pincode. Please choose standard delivery.",
                            error_code="EXPRESS_UNAVAILABLE")
    return result


# ------------------------------------------------------------------ admin


def view(row: DeliveryPincode) -> dict:
    from app.services import billing

    return {
        "id": row.id, "pincode": row.pincode, "city": row.city, "district": row.district, "state": row.state,
        "serviceable": row.serviceable, "codAvailable": row.cod_available, "expressAvailable": row.express_available,
        "minDays": row.min_days, "maxDays": row.max_days,
        "deliveryFee": billing.to_major(row.delivery_fee) if row.delivery_fee is not None else None,
        "courier": row.courier, "notes": row.notes, "active": row.active,
        "createdAt": row.created_at, "updatedAt": row.updated_at,
    }


def _clean(payload: dict) -> dict:
    """Validate one entry's fields; raises with the first problem."""
    from app.services import billing

    code = normalise(payload.get("pincode", ""))
    if not PINCODE.match(code):
        raise ValidationError("Enter a valid 6-digit pincode (it can't start with 0).", error_code="PINCODE_INVALID")

    def days(key: str) -> Optional[int]:
        value = payload.get(key)
        if value in (None, ""):
            return None
        try:
            number = int(value)
        except (TypeError, ValueError):
            raise ValidationError("Delivery days must be whole numbers.", error_code="INVALID_DAYS") from None
        if not 0 <= number <= 60:
            raise ValidationError("Delivery days must be between 0 and 60.", error_code="INVALID_DAYS")
        return number

    min_days, max_days = days("minDays"), days("maxDays")
    if min_days is not None and max_days is not None and min_days > max_days:
        raise ValidationError("The earliest delivery can't be after the latest.", error_code="INVALID_DAYS")
    fee_raw = payload.get("deliveryFee")
    fee = None
    if fee_raw not in (None, ""):
        try:
            fee_value = float(fee_raw)
        except (TypeError, ValueError):
            raise ValidationError("The delivery fee must be a number.", error_code="INVALID_FEE") from None
        if not 0 <= fee_value <= 100000:
            raise ValidationError("The delivery fee must be between ₹0 and ₹1,00,000.", error_code="INVALID_FEE")
        fee = billing.to_minor(fee_value)

    def flag(key: str, default: bool) -> bool:
        value = payload.get(key, default)
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes", "y")
        return bool(value)

    return {
        "pincode": code,
        "city": str(payload.get("city") or "").strip()[:120],
        "district": str(payload.get("district") or "").strip()[:120],
        "state": str(payload.get("state") or "").strip()[:120],
        "serviceable": flag("serviceable", True),
        "cod_available": flag("codAvailable", True),
        "express_available": flag("expressAvailable", True),
        "min_days": min_days,
        "max_days": max_days,
        "delivery_fee": fee,
        "courier": str(payload.get("courier") or "").strip()[:60],
        "notes": str(payload.get("notes") or "").strip()[:255],
        "active": flag("active", True),
    }


def save(db: Session, payload: dict, row_id: Optional[int] = None) -> DeliveryPincode:
    values = _clean(payload)
    now = datetime.utcnow()
    clash = db.execute(select(DeliveryPincode).where(DeliveryPincode.pincode == values["pincode"])).scalar_one_or_none()
    if row_id is None:
        if clash is not None:
            raise ConflictError(f"{values['pincode']} is already listed — edit that entry instead.",
                                error_code="DUPLICATE")
        row = DeliveryPincode(created_at=now, updated_at=now, **values)
        db.add(row)
    else:
        row = db.get(DeliveryPincode, row_id)
        if row is None:
            raise NotFoundError("No such pincode entry.", error_code="NOT_FOUND")
        if clash is not None and clash.id != row.id:
            raise ConflictError(f"{values['pincode']} is already listed.", error_code="DUPLICATE")
        for key, value in values.items():
            setattr(row, key, value)
        row.updated_at = now
    db.commit()
    db.refresh(row)
    return row


def delete(db: Session, row_id: int) -> None:
    row = db.get(DeliveryPincode, row_id)
    if row is None:
        raise NotFoundError("No such pincode entry.", error_code="NOT_FOUND")
    db.delete(row)
    db.commit()


def search(db: Session, *, q: str = "", state: str = "", active: str = "", serviceable: str = "",
           cod: str = "", page: int = 1, page_size: int = 25) -> tuple:
    conditions = []
    text = (q or "").strip()
    if text:
        like = f"%{text}%"
        conditions.append(or_(DeliveryPincode.pincode.like(like), DeliveryPincode.city.ilike(like),
                              DeliveryPincode.district.ilike(like), DeliveryPincode.state.ilike(like)))
    if state:
        conditions.append(DeliveryPincode.state == state)
    for flag, column in ((active, DeliveryPincode.active), (serviceable, DeliveryPincode.serviceable),
                         (cod, DeliveryPincode.cod_available)):
        if flag in ("yes", "no"):
            conditions.append(column.is_(flag == "yes"))
    total = db.execute(select(func.count()).select_from(DeliveryPincode).where(*conditions)).scalar_one()
    rows = db.execute(
        select(DeliveryPincode).where(*conditions).order_by(DeliveryPincode.pincode)
        .offset((max(1, page) - 1) * page_size).limit(page_size)
    ).scalars().all()
    states = [s for (s,) in db.execute(
        select(DeliveryPincode.state).where(DeliveryPincode.state != "").distinct().order_by(DeliveryPincode.state)
    ).all()]
    summary = dict(db.execute(select(DeliveryPincode.active, func.count()).group_by(DeliveryPincode.active)).all())
    return list(rows), total, states, {"active": summary.get(True, 0), "inactive": summary.get(False, 0)}


CSV_COLUMNS = ["pincode", "city", "district", "state", "serviceable", "codAvailable", "expressAvailable",
               "minDays", "maxDays", "deliveryFee", "courier", "active", "notes"]


def import_csv(db: Session, content: str) -> dict:
    """
    Add or update entries from CSV, matched on pincode.

    Every row is validated first; if any is wrong nothing is written, and each
    problem is reported with its line number — a half-imported sheet is worse
    than none.
    """
    reader = csv.DictReader(io.StringIO((content or "").lstrip("﻿")))
    if not reader.fieldnames or "pincode" not in [f.strip() for f in reader.fieldnames]:
        raise ValidationError("The first row must be the column names, including 'pincode'.", error_code="CSV_HEADER")
    cleaned, errors, seen = [], [], set()
    for number, raw in enumerate(reader, start=2):
        if number - 1 > MAX_IMPORT_ROWS:
            raise ValidationError(f"Import up to {MAX_IMPORT_ROWS} rows at a time.", error_code="CSV_TOO_LARGE")
        row = {k.strip(): (v or "").strip() for k, v in raw.items() if k}
        if not any(row.values()):
            continue
        try:
            values = _clean(row)
        except ValidationError as problem:
            errors.append({"line": number, "pincode": row.get("pincode", ""), "error": problem.message})
            continue
        if values["pincode"] in seen:
            errors.append({"line": number, "pincode": values["pincode"], "error": "Listed twice in this file."})
            continue
        seen.add(values["pincode"])
        cleaned.append(values)
    if errors:
        return {"created": 0, "updated": 0, "errors": errors[:100], "errorCount": len(errors)}

    now = datetime.utcnow()
    existing = {r.pincode: r for r in db.execute(
        select(DeliveryPincode).where(DeliveryPincode.pincode.in_([v["pincode"] for v in cleaned]))
    ).scalars()} if cleaned else {}
    created = updated = 0
    for values in cleaned:
        row = existing.get(values["pincode"])
        if row is None:
            db.add(DeliveryPincode(created_at=now, updated_at=now, **values))
            created += 1
        else:
            for key, value in values.items():
                setattr(row, key, value)
            row.updated_at = now
            updated += 1
    db.commit()
    return {"created": created, "updated": updated, "errors": [], "errorCount": 0}


def export_rows(db: Session) -> List[dict]:
    return [view(r) for r in db.execute(select(DeliveryPincode).order_by(DeliveryPincode.pincode)).scalars()]
