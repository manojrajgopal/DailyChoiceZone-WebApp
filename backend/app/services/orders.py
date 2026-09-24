"""Placing and managing orders.

Checkout is **one transaction**. Order, lines, stock, payment, invoice and
coupon usage all succeed together or none of them do — a half-written checkout
leaves an order nobody was charged for, or stock consumed by an order that does
not exist.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import List, Optional, Tuple

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

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
from app.services import billing, coupons as coupon_service, products as product_service
from app.services.payments import PaymentRequest, get_provider
from app.utils.ids import next_id

# Which status may follow which. Anything else is refused: an order cannot go
# from delivered back to processing, and letting it would make the timeline
# meaningless.
ALLOWED_TRANSITIONS = {
    "pending": {"confirmed", "cancelled"},
    "confirmed": {"processing", "cancelled"},
    "processing": {"shipped", "cancelled"},
    "shipped": {"delivered", "returned"},
    "delivered": {"returned"},
    "cancelled": set(),
    "returned": set(),
}

# Once it has left the warehouse, cancelling is a return, not a cancellation.
CUSTOMER_CANCELLABLE = {"pending", "confirmed", "processing"}


def _generate_order_number(db: Session) -> str:
    """`DCZ10241` — short enough to read aloud on a support call."""
    highest = db.execute(
        select(func.max(Order.order_number)).where(Order.order_number.like("DCZ%"))
    ).scalar()

    try:
        number = int((highest or "DCZ10000")[3:]) + 1
    except ValueError:
        number = 10001

    return f"DCZ{number}"


def _next_invoice_number(db: Session, config: dict, issued: datetime) -> str:
    """
    Sequential, and issued here rather than by any caller.

    **This is why invoice numbering belongs on a server.** A browser cannot
    guarantee a gapless sequence — two devices would mint the same number,
    because neither can see the other. One writer, one counter.
    """
    invoice_cfg = config.get("invoice", {})
    prefix = invoice_cfg.get("prefix", "DCZ-INV")
    padding = invoice_cfg.get("padding", 6)

    highest = db.execute(
        select(func.max(Invoice.invoice_number)).where(Invoice.invoice_number.like(f"{prefix}-%"))
    ).scalar()

    number = invoice_cfg.get("startNumber", 1)
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

    place_of_supply = (billing_address or shipping_address).get("state", "")
    config = billing.billing_config(db)
    now = datetime.utcnow()

    # --- price it, from the catalogue ------------------------------------
    lines: List[billing.BillingLine] = []
    for item in items:
        product = item.product
        if product is None or product.status not in ("active", "out-of-stock"):
            raise ConflictError(
                "An item in your bag is no longer available.", error_code="PRODUCT_UNAVAILABLE"
            )
        if product.stock < item.quantity:
            raise ConflictError(
                f"Only {product.stock} of {product.name} left.", error_code="INSUFFICIENT_STOCK"
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

    shipping = billing.calculate_shipping(
        db,
        subtotal=subtotal,
        item_count=item_count,
        method=delivery_method,
        coupon_waives_shipping=bool(coupon and coupon.get("type") == "free-shipping"),
    )

    priced = billing.calculate(
        db, lines, place_of_supply=place_of_supply, shipping=shipping, coupon=coupon
    )
    breakdown = priced["breakdown"]

    try:
        # --- the order ---------------------------------------------------
        order = Order(
            id=next_id(db, Order, "order"),
            order_number=_generate_order_number(db),
            customer_id=customer.id,
            customer_name=customer.full_name,
            customer_email=email or customer.email,
            placed_at=now,
            status="confirmed",
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
                    image=item.product.images[0].url if item.product.images else "",
                    size=line.size,
                    color=line.color,
                    quantity=line.quantity,
                    # The price **at the time of purchase**. An order's value
                    # must never be recomputed from the current catalogue.
                    unit_price=billing.to_major(line.unit_price),
                    line_total=billing.to_major(line.unit_price * line.quantity),
                )
            )

        order.events.append(
            OrderEvent(status="pending", note="Order placed.", actor="customer", occurred_at=now)
        )
        order.events.append(
            OrderEvent(status="confirmed", note="", actor="system", occurred_at=now)
        )

        db.add(order)
        db.flush()

        # --- stock -------------------------------------------------------
        for line in lines:
            product_service.consume_stock(db, line.product_id, line.quantity, order.id)

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
        provider = get_provider()
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
    db: Session, order_id: str, status: str, *, note: str = "", actor: str = "system"
) -> Order:
    """
    Move an order along, and record that it moved.

    The transition map is enforced here rather than trusted from the client:
    an order that could jump from pending to delivered would make its own
    timeline a work of fiction.
    """
    order = get_order(db, order_id)

    if status == order.status:
        return order

    allowed = ALLOWED_TRANSITIONS.get(order.status, set())
    if status not in allowed:
        raise ConflictError(
            f"An order that is {order.status} cannot become {status}.",
            error_code="INVALID_TRANSITION",
        )

    order.status = status
    now = datetime.utcnow()
    order.events.append(OrderEvent(status=status, note=note, actor=actor, occurred_at=now))

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

    # Cancelling before dispatch returns the stock to the shelf.
    if status == "cancelled":
        _restock(db, order, note="Order cancelled")

    db.commit()
    db.refresh(order)
    return order


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
