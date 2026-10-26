"""
What customers do with virtual try-on.

Every check is made here, on the server, whatever the storefront shows:
the feature is on, storage is available, the product can be tried on and a
verified model can run it, the photo is the customer's own, the plan (or
trial, or allocation) allows it, the customer is under every limit, and some
credential could run it. Only then is a request queued; the worker checks the
entitlement again when it starts.

Requests are idempotent: the storefront sends a key per "Try it on" press,
and the same key always returns the same request — a double click, a retried
network call or a refresh never charges twice.
"""

from __future__ import annotations

import logging
import re
import secrets
from datetime import date, datetime, timedelta
from typing import Optional, Tuple

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import rate_limit
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import (
    Customer,
    Product,
    ProductColor,
    ProductSize,
    VtoCleanupTask,
    VtoModel,
    VtoPhoto,
    VtoRequest,
)
from app.services.try_on import catalogue, entitlements, images, programme, selection, storage
from app.services.try_on.errors import TryOnError, describe
from app.utils.ids import next_id

logger = logging.getLogger(__name__)

_KEY = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
UNSAVED_PHOTO_HOURS = 2
ACTIVE = entitlements.ACTIVE_STATUSES


# ------------------------------------------------------------------ storage


def discard(db: Session, storage_name: str, key: str, reason: str) -> bool:
    """Delete a stored object now; if that fails, queue it so it is retried until it goes."""
    if not storage_name or not key:
        return True
    try:
        storage.backend(storage_name).delete(key)
        return True
    except storage.StorageFailed as error:
        now = datetime.utcnow()
        db.add(VtoCleanupTask(storage=storage_name, object_key=key, reason=reason[:40], attempts=1,
                              next_attempt_at=now + timedelta(minutes=5), last_error=str(error)[:300],
                              created_at=now))
        return False


# ---------------------------------------------------------------- products


def _published_product(db: Session, product_id: str) -> Product:
    from app.services import products

    try:
        return products.get_product_by_identifier(db, (product_id or "")[:160], published_only=True)
    except NotFoundError:
        raise NotFoundError("We couldn't find that product.", error_code="PRODUCT_NOT_FOUND") from None


def product_offer(db: Session, customer: Optional[Customer], product_id: str) -> dict:
    """Everything the product page's try-on panel needs — no secrets, no internals."""
    product = _published_product(db, product_id)
    settings = programme.get(db)
    capability_key, why = catalogue.capability_for(db, product)
    states = catalogue.capability_states(db)
    state = states.get(capability_key, "unsupported") if capability_key else "unsupported"
    capability = catalogue.get_capability(db, capability_key) if capability_key else None
    summary = entitlements.summary(db, customer) if customer else None
    models = selection.models_for(db, capability_key) if capability_key and state == "available" else []
    if summary and summary["eligible"] and capability_key:
        rules = entitlements.resolve(db, customer).rules
        if rules.get("qualityTiers"):
            models = [m for m in models if m.quality_tier in rules["qualityTiers"]]
    if not settings["enabled"]:
        state = "off"
    store = storage.status()
    return {
        "productId": product.id,
        "productName": product.name,
        "state": state if store["active"] != "none" else "off",
        "reason": why,
        "capability": {
            "key": capability.key, "name": capability.name, "subjectKind": capability.subject_kind,
            "guidance": capability.guidance or [], "inputRules": capability.input_rules or {},
        } if capability else None,
        "eligibility": summary,
        "models": [{"id": m.id, "name": m.name, "qualityTier": m.quality_tier, "avgSeconds": m.avg_seconds}
                   for m in models] if summary and summary.get("modelChoice") else [],
        "avgSeconds": models[0].avg_seconds if models else None,
        "privacyNotice": settings["privacyNotice"],
        "storage": {"mode": store["active"], "ephemeralMinutes": store["ephemeralTtlMinutes"]},
        "feedback": settings["feedback"],
    }


# ------------------------------------------------------------------- photos


def _own_photo(db: Session, customer: Customer, photo_id: str) -> VtoPhoto:
    photo = db.get(VtoPhoto, (photo_id or "")[:20])
    if photo is None or photo.customer_id != customer.id or photo.deleted_at is not None:
        raise NotFoundError("We couldn't find that photo.", error_code="PHOTO_NOT_FOUND")
    if photo.expires_at is not None and photo.expires_at <= datetime.utcnow():
        raise NotFoundError("That photo has expired. Please upload it again.", error_code="PHOTO_EXPIRED")
    return photo


def photo_out(photo: VtoPhoto) -> dict:
    return {"id": photo.id, "width": photo.width, "height": photo.height, "saved": photo.saved,
            "storage": photo.storage, "expiresAt": photo.expires_at, "createdAt": photo.created_at}


def upload_photo(db: Session, customer: Customer, data: bytes, *, save: bool = False,
                 capability_key: str = "") -> VtoPhoto:
    settings = programme.get(db)
    if not settings["enabled"]:
        raise TryOnError("plan_ineligible", "Virtual try-on is switched off right now.", status_code=403)
    entitlement = entitlements.resolve(db, customer)
    if not entitlement.eligible:
        raise TryOnError("plan_ineligible", status_code=403)
    rate_limit.check(f"vto-upload:{customer.id}", limit=settings["uploadsPerHour"], window_seconds=3600,
                     message="You've uploaded a lot of photos. Please wait a while and try again.")
    rules = {}
    if capability_key:
        try:
            rules = catalogue.get_capability(db, capability_key).input_rules or {}
        except NotFoundError:
            rules = {}
    normalised = images.normalise(data, max_bytes=images.max_upload_bytes(entitlement.rules.get("maxUploadMb")),
                                  rules=rules)
    backend = storage.require_active()
    key = storage.new_key("photos", customer.id)
    try:
        backend.put(key, normalised.data, normalised.content_type)
    except storage.StorageFailed:
        raise TryOnError("storage_unavailable", status_code=503) from None

    now = datetime.utcnow()
    keep = save and backend.name == "s3"
    if backend.name == "ephemeral":
        expires = storage.expires_for("ephemeral", "temporary", None, now)
    elif keep:
        expires = storage.expires_for("s3", entitlement.rules.get("retention", "temporary"),
                                      entitlement.rules.get("retentionDays"), now)
    else:
        expires = now + timedelta(hours=UNSAVED_PHOTO_HOURS)
    photo = VtoPhoto(id=next_id(db, VtoPhoto, "vto_photo"), customer_id=customer.id, storage=backend.name,
                     object_key=key, content_type=normalised.content_type, width=normalised.width,
                     height=normalised.height, size_bytes=len(normalised.data), saved=keep, expires_at=expires,
                     created_at=now)
    db.add(photo)
    db.commit()
    return photo


def list_photos(db: Session, customer: Customer) -> list:
    now = datetime.utcnow()
    return list(db.execute(select(VtoPhoto).where(
        VtoPhoto.customer_id == customer.id, VtoPhoto.saved.is_(True), VtoPhoto.deleted_at.is_(None),
        (VtoPhoto.expires_at.is_(None)) | (VtoPhoto.expires_at > now),
    ).order_by(VtoPhoto.created_at.desc()).limit(20)).scalars())


def photo_in_use(db: Session, photo: VtoPhoto) -> bool:
    return db.execute(select(func.count()).select_from(VtoRequest).where(
        VtoRequest.photo_id == photo.id, VtoRequest.deleted_at.is_(None),
        VtoRequest.status.in_(ACTIVE + ("succeeded",)), VtoRequest.result_deleted_at.is_(None))).scalar_one() > 0


def delete_photo(db: Session, customer: Customer, photo_id: str) -> dict:
    photo = db.get(VtoPhoto, (photo_id or "")[:20])
    if photo is None or photo.customer_id != customer.id or photo.deleted_at is not None:
        raise NotFoundError("We couldn't find that photo.", error_code="PHOTO_NOT_FOUND")
    if db.execute(select(func.count()).select_from(VtoRequest).where(
            VtoRequest.photo_id == photo.id, VtoRequest.status.in_(ACTIVE))).scalar_one():
        raise ConflictError("That photo is being used by a try-on in progress.", error_code="PHOTO_IN_USE")
    done = discard(db, photo.storage, photo.object_key, "customer_deleted")
    photo.deleted_at = datetime.utcnow()
    db.commit()
    return {"deleted": True, "pending": not done}


def _photo_bytes(photo: VtoPhoto) -> Optional[bytes]:
    try:
        return storage.backend(photo.storage).get(photo.object_key)
    except storage.StorageFailed:
        return None


# ----------------------------------------------------------------- requests


def _idempotency_key(raw: Optional[str]) -> str:
    raw = (raw or "").strip()
    if not raw:
        return "auto-" + secrets.token_hex(16)
    if not _KEY.match(raw):
        raise ValidationError("The request key must be 8–64 letters, digits, '-' or '_'.", error_code="INVALID_KEY")
    return raw


def _existing(db: Session, customer_id: str, key: str) -> Optional[VtoRequest]:
    return db.execute(select(VtoRequest).where(
        VtoRequest.customer_id == customer_id, VtoRequest.idempotency_key == key)).scalar_one_or_none()


def _check_variant(db: Session, product: Product, color: str, size: str) -> Tuple[str, str]:
    color, size = (color or "").strip()[:60], (size or "").strip()[:30]
    if color:
        names = {c.lower(): c for c in db.execute(select(ProductColor.name).where(
            ProductColor.product_id == product.id)).scalars()}
        if names and color.lower() not in names:
            raise ValidationError("Choose one of this product's colours.", error_code="INVALID_COLOR")
        color = names.get(color.lower(), color)
    if size:
        labels = set(db.execute(select(ProductSize.label).where(ProductSize.product_id == product.id)).scalars())
        if labels and size not in labels:
            raise ValidationError("Choose one of this product's sizes.", error_code="INVALID_SIZE")
    return color, size


def submit(db: Session, customer: Customer, payload: dict, idempotency_key: Optional[str] = None
           ) -> Tuple[VtoRequest, bool]:
    """Queue a try-on. Returns (request, created) — created is False for a repeated key."""
    if not isinstance(payload, dict):
        raise ValidationError("Send the try-on as an object.", error_code="INVALID_REQUEST")
    key = _idempotency_key(idempotency_key or payload.get("clientRequestId"))
    existing = _existing(db, customer.id, key)
    if existing is not None:
        return existing, False

    settings = programme.get(db)
    if not settings["enabled"]:
        raise TryOnError("plan_ineligible", "Virtual try-on is switched off right now.", status_code=403)
    backend = storage.require_active()
    product = _published_product(db, str(payload.get("productId") or ""))
    capability_key, _ = catalogue.capability_for(db, product)
    state = catalogue.capability_states(db).get(capability_key, "unsupported") if capability_key else "unsupported"
    if state != "available":
        message = ("Try-on for this kind of item is coming soon." if state == "coming_soon"
                   else "Try-on isn't available for this item right now." if state == "unavailable"
                   else "Try-on isn't available for this item.")
        raise TryOnError("unsupported_category", message)
    color, size = _check_variant(db, product, str(payload.get("color") or ""), str(payload.get("size") or ""))
    photo = _own_photo(db, customer, str(payload.get("photoId") or ""))
    rate_limit.check(f"vto-submit:{customer.id}", limit=settings["submitPerHour"], window_seconds=3600,
                     message="You've started a lot of try-ons. Please wait a while and try again.")

    # From here on, this customer's quota decisions happen one at a time.
    entitlements.lock_customer(db, customer.id)
    existing = _existing(db, customer.id, key)
    if existing is not None:
        return existing, False
    now = datetime.utcnow()
    entitlement = entitlements.resolve(db, customer, now)
    charge = entitlements.choose_charge(db, entitlement, capability_key, now)
    rules = entitlement.rules
    if entitlements.in_progress(db, customer.id) >= int(rules.get("concurrent") or 1):
        raise TryOnError("concurrency_limit", status_code=429)
    retention = rules.get("retention", "temporary")
    if (backend.name == "s3" and retention == "permanent" and rules.get("storageQuota")
            and entitlements.stored_results(db, customer.id) >= rules["storageQuota"]):
        raise TryOnError("limit_reached", "Your saved try-ons are full. Delete some to make room.", status_code=429)

    requested = str(payload.get("modelId") or "").strip()[:20] or None
    tiers = rules.get("qualityTiers") or None
    if requested:
        allowed = [m.id for m in selection.models_for(db, capability_key, quality_tiers=tiers)]
        if not rules.get("modelChoice") or requested not in allowed:
            raise ValidationError("That quality option isn't available for this item.", error_code="INVALID_MODEL")
    if not selection.has_capacity(db, customer.id, capability_key, product.category_id, tiers):
        raise TryOnError("no_capacity", status_code=503)

    request = VtoRequest(
        id=next_id(db, VtoRequest, "vto_request"), customer_id=customer.id, product_id=product.id,
        product_name=product.name[:200], color=color, size=size, capability_key=capability_key,
        category_id=product.category_id or "", photo_id=photo.id, requested_model_id=requested,
        credential_label="", source=charge.source, membership_id=charge.membership_id,
        plan_id=entitlement.plan_id, plan_name=(entitlement.plan_name or ("Trial" if charge.source == "trial" else
                                                                           "Allocation"))[:80],
        status="queued", error_code="", error_badge="", error_message="", technical_detail="", retryable=False,
        attempts=0, retries_used=0, cancel_requested=False, idempotency_key=key, queued_at=now,
        storage_mode="ephemeral" if backend.name == "ephemeral" else retention, result_storage="", result_key="",
        result_content_type="", favourite=False, feedback_comment="", notices=[], created_at=now, updated_at=now,
    )
    db.add(request)
    entitlements.reserve(db, request, charge, now)
    # The photo must outlive the request; extend an unsaved one if needed.
    if not photo.saved and photo.expires_at is not None and backend.name == "s3":
        photo.expires_at = max(photo.expires_at, now + timedelta(hours=UNSAVED_PHOTO_HOURS))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = _existing(db, customer.id, key)
        if existing is None:
            raise
        return existing, False
    return request, True


def own_request(db: Session, customer: Customer, request_id: str) -> VtoRequest:
    request = db.get(VtoRequest, (request_id or "")[:20])
    if request is None or request.customer_id != customer.id or request.deleted_at is not None:
        raise NotFoundError("We couldn't find that try-on.", error_code="TRY_ON_NOT_FOUND")
    return request


def _queue_position(db: Session, request: VtoRequest) -> Optional[int]:
    if request.status != "queued" or request.queued_at is None:
        return None
    return db.execute(select(func.count()).select_from(VtoRequest).where(
        VtoRequest.status == "queued", VtoRequest.queued_at < request.queued_at)).scalar_one() + 1


def result_available(request: VtoRequest, now: Optional[datetime] = None) -> bool:
    now = now or datetime.utcnow()
    return (request.status == "succeeded" and bool(request.result_key) and request.result_deleted_at is None
            and (request.result_expires_at is None or request.result_expires_at > now))


def request_out(db: Session, request: VtoRequest, *, rules: Optional[dict] = None) -> dict:
    """The customer's view of a request: plain-language status and error, nothing technical."""
    from app.models import ProductImage, VtoCapability

    now = datetime.utcnow()
    failure = describe(request.error_code) if request.error_code else None
    rules = rules or {}
    image = None
    if request.product_id:
        image = db.execute(select(ProductImage.url).where(ProductImage.product_id == request.product_id)
                           .order_by(ProductImage.position, ProductImage.id).limit(1)).scalar()
    capability = db.get(VtoCapability, request.capability_key)
    model = db.get(VtoModel, request.model_id) if request.model_id else None
    available = result_available(request, now)
    photo = db.get(VtoPhoto, request.photo_id) if request.photo_id else None
    original = bool(photo and photo.deleted_at is None and (photo.expires_at is None or photo.expires_at > now))
    eta = None
    if request.status in ACTIVE:
        models = selection.models_for(db, request.capability_key)
        avg = models[0].avg_seconds if models else 45
        position = _queue_position(db, request) or 0
        elapsed = int((now - (request.started_at or now)).total_seconds()) if request.status != "queued" else 0
        eta = max(5, avg * max(position, 1) - elapsed)
    return {
        "id": request.id,
        "status": request.status,
        "product": {"id": request.product_id, "name": request.product_name, "image": image},
        "color": request.color,
        "size": request.size,
        "capability": {"key": request.capability_key, "name": capability.name if capability else request.capability_key},
        "model": {"name": model.name, "qualityTier": model.quality_tier} if model else None,
        "queuePosition": _queue_position(db, request),
        "etaSeconds": eta,
        "error": {"code": request.error_code, "message": failure.customer, "retryable": request.retryable}
        if failure and request.status in ("failed", "cancelled", "expired") else None,
        "canRetry": request.status == "failed" and request.retryable,
        "canCancel": request.status in ("queued", "processing", "retrying") and not request.cancel_requested,
        "result": {
            "available": available,
            "mode": request.storage_mode,
            "expiresAt": request.result_expires_at,
            "downloadable": available and rules.get("download", True),
            "deleted": request.result_deleted_at is not None,
        },
        "original": {"available": original},
        "favourite": request.favourite,
        "feedback": {"rating": request.feedback_rating, "comment": request.feedback_comment}
        if request.feedback_rating else None,
        "createdAt": request.created_at,
        "startedAt": request.started_at,
        "finishedAt": request.finished_at,
        "durationMs": request.duration_ms,
    }


def list_requests(db: Session, customer: Customer, *, status: str = "", product_id: str = "",
                  date_from: Optional[date] = None, date_to: Optional[date] = None, favourites: bool = False,
                  page: int = 1, page_size: int = 12) -> Tuple[list, int]:
    conditions = [VtoRequest.customer_id == customer.id, VtoRequest.deleted_at.is_(None)]
    if status == "active":
        conditions.append(VtoRequest.status.in_(ACTIVE))
    elif status in ("succeeded", "failed", "cancelled", "expired", "queued", "processing"):
        conditions.append(VtoRequest.status == status)
    if product_id:
        conditions.append(VtoRequest.product_id == product_id[:20])
    if date_from:
        conditions.append(VtoRequest.created_at >= datetime.combine(date_from, datetime.min.time()))
    if date_to:
        conditions.append(VtoRequest.created_at < datetime.combine(date_to + timedelta(days=1), datetime.min.time()))
    if favourites:
        conditions.append(VtoRequest.favourite.is_(True))
    total = db.execute(select(func.count()).select_from(VtoRequest).where(*conditions)).scalar_one()
    rows = db.execute(select(VtoRequest).where(*conditions).order_by(VtoRequest.created_at.desc(), VtoRequest.id.desc())
                      .offset((max(page, 1) - 1) * page_size).limit(page_size)).scalars().all()
    return list(rows), total


def retry(db: Session, customer: Customer, request_id: str) -> VtoRequest:
    """Run a failed request again, within the plan's retry allowance and quota."""
    entitlements.lock_customer(db, customer.id)
    request = own_request(db, customer, request_id)
    if request.status in ACTIVE:
        return request
    if request.status != "failed" or not request.retryable:
        raise ConflictError("This try-on can't be retried.", error_code="NOT_RETRYABLE")
    now = datetime.utcnow()
    entitlement = entitlements.resolve(db, customer, now)
    rules = entitlement.rules
    if request.retries_used >= int(rules.get("retriesPerRequest") or 0):
        raise ConflictError("You've used the retries for this try-on. Start a new one instead.",
                            error_code="RETRIES_USED")
    photo = db.get(VtoPhoto, request.photo_id) if request.photo_id else None
    if photo is None or photo.deleted_at is not None or (photo.expires_at and photo.expires_at <= now):
        raise ConflictError("The photo for this try-on has expired. Please start a new one.", error_code="PHOTO_EXPIRED")
    charge = entitlements.choose_charge(db, entitlement, request.capability_key, now)
    if entitlements.in_progress(db, customer.id) >= int(rules.get("concurrent") or 1):
        raise TryOnError("concurrency_limit", status_code=429)
    entitlements.reserve(db, request, charge, now)
    request.status, request.retries_used = "queued", request.retries_used + 1
    request.error_code = request.error_badge = request.error_message = request.technical_detail = ""
    request.retryable, request.cancel_requested, request.lease_until = False, False, None
    request.queued_at, request.started_at, request.finished_at, request.updated_at = now, None, None, now
    if not photo.saved and photo.expires_at is not None and photo.storage == "s3":
        photo.expires_at = max(photo.expires_at, now + timedelta(hours=UNSAVED_PHOTO_HOURS))
    db.commit()
    return request


def cancel(db: Session, customer: Customer, request_id: str) -> VtoRequest:
    request = own_request(db, customer, request_id)
    if request.status not in ACTIVE:
        raise ConflictError("Only a try-on in progress can be cancelled.", error_code="NOT_CANCELLABLE")
    now = datetime.utcnow()
    if request.status == "queued":
        _finish_failed(request, "cancelled", "", now)
        entitlements.settle(db, request.id, "cancelled")
    else:
        # Running: the worker stops at its next step and discards any result.
        request.cancel_requested = True
        request.updated_at = now
    db.commit()
    return request


def _finish_failed(request: VtoRequest, code: str, detail: str, now: datetime, *, retryable: bool = False) -> None:
    failure = describe(code)
    request.status = "cancelled" if code == "cancelled" else "failed"
    request.error_code, request.error_badge = failure.code, failure.badge
    request.error_message = failure.admin[:255]
    request.technical_detail = detail[:600]
    request.retryable = retryable
    request.finished_at, request.updated_at, request.lease_until = now, now, None
    if request.started_at:
        request.duration_ms = int((now - request.started_at).total_seconds() * 1000)


def delete_request(db: Session, customer: Customer, request_id: str) -> dict:
    """
    Delete a try-on: its result and, unless saved for reuse, its photo. The
    request is hidden from the customer at once; storage that refuses the
    deletion is retried by the clean-up job until it succeeds.
    """
    request = own_request(db, customer, request_id)
    if request.status in ACTIVE:
        raise ConflictError("Cancel the try-on before deleting it.", error_code="TRY_ON_IN_PROGRESS")
    now = datetime.utcnow()
    done = discard(db, request.result_storage, request.result_key, "customer_deleted")
    request.result_deleted_at = request.result_deleted_at or now
    request.deleted_at, request.updated_at = now, now
    photo = db.get(VtoPhoto, request.photo_id) if request.photo_id else None
    if photo is not None and photo.deleted_at is None and not photo.saved:
        db.flush()
        if not photo_in_use(db, photo):
            done = discard(db, photo.storage, photo.object_key, "customer_deleted") and done
            photo.deleted_at = now
    db.commit()
    return {"deleted": True, "pending": not done}


def image_of(db: Session, customer: Customer, request_id: str, which: str) -> Tuple[bytes, str]:
    """The result or the original photo, for the customer who owns it."""
    request = own_request(db, customer, request_id)
    now = datetime.utcnow()
    if which == "result":
        if not result_available(request, now):
            raise NotFoundError("This try-on's image isn't available.", error_code="RESULT_UNAVAILABLE")
        storage_name, key, content_type = request.result_storage, request.result_key, request.result_content_type
    else:
        photo = db.get(VtoPhoto, request.photo_id) if request.photo_id else None
        if photo is None or photo.deleted_at is not None or (photo.expires_at and photo.expires_at <= now):
            raise NotFoundError("The original photo isn't available.", error_code="PHOTO_UNAVAILABLE")
        storage_name, key, content_type = photo.storage, photo.object_key, photo.content_type
    try:
        data = storage.backend(storage_name).get(key)
    except storage.StorageFailed:
        raise TryOnError("storage_unavailable", status_code=503) from None
    if data is None:
        raise NotFoundError("This image has expired.", error_code="RESULT_EXPIRED")
    return data, content_type or "image/jpeg"


def download_link(db: Session, customer: Customer, request_id: str) -> Optional[str]:
    """A short-lived signed link to the result in S3, when the plan allows downloads. None: use the API."""
    request = own_request(db, customer, request_id)
    rules = entitlements.resolve(db, customer).rules
    if not result_available(request) :
        raise NotFoundError("This try-on's image isn't available.", error_code="RESULT_UNAVAILABLE")
    if not rules.get("download", True):
        raise TryOnError("plan_ineligible", "Your plan doesn't include downloading try-ons.", status_code=403)
    try:
        return storage.backend(request.result_storage).link(request.result_key, f"try-on-{request.id}.jpg",
                                                            inline=False)
    except storage.StorageFailed:
        raise TryOnError("storage_unavailable", status_code=503) from None


def set_favourite(db: Session, customer: Customer, request_id: str, favourite: bool) -> VtoRequest:
    request = own_request(db, customer, request_id)
    request.favourite = bool(favourite)
    request.updated_at = datetime.utcnow()
    db.commit()
    return request


def set_feedback(db: Session, customer: Customer, request_id: str, rating: int, comment: str) -> VtoRequest:
    request = own_request(db, customer, request_id)
    if request.status != "succeeded":
        raise ConflictError("Only a finished try-on can be rated.", error_code="NOT_FINISHED")
    request.feedback_rating = max(1, min(int(rating), 5))
    request.feedback_comment = (comment or "").strip()[:500]
    request.updated_at = datetime.utcnow()
    db.commit()
    return request
