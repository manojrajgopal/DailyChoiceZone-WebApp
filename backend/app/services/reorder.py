"""
Reorder: put a past order's items back in the bag.

Every item goes through the bag's own `add_item` — the same checks as adding
it from the product page: the product still exists and is on sale, the size
and colour still exist, there's stock, the quantity limit, a flash sale's
limit per customer. Nothing from the old order is reused but what was bought:
not its prices (the bag prices everything as it is now), not its coupon, its
delivery fee or its tax. Nothing is ordered — the shopper reviews the bag and
checks out as usual.

Partial reorders are normal: what can be added is, and each item that can't
says why. An item already in the bag at the quantity ordered (or more) isn't
added again, so reordering twice doesn't double the bag.

A bundle bought before is added as that bundle again when it's still on sale.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Dict, List, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import AppError, NotFoundError, ValidationError
from app.models import CartBundle, CartItem, Customer, Order, OrderItem, Product, ReorderEvent
from app.services import billing

REASONS = {
    "discontinued": "No longer sold",
    "unavailable": "Not on sale right now",
    "out_of_stock": "Out of stock",
    "variant_unavailable": "That size or colour isn't available any more",
    "limited": "Fewer in stock than you ordered",
    "in_bag": "Already in your bag",
    "bundle_unavailable": "This bundle isn't on sale any more",
    "rejected": "Couldn't be added",
}
SELLABLE = ("active", "out-of-stock")


def _order(db: Session, customer: Customer, order_id: str) -> Order:
    from app.services.orders import get_order

    try:
        return get_order(db, order_id, customer_id=customer.id)
    except NotFoundError:
        # The same answer for someone else's order as for one that doesn't exist.
        raise NotFoundError("No such order.", error_code="ORDER_NOT_FOUND") from None


def _groups(order: Order) -> List[dict]:
    """The order's lines as things to reorder: loose items, and each bundle once."""
    groups, seen = [], set()
    for item in order.items:
        if item.bundle_group:
            if item.bundle_group in seen:
                continue
            seen.add(item.bundle_group)
            parts = [i for i in order.items if i.bundle_group == item.bundle_group]
            groups.append({"kind": "bundle", "key": f"bundle:{item.bundle_group}", "bundleId": item.bundle_id,
                           "name": item.bundle_name, "quantity": item.bundle_quantity or 1, "items": parts})
        else:
            groups.append({"kind": "item", "key": f"item:{item.id}", "item": item})
    return groups


def _in_bag(db: Session, customer_id: str) -> Dict[tuple, int]:
    return {(r.product_id, r.size or "", r.color or ""): r.quantity for r in db.execute(
        select(CartItem).where(CartItem.customer_id == customer_id)).scalars()}


def _check_item(db: Session, item: OrderItem, bag: Dict[tuple, int]) -> dict:
    product = db.get(Product, item.product_id)
    size, color = item.size or "", item.color or ""
    row = {
        "key": f"item:{item.id}", "kind": "item", "orderItemId": item.id, "productId": item.product_id,
        "name": item.name, "image": item.image, "size": item.size, "color": item.color,
        "orderedQuantity": item.quantity, "orderedUnitPrice": float(item.unit_price),
        "currentPrice": None, "available": 0, "quantity": 0, "status": "available", "reason": None, "slug": item.slug,
    }
    if product is None:
        return {**row, "status": "discontinued", "reason": REASONS["discontinued"]}
    row["slug"] = product.slug
    if product.status not in SELLABLE:
        return {**row, "status": "unavailable" if product.status != "archived" else "discontinued",
                "reason": REASONS["unavailable" if product.status != "archived" else "discontinued"]}
    sizes = [s.label for s in product.sizes]
    colours = [c.name for c in product.colors]
    if (size and sizes and size not in sizes) or (sizes and not size) or (color and colours and color not in colours):
        return {**row, "status": "variant_unavailable", "reason": REASONS["variant_unavailable"]}
    from app.services import pricing

    offer = pricing.offer_for(product, db)
    row["currentPrice"] = billing.to_major(offer.sale_price) if offer else float(product.price)
    available = product.available_stock
    row["available"] = available
    if available <= 0:
        return {**row, "status": "out_of_stock", "reason": REASONS["out_of_stock"]}
    already = bag.get((product.id, size, color or (colours[0] if colours and not color else color)), 0)
    if already >= item.quantity:
        return {**row, "status": "in_bag", "reason": REASONS["in_bag"], "inBag": already}
    from app.services.cart import MAX_QUANTITY_PER_LINE

    wanted = item.quantity - already
    can = min(wanted, available, MAX_QUANTITY_PER_LINE - already)
    if can <= 0:
        return {**row, "status": "in_bag", "reason": REASONS["in_bag"], "inBag": already}
    row["quantity"] = can
    if can < wanted:
        row.update(status="limited", reason=f"Only {can} can be added — {REASONS['limited'].lower()}")
    return row


def _check_bundle(db: Session, group: dict, customer_id: str) -> dict:
    from app.models import Bundle
    from app.services import bundles as bundle_service, pricing

    row = {"key": group["key"], "kind": "bundle", "bundleId": group["bundleId"], "name": group["name"],
           "orderedQuantity": group["quantity"], "quantity": 0, "status": "available", "reason": None,
           "components": [{"name": i.name, "size": i.size, "color": i.color,
                           "quantity": i.quantity // max(1, group["quantity"])} for i in group["items"]],
           "currentPrice": None, "image": group["items"][0].image if group["items"] else ""}
    bundle = db.get(Bundle, group["bundleId"]) if group["bundleId"] else None
    if bundle is None or not pricing.bundle_window_open(bundle):
        return {**row, "status": "bundle_unavailable", "reason": REASONS["bundle_unavailable"]}
    quote = pricing.quote_bundle(bundle, bundle_service._products(db, [i.product_id for i in bundle.items]))
    row["currentPrice"] = billing.to_major(quote.price)
    row["slug"] = bundle.slug
    if quote.reason:
        return {**row, "status": "out_of_stock" if quote.available <= 0 else "bundle_unavailable", "reason": quote.reason}
    already = db.execute(select(func.coalesce(func.sum(CartBundle.quantity), 0)).where(
        CartBundle.customer_id == customer_id, CartBundle.bundle_id == bundle.id)).scalar_one()
    if already >= group["quantity"]:
        return {**row, "status": "in_bag", "reason": REASONS["in_bag"]}
    can = min(group["quantity"] - int(already), quote.available, bundle.max_per_order)
    row["quantity"] = max(0, can)
    if can <= 0:
        return {**row, "status": "out_of_stock", "reason": REASONS["out_of_stock"]}
    if can < group["quantity"] - int(already):
        row.update(status="limited", reason=f"Only {can} can be added")
    return row


def reorderable(db: Session, customer: Customer, order_id: str) -> dict:
    """What can come back into the bag from this order, at today's prices, and what can't and why."""
    order = _order(db, customer, order_id)
    bag = _in_bag(db, customer.id)
    lines = [_check_item(db, g["item"], bag) if g["kind"] == "item" else _check_bundle(db, g, customer.id)
             for g in _groups(order)]
    addable = [line for line in lines if line["quantity"] > 0]
    return {"orderId": order.id, "orderNumber": order.order_number, "placedAt": order.placed_at,
            "items": lines, "addable": len(addable), "unavailable": len(lines) - len(addable)}


def reorder(db: Session, customer: Customer, order_id: str, keys: Optional[List[str]] = None) -> dict:
    """
    Add what can be added (all, or the lines named by `keys`) to the bag,
    through the bag's own checks. Records the reorder for the portal's figures.
    """
    from app.services import bundles as bundle_service, cart

    check = reorderable(db, customer, order_id)
    order = _order(db, customer, order_id)
    chosen = check["items"] if keys is None else [line for line in check["items"] if line["key"] in set(keys)]
    if keys is not None and not chosen:
        raise ValidationError("Choose at least one item to add.", error_code="NOTHING_SELECTED")
    items_by_id = {item.id: item for item in order.items}
    added, skipped = [], []
    for line in chosen:
        if line["quantity"] <= 0:
            skipped.append(line)
            continue
        try:
            if line["kind"] == "item":
                item = items_by_id[line["orderItemId"]]
                cart.add_item(db, customer, product_id=item.product_id, size=item.size, color=item.color,
                              quantity=line["quantity"])
            else:
                group = next(g for g in _groups(order) if g["key"] == line["key"])
                selections = [{"productId": i.product_id, "size": i.size, "color": i.color} for i in group["items"]]
                bundle_service.add_to_cart(db, customer, line["bundleId"], line["quantity"], selections)
            added.append(line)
        except AppError as error:
            db.rollback()
            skipped.append({**line, "status": "rejected", "reason": error.message, "quantity": 0})
    db.add(ReorderEvent(
        customer_id=customer.id, order_id=order.id, items_requested=len(chosen), items_added=len(added),
        items=[{"productId": line.get("productId"), "bundleId": line.get("bundleId"), "name": line["name"],
                "quantity": line["quantity"], "added": line in added, "reason": line.get("reason")}
               for line in added + skipped],
        created_at=datetime.utcnow(),
    ))
    db.commit()
    units = sum(line["quantity"] for line in added)
    message = (f"{units} item{'s' if units != 1 else ''} added to your bag" if added else "Nothing could be added to your bag")
    if skipped:
        message += f"; {len(skipped)} couldn't be added"
    return {"added": added, "skipped": skipped, "message": message + ".", "units": units}


# ------------------------------------------------------------------ figures


def metrics(db: Session, *, start: datetime, end: datetime, limit: int = 10) -> dict:
    """Reorders in a period: how many, how many led to an order within a week, and what was reordered most."""
    events = db.execute(select(ReorderEvent).where(ReorderEvent.created_at >= start, ReorderEvent.created_at < end)
                        ).scalars().all()
    converted = 0
    for event in events:
        if db.execute(select(Order.id).where(
                Order.customer_id == event.customer_id, Order.status != "cancelled",
                Order.placed_at >= event.created_at, Order.placed_at <= event.created_at + timedelta(days=7)
        ).limit(1)).first():
            converted += 1
    products: Dict[str, dict] = {}
    for event in events:
        for line in event.items or []:
            if not line.get("added") or not line.get("productId"):
                continue
            row = products.setdefault(line["productId"], {"productId": line["productId"], "name": line["name"],
                                                          "times": 0, "units": 0})
            row["times"] += 1
            row["units"] += int(line.get("quantity") or 0)
    repeat = db.execute(select(func.count()).select_from(
        select(Order.customer_id).where(Order.status != "cancelled").group_by(Order.customer_id)
        .having(func.count(Order.id) >= 2).subquery())).scalar_one()
    with_events = len({e.customer_id for e in events})
    return {
        "reorders": len(events),
        "customers": with_events,
        "itemsAdded": sum(e.items_added for e in events),
        "converted": converted,
        "conversion": round(converted / len(events) * 100, 1) if events else None,
        "topProducts": sorted(products.values(), key=lambda r: (r["times"], r["units"]), reverse=True)[:limit],
        "repeatCustomers": int(repeat),
    }
