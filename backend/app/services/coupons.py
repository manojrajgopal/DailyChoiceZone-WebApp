"""Coupons: listing, validation and redemption.

**Validation happens here, never in the browser.** A discount the client
calculates is a discount the client can change; this is the only place a code
is turned into money off.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import Coupon, CouponUsage
from app.services import billing
from app.utils.ids import next_id


def list_coupons(db: Session, *, active_only: bool = True) -> List[Coupon]:
    statement = select(Coupon).order_by(Coupon.code)
    if active_only:
        now = datetime.utcnow()
        statement = statement.where(
            Coupon.active.is_(True),
            Coupon.starts_at <= now,
            (Coupon.ends_at.is_(None)) | (Coupon.ends_at >= now),
        )
    return list(db.execute(statement).scalars().all())


def get_coupon(db: Session, identifier: str) -> Coupon:
    coupon = db.execute(
        select(Coupon).where((Coupon.id == identifier) | (Coupon.code == identifier.upper()))
    ).scalar_one_or_none()

    if coupon is None:
        raise NotFoundError(f"No coupon '{identifier}'.", error_code="COUPON_NOT_FOUND")

    return coupon


def effective_status(coupon: Coupon, now: Optional[datetime] = None) -> str:
    """
    What a coupon actually is right now.

    Derived rather than stored: a scheduled coupon becomes live while nobody is
    looking, and an expired one expires overnight. A status column would be
    wrong the morning after it was written.
    """
    now = now or datetime.utcnow()

    if not coupon.active:
        return "disabled"
    if coupon.starts_at > now:
        return "scheduled"
    if coupon.ends_at and coupon.ends_at < now:
        return "expired"
    if coupon.usage_limit is not None and coupon.usage_count >= coupon.usage_limit:
        return "exhausted"
    return "active"


def validate_coupon(
    db: Session,
    code: str,
    subtotal_minor: int,
    *,
    customer_id: Optional[str] = None,
) -> dict:
    """
    Check a code against a basket.

    Returns a result rather than raising, because "add ₹500 more to use this"
    is useful information and not an error — the caller decides whether to show
    it as a failure.
    """
    trimmed = (code or "").strip().upper()
    if not trimmed:
        return {"valid": False, "reason": "Enter a coupon code."}

    coupon = db.execute(select(Coupon).where(Coupon.code == trimmed)).scalar_one_or_none()
    if coupon is None:
        return {"valid": False, "reason": f'"{trimmed}" is not a valid code.'}

    status = effective_status(coupon)
    if status == "disabled":
        return {"valid": False, "reason": "That code is no longer available."}
    if status == "scheduled":
        return {"valid": False, "reason": "That code is not active yet."}
    if status == "expired":
        return {"valid": False, "reason": "That code has expired."}
    if status == "exhausted":
        return {"valid": False, "reason": "That code has been fully redeemed."}

    minimum = billing.to_minor(float(coupon.min_subtotal))
    if subtotal_minor < minimum:
        shortfall = billing.to_major(minimum - subtotal_minor)
        return {
            "valid": False,
            "reason": f"Add ₹{shortfall:,.0f} more to use {coupon.code}.",
        }

    # Per-customer limits are the commonest thing a coupon needs to enforce,
    # and a usage counter alone cannot answer "has *this* person used it".
    if customer_id and coupon.per_customer_limit is not None:
        used = db.execute(
            select(func.count())
            .select_from(CouponUsage)
            .where(CouponUsage.coupon_id == coupon.id, CouponUsage.customer_id == customer_id)
        ).scalar_one()

        if used >= coupon.per_customer_limit:
            return {"valid": False, "reason": "You have already used that code."}

    discount = billing.calculate_coupon_discount(
        subtotal_minor,
        {
            "code": coupon.code,
            "type": coupon.type,
            "value": float(coupon.value),
            "minSubtotal": float(coupon.min_subtotal),
            "maxDiscount": float(coupon.max_discount) if coupon.max_discount is not None else None,
        },
    )

    return {
        "valid": True,
        "id": coupon.id,
        "code": coupon.code,
        "description": coupon.description,
        "type": coupon.type,
        "value": float(coupon.value),
        "minSubtotal": float(coupon.min_subtotal),
        "maxDiscount": float(coupon.max_discount) if coupon.max_discount is not None else None,
        "discount": discount,
    }


def record_usage(
    db: Session, coupon_code: str, customer_id: str, order_id: str, discount_minor: int
) -> None:
    """
    Note that a coupon was redeemed.

    Called inside the order transaction and does not commit — a usage recorded
    against an order that then failed would burn a customer's one-time code for
    nothing.
    """
    coupon = db.execute(
        select(Coupon).where(Coupon.code == coupon_code.upper())
    ).scalar_one_or_none()

    if coupon is None:
        return

    coupon.usage_count += 1
    db.add(
        CouponUsage(
            coupon_id=coupon.id,
            customer_id=customer_id,
            order_id=order_id,
            discount_amount=billing.to_major(discount_minor),
            used_at=datetime.utcnow(),
        )
    )


# ------------------------------------------------------------------ admin


def save_coupon(db: Session, payload: dict, coupon_id: Optional[str] = None) -> Coupon:
    if coupon_id:
        coupon = get_coupon(db, coupon_id)
    else:
        coupon = Coupon(id=next_id(db, Coupon, "coupon"), code="", starts_at=datetime.utcnow())
        db.add(coupon)

    code = (payload.get("code") or coupon.code or "").strip().upper()
    if not code:
        raise ValidationError("A coupon needs a code.", error_code="COUPON_INCOMPLETE")

    clash = db.execute(
        select(Coupon.id).where(Coupon.code == code, Coupon.id != coupon.id)
    ).scalar_one_or_none()
    if clash:
        raise ConflictError(f"'{code}' is already in use.", error_code="COUPON_CODE_TAKEN")

    coupon.code = code
    for field, attribute in (
        ("description", "description"),
        ("type", "type"),
        ("value", "value"),
        ("minSubtotal", "min_subtotal"),
        ("maxDiscount", "max_discount"),
        ("usageLimit", "usage_limit"),
        ("perCustomerLimit", "per_customer_limit"),
    ):
        if field in payload:
            setattr(coupon, attribute, payload[field])

    if payload.get("startsAt"):
        coupon.starts_at = _parse(payload["startsAt"])
    if "endsAt" in payload:
        coupon.ends_at = _parse(payload["endsAt"]) if payload["endsAt"] else None
    if "status" in payload:
        coupon.active = payload["status"] != "disabled"
    if "active" in payload:
        coupon.active = bool(payload["active"])

    db.commit()
    db.refresh(coupon)
    return coupon


def delete_coupon(db: Session, coupon_id: str) -> None:
    """
    Remove a coupon.

    Refused once it has been redeemed: a usage row points at it, and the order
    it discounted has to stay explicable.
    """
    coupon = get_coupon(db, coupon_id)

    used = db.execute(
        select(func.count()).select_from(CouponUsage).where(CouponUsage.coupon_id == coupon.id)
    ).scalar_one()

    if used:
        raise ConflictError(
            f"{coupon.code} has been redeemed {used} time(s). Disable it instead.",
            error_code="COUPON_IN_USE",
        )

    db.delete(coupon)
    db.commit()


def _parse(value: str) -> datetime:
    from app.seed.json_loader import parse_dt

    parsed = parse_dt(value)
    if parsed is None:
        raise ValidationError(f"'{value}' is not a valid date.", error_code="INVALID_DATE")
    return parsed
