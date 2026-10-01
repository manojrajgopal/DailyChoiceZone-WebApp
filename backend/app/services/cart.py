"""The cart, and what it costs.

Stored server-side and priced server-side. A cart in local storage is a cart
that disagrees with itself across two devices and can be edited by whoever owns
the browser; a total computed in the browser is a total that can be argued
with. Both live here.
"""

from __future__ import annotations

from typing import List, Optional, Tuple

from sqlalchemy import delete, select
from sqlalchemy.orm import Session, selectinload

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import CartItem, Coupon, Customer, Product, WishlistItem
from app.repositories import products as product_repo
from app.services import billing, cart_recovery
from app.services.coupons import validate_coupon

MAX_QUANTITY_PER_LINE = 10


def _load_items(db: Session, customer_id: str) -> List[CartItem]:
    return list(
        db.execute(
            select(CartItem)
            .options(
                selectinload(CartItem.product).selectinload(Product.images),
                selectinload(CartItem.product).selectinload(Product.category),
            )
            .where(CartItem.customer_id == customer_id)
            .order_by(CartItem.created_at.asc(), CartItem.id.asc())
        )
        .unique()
        .scalars()
        .all()
    )


def add_item(
    db: Session,
    customer: Customer,
    *,
    product_id: str,
    size: Optional[str],
    color: Optional[str],
    quantity: int = 1,
) -> CartItem:
    """
    Add to the cart, or increase the line that is already there.

    The unique constraint on (customer, product, size, colour) is what makes
    this idempotent per variant: the same shirt in two sizes is two lines, the
    same shirt in the same size added twice is one line with quantity two.
    """
    product = product_repo.get_by_id(db, product_id, published_only=True)
    if product is None:
        raise NotFoundError("That product is not available.", error_code="PRODUCT_NOT_FOUND")

    # Available, not merely on the shelf: a unit held for someone else's
    # payment in progress is not for sale.
    available = product.available_stock
    if available <= 0:
        raise ConflictError(f"{product.name} is out of stock.", error_code="OUT_OF_STOCK")

    if quantity <= 0:
        raise ValidationError("A quantity must be at least 1.", error_code="INVALID_QUANTITY")

    # A product with sizes must be ordered in one — otherwise the warehouse
    # has no idea what to pick.
    if product.sizes and not size:
        raise ValidationError("Choose a size first.", error_code="SIZE_REQUIRED")

    # And it must be one the product comes in. An order for a size or colour
    # that does not exist is an order the warehouse cannot fill, and nothing
    # stops a client naming one.
    size_labels = [entry.label for entry in (product.sizes or [])]
    if size and size_labels and size not in size_labels:
        raise ValidationError(f"{product.name} does not come in {size}.", error_code="SIZE_UNAVAILABLE")

    colour_names = [entry.name for entry in (product.colors or [])]
    if color and colour_names and color not in colour_names:
        raise ValidationError(f"{product.name} does not come in {color}.", error_code="COLOR_UNAVAILABLE")

    size = size or ""
    color = color or (colour_names[0] if colour_names else "")

    existing = db.execute(
        select(CartItem).where(
            CartItem.customer_id == customer.id,
            CartItem.product_id == product.id,
            CartItem.size == size,
            CartItem.color == color,
        )
    ).scalar_one_or_none()

    wanted = (existing.quantity if existing else 0) + quantity
    capped = max(1, min(wanted, MAX_QUANTITY_PER_LINE, available))

    if existing:
        existing.quantity = capped
        item = existing
    else:
        item = CartItem(
            customer_id=customer.id,
            product_id=product.id,
            size=size,
            color=color,
            quantity=capped,
        )
        db.add(item)

    cart_recovery.touch(db, customer.id)
    db.commit()
    db.refresh(item)
    return item


def update_quantity(db: Session, customer: Customer, item_id: int, quantity: int) -> Optional[CartItem]:
    """Set a line's quantity. Zero removes it, which is what the stepper does."""
    item = db.get(CartItem, item_id)
    if item is None or item.customer_id != customer.id:
        raise NotFoundError("That item is not in your bag.", error_code="CART_ITEM_NOT_FOUND")

    if quantity <= 0:
        db.delete(item)
        cart_recovery.touch(db, customer.id)
        db.commit()
        return None

    item.quantity = min(quantity, MAX_QUANTITY_PER_LINE, max(1, item.product.available_stock))
    cart_recovery.touch(db, customer.id)
    db.commit()
    db.refresh(item)
    return item


def remove_item(db: Session, customer: Customer, item_id: int) -> None:
    item = db.get(CartItem, item_id)
    if item is None or item.customer_id != customer.id:
        raise NotFoundError("That item is not in your bag.", error_code="CART_ITEM_NOT_FOUND")

    db.delete(item)
    cart_recovery.touch(db, customer.id)
    db.commit()


def clear(db: Session, customer: Customer) -> None:
    db.execute(delete(CartItem).where(CartItem.customer_id == customer.id))
    cart_recovery.touch(db, customer.id)
    db.commit()


def get_cart(
    db: Session,
    customer: Customer,
    *,
    coupon_code: Optional[str] = None,
    delivery_method: str = "standard",
    place_of_supply: Optional[str] = None,
    pincode: Optional[str] = None,
) -> dict:
    """
    The bag, priced.

    Returns the lines **and** the breakdown, so the client renders what the
    server calculated rather than calculating alongside it. One number, one
    source.

    A line whose product has since been withdrawn is dropped rather than shown
    broken — a product can be delisted while it sits in someone's bag.
    """
    items = _load_items(db, customer.id)
    live = [item for item in items if item.product and item.product.status in ("active", "out-of-stock")]

    coupon = None
    coupon_error = None
    if coupon_code:
        subtotal_guess = sum(
            billing.to_minor(float(i.product.price)) * i.quantity for i in live
        )
        result = validate_coupon(db, coupon_code, subtotal_guess, customer_id=customer.id)
        coupon = result if result.get("valid") else None
        # Said, not swallowed: a code that silently stops applying reads as a
        # broken store.
        coupon_error = None if coupon else result.get("reason")

    from app.services import membership as membership_service

    perks = membership_service.order_benefits(db, customer.id, delivery_method=delivery_method)

    lines = [
        billing.BillingLine(
            product_id=item.product.id,
            name=item.product.name,
            sku=item.product.sku,
            category=item.product.category.slug if item.product.category else None,
            size=item.size or None,
            color=item.color or None,
            quantity=item.quantity,
            unit_price=billing.to_minor(float(item.product.price)),
            list_price=billing.to_minor(float(item.product.original_price)),
        )
        for item in live
    ]

    subtotal = sum(line.unit_price * line.quantity for line in lines)
    item_count = sum(line.quantity for line in lines)

    # Priced for the delivery pincode when checkout knows it, so the figure
    # shown is the one the order is created with.
    delivery = None
    if pincode:
        from app.services import serviceability

        delivery = serviceability.check(db, pincode)

    shipping = billing.calculate_shipping(
        db,
        subtotal=subtotal,
        item_count=item_count,
        method=delivery_method,
        coupon_waives_shipping=bool(coupon and coupon.get("type") == "free-shipping"),
        member_waives_shipping=perks["freeDelivery"],
        standard_fee=delivery.delivery_fee if delivery is not None and delivery.serviceable else None,
    )

    state = place_of_supply or billing.tax_config(db).get("originState", "")
    result = billing.calculate(
        db,
        lines,
        place_of_supply=state,
        shipping=shipping,
        coupon=coupon,
        member_discount_percent=perks["discountPercent"],
    )

    # How much more to spend to earn free delivery — a merchandising prompt,
    # not part of the bill, which is why it sits beside the breakdown.
    threshold = billing.to_minor(
        (billing.store_settings(db).get("shipping") or {}).get("freeDeliveryThreshold", 999)
    )

    return {
        "items": [
            {
                "id": item.id,
                "productId": item.product.id,
                "size": item.size or None,
                "color": item.color or None,
                "quantity": item.quantity,
                "product": item.product,
                "lineTotal": billing.to_minor(float(item.product.price)) * item.quantity,
            }
            for item in live
        ],
        "breakdown": result["breakdown"],
        "freeDeliveryShortfall": max(0, threshold - subtotal),
        "delivery": delivery.view(db) if delivery is not None else None,
        "appliedCoupon": coupon,
        "couponError": coupon_error,
        "membership": (
            {
                "name": membership_service.programme(db)["name"],
                "planName": perks["membership"].plan_name,
                "endsAt": perks["membership"].ends_at,
                "discountPercent": perks["discountPercent"],
                "freeDelivery": perks["freeDelivery"],
                "freeDeliveriesLeft": perks["freeDeliveriesLeft"],
            }
            if perks["membership"]
            else None
        ),
    }


# --------------------------------------------------------------- wishlist


def list_wishlist(db: Session, customer: Customer) -> List[Product]:
    items = db.execute(
        select(WishlistItem)
        .where(WishlistItem.customer_id == customer.id)
        .order_by(WishlistItem.created_at.desc(), WishlistItem.id.desc())
    ).scalars().all()

    return product_repo.get_many(db, [item.product_id for item in items])


def add_to_wishlist(db: Session, customer: Customer, product_id: str) -> None:
    """
    Save a product.

    Silently does nothing when it is already saved — the unique constraint
    guarantees one row, and a duplicate click is not an error the shopper needs
    to hear about.
    """
    product = product_repo.get_by_id(db, product_id, published_only=True)
    if product is None:
        raise NotFoundError("That product is not available.", error_code="PRODUCT_NOT_FOUND")

    existing = db.execute(
        select(WishlistItem).where(
            WishlistItem.customer_id == customer.id,
            WishlistItem.product_id == product_id,
        )
    ).scalar_one_or_none()

    if existing:
        return

    db.add(WishlistItem(customer_id=customer.id, product_id=product_id))
    db.commit()


def remove_from_wishlist(db: Session, customer: Customer, product_id: str) -> None:
    db.execute(
        delete(WishlistItem).where(
            WishlistItem.customer_id == customer.id,
            WishlistItem.product_id == product_id,
        )
    )
    db.commit()


def wishlist_ids(db: Session, customer: Customer) -> List[str]:
    """Just the ids — for the heart on a product card, which needs nothing else."""
    return list(
        db.execute(
            select(WishlistItem.product_id).where(WishlistItem.customer_id == customer.id)
        ).scalars().all()
    )
