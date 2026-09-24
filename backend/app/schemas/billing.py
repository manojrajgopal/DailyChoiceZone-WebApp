"""Billing shapes.

Amounts are integers in the currency's minor unit throughout — the same
convention the database and the frontend use. A response that quietly switched
to rupees would be a units bug waiting in every consumer.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from pydantic import Field

from app.schemas.base import CamelModel


class TaxBreakdown(CamelModel):
    mode: str
    taxable_amount: int
    cgst: int
    sgst: int
    igst: int
    total_tax: int
    rate_percent: float


class BillingBreakdown(CamelModel):
    currency: str
    item_count: int
    subtotal: int
    product_discount: int
    coupon_discount: int
    coupon_code: Optional[str] = None
    shipping: int
    other_charges: int
    taxable_amount: int
    tax: TaxBreakdown
    grand_total: int
    prices_include_tax: bool


class InvoiceLineOut(CamelModel):
    product_id: str
    name: str
    sku: str
    hsn: str
    size: Optional[str] = None
    color: Optional[str] = None
    quantity: int
    unit_price: int
    line_subtotal: int
    discount: int
    taxable_amount: int
    tax_rate_percent: float
    cgst: int
    sgst: int
    igst: int
    tax: int
    line_total: int


class InvoiceOut(CamelModel):
    id: str
    invoice_number: str
    order_id: str
    order_number: str
    customer_id: str
    customer_name: str
    customer_email: str
    status: str
    issued_at: datetime
    due_at: datetime
    billing_address: dict
    shipping_address: dict
    place_of_supply: str
    lines: List[InvoiceLineOut]
    breakdown: BillingBreakdown
    payment_id: Optional[str] = None
    payment_method: str
    payment_status: str
    amount_paid: int
    amount_refunded: int
    notes: str
    terms: str

    @classmethod
    def from_model(cls, invoice) -> "InvoiceOut":
        return cls(
            id=invoice.id,
            invoice_number=invoice.invoice_number,
            order_id=invoice.order_id,
            order_number=invoice.order_number,
            customer_id=invoice.customer_id,
            customer_name=invoice.customer_name,
            customer_email=invoice.customer_email,
            status=invoice.status,
            issued_at=invoice.issued_at,
            due_at=invoice.due_at,
            billing_address=invoice.billing_address or {},
            shipping_address=invoice.shipping_address or {},
            place_of_supply=invoice.place_of_supply,
            lines=[InvoiceLineOut.model_validate(line) for line in invoice.items],
            breakdown=BillingBreakdown(
                currency=invoice.currency,
                item_count=invoice.item_count,
                subtotal=invoice.subtotal,
                product_discount=invoice.product_discount,
                coupon_discount=invoice.coupon_discount,
                coupon_code=invoice.coupon_code,
                shipping=invoice.shipping,
                other_charges=invoice.other_charges,
                taxable_amount=invoice.taxable_amount,
                tax=TaxBreakdown(
                    mode=invoice.tax_mode,
                    taxable_amount=invoice.taxable_amount,
                    cgst=invoice.cgst,
                    sgst=invoice.sgst,
                    igst=invoice.igst,
                    total_tax=invoice.total_tax,
                    rate_percent=float(invoice.tax_rate_percent),
                ),
                grand_total=invoice.grand_total,
                prices_include_tax=invoice.prices_include_tax,
            ),
            payment_id=invoice.payment_id,
            payment_method=invoice.payment_method,
            payment_status=invoice.payment_status,
            amount_paid=invoice.amount_paid,
            amount_refunded=invoice.amount_refunded,
            notes=invoice.notes,
            terms=invoice.terms,
        )


class PaymentEventOut(CamelModel):
    status: str
    note: str
    occurred_at: datetime = Field(serialization_alias="at")


class PaymentOut(CamelModel):
    id: str
    transaction_id: str
    order_id: str
    order_number: str
    invoice_id: str
    invoice_number: str
    customer_id: str
    customer_name: str
    customer_email: str
    amount: int
    refunded_amount: int
    method: str
    status: str
    provider: str
    created_at: datetime
    captured_at: Optional[datetime] = None
    timeline: List[PaymentEventOut] = []
    # A masked remnant only — never an instrument. See the Payment model.
    instrument_hint: str

    @classmethod
    def from_model(cls, payment) -> "PaymentOut":
        return cls(
            id=payment.id,
            transaction_id=payment.transaction_id,
            order_id=payment.order_id,
            order_number=payment.order_number,
            invoice_id=payment.invoice_id,
            invoice_number=payment.invoice_number,
            customer_id=payment.customer_id,
            customer_name=payment.customer_name,
            customer_email=payment.customer_email,
            amount=payment.amount,
            refunded_amount=payment.refunded_amount,
            method=payment.method,
            status=payment.status,
            provider=payment.provider,
            created_at=payment.created_at_utc,
            captured_at=payment.captured_at,
            timeline=[PaymentEventOut.model_validate(e) for e in payment.events],
            instrument_hint=payment.instrument_hint,
        )


class RefundLineOut(CamelModel):
    product_id: str
    name: str
    quantity: int
    amount: int


class RefundOut(CamelModel):
    id: str
    refund_number: str
    order_id: str
    order_number: str
    invoice_id: str
    invoice_number: str
    payment_id: str
    customer_id: str
    customer_name: str
    amount: int
    reason: str
    status: str
    requested_at: datetime
    processed_at: Optional[datetime] = None
    lines: List[RefundLineOut] = []
    credit_note_id: Optional[str] = None
    initiated_by: str

    @classmethod
    def from_model(cls, refund) -> "RefundOut":
        return cls(
            **{
                key: getattr(refund, key)
                for key in (
                    "id", "refund_number", "order_id", "order_number", "invoice_id",
                    "invoice_number", "payment_id", "customer_id", "customer_name",
                    "amount", "reason", "status", "requested_at", "processed_at",
                    "credit_note_id", "initiated_by",
                )
            },
            lines=[RefundLineOut.model_validate(line) for line in refund.items],
        )


class CreditNoteOut(CamelModel):
    id: str
    credit_note_number: str
    invoice_id: str
    invoice_number: str
    order_id: str
    order_number: str
    customer_id: str
    customer_name: str
    refund_id: Optional[str] = None
    reason: str
    amount: int
    tax: int
    total: int
    issued_at: datetime
    status: str


# ------------------------------------------------------------- requests


class RefundCreate(CamelModel):
    invoice_id: str
    amount: int = Field(gt=0)
    reason: str = Field(min_length=2)
    lines: Optional[List[dict]] = None
    status: str = "completed"


class RefundStatusUpdate(CamelModel):
    status: str


class CreditNoteCreate(CamelModel):
    invoice_id: str
    total: int = Field(gt=0)
    reason: str = Field(min_length=2)
    refund_id: Optional[str] = None
    status: str = "issued"


class CreditNoteStatusUpdate(CamelModel):
    status: str


class MarkPaidRequest(CamelModel):
    # Omitted settles the whole outstanding balance.
    amount: Optional[int] = None


class BillingStats(CamelModel):
    revenue: int
    paid: int
    pending: int
    refunded: int
    tax_collected: int
    shipping_revenue: int
    discounts_given: int
    invoice_count: int
    payment_count: int
    refund_count: int
    credit_note_count: int
    net_sales: int


class TaxReportRow(CamelModel):
    rate_percent: float
    taxable_amount: int
    cgst: int
    sgst: int
    igst: int
    total_tax: int
    invoice_count: int
