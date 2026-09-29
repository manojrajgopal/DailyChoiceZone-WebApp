"""Orders, for the portal."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.dependencies.auth import get_current_admin, require_permission
from app.models import AdminUser, Invoice
from app.schemas.orders import OrderOut, OrderStatusUpdate
from app.services import orders as service
from app.utils.response import ok, ok_list

router = APIRouter(prefix="/admin/orders", tags=["Orders"])


@router.get("", summary="Every order")
def list_orders(
    customer_id: Optional[str] = Query(None, alias="customerId"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    """
    Every order, or one customer's.

    `customerId` is what the customer page asks for. It used to read the whole
    order book — 279 KB — and filter it in the browser.
    """
    orders = service.list_orders(db, customer_id=customer_id)
    invoices = {
        invoice.order_id: invoice for invoice in db.execute(select(Invoice)).scalars()
    }
    return ok_list(
        [OrderOut.from_model(o, invoices.get(o.id)).model_dump(by_alias=True) for o in orders]
    )


@router.get("/{order_id}", summary="One order")
def get_order(
    order_id: str,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    order = service.get_order(db, order_id)
    invoice = db.execute(
        select(Invoice).where(Invoice.order_id == order.id)
    ).scalar_one_or_none()
    return ok(OrderOut.from_model(order, invoice).model_dump(by_alias=True))


@router.put("/{order_id}/status", summary="Move an order along")
def update_status(
    order_id: str,
    payload: OrderStatusUpdate,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("orders")),
):
    """
    One endpoint for every transition.

    Not `/ship`, `/deliver`, `/cancel` — they are the same operation with a
    different argument, and the legal transitions are enforced in the service
    rather than implied by which URL was called.
    """
    order = service.update_status(
        db, order_id, payload.status, note=payload.note, actor=admin.id, confirm=payload.confirm
    )
    invoice = db.execute(
        select(Invoice).where(Invoice.order_id == order.id)
    ).scalar_one_or_none()
    return ok(
        OrderOut.from_model(order, invoice).model_dump(by_alias=True),
        message=f"Order is now {payload.status}.",
    )


@router.post("/{order_id}/payment-link", status_code=201, summary="Send a payment link")
def send_payment_link(
    order_id: str,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("orders")),
):
    """
    Raise a Razorpay Payment Link for a confirmed, unpaid order and send it.

    Razorpay delivers it to the customer by SMS and email. The order is marked
    paid only when the gateway confirms the payment — by the link's callback
    or its `payment_link.paid` webhook — never when the link is sent.

    Cash-on-delivery orders only: see `settlement.open_payment_link` for why a
    checkout order still holding stock cannot be paid this way.
    """
    from app.models import Payment
    from app.services import settlement

    order = service.get_order(db, order_id)
    payment = db.execute(select(Payment).where(Payment.order_id == order.id)).scalars().first()
    if payment is None:
        from app.core.errors import NotFoundError

        raise NotFoundError("That order has no payment record.", error_code="PAYMENT_NOT_FOUND")

    link = settlement.open_payment_link(db, payment)
    return ok(link, message="Payment link sent to the customer.")
