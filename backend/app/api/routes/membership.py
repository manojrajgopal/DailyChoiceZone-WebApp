"""
The membership programme.

Shoppers:
    GET  /api/memberships                 the programme and its plans (public)
    GET  /api/memberships/me              your membership, if any
    POST /api/memberships/checkout        start buying a plan
    POST /api/memberships/{id}/verify     confirm the payment the browser reports
    POST /api/memberships/{id}/abandon    close a purchase that was not paid

Store (permission "customers"):
    GET/PUT          /api/admin/memberships/programme
    GET/POST         /api/admin/memberships/plans
    PUT/DELETE       /api/admin/memberships/plans/{id}
    GET              /api/admin/memberships
    POST             /api/admin/memberships/{id}/cancel
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import Field
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.dependencies.auth import get_current_customer, get_optional_customer, require_permission
from app.models import AdminUser, Customer, CustomerMembership, MembershipPlan
from app.schemas.base import CamelModel
from app.services import membership as service
from app.utils.response import ok

router = APIRouter(prefix="/memberships", tags=["Membership"])
admin_router = APIRouter(prefix="/admin/memberships", tags=["Admin · Membership"])


def plan_out(plan: MembershipPlan) -> dict:
    per_month = float(plan.price) / max(plan.duration_months, 1)
    return {
        "id": plan.id,
        "name": plan.name,
        "description": plan.description,
        "durationMonths": plan.duration_months,
        "price": float(plan.price),
        "compareAtPrice": float(plan.compare_at_price) if plan.compare_at_price is not None else None,
        "pricePerMonth": round(per_month, 2),
        "freeDelivery": plan.free_delivery,
        "freeDeliveriesPerMonth": plan.free_deliveries_per_month,
        "memberDiscountPercent": float(plan.member_discount_percent or 0),
        "extraReturnDays": plan.extra_return_days,
        "earlyAccess": plan.early_access,
        "prioritySupport": plan.priority_support,
        "badge": plan.badge,
        "active": plan.active,
        "sortOrder": plan.sort_order,
    }


class CheckoutIn(CamelModel):
    plan_id: str = Field(min_length=1, max_length=20)


class VerifyIn(CamelModel):
    razorpay_payment_id: str = Field(default="", max_length=64)
    razorpay_order_id: str = Field(default="", max_length=64)
    razorpay_signature: str = Field(default="", max_length=128)


# ---------------------------------------------------------------- shoppers


@router.get("", summary="The membership programme and its plans")
def programme(
    db: Session = Depends(get_db),
    customer: Optional[Customer] = Depends(get_optional_customer),
):
    service.expire_lapsed(db)
    info = service.programme(db)
    current = service.active_membership(db, customer.id) if customer else None
    return ok(
        {
            **info,
            "plans": [plan_out(p) for p in service.list_plans(db)] if info["enabled"] else [],
            "membership": service.membership_summary(db, current),
        }
    )


@router.get("/me", summary="Your membership")
def mine(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    service.expire_lapsed(db)
    current = service.active_membership(db, customer.id)
    return ok(
        {
            "programme": service.programme(db),
            "membership": service.membership_summary(db, current),
            "history": [service.membership_summary(db, m) for m in service.history(db, customer)],
        }
    )


@router.post("/checkout", status_code=201, summary="Start buying a plan")
def checkout(
    payload: CheckoutIn,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    membership, handoff = service.start_purchase(db, customer, payload.plan_id)
    return ok(
        {
            "membershipId": membership.id,
            "status": membership.status,
            "gateway": handoff or None,
            "membership": service.membership_summary(db, membership) if membership.status == "active" else None,
        }
    )


@router.post("/{membership_id}/verify", summary="Confirm a membership payment")
def verify(
    membership_id: str,
    payload: VerifyIn,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    membership = service.confirm_purchase(
        db, customer, membership_id, payload.model_dump(by_alias=False)
    )
    name = service.programme(db)["name"]
    return ok(service.membership_summary(db, membership), message=f"Welcome to {name}!")


@router.post("/{membership_id}/abandon", summary="Close an unpaid purchase")
def abandon(
    membership_id: str,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    service.cancel_pending(db, customer, membership_id)
    return ok(message="Purchase closed.")


# -------------------------------------------------------------------- store


@admin_router.get("/programme", summary="Programme settings")
def get_programme(db: Session = Depends(get_db), admin: AdminUser = Depends(require_permission("customers"))):
    return ok(service.programme(db))


@admin_router.put("/programme", summary="Save programme settings")
def put_programme(
    payload: dict,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("customers")),
):
    return ok(service.save_programme(db, payload), message="Membership settings saved.")


@admin_router.get("/plans", summary="Every plan")
def list_plans(db: Session = Depends(get_db), admin: AdminUser = Depends(require_permission("customers"))):
    return ok([plan_out(p) for p in service.list_plans(db, include_inactive=True)])


@admin_router.post("/plans", status_code=201, summary="Add a plan")
def create_plan(
    payload: dict,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("customers")),
):
    return ok(plan_out(service.save_plan(db, payload)), message="Plan added.")


@admin_router.put("/plans/{plan_id}", summary="Update a plan")
def update_plan(
    plan_id: str,
    payload: dict,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("customers")),
):
    return ok(plan_out(service.save_plan(db, payload, plan_id)), message="Plan updated.")


@admin_router.delete("/plans/{plan_id}", summary="Delete or retire a plan")
def delete_plan(
    plan_id: str,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("customers")),
):
    outcome = service.delete_plan(db, plan_id)
    return ok(
        {"outcome": outcome},
        message="Plan deleted." if outcome == "deleted" else "Plan retired — existing members keep it until it ends.",
    )


@admin_router.get("", summary="Members")
def list_members(
    status: Optional[str] = Query(default=None, max_length=12),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("customers")),
):
    from app.models import Customer as CustomerModel

    service.expire_lapsed(db)
    rows = service.list_members(db, status=status)
    people = {c.id: c for c in db.query(CustomerModel).filter(CustomerModel.id.in_({r.customer_id for r in rows})).all()} if rows else {}
    return ok(
        [
            {
                **service.membership_summary(db, row),
                "customerId": row.customer_id,
                "customerName": people[row.customer_id].full_name if row.customer_id in people else "",
                "customerEmail": people[row.customer_id].email if row.customer_id in people else "",
                "paidAt": row.paid_at,
            }
            for row in rows
        ]
    )


@admin_router.post("/{membership_id}/cancel", summary="End a membership now")
def cancel_membership(
    membership_id: str,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("customers")),
):
    membership: CustomerMembership = service.admin_cancel(db, membership_id)
    return ok(service.membership_summary(db, membership), message="Membership ended.")
