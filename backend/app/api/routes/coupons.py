"""Coupons: what is on offer, and whether one applies."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.dependencies.auth import get_optional_customer
from app.models import Customer
from app.schemas.base import CamelModel
from app.services import coupons as service
from app.utils.response import ok, ok_list

router = APIRouter(prefix="/coupons", tags=["Coupons"])


class ValidateCoupon(CamelModel):
    code: str
    # Minor units, so the client and the server are talking about the same
    # number. Advisory only: the order recalculates from the cart regardless.
    subtotal: int


@router.get("", summary="Coupons a shopper can use")
def list_coupons(
    db: Session = Depends(get_db),
    customer: Optional[Customer] = Depends(get_optional_customer),
):
    """
    Only live ones, and only those this shopper may use — a members' code is
    listed to members, a selected customer's to that customer, and a code
    handed out privately to nobody.
    """
    coupons = service.coupons_for(db, customer.id if customer else None)
    return ok_list(
        [
            {
                "id": coupon.id,
                "code": coupon.code,
                "description": coupon.description,
                "type": coupon.type,
                "value": float(coupon.value),
                "minSubtotal": float(coupon.min_subtotal),
                "maxDiscount": float(coupon.max_discount) if coupon.max_discount is not None else None,
                "audience": coupon.audience,
                "endsAt": coupon.ends_at,
                "perCustomerLimit": coupon.per_customer_limit,
            }
            for coupon in coupons
        ]
    )


@router.post("/validate", summary="Check a code against a basket")
def validate(
    payload: ValidateCoupon,
    db: Session = Depends(get_db),
    customer: Optional[Customer] = Depends(get_optional_customer),
):
    """
    Returns 200 with `valid: false` and a reason when a code does not apply.

    "Add ₹500 more to use this" is information, not an error — a 4xx would make
    the client treat a perfectly normal outcome as a failure.
    """
    result = service.validate_coupon(
        db, payload.code, payload.subtotal, customer_id=customer.id if customer else None
    )
    return ok(result)
