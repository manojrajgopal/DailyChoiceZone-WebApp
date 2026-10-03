"""
Partial refunds (docs/refunds.md).

Customer:

    GET  /api/account/refunds                         your refunds (?order=<id or number>)
    GET  /api/account/orders/{identifier}/refunds     one of your orders' refunds (404 if not yours)

Portal (`refunds`; approving above the threshold and the settings: `refunds-large`):

    GET  /api/admin/refunds                           list, filters, pagination
    GET  /api/admin/refunds/summary                   headline numbers
    GET  /api/admin/refunds/settings                  PUT (refunds-large)
    GET  /api/admin/refunds/orders/{orderId}          what is left to refund, and the order's refunds
    POST /api/admin/refunds/orders/{orderId}/calculate  the breakdown of a proposed refund
    POST /api/admin/refunds/orders/{orderId}          raise (and send) it — idempotent by key
    GET  /api/admin/refunds/{id}
    POST /api/admin/refunds/{id}/approve | reject | cancel | retry
"""

from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import Field
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.dependencies.auth import get_current_customer, require_access
from app.models import AdminUser, Customer
from app.schemas.base import CamelModel
from app.services import invoices as ledger
from app.services import refunds as service
from app.utils.response import Pagination, ok

account_router = APIRouter(prefix="/account", tags=["Account · Refunds"])
admin_router = APIRouter(prefix="/admin/refunds", tags=["Admin · Refunds"])


# ---------------------------------------------------------------- customer


@account_router.get("/refunds", summary="Your refunds")
def my_refunds(order: Optional[str] = Query(None, max_length=40), db: Session = Depends(get_db),
               customer: Customer = Depends(get_current_customer)):
    return ok({"items": service.for_customer(db, customer, order=order)})


@account_router.get("/orders/{identifier}/refunds", summary="One of your orders' refunds")
def my_order_refunds(identifier: str, db: Session = Depends(get_db),
                     customer: Customer = Depends(get_current_customer)):
    found = service.customer_order(db, customer, identifier[:40])
    return ok({"orderNumber": found.order_number, "items": service.for_customer(db, customer, order=found.id)})


# ------------------------------------------------------------------ portal


class LineIn(CamelModel):
    order_item_id: int = Field(ge=1)
    quantity: int = Field(ge=0, le=10_000)


class CalculateIn(CamelModel):
    lines: List[LineIn] = Field(default_factory=list, max_length=200)
    full_refund: bool = False
    include_shipping: bool = False
    # Paise. Omitted with `includeShipping`: all the delivery fee still refundable.
    shipping_amount: Optional[int] = Field(default=None, ge=0, le=10_000_000_00)
    adjustment_amount: int = Field(default=0, ge=0, le=10_000_000_00)
    method: Optional[str] = Field(default=None, max_length=20)


class CreateIn(CalculateIn):
    idempotency_key: str = Field(min_length=8, max_length=80)
    reason_code: str = Field(max_length=30)
    reason: str = Field(default="", max_length=255)
    internal_note: str = Field(default="", max_length=1000)
    manual_reference: str = Field(default="", max_length=120)
    process_now: bool = True


class NoteIn(CamelModel):
    note: str = Field(default="", max_length=500)


class SettingsIn(CamelModel):
    allowed_methods: Optional[List[str]] = Field(default=None, max_length=5)
    approval_threshold: Optional[int] = None
    returns_skip_approval: Optional[bool] = None
    returns_method: Optional[str] = Field(default=None, max_length=20)
    cod_method: Optional[str] = Field(default=None, max_length=20)
    include_shipping_on_full_refund: Optional[bool] = None
    auto_credit_note: Optional[bool] = None
    poll_minutes: Optional[int] = None
    max_attempts: Optional[int] = None


def _lines(payload: CalculateIn) -> list:
    return [{"orderItemId": line.order_item_id, "quantity": line.quantity} for line in payload.lines]


@admin_router.get("", summary="Every refund")
def list_refunds(
    status: str = Query("", max_length=20),
    method: str = Query("", max_length=20),
    reason_code: str = Query("", alias="reasonCode", max_length=30),
    q: str = Query("", max_length=100),
    order_id: str = Query("", alias="orderId", max_length=20),
    awaiting_approval: bool = Query(False, alias="awaitingApproval"),
    page: int = Query(1, ge=1, le=10_000),
    page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_access("refunds")),
):
    rows, total = service.search(db, status=status, method=method, reason_code=reason_code, q=q, order_id=order_id,
                                 awaiting_approval=awaiting_approval, page=page, page_size=page_size)
    return ok({"items": [service.admin_view(r) for r in rows],
               "pagination": Pagination.build(page, page_size, total).model_dump()})


@admin_router.get("/summary", summary="Refund headline numbers")
def refund_summary(db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("refunds"))):
    return ok(service.summary(db))


@admin_router.get("/settings", summary="Refund settings")
def get_settings(db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("refunds"))):
    return ok({**service.settings(db), "methods": list(ledger.REFUND_METHODS)})


@admin_router.put("/settings", summary="Save refund settings")
def put_settings(payload: SettingsIn, db: Session = Depends(get_db),
                 admin: AdminUser = Depends(require_access("refunds-large"))):
    saved = service.save_settings(db, payload.model_dump(by_alias=True, exclude_none=True))
    return ok({**saved, "methods": list(ledger.REFUND_METHODS)}, message="Refund settings saved.")


@admin_router.get("/orders/{order_id}", summary="What is left to refund on an order")
def order_context(order_id: str, db: Session = Depends(get_db),
                  admin: AdminUser = Depends(require_access("refunds"))):
    breakdown = service.calculate(db, order_id[:40], actor=admin)
    rows = ledger.list_refunds(db, order_id=breakdown["orderId"])
    return ok({"breakdown": breakdown, "refunds": [service.admin_view(r) for r in rows]})


@admin_router.post("/orders/{order_id}/calculate", summary="The breakdown of a proposed refund")
def calculate(order_id: str, payload: CalculateIn, db: Session = Depends(get_db),
              admin: AdminUser = Depends(require_access("refunds"))):
    return ok(service.calculate(db, order_id[:40], lines=_lines(payload), full=payload.full_refund,
                                include_shipping=payload.include_shipping, shipping_amount=payload.shipping_amount,
                                adjustment=payload.adjustment_amount, method=payload.method, actor=admin))


@admin_router.post("/orders/{order_id}", status_code=201, summary="Raise a refund of lines, quantities and shipping")
def create(order_id: str, payload: CreateIn, db: Session = Depends(get_db),
           admin: AdminUser = Depends(require_access("refunds"))):
    refund = service.create_for_order(
        db, order_id[:40], actor=admin, idempotency_key=payload.idempotency_key, lines=_lines(payload),
        full=payload.full_refund, include_shipping=payload.include_shipping, shipping_amount=payload.shipping_amount,
        adjustment=payload.adjustment_amount, method=payload.method, reason_code=payload.reason_code,
        reason=payload.reason, internal_note=payload.internal_note, manual_reference=payload.manual_reference,
        process_now=payload.process_now,
    )
    messages = {
        "completed": "Refund completed.", "processing": "Refund sent; the gateway will confirm it.",
        "requested": "Refund recorded; it needs approval before it is sent." if refund.requires_approval
        else "Refund recorded.",
        "failed": "The payment gateway declined this refund. You can retry it from the refunds list.",
    }
    return ok(service.admin_view(refund), message=messages.get(refund.status, "Refund recorded."))


@admin_router.get("/{refund_id}", summary="One refund")
def get_refund(refund_id: str, db: Session = Depends(get_db),
               admin: AdminUser = Depends(require_access("refunds"))):
    return ok(service.admin_view(ledger.get_refund(db, refund_id[:20])))


@admin_router.post("/{refund_id}/approve", summary="Approve and send a requested refund")
def approve(refund_id: str, db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("refunds"))):
    refund = service.approve(db, refund_id[:20], admin)
    return ok(service.admin_view(refund), message="Refund approved.")


@admin_router.post("/{refund_id}/reject", summary="Reject a requested refund")
def reject(refund_id: str, payload: NoteIn, db: Session = Depends(get_db),
           admin: AdminUser = Depends(require_access("refunds"))):
    return ok(service.admin_view(service.reject(db, refund_id[:20], admin, payload.note)), message="Refund rejected.")


@admin_router.post("/{refund_id}/cancel", summary="Cancel a requested or failed refund")
def cancel(refund_id: str, payload: NoteIn, db: Session = Depends(get_db),
           admin: AdminUser = Depends(require_access("refunds"))):
    return ok(service.admin_view(service.cancel(db, refund_id[:20], admin, payload.note)), message="Refund cancelled.")


@admin_router.post("/{refund_id}/retry", summary="Retry a failed refund, or check a processing one")
def retry(refund_id: str, db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("refunds"))):
    refund = service.retry(db, refund_id[:20], admin)
    return ok(service.admin_view(refund), message={
        "completed": "Refund completed.", "processing": "Refund sent; the gateway will confirm it.",
        "failed": "The payment gateway declined it again.",
    }.get(refund.status, "Refund updated."))
