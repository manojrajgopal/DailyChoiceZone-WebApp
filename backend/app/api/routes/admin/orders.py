"""Orders, for the portal."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Body, Depends, Query
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
    q: Optional[str] = Query(None, max_length=80),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    """
    Every order, one customer's, or the one an Order ID names.

    `customerId` is what the customer page asks for. It used to read the whole
    order book — 279 KB — and filter it in the browser. `q` is an Order ID
    (`DCZ10241` or `ORD001`), matched exactly; names and emails match nothing.
    """
    orders = service.list_orders(db, customer_id=customer_id, q=q)
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
    The moves an admin makes by hand: confirm, cancel, record a return to
    origin.

    Everything else belongs to the workflow that owns it
    (`services/fulfilment/workflow.py`, docs/order-fulfilment.md): packing
    moves an order to Packing and Packed, a shipment moves it from Packed to
    Delivered. Asking this endpoint for one of those is refused (409
    `WORKFLOW_OWNED`), as is any skip or backward move (409
    `INVALID_TRANSITION`) — whatever the request says, so the workflow can't
    be bypassed by calling the API directly.
    """
    from app.services import audit

    previous = service.get_order(db, order_id).status
    order = service.update_status(
        db, order_id, payload.status, note=payload.note, reason=payload.reason, actor=admin.id, source="admin"
    )
    if previous != order.status:
        details = {k: v for k, v in (("note", payload.note), ("reason", payload.reason)) if v}
        audit.record(db, "orders.status", resource_type="orders", resource_id=order.id, actor=admin,
                     summary=f"Moved order {order.order_number} from {previous} to {order.status}",
                     changes={"status": {"from": previous, "to": order.status}},
                     details=details or None)
        db.commit()
    invoice = db.execute(
        select(Invoice).where(Invoice.order_id == order.id)
    ).scalar_one_or_none()
    return ok(
        OrderOut.from_model(order, invoice).model_dump(by_alias=True),
        message=f"Order is now {payload.status}.",
    )


@router.get("/{order_id}/fulfilment", summary="Where the order is in fulfilment, and what can be done next")
def order_fulfilment(order_id: str, db: Session = Depends(get_db), admin: AdminUser = Depends(get_current_admin)):
    """
    The lifecycle (each step completed, current, upcoming, skipped, exception
    or cancelled), the valid next actions for this admin, the packing job,
    packages, shipment, tracking and returns, and one history across all of
    them. Decided here; the order page only draws it.
    """
    from app.services.fulfilment import overview

    return ok(overview.view(db, order_id[:20], admin))


@router.post("/{order_id}/fulfilment/actions", summary="Take the next fulfilment step from the order page")
def order_fulfilment_action(order_id: str, payload: dict = Body(...), db: Session = Depends(get_db),
                            admin: AdminUser = Depends(get_current_admin)):
    """
    `{ action, reason?, note? }`, where action is one of `confirm`, `cancel`,
    `record-return` (permission `orders`) or `start-packing`, `begin-packing`,
    `repack` (permission `packing`). Each is validated by the service that owns
    it. Answers with the fresh fulfilment view.
    """
    from app.services.fulfilment import overview

    message = overview.perform(db, order_id[:20], payload, admin)
    db.expire_all()
    return ok(overview.view(db, order_id[:20], admin), message=message)


@router.post("/{order_id}/payment-link", status_code=201, summary="Ask the customer to pay online")
def send_payment_link(
    order_id: str,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("orders")),
):
    """
    Ask the customer to pay a confirmed, unpaid order online.

    Sent by the store's own email (and SMS/WhatsApp where switched on), with a
    link to the store's own payment page — not a Razorpay Payment Link, so the
    customer never sees a Razorpay page (docs/payments-in-our-ui.md). The order
    is marked paid only when the gateway confirms the payment, never when the
    request is sent. Can be sent again.

    Cash-on-delivery orders only, as before: a checkout order still holding
    stock is paid from its own payment page within its window.
    """
    from app.models import Payment
    from app.services import settlement

    order = service.get_order(db, order_id)
    payment = db.execute(select(Payment).where(Payment.order_id == order.id)).scalars().first()
    if payment is None:
        from app.core.errors import NotFoundError

        raise NotFoundError("That order has no payment record.", error_code="PAYMENT_NOT_FOUND")
    sent = settlement.request_online_payment(db, payment)
    return ok({**sent, "shortUrl": sent["url"]}, message="Payment request sent to the customer.")
