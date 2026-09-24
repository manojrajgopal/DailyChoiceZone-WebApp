"""Orders — the customer's own."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.dependencies.auth import get_current_customer
from app.models import Customer, Invoice
from app.schemas.auth import AddressWrite
from app.schemas.orders import CancelOrderRequest, OrderOut, PlaceOrderRequest
from app.services import auth as auth_service, orders as service
from app.utils.response import ok, ok_list

router = APIRouter(prefix="/orders", tags=["Orders"])


def _invoice_for(db: Session, order_id: str):
    return db.execute(select(Invoice).where(Invoice.order_id == order_id)).scalar_one_or_none()


@router.get("", summary="Your orders")
def list_orders(
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    orders = service.list_orders(db, customer_id=customer.id)
    invoices = {
        invoice.order_id: invoice
        for invoice in db.execute(
            select(Invoice).where(Invoice.customer_id == customer.id)
        ).scalars()
    }
    return ok_list(
        [OrderOut.from_model(o, invoices.get(o.id)).model_dump(by_alias=True) for o in orders]
    )


@router.post("", status_code=201, summary="Place an order")
def place_order(
    payload: PlaceOrderRequest,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    """
    Checkout.

    Order, stock, payment and invoice in one transaction. The response carries
    all three so the confirmation page needs no follow-up call.
    """
    shipping = payload.shipping_address.model_dump(by_alias=True)
    billing_address = payload.billing_address.model_dump(by_alias=True) if payload.billing_address else None

    order, invoice, payment = service.place_order(
        db,
        customer,
        shipping_address=shipping,
        billing_address=billing_address,
        delivery_method=payload.delivery_method,
        payment_method=payload.payment_method,
        coupon_code=payload.coupon_code,
        email=payload.email,
    )

    # Keep the address for next time, if asked. After the order, never before —
    # a failed checkout should not leave a saved address behind.
    if payload.save_address:
        try:
            auth_service.create_address(
                db,
                customer,
                AddressWrite(
                    full_name=shipping["fullName"],
                    phone=shipping.get("phone", ""),
                    line1=shipping["line1"],
                    line2=shipping.get("line2", ""),
                    city=shipping["city"],
                    state=shipping["state"],
                    pincode=shipping["pincode"],
                    country=shipping.get("country", "India"),
                ),
            )
        except Exception:  # noqa: BLE001 — a saved address is a convenience
            db.rollback()

    return ok(
        {
            "order": OrderOut.from_model(order, invoice).model_dump(by_alias=True),
            "invoiceId": invoice.id,
            "invoiceNumber": invoice.invoice_number,
            "paymentId": payment.id,
            "paymentStatus": payment.status,
            "amount": invoice.grand_total,
        },
        message="Order placed.",
    )


@router.get("/{identifier}", summary="One of your orders")
def get_order(
    identifier: str,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    """Accepts `ORD001` or the `DCZ10241` number from the confirmation email."""
    order = service.get_order(db, identifier, customer_id=customer.id)
    return ok(OrderOut.from_model(order, _invoice_for(db, order.id)).model_dump(by_alias=True))


@router.post("/{identifier}/cancel", summary="Cancel an order")
def cancel_order(
    identifier: str,
    payload: CancelOrderRequest,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    """
    One action endpoint, because cancelling is not "setting a field".

    It returns stock, records a timeline entry and refuses once the parcel has
    left — none of which a generic status update should be deciding.
    """
    order = service.cancel_order(db, identifier, customer, payload.reason)
    return ok(
        OrderOut.from_model(order, _invoice_for(db, order.id)).model_dump(by_alias=True),
        message="Order cancelled.",
    )
