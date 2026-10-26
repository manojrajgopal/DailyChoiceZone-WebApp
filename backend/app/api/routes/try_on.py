"""
Virtual try-on (docs/virtual-try-on.md).

Shoppers:
    GET    /api/try-on/catalogue                 what can be tried on (public; drives badges)
    GET    /api/try-on/eligibility               your allowance, retention and storage
    GET    /api/try-on/products                  products you can try on, by capability / category
    GET    /api/try-on/products/{id}             the try-on panel for one product
    POST   /api/try-on/photos                    upload a photo (multipart)
    GET    /api/try-on/photos                    your saved photos
    DELETE /api/try-on/photos/{id}
    POST   /api/try-on/requests                  start a try-on (Idempotency-Key header)
    GET    /api/try-on/requests                  your history
    GET    /api/try-on/requests/{id}             one try-on (poll while it runs)
    POST   /api/try-on/requests/{id}/retry|cancel
    DELETE /api/try-on/requests/{id}             delete it and its images
    GET    /api/try-on/requests/{id}/image       the result or original (?which=original)
    GET    /api/try-on/requests/{id}/download    a short-lived download link, when stored in S3
    PUT    /api/try-on/requests/{id}/favourite|feedback
    GET    /api/try-on/usage
    GET/POST /api/try-on/access-requests         ask for more or dedicated access
    POST   /api/try-on/access-requests/{id}/withdraw
    GET    /api/try-on/allocations               extra access you've been given

Store (permission "try-on"; credentials need "try-on-credentials"):
    /api/admin/try-on/overview, requests, settings, storage, cleanup,
    capabilities, mappings, products/{id}/setting, adapters, providers,
    models, plans, credentials, access-requests, allocations
"""

from __future__ import annotations

from datetime import date
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, Header, Query, UploadFile
from fastapi.responses import Response
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import ValidationError
from app.dependencies.auth import get_current_customer, get_optional_customer, require_access
from app.models import AdminUser, Customer, MembershipPlan, VtoCleanupTask
from app.schemas.base import CamelModel
from app.services import membership as membership_service
from app.services.try_on import (
    allocations,
    analytics,
    catalogue,
    credentials,
    crypto,
    entitlements,
    images,
    platforms,
    programme,
    service,
    storage,
)
from app.services.try_on import adapters as adapter_registry
from app.services.try_on.jobs import retry_cleanup
from app.utils.response import Pagination, ok

router = APIRouter(prefix="/try-on", tags=["Virtual try-on"])
admin_router = APIRouter(prefix="/admin/try-on", tags=["Admin · Virtual try-on"])

MANAGE = "try-on"
SECRETS = "try-on-credentials"


def _page(page: int, page_size: int, total: int) -> dict:
    return Pagination.build(page, page_size, total).model_dump()


async def _read_upload(file: UploadFile, limit: int) -> bytes:
    data = await file.read(limit + 1)
    if len(data) > limit:
        from app.services.try_on.errors import TryOnError

        raise TryOnError("image_too_large", f"Photos must be {limit // (1024 * 1024)} MB or smaller.")
    return data


# ================================================================ shoppers


class RequestIn(CamelModel):
    product_id: str = Field(min_length=1, max_length=160)
    photo_id: str = Field(min_length=1, max_length=20)
    color: str = Field(default="", max_length=60)
    size: str = Field(default="", max_length=30)
    model_id: Optional[str] = Field(default=None, max_length=20)
    client_request_id: Optional[str] = Field(default=None, max_length=64)


class FavouriteIn(CamelModel):
    favourite: bool


class FeedbackIn(CamelModel):
    rating: int = Field(ge=1, le=5)
    comment: str = Field(default="", max_length=500)


class AccessIn(CamelModel):
    kind: str = Field(default="more_usage", pattern="^(more_usage|dedicated)$")
    reason: str = Field(min_length=5, max_length=500)
    capabilities: List[str] = Field(default_factory=list, max_length=20)
    expected_usage: int = Field(default=0, ge=0, le=100000)
    requested_model_id: Optional[str] = Field(default=None, max_length=20)
    starts_on: Optional[date] = None
    ends_on: Optional[date] = None
    message: str = Field(default="", max_length=1000)


@router.get("/catalogue", summary="What can be tried on, for badges and buttons")
def storefront_catalogue(db: Session = Depends(get_db)):
    settings = programme.get(db)
    store = storage.status()
    data = catalogue.storefront_map(db) if settings["enabled"] else {"capabilities": [], "mappings": [],
                                                                     "productOverrides": {}}
    return ok({**data, "enabled": settings["enabled"] and store["active"] != "none", "storage": store["active"]})


@router.get("/eligibility", summary="Your try-on allowance")
def eligibility(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    settings = programme.get(db)
    return ok({**entitlements.summary(db, customer), "enabled": settings["enabled"],
               "privacyNotice": settings["privacyNotice"], "feedback": settings["feedback"],
               "storage": {k: v for k, v in storage.status().items() if k in ("active", "ephemeralTtlMinutes",
                                                                                "permanentAvailable")}})


@router.get("/usage", summary="Your try-on usage")
def usage(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    return ok(entitlements.summary(db, customer))


@router.get("/products", summary="Products you can try on")
def products(
    capability: str = Query("", max_length=60),
    category: str = Query("", max_length=80),
    page: int = Query(1, ge=1),
    page_size: int = Query(24, ge=1, le=60, alias="pageSize"),
    db: Session = Depends(get_db),
):
    rows, total = catalogue.eligible_products(db, capability=capability, category_slug=category, page=page,
                                              page_size=page_size)
    return ok({"items": rows, "pagination": _page(page, page_size, total)})


@router.get("/products/{product_id}", summary="The try-on panel for a product")
def product_offer(product_id: str, db: Session = Depends(get_db),
                  customer: Optional[Customer] = Depends(get_optional_customer)):
    return ok(service.product_offer(db, customer, product_id))


@router.post("/photos", status_code=201, summary="Upload a photo for try-on")
async def upload_photo(
    file: UploadFile = File(...),
    save: bool = Form(False),
    capability: str = Form("", max_length=60),
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    from starlette.concurrency import run_in_threadpool

    data = await _read_upload(file, images.HARD_MAX_BYTES)
    photo = await run_in_threadpool(service.upload_photo, db, customer, data, save=save, capability_key=capability)
    return ok(service.photo_out(photo), message="Photo ready.")


@router.get("/photos", summary="Your saved photos")
def photos(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    return ok([service.photo_out(p) for p in service.list_photos(db, customer)])


@router.delete("/photos/{photo_id}", summary="Delete a photo")
def delete_photo(photo_id: str, db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    return ok(service.delete_photo(db, customer, photo_id), message="Photo deleted.")


@router.post("/requests", status_code=202, summary="Start a try-on")
def start(
    payload: RequestIn,
    idempotency_key: Optional[str] = Header(default=None, alias="Idempotency-Key", max_length=64),
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    request, created = service.submit(db, customer, payload.model_dump(by_alias=True), idempotency_key)
    rules = entitlements.resolve(db, customer).rules
    return ok(service.request_out(db, request, rules=rules),
              message="Your try-on is on its way." if created else "Already started.")


@router.get("/requests", summary="Your try-ons")
def history(
    status: str = Query("", max_length=12),
    product_id: str = Query("", max_length=20, alias="productId"),
    date_from: Optional[date] = Query(None, alias="from"),
    date_to: Optional[date] = Query(None, alias="to"),
    favourites: bool = Query(False),
    page: int = Query(1, ge=1),
    page_size: int = Query(12, ge=1, le=50, alias="pageSize"),
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    rows, total = service.list_requests(db, customer, status=status, product_id=product_id, date_from=date_from,
                                        date_to=date_to, favourites=favourites, page=page, page_size=page_size)
    rules = entitlements.resolve(db, customer).rules
    return ok({"items": [service.request_out(db, r, rules=rules) for r in rows],
               "pagination": _page(page, page_size, total)})


@router.get("/requests/{request_id}", summary="One try-on")
def one(request_id: str, db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    request = service.own_request(db, customer, request_id)
    return ok(service.request_out(db, request, rules=entitlements.resolve(db, customer).rules))


@router.post("/requests/{request_id}/retry", summary="Try again")
def retry(request_id: str, db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    request = service.retry(db, customer, request_id)
    return ok(service.request_out(db, request, rules=entitlements.resolve(db, customer).rules),
              message="Trying again.")


@router.post("/requests/{request_id}/cancel", summary="Cancel a try-on in progress")
def cancel(request_id: str, db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    request = service.cancel(db, customer, request_id)
    return ok(service.request_out(db, request), message="Cancelling.")


@router.delete("/requests/{request_id}", summary="Delete a try-on and its images")
def delete(request_id: str, db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    result = service.delete_request(db, customer, request_id)
    return ok(result, message="Deleted.")


@router.get("/requests/{request_id}/image", summary="The result or the original photo")
def image(
    request_id: str,
    which: str = Query("result", pattern="^(result|original)$"),
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    data, content_type = service.image_of(db, customer, request_id, which)
    return Response(content=data, media_type=content_type,
                    headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})


@router.get("/requests/{request_id}/download", summary="A short-lived download link")
def download(request_id: str, db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    return ok({"url": service.download_link(db, customer, request_id)})


@router.put("/requests/{request_id}/favourite", summary="Keep a try-on among favourites")
def favourite(request_id: str, payload: FavouriteIn, db: Session = Depends(get_db),
              customer: Customer = Depends(get_current_customer)):
    request = service.set_favourite(db, customer, request_id, payload.favourite)
    return ok({"id": request.id, "favourite": request.favourite})


@router.put("/requests/{request_id}/feedback", summary="Rate a try-on")
def feedback(request_id: str, payload: FeedbackIn, db: Session = Depends(get_db),
             customer: Customer = Depends(get_current_customer)):
    request = service.set_feedback(db, customer, request_id, payload.rating, payload.comment)
    return ok({"id": request.id, "rating": request.feedback_rating}, message="Thanks for the feedback.")


@router.get("/access-requests", summary="Your requests for more try-on access")
def my_access_requests(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    return ok([allocations.request_out(r) for r in allocations.customer_requests(db, customer)])


@router.post("/access-requests", status_code=201, summary="Ask for more or dedicated try-on access")
def ask_access(payload: AccessIn, db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    row = allocations.request_access(db, customer, payload.model_dump(by_alias=True, mode="json"))
    return ok(allocations.request_out(row), message="Request sent. We'll let you know.")


@router.post("/access-requests/{request_id}/withdraw", summary="Withdraw a waiting request")
def withdraw(request_id: str, db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    return ok(allocations.request_out(allocations.withdraw(db, customer, request_id)), message="Withdrawn.")


@router.get("/allocations", summary="Extra try-on access you've been given")
def my_allocations(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    return ok([allocations.allocation_out(db, a) for a in allocations.customer_allocations(db, customer)])


# =================================================================== store


def _filters(
    date_from: Optional[date] = Query(None, alias="from"),
    date_to: Optional[date] = Query(None, alias="to"),
    provider_id: str = Query("", max_length=20, alias="providerId"),
    model_id: str = Query("", max_length=20, alias="modelId"),
    credential_id: str = Query("", max_length=20, alias="credentialId"),
    customer_id: str = Query("", max_length=20, alias="customerId"),
    plan_id: str = Query("", max_length=20, alias="planId"),
    capability: str = Query("", max_length=60),
    category_id: str = Query("", max_length=20, alias="categoryId"),
    status: str = Query("", max_length=12),
    error_code: str = Query("", max_length=40, alias="errorCode"),
    q: str = Query("", max_length=40),
) -> list:
    """The dashboard's and the request log's filters, as SQL conditions."""
    return analytics.filters(date_from=date_from, date_to=date_to, provider_id=provider_id, model_id=model_id,
                             credential_id=credential_id, customer_id=customer_id, plan_id=plan_id,
                             capability=capability, category_id=category_id, status=status, error_code=error_code,
                             query=q)


@admin_router.get("/overview", summary="The try-on dashboard")
def overview(
    granularity: str = Query("day", pattern="^(day|week|month)$"),
    conditions: list = Depends(_filters),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_access(MANAGE)),
):
    return ok(analytics.overview(db, conditions, granularity=granularity))


@admin_router.get("/requests", summary="Every try-on request")
def admin_requests(
    conditions: list = Depends(_filters),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_access(MANAGE)),
):
    rows, total, counts = analytics.list_requests(db, conditions, page=page, page_size=page_size)
    return ok({"items": [analytics.admin_request_out(db, r) for r in rows], "counts": counts,
               "pagination": _page(page, page_size, total)})


@admin_router.get("/requests/{request_id}", summary="One try-on request, with its attempts")
def admin_request(request_id: str, db: Session = Depends(get_db),
                  admin: AdminUser = Depends(require_access(MANAGE))):
    from app.core.errors import NotFoundError
    from app.models import VtoRequest

    row = db.get(VtoRequest, request_id[:20])
    if row is None:
        raise NotFoundError("We couldn't find that try-on.", error_code="TRY_ON_NOT_FOUND")
    return ok(analytics.admin_request_out(db, row, detail=True))


@admin_router.post("/requests/{request_id}/requeue", summary="Run a failed request again (no extra charge)")
def admin_requeue(request_id: str, db: Session = Depends(get_db),
                  admin: AdminUser = Depends(require_access(MANAGE))):
    from datetime import datetime

    from app.core.errors import ConflictError, NotFoundError
    from app.models import VtoRequest, VtoUsage
    from app.services import audit

    row = db.get(VtoRequest, request_id[:20])
    if row is None:
        raise NotFoundError("We couldn't find that try-on.", error_code="TRY_ON_NOT_FOUND")
    if row.status != "failed" or row.deleted_at is not None:
        raise ConflictError("Only a failed try-on can be run again.", error_code="NOT_FAILED")
    now = datetime.utcnow()
    usage_row = db.execute(select(VtoUsage).where(VtoUsage.request_id == row.id)).scalar_one_or_none()
    if usage_row is not None:
        usage_row.status, usage_row.updated_at = "reserved", now
    row.status, row.error_code, row.error_badge, row.error_message, row.technical_detail = "queued", "", "", "", ""
    row.retryable, row.cancel_requested, row.lease_until, row.queued_at = False, False, None, now
    row.started_at = row.finished_at = None
    row.updated_at = now
    audit.record(db, "try_on_request.requeue", resource_type="try-on-request", resource_id=row.id,
                 summary=f"Re-ran try-on {row.id}")
    db.commit()
    return ok(analytics.admin_request_out(db, row), message="Queued again.")


@admin_router.get("/settings", summary="Try-on settings")
def get_settings(db: Session = Depends(get_db), admin: AdminUser = Depends(require_access(MANAGE))):
    return ok({**programme.get(db), "storage": storage.status(), "encryption": crypto.key_status()})


@admin_router.put("/settings", summary="Save try-on settings")
def put_settings(payload: dict, db: Session = Depends(get_db), admin: AdminUser = Depends(require_access(MANAGE))):
    value = programme.save(db, payload)
    db.commit()
    return ok(value, message="Try-on settings saved.")


@admin_router.get("/storage", summary="Where try-on images are stored")
def storage_status(db: Session = Depends(get_db), admin: AdminUser = Depends(require_access(MANAGE))):
    return ok(storage.status())


@admin_router.get("/cleanup", summary="Deletions still to be confirmed by storage")
def cleanup(
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_access(MANAGE)),
):
    from sqlalchemy import func

    condition = VtoCleanupTask.done_at.is_(None)
    total = db.execute(select(func.count()).select_from(VtoCleanupTask).where(condition)).scalar_one()
    rows = db.execute(select(VtoCleanupTask).where(condition).order_by(VtoCleanupTask.next_attempt_at)
                      .offset((page - 1) * page_size).limit(page_size)).scalars().all()
    return ok({"items": [{"id": t.id, "storage": t.storage, "reason": t.reason, "attempts": t.attempts,
                          "nextAttemptAt": t.next_attempt_at, "lastError": t.last_error, "createdAt": t.created_at}
                         for t in rows], "pagination": _page(page, page_size, total)})


@admin_router.post("/cleanup/run", summary="Retry pending deletions now")
def run_cleanup(db: Session = Depends(get_db), admin: AdminUser = Depends(require_access(MANAGE))):
    from datetime import datetime, timedelta

    result = retry_cleanup(db, datetime.utcnow() + timedelta(days=2))
    db.commit()
    return ok(result, message=f"{result['done']} deleted, {result['failed']} still failing.")


# --- capabilities, mappings, products


def _capability_out(c, states: dict) -> dict:
    return {"key": c.key, "family": c.family, "name": c.name, "description": c.description,
            "subjectKind": c.subject_kind, "inputRules": c.input_rules or {}, "guidance": c.guidance or [],
            "status": c.status, "state": states.get(c.key, "unsupported"), "sortOrder": c.sort_order}


@admin_router.get("/capabilities", summary="Kinds of try-on")
def list_capabilities(db: Session = Depends(get_db), admin: AdminUser = Depends(require_access(MANAGE))):
    states = catalogue.capability_states(db)
    return ok([_capability_out(c, states) for c in catalogue.capabilities(db)])


@admin_router.post("/capabilities", status_code=201, summary="Add a kind of try-on")
def add_capability(payload: dict, db: Session = Depends(get_db), admin: AdminUser = Depends(require_access(MANAGE))):
    row = catalogue.save_capability(db, payload)
    db.commit()
    return ok(_capability_out(row, catalogue.capability_states(db)), message="Try-on type added.")


@admin_router.put("/capabilities/{key}", summary="Change a kind of try-on")
def put_capability(key: str, payload: dict, db: Session = Depends(get_db),
                   admin: AdminUser = Depends(require_access(MANAGE))):
    row = catalogue.save_capability(db, payload, key)
    db.commit()
    return ok(_capability_out(row, catalogue.capability_states(db)), message="Try-on type saved.")


def _mapping_out(m) -> dict:
    return {"id": m.id, "categoryId": m.category_id, "subcategory": m.subcategory,
            "capabilityKey": m.capability_key, "enabled": m.enabled}


@admin_router.get("/mappings", summary="Which categories use which try-on")
def list_mappings(db: Session = Depends(get_db), admin: AdminUser = Depends(require_access(MANAGE))):
    from app.models import Category

    categories = [{"id": c.id, "name": c.name, "slug": c.slug,
                   "subcategories": [{"slug": i.get("slug"), "name": i.get("name")}
                                     for g in (c.groups or []) if isinstance(g, dict)
                                     for i in (g.get("items") or []) if isinstance(i, dict)]}
                  for c in db.execute(select(Category).order_by(Category.display_order, Category.name)).scalars()]
    return ok({"items": [_mapping_out(m) for m in catalogue.mappings(db)], "categories": categories})


@admin_router.post("/mappings", status_code=201, summary="Map a category to a try-on")
def add_mapping(payload: dict, db: Session = Depends(get_db), admin: AdminUser = Depends(require_access(MANAGE))):
    row = catalogue.save_mapping(db, payload)
    db.commit()
    return ok(_mapping_out(row), message="Category mapped.")


@admin_router.put("/mappings/{mapping_id}", summary="Change a category mapping")
def put_mapping(mapping_id: int, payload: dict, db: Session = Depends(get_db),
                admin: AdminUser = Depends(require_access(MANAGE))):
    row = catalogue.save_mapping(db, payload, mapping_id)
    db.commit()
    return ok(_mapping_out(row), message="Mapping saved.")


@admin_router.delete("/mappings/{mapping_id}", summary="Remove a category mapping")
def delete_mapping(mapping_id: int, db: Session = Depends(get_db),
                   admin: AdminUser = Depends(require_access(MANAGE))):
    catalogue.delete_mapping(db, mapping_id)
    db.commit()
    return ok(message="Mapping removed.")


def _setting_out(db: Session, product_id: str) -> dict:
    from app.core.errors import NotFoundError
    from app.models import Product

    product = db.get(Product, product_id[:20])
    if product is None:
        raise NotFoundError("We couldn't find that product.", error_code="PRODUCT_NOT_FOUND")
    setting = catalogue.product_setting(db, product.id)
    key, why = catalogue.capability_for(db, product)
    return {"productId": product.id, "capabilityKey": setting.capability_key if setting else None,
            "optOut": bool(setting and setting.opt_out),
            "garmentImageUrl": setting.garment_image_url if setting else "",
            "effectiveCapability": key, "decidedBy": why,
            "state": catalogue.capability_states(db).get(key, "unsupported") if key else "unsupported"}


@admin_router.get("/products/{product_id}/setting", summary="A product's try-on setting")
def get_product_setting(product_id: str, db: Session = Depends(get_db),
                        admin: AdminUser = Depends(require_access(MANAGE))):
    return ok(_setting_out(db, product_id))


@admin_router.put("/products/{product_id}/setting", summary="Change a product's try-on setting")
def put_product_setting(product_id: str, payload: dict, db: Session = Depends(get_db),
                        admin: AdminUser = Depends(require_access(MANAGE))):
    catalogue.save_product_setting(db, product_id[:20], payload)
    db.commit()
    return ok(_setting_out(db, product_id), message="Saved.")


# --- providers and models


@admin_router.get("/adapters", summary="The AI adapters this server can run")
def list_adapters(admin: AdminUser = Depends(require_access(MANAGE))):
    return ok({"adapters": adapter_registry.available(), "providerKinds": adapter_registry.provider_kinds()})


@admin_router.get("/providers", summary="AI providers")
def list_providers(db: Session = Depends(get_db), admin: AdminUser = Depends(require_access(MANAGE))):
    return ok([platforms.provider_out(p) for p in platforms.providers(db)])


@admin_router.post("/providers", status_code=201, summary="Add an AI provider")
def add_provider(payload: dict, db: Session = Depends(get_db), admin: AdminUser = Depends(require_access(MANAGE))):
    row = platforms.save_provider(db, payload)
    db.commit()
    return ok(platforms.provider_out(row), message="Provider added.")


@admin_router.put("/providers/{provider_id}", summary="Change an AI provider")
def put_provider(provider_id: str, payload: dict, db: Session = Depends(get_db),
                 admin: AdminUser = Depends(require_access(MANAGE))):
    row = platforms.save_provider(db, payload, provider_id)
    db.commit()
    return ok(platforms.provider_out(row), message="Provider saved.")


@admin_router.post("/providers/{provider_id}/check", summary="Check a provider's health")
def check_provider(provider_id: str, db: Session = Depends(get_db),
                   admin: AdminUser = Depends(require_access(SECRETS))):
    row = platforms.check_provider(db, provider_id)
    db.commit()
    return ok(platforms.provider_out(row), message=row.health_detail)


@admin_router.get("/models", summary="AI models")
def list_models(db: Session = Depends(get_db), admin: AdminUser = Depends(require_access(MANAGE))):
    return ok([platforms.model_out(m) for m in platforms.models(db)])


@admin_router.post("/models", status_code=201, summary="Add an AI model")
def add_model(payload: dict, db: Session = Depends(get_db), admin: AdminUser = Depends(require_access(MANAGE))):
    row = platforms.save_model(db, payload)
    db.commit()
    return ok(platforms.model_out(row), message="Model added.")


@admin_router.put("/models/{model_id}", summary="Change an AI model")
def put_model(model_id: str, payload: dict, db: Session = Depends(get_db),
              admin: AdminUser = Depends(require_access(MANAGE))):
    row = platforms.save_model(db, payload, model_id)
    db.commit()
    return ok(platforms.model_out(row), message="Model saved.")


@admin_router.delete("/models/{model_id}", summary="Delete (or disable) an AI model")
def delete_model(model_id: str, db: Session = Depends(get_db), admin: AdminUser = Depends(require_access(MANAGE))):
    outcome = platforms.delete_model(db, model_id)
    db.commit()
    return ok({"outcome": outcome}, message="Model deleted." if outcome == "deleted" else
              "Model disabled — requests already made with it keep its name.")


@admin_router.post("/models/{model_id}/test", summary="Test a model with your own photos")
async def test_model(
    model_id: str,
    person: UploadFile = File(...),
    garment: UploadFile = File(...),
    capability: str = Form(..., max_length=60),
    credential_id: str = Form("", max_length=20, alias="credentialId"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_access(SECRETS)),
):
    from starlette.concurrency import run_in_threadpool

    person_data = await _read_upload(person, images.HARD_MAX_BYTES)
    garment_data = await _read_upload(garment, images.HARD_MAX_BYTES)
    result = await run_in_threadpool(platforms.test_model, db, model_id, capability, person_data, garment_data,
                                     credential_id or None)
    db.commit()
    return ok(result, message="Test finished." if result["ok"] else "The test failed.")


# --- plan entitlements


def _plan_row(plan: MembershipPlan) -> dict:
    return {"id": plan.id, "name": plan.name, "active": plan.active, "durationMonths": plan.duration_months,
            "tryOn": membership_service.benefits_of(plan).get("tryOn")}


@admin_router.get("/plans", summary="Membership plans and their try-on entitlement")
def plans(db: Session = Depends(get_db), admin: AdminUser = Depends(require_access(MANAGE))):
    settings = programme.get(db)
    return ok({"plans": [_plan_row(p) for p in membership_service.list_plans(db, include_inactive=True)],
               "trial": settings["trial"], "defaults": entitlements.DEFAULT_RULES})


@admin_router.put("/plans/{plan_id}", summary="Set a plan's try-on entitlement")
def put_plan(plan_id: str, payload: dict, db: Session = Depends(get_db),
             admin: AdminUser = Depends(require_access(MANAGE))):
    if "tryOn" not in payload:
        raise ValidationError("Send the plan's tryOn entitlement.", error_code="INVALID_TRY_ON")
    plan = membership_service.save_plan(db, {"tryOn": payload["tryOn"]}, plan_id)
    return ok(_plan_row(plan), message="Plan entitlement saved. New purchases get it; existing members "
                                       "without try-on get it too.")


# --- credentials (secrets: their own permission)


class CredentialIn(CamelModel):
    provider_id: str = Field(min_length=1, max_length=20)
    secret: str = Field(min_length=1, max_length=500)
    label: str = Field(default="", max_length=80)
    hidden: bool = False
    auto_select: bool = True
    priority: int = Field(default=100, ge=0, le=10000)
    scope: str = Field(default="shared", pattern="^(shared|dedicated)$")
    dedicated_customer_id: Optional[str] = Field(default=None, max_length=20)
    model_ids: List[str] = Field(default_factory=list, max_length=50)
    capability_keys: List[str] = Field(default_factory=list, max_length=50)
    category_ids: List[str] = Field(default_factory=list, max_length=50)
    daily_limit: Optional[int] = Field(default=None, ge=1)
    monthly_limit: Optional[int] = Field(default=None, ge=1)
    validate_now: bool = False


class BulkIn(CamelModel):
    provider_id: str = Field(min_length=1, max_length=20)
    secrets: str = Field(min_length=1, max_length=100000)
    label_prefix: str = Field(default="", max_length=60)
    model_ids: List[str] = Field(default_factory=list, max_length=50)
    capability_keys: List[str] = Field(default_factory=list, max_length=50)
    category_ids: List[str] = Field(default_factory=list, max_length=50)
    priority: int = Field(default=100, ge=0, le=10000)
    hidden: bool = False


class SecretIn(CamelModel):
    secret: str = Field(min_length=1, max_length=500)


def _credential_payload(model: CamelModel, *drop: str) -> dict:
    return {k: v for k, v in model.model_dump(by_alias=True).items() if k not in drop}


@admin_router.get("/credentials", summary="Provider credentials (masked)")
def list_credentials(
    include_hidden: bool = Query(False, alias="includeHidden"),
    include_deleted: bool = Query(False, alias="includeDeleted"),
    provider_id: str = Query("", max_length=20, alias="providerId"),
    state: str = Query("", max_length=16),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_access(SECRETS)),
):
    rows = credentials.list_credentials(db, include_hidden=include_hidden, include_deleted=include_deleted,
                                        provider_id=provider_id, state=state)
    return ok({"items": [credentials.out(r) for r in rows], "counts": credentials.counts(db),
               "encryption": crypto.key_status()})


@admin_router.post("/credentials", status_code=201, summary="Add a credential")
def add_credential(payload: CredentialIn, db: Session = Depends(get_db),
                   admin: AdminUser = Depends(require_access(SECRETS))):
    row = credentials.add(db, _credential_payload(payload, "validateNow"), admin_id=admin.id)
    db.commit()
    if payload.validate_now:
        row = credentials.validate(db, row.id)
        db.commit()
    return ok(credentials.out(row), message="Credential saved. Its token can't be shown again.")


@admin_router.post("/credentials/bulk", status_code=201, summary="Add several credentials")
def add_credentials(payload: BulkIn, db: Session = Depends(get_db),
                    admin: AdminUser = Depends(require_access(SECRETS))):
    result = credentials.bulk_add(db, payload.model_dump(by_alias=True), admin_id=admin.id)
    db.commit()
    return ok({"added": [credentials.out(r) for r in result["added"]], "skipped": result["skipped"]},
              message=f"{len(result['added'])} added, {len(result['skipped'])} skipped.")


@admin_router.post("/credentials/reencrypt", summary="Re-encrypt every credential with the current key")
def reencrypt(db: Session = Depends(get_db), admin: AdminUser = Depends(require_access(SECRETS))):
    result = credentials.reencrypt(db)
    db.commit()
    return ok(result, message=f"{result['reencrypted']} re-encrypted.")


@admin_router.put("/credentials/{credential_id}", summary="Change a credential's settings")
def put_credential(credential_id: str, payload: dict, db: Session = Depends(get_db),
                   admin: AdminUser = Depends(require_access(SECRETS))):
    row = credentials.update(db, credential_id, payload)
    db.commit()
    return ok(credentials.out(row), message="Credential saved.")


@admin_router.put("/credentials/{credential_id}/secret", summary="Replace a credential's token")
def rotate_credential(credential_id: str, payload: SecretIn, db: Session = Depends(get_db),
                      admin: AdminUser = Depends(require_access(SECRETS))):
    row = credentials.rotate(db, credential_id, payload.secret)
    db.commit()
    return ok(credentials.out(row), message="Token replaced.")


def _state_route(action: str):
    def handler(credential_id: str, db: Session = Depends(get_db),
                admin: AdminUser = Depends(require_access(SECRETS))):
        row = credentials.set_state(db, credential_id, action)
        db.commit()
        return ok(credentials.out(row), message=f"Credential {action}d.")

    handler.__name__ = f"{action}_credential"
    return handler


for _action in ("enable", "disable", "hide", "unhide"):
    admin_router.add_api_route(f"/credentials/{{credential_id}}/{_action}", _state_route(_action), methods=["POST"],
                               summary=f"{_action.capitalize()} a credential")


@admin_router.post("/credentials/{credential_id}/validate", summary="Check a credential with its provider")
def validate_credential(credential_id: str, db: Session = Depends(get_db),
                        admin: AdminUser = Depends(require_access(SECRETS))):
    row = credentials.validate(db, credential_id)
    db.commit()
    state = credentials.effective_status(row)
    if row.validation_status == "valid":
        message = "Accepted by the provider."
    elif row.validation_status == "invalid":
        message = "The provider rejected this token. Replace it."
    else:
        reason = (credentials.out(row)["lastError"] or state).rstrip(".")
        message = f"Couldn't check it: {reason}. Try again in a moment."
    return ok(credentials.out(row), message=message)


@admin_router.delete("/credentials/{credential_id}", summary="Delete a credential (history is kept)")
def delete_credential(credential_id: str, db: Session = Depends(get_db),
                      admin: AdminUser = Depends(require_access(SECRETS))):
    row = credentials.delete(db, credential_id)
    db.commit()
    return ok(credentials.out(row), message="Credential deleted. Its token has been erased.")


@admin_router.get("/credentials/{credential_id}/usage", summary="Who used a credential")
def credential_usage(credential_id: str, db: Session = Depends(get_db),
                     admin: AdminUser = Depends(require_access(SECRETS))):
    return ok(credentials.usage(db, credential_id))


# --- access requests and allocations


class DecisionIn(CamelModel):
    note: str = Field(default="", max_length=500)
    allocation: dict = Field(default_factory=dict)


@admin_router.get("/access-requests", summary="Customers' requests for try-on access")
def access_requests(
    status: str = Query("", max_length=12),
    customer_id: str = Query("", max_length=20, alias="customerId"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_access(MANAGE)),
):
    rows, total, counts = allocations.list_requests(db, status=status, customer_id=customer_id, page=page,
                                                    page_size=page_size)
    return ok({"items": [allocations.request_out(r, admin=True) for r in rows], "counts": counts,
               "pagination": _page(page, page_size, total)})


@admin_router.post("/access-requests/{request_id}/approve", summary="Approve, creating an allocation")
def approve(request_id: str, payload: DecisionIn, db: Session = Depends(get_db),
            admin: AdminUser = Depends(require_access(MANAGE))):
    row = allocations.decide(db, request_id, "approve", payload.model_dump(), admin_id=admin.id)
    db.commit()
    return ok(allocations.request_out(row, admin=True), message="Approved.")


@admin_router.post("/access-requests/{request_id}/reject", summary="Reject a request")
def reject(request_id: str, payload: DecisionIn, db: Session = Depends(get_db),
           admin: AdminUser = Depends(require_access(MANAGE))):
    row = allocations.decide(db, request_id, "reject", payload.model_dump(), admin_id=admin.id)
    db.commit()
    return ok(allocations.request_out(row, admin=True), message="Rejected.")


@admin_router.get("/allocations", summary="Customers' allocations")
def list_allocations(
    status: str = Query("", max_length=12),
    customer_id: str = Query("", max_length=20, alias="customerId"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_access(MANAGE)),
):
    rows, total = allocations.list_allocations(db, status=status, customer_id=customer_id, page=page,
                                               page_size=page_size)
    return ok({"items": [allocations.allocation_out(db, a, admin=True) for a in rows],
               "pagination": _page(page, page_size, total)})


@admin_router.post("/allocations", status_code=201, summary="Give a customer try-on access")
def add_allocation(payload: dict, db: Session = Depends(get_db), admin: AdminUser = Depends(require_access(MANAGE))):
    row = allocations.create_allocation(db, payload, admin_id=admin.id)
    db.commit()
    return ok(allocations.allocation_out(db, row, admin=True), message="Allocation created.")


@admin_router.get("/allocations/{allocation_id}", summary="One allocation, with its usage")
def get_allocation(allocation_id: str, db: Session = Depends(get_db),
                   admin: AdminUser = Depends(require_access(MANAGE))):
    from app.models import VtoRequest

    row = allocations.get_allocation(db, allocation_id)
    recent = db.execute(select(VtoRequest).where(VtoRequest.allocation_id == row.id)
                        .order_by(VtoRequest.created_at.desc()).limit(20)).scalars().all()
    return ok({**allocations.allocation_out(db, row, admin=True),
               "requests": [analytics.admin_request_out(db, r) for r in recent]})


@admin_router.put("/allocations/{allocation_id}", summary="Change an allocation")
def put_allocation(allocation_id: str, payload: dict, db: Session = Depends(get_db),
                   admin: AdminUser = Depends(require_access(MANAGE))):
    row = allocations.update_allocation(db, allocation_id, payload)
    db.commit()
    return ok(allocations.allocation_out(db, row, admin=True), message="Allocation saved.")


@admin_router.post("/allocations/{allocation_id}/revoke", summary="Revoke an allocation")
def revoke_allocation(allocation_id: str, db: Session = Depends(get_db),
                      admin: AdminUser = Depends(require_access(MANAGE))):
    row = allocations.revoke(db, allocation_id)
    db.commit()
    return ok(allocations.allocation_out(db, row, admin=True), message="Allocation revoked.")
