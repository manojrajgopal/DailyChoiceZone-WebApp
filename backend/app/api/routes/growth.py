"""
Referrals, flash sales and bundles.

Every amount, price and reward is worked out on the server; nothing a request
sends about money is used. The portal's endpoints check their permission
here, on the server — `referrals`, `flash-sales`, `bundles`.
"""

from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, Query, Request
from pydantic import Field
from sqlalchemy.orm import Session

from app.core import rate_limit
from app.core.database import get_db
from app.dependencies.auth import client_ip, get_current_customer, require_access
from app.models import AdminUser, Customer
from app.schemas.base import CamelModel
from app.services import bundles, flash_sales, referrals
from app.utils.response import Pagination, ok

referral_router = APIRouter(prefix="/referrals", tags=["Referrals"])
account_router = APIRouter(prefix="/account", tags=["Account · Referrals"])
admin_referral_router = APIRouter(prefix="/admin/referrals", tags=["Admin · Referrals"])

flash_router = APIRouter(prefix="/flash-sales", tags=["Flash sales"])
admin_flash_router = APIRouter(prefix="/admin/flash-sales", tags=["Admin · Flash sales"])

bundle_router = APIRouter(prefix="/bundles", tags=["Bundles"])
cart_bundle_router = APIRouter(prefix="/cart/bundles", tags=["Cart"])
admin_bundle_router = APIRouter(prefix="/admin/bundles", tags=["Admin · Bundles"])


def _page(page: int, size: int, total: int) -> dict:
    return Pagination.build(page, size, total).model_dump()


# ---------------------------------------------------------------- referrals


@referral_router.get("/check", summary="Is a referral code valid?")
def check_referral(request: Request, code: str = Query("", max_length=32), db: Session = Depends(get_db)):
    rate_limit.check(f"referral-check:{client_ip(request)}", limit=30, window_seconds=300)
    return ok(referrals.check_code(db, code))


@account_router.get("/referrals", summary="Your referral code and the friends who joined with it")
def my_referrals(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    return ok(referrals.mine(db, customer))


@admin_referral_router.get("", summary="Referrals")
def admin_referrals(status: str = Query("", max_length=20), q: str = Query("", max_length=80),
                    page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
                    db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("referrals"))):
    items, total, counts = referrals.admin_list(db, status=status, q=q, page=page, page_size=page_size)
    return ok({"items": items, "pagination": _page(page, page_size, total), "counts": counts})


@admin_referral_router.get("/metrics", summary="Referral programme figures")
def admin_referral_metrics(days: int = Query(30, ge=1, le=365), db: Session = Depends(get_db),
                           admin: AdminUser = Depends(require_access("referrals"))):
    return ok(referrals.metrics(db, days=days))


@admin_referral_router.get("/settings", summary="Referral programme settings")
def admin_referral_settings(db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("referrals"))):
    return ok(referrals.settings(db))


@admin_referral_router.put("/settings", summary="Save referral programme settings")
def admin_save_referral_settings(payload: dict, db: Session = Depends(get_db),
                                 admin: AdminUser = Depends(require_access("referrals"))):
    return ok(referrals.save_settings(db, admin, payload), message="Referral settings saved.")


class Decision(CamelModel):
    note: str = Field(default="", max_length=300)


@admin_referral_router.post("/{referral_id}/approve", summary="Approve a held referral and pay its rewards")
def admin_approve_referral(referral_id: int, payload: Decision, db: Session = Depends(get_db),
                           admin: AdminUser = Depends(require_access("referrals"))):
    return ok(referrals.decide(db, admin, referral_id, "approve", payload.note), message="Referral approved.")


@admin_referral_router.post("/{referral_id}/reject", summary="Reject a referral")
def admin_reject_referral(referral_id: int, payload: Decision, db: Session = Depends(get_db),
                          admin: AdminUser = Depends(require_access("referrals"))):
    return ok(referrals.decide(db, admin, referral_id, "reject", payload.note), message="Referral rejected.")


@admin_referral_router.post("/codes/{customer_id}/{action}", summary="Switch a customer's referral code off or on")
def admin_referral_code(customer_id: str, action: str, db: Session = Depends(get_db),
                        admin: AdminUser = Depends(require_access("referrals"))):
    if action not in ("disable", "enable"):
        from app.core.errors import NotFoundError

        raise NotFoundError("Unknown action.", error_code="NOT_FOUND")
    return ok(referrals.set_code_disabled(db, admin, customer_id, action == "disable"))


# -------------------------------------------------------------- flash sales


@flash_router.get("", summary="Live and upcoming flash sales")
def list_flash_sales(db: Session = Depends(get_db)):
    return ok(flash_sales.storefront(db))


@flash_router.get("/{sale_id}", summary="One flash sale")
def get_flash_sale(sale_id: int, db: Session = Depends(get_db)):
    return ok(flash_sales.storefront_sale(db, sale_id))


@admin_flash_router.get("", summary="Flash sales")
def admin_flash_sales(phase: str = Query("", max_length=20), q: str = Query("", max_length=80),
                      page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
                      db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("flash-sales"))):
    items, total, counts = flash_sales.admin_list(db, phase_filter=phase, q=q, page=page, page_size=page_size)
    return ok({"items": items, "pagination": _page(page, page_size, total), "counts": counts})


@admin_flash_router.post("", status_code=201, summary="Create a flash sale")
def admin_create_flash_sale(payload: dict, db: Session = Depends(get_db),
                            admin: AdminUser = Depends(require_access("flash-sales"))):
    sale = flash_sales.create(db, admin, payload)
    return ok(flash_sales.view(db, sale, admin=True), message="Flash sale saved.")


@admin_flash_router.get("/{sale_id}", summary="One flash sale with its sales")
def admin_flash_sale(sale_id: int, db: Session = Depends(get_db),
                     admin: AdminUser = Depends(require_access("flash-sales"))):
    return ok(flash_sales.view(db, flash_sales._load(db, sale_id), admin=True))


@admin_flash_router.put("/{sale_id}", summary="Change a flash sale")
def admin_update_flash_sale(sale_id: int, payload: dict, db: Session = Depends(get_db),
                            admin: AdminUser = Depends(require_access("flash-sales"))):
    sale = flash_sales.update(db, admin, sale_id, payload)
    return ok(flash_sales.view(db, sale, admin=True), message="Flash sale saved.")


@admin_flash_router.post("/{sale_id}/{action}", summary="Publish, unpublish, cancel or end a flash sale")
def admin_flash_sale_action(sale_id: int, action: str, db: Session = Depends(get_db),
                            admin: AdminUser = Depends(require_access("flash-sales"))):
    sale = flash_sales.set_status(db, admin, sale_id, action)
    return ok(flash_sales.view(db, sale, admin=True))


@admin_flash_router.delete("/{sale_id}", summary="Delete a flash sale nobody ordered from")
def admin_delete_flash_sale(sale_id: int, db: Session = Depends(get_db),
                            admin: AdminUser = Depends(require_access("flash-sales"))):
    flash_sales.delete(db, admin, sale_id)
    return ok(message="Flash sale deleted.")


# ------------------------------------------------------------------ bundles


@bundle_router.get("", summary="Bundles on sale")
def list_bundles(product_id: Optional[str] = Query(None, alias="productId", max_length=40),
                 db: Session = Depends(get_db)):
    return ok(bundles.storefront_list(db, product_id=product_id))


@bundle_router.get("/{slug}", summary="One bundle")
def get_bundle(slug: str, db: Session = Depends(get_db)):
    return ok(bundles.storefront_detail(db, slug))


class Selection(CamelModel):
    product_id: str = Field(min_length=1, max_length=40)
    size: Optional[str] = Field(default=None, max_length=30)
    color: Optional[str] = Field(default=None, max_length=60)


class AddBundle(CamelModel):
    bundle_id: int = Field(ge=1)
    quantity: int = Field(default=1, ge=1, le=20)
    selections: List[Selection] = Field(default_factory=list, max_length=10)


class BundleQuantity(CamelModel):
    quantity: int = Field(ge=0, le=20)


def _cart(db: Session, customer: Customer) -> dict:
    from app.api.routes.cart import _render
    from app.services import cart

    return _render(cart.get_cart(db, customer))


@cart_bundle_router.post("", status_code=201, summary="Add a bundle to the bag")
def add_bundle(payload: AddBundle, db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    bundles.add_to_cart(db, customer, payload.bundle_id, payload.quantity,
                        [s.model_dump(by_alias=True) for s in payload.selections])
    return ok(_cart(db, customer), message="Bundle added to bag.")


@cart_bundle_router.put("/{entry_id}", summary="Change how many of a bundle are in the bag")
def update_bundle(entry_id: int, payload: BundleQuantity, db: Session = Depends(get_db),
                  customer: Customer = Depends(get_current_customer)):
    bundles.update_quantity(db, customer, entry_id, payload.quantity)
    return ok(_cart(db, customer))


@cart_bundle_router.delete("/{entry_id}", summary="Remove a bundle from the bag")
def remove_bundle(entry_id: int, db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    bundles.remove(db, customer, entry_id)
    return ok(_cart(db, customer), message="Bundle removed.")


@admin_bundle_router.get("", summary="Bundles")
def admin_bundles(status: str = Query("", max_length=20), q: str = Query("", max_length=80),
                  page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
                  db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("bundles"))):
    items, total, counts = bundles.admin_list(db, status=status, q=q, page=page, page_size=page_size)
    return ok({"items": items, "pagination": _page(page, page_size, total), "counts": counts})


@admin_bundle_router.post("", status_code=201, summary="Create a bundle")
def admin_create_bundle(payload: dict, db: Session = Depends(get_db),
                        admin: AdminUser = Depends(require_access("bundles"))):
    return ok(bundles.save(db, admin, payload), message="Bundle saved.")


@admin_bundle_router.get("/{bundle_id}", summary="One bundle with its sales")
def admin_bundle(bundle_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("bundles"))):
    return ok(bundles.admin_detail(db, bundle_id))


@admin_bundle_router.put("/{bundle_id}", summary="Change a bundle")
def admin_update_bundle(bundle_id: int, payload: dict, db: Session = Depends(get_db),
                        admin: AdminUser = Depends(require_access("bundles"))):
    return ok(bundles.save(db, admin, payload, bundle_id), message="Bundle saved.")


@admin_bundle_router.delete("/{bundle_id}", summary="Delete a bundle nobody ordered")
def admin_delete_bundle(bundle_id: int, db: Session = Depends(get_db),
                        admin: AdminUser = Depends(require_access("bundles"))):
    bundles.delete(db, admin, bundle_id)
    return ok(message="Bundle deleted.")
