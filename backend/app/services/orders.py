"""Placing and managing orders.

Checkout is **one transaction**. Order, lines, stock, payment, invoice and
coupon usage all succeed together or none of them do — a half-written checkout
leaves an order nobody was charged for, or stock consumed by an order that does
not exist.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import List, Optional, Tuple

from sqlalchemy import Integer, func, select
from sqlalchemy.orm import Session, selectinload

from app.core.config import settings
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import (
    Customer,
    Invoice,
    InvoiceItem,
    Order,
    OrderEvent,
    OrderItem,
    Payment,
    PaymentEvent,
    Product,
)
from app.models.catalogue import images_for
from app.services import billing, coupons as coupon_service, products as product_service
from app.services.payments import PaymentRequest, get_provider
from app.utils.ids import next_id

# The fulfilment pipeline, in order. An order moves one stage at a time;
# jumping ahead or stepping back is allowed only when the caller confirms it
# (`confirm=True`), and is written into the timeline note so the record says
# so. `shipped` is the stage where the parcel is dispatched to the courier.
ORDER_FLOW = (
    "pending",
    "confirmed",
    "processing",
    "packed",
    "shipped",
    "in-transit",
    "out-for-delivery",
    "delivered",
)

STAGE_LABELS = {
    "pending": "Pending",
    "confirmed": "Confirmed",
    "processing": "Processing",
    "packed": "Packed",
    "shipped": "Shipped",
    "in-transit": "In transit",
    "out-for-delivery": "Out for delivery",
    "delivered": "Delivered",
    "cancelled": "Cancelled",
    "returned": "Returned",
}

ORDER_STATUSES = set(ORDER_FLOW) | {"cancelled", "returned"}

# Once it has left the warehouse, cancelling is a return, not a cancellation.
CANCELLABLE_FROM = {"pending", "confirmed", "processing", "packed"}
RETURNABLE_FROM = {"shipped", "in-transit", "out-for-delivery", "delivered"}
TERMINAL = {"cancelled", "returned"}

logger = logging.getLogger(__name__)

CUSTOMER_CANCELLABLE = CANCELLABLE_FROM


def classify_transition(order: Order, target: str) -> str:
    """
    What moving `order` to `target` would be: "same", "next", "skip", "back",
    "cancel" or "return". Raises `ConflictError` for a move that is never
    allowed, confirmed or not.

    Never allowed:
    - leaving `cancelled` or `returned` — they are records, not stages;
    - cancelling once dispatched (that is a return) or returning before it;
    - going back to `pending` — only a payment moves an order out of it, and
      only a payment could move it back;
    - going back from `delivered` — the delivery (and, for cash on delivery,
      the collection) has been recorded; the way back is a return;
    - moving a checkout order forward while its stock is only held for a
      payment that has not arrived. The payment confirms it, or the hold lapses.
    """
    current = order.status
    if target not in ORDER_STATUSES:
        raise ValidationError(f"'{target}' is not an order status.", error_code="INVALID_STATUS")
    if target == current:
        return "same"
    if current in TERMINAL:
        raise ConflictError(
            f"This order is {current}; its status can no longer change.",
            error_code="INVALID_TRANSITION",
        )
    if target == "cancelled":
        if current not in CANCELLABLE_FROM:
            raise ConflictError(
                "This order has left the warehouse and cannot be cancelled. Record a return instead.",
                error_code="INVALID_TRANSITION",
            )
        return "cancel"
    if target == "returned":
        if current not in RETURNABLE_FROM:
            raise ConflictError(
                "Only an order that has been shipped can be returned. Cancel it instead.",
                error_code="INVALID_TRANSITION",
            )
        return "return"

    here, there = ORDER_FLOW.index(current), ORDER_FLOW.index(target)
    if there > here:
        if current == "pending" and order.stock_state == "reserved" and order.payment_status != "paid":
            raise ConflictError(
                "This order is waiting for its payment. It is confirmed when the payment arrives.",
                error_code="AWAITING_PAYMENT",
            )
        return "next" if there == here + 1 else "skip"

    if target == "pending":
        raise ConflictError(
            "An order cannot be moved back to pending.", error_code="INVALID_TRANSITION"
        )
    if current == "delivered":
        raise ConflictError(
            "A delivered order cannot be moved back. Record a return instead.",
            error_code="INVALID_TRANSITION",
        )
    return "back"


def transition_note(order: Order, target: str, kind: str) -> str:
    """What the timeline should say about an out-of-sequence move."""
    if kind == "skip":
        here, there = ORDER_FLOW.index(order.status), ORDER_FLOW.index(target)
        skipped = ", ".join(STAGE_LABELS[s] for s in ORDER_FLOW[here + 1 : there])
        return f"Skipped {skipped}."
    if kind == "back":
        return f"Moved back from {STAGE_LABELS[order.status]}."
    return ""


# The delivery methods the shipping calculation understands. Anything else
# used to fall through to the standard fee — harmless for the price, but it
# recorded a delivery method the warehouse had never heard of.
DELIVERY_METHODS = {"standard", "express"}

# The payment methods this system knows how to take. The store's own settings
# choose which of these are offered; this is the outer bound on what they can
# name.
KNOWN_PAYMENT_METHODS = {"upi", "card", "debit-card", "netbanking", "wallet", "cod"}


def _require_payment_method(config: dict, method: str) -> None:
    """
    The method must be one the store has switched on.

    This is the check whose absence let a client choose cash on delivery on a
    store that does not offer it — an order confirmed with nothing paid and
    nothing to be collected. An unconfigured store offers everything known,
    which is the only sensible default for a fresh installation.
    """
    if method not in KNOWN_PAYMENT_METHODS:
        raise ValidationError("That payment method is not recognised.", error_code="PAYMENT_METHOD_INVALID")

    enabled = set(((config or {}).get("payment") or {}).get("enabledMethods") or [])
    # "card" and "debit-card" are one rail at the gateway; either switches both.
    if method in {"card", "debit-card"} and enabled & {"card", "debit-card"}:
        return
    if enabled and method not in enabled:
        raise ValidationError(
            "That payment method is not available for this store.",
            error_code="PAYMENT_METHOD_UNAVAILABLE",
        )


def _require_delivery_method(method: str) -> None:
    if method not in DELIVERY_METHODS:
        raise ValidationError("That delivery method is not available.", error_code="DELIVERY_METHOD_INVALID")


def _settles_later(provider, method: str) -> bool:
    """
    Will this payment arrive after the order is placed?

    True for any prepaid method through a real gateway: the shopper has not
    been shown a payment screen yet. Such an order *holds* its stock rather
    than taking it, and has a window in which to be paid.

    False for cash on delivery — confirmed now, collected later by the courier
    — and for a provider that settles synchronously, which is only the mock.
    """
    if method == "cod":
        return False
    return getattr(provider, "name", "") != "mock"


def _refuse_if_hoarding(db: Session, customer: Customer, now: datetime) -> None:
    """
    Cap how much stock one account can hold without paying.

    A hold costs nothing to create. Without a limit an account could place
    order after order and never pay, keeping a product sold out for every other
    shopper five minutes at a time. The cap counts only holds that are still
    live; an expired one is the sweeper's to cancel and does not count against
    anybody.
    """
    open_holds = db.execute(
        select(func.count())
        .select_from(Order)
        .where(
            Order.customer_id == customer.id,
            Order.stock_state == "reserved",
            Order.status == "pending",
            Order.payment_expires_at > now,
        )
    ).scalar_one()

    if open_holds >= settings.MAX_UNPAID_ORDERS_PER_CUSTOMER:
        raise ConflictError(
            "You have unpaid orders waiting. Please pay for or cancel one of them first.",
            error_code="TOO_MANY_UNPAID_ORDERS",
        )


def _generate_order_number(db: Session, config: dict) -> str:
    """
    The reference a customer quotes on a support call.

    Its prefix and starting point are the store's — configured in the billing
    document, not written in here, so a shop can use its own numbering without
    editing code.
    """
    order_cfg = config.get("order") or {}
    prefix = str(order_cfg.get("prefix") or "")
    start = int(order_cfg.get("startNumber") or 1)

    # The highest so far, read numerically.
    #
    # `max()` on the column is a *string* max, which orders "DCZ9" above
    # "DCZ10" — and, with no prefix configured, put a number that does not
    # parse at the top and sent this back to `start` on every order. Every
    # order after the first then asked for a number that already existed and
    # the unique index refused it.
    suffix = func.substr(Order.order_number, len(prefix) + 1)
    # Locking read — see `next_id`. A plain read would come from this
    # transaction's snapshot and miss an order committed a moment ago.
    highest = db.execute(
        select(func.max(func.cast(suffix, Integer)))
        .where(
            Order.order_number.like(f"{prefix}%"),
            suffix.regexp_match("^[0-9]+$"),
        )
        .with_for_update()
    ).scalar()

    number = max(start, int(highest) + 1 if highest else start)

    # Belt and braces: a gap in the series is fine, a collision is a failed
    # checkout. Nothing here should loop more than once.
    while db.execute(
        select(Order.id).where(Order.order_number == f"{prefix}{number}").with_for_update()
    ).scalar_one_or_none():
        number += 1

    return f"{prefix}{number}"


def _next_invoice_number(db: Session, config: dict, issued: datetime) -> str:
    """
    Sequential, and issued here rather than by any caller.

    **This is why invoice numbering belongs on a server.** A browser cannot
    guarantee a gapless sequence — two devices would mint the same number,
    because neither can see the other. One writer, one counter.
    """
    invoice_cfg = config.get("invoice") or {}
    prefix = str(invoice_cfg.get("prefix") or "")
    padding = int(invoice_cfg.get("padding") or 1)

    # Locking read, for the same reason as the order number. Invoice numbers
    # must also be gapless and unique — a tax requirement, not a preference.
    highest = db.execute(
        select(func.max(Invoice.invoice_number))
        .where(Invoice.invoice_number.like(f"{prefix}-%"))
        .with_for_update()
    ).scalar()

    number = int(invoice_cfg.get("startNumber") or 1)
    if highest:
        try:
            number = int(highest.split("-")[-1]) + 1
        except ValueError:
            pass

    return f"{prefix}-{issued.year}-{number:0{padding}d}"


# ---------------------------------------------------------------- reading


def _with_relations(statement):
    return statement.options(selectinload(Order.items), selectinload(Order.events))


def list_orders(db: Session, *, customer_id: Optional[str] = None) -> List[Order]:
    statement = _with_relations(select(Order)).order_by(Order.placed_at.desc())
    if customer_id:
        statement = statement.where(Order.customer_id == customer_id)
    return list(db.execute(statement).unique().scalars().all())


def get_order(db: Session, identifier: str, *, customer_id: Optional[str] = None) -> Order:
    """
    Fetch by id or order number.

    Both are business identifiers: the portal navigates by `ORD001`, a customer
    quotes `DCZ10241` from their email.
    """
    statement = _with_relations(select(Order)).where(
        (Order.id == identifier) | (Order.order_number == identifier)
    )
    order = db.execute(statement).unique().scalar_one_or_none()

    # Ownership is checked here, not in the route — and a mismatch reads as
    # "not found", because "that exists but is not yours" is itself a fact
    # worth not disclosing.
    if order is None or (customer_id and order.customer_id != customer_id):
        raise NotFoundError(f"No order '{identifier}'.", error_code="ORDER_NOT_FOUND")

    return order


# ---------------------------------------------------------------- placing


def place_order(
    db: Session,
    customer: Customer,
    *,
    shipping_address: dict,
    billing_address: Optional[dict],
    delivery_method: str,
    payment_method: str,
    coupon_code: Optional[str] = None,
    email: Optional[str] = None,
) -> Tuple[Order, Invoice, Payment]:
    """
    Turn a cart into an order, an invoice and a payment.

        cart → price it → order → stock → payment → invoice → empty the cart

    Every total is recalculated here from the cart and the catalogue. **Nothing
    the client sent about money is trusted** — not the price, not the discount,
    not the total. The browser's figures are for display; these are what the
    customer is charged.
    """
    from app.models import CartItem

    items = list(
        db.execute(
            select(CartItem)
            .options(selectinload(CartItem.product).selectinload(Product.category))
            .where(CartItem.customer_id == customer.id)
        )
        .unique()
        .scalars()
        .all()
    )

    if not items:
        raise ValidationError("Your bag is empty.", error_code="CART_EMPTY")

    config = billing.billing_config(db)
    now = datetime.utcnow()

    # --- what the client chose, checked against what the store offers -----
    #
    # Both used to be free strings. `payment_method: "cod"` produced a confirmed,
    # unpaid order even on a store with cash on delivery switched off, because
    # nothing compared the choice with the store's own settings.
    _require_payment_method(config, payment_method)
    _require_delivery_method(delivery_method)

    provider = get_provider()
    holds_stock = _settles_later(provider, payment_method)

    # --- one customer cannot hold the shelf hostage -----------------------
    if holds_stock:
        _refuse_if_hoarding(db, customer, now)

    place_of_supply = (billing_address or shipping_address).get("state", "")

    # --- lock, then price, from the catalogue ------------------------------
    #
    # Locked before anything is read, so the price and the stock this order is
    # built from are the ones that are true when it commits. Two orders for the
    # last unit now queue here rather than both reading "one left".
    locked = product_service.lock_products(db, [item.product_id for item in items])

    lines: List[billing.BillingLine] = []
    for item in items:
        product = locked.get(item.product_id)
        if product is None or product.status not in ("active", "out-of-stock"):
            raise ConflictError(
                "An item in your bag is no longer available.", error_code="PRODUCT_UNAVAILABLE"
            )

        available = product.available_stock
        if item.quantity <= 0:
            raise ValidationError("A quantity in your bag is not valid.", error_code="INVALID_QUANTITY")
        if item.quantity > available:
            raise ConflictError(
                f"Only {available} of {product.name} left."
                if available
                else f"{product.name} has just sold out.",
                error_code="INSUFFICIENT_STOCK",
            )

        lines.append(
            billing.BillingLine(
                product_id=product.id,
                name=product.name,
                sku=product.sku,
                category=product.category.slug if product.category else None,
                size=item.size or None,
                color=item.color or None,
                quantity=item.quantity,
                unit_price=billing.to_minor(float(product.price)),
                list_price=billing.to_minor(float(product.original_price)),
            )
        )

    subtotal = sum(line.unit_price * line.quantity for line in lines)
    item_count = sum(line.quantity for line in lines)

    coupon = None
    if coupon_code:
        result = coupon_service.validate_coupon(db, coupon_code, subtotal, customer_id=customer.id)
        if not result.get("valid"):
            raise ValidationError(result.get("reason", "That coupon cannot be used."),
                                  error_code="COUPON_INVALID")
        coupon = result

    from app.services import membership as membership_service

    perks = membership_service.order_benefits(db, customer.id, delivery_method=delivery_method)
    coupon_ships_free = bool(coupon and coupon.get("type") == "free-shipping")

    shipping = billing.calculate_shipping(
        db,
        subtotal=subtotal,
        item_count=item_count,
        method=delivery_method,
        coupon_waives_shipping=coupon_ships_free,
        member_waives_shipping=perks["freeDelivery"],
    )
    # Counted against the monthly quota only when the membership is what made
    # delivery free — not when the basket or a coupon already had.
    standard_fee = billing.calculate_shipping(
        db, subtotal=subtotal, item_count=item_count, method=delivery_method
    )
    member_free_delivery = bool(perks["freeDelivery"] and standard_fee > 0 and not coupon_ships_free)

    priced = billing.calculate(
        db,
        lines,
        place_of_supply=place_of_supply,
        shipping=shipping,
        coupon=coupon,
        member_discount_percent=perks["discountPercent"],
    )
    breakdown = priced["breakdown"]

    try:
        # --- the order ---------------------------------------------------
        order = Order(
            id=next_id(db, Order, "order"),
            order_number=_generate_order_number(db, config),
            customer_id=customer.id,
            customer_name=customer.full_name,
            customer_email=email or customer.email,
            placed_at=now,
            # Confirmed further down, once the payment outcome is known. A
            # prepaid order stays pending until the gateway settles it —
            # confirming first would mean an abandoned Checkout left a
            # confirmed order nobody ever paid for.
            status="pending",
            payment_status="pending",
            payment_method=payment_method,
            delivery_method=delivery_method,
            delivery_fee=billing.to_major(shipping),
            expected_delivery=_delivery_estimate(delivery_method),
            item_count=item_count,
            subtotal=billing.to_major(breakdown["subtotal"]),
            catalogue_savings=billing.to_major(breakdown["productDiscount"]),
            coupon_code=coupon["code"] if coupon else None,
            coupon_discount=billing.to_major(breakdown["couponDiscount"]),
            membership_id=perks["membership"].id if perks["membership"] else None,
            member_discount=billing.to_major(breakdown["memberDiscount"]),
            member_free_delivery=member_free_delivery,
            tax_amount=billing.to_major(breakdown["tax"]["totalTax"]),
            total=billing.to_major(breakdown["grandTotal"]),
            shipping_name=shipping_address.get("fullName", ""),
            shipping_phone=shipping_address.get("phone", ""),
            shipping_line1=shipping_address.get("line1", ""),
            shipping_line2=shipping_address.get("line2", ""),
            shipping_city=shipping_address.get("city", ""),
            shipping_state=shipping_address.get("state", ""),
            shipping_pincode=shipping_address.get("pincode", ""),
            shipping_country=shipping_address.get("country", "India"),
        )

        for item, line in zip(items, lines):
            order.items.append(
                OrderItem(
                    product_id=line.product_id,
                    name=line.name,
                    sku=line.sku,
                    slug=item.product.slug,
                    brand=item.product.brand,
                    # The photograph of the colour bought, not of the product
                    # in general: the order page shows what is on its way.
                    image=next(iter(images_for(item.product, item.color)), ""),
                    size=line.size,
                    color=line.color,
                    quantity=line.quantity,
                    is_returnable=item.product.is_returnable,
                    is_replaceable=item.product.is_replaceable,
                    # The price **at the time of purchase**. An order's value
                    # must never be recomputed from the current catalogue.
                    unit_price=billing.to_major(line.unit_price),
                    line_total=billing.to_major(line.unit_price * line.quantity),
                )
            )

        order.events.append(
            OrderEvent(status="pending", note="Order placed.", actor="customer", occurred_at=now)
        )

        db.add(order)
        db.flush()

        # --- stock -------------------------------------------------------
        #
        # Held, not taken, when the money has not arrived yet. A prepaid order
        # whose payment never comes must not have moved anything off the shelf
        # — it reserves, and the reservation becomes a sale on payment or is
        # released when the window closes. Cash on delivery takes the stock at
        # once, because that order is already confirmed.
        if holds_stock:
            for line in lines:
                product_service.reserve_stock(db, line.product_id, line.quantity, order.id)
            order.stock_state = "reserved"
            order.payment_expires_at = now + timedelta(seconds=settings.PAYMENT_WINDOW_SECONDS)
        else:
            for line in lines:
                product_service.consume_stock(db, line.product_id, line.quantity, order.id)
            order.stock_state = "consumed"

        # --- invoice -----------------------------------------------------
        issued = now
        invoice = Invoice(
            id=next_id(db, Invoice, "invoice"),
            invoice_number=_next_invoice_number(db, config, issued),
            order_id=order.id,
            order_number=order.order_number,
            customer_id=customer.id,
            customer_name=customer.full_name,
            customer_email=order.customer_email,
            status="issued",
            issued_at=issued,
            due_at=issued + timedelta(days=config.get("invoice", {}).get("dueDays", 7)),
            billing_address=billing_address or shipping_address,
            shipping_address=shipping_address,
            place_of_supply=place_of_supply,
            currency=breakdown["currency"],
            item_count=breakdown["itemCount"],
            subtotal=breakdown["subtotal"],
            product_discount=breakdown["productDiscount"],
            coupon_code=breakdown["couponCode"],
            coupon_discount=breakdown["couponDiscount"],
            member_discount=breakdown["memberDiscount"],
            shipping=breakdown["shipping"],
            other_charges=breakdown["otherCharges"],
            taxable_amount=breakdown["tax"]["taxableAmount"],
            tax_mode=breakdown["tax"]["mode"],
            tax_rate_percent=breakdown["tax"]["ratePercent"],
            cgst=breakdown["tax"]["cgst"],
            sgst=breakdown["tax"]["sgst"],
            igst=breakdown["tax"]["igst"],
            total_tax=breakdown["tax"]["totalTax"],
            prices_include_tax=breakdown["pricesIncludeTax"],
            grand_total=breakdown["grandTotal"],
            payment_method=payment_method,
            payment_status="pending",
            notes=config.get("invoice", {}).get("notes", ""),
            terms=config.get("invoice", {}).get("paymentTerms", ""),
        )

        invoice.items = [InvoiceItem(**_invoice_line(line)) for line in priced["lines"]]
        db.add(invoice)
        db.flush()

        # --- payment -----------------------------------------------------
        result = provider.create(
            PaymentRequest(
                order_id=order.id,
                invoice_id=invoice.id,
                customer_id=customer.id,
                customer_name=customer.full_name,
                customer_email=order.customer_email,
                amount=breakdown["grandTotal"],
                currency=breakdown["currency"],
                method=payment_method,
                notes={"orderNumber": order.order_number},
            )
        )

        payment = Payment(
            id=next_id(db, Payment, "payment"),
            transaction_id=result.transaction_id,
            order_id=order.id,
            order_number=order.order_number,
            invoice_id=invoice.id,
            invoice_number=invoice.invoice_number,
            customer_id=customer.id,
            customer_name=customer.full_name,
            customer_email=order.customer_email,
            amount=breakdown["grandTotal"],
            method=payment_method,
            status=result.status,
            provider=provider.name,
            provider_reference=result.provider_reference,
            instrument_hint=result.instrument_hint,
            created_at_utc=now,
            captured_at=now if result.status == "paid" else None,
        )

        payment.events.append(
            PaymentEvent(status="initiated", note="Payment initiated at checkout.", occurred_at=now)
        )
        if result.status == "paid":
            payment.events.append(
                PaymentEvent(status="succeeded", note="Authorised and captured.", occurred_at=now)
            )
        elif result.status == "failed":
            payment.events.append(
                PaymentEvent(
                    status="failed",
                    note=result.failure_reason or "Declined by the provider.",
                    occurred_at=now,
                )
            )
        else:
            payment.events.append(
                PaymentEvent(
                    status="processing",
                    note="Awaiting collection on delivery."
                    if payment_method == "cod"
                    else "Sent to the payment provider.",
                    occurred_at=now,
                )
            )

        db.add(payment)
        db.flush()

        # Close the loop so either record reaches the other.
        invoice.payment_id = payment.id
        invoice.payment_status = payment.status

        if payment.status == "paid":
            invoice.status = "paid"
            invoice.amount_paid = breakdown["grandTotal"]
            order.payment_status = "paid"
        elif payment_method == "cod":
            order.payment_status = "cod-pending"
        elif payment.status == "failed":
            order.payment_status = "failed"

        # Confirm the order, unless it is waiting for a gateway.
        #
        # Cash on delivery confirms immediately — the arrangement is with the
        # courier, and there is nothing to wait for. So does a provider that
        # settles synchronously, which is what the mock does.
        #
        # A prepaid order with an unsettled payment stays `pending`.
        # `settlement.apply_result` confirms it when the money arrives, from
        # either the browser's verify call or the webhook. This is the whole
        # reason a real gateway needs a two-step flow: at this point in the
        # request the shopper has not been shown a payment screen yet.
        awaiting_gateway = payment_method != "cod" and payment.status not in (
            "paid",
            "authorized",
        )

        if not awaiting_gateway:
            order.status = "confirmed"
            order.events.append(
                OrderEvent(
                    status="confirmed",
                    note="Payment received." if payment.status == "paid" else "",
                    actor="system",
                    occurred_at=now,
                )
            )
            from app.services import email as email_service

            email_service.notify_order(db, order, "confirmed")

        # --- coupon ------------------------------------------------------
        if coupon:
            coupon_service.record_usage(
                db, coupon["code"], customer.id, order.id, breakdown["couponDiscount"]
            )

        # --- empty the bag -----------------------------------------------
        for item in items:
            db.delete(item)

        db.commit()

    except Exception:
        # One failure undoes all of it. An order without its invoice, or stock
        # consumed by an order that was never created, is worse than a failed
        # checkout the customer can retry.
        db.rollback()
        raise

    db.refresh(order)
    db.refresh(invoice)
    db.refresh(payment)
    return order, invoice, payment


def _invoice_line(line: dict) -> dict:
    return {
        "product_id": line["productId"],
        "name": line["name"],
        "sku": line["sku"],
        "hsn": line["hsn"],
        "size": line["size"],
        "color": line["color"],
        "quantity": line["quantity"],
        "unit_price": line["unitPrice"],
        "line_subtotal": line["lineSubtotal"],
        "discount": line["discount"],
        "taxable_amount": line["taxableAmount"],
        "tax_rate_percent": line["taxRatePercent"],
        "cgst": line["cgst"],
        "sgst": line["sgst"],
        "igst": line["igst"],
        "tax": line["tax"],
        "line_total": line["lineTotal"],
    }


def _delivery_estimate(method: str, from_date: Optional[datetime] = None) -> str:
    """A date in plain language, counting business days only."""
    date = from_date or datetime.utcnow()
    remaining = 2 if method == "express" else 5

    while remaining > 0:
        date += timedelta(days=1)
        if date.weekday() < 5:
            remaining -= 1

    # Built by hand rather than with `%-d`, which is not portable to Windows.
    return f"{date:%a}, {date.day} {date:%b}"


# --------------------------------------------------------------- updating


def update_status(
    db: Session,
    order_id: str,
    status: str,
    *,
    note: str = "",
    actor: str = "system",
    confirm: bool = False,
) -> Order:
    """
    Move an order along, and record that it moved.

    The rules are enforced here rather than trusted from the client — see
    `classify_transition`. The next stage needs nothing more; skipping stages
    or stepping back needs `confirm=True`, so a slip of the dropdown cannot
    rewrite an order's history, and the timeline records what was done.
    """
    order = get_order(db, order_id)

    kind = classify_transition(order, status)
    if kind == "same":
        return order
    if kind in ("skip", "back") and not confirm:
        raise ConflictError(
            f"Moving this order from {STAGE_LABELS[order.status]} to {STAGE_LABELS[status]} "
            + ("skips stages" if kind == "skip" else "moves it backwards")
            + " and needs confirming.",
            error_code="CONFIRMATION_REQUIRED",
        )

    extra = transition_note(order, status, kind)
    note = " ".join(part for part in (extra, note.strip()) if part)

    order.status = status
    now = datetime.utcnow()
    order.events.append(OrderEvent(status=status, note=note, actor=actor, occurred_at=now))

    from app.services import email as email_service

    email_service.notify_order(db, order, status)

    # Cash on delivery settles when the courier hands it over.
    if status == "delivered" and order.payment_status == "cod-pending":
        order.payment_status = "paid"
        payment = db.execute(
            select(Payment).where(Payment.order_id == order.id)
        ).scalar_one_or_none()
        if payment:
            payment.status = "paid"
            payment.captured_at = now
            payment.events.append(
                PaymentEvent(status="succeeded", note="Collected by the courier.", occurred_at=now)
            )
            invoice = db.execute(
                select(Invoice).where(Invoice.order_id == order.id)
            ).scalar_one_or_none()
            if invoice:
                invoice.status = "paid"
                invoice.payment_status = "paid"
                invoice.amount_paid = invoice.grand_total

    # Cancelling before dispatch returns the stock — but *which* return
    # depends on what the order did with it. See `return_stock`. The coupon
    # use comes back too, so a one-time code isn't burnt by an order that
    # never went ahead.
    if status == "cancelled":
        return_stock(db, order, note="Order cancelled")
        coupon_service.release_usage(db, order.id)

    db.commit()

    # Money collected for an order that will not be fulfilled goes back.
    #
    # After the cancellation is committed, not inside it: the order is
    # cancelled whatever the gateway says. If the refund cannot be sent, it is
    # still *recorded* as owed — see `refund_if_collected` — so it can be
    # retried rather than silently forgotten, which is what used to happen:
    # cancelling a paid order put the stock back and kept the money.
    if status == "cancelled":
        refund_if_collected(db, order, reason=note or "Order cancelled")

    # A payment link outstanding for an order that is cancelled, or whose cash
    # has just been collected, must stop being payable — otherwise the
    # customer can still pay it and be charged for something already settled.
    if status in ("cancelled", "delivered"):
        _retire_payment_link(db, order)

    db.refresh(order)
    return order


def _retire_payment_link(db: Session, order: Order) -> None:
    """
    Make every way of paying this order stop working: its payment link and any
    QR code minted for it.

    A customer who cancels from the QR screen would otherwise leave a live,
    single-use code behind. Paying it would be refunded — a payment on a
    cancelled order always is — but a code that cannot be paid is better than
    a refund nobody wanted.
    """
    payment = db.execute(select(Payment).where(Payment.order_id == order.id)).scalars().first()
    if payment is None:
        return

    provider = get_provider()
    cancel = getattr(provider, "cancel_payment_link", None)
    if cancel is not None and payment.payment_link_id:
        cancel(payment.payment_link_id)

    close_qr = getattr(provider, "close_qr", None)
    if close_qr is not None:
        from app.services.settlement import _issued_qr_ids

        for qr_id in _issued_qr_ids(payment):
            try:
                close_qr(qr_id)
            except Exception:  # never let the gateway undo a committed cancel
                logger.exception("Could not close QR code %s for order %s", qr_id, order.id)


def cancel_order(db: Session, order_id: str, customer: Customer, reason: str = "") -> Order:
    """
    A customer cancelling their own order.

    Only while it is still in the warehouse. Once dispatched it is a return,
    which is a different process with a different shape.
    """
    order = get_order(db, order_id, customer_id=customer.id)

    if order.status not in CUSTOMER_CANCELLABLE:
        raise ConflictError(
            f"This order is already {order.status} and can no longer be cancelled. "
            "Start a return instead.",
            error_code="ORDER_NOT_CANCELLABLE",
        )

    return update_status(
        db,
        order.id,
        "cancelled",
        note=reason or "Cancelled by the customer.",
        actor="customer",
    )


def return_stock(db: Session, order: Order, *, note: str) -> None:
    """
    Give an order's stock back, in whichever way matches how it took it.

    - **reserved** — a prepaid order still waiting for its payment. Nothing
      ever left the shelf, so the *hold* is released. Restocking it instead
      would add units that were never removed, conjuring stock out of nothing.
    - **consumed** — cash on delivery, a paid order, or anything placed before
      reservations existed. The units really were taken, so they go back.
    - **released** — already given back. Nothing to do, which is what keeps a
      second call from returning the same units twice.

    Called inside the caller's transaction; never commits.
    """
    if order.stock_state == "reserved":
        for item in order.items:
            product_service.release_reservation(db, item.product_id, item.quantity, order.id)
        order.stock_state = "released"
        return

    if order.stock_state == "consumed":
        _restock(db, order, note=note)
        order.stock_state = "released"


def refund_if_collected(db: Session, order: Order, *, reason: str) -> None:
    """
    Refund whatever has been collected for an order that is not going ahead.

    Recorded first and sent second. The refund is written as `requested` and
    committed, *then* sent to the gateway — so if the gateway refuses or is
    unreachable, the debt is on record for someone to retry rather than lost.
    Nothing is refunded twice: `create_refund` measures against what the
    payment has left, and a payment with nothing collected is left alone.
    """
    from app.services import invoices as invoice_service

    invoice = db.execute(select(Invoice).where(Invoice.order_id == order.id)).scalar_one_or_none()
    if invoice is None:
        return

    payment = db.execute(select(Payment).where(Payment.invoice_id == invoice.id)).scalar_one_or_none()
    if payment is None or payment.status not in ("paid", "partially-refunded"):
        return

    owed = invoice_service.refundable_amount(payment)
    if owed <= 0:
        return

    try:
        refund = invoice_service.create_refund(
            db,
            invoice_id=invoice.id,
            amount=owed,
            reason=reason[:200] or "Order cancelled",
            initiated_by="system",
            status="requested",
        )
    except (ConflictError, ValidationError) as error:
        logger.warning("Order %s: no refund raised on cancellation: %s", order.id, error)
        return

    try:
        invoice_service.set_refund_status(db, refund.id, "completed")
    except ConflictError as error:
        # Recorded and left for a person. Visible in the portal as requested.
        db.rollback()
        logger.error(
            "Order %s: refund %s could not be sent (%s); left requested for retry.",
            order.id,
            refund.id,
            error,
        )


def _restock(db: Session, order: Order, *, note: str) -> None:
    """Put the goods back. Called inside the caller's transaction."""
    from app.models import StockAdjustment

    now = datetime.utcnow()
    for item in order.items:
        product = db.get(Product, item.product_id)
        if product is None:
            continue

        before = product.stock
        product.stock += item.quantity
        if product.status == "out-of-stock" and product.stock > 0:
            product.status = "active"

        db.add(
            StockAdjustment(
                product_id=product.id,
                reason="return",
                quantity_before=before,
                quantity_after=product.stock,
                delta=item.quantity,
                note=f"{note} ({order.order_number})",
                actor="system",
                created_at=now,
            )
        )
