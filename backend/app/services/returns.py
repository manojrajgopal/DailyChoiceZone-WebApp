"""
Returns and replacements.

After an order is delivered, the customer may send items back within
the store's return window (Store settings → Returns):

- **return** — for a refund. Only items bought as returnable.
- **replacement** — for the same item again. Only items bought as replaceable.

Which items qualify is read from the order line (`OrderItem.is_returnable`,
`is_replaceable`), copied from the product at checkout — the promise made when
the customer paid, not today's setting.

    return:       requested → approved → picked-up → received → refunded
    replacement:  requested → approved → picked-up → received
                                          → replacement-shipped → completed

`approved` may go straight to `received` for a parcel the customer sends
themselves. Before pickup a request can be `rejected` (by the store) or
`cancelled` (by either side). Receiving a return restocks it; refunding sends
the money back through the order's own payment; shipping a replacement takes
the units from stock.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Iterable, List, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import (
    Customer,
    Invoice,
    Order,
    OrderItem,
    Product,
    ReturnEvent,
    ReturnRequest,
    ReturnRequestItem,
    StockAdjustment,
)
from app.services import billing
from app.utils.ids import next_id

logger = logging.getLogger(__name__)

KINDS = ("return", "replacement")

REASONS = {
    "return": (
        "Size or fit isn't right",
        "Not as described or pictured",
        "Quality not as expected",
        "Received the wrong item",
        "Arrived damaged or defective",
        "Changed my mind",
    ),
    "replacement": (
        "Arrived damaged or defective",
        "Received the wrong item",
        "Wrong size delivered",
        "Missing parts or accessories",
        "Quality issue",
    ),
}

FLOW = {
    "return": {
        "requested": ("approved", "rejected", "cancelled"),
        "approved": ("picked-up", "received", "cancelled"),
        "picked-up": ("received",),
        "received": ("refunded",),
    },
    "replacement": {
        "requested": ("approved", "rejected", "cancelled"),
        "approved": ("picked-up", "received", "cancelled"),
        "picked-up": ("received",),
        "received": ("replacement-shipped",),
        "replacement-shipped": ("completed",),
    },
}

# A request in any of these no longer holds its items.
CLOSED_WITHOUT_EFFECT = {"rejected", "cancelled"}
FINISHED = {"rejected", "cancelled", "refunded", "completed"}


# ------------------------------------------------------------- eligibility


def window_days(db: Session) -> int:
    """
    The return window, from the store's own settings — the same number the
    product page quotes — falling back to `RETURN_WINDOW_DAYS`.
    """
    try:
        days = int(billing.store_settings(db).get("returns", {}).get("windowDays") or 0)
    except (TypeError, ValueError):
        days = 0
    return days if days > 0 else settings.RETURN_WINDOW_DAYS


def _member_extra_days(db: Session, order: Order) -> int:
    """Extra return days the membership the order was placed under carries."""
    if not getattr(order, "membership_id", None):
        return 0
    from app.models import CustomerMembership

    membership = db.get(CustomerMembership, order.membership_id)
    try:
        return int(((membership.benefits or {}) if membership else {}).get("extraReturnDays") or 0)
    except (TypeError, ValueError):
        return 0


def delivered_at(order: Order) -> Optional[datetime]:
    """When the order was delivered — the latest `delivered` event."""
    times = [event.occurred_at for event in order.events if event.status == "delivered"]
    return max(times) if times else None


def window_ends(order: Order, days: int) -> Optional[datetime]:
    at = delivered_at(order)
    return at + timedelta(days=days) if at else None


def _claimed(db: Session, order: Order) -> dict:
    """Units of each order line already in a live or finished request."""
    rows = db.execute(
        select(ReturnRequestItem.order_item_id, ReturnRequestItem.quantity)
        .join(ReturnRequest, ReturnRequest.id == ReturnRequestItem.request_id)
        .where(
            ReturnRequest.order_id == order.id,
            ReturnRequest.status.notin_(CLOSED_WITHOUT_EFFECT),
        )
    ).all()
    claimed: dict = {}
    for item_id, quantity in rows:
        claimed[item_id] = claimed.get(item_id, 0) + quantity
    return claimed


def _unit_amounts(db: Session, order: Order) -> dict:
    """
    What one unit of each order line was actually paid for, in minor units —
    from the invoice, so coupon savings are shared out exactly as they were
    when the customer paid.
    """
    invoice = db.execute(select(Invoice).where(Invoice.order_id == order.id)).scalar_one_or_none()
    by_variant = {}
    for line in invoice.items if invoice else []:
        key = (line.product_id, line.size or None, line.color or None)
        if line.quantity:
            by_variant[key] = line.line_total // line.quantity
    amounts = {}
    for item in order.items:
        key = (item.product_id, item.size or None, item.color or None)
        amounts[item.id] = by_variant.get(
            key, billing.to_minor(float(item.line_total)) // max(item.quantity, 1)
        )
    return amounts


def _amount_for(db: Session, order: Order, line: OrderItem, before: int, quantity: int, fallback_unit: int) -> int:
    """
    What `quantity` units of a line cost, after the units already claimed —
    their exact cumulative share of the invoice line (see
    `services/refunds.share_of_units`), so two returns of one line add up to
    the line to the paisa. The old `line_total // qty` lost the remainder.
    """
    from app.services import refunds

    invoice = db.execute(select(Invoice).where(Invoice.order_id == order.id)).scalar_one_or_none()
    if invoice is not None:
        for item, invoice_line in refunds._pairs(order, invoice):
            if item.id == line.id and invoice_line is not None:
                return refunds.share_of_units(invoice_line, before, quantity)["amount"]
    return fallback_unit * quantity


def eligibility(db: Session, order: Order, now: Optional[datetime] = None) -> dict:
    """
    What can be sent back from this order, and why not when nothing can.

    `reason` is written for the customer and is empty when something qualifies.
    """
    now = now or datetime.utcnow()
    days = window_days(db) + _member_extra_days(db, order)
    ends = window_ends(order, days)
    claimed = _claimed(db, order)

    if order.status != "delivered":
        reason = "Returns and replacements open once your order has been delivered."
    elif ends is None or now > ends:
        reason = (
            f"The {days}-day return and replacement window "
            "for this order has closed."
        )
    else:
        reason = ""

    items = []
    for item in order.items:
        remaining = max(item.quantity - claimed.get(item.id, 0), 0)
        open_ = not reason and remaining > 0
        items.append(
            {
                "orderItemId": item.id,
                "productId": item.product_id,
                "name": item.name,
                "image": item.image,
                "size": item.size,
                "color": item.color,
                "quantity": item.quantity,
                "available": remaining,
                "returnable": open_ and item.is_returnable,
                "replaceable": open_ and item.is_replaceable,
                "isReturnable": item.is_returnable,
                "isReplaceable": item.is_replaceable,
            }
        )

    if not reason and not any(entry["returnable"] or entry["replaceable"] for entry in items):
        reason = (
            "Everything in this order has already been sent back, or its items "
            "can't be returned or replaced."
        )

    return {
        "eligible": not reason,
        "reason": reason,
        "windowDays": days,
        "windowEndsAt": ends,
        "reasons": {kind: list(options) for kind, options in REASONS.items()},
        "items": items,
    }


# ----------------------------------------------------------------- reading


def _query():
    return select(ReturnRequest).order_by(ReturnRequest.created_at.desc())


def list_for_order(db: Session, order: Order) -> List[ReturnRequest]:
    return list(db.execute(_query().where(ReturnRequest.order_id == order.id)).scalars())


def list_for_customer(db: Session, customer: Customer) -> List[ReturnRequest]:
    return list(db.execute(_query().where(ReturnRequest.customer_id == customer.id)).scalars())


def list_all(
    db: Session,
    *,
    status: Optional[str] = None,
    kind: Optional[str] = None,
    q: Optional[str] = None,
    customer: Optional[str] = None,
) -> List[ReturnRequest]:
    """
    `q` is a Return ID or the order's number/ID and `customer` a Customer ID,
    each matched exactly (docs/id-lookup.md) — never a name or an email.
    """
    from app.services.lookup.filters import any_id_condition, id_condition

    query = _query()
    by_id = any_id_condition(q, ("return", None, None), ("order", ReturnRequest.order_id, Order.id))
    if by_id is not None:
        query = query.where(by_id)
    by_customer = id_condition("customer", customer, column=ReturnRequest.customer_id, via=Customer.id)
    if by_customer is not None:
        query = query.where(by_customer)
    if status:
        query = query.where(ReturnRequest.status == status)
    if kind:
        query = query.where(ReturnRequest.kind == kind)
    return list(db.execute(query.limit(500)).scalars())


def get(db: Session, request_id: str, *, customer_id: Optional[str] = None) -> ReturnRequest:
    request = db.get(ReturnRequest, request_id)
    # "Not yours" looks exactly like "does not exist".
    if request is None or (customer_id and request.customer_id != customer_id):
        raise NotFoundError("We couldn't find that request.", error_code="RETURN_NOT_FOUND")
    return request


def next_steps(request: ReturnRequest) -> tuple:
    return FLOW.get(request.kind, {}).get(request.status, ())


# ---------------------------------------------------------------- creating


def create(
    db: Session,
    customer: Customer,
    order: Order,
    *,
    kind: str,
    reason: str,
    comment: str,
    items: Iterable[dict],
) -> ReturnRequest:
    if order.customer_id != customer.id:
        raise NotFoundError("We couldn't find that order.", error_code="ORDER_NOT_FOUND")
    if kind not in KINDS:
        raise ValidationError("Choose a return or a replacement.", error_code="INVALID_KIND")
    if reason not in REASONS[kind]:
        raise ValidationError("Please choose a reason from the list.", error_code="INVALID_REASON")

    # Lock the order so two requests sent at once cannot claim the same units.
    db.execute(select(Order).where(Order.id == order.id).with_for_update())
    status = eligibility(db, order)
    if not status["eligible"]:
        raise ConflictError(status["reason"], error_code="RETURN_NOT_ALLOWED")

    by_id = {entry["orderItemId"]: entry for entry in status["items"]}
    lines = {item.id: item for item in order.items}
    amounts = _unit_amounts(db, order)
    claimed = _claimed(db, order)
    flag = "returnable" if kind == "return" else "replaceable"

    chosen = []
    seen = set()
    for entry in items:
        item_id, quantity = int(entry["orderItemId"]), int(entry["quantity"])
        if item_id in seen:
            raise ValidationError("Each item can be listed once.", error_code="DUPLICATE_ITEM")
        seen.add(item_id)
        info = by_id.get(item_id)
        if info is None:
            raise ValidationError("That item isn't part of this order.", error_code="ITEM_NOT_IN_ORDER")
        if not info[flag]:
            raise ConflictError(
                f"{info['name']} can't be {'returned' if kind == 'return' else 'replaced'}.",
                error_code="ITEM_NOT_ELIGIBLE",
            )
        if quantity < 1 or quantity > info["available"]:
            raise ValidationError(
                f"Choose between 1 and {info['available']} of {info['name']}.",
                error_code="INVALID_QUANTITY",
            )
        chosen.append((lines[item_id], quantity))

    if not chosen:
        raise ValidationError("Choose at least one item.", error_code="NO_ITEMS")

    now = datetime.utcnow()
    request = ReturnRequest(
        id=next_id(db, ReturnRequest, "return_request"),
        order_id=order.id,
        customer_id=customer.id,
        order_number=order.order_number,
        customer_name=order.customer_name,
        kind=kind,
        status="requested",
        reason=reason,
        comment=(comment or "").strip()[:1000],
        created_at=now,
        updated_at=now,
    )
    for line, quantity in chosen:
        request.items.append(
            ReturnRequestItem(
                order_item_id=line.id,
                product_id=line.product_id,
                name=line.name,
                image=line.image,
                size=line.size,
                color=line.color,
                quantity=quantity,
                amount=_amount_for(db, order, line, claimed.get(line.id, 0), quantity,
                                   amounts.get(line.id, 0)),
            )
        )
    request.amount = sum(entry.amount for entry in request.items)
    request.events.append(
        ReturnEvent(status="requested", note=reason, actor="customer", occurred_at=now)
    )
    db.add(request)

    from app.services.email.notifications import notify_return

    notify_return(db, request, order.customer_email)
    from app.services import inbox

    inbox.staff(db, "return", f"New {kind} request on {order.order_number}",
                f"{order.customer_name}: {reason}", f"/admin/returns/detail?id={request.id}", permission="orders")
    db.commit()
    db.refresh(request)
    return request


# ---------------------------------------------------------------- moving


def cancel_by_customer(db: Session, customer: Customer, request_id: str) -> ReturnRequest:
    request = get(db, request_id, customer_id=customer.id)
    if request.status != "requested":
        raise ConflictError(
            "This request is already being processed and can no longer be cancelled.",
            error_code="RETURN_NOT_CANCELLABLE",
        )
    return _move(db, request, "cancelled", note="Cancelled by you.", actor="customer")


def update_status(
    db: Session, request_id: str, status: str, *, note: str = "", actor: str = "system",
    refund_method: Optional[str] = None,
) -> ReturnRequest:
    request = get(db, request_id)
    if status not in next_steps(request):
        raise ConflictError(
            f"A request that is {request.status.replace('-', ' ')} can't move to "
            f"{status.replace('-', ' ')}.",
            error_code="INVALID_TRANSITION",
        )
    return _move(db, request, status, note=note, actor=actor, refund_method=refund_method)


def _move(db: Session, request: ReturnRequest, status: str, *, note: str, actor: str,
          refund_method: Optional[str] = None) -> ReturnRequest:
    now = datetime.utcnow()

    if status == "received" and request.kind == "return":
        _restock(db, request, now, actor)
    if status == "replacement-shipped":
        _ship_replacement(db, request, now, actor)
    if status == "refunded":
        _refund(db, request, actor, method=refund_method)

    request.status = status
    request.updated_at = now
    if note.strip() and status in ("rejected", "approved", "picked-up"):
        request.resolution_note = note.strip()[:500]
    request.events.append(
        ReturnEvent(status=status, note=note.strip()[:500], actor=actor, occurred_at=now)
    )
    from app.services.email.notifications import notify_return

    order = db.get(Order, request.order_id)
    if order is not None:
        notify_return(db, request, order.customer_email)
    db.commit()

    # Returned units back on the shelf: anyone waiting for them hears now.
    if status == "received" and request.kind == "return":
        from app.services import alerts

        for product_id in {item.product_id for item in request.items}:
            alerts.process_product(db, product_id)
    db.refresh(request)
    return request


def _adjust(db: Session, product: Product, delta: int, reason: str, note: str, actor: str, now: datetime) -> None:
    before = product.stock
    product.stock = before + delta
    if product.status == "out-of-stock" and product.stock > 0:
        product.status = "active"
    db.add(
        StockAdjustment(
            product_id=product.id,
            reason=reason,
            quantity_before=before,
            quantity_after=product.stock,
            delta=delta,
            note=note,
            actor=actor[:40],
            created_at=now,
        )
    )


def _restock(db: Session, request: ReturnRequest, now: datetime, actor: str) -> None:
    for item in request.items:
        product = db.get(Product, item.product_id, with_for_update=True)
        if product is not None:
            _adjust(db, product, item.quantity, "return", f"Returned ({request.id})", actor, now)


def _ship_replacement(db: Session, request: ReturnRequest, now: datetime, actor: str) -> None:
    for item in sorted(request.items, key=lambda entry: entry.product_id):
        product = db.get(Product, item.product_id, with_for_update=True)
        if product is None or product.available_stock < item.quantity:
            raise ConflictError(
                f"Not enough stock to send a replacement {item.name}.",
                error_code="INSUFFICIENT_STOCK",
            )
        _adjust(db, product, -item.quantity, "sale", f"Replacement sent ({request.id})", actor, now)


def _refund(db: Session, request: ReturnRequest, actor: str, *, method: Optional[str] = None) -> None:
    """
    Pay back exactly the returned units, through the same calculation and
    refund system as the portal's wizard (docs/refunds.md): their share of
    the line, discount and tax, within what is left on the order.

    Recorded first, then sent — so a gateway that refuses leaves the refund on
    record to retry, and a retry never raises a second one:

    - already completed, or processing (on its way at the gateway): the
      return is refunded; nothing is sent again;
    - requested or failed: that same refund is sent (again);
    - waiting for approval: the return stays received until it is approved.
    """
    from app.models import Refund
    from app.services import invoices as invoice_service
    from app.services import refunds

    existing = db.get(Refund, request.refund_id) if request.refund_id else None
    if existing is not None and existing.status in ("completed", "processing"):
        return
    if existing is None or existing.status in ("cancelled", "rejected"):
        conf = refunds.settings(db)
        refund = refunds.create_for_order(
            db, request.order_id, actor=None,
            idempotency_key=f"return:{request.id}:{existing.id if existing is not None else 'first'}",
            lines=[{"orderItemId": item.order_item_id, "quantity": item.quantity} for item in request.items],
            method=method or conf["returnsMethod"], reason_code="return-approved",
            reason=f"Return {request.id}: {request.reason}"[:200], process_now=False,
            initiated_by=(actor or "admin")[:40], skip_approval=bool(conf["returnsSkipApproval"]), clamp=True,
        )
        request.refund_id = refund.id
        db.commit()
        existing = refund
    if existing.requires_approval and existing.approved_by is None:
        raise ConflictError("This return's refund is waiting for approval by an admin with 'refunds-large'.",
                            error_code="REFUND_AWAITING_APPROVAL")
    invoice_service.set_refund_status(db, existing.id, "completed")
