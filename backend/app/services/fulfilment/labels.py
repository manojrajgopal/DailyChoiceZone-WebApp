"""
Shipping labels: our own label PDF for any shipment, manual or courier.
See docs/packing-and-labels.md.

## The rules this module keeps

- A label is generated from an **immutable snapshot** (seller, buyer,
  shipment, packages, items, COD) frozen when it is made. The PDF is drawn
  from the snapshot on every request: no file storage, and an old version
  reads exactly as printed.
- **Idempotent.** Generating again with no reason returns the current label.
  Regenerating needs a reason; the current version becomes `regenerated`
  (superseded) and the next version is current. At most one current label per
  shipment (`current_key`, enforced by the database).
- A label that can't be made is recorded as a `failed` version with the
  reason, and the admin gets a clear message: missing address, pincode, phone,
  weight, dimensions or SKU; no AWB; a cancelled shipment; a PDF failure.
- When the courier also made a label (Shiprocket), its link and the courier's
  shipment reference are kept on the record (`external_url`,
  `provider_reference`), so both are at hand.
- Bulk operations are synchronous and capped at 100 shipments; one failure
  never fails the batch.
"""

from __future__ import annotations

import io
import logging
import re
import zipfile
from datetime import datetime
from typing import Dict, List, Optional, Tuple

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from app.core.errors import AppError, ConflictError, NotFoundError, ValidationError
from app.models import Order
from app.models.fulfilment import ShippingLabel
from app.models.shipping import Shipment
from app.services import audit, billing
from app.services.fulfilment import label_pdf
from app.services.fulfilment import settings as fulfilment_settings

logger = logging.getLogger(__name__)

STATUS_LABELS = {"not-generated": "Not generated", "generating": "Generating", "generated": "Generated",
                 "failed": "Failed", "regenerated": "Superseded", "cancelled": "Cancelled"}
BULK_LIMIT = 100
PINCODE = re.compile(r"^[1-9][0-9]{5}$")
PHONE = re.compile(r"^\+?[0-9][0-9 -]{6,18}$")


class LabelInvalid(ValidationError):
    error_code = "LABEL_INVALID"


class LabelRenderFailed(AppError):
    status_code = 500
    error_code = "LABEL_RENDER_FAILED"


def _now() -> datetime:
    return datetime.utcnow().replace(microsecond=0)


def _shipment(db: Session, shipment_id, *, lock: bool = False) -> Shipment:
    from app.services.shipping import service

    return service.get(db, shipment_id, lock=lock)


def current(db: Session, shipment_id: int) -> Optional[ShippingLabel]:
    return db.execute(select(ShippingLabel).where(ShippingLabel.current_key == shipment_id)).scalar_one_or_none()


def _latest(db: Session, shipment_id: int) -> Optional[ShippingLabel]:
    return db.execute(select(ShippingLabel).where(ShippingLabel.shipment_id == shipment_id)
                      .order_by(ShippingLabel.version.desc())).scalars().first()


def _next_version(db: Session, shipment_id: int) -> int:
    return int(db.execute(select(func.max(ShippingLabel.version))
                          .where(ShippingLabel.shipment_id == shipment_id)).scalar() or 0) + 1


# ---------------------------------------------------------------- snapshot


def _seller(db: Session, shipment: Shipment) -> dict:
    store = billing.store_settings(db)
    business = billing.billing_config(db).get("business") or {}
    tax = billing.tax_config(db)
    contact = store.get("contact") or {}
    origin = shipment.origin or {}
    name = (store.get("general") or {}).get("storeName") or business.get("storeName") or origin.get("name") or ""
    if origin.get("line1"):
        address = {k: str(origin.get(k) or "") for k in ("line1", "line2", "city", "state", "pincode", "phone")}
    else:
        address = {"line1": business.get("addressLine1") or contact.get("addressLine") or "",
                   "line2": business.get("addressLine2") or "",
                   "city": business.get("city") or contact.get("city") or "",
                   "state": business.get("state") or contact.get("state") or "",
                   "pincode": business.get("postalCode") or contact.get("pincode") or "",
                   "phone": business.get("phone") or contact.get("phone") or ""}
    return {"name": name, **address, "gstin": tax.get("gstin") or (store.get("tax") or {}).get("gstin") or ""}


def _package_rows(db: Session, shipment: Shipment, order: Order) -> List[dict]:
    """One entry per physical package: the packing job's when it has them, else the shipment's figures."""
    from app.services.fulfilment import packing

    items = {item.id: item for item in order.items}
    packages = packing.packages_for_shipment(db, shipment)
    if packages:
        lines = {}
        for package in packages:
            if package.job is not None:
                lines.update({line.id: line for line in package.job.lines})
        out = []
        for package in packages:
            contents = []
            for entry in package.items:
                line = lines.get(entry.line_id)
                item = items.get(line.order_item_id) if line is not None else None
                if item is not None:
                    contents.append({"sku": item.sku or "", "name": item.name, "size": item.size or "",
                                     "color": item.color or "", "quantity": entry.quantity})
            out.append({"number": package.package_number, "weightGrams": package.weight_grams,
                        "lengthCm": float(package.length_cm) if package.length_cm is not None else None,
                        "widthCm": float(package.width_cm) if package.width_cm is not None else None,
                        "heightCm": float(package.height_cm) if package.height_cm is not None else None,
                        "type": package.package_type, "items": contents})
        return out
    count = max(1, int(shipment.package_count or 1))
    contents = [{"sku": i.sku or "", "name": i.name, "size": i.size or "", "color": i.color or "",
                 "quantity": i.quantity} for i in order.items]

    def dim(value):
        return float(value) if value is not None else None

    return [{"number": f"{shipment.shipment_number}/{n}", "weightGrams": shipment.weight_grams,
             "lengthCm": dim(shipment.length_cm), "widthCm": dim(shipment.width_cm),
             "heightCm": dim(shipment.height_cm), "type": shipment.package_type,
             # The contents go on the first label of an un-packed multi-box shipment.
             "items": contents if n == 1 else []} for n in range(1, count + 1)]


def snapshot(db: Session, shipment: Shipment, *, format_key: str, version: int, when: datetime) -> dict:
    order = db.get(Order, shipment.order_id)
    dest = shipment.destination or {}
    return {
        "format": format_key, "version": version, "generatedAt": when.isoformat(),
        "seller": _seller(db, shipment),
        "buyer": {k: str(dest.get(k) or "") for k in ("name", "phone", "line1", "line2", "city", "state",
                                                     "pincode", "country")},
        "shipment": {"id": shipment.id, "number": shipment.shipment_number, "awb": shipment.awb or "",
                     "courierName": shipment.courier_name, "service": shipment.service,
                     "providerCode": shipment.provider_code,
                     "orderNumber": order.order_number if order else "",
                     "orderDate": order.placed_at.isoformat() if order and order.placed_at else "",
                     "paymentMethod": order.payment_method if order else ""},
        "cod": bool(shipment.cod), "codAmount": int(shipment.cod_amount or 0),
        "declaredValue": int(shipment.declared_value or 0),
        "packages": _package_rows(db, shipment, order) if order is not None else [],
        "items": [{"sku": i.sku or "", "name": i.name, "size": i.size or "", "color": i.color or "",
                   "quantity": i.quantity} for i in (order.items if order else [])],
    }


# -------------------------------------------------------------- validation


def problems(db: Session, shipment: Shipment) -> List[dict]:
    """Why a label can't be made for this shipment now. Empty: it can."""
    out: List[dict] = []

    def add(code: str, message: str):
        out.append({"code": code, "message": message})

    if shipment.status == "cancelled":
        add("SHIPMENT_CANCELLED", "This shipment is cancelled; it can't have a label.")
        return out
    if not shipment.awb:
        if shipment.provider_code == "manual":
            add("AWB_REQUIRED", "Enter the courier's AWB on the shipment first.")
        else:
            add("AWB_REQUIRED", "The courier hasn't assigned an AWB yet. Retry the shipment, then try again.")
    dest = shipment.destination or {}
    missing = [label for key, label in (("name", "name"), ("line1", "address line"), ("city", "city"),
                                        ("state", "state")) if not str(dest.get(key) or "").strip()]
    if missing:
        add("ADDRESS_INCOMPLETE", f"The delivery address is missing: {', '.join(missing)}.")
    if not PINCODE.match(str(dest.get("pincode") or "").strip()):
        add("PINCODE_MISSING", "The delivery address needs a valid 6-digit pincode.")
    if not PHONE.match(str(dest.get("phone") or "").strip()):
        add("PHONE_MISSING", "The delivery address needs the customer's phone number.")
    order = db.get(Order, shipment.order_id)
    packages = _package_rows(db, shipment, order) if order is not None else []
    if not packages or any(not p.get("weightGrams") for p in packages):
        add("WEIGHT_MISSING", "Enter the package weight.")
    if not packages or any(p.get(k) is None for p in packages for k in ("lengthCm", "widthCm", "heightCm")):
        add("DIMENSIONS_MISSING", "Enter the package's length, width and height.")
    if order is not None and any(not (item.sku or "").strip() for item in order.items):
        add("SKU_MISSING", "An item on this order has no SKU. Add it to the product first.")
    return out


# ------------------------------------------------------------- generating


def _clean_format(db: Session, raw) -> str:
    if raw in (None, ""):
        return fulfilment_settings.settings(db)["labelFormat"]
    if raw not in label_pdf.FORMATS:
        raise ValidationError(f"The label format must be one of: {', '.join(label_pdf.FORMATS)}.",
                              error_code="INVALID_FORMAT", details={"field": "format"})
    return raw


def _record_failure(db: Session, shipment: Shipment, *, format_key: str, code: str, message: str, admin,
                    reason: str) -> ShippingLabel:
    row = ShippingLabel(shipment_id=shipment.id, version=_next_version(db, shipment.id), current_key=None,
                        status="failed", format=format_key, snapshot={}, page_count=0,
                        generated_by=getattr(admin, "id", "") or "system", reason=reason[:300],
                        error_code=code[:40], error_message=message[:500], created_at=_now(), updated_at=_now())
    db.add(row)
    audit.record(db, "label.failed", resource_type="shipment", resource_id=shipment.shipment_number, actor=admin,
                 summary=f"Label for {shipment.shipment_number} couldn't be made: {message}"[:500],
                 outcome="failure", error_code=code[:40], system=admin is None)
    db.commit()
    return row


def generate(db: Session, shipment_id, *, admin, format_key=None, reason: str = "") -> Tuple[ShippingLabel, bool]:
    """
    Make the shipment's label. Returns (label, created). With no reason and a
    current label, that label comes back unchanged (a double click is
    harmless). With a reason, the current one is superseded.
    """
    shipment = _shipment(db, shipment_id, lock=True)
    fmt = _clean_format(db, format_key)
    reason = (reason or "").strip()[:300]
    existing = current(db, shipment.id)
    if existing is not None and not reason:
        db.commit()
        return existing, False

    found = problems(db, shipment)
    if found:
        _record_failure(db, shipment, format_key=fmt, code=found[0]["code"], message=found[0]["message"],
                        admin=admin, reason=reason)
        raise LabelInvalid(found[0]["message"], error_code=found[0]["code"], details={"problems": found})

    now = _now()
    version = _next_version(db, shipment.id)
    data = snapshot(db, shipment, format_key=fmt, version=version, when=now)
    try:
        rendered = label_pdf.render(data, fmt)
    except Exception as error:  # a broken PDF is recorded, never a half-made label
        logger.exception("Label PDF for shipment %s failed", shipment.id)
        _record_failure(db, shipment, format_key=fmt, code="LABEL_RENDER_FAILED",
                        message="The label PDF couldn't be drawn. Please try again.", admin=admin, reason=reason)
        raise LabelRenderFailed("The label PDF couldn't be drawn. Please try again.") from error
    if not rendered.startswith(b"%PDF"):
        raise LabelRenderFailed("The label PDF couldn't be drawn. Please try again.")

    try:
        if existing is not None:
            existing.status = "regenerated"
            existing.current_key = None
            existing.superseded_at = now
            db.flush()
        row = ShippingLabel(shipment_id=shipment.id, version=version, current_key=shipment.id, status="generated",
                            format=fmt, snapshot=data, page_count=len(data["packages"]),
                            generated_by=getattr(admin, "id", "") or "system", generated_at=now, reason=reason,
                            provider_reference=(shipment.provider_shipment_id or "")[:64],
                            external_url=(shipment.label_url or "")[:1000], created_at=now, updated_at=now)
        db.add(row)
        db.flush()
        audit.record(db, "label.regenerate" if existing is not None else "label.generate", resource_type="shipment",
                     resource_id=shipment.shipment_number, actor=admin,
                     summary=(f"Label v{version} for {shipment.shipment_number}"
                              + (f" (replaces v{existing.version}: {reason})" if existing is not None else "")),
                     changes=audit.diff({}, {"version": version, "format": fmt}), system=admin is None)
        db.commit()
    except (IntegrityError, OperationalError):
        # Another request made it first.
        db.rollback()
        winner = current(db, shipment.id)
        if winner is not None:
            return winner, False
        raise ConflictError("The label is being made by another request. Please try again.",
                            error_code="LABEL_BUSY") from None
    return row, True


def regenerate(db: Session, shipment_id, *, admin, reason, format_key=None) -> ShippingLabel:
    text = reason.strip() if isinstance(reason, str) else ""
    if len(text) < 3:
        raise ValidationError("Say why the label is being made again.", error_code="REASON_REQUIRED",
                              details={"field": "reason"})
    label, _ = generate(db, shipment_id, admin=admin, format_key=format_key, reason=text)
    return label


def cancel(db: Session, shipment_id, *, admin, reason: str = "") -> ShippingLabel:
    shipment = _shipment(db, shipment_id, lock=True)
    label = current(db, shipment.id)
    if label is None:
        raise ConflictError("This shipment has no current label.", error_code="NO_LABEL")
    _void(label, reason=(reason or "").strip()[:300] or "Cancelled by the team.")
    audit.record(db, "label.cancel", resource_type="shipment", resource_id=shipment.shipment_number, actor=admin,
                 summary=f"Label v{label.version} for {shipment.shipment_number} cancelled")
    db.commit()
    return label


def _void(label: ShippingLabel, *, reason: str) -> None:
    label.status = "cancelled"
    label.current_key = None
    label.cancelled_at = _now()
    label.cancel_reason = reason[:300]


def on_shipment_cancelled(db: Session, shipment: Shipment) -> None:
    """The shipment is cancelled: so is its label. Never commits."""
    label = current(db, shipment.id)
    if label is not None:
        _void(label, reason="The shipment was cancelled.")


# ------------------------------------------------------------------ reading


def view(label: ShippingLabel) -> dict:
    return {
        "id": label.id, "shipmentId": label.shipment_id, "version": label.version, "status": label.status,
        "statusLabel": STATUS_LABELS.get(label.status, label.status), "format": label.format,
        "formatName": label_pdf.FORMATS[label.format].name if label.format in label_pdf.FORMATS else label.format,
        "current": label.current_key is not None, "pageCount": label.page_count,
        "generatedBy": label.generated_by, "generatedAt": label.generated_at, "reason": label.reason,
        "providerReference": label.provider_reference, "externalUrl": label.external_url,
        "errorCode": label.error_code, "errorMessage": label.error_message,
        "cancelledAt": label.cancelled_at, "cancelReason": label.cancel_reason, "supersededAt": label.superseded_at,
        "createdAt": label.created_at,
        "printable": label.status in ("generated", "regenerated", "cancelled") and bool(label.snapshot),
    }


def overview(db: Session, shipment_id) -> dict:
    shipment = _shipment(db, shipment_id)
    rows = list(db.execute(select(ShippingLabel).where(ShippingLabel.shipment_id == shipment.id)
                           .order_by(ShippingLabel.version.desc())).scalars())
    now = current(db, shipment.id)
    latest = rows[0] if rows else None
    found = problems(db, shipment)
    return {
        "shipmentId": shipment.id, "status": now.status if now else (latest.status if latest else "not-generated"),
        "current": view(now) if now else None,
        "history": [view(r) for r in rows],
        "problems": found, "canGenerate": not found,
        "courierLabelUrl": shipment.label_url or "",
        "formats": label_pdf.formats(), "defaultFormat": fulfilment_settings.settings(db)["labelFormat"],
    }


def get_label(db: Session, label_id) -> ShippingLabel:
    try:
        key = int(label_id)
    except (TypeError, ValueError):
        key = None
    label = db.get(ShippingLabel, key) if key is not None else None
    if label is None:
        raise NotFoundError("No such label.", error_code="LABEL_NOT_FOUND")
    return label


def _filename(label: ShippingLabel) -> str:
    awb = re.sub(r"[^A-Za-z0-9-]", "", (label.snapshot or {}).get("shipment", {}).get("awb", "")) or "label"
    return f"label-{awb}-v{label.version}.pdf"


def pdf(db: Session, label_id) -> Tuple[bytes, str]:
    label = get_label(db, label_id)
    if not label.snapshot or label.status in ("failed", "generating"):
        raise ConflictError("This label version wasn't generated; there's nothing to print.",
                            error_code="LABEL_NOT_AVAILABLE")
    data = dict(label.snapshot)
    if label.status != "generated":
        data["void"] = "CANCELLED" if label.status == "cancelled" else "SUPERSEDED"
    try:
        return label_pdf.render(data, label.format), _filename(label)
    except Exception as error:
        logger.exception("Label %s could not be drawn", label.id)
        raise LabelRenderFailed("The label PDF couldn't be drawn. Please try again.") from error


def states(db: Session, shipment_ids: List[int]) -> Dict[int, str]:
    """Each shipment's label status for the shipments list: the current label's, else the latest version's."""
    if not shipment_ids:
        return {}
    rows = db.execute(select(ShippingLabel.shipment_id, ShippingLabel.version, ShippingLabel.status,
                             ShippingLabel.current_key)
                      .where(ShippingLabel.shipment_id.in_(shipment_ids))).all()
    out: Dict[int, Tuple[int, str]] = {}
    for shipment_id, version, status, key in rows:
        rank = (1 if key is not None else 0, version)
        if shipment_id not in out or rank > out[shipment_id][0]:
            out[shipment_id] = (rank, status)
    return {k: v[1] for k, v in out.items()}


# --------------------------------------------------------------------- bulk


def clean_ids(raw) -> List[int]:
    if isinstance(raw, str):
        raw = [part for part in raw.split(",") if part.strip()]
    if not isinstance(raw, list) or not raw:
        raise ValidationError("Choose at least one shipment.", error_code="NO_SHIPMENTS",
                              details={"field": "shipmentIds"})
    out: List[int] = []
    for value in raw:
        if isinstance(value, bool):
            raise ValidationError("Shipment ids must be numbers.", error_code="INVALID_IDS")
        try:
            number = int(str(value).strip())
        except (TypeError, ValueError):
            raise ValidationError("Shipment ids must be numbers.", error_code="INVALID_IDS") from None
        if number not in out:
            out.append(number)
    if len(out) > BULK_LIMIT:
        raise ValidationError(f"At most {BULK_LIMIT} shipments at a time.", error_code="TOO_MANY",
                              details={"limit": BULK_LIMIT})
    return out


def bulk_generate(db: Session, raw_ids, *, admin, format_key=None) -> dict:
    ids = clean_ids(raw_ids)
    fmt = _clean_format(db, format_key)
    results = []
    for shipment_id in ids:
        try:
            label, created = generate(db, shipment_id, admin=admin, format_key=fmt)
            results.append({"shipmentId": shipment_id, "ok": True, "created": created, "label": view(label)})
        except AppError as error:
            db.rollback()
            results.append({"shipmentId": shipment_id, "ok": False,
                            "error": {"code": error.error_code, "message": error.message}})
        except Exception:  # one shipment never fails the batch
            db.rollback()
            logger.exception("Bulk label for shipment %s failed", shipment_id)
            results.append({"shipmentId": shipment_id, "ok": False,
                            "error": {"code": "LABEL_FAILED", "message": "The label couldn't be made."}})
    succeeded = sum(1 for r in results if r["ok"])
    return {"results": results, "succeeded": succeeded, "failed": len(results) - succeeded}


def bulk_file(db: Session, raw_ids, *, mode: str = "zip") -> Tuple[bytes, str, str, List[int]]:
    """The current labels of these shipments: a ZIP of PDFs, or one merged PDF to print. Returns (bytes, name, type, skipped)."""
    ids = clean_ids(raw_ids)
    found: List[ShippingLabel] = []
    skipped: List[int] = []
    for shipment_id in ids:
        label = current(db, shipment_id)
        (found.append(label) if label is not None else skipped.append(shipment_id))
    if not found:
        raise ConflictError("None of these shipments has a generated label.", error_code="NO_LABELS")
    stamp = _now().strftime("%Y%m%d-%H%M")
    if mode == "merged":
        try:
            data = label_pdf.render_many([dict(label.snapshot) for label in found])
        except Exception as error:
            logger.exception("Merged label PDF failed")
            raise LabelRenderFailed("The labels couldn't be put together. Please try again.") from error
        return data, f"labels-{stamp}.pdf", "application/pdf", skipped
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for label in found:
            content, name = pdf(db, label.id)
            info = zipfile.ZipInfo(name, date_time=(label.generated_at or _now()).timetuple()[:6])
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, content)
        if skipped:
            archive.writestr("not-included.txt", "These shipments have no generated label:\n"
                             + "\n".join(str(s) for s in skipped) + "\n")
    return buffer.getvalue(), f"labels-{stamp}.zip", "application/zip", skipped


# ------------------------------------------------------------------ summary


def summary(db: Session) -> dict:
    today = _now().replace(hour=0, minute=0, second=0)
    has_current = select(ShippingLabel.id).where(ShippingLabel.current_key == Shipment.id).exists()
    pending = db.execute(select(func.count()).select_from(Shipment)
                         .where(Shipment.awb.is_not(None),
                                Shipment.status.in_(("ready-for-pickup", "pickup-scheduled", "pending")),
                                ~has_current)).scalar_one()
    generated_today = db.execute(select(func.count()).select_from(ShippingLabel)
                                 .where(ShippingLabel.generated_at >= today,
                                        ShippingLabel.status.in_(("generated", "regenerated")))).scalar_one()
    latest = (select(ShippingLabel.shipment_id, func.max(ShippingLabel.version).label("v"))
              .group_by(ShippingLabel.shipment_id).subquery())
    failures = db.execute(select(func.count()).select_from(ShippingLabel)
                          .join(latest, (latest.c.shipment_id == ShippingLabel.shipment_id)
                                & (latest.c.v == ShippingLabel.version))
                          .join(Shipment, Shipment.id == ShippingLabel.shipment_id)
                          .where(ShippingLabel.status == "failed", Shipment.status != "cancelled")).scalar_one()
    return {"labelsPending": int(pending), "labelsGeneratedToday": int(generated_today),
            "labelFailures": int(failures)}

