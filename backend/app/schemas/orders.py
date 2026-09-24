"""Order shapes."""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from pydantic import Field

from app.schemas.base import CamelModel


class AddressPayload(CamelModel):
    full_name: str
    phone: str = ""
    line1: str
    line2: str = ""
    city: str
    state: str
    pincode: str
    country: str = "India"
    email: str = ""


class PlaceOrderRequest(CamelModel):
    """
    What checkout sends.

    Notably absent: any amount. Prices, discounts, tax and the total are all
    recalculated server-side from the cart and the catalogue — see
    `services.orders.place_order`. A client that could name its own total would
    eventually name a smaller one.
    """

    shipping_address: AddressPayload
    # Omitted when billing matches delivery, which is most orders.
    billing_address: Optional[AddressPayload] = None
    delivery_method: str = "standard"
    payment_method: str = "upi"
    coupon_code: Optional[str] = None
    email: Optional[str] = None
    save_address: bool = False


class OrderItemOut(CamelModel):
    product_id: str
    name: str
    sku: str
    slug: str
    brand: str
    image: str
    size: Optional[str] = None
    color: Optional[str] = None
    quantity: int
    unit_price: float
    line_total: float


class OrderEventOut(CamelModel):
    status: str
    note: str
    actor: str = Field(serialization_alias="by")
    occurred_at: datetime = Field(serialization_alias="at")


class OrderTotals(CamelModel):
    item_count: int
    subtotal: float
    catalogue_savings: float
    coupon_discount: float
    delivery_fee: float
    tax_amount: float
    total: float


class OrderOut(CamelModel):
    id: str
    order_number: str
    customer_id: str
    customer_name: str
    customer_email: str
    placed_at: datetime
    status: str
    payment_status: str
    payment_method: str
    delivery_method: str
    expected_delivery: str
    tracking_number: Optional[str] = None
    items: List[OrderItemOut]
    totals: OrderTotals
    shipping_address: AddressPayload
    timeline: List[OrderEventOut] = []
    coupon_code: Optional[str] = None
    invoice_id: Optional[str] = None
    invoice_number: Optional[str] = None

    @classmethod
    def from_model(cls, order, invoice=None) -> "OrderOut":
        return cls(
            id=order.id,
            order_number=order.order_number,
            customer_id=order.customer_id,
            customer_name=order.customer_name,
            customer_email=order.customer_email,
            placed_at=order.placed_at,
            status=order.status,
            payment_status=order.payment_status,
            payment_method=order.payment_method,
            delivery_method=order.delivery_method,
            expected_delivery=order.expected_delivery,
            tracking_number=order.tracking_number,
            items=[OrderItemOut.model_validate(item) for item in order.items],
            totals=OrderTotals(
                item_count=order.item_count,
                subtotal=float(order.subtotal),
                catalogue_savings=float(order.catalogue_savings),
                coupon_discount=float(order.coupon_discount),
                delivery_fee=float(order.delivery_fee),
                tax_amount=float(order.tax_amount),
                total=float(order.total),
            ),
            shipping_address=AddressPayload(
                full_name=order.shipping_name,
                phone=order.shipping_phone,
                line1=order.shipping_line1,
                line2=order.shipping_line2,
                city=order.shipping_city,
                state=order.shipping_state,
                pincode=order.shipping_pincode,
                country=order.shipping_country,
            ),
            timeline=[OrderEventOut.model_validate(event) for event in order.events],
            coupon_code=order.coupon_code,
            invoice_id=invoice.id if invoice else None,
            invoice_number=invoice.invoice_number if invoice else None,
        )


class OrderStatusUpdate(CamelModel):
    status: str
    note: str = ""


class CancelOrderRequest(CamelModel):
    reason: str = ""
