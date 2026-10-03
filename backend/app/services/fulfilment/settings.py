"""
The `fulfilment` settings document: packing SLA, volumetric divisor, the
packing slip's price switch, and the label defaults (format and package).

Stored in `setting_documents` under the key `fulfilment`, merged over
`DEFAULTS` on read like the other feature documents (abandoned carts,
loyalty). Saved from Admin, Settings, Couriers (the "Packing and labels"
panel).
"""

from __future__ import annotations

import copy
from datetime import datetime

from sqlalchemy.orm import Session

from app.core.errors import ValidationError
from app.models import SettingDocument

KEY = "fulfilment"

DEFAULTS: dict = {
    # An order not packed this many hours after it was placed is overdue.
    "slaHours": 24,
    # Volumetric weight (kg) = L x W x H (cm) / divisor. 5000 is the usual
    # courier figure in India; some use 4000 for air.
    "volumetricDivisor": 5000,
    # Whether the packing slip prints prices by default (the slip can still be
    # printed either way).
    "slipShowPrices": False,
    # The label format used when none is asked for.
    "labelFormat": "thermal-4x6",
    # Prefills a new package (and a shipment with nothing else to go on).
    # Admin-entered; never invented. None until set.
    "defaultPackage": None,
}

PACKAGE_TYPES = ("box", "envelope", "polybag", "tube", "crate", "other")


def settings(db: Session) -> dict:
    stored = (db.get(SettingDocument, KEY) or SettingDocument(value={})).value or {}
    merged = copy.deepcopy(DEFAULTS)
    if isinstance(stored, dict):
        merged.update({k: copy.deepcopy(v) for k, v in stored.items() if k in DEFAULTS})
    return merged


def _whole(value, field: str, low: int, high: int) -> int:
    if isinstance(value, bool):
        raise ValidationError(f"{field} must be a whole number.", error_code="INVALID_SETTING",
                              details={"field": field})
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValidationError(f"{field} must be a whole number.", error_code="INVALID_SETTING",
                              details={"field": field}) from None
    if number != number or not number.is_integer() or not low <= number <= high:
        raise ValidationError(f"{field} must be a whole number from {low} to {high}.", error_code="INVALID_SETTING",
                              details={"field": field})
    return int(number)


def _package(raw):
    if raw in (None, {}):
        return None
    if not isinstance(raw, dict):
        raise ValidationError("The default package must be an object.", error_code="INVALID_SETTING",
                              details={"field": "defaultPackage"})
    from app.services.shipping.service import clean_package

    package = clean_package(raw, require_dimensions=True)
    if package.type not in PACKAGE_TYPES:
        raise ValidationError(f"The package type must be one of: {', '.join(PACKAGE_TYPES)}.",
                              error_code="INVALID_SETTING", details={"field": "defaultPackage.type"})
    return {"weightGrams": package.weight_grams, "lengthCm": package.length_cm, "widthCm": package.width_cm,
            "heightCm": package.height_cm, "type": package.type}


def save(db: Session, payload: dict, *, actor=None) -> dict:
    from app.services import audit
    from app.services.fulfilment.label_pdf import FORMATS

    if not isinstance(payload, dict):
        raise ValidationError("Send the settings as an object.", error_code="INVALID_SETTING")
    before = settings(db)
    out = copy.deepcopy(before)
    if "slaHours" in payload:
        out["slaHours"] = _whole(payload["slaHours"], "slaHours", 1, 24 * 14)
    if "volumetricDivisor" in payload:
        out["volumetricDivisor"] = _whole(payload["volumetricDivisor"], "volumetricDivisor", 1000, 10000)
    if "slipShowPrices" in payload:
        out["slipShowPrices"] = bool(payload["slipShowPrices"])
    if "labelFormat" in payload:
        if payload["labelFormat"] not in FORMATS:
            raise ValidationError(f"The label format must be one of: {', '.join(FORMATS)}.",
                                  error_code="INVALID_SETTING", details={"field": "labelFormat"})
        out["labelFormat"] = payload["labelFormat"]
    if "defaultPackage" in payload:
        out["defaultPackage"] = _package(payload["defaultPackage"])
    now = datetime.utcnow()
    row = db.get(SettingDocument, KEY)
    if row is None:
        db.add(SettingDocument(key=KEY, value=out, created_at=now, updated_at=now))
    else:
        row.value = out
        row.updated_at = now
    audit.record(db, "fulfilment.settings", resource_type="settings", resource_id=KEY, actor=actor,
                 summary="Packing and label settings changed", changes=audit.diff(before, out))
    db.commit()
    return out
