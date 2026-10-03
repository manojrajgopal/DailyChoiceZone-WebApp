"""Billing endpoints — the customer's invoices, and the portal's whole module."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.dependencies.auth import get_current_admin, get_current_customer, require_access, require_permission
from app.models import AdminUser, CreditNote, Customer, Invoice, Payment, Refund
from app.schemas.billing import (
    CreditNoteCreate,
    CreditNoteOut,
    CreditNoteStatusUpdate,
    InvoiceOut,
    MarkPaidRequest,
    PaymentOut,
    RefundCreate,
    RefundOut,
    RefundStatusUpdate,
)
from app.services import invoices as service
from app.utils.response import ok, ok_list

router = APIRouter(prefix="/invoices", tags=["Billing"])
admin_router = APIRouter(prefix="/admin/billing", tags=["Billing"])


# ------------------------------------------------------------- customer


@router.get("", summary="Your invoices")
def list_my_invoices(
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    rows = service.list_invoices(db, customer_id=customer.id)
    return ok_list([InvoiceOut.from_model(invoice).model_dump(by_alias=True) for invoice in rows])


@router.get("/{invoice_id}", summary="One of your invoices")
def get_my_invoice(
    invoice_id: str,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    invoice = service.get_invoice(db, invoice_id, customer_id=customer.id)
    return ok(InvoiceOut.from_model(invoice).model_dump(by_alias=True))


# ---------------------------------------------------------------- portal


@admin_router.get("/invoices", summary="Every invoice")
def list_invoices(
    search: Optional[str] = None,
    status: Optional[str] = None,
    order_id: Optional[str] = Query(None, alias="orderId"),
    payment_status: Optional[str] = Query(None, alias="paymentStatus"),
    date_from: Optional[datetime] = Query(None, alias="from"),
    date_to: Optional[datetime] = Query(None, alias="to"),
    min_amount: Optional[int] = Query(None, alias="minAmount"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    """
    Every invoice, or the ones matching the filters.

    `orderId` narrows it to a single order's invoice, which is what the order
    and invoice screens ask for. They used to read the whole ledger — 334 KB —
    and pick the row out in the browser.
    """
    rows = service.list_invoices(
        db,
        search=search,
        status=status,
        order_id=order_id,
        payment_status=payment_status,
        date_from=date_from,
        date_to=date_to,
        min_amount=min_amount,
    )
    return ok_list([InvoiceOut.from_model(invoice).model_dump(by_alias=True) for invoice in rows])


@admin_router.get("/invoices/{invoice_id}", summary="One invoice")
def get_invoice(
    invoice_id: str,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    invoice = service.get_invoice(db, invoice_id)
    return ok(InvoiceOut.from_model(invoice).model_dump(by_alias=True))


@admin_router.post("/invoices/{invoice_id}/mark-paid", summary="Record a settlement")
def mark_paid(
    invoice_id: str,
    payload: MarkPaidRequest,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("orders")),
):
    invoice = service.mark_paid(db, invoice_id, payload.amount)
    return ok(InvoiceOut.from_model(invoice).model_dump(by_alias=True), message="Marked as paid.")


@admin_router.get("/payments", summary="Every transaction")
def list_payments(
    search: Optional[str] = None,
    status: Optional[str] = None,
    method: Optional[str] = None,
    order_id: Optional[str] = Query(None, alias="orderId"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    """`orderId` narrows it to one order's transaction — see the invoices route."""
    rows = service.list_payments(
        db, search=search, status=status, method=method, order_id=order_id
    )
    return ok_list([PaymentOut.from_model(payment).model_dump(by_alias=True) for payment in rows])


@admin_router.get("/payments/{payment_id}", summary="One transaction")
def get_payment(
    payment_id: str,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    payment = service.get_payment(db, payment_id)
    return ok(PaymentOut.from_model(payment).model_dump(by_alias=True))


@admin_router.post("/payments/{payment_id}/capture", summary="Mark a payment received")
def capture_payment(
    payment_id: str,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("orders")),
):
    payment = service.capture_payment(db, payment_id)
    return ok(PaymentOut.from_model(payment).model_dump(by_alias=True), message="Payment received.")


@admin_router.get("/refunds", summary="Every refund")
def list_refunds(
    search: Optional[str] = None,
    status: Optional[str] = None,
    order_id: Optional[str] = Query(None, alias="orderId"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    rows = service.list_refunds(db, search=search, status=status, order_id=order_id)
    return ok_list([RefundOut.from_model(refund).model_dump(by_alias=True) for refund in rows])


@admin_router.post("/refunds", status_code=201, summary="Raise a refund")
def create_refund(
    payload: RefundCreate,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_access("refunds")),
):
    """
    An amount refund. Above the approval threshold, raised by an admin
    without `refunds-large`, it is recorded `requested` to await approval
    rather than sent (docs/refunds.md).
    """
    from app.services import refunds as refund_service

    status = service.normalise_refund_status(payload.status)
    threshold = refund_service.threshold_paise(db)
    waits = bool(threshold and payload.amount > threshold and not refund_service.has_access(admin, "refunds-large"))
    refund = service.create_refund(
        db,
        invoice_id=payload.invoice_id,
        amount=payload.amount,
        reason=payload.reason,
        lines=payload.lines,
        initiated_by=admin.id,
        status="requested" if waits else status,
        method=payload.method,
        reason_code=payload.reason_code,
        internal_note=payload.internal_note,
        idempotency_key=payload.idempotency_key,
        requires_approval=waits,
    )
    return ok(RefundOut.from_model(refund).model_dump(by_alias=True),
              message="Refund recorded; it needs approval before it is sent." if waits else "Refund raised.")


@admin_router.put("/refunds/{refund_id}", summary="Move a refund along")
def update_refund(
    refund_id: str,
    payload: RefundStatusUpdate,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_access("refunds")),
):
    from app.services import refunds as refund_service

    status = service.normalise_refund_status(payload.status)
    if status == "completed":
        current = service.get_refund(db, refund_id)
        if current.status == "requested":
            # Sending a requested refund is approving it: the approval rules apply.
            refund = refund_service.approve(db, refund_id, admin)
            if refund.status == "failed":
                from app.core.errors import ConflictError

                raise ConflictError("The payment provider declined this refund. Please try again or contact support.",
                                    error_code="PROVIDER_REFUSED")
            return ok(RefundOut.from_model(refund).model_dump(by_alias=True), message=f"Refund {status}.")
    refund = service.set_refund_status(db, refund_id, status)
    return ok(RefundOut.from_model(refund).model_dump(by_alias=True), message=f"Refund {status}.")


@admin_router.get("/credit-notes", summary="Every credit note")
def list_credit_notes(
    order_id: Optional[str] = Query(None, alias="orderId"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    """`orderId` narrows it to one order's notes — see the invoices route."""
    rows = service.list_credit_notes(db, order_id=order_id)
    return ok_list([CreditNoteOut.model_validate(note).model_dump(by_alias=True) for note in rows])


@admin_router.post("/credit-notes", status_code=201, summary="Issue a credit note")
def create_credit_note(
    payload: CreditNoteCreate,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_access("refunds")),
):
    note = service.create_credit_note(
        db,
        invoice_id=payload.invoice_id,
        total=payload.total,
        reason=payload.reason,
        refund_id=payload.refund_id,
        status=payload.status,
    )
    return ok(
        CreditNoteOut.model_validate(note).model_dump(by_alias=True),
        message="Credit note issued.",
    )


@admin_router.put("/credit-notes/{note_id}", summary="Issue or cancel a credit note")
def update_credit_note(
    note_id: str,
    payload: CreditNoteStatusUpdate,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_access("refunds")),
):
    note = service.set_credit_note_status(db, note_id, payload.status)
    return ok(CreditNoteOut.model_validate(note).model_dump(by_alias=True))


# ------------------------------------------------------------- reporting


def _window(from_: Optional[datetime], to: Optional[datetime]):
    conditions = []
    if from_:
        conditions.append(Invoice.issued_at >= from_)
    if to:
        conditions.append(Invoice.issued_at <= to)
    return conditions


@admin_router.get("/overview", summary="What the billing landing page shows")
def billing_overview(
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    """
    The three panels beside the tiles, in one read.

    The page used to assemble them from the three list endpoints — every
    invoice, every payment and every refund in the business, some 470 KB of
    them — to show eight invoices, the refunds still open, and a total per
    payment method. The lists are still there for the pages that list things.

    Deliberately not scoped to the tiles' date range, because none of these
    three ever was: "recent invoices" means the latest eight whatever window
    the tiles are showing, and the same goes for what is outstanding.
    """
    recent = service.list_invoices(db)[:8]

    open_refunds = [
        refund
        for refund in service.list_refunds(db)
        if refund.status not in ("completed", "rejected", "cancelled")
    ]

    by_method = db.execute(
        select(Payment.method, func.coalesce(func.sum(Payment.amount), 0))
        .where(Payment.status != "failed")
        .group_by(Payment.method)
        .order_by(func.sum(Payment.amount).desc())
    ).all()

    return ok(
        {
            "recentInvoices": [
                InvoiceOut.from_model(invoice).model_dump(by_alias=True) for invoice in recent
            ],
            "openRefunds": [
                RefundOut.from_model(refund).model_dump(by_alias=True)
                for refund in open_refunds
            ],
            "paymentsByMethod": [
                {"method": method, "amount": int(amount)} for method, amount in by_method
            ],
        }
    )


@admin_router.get("/stats", summary="Revenue, collected, outstanding, refunded")
def billing_stats(
    date_from: Optional[datetime] = Query(None, alias="from"),
    date_to: Optional[datetime] = Query(None, alias="to"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    """
    Aggregated in SQL, never from a stored total.

    A cached figure is wrong the moment somebody marks an invoice paid, and a
    dashboard that lies about money is worse than one that is a little slower.
    """
    conditions = _window(date_from, date_to) + [Invoice.status != "cancelled"]

    totals = db.execute(
        select(
            func.coalesce(func.sum(Invoice.grand_total), 0),
            func.coalesce(func.sum(Invoice.amount_paid), 0),
            func.coalesce(func.sum(Invoice.total_tax), 0),
            func.coalesce(func.sum(Invoice.shipping), 0),
            func.coalesce(func.sum(Invoice.coupon_discount), 0),
            func.count(Invoice.id),
        ).where(*conditions)
    ).one()

    refunded = db.execute(
        select(func.coalesce(func.sum(Refund.amount), 0)).where(Refund.status == "completed")
    ).scalar_one()

    refund_count = db.execute(select(func.count()).select_from(Refund)).scalar_one()
    payment_count = db.execute(select(func.count()).select_from(Payment)).scalar_one()
    note_count = db.execute(select(func.count()).select_from(CreditNote)).scalar_one()

    revenue, paid, tax, shipping, discounts, invoice_count = totals

    return ok(
        {
            "revenue": int(revenue),
            "paid": int(paid),
            "pending": max(0, int(revenue) - int(paid)),
            "refunded": int(refunded),
            "taxCollected": int(tax),
            "shippingRevenue": int(shipping),
            "discountsGiven": int(discounts),
            "invoiceCount": int(invoice_count),
            "paymentCount": int(payment_count),
            "refundCount": int(refund_count),
            "creditNoteCount": int(note_count),
            "netSales": int(paid) - int(refunded),
        }
    )


@admin_router.get("/tax-report", summary="Tax collected, by rate")
def tax_report(
    date_from: Optional[datetime] = Query(None, alias="from"),
    date_to: Optional[datetime] = Query(None, alias="to"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    """
    Grouped by rate rather than by category, because that is how a return is
    filed — the question is "how much at 5%", not "how much from footwear".
    """
    from app.models import InvoiceItem

    conditions = _window(date_from, date_to) + [Invoice.status != "cancelled"]

    rows = db.execute(
        select(
            InvoiceItem.tax_rate_percent,
            func.coalesce(func.sum(InvoiceItem.taxable_amount), 0),
            func.coalesce(func.sum(InvoiceItem.cgst), 0),
            func.coalesce(func.sum(InvoiceItem.sgst), 0),
            func.coalesce(func.sum(InvoiceItem.igst), 0),
            func.coalesce(func.sum(InvoiceItem.tax), 0),
            func.count(func.distinct(InvoiceItem.invoice_id)),
        )
        .join(Invoice, Invoice.id == InvoiceItem.invoice_id)
        .where(*conditions)
        .group_by(InvoiceItem.tax_rate_percent)
        .order_by(InvoiceItem.tax_rate_percent)
    ).all()

    return ok_list(
        [
            {
                "ratePercent": float(rate),
                "taxableAmount": int(taxable),
                "cgst": int(cgst),
                "sgst": int(sgst),
                "igst": int(igst),
                "totalTax": int(total),
                "invoiceCount": int(count),
            }
            for rate, taxable, cgst, sgst, igst, total, count in rows
        ]
    )
