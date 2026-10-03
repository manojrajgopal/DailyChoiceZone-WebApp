"""
Partial refunds: what a refund of some lines, quantities and shipping comes
to, the approval around it, retries, the customer's view and the settings.

See docs/refunds.md. The money itself moves in `services/invoices.py`
(`create_refund`, `dispatch_refund`, `apply_refund_outcome`, `check_refund`),
the one place every refund — the portal's, a return's, a cancellation's —
goes through. This module works out *what* to refund and hands it over.

## The calculation, per order line

For each line it reports what was ordered, cancelled, returned and already
refunded, what is left, and — for the units chosen — their share of the
line's price, its coupon/member discount, its taxable value and its tax
(CGST/SGST/IGST as invoiced). All integer paise.

Shares are **cumulative**: the first `n` of a line's `Q` units are worth
`total × n ÷ Q` (rounded down), so refunding units `r+1 … r+k` is
`cum(r+k) − cum(r)`. Any number of partial refunds of a line therefore adds
up to the line exactly — the last unit takes the remainder — and no paisa is
lost or invented (the old `line_total // qty` lost up to `qty − 1` paise).

## The limits

- no line beyond its units still refundable (ordered − cancelled − refunded);
- no more shipping than was charged and not yet refunded;
- no refund beyond what is left on the order, counting refunds still waiting
  (requested, processing) as well as completed ones.
"""

from __future__ import annotations

import copy
import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import AuthorizationError, ConflictError, NotFoundError, ValidationError
from app.models import (
    AdminUser,
    Customer,
    Invoice,
    Order,
    Payment,
    Refund,
    RefundItem,
    ReturnRequest,
    ReturnRequestItem,
    SettingDocument,
)
from app.services import billing
from app.services import invoices as ledger

logger = logging.getLogger(__name__)

SETTINGS_KEY = "refunds"
DEFAULTS: Dict = {
    # How the payment's share may go back: to the original payment (the
    # gateway; for cash on delivery, a bank/UPI transfer recorded here) or as
    # store credit.
    "allowedMethods": ["original", "store-credit"],
    # Rupees. A refund above this needs `refunds-large`; raised by anyone else
    # it waits, requested, for such an admin to approve. 0: no threshold.
    "approvalThreshold": 10000,
    # Approved returns are refunded when the return is marked refunded,
    # without a second approval (the return itself was the approval).
    "returnsSkipApproval": True,
    # How a return's refund goes back unless the team chooses otherwise.
    "returnsMethod": "original",
    # What the wizard suggests for a cash-on-delivery order.
    "codMethod": "store-credit",
    # The wizard ticks the delivery fee when every unit is being refunded.
    "includeShippingOnFullRefund": True,
    # Issue a credit note automatically when a refund completes.
    "autoCreditNote": False,
    # The refunds job: how long a processing refund waits between checks, and
    # how many times one the gateway never confirmed is sent.
    "pollMinutes": 30,
    "maxAttempts": 3,
}

STATUS_LABELS = {
    "requested": "Requested", "processing": "Processing", "completed": "Completed", "failed": "Failed",
    "cancelled": "Cancelled", "rejected": "Rejected",
}
REASON_LABELS = {
    "customer-requested": "Requested by customer", "wrong-product": "Wrong product sent", "damaged": "Arrived damaged",
    "defective": "Defective", "missing-item": "Item missing", "price-adjustment": "Price adjustment",
    "duplicate-payment": "Duplicate payment", "cancellation": "Order cancelled", "return-approved": "Return approved",
    "other": "Other",
}
METHOD_LABELS = {"original": "Original payment method", "store-credit": "Store credit"}


# ---------------------------------------------------------------- settings


def settings(db: Session) -> dict:
    stored = (db.get(SettingDocument, SETTINGS_KEY) or SettingDocument(value={})).value or {}
    merged = copy.deepcopy(DEFAULTS)
    merged.update({k: v for k, v in stored.items() if k in DEFAULTS})
    return merged


def _whole(value, label: str, low: int, high: int) -> int:
    if isinstance(value, bool):
        raise ValidationError(f"{label} must be a whole number.", error_code="INVALID_SETTING")
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ValidationError(f"{label} must be a whole number.", error_code="INVALID_SETTING") from None
    if not low <= number <= high:
        raise ValidationError(f"{label} must be between {low:,} and {high:,}.", error_code="INVALID_SETTING")
    return number


def save_settings(db: Session, payload: dict) -> dict:
    out = settings(db)
    before = copy.deepcopy(out)
    if "allowedMethods" in payload:
        methods = [m for m in dict.fromkeys(payload["allowedMethods"] or []) if isinstance(m, str)]
        if not methods or any(m not in ledger.REFUND_METHODS for m in methods):
            raise ValidationError("Choose at least one refund method from the list.", error_code="INVALID_SETTING")
        out["allowedMethods"] = methods
    for key in ("returnsSkipApproval", "includeShippingOnFullRefund", "autoCreditNote"):
        if key in payload:
            out[key] = bool(payload[key])
    for key in ("returnsMethod", "codMethod"):
        if key in payload:
            if payload[key] not in ledger.REFUND_METHODS:
                raise ValidationError("Choose a refund method from the list.", error_code="INVALID_SETTING")
            out[key] = payload[key]
    if "approvalThreshold" in payload:
        out["approvalThreshold"] = _whole(payload["approvalThreshold"], "The approval threshold", 0, 10_000_000)
    if "pollMinutes" in payload:
        out["pollMinutes"] = _whole(payload["pollMinutes"], "The check interval", 5, 1440)
    if "maxAttempts" in payload:
        out["maxAttempts"] = _whole(payload["maxAttempts"], "The number of attempts", 1, 10)

    now = datetime.utcnow()
    row = db.get(SettingDocument, SETTINGS_KEY)
    if row is None:
        db.add(SettingDocument(key=SETTINGS_KEY, value=out, created_at=now, updated_at=now))
    else:
        row.value = out
        row.updated_at = now
    from app.services import audit

    audit.record(db, "refunds.settings.updated", resource_type="settings", resource_id=SETTINGS_KEY,
                 summary="Refund settings updated",
                 changes={k: {"from": before[k], "to": out[k]} for k in out if before.get(k) != out[k]})
    db.commit()
    return out


def threshold_paise(db: Session) -> int:
    return billing.to_minor(settings(db)["approvalThreshold"] or 0)


def has_access(admin: Optional[AdminUser], permission: str) -> bool:
    """`require_access`'s rule, for decisions made inside a request."""
    if admin is None:
        return False
    if admin.role == "super-admin":
        return True
    from app.core.permissions import permissions_for

    return permission in (admin.permissions or []) or permission in permissions_for(admin.role)


# ------------------------------------------------------------- the lines


def _pairs(order: Order, invoice: Invoice) -> List[tuple]:
    """
    Each order line with its invoice line. Both are written from the same
    priced bag in the same order, so position decides; a key (product, size,
    colour, bundle) is the fallback for anything older that doesn't line up.
    """
    order_lines = sorted(order.items, key=lambda i: i.id)
    invoice_lines = sorted(invoice.items, key=lambda i: i.id)
    if len(order_lines) == len(invoice_lines) and all(
            a.product_id == b.product_id for a, b in zip(order_lines, invoice_lines)):
        return list(zip(order_lines, invoice_lines))
    pool = list(invoice_lines)
    out = []
    for item in order_lines:
        key = (item.product_id, item.size or None, item.color or None, item.bundle_group or "")
        match = next((line for line in pool if (line.product_id, line.size or None, line.color or None,
                                                line.bundle_group or "") == key), None)
        if match is None:
            match = next((line for line in pool if line.product_id == item.product_id), None)
        if match is not None:
            pool.remove(match)
        out.append((item, match))
    return out


def _refunded_units(db: Session, order: Order, pairs: List[tuple]) -> Dict[int, int]:
    """Units of each order line in refunds still holding money. Old lines name only a product."""
    rows = db.execute(
        select(RefundItem.order_item_id, RefundItem.product_id, RefundItem.quantity)
        .join(Refund, Refund.id == RefundItem.refund_id)
        .where(Refund.order_id == order.id, Refund.status.in_(ledger.ACTIVE_REFUND_STATUSES))
    ).all()
    units: Dict[int, int] = {item.id: 0 for item, _ in pairs}
    loose = []
    for order_item_id, product_id, quantity in rows:
        if order_item_id in units:
            units[order_item_id] += int(quantity or 0)
        else:
            loose.append((product_id, int(quantity or 0)))
    for product_id, quantity in loose:
        for item, _ in pairs:
            if quantity <= 0:
                break
            if item.product_id == product_id:
                take = min(quantity, item.quantity - units[item.id])
                units[item.id] += max(0, take)
                quantity -= max(0, take)
    return units


def _returned_units(db: Session, order: Order) -> Dict[int, int]:
    rows = db.execute(
        select(ReturnRequestItem.order_item_id, ReturnRequestItem.quantity)
        .join(ReturnRequest, ReturnRequest.id == ReturnRequestItem.request_id)
        .where(ReturnRequest.order_id == order.id, ReturnRequest.kind == "return",
               ReturnRequest.status.in_(("received", "refunded")))
    ).all()
    out: Dict[int, int] = {}
    for item_id, quantity in rows:
        out[item_id] = out.get(item_id, 0) + int(quantity or 0)
    return out


def _cum(total: int, n: int, q: int) -> int:
    return (int(total or 0) * n) // q if q else 0


def share_of_units(line, before: int, units: int) -> dict:
    """Units `before+1 … before+units` of an invoice line: their exact share of each amount."""
    q = int(line.quantity or 0)

    def part(total: int) -> int:
        return _cum(total, before + units, q) - _cum(total, before, q)

    amount = part(line.line_total)
    tax = part(line.tax)
    cgst, igst = part(line.cgst), part(line.igst)
    return {
        "gross": part(line.line_subtotal), "discount": part(line.discount), "amount": amount,
        "tax": tax, "taxable": amount - tax, "cgst": cgst, "igst": igst, "sgst": tax - cgst - igst,
    }


def _context(db: Session, order_id: str):
    order = db.get(Order, order_id)
    if order is None:
        order = db.execute(select(Order).where(Order.order_number == order_id)).scalar_one_or_none()
    if order is None:
        raise NotFoundError("We couldn't find that order.", error_code="ORDER_NOT_FOUND")
    invoice = ledger.get_invoice_by_order(db, order.id)
    if invoice is None:
        raise ConflictError("This order has no invoice to refund against.", error_code="NO_INVOICE")
    payment = db.execute(select(Payment).where(Payment.invoice_id == invoice.id)).scalar_one_or_none()
    return order, invoice, payment


def calculate(
    db: Session,
    order_id: str,
    *,
    lines: Optional[List[dict]] = None,
    full: bool = False,
    include_shipping: bool = False,
    shipping_amount: Optional[int] = None,
    adjustment: int = 0,
    method: Optional[str] = None,
    actor: Optional[AdminUser] = None,
    clamp: bool = False,
    tender_split: bool = True,
) -> dict:
    """
    The breakdown of a refund — or, with nothing chosen, of what is left to
    refund. What the wizard shows is exactly this; it never adds anything up
    itself. Raises on a line, quantity or amount that isn't allowed, and on a
    total beyond what is left (unless `clamp`, which a return uses: it trims
    the extras — an adjustment, then shipping — never the items).
    """
    order, invoice, payment = _context(db, order_id)
    conf = settings(db)
    pairs = _pairs(order, invoice)
    refunded = _refunded_units(db, order, pairs)
    returned = _returned_units(db, order)
    cancelled_order = order.status == "cancelled"

    wanted: Dict[int, int] = {}
    for entry in lines or []:
        try:
            item_id, quantity = int(entry.get("orderItemId")), int(entry.get("quantity"))
        except (TypeError, ValueError, AttributeError):
            raise ValidationError("Each line needs an order line and a whole quantity.",
                                  error_code="INVALID_REFUND_LINES") from None
        if item_id in wanted:
            raise ValidationError("Each line can be listed once.", error_code="DUPLICATE_LINE")
        if quantity < 0:
            raise ValidationError("A quantity can't be negative.", error_code="INVALID_QUANTITY")
        wanted[item_id] = quantity
    # A cancelled order's items and delivery go back with the cancellation itself; say so plainly
    # rather than as "only 0 can be refunded" (a goodwill adjustment is still allowed).
    if cancelled_order and not clamp and (full or include_shipping or shipping_amount
                                          or any(quantity > 0 for quantity in wanted.values())):
        raise ConflictError("This order was cancelled; its refund is raised with the cancellation.",
                            error_code="ORDER_CANCELLED")
    known = {item.id for item, _ in pairs}
    unknown = [item_id for item_id in wanted if item_id not in known]
    if unknown:
        raise ValidationError("That item isn't part of this order.", error_code="ITEM_NOT_IN_ORDER",
                              details={"orderItemIds": unknown})

    out_lines = []
    totals = {"items": 0, "gross": 0, "discount": 0, "taxable": 0, "tax": 0, "cgst": 0, "sgst": 0, "igst": 0}
    every_unit = True
    for item, line in pairs:
        cancelled = item.quantity if cancelled_order else 0
        done = min(item.quantity, refunded.get(item.id, 0))
        refundable = max(0, item.quantity - cancelled - done) if line is not None else 0
        choose = refundable if full else wanted.get(item.id, 0)
        if choose > refundable:
            raise ValidationError(
                f"Only {refundable} of {item.name} can still be refunded.", error_code="QUANTITY_EXCEEDS_REFUNDABLE",
                details={"orderItemId": item.id, "refundable": refundable})
        if choose < refundable:
            every_unit = False
        share = share_of_units(line, done, choose) if line is not None and choose else {
            "gross": 0, "discount": 0, "amount": 0, "tax": 0, "taxable": 0, "cgst": 0, "sgst": 0, "igst": 0}
        remaining_amount = (int(line.line_total) - _cum(line.line_total, done, line.quantity)) if line else 0
        for key, source in (("items", "amount"), ("gross", "gross"), ("discount", "discount"),
                            ("taxable", "taxable"), ("tax", "tax"), ("cgst", "cgst"), ("sgst", "sgst"),
                            ("igst", "igst")):
            totals[key] += share[source]
        out_lines.append({
            "orderItemId": item.id, "invoiceItemId": line.id if line else None, "productId": item.product_id,
            "name": item.name, "sku": item.sku, "image": item.image, "size": item.size, "color": item.color,
            "hsn": line.hsn if line else "",
            "ordered": item.quantity, "cancelled": cancelled, "returned": returned.get(item.id, 0),
            "refunded": done, "refundable": refundable,
            "unitPrice": int(line.unit_price) if line else 0, "lineTotal": int(line.line_total) if line else 0,
            "lineDiscount": int(line.discount) if line else 0, "lineTax": int(line.tax) if line else 0,
            "taxRatePercent": float(line.tax_rate_percent or 0) if line else 0.0,
            "remainingAmount": remaining_amount,
            "quantity": choose, "gross": share["gross"], "discount": share["discount"], "amount": share["amount"],
            "taxable": share["taxable"], "tax": share["tax"], "cgst": share["cgst"], "sgst": share["sgst"],
            "igst": share["igst"],
        })

    # --- shipping: what was charged, less what earlier refunds gave back
    shipping_refunded = int(db.execute(select(func.coalesce(func.sum(Refund.shipping_amount), 0)).where(
        Refund.order_id == order.id, Refund.status.in_(ledger.ACTIVE_REFUND_STATUSES))).scalar_one())
    shipping_left = 0 if cancelled_order else max(0, int(invoice.shipping or 0) - shipping_refunded)
    if shipping_amount is not None:
        if shipping_amount < 0 or shipping_amount > shipping_left:
            raise ValidationError(f"Up to ₹{shipping_left / 100:,.2f} of delivery can be refunded.",
                                  error_code="SHIPPING_EXCEEDS_REFUNDABLE", details={"refundable": shipping_left})
        shipping = int(shipping_amount)
    else:
        shipping = shipping_left if (include_shipping or full) else 0

    adjustment = int(adjustment or 0)
    if adjustment < 0:
        raise ValidationError("An adjustment can't be negative.", error_code="INVALID_AMOUNT")

    rooms = ledger.refund_rooms(db, invoice, payment, tender_split=tender_split)
    if cancelled_order and not clamp and (totals["items"] or shipping):
        raise ConflictError("This order was cancelled; its refund is raised with the cancellation.",
                            error_code="ORDER_CANCELLED")

    total = totals["items"] + shipping + adjustment
    if total > rooms["total"]:
        if not clamp:
            raise ConflictError(
                f"That is more than is left to refund on this order (₹{rooms['total'] / 100:,.2f}).",
                error_code="REFUND_EXCEEDS_PAYMENT", details={"remaining": rooms["total"], "total": total})
        over = total - rooms["total"]
        cut = min(over, adjustment)
        adjustment -= cut
        over -= cut
        cut = min(over, shipping)
        shipping -= cut
        over -= cut
        if over > 0:
            raise ConflictError("Less is left to refund on this order than these items cost.",
                                error_code="REFUND_EXCEEDS_PAYMENT", details={"remaining": rooms["total"]})
        total = totals["items"] + shipping + adjustment

    adjustment_tax = ledger.credit_note_tax(invoice, adjustment)["totalTax"] if adjustment else 0
    payment_part, tender_part = ledger.split_refund(invoice, total, rooms) if total else (0, 0)
    collected = ledger._collected(payment)
    from app.services import tenders

    tender_total = tenders.tender_total(invoice)
    is_cod = bool(payment and payment.method == "cod")
    allowed = list(conf["allowedMethods"])
    chosen = method or (conf["codMethod"] if is_cod and conf["codMethod"] in allowed else allowed[0])
    threshold = threshold_paise(db)
    return {
        "orderId": order.id, "orderNumber": order.order_number, "orderStatus": order.status,
        "invoiceId": invoice.id, "invoiceNumber": invoice.invoice_number, "currency": invoice.currency,
        "paymentMethod": payment.method if payment else "", "paymentStatus": payment.status if payment else "",
        "isCod": is_cod, "taxMode": invoice.tax_mode,
        "paid": {"total": collected + tender_total, "payment": collected, "tenders": tender_total,
                 "grandTotal": invoice.grand_total},
        "refunded": rooms["held"],
        "remaining": rooms["total"],
        "remainingByDestination": {"payment": rooms["payment"], "tenders": rooms["tenders"]},
        "lines": out_lines,
        "shipping": {"charged": int(invoice.shipping or 0), "refunded": shipping_refunded,
                     "refundable": shipping_left, "amount": shipping},
        "adjustment": adjustment,
        "totals": {
            "items": totals["items"], "gross": totals["gross"], "discount": totals["discount"],
            "shipping": shipping, "adjustment": adjustment,
            "taxable": totals["taxable"] + adjustment - adjustment_tax,
            "tax": totals["tax"] + adjustment_tax, "cgst": totals["cgst"], "sgst": totals["sgst"],
            "igst": totals["igst"], "total": total,
        },
        "split": {"payment": payment_part, "tenders": tender_part},
        "fullRefund": every_unit and shipping == shipping_left and total > 0,
        "suggestShipping": bool(conf["includeShippingOnFullRefund"]) and every_unit and shipping_left > 0,
        "method": chosen, "allowedMethods": allowed,
        "approvalThreshold": threshold,
        "requiresApproval": bool(threshold and total > threshold and not has_access(actor, "refunds-large")),
        "reasonCodes": [{"code": c, "label": REASON_LABELS[c]} for c in ledger.REASON_CODES],
    }


def _items_from(breakdown: dict) -> List[RefundItem]:
    return [
        RefundItem(product_id=line["productId"], name=line["name"][:200], quantity=line["quantity"],
                   amount=line["amount"], order_item_id=line["orderItemId"], invoice_item_id=line["invoiceItemId"],
                   discount=line["discount"], taxable_amount=line["taxable"],
                   tax_rate_percent=line["taxRatePercent"], cgst=line["cgst"], sgst=line["sgst"],
                   igst=line["igst"], tax=line["tax"])
        for line in breakdown["lines"] if line["quantity"] > 0
    ]


# ---------------------------------------------------------------- creating


def create_for_order(
    db: Session,
    order_id: str,
    *,
    actor: Optional[AdminUser],
    idempotency_key: str,
    lines: Optional[List[dict]] = None,
    full: bool = False,
    include_shipping: bool = False,
    shipping_amount: Optional[int] = None,
    adjustment: int = 0,
    method: Optional[str] = None,
    reason_code: str = "other",
    reason: str = "",
    internal_note: str = "",
    manual_reference: str = "",
    process_now: bool = True,
    initiated_by: Optional[str] = None,
    skip_approval: bool = False,
    clamp: bool = False,
) -> Refund:
    """
    Raise (and normally send) a refund of the chosen lines, quantities,
    shipping and adjustment — the calculation's own numbers, recomputed
    here on the server whatever the client last saw.

    Above the approval threshold, raised by someone without `refunds-large`,
    it is recorded `requested` and waits for approval instead of being sent.
    """
    key = (idempotency_key or "").strip()
    if not 8 <= len(key) <= 80:
        raise ValidationError("A refund needs an idempotency key of 8 to 80 characters.",
                              error_code="IDEMPOTENCY_KEY_REQUIRED")
    existing = ledger.find_by_idempotency_key(db, key)
    if existing is not None:
        order, _, _ = _context(db, order_id)
        if existing.order_id != order.id:
            raise ConflictError("That idempotency key was already used for a different refund.",
                                error_code="IDEMPOTENCY_KEY_REUSED")
        existing._replayed = True
        return existing

    conf = settings(db)
    breakdown = calculate(db, order_id, lines=lines, full=full, include_shipping=include_shipping,
                          shipping_amount=shipping_amount, adjustment=adjustment, method=method, actor=actor,
                          clamp=clamp)
    if breakdown["totals"]["total"] <= 0:
        raise ValidationError("Choose something to refund.", error_code="NOTHING_SELECTED")
    chosen = breakdown["method"]
    if chosen not in conf["allowedMethods"] and not (skip_approval and chosen in ledger.REFUND_METHODS):
        raise ValidationError("That refund method isn't allowed.", error_code="METHOD_NOT_ALLOWED",
                              details={"allowed": conf["allowedMethods"]})
    if reason_code not in ledger.REASON_CODES:
        raise ValidationError("Choose a reason from the list.", error_code="INVALID_REASON_CODE")

    waits = breakdown["requiresApproval"] and not skip_approval
    text = (reason or "").strip() or REASON_LABELS[reason_code]
    try:
        refund = ledger.create_refund(
            db, invoice_id=breakdown["invoiceId"], amount=breakdown["totals"]["total"], reason=text,
            initiated_by=initiated_by or (actor.id if actor else "system"),
            status="completed" if process_now and not waits else "requested",
            method=chosen, reason_code=reason_code, internal_note=internal_note, idempotency_key=key,
            items=_items_from(breakdown), shipping_amount=breakdown["shipping"]["amount"],
            tax_amount=breakdown["totals"]["tax"], discount_amount=breakdown["totals"]["discount"],
            requires_approval=waits, manual_reference=manual_reference,
        )
    except ConflictError as error:
        if error.error_code != "PROVIDER_REFUSED":
            raise
        # Recorded as failed, with the gateway's reason; the list offers a retry.
        refund = ledger.find_by_idempotency_key(db, key)
        if refund is None:
            raise
    if waits and not getattr(refund, "_replayed", False):
        from app.services import inbox

        inbox.staff(db, "refund", f"Refund {refund.refund_number} needs approval",
                    f"₹{refund.amount / 100:,.2f} on {refund.order_number}",
                    "/admin/billing/refunds?status=requested", permission="refunds-large")
        db.commit()
    return refund


# ---------------------------------------------------------------- deciding


def _audit(db: Session, action: str, refund: Refund, summary: str, **details) -> None:
    from app.services import audit

    audit.record(db, action, resource_type="refund", resource_id=refund.id, summary=summary, details=details or None)


def approve(db: Session, refund_id: str, admin: AdminUser) -> Refund:
    refund = ledger.get_refund(db, refund_id, lock=True)
    if refund.status != "requested":
        raise ConflictError("Only a requested refund can be approved.", error_code="INVALID_TRANSITION")
    if not has_access(admin, "refunds-large") and (refund.requires_approval or
                                                    refund.amount > threshold_paise(db) > 0):
        raise AuthorizationError("Approving a refund this large needs 'refunds-large'.",
                                 error_code="PERMISSION_DENIED")
    refund.approved_by = admin.id
    refund.approved_at = datetime.utcnow()
    _audit(db, "refund.approved", refund, f"Refund {refund.refund_number} approved")
    db.commit()
    try:
        return ledger.set_refund_status(db, refund.id, "completed")
    except ConflictError as error:
        if error.error_code != "PROVIDER_REFUSED":
            raise
        return ledger.get_refund(db, refund.id)


def reject(db: Session, refund_id: str, admin: AdminUser, note: str = "") -> Refund:
    refund = ledger.get_refund(db, refund_id, lock=True)
    if refund.status != "requested":
        raise ConflictError("Only a requested refund can be rejected.", error_code="INVALID_TRANSITION")
    if refund.requires_approval and not has_access(admin, "refunds-large"):
        raise AuthorizationError("Rejecting a refund awaiting approval needs 'refunds-large'.",
                                 error_code="PERMISSION_DENIED")
    if note.strip():
        refund.internal_note = (f"{refund.internal_note}\nRejected: {note.strip()}").strip()[:1000]
    _audit(db, "refund.rejected", refund, f"Refund {refund.refund_number} rejected")
    db.commit()
    return ledger.set_refund_status(db, refund.id, "rejected")


def cancel(db: Session, refund_id: str, admin: AdminUser, note: str = "") -> Refund:
    refund = ledger.get_refund(db, refund_id, lock=True)
    if refund.status not in ("requested", "failed"):
        raise ConflictError("Only a requested or failed refund can be cancelled.", error_code="INVALID_TRANSITION")
    # Withdrawing a large refund that waits for approval is a manager's call too, unless it is the
    # person who raised it taking it back.
    if (refund.status == "requested" and refund.requires_approval and not has_access(admin, "refunds-large")
            and refund.initiated_by != getattr(admin, "id", None)):
        raise AuthorizationError("Cancelling a refund awaiting approval needs 'refunds-large'.",
                                 error_code="PERMISSION_DENIED")
    if note.strip():
        refund.internal_note = (f"{refund.internal_note}\nCancelled: {note.strip()}").strip()[:1000]
    _audit(db, "refund.cancelled", refund, f"Refund {refund.refund_number} cancelled")
    db.commit()
    return ledger.set_refund_status(db, refund.id, "cancelled")


def retry(db: Session, refund_id: str, admin: Optional[AdminUser] = None) -> Refund:
    """
    Try again. A failed refund is sent again (only the payment's share — the
    tenders' went back already). A processing one the gateway never confirmed
    is looked up first and sent only if the gateway has none; one it accepted
    is asked for its state.
    """
    refund = ledger.get_refund(db, refund_id)
    if refund.requires_approval and refund.approved_by is None and not has_access(admin, "refunds-large"):
        raise AuthorizationError("This refund is waiting for approval.", error_code="PERMISSION_DENIED")
    _audit(db, "refund.retried", refund, f"Refund {refund.refund_number} retried", status=refund.status)
    db.commit()
    if refund.status == "failed":
        try:
            return ledger.set_refund_status(db, refund.id, "completed")
        except ConflictError as error:
            if error.error_code != "PROVIDER_REFUSED":
                raise
            return ledger.get_refund(db, refund.id)
    if refund.status == "processing":
        return ledger.check_refund(db, refund.id)
    raise ConflictError("Only a failed or processing refund can be retried.", error_code="INVALID_TRANSITION")


# ------------------------------------------------------------------ views


def admin_view(refund: Refund) -> dict:
    share = ledger.payment_share(refund)
    return {
        "id": refund.id, "refundNumber": refund.refund_number, "orderId": refund.order_id,
        "orderNumber": refund.order_number, "invoiceId": refund.invoice_id, "invoiceNumber": refund.invoice_number,
        "paymentId": refund.payment_id, "customerId": refund.customer_id, "customerName": refund.customer_name,
        "amount": refund.amount, "paymentAmount": share, "tenderAmount": refund.tender_amount or 0,
        "shippingAmount": refund.shipping_amount or 0, "taxAmount": refund.tax_amount or 0,
        "discountAmount": refund.discount_amount or 0,
        "method": refund.method, "methodLabel": METHOD_LABELS.get(refund.method, refund.method),
        "reasonCode": refund.reason_code, "reasonLabel": REASON_LABELS.get(refund.reason_code, "Other"),
        "reason": refund.reason, "internalNote": refund.internal_note,
        "status": refund.status, "statusLabel": STATUS_LABELS.get(refund.status, refund.status),
        "requiresApproval": bool(refund.requires_approval), "approvedBy": refund.approved_by,
        "approvedAt": refund.approved_at, "initiatedBy": refund.initiated_by,
        "gatewayReference": refund.gateway_reference, "manualReference": refund.manual_reference,
        "failureReason": refund.failure_reason, "attempts": refund.attempts or 0,
        "lastAttemptAt": refund.last_attempt_at, "nextCheckAt": refund.next_check_at,
        "creditNoteId": refund.credit_note_id,
        "requestedAt": refund.requested_at, "processedAt": refund.processed_at,
        "canApprove": refund.status == "requested", "canRetry": refund.status in ("failed", "processing"),
        "canCancel": refund.status in ("requested", "failed"),
        "items": [
            {"orderItemId": i.order_item_id, "invoiceItemId": i.invoice_item_id, "productId": i.product_id,
             "name": i.name, "quantity": i.quantity, "amount": i.amount, "discount": i.discount or 0,
             "taxable": i.taxable_amount or 0, "taxRatePercent": float(i.tax_rate_percent or 0),
             "cgst": i.cgst or 0, "sgst": i.sgst or 0, "igst": i.igst or 0, "tax": i.tax or 0}
            for i in refund.items
        ],
    }


# What a customer sees of a status. A failed gateway attempt is the store's to
# retry, so to the customer it is still in progress; a withdrawn one is gone.
CUSTOMER_STATUS = {"requested": "requested", "processing": "processing", "failed": "processing",
                   "completed": "completed"}
CUSTOMER_STATUS_LABELS = {"requested": "Requested", "processing": "In progress", "completed": "Refunded"}


def customer_view(refund: Refund) -> dict:
    """Nothing internal: no notes, no gateway references, no failure reasons, no staff."""
    status = CUSTOMER_STATUS.get(refund.status, "processing")
    share = ledger.payment_share(refund)
    destinations = []
    if share:
        destinations.append({"kind": refund.method, "amount": share,
                             "label": "Store credit" if refund.method == "store-credit" else "Original payment method"})
    if refund.tender_amount:
        destinations.append({"kind": "tenders", "amount": refund.tender_amount,
                             "label": "Gift card, store credit or points used on the order"})
    return {
        "refundNumber": refund.refund_number, "orderNumber": refund.order_number, "amount": refund.amount,
        "method": refund.method, "methodLabel": METHOD_LABELS.get(refund.method, "Original payment method"),
        "destinations": destinations,
        "reason": REASON_LABELS.get(refund.reason_code, "Other"),
        "status": status, "statusLabel": CUSTOMER_STATUS_LABELS[status],
        "requestedAt": refund.requested_at, "completedAt": refund.processed_at if refund.status == "completed" else None,
        "shippingAmount": refund.shipping_amount or 0,
        "items": [{"name": i.name, "quantity": i.quantity, "amount": i.amount} for i in refund.items],
    }


def for_customer(db: Session, customer: Customer, *, order: Optional[str] = None) -> List[dict]:
    query = select(Refund).where(Refund.customer_id == customer.id,
                                 Refund.status.in_(tuple(CUSTOMER_STATUS))).order_by(Refund.requested_at.desc())
    if order:
        found = db.execute(select(Order).where(Order.customer_id == customer.id,
                                               (Order.id == order) | (Order.order_number == order))
                           ).scalar_one_or_none()
        # Someone else's order reads as one with no refunds — and as not found
        # on the per-order route, which checks it first.
        if found is None:
            return []
        query = query.where(Refund.order_id == found.id)
    return [customer_view(r) for r in db.execute(query.limit(200)).scalars()]


def customer_order(db: Session, customer: Customer, identifier: str) -> Order:
    found = db.execute(select(Order).where(Order.customer_id == customer.id,
                                           (Order.id == identifier) | (Order.order_number == identifier))
                       ).scalar_one_or_none()
    if found is None:
        raise NotFoundError("We couldn't find that order.", error_code="ORDER_NOT_FOUND")
    return found


def search(db: Session, *, status: str = "", method: str = "", reason_code: str = "", q: str = "",
           order_id: str = "", awaiting_approval: bool = False, page: int = 1, page_size: int = 25) -> tuple:
    query = select(Refund)
    if status and status != "all":
        query = query.where(Refund.status == ledger.normalise_refund_status(status))
    if method:
        query = query.where(Refund.method == method)
    if reason_code:
        query = query.where(Refund.reason_code == reason_code)
    if order_id:
        query = query.where(Refund.order_id == order_id)
    if awaiting_approval:
        query = query.where(Refund.status == "requested", Refund.requires_approval.is_(True))
    for word in (q or "").split():
        pattern = f"%{word}%"
        query = query.where(Refund.refund_number.like(pattern) | Refund.order_number.like(pattern)
                            | Refund.customer_name.like(pattern) | Refund.invoice_number.like(pattern))
    total = db.execute(select(func.count()).select_from(query.subquery())).scalar_one()
    rows = db.execute(query.order_by(Refund.requested_at.desc(), Refund.id.desc())
                      .offset((max(1, page) - 1) * page_size).limit(page_size)).scalars().all()
    return rows, total


def summary(db: Session) -> dict:
    """Headline numbers for the admin dashboard."""
    counts = dict(db.execute(select(Refund.status, func.count()).group_by(Refund.status)).all())
    awaiting = db.execute(select(func.count()).select_from(Refund).where(
        Refund.status == "requested", Refund.requires_approval.is_(True))).scalar_one()
    start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    today = db.execute(select(func.coalesce(func.sum(Refund.amount), 0), func.count()).where(
        Refund.status == "completed", Refund.processed_at >= start)).one()
    return {
        "requested": int(counts.get("requested", 0)), "awaitingApproval": int(awaiting),
        "processing": int(counts.get("processing", 0)), "failed": int(counts.get("failed", 0)),
        "refundedToday": int(today[0]), "refundedTodayCount": int(today[1]),
    }


# -------------------------------------------------------------------- job

INTERVAL_SECONDS = 300
BATCH = 50


def sweep(db: Session) -> dict:
    """
    One pass of the `refunds` job: every processing refund that is due a look.

    Never confirmed by the gateway (a timeout): looked up by its number and
    sent only if the gateway has none — at most `maxAttempts` sends, after
    which it is left for a person with an alert. Accepted: asked for its
    state, which completes or fails it.
    """
    conf = settings(db)
    now = datetime.utcnow()
    stale = now - timedelta(minutes=int(conf["pollMinutes"]))
    ids = list(db.execute(
        select(Refund.id).where(
            Refund.status == "processing",
            ((Refund.next_check_at.is_not(None)) & (Refund.next_check_at <= now))
            | ((Refund.next_check_at.is_(None)) & (Refund.requested_at <= stale)))
        .order_by(Refund.requested_at).limit(BATCH)
    ).scalars())
    out = {"checked": 0, "completed": 0, "failed": 0, "gaveUp": 0}
    for refund_id in ids:
        try:
            refund = ledger.get_refund(db, refund_id)
            if not refund.gateway_settled and (refund.attempts or 0) >= int(conf["maxAttempts"]):
                found = _look_up_once(db, refund)
                if not found:
                    refund.next_check_at = None
                    refund.failure_reason = "The gateway never confirmed this refund; check it at the gateway."
                    from app.services import inbox

                    inbox.staff(db, "refund", f"Refund {refund.refund_number} needs attention",
                                refund.failure_reason, "/admin/billing/refunds?status=processing",
                                permission="refunds")
                    db.commit()
                    out["gaveUp"] += 1
                    continue
            after = ledger.check_refund(db, refund_id)
            out["checked"] += 1
            if after.status in ("completed", "failed"):
                out[after.status] += 1
        except ConflictError as error:
            if error.error_code == "PROVIDER_REFUSED":
                out["failed"] += 1
            else:
                db.rollback()
                logger.warning("Refund %s: %s", refund_id, error)
        except Exception:  # noqa: BLE001 — one refund must not stop the pass
            db.rollback()
            logger.exception("Checking refund %s failed", refund_id)
    return out


def _look_up_once(db: Session, refund: Refund) -> bool:
    """Out of sends: one last look at the gateway. True when it has the refund (adopted)."""
    from app.services.invoices import get_provider

    payment = db.get(Payment, refund.payment_id)
    provider = get_provider()
    finder = getattr(provider, "find_refund", None)
    if payment is None or finder is None:
        return False
    try:
        found = finder(payment.transaction_id, refund.refund_number)
    except Exception:  # noqa: BLE001
        return False
    return found is not None and found.status != "rejected"


def _sweep_once() -> None:
    from app.core.database import SessionLocal

    with SessionLocal() as db:
        try:
            sweep(db)
        except Exception:
            db.rollback()
            raise


async def run_forever() -> None:
    import asyncio

    from app.services import jobs

    logger.info("Refunds checked every %ss.", INTERVAL_SECONDS)
    while True:
        try:
            await asyncio.to_thread(jobs.tracked("refunds", INTERVAL_SECONDS, _sweep_once))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Refunds sweep failed; retrying next interval.")
        await asyncio.sleep(INTERVAL_SECONDS)
