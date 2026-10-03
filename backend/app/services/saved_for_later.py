"""
Saved for later: bag lines put aside.

Different from the wishlist on purpose. The wishlist is "I like this"; a saved
line is "this was in my bag, not now" — so it keeps the size, colour and
quantity the customer chose, and it goes back to the *bag*, not to a product
page.

## Nothing here prices anything

A saved line remembers what it cost when it was saved only to say "the price
dropped from ₹X to ₹Y". Moving it back to the bag goes through
`cart.add_item` — the same checks as adding it fresh: the product is published
and in stock, the size and colour still exist, the quantity is within the
line limit, the stock and any flash-sale limit. The bag then prices it from
the catalogue like every other line, and checkout locks and re-checks it
again. A saved line can't carry an old price or an old stock level into an
order.

## Guests

A guest's saved lines are kept in the browser, like the guest bag, and handed
over once at sign-in (`merge`).
"""

from __future__ import annotations

import logging
from typing import Iterable, List, Optional

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import CartItem, Customer, Product, SavedCartItem, WishlistItem
from app.repositories import products as product_repo
from app.services import billing, cart_recovery
from app.services.cart import MAX_QUANTITY_PER_LINE

logger = logging.getLogger(__name__)

MAX_MERGE_ITEMS = 50


def limit() -> int:
    return max(1, int(settings.SAVED_FOR_LATER_LIMIT))


def _current_unit_price(product: Product) -> int:
    """Today's selling price in paise, flash sale included — what the bag would charge."""
    from app.services import pricing

    offer = pricing.offer_for(product)
    if offer is not None:
        return int(offer.sale_price)
    return billing.to_minor(float(product.price))


def status_of(product: Optional[Product], *, size: str, color: str, quantity: int) -> dict:
    """
    Can this line go back in the bag as it is, and if not, why.

    `available` | `limited` (fewer in stock than saved) | `out-of-stock` |
    `variant-unavailable` (the size or colour is gone, or a size is now
    needed) | `unavailable` (withdrawn from sale).
    """
    if product is None or product.status not in product_repo.PUBLISHED_STATUSES:
        return {"status": "unavailable", "message": "Currently unavailable", "maxQuantity": 0}
    sizes = [s.label for s in product.sizes]
    colors = [c.name for c in product.colors]
    if (size and size not in sizes) or (sizes and not size) or (color and colors and color not in colors):
        return {"status": "variant-unavailable", "message": "This option is no longer available — choose another.",
                "maxQuantity": 0}
    available = product.available_stock
    if product.status != "active" or available <= 0:
        return {"status": "out-of-stock", "message": "Currently unavailable", "maxQuantity": 0}
    cap = min(available, MAX_QUANTITY_PER_LINE)
    if quantity > cap:
        return {"status": "limited", "message": f"Only {cap} available", "maxQuantity": cap}
    return {"status": "available", "message": "", "maxQuantity": cap}


def _rows(db: Session, customer_id: str) -> List[SavedCartItem]:
    return list(db.execute(
        select(SavedCartItem)
        .where(SavedCartItem.customer_id == customer_id)
        .order_by(SavedCartItem.created_at.desc(), SavedCartItem.id.desc())
    ).scalars().all())


def listing(db: Session, customer: Customer) -> List[dict]:
    """
    Every saved line, newest first, each with today's price and whether it can
    go back in the bag. Withdrawn products are listed (so the customer can
    remove them) but never as something to buy.
    """
    from app.schemas.catalogue import ProductOut

    rows = _rows(db, customer.id)
    if not rows:
        return []
    ids = list({row.product_id for row in rows})
    # Every status: a line whose product was withdrawn still needs a name and
    # a picture to be recognised and removed.
    products = {p.id: p for p in product_repo.get_many(db, ids, published_only=False)}
    wished = set(db.execute(select(WishlistItem.product_id).where(
        WishlistItem.customer_id == customer.id, WishlistItem.product_id.in_(ids))).scalars())
    out = []
    for row in rows:
        product = products.get(row.product_id)
        if product is None:
            continue
        state = status_of(product, size=row.size, color=row.color, quantity=row.quantity)
        purchasable = state["status"] in ("available", "limited")
        current = _current_unit_price(product)
        saved = int(row.saved_unit_price or 0)
        out.append({
            "id": row.id,
            "productId": row.product_id,
            "size": row.size or None,
            "color": row.color or None,
            "quantity": row.quantity,
            "savedAt": row.created_at,
            "updatedAt": row.updated_at,
            "unitPrice": current,
            "savedUnitPrice": saved,
            # Said only when it is real and in the customer's favour.
            "priceDrop": ({"from": saved, "to": current} if saved and current < saved else None),
            "priceRise": bool(saved and current > saved),
            "status": state["status"],
            "message": state["message"],
            "maxQuantity": state["maxQuantity"],
            "canMoveToCart": purchasable,
            "inWishlist": row.product_id in wished,
            "product": ProductOut.from_model(product).model_dump(by_alias=True),
        })
    return out


def count(db: Session, customer_id: str) -> int:
    return int(db.execute(select(func.count()).select_from(SavedCartItem)
                          .where(SavedCartItem.customer_id == customer_id)).scalar_one())


def _existing(db: Session, customer_id: str, product_id: str, size: str, color: str, *, lock: bool = True):
    statement = select(SavedCartItem).where(
        SavedCartItem.customer_id == customer_id, SavedCartItem.product_id == product_id,
        SavedCartItem.size == size, SavedCartItem.color == color,
    )
    if lock:
        statement = statement.with_for_update()
    return db.execute(statement).scalar_one_or_none()


def _put(db: Session, customer_id: str, product: Product, *, size: str, color: str, quantity: int) -> SavedCartItem:
    """Add to the saved lines, merging with the same variant. Flushes; doesn't commit."""
    quantity = max(1, min(int(quantity or 1), MAX_QUANTITY_PER_LINE))
    row = _existing(db, customer_id, product.id, size, color)
    price = _current_unit_price(product)
    if row is not None:
        row.quantity = min(MAX_QUANTITY_PER_LINE, row.quantity + quantity)
        row.saved_unit_price = price
        db.flush()
        return row
    if count(db, customer_id) >= limit():
        raise ConflictError(f"You can save up to {limit()} items for later. Remove some to save more.",
                            error_code="SAVED_LIMIT_REACHED")
    row = SavedCartItem(customer_id=customer_id, product_id=product.id, size=size, color=color,
                        quantity=quantity, saved_unit_price=price)
    db.add(row)
    db.flush()
    return row


def save_from_cart(db: Session, customer: Customer, cart_item_id: int) -> SavedCartItem:
    """
    Move a bag line to "saved for later", in one transaction: the bag line goes,
    the saved line appears (or grows, if that variant was already saved).

    The bag line is locked first, so two clicks on "Save for later" move it
    once; the second finds nothing to move.
    """
    item = db.execute(select(CartItem).where(CartItem.id == cart_item_id).with_for_update()).scalar_one_or_none()
    if item is None or item.customer_id != customer.id:
        raise NotFoundError("That item is not in your bag.", error_code="CART_ITEM_NOT_FOUND")
    product = db.get(Product, item.product_id)
    if product is None:
        raise NotFoundError("That item is not in your bag.", error_code="CART_ITEM_NOT_FOUND")
    try:
        row = _put(db, customer.id, product, size=item.size or "", color=item.color or "", quantity=item.quantity)
        db.delete(item)
        cart_recovery.touch(db, customer.id)
        _event(db, "saved_for_later", customer.id, product.id, row.quantity)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ConflictError("That item was just saved from another tab. Refresh to see it.",
                            error_code="SAVE_CONFLICT") from None
    except Exception:
        db.rollback()
        logger.warning("Could not save cart line %s for later", cart_item_id, exc_info=True)
        raise
    db.refresh(row)
    return row


def move_to_cart(db: Session, customer: Customer, saved_id: int, *, quantity: Optional[int] = None) -> dict:
    """
    Put a saved line back in the bag — through the bag's own checks.

    Refused, with the reason, when it can't be bought as it is: the saved line
    stays where it is and nothing is added. When fewer are in stock than were
    saved, as many as there are go in and the result says so.
    """
    from app.services import cart as cart_service

    row = db.execute(select(SavedCartItem).where(SavedCartItem.id == saved_id).with_for_update()).scalar_one_or_none()
    if row is None or row.customer_id != customer.id:
        raise NotFoundError("That item isn't in your saved list.", error_code="SAVED_ITEM_NOT_FOUND")
    wanted = row.quantity if quantity is None else int(quantity)
    if wanted < 1 or wanted > MAX_QUANTITY_PER_LINE:
        raise ValidationError(f"Choose a quantity between 1 and {MAX_QUANTITY_PER_LINE}.",
                              error_code="INVALID_QUANTITY")
    product_id, size, color = row.product_id, row.size, row.color
    product = db.get(Product, product_id)
    if product is not None and product.status in product_repo.PUBLISHED_STATUSES and product.available_stock <= 0:
        raise ConflictError(f"{product.name} is currently unavailable. We'll keep it here for you.",
                            error_code="OUT_OF_STOCK")
    # The bag line this lands on: the bag gives a colourless add the first colour.
    bag_color = color or (product.colors[0].name if product is not None and product.colors else "")
    try:
        before = db.execute(select(CartItem.quantity).where(
            CartItem.customer_id == customer.id, CartItem.product_id == product_id,
            CartItem.size == size, CartItem.color == bag_color,
        )).scalar_one_or_none() or 0
        item = cart_service.add_item(db, customer, product_id=product_id, size=size or None, color=color or None,
                                     quantity=wanted, source="saved-for-later", commit=False)
        moved = item.quantity - before
        db.delete(row)
        _event(db, "saved_moved_to_cart", customer.id, product_id, moved)
        db.commit()
    except Exception:
        db.rollback()
        raise
    note = "" if moved >= wanted else (
        f"Only {moved} could be added — that's all we have right now." if moved > 0
        else "Your bag already holds as many as we can sell you.")
    return {"moved": moved, "requested": wanted, "message": note}


def update_quantity(db: Session, customer: Customer, saved_id: int, quantity: int) -> SavedCartItem:
    row = db.execute(select(SavedCartItem).where(SavedCartItem.id == saved_id).with_for_update()).scalar_one_or_none()
    if row is None or row.customer_id != customer.id:
        raise NotFoundError("That item isn't in your saved list.", error_code="SAVED_ITEM_NOT_FOUND")
    if quantity < 1 or quantity > MAX_QUANTITY_PER_LINE:
        raise ValidationError(f"Choose a quantity between 1 and {MAX_QUANTITY_PER_LINE}.",
                              error_code="INVALID_QUANTITY")
    row.quantity = quantity
    db.commit()
    db.refresh(row)
    return row


def remove(db: Session, customer: Customer, saved_id: int) -> None:
    result = db.execute(delete(SavedCartItem).where(
        SavedCartItem.id == saved_id, SavedCartItem.customer_id == customer.id))
    if not result.rowcount:
        raise NotFoundError("That item isn't in your saved list.", error_code="SAVED_ITEM_NOT_FOUND")
    db.commit()


def clear(db: Session, customer: Customer) -> int:
    result = db.execute(delete(SavedCartItem).where(SavedCartItem.customer_id == customer.id))
    db.commit()
    return int(result.rowcount or 0)


def merge(db: Session, customer: Customer, items: Iterable[dict]) -> dict:
    """
    A guest's saved lines, handed over at sign-in.

    Each must be a published product in a size and colour it still comes in;
    anything else is skipped and counted. The same variant merges into one
    line, quantities added and capped at the line limit.
    """
    entries = list(items or [])
    if len(entries) > MAX_MERGE_ITEMS:
        raise ValidationError(f"Send at most {MAX_MERGE_ITEMS} items at a time.", error_code="TOO_MANY_ITEMS")
    ids = list({str(e.get("productId") or "")[:20] for e in entries if e.get("productId")})
    products = {p.id: p for p in product_repo.get_many(db, ids)}
    merged = skipped = 0
    for attempt in range(2):
        merged = skipped = 0
        try:
            for entry in entries:
                product = products.get(str(entry.get("productId") or "")[:20])
                size = str(entry.get("size") or "")[:30]
                color = str(entry.get("color") or "")[:60]
                try:
                    quantity = int(entry.get("quantity") or 1)
                except (TypeError, ValueError):
                    quantity = 1
                if product is None or status_of(product, size=size, color=color, quantity=1)["status"] in (
                        "unavailable", "variant-unavailable"):
                    skipped += 1
                    continue
                if not color and product.colors:
                    color = product.colors[0].name
                try:
                    _put(db, customer.id, product, size=size, color=color, quantity=quantity)
                except ConflictError:
                    skipped += 1
                    continue
                merged += 1
            db.commit()
            break
        except IntegrityError:
            db.rollback()
            if attempt:
                raise
    return {"merged": merged, "skipped": skipped}


def _event(db: Session, event: str, customer_id: str, product_id: str, quantity: int) -> None:
    from app.services import analytics_events

    analytics_events.server_event(db, event, customer_id=customer_id, product_id=product_id, quantity=quantity)


def admin_view(db: Session, customer_id: str) -> List[dict]:
    """A customer's saved lines for the portal's customer screen (read-only)."""
    rows = db.execute(
        select(SavedCartItem, Product.name, Product.status)
        .join(Product, Product.id == SavedCartItem.product_id)
        .where(SavedCartItem.customer_id == customer_id)
        .order_by(SavedCartItem.created_at.desc())
    ).all()
    return [{"id": r.id, "productId": r.product_id, "name": name, "status": status, "size": r.size or None,
             "color": r.color or None, "quantity": r.quantity, "savedAt": r.created_at} for r, name, status in rows]
