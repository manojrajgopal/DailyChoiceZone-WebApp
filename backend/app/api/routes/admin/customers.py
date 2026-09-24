"""Customers, for the portal."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.core.database import get_db
from app.core.errors import NotFoundError
from app.dependencies.auth import get_current_admin, require_permission
from app.models import AdminUser, Address, Customer, Order, WishlistItem
from app.schemas.base import CamelModel
from app.utils.response import ok, ok_list

router = APIRouter(prefix="/admin/customers", tags=["Customers"])


class CustomerStatusUpdate(CamelModel):
    status: str


def _aggregates(db: Session) -> dict:
    """
    Order count, spend and last order — one grouped query, not one per customer.

    Recomputed rather than stored: a stored total is wrong the moment an order
    is cancelled, and nothing runs to notice.
    """
    rows = db.execute(
        select(
            Order.customer_id,
            func.count(Order.id),
            func.coalesce(func.sum(Order.total), 0),
            func.max(Order.placed_at),
        )
        .where(Order.status != "cancelled")
        .group_by(Order.customer_id)
    ).all()

    return {
        customer_id: {
            "orderCount": int(count),
            "totalSpent": float(spent),
            "lastOrderAt": last,
        }
        for customer_id, count, spent, last in rows
    }


def _to_dict(customer: Customer, stats: dict, wishlist: list[str]) -> dict:
    return {
        "id": customer.id,
        "firstName": customer.first_name,
        "lastName": customer.last_name,
        "email": customer.email,
        "phone": customer.phone,
        "status": customer.status,
        "joinedAt": customer.joined_at,
        "orderCount": stats.get("orderCount", 0),
        "totalSpent": stats.get("totalSpent", 0.0),
        "lastOrderAt": stats.get("lastOrderAt"),
        "addresses": [
            {
                "id": a.id,
                "fullName": a.full_name,
                "phone": a.phone,
                "line1": a.line1,
                "line2": a.line2,
                "city": a.city,
                "state": a.state,
                "pincode": a.pincode,
                "type": a.type,
                "isDefault": a.is_default,
            }
            for a in customer.addresses
        ],
        "wishlistProductIds": wishlist,
    }


@router.get("", summary="Every customer")
def list_customers(
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    customers = (
        db.execute(select(Customer).options(selectinload(Customer.addresses)).order_by(Customer.id))
        .unique()
        .scalars()
        .all()
    )
    stats = _aggregates(db)

    wishlists: dict[str, list[str]] = {}
    for customer_id, product_id in db.execute(
        select(WishlistItem.customer_id, WishlistItem.product_id)
    ).all():
        wishlists.setdefault(customer_id, []).append(product_id)

    return ok_list(
        [
            _to_dict(customer, stats.get(customer.id, {}), wishlists.get(customer.id, []))
            for customer in customers
        ]
    )


@router.get("/{customer_id}", summary="One customer")
def get_customer(
    customer_id: str,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    customer = db.get(Customer, customer_id)
    if customer is None:
        raise NotFoundError("No such customer.", error_code="CUSTOMER_NOT_FOUND")

    stats = _aggregates(db).get(customer_id, {})
    wishlist = list(
        db.execute(
            select(WishlistItem.product_id).where(WishlistItem.customer_id == customer_id)
        ).scalars().all()
    )
    return ok(_to_dict(customer, stats, wishlist))


@router.put("/{customer_id}/status", summary="Block or unblock a customer")
def set_status(
    customer_id: str,
    payload: CustomerStatusUpdate,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("customers")),
):
    """
    Blocking takes effect immediately.

    Every request re-reads the customer's status, so a blocked account cannot
    keep working until its token happens to expire.
    """
    customer = db.get(Customer, customer_id)
    if customer is None:
        raise NotFoundError("No such customer.", error_code="CUSTOMER_NOT_FOUND")

    customer.status = payload.status
    db.commit()
    db.refresh(customer)

    stats = _aggregates(db).get(customer_id, {})
    return ok(_to_dict(customer, stats, []), message=f"Customer {payload.status}.")
