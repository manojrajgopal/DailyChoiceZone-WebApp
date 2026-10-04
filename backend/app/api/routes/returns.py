"""
Returns and replacements — the customer's side and the store's.

Customer:
    GET  /api/orders/{order}/returns   what can be sent back, and requests so far
    POST /api/orders/{order}/returns   ask to return or replace items
    GET  /api/returns                  every request on the account
    POST /api/returns/{id}/cancel      withdraw a request not yet processed

Store (permission "orders"):
    GET  /api/admin/returns            all requests, filterable
    GET  /api/admin/returns/{id}
    PUT  /api/admin/returns/{id}/status
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import Field
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.dependencies.auth import get_current_customer, require_permission
from app.models import AdminUser, Customer, ReturnRequest
from app.schemas.base import CamelModel
from app.services import orders as order_service
from app.services import returns as service
from app.utils.response import ok

router = APIRouter(tags=["Returns"])
admin_router = APIRouter(prefix="/admin/returns", tags=["Admin · Returns"])


class ReturnItemIn(CamelModel):
    order_item_id: int
    quantity: int = Field(ge=1, le=100)


class ReturnRequestIn(CamelModel):
    kind: Literal["return", "replacement"]
    reason: str = Field(min_length=1, max_length=120)
    comment: str = Field(default="", max_length=1000)
    items: List[ReturnItemIn] = Field(min_length=1, max_length=50)


class ReturnStatusIn(CamelModel):
    status: str = Field(min_length=1, max_length=24)
    note: str = Field(default="", max_length=500)
    # Partial refunds (docs/refunds.md): how a return's refund goes back —
    # `original` or `store-credit`. Omitted: the refund settings' default.
    refund_method: Optional[str] = Field(default=None, max_length=20)


def serialise(request: ReturnRequest, *, for_admin: bool = False) -> dict:
    data = {
        "id": request.id,
        "orderId": request.order_id,
        "orderNumber": request.order_number,
        "kind": request.kind,
        "status": request.status,
        "reason": request.reason,
        "comment": request.comment,
        "resolutionNote": request.resolution_note,
        "amount": request.amount,
        "refundId": request.refund_id,
        "createdAt": request.created_at,
        "updatedAt": request.updated_at,
        "canCancel": request.status == "requested",
        "items": [
            {
                "orderItemId": item.order_item_id,
                "productId": item.product_id,
                "name": item.name,
                "image": item.image,
                "size": item.size,
                "color": item.color,
                "quantity": item.quantity,
                "amount": item.amount,
            }
            for item in request.items
        ],
        "timeline": [
            {"status": event.status, "note": event.note, "by": event.actor, "at": event.occurred_at}
            for event in request.events
        ],
    }
    if for_admin:
        data["customerId"] = request.customer_id
        data["customerName"] = request.customer_name
        data["nextSteps"] = list(service.next_steps(request))
    return data


# ---------------------------------------------------------------- customer


@router.get("/orders/{identifier}/returns", summary="Return and replacement options for an order")
def order_returns(
    identifier: str,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    order = order_service.get_order(db, identifier, customer_id=customer.id)
    return ok(
        {
            "eligibility": service.eligibility(db, order),
            "requests": [serialise(r) for r in service.list_for_order(db, order)],
        }
    )


@router.post("/orders/{identifier}/returns", status_code=201, summary="Request a return or replacement")
def request_return(
    identifier: str,
    payload: ReturnRequestIn,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    order = order_service.get_order(db, identifier, customer_id=customer.id)
    request = service.create(
        db,
        customer,
        order,
        kind=payload.kind,
        reason=payload.reason,
        comment=payload.comment,
        items=[item.model_dump(by_alias=True) for item in payload.items],
    )
    return ok(
        serialise(request),
        message=(
            "Your return request has been received."
            if payload.kind == "return"
            else "Your replacement request has been received."
        ),
    )


@router.get("/returns", summary="Your returns and replacements")
def my_returns(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    return ok([serialise(r) for r in service.list_for_customer(db, customer)])


@router.post("/returns/{request_id}/cancel", summary="Withdraw a request")
def cancel_return(
    request_id: str,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    request = service.cancel_by_customer(db, customer, request_id)
    return ok(serialise(request), message="Your request has been cancelled.")


# ------------------------------------------------------------------- store


@admin_router.get("", summary="All returns and replacements")
def list_returns(
    status: Optional[str] = Query(default=None, max_length=24),
    kind: Optional[str] = Query(default=None, max_length=12),
    q: Optional[str] = Query(default=None, max_length=64,
                             description="A Return ID, or the order's number or Order ID, matched exactly."),
    customer: Optional[str] = Query(default=None, max_length=64, description="A Customer ID, matched exactly."),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("orders")),
):
    rows = service.list_all(db, status=status, kind=kind, q=q, customer=customer)
    return ok([serialise(r, for_admin=True) for r in rows])


@admin_router.get("/{request_id}", summary="One return or replacement")
def get_return(
    request_id: str,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("orders")),
):
    return ok(serialise(service.get(db, request_id), for_admin=True))


@admin_router.put("/{request_id}/status", summary="Move a return or replacement along")
def move_return(
    request_id: str,
    payload: ReturnStatusIn,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("orders")),
):
    if payload.status == "refunded":
        # Marking a return refunded sends money: the refunds permission, not just orders.
        from app.core.errors import AuthorizationError
        from app.services import refunds as refund_service

        if not refund_service.has_access(admin, "refunds"):
            raise AuthorizationError("Your role does not include 'refunds'.", error_code="PERMISSION_DENIED")
    request = service.update_status(db, request_id, payload.status, note=payload.note, actor=admin.id,
                                    refund_method=payload.refund_method)
    return ok(serialise(request, for_admin=True), message="Request updated.")
