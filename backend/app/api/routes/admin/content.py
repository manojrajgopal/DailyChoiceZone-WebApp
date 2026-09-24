"""Homepage, banners, coupons and review moderation."""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import NotFoundError
from app.dependencies.auth import get_current_admin, require_permission
from app.models import AdminUser, Banner, HomepageSection
from app.schemas.base import CamelModel
from app.services import coupons as coupon_service, reviews as review_service, site as site_service
from app.utils.ids import next_id
from app.utils.response import ok, ok_list

router = APIRouter(prefix="/admin", tags=["Admin"])
marketing_router = APIRouter(prefix="/admin", tags=["Admin"])


# -------------------------------------------------------------- homepage


class SectionUpdate(CamelModel):
    id: str
    active: Optional[bool] = None
    display_order: Optional[int] = None
    title: Optional[str] = None
    subtitle: Optional[str] = None


@router.get("/homepage", summary="Homepage sections, including hidden ones")
def list_sections(
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    sections = site_service.homepage_sections(db, active_only=False)
    return ok_list([site_service.section_to_dict(section) for section in sections])


@router.put("/homepage", summary="Reorder and toggle sections")
def save_sections(
    payload: List[SectionUpdate],
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("content")),
):
    """
    The whole arrangement in one call.

    Reordering moves several rows at once, so sending them together is one
    transaction rather than a burst of requests that could half-apply.
    """
    for entry in payload:
        section = db.get(HomepageSection, entry.id)
        if section is None:
            continue

        if entry.active is not None:
            section.active = entry.active
        if entry.display_order is not None:
            section.display_order = entry.display_order
        if entry.title is not None:
            section.title = entry.title
        if entry.subtitle is not None:
            section.subtitle = entry.subtitle

    db.commit()

    sections = site_service.homepage_sections(db, active_only=False)
    return ok_list(
        [site_service.section_to_dict(section) for section in sections],
        message="Homepage updated.",
    )


# --------------------------------------------------------------- banners


class BannerWrite(CamelModel):
    title: Optional[str] = None
    subtitle: Optional[str] = None
    image: Optional[str] = None
    button_text: Optional[str] = None
    button_link: Optional[str] = None
    starts_at: Optional[datetime] = None
    ends_at: Optional[datetime] = None
    active: Optional[bool] = None
    display_order: Optional[int] = None


def _banner_dict(banner: Banner) -> dict:
    return {
        "id": banner.id,
        "title": banner.title,
        "subtitle": banner.subtitle,
        "image": banner.image,
        "buttonText": banner.button_text,
        "buttonLink": banner.button_link,
        "startsAt": banner.starts_at,
        "endsAt": banner.ends_at,
        "active": banner.active,
        "displayOrder": banner.display_order,
    }


def _apply_banner(banner: Banner, payload: BannerWrite) -> None:
    provided = payload.model_dump(exclude_unset=True, by_alias=False)
    fields = (
        "title", "subtitle", "image", "button_text", "button_link",
        "starts_at", "ends_at", "active", "display_order",
    )
    for field in fields:
        if field in provided and provided[field] is not None:
            setattr(banner, field, provided[field])


@router.get("/banners", summary="Every banner")
def list_banners(
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    banners = db.execute(select(Banner).order_by(Banner.display_order)).scalars().all()
    return ok_list([_banner_dict(banner) for banner in banners])


@router.post("/banners", status_code=201, summary="Create a banner")
def create_banner(
    payload: BannerWrite,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("content")),
):
    banner = Banner(
        id=next_id(db, Banner, "banner"),
        title=payload.title or "",
        starts_at=payload.starts_at or datetime.utcnow(),
    )
    _apply_banner(banner, payload)
    db.add(banner)
    db.commit()
    db.refresh(banner)
    return ok(_banner_dict(banner), message="Banner created.")


@router.put("/banners/{banner_id}", summary="Update a banner")
def update_banner(
    banner_id: str,
    payload: BannerWrite,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("content")),
):
    banner = db.get(Banner, banner_id)
    if banner is None:
        raise NotFoundError("No such banner.", error_code="BANNER_NOT_FOUND")

    _apply_banner(banner, payload)
    db.commit()
    db.refresh(banner)
    return ok(_banner_dict(banner), message="Banner updated.")


@router.delete("/banners/{banner_id}", summary="Delete a banner")
def delete_banner(
    banner_id: str,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("content")),
):
    banner = db.get(Banner, banner_id)
    if banner is None:
        raise NotFoundError("No such banner.", error_code="BANNER_NOT_FOUND")

    db.delete(banner)
    db.commit()
    return ok(message="Banner deleted.")


# --------------------------------------------------------------- coupons


@marketing_router.get("/coupons", summary="Every coupon")
def list_coupons(
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    coupons = coupon_service.list_coupons(db, active_only=False)
    return ok_list(
        [
            {
                "id": coupon.id,
                "code": coupon.code,
                "description": coupon.description,
                "type": coupon.type,
                "value": float(coupon.value),
                "minSubtotal": float(coupon.min_subtotal),
                "maxDiscount": (
                    float(coupon.max_discount) if coupon.max_discount is not None else None
                ),
                "startsAt": coupon.starts_at,
                "endsAt": coupon.ends_at,
                "usageLimit": coupon.usage_limit,
                "usageCount": coupon.usage_count,
                "perCustomerLimit": coupon.per_customer_limit,
                # Derived, so a scheduled coupon goes live on its own and an
                # expired one stops being offered without anyone editing it.
                "status": coupon_service.effective_status(coupon),
                "createdAt": coupon.created_at,
            }
            for coupon in coupons
        ]
    )


@marketing_router.post("/coupons", status_code=201, summary="Create a coupon")
def create_coupon(
    payload: dict,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("coupons")),
):
    coupon = coupon_service.save_coupon(db, payload)
    return ok({"id": coupon.id, "code": coupon.code}, message="Coupon created.")


@marketing_router.put("/coupons/{coupon_id}", summary="Update a coupon")
def update_coupon(
    coupon_id: str,
    payload: dict,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("coupons")),
):
    coupon = coupon_service.save_coupon(db, payload, coupon_id)
    return ok({"id": coupon.id, "code": coupon.code}, message="Coupon updated.")


@marketing_router.delete("/coupons/{coupon_id}", summary="Delete a coupon")
def delete_coupon(
    coupon_id: str,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("coupons")),
):
    coupon_service.delete_coupon(db, coupon_id)
    return ok(message="Coupon deleted.")


# --------------------------------------------------------------- reviews


class ReviewStatusUpdate(CamelModel):
    status: str


@marketing_router.get("/reviews", summary="Every review, for moderation")
def list_reviews(
    status: Optional[str] = None,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    reviews = review_service.list_all(db, status=status)
    return ok_list(
        [
            {
                "id": review.id,
                "productId": review.product_id,
                "customerId": review.customer_id,
                "customerName": review.author,
                "rating": review.rating,
                "title": review.title,
                "body": review.body,
                "status": review.status,
                "verifiedPurchase": review.verified_purchase,
                "submittedAt": review.submitted_at,
            }
            for review in reviews
        ]
    )


@marketing_router.put("/reviews/{review_id}", summary="Approve or reject a review")
def set_review_status(
    review_id: str,
    payload: ReviewStatusUpdate,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("reviews")),
):
    review = review_service.set_status(db, review_id, payload.status)
    return ok({"id": review.id, "status": review.status}, message=f"Review {payload.status}.")


@marketing_router.delete("/reviews/{review_id}", summary="Delete a review")
def delete_review(
    review_id: str,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("reviews")),
):
    review_service.delete_review(db, review_id)
    return ok(message="Review deleted.")
