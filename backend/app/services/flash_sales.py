"""
Flash sales: timed sale prices on chosen products.

The price itself is worked out in `services.pricing`, which the product pages,
the bag and checkout all share. This module is the rest: setting sales up
(with the checks that keep one price per product at a time), the storefront's
list of live and upcoming sales, the claims that follow an order's stock, and
telling people — customers with a sale item in their wishlist when it starts,
and the store team when it goes live, when an item sells out and when it ends.

## Units at the sale price follow the order's stock

`record_claims` writes a claim per sale item when an order is placed: held
(`reserved`) while a prepaid order waits for the gateway, `consumed` when it
is paid (or for cash on delivery, at once). `commit_claims` turns held claims
into sold ones when the payment arrives; `release_claims` hands them back when
the order is cancelled or its payment window closes — so an abandoned payment
never keeps a sale unit away from the next shopper. Both are idempotent: they
only move claims that are in the state they expect.

When a sale ends, nothing needs releasing: the sale price stops applying to
new orders, and orders already placed keep the price they were placed at.
"""

from __future__ import annotations

import html as html_lib
import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.core.config import settings as app_settings
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import (
    AdminUser,
    Customer,
    FlashSale,
    FlashSaleClaim,
    FlashSaleItem,
    Order,
    Product,
    WishlistItem,
)
from app.services import audit, billing, pricing
from app.utils.dates import parse_dt

logger = logging.getLogger(__name__)

INTERVAL_SECONDS = 60
MAX_ITEMS = 100
MAX_DURATION = timedelta(days=31)
EMAIL_TYPE = "flash_sales"
ANNOUNCE_BATCH = 500


# ------------------------------------------------------------------ status


def phase(sale: FlashSale, now: Optional[datetime] = None) -> str:
    """draft | scheduled | live | ended | cancelled."""
    now = now or datetime.utcnow()
    if sale.status in ("draft", "cancelled"):
        return sale.status
    if now < sale.starts_at:
        return "scheduled"
    if now >= sale.ends_at:
        return "ended"
    return "live"


def _sold(db: Session, item_ids: List[int]) -> Dict[int, dict]:
    if not item_ids:
        return {}
    out: Dict[int, dict] = {}
    for item_id, state, qty, revenue, regular in db.execute(
        select(FlashSaleClaim.item_id, FlashSaleClaim.state, func.sum(FlashSaleClaim.quantity),
               func.sum(FlashSaleClaim.quantity * FlashSaleClaim.unit_price),
               func.sum(FlashSaleClaim.quantity * FlashSaleClaim.regular_price))
        .where(FlashSaleClaim.item_id.in_(item_ids))
        .group_by(FlashSaleClaim.item_id, FlashSaleClaim.state)
    ).all():
        row = out.setdefault(int(item_id), {"reserved": 0, "consumed": 0, "released": 0, "revenue": 0, "savings": 0})
        row[state] = int(qty or 0)
        if state == "consumed":
            row["revenue"] += int(revenue or 0)
            row["savings"] += int((regular or 0) - (revenue or 0))
    return out


def _product_card(product: Product) -> dict:
    from app.schemas.catalogue import ProductOut

    return ProductOut.from_model(product).model_dump(by_alias=True)


def view(db: Session, sale: FlashSale, *, admin: bool = False, now: Optional[datetime] = None) -> dict:
    now = now or datetime.utcnow()
    counts = _sold(db, [item.id for item in sale.items])
    products = {p.id: p for p in db.execute(
        select(Product).where(Product.id.in_([i.product_id for i in sale.items]))
    ).scalars().all()} if sale.items else {}
    items = []
    for item in sale.items:
        product = products.get(item.product_id)
        if product is None:
            continue
        sold = counts.get(item.id, {})
        taken = sold.get("reserved", 0) + sold.get("consumed", 0)
        row = {
            "id": item.id,
            "productId": item.product_id,
            "salePrice": float(item.sale_price),
            "regularPrice": float(product.price),
            "stockLimit": item.stock_limit,
            "perCustomerLimit": item.per_customer_limit,
            "remaining": None if item.stock_limit is None else max(0, item.stock_limit - taken),
            "soldOut": item.stock_limit is not None and taken >= item.stock_limit,
        }
        if admin:
            row.update({
                "product": {"id": product.id, "name": product.name, "sku": product.sku, "slug": product.slug,
                            "price": float(product.price), "stock": product.stock,
                            "available": product.available_stock, "status": product.status,
                            "image": next(iter(_images(product)), "")},
                "reserved": sold.get("reserved", 0), "sold": sold.get("consumed", 0),
                "released": sold.get("released", 0),
                "revenue": billing.to_major(sold.get("revenue", 0)),
                "savings": billing.to_major(sold.get("savings", 0)),
                "soldOutAt": item.sold_out_at,
            })
        else:
            if product.status not in ("active", "out-of-stock"):
                continue
            row["product"] = _product_card(product)
        items.append(row)
    out = {
        "id": sale.id,
        "name": sale.name,
        "description": sale.description,
        "status": sale.status,
        "phase": phase(sale, now),
        "startsAt": sale.starts_at,
        "endsAt": sale.ends_at,
        "allowCoupons": sale.allow_coupons,
        "items": items,
    }
    if admin:
        out.update({
            "createdAt": sale.created_at, "updatedAt": sale.updated_at, "announcedAt": sale.announced_at,
            "totals": {
                "sold": sum(i.get("sold", 0) for i in items),
                "reserved": sum(i.get("reserved", 0) for i in items),
                "revenue": round(sum(i.get("revenue", 0) for i in items), 2),
                "savings": round(sum(i.get("savings", 0) for i in items), 2),
            },
        })
    return out


def _images(product: Product):
    from app.models.catalogue import images_for

    return images_for(product)


# ------------------------------------------------------------------- admin


def _load(db: Session, sale_id: int, *, lock: bool = False) -> FlashSale:
    query = select(FlashSale).options(selectinload(FlashSale.items)).where(FlashSale.id == sale_id)
    sale = db.execute(query.with_for_update() if lock else query).scalar_one_or_none()
    if sale is None:
        raise NotFoundError("No such flash sale.", error_code="FLASH_SALE_NOT_FOUND")
    return sale


def admin_list(db: Session, *, phase_filter: str = "", q: str = "", page: int = 1, page_size: int = 25) -> tuple:
    now = datetime.utcnow()
    conditions = []
    if q:
        conditions.append(FlashSale.name.ilike(f"%{q.strip()}%"))
    phases = {
        "draft": [FlashSale.status == "draft"],
        "cancelled": [FlashSale.status == "cancelled"],
        "scheduled": [FlashSale.status == "published", FlashSale.starts_at > now],
        "live": [FlashSale.status == "published", FlashSale.starts_at <= now, FlashSale.ends_at > now],
        "ended": [FlashSale.status == "published", FlashSale.ends_at <= now],
    }
    counts = {
        key: int(db.execute(select(func.count()).select_from(FlashSale).where(*conds)).scalar_one())
        for key, conds in phases.items()
    }
    if phase_filter in phases:
        conditions += phases[phase_filter]
    total = db.execute(select(func.count()).select_from(FlashSale).where(*conditions)).scalar_one()
    sales = db.execute(
        select(FlashSale).options(selectinload(FlashSale.items)).where(*conditions)
        .order_by(FlashSale.starts_at.desc(), FlashSale.id.desc())
        .offset((page - 1) * page_size).limit(page_size)
    ).scalars().all()
    rows = []
    for sale in sales:
        data = view(db, sale, admin=True, now=now)
        data["itemCount"] = len(data.pop("items"))
        rows.append(data)
    return rows, int(total), counts


def _parse_when(value, label: str) -> datetime:
    parsed = parse_dt(value) if isinstance(value, str) else None
    if parsed is None:
        raise ValidationError(f"Choose when the sale {label}.", error_code="INVALID_DATE")
    return parsed.replace(microsecond=0)


def _int_or_none(value, label: str, *, low: int = 1, high: int = 100000) -> Optional[int]:
    if value in (None, ""):
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ValidationError(f"{label} must be a whole number.", error_code="INVALID_NUMBER") from None
    if number < low or number > high:
        raise ValidationError(f"{label} must be between {low} and {high}.", error_code="INVALID_NUMBER")
    return number


def _validate(db: Session, payload: dict, sale: Optional[FlashSale]) -> dict:
    name = str(payload.get("name") or "").strip()
    if not 3 <= len(name) <= 120:
        raise ValidationError("Give the sale a name (3 to 120 characters).", error_code="INVALID_NAME")
    description = str(payload.get("description") or "").strip()[:500]
    starts_at = _parse_when(payload.get("startsAt"), "starts")
    ends_at = _parse_when(payload.get("endsAt"), "ends")
    if ends_at <= starts_at:
        raise ValidationError("The sale must end after it starts.", error_code="INVALID_WINDOW")
    if ends_at - starts_at > MAX_DURATION:
        raise ValidationError("A flash sale can run for at most 31 days.", error_code="INVALID_WINDOW")
    raw_items = payload.get("items") or []
    if not isinstance(raw_items, list) or not raw_items:
        raise ValidationError("Add at least one product to the sale.", error_code="ITEMS_REQUIRED")
    if len(raw_items) > MAX_ITEMS:
        raise ValidationError(f"A sale can have at most {MAX_ITEMS} products.", error_code="TOO_MANY_ITEMS")
    ids = [str((row or {}).get("productId") or "") for row in raw_items]
    if len(set(ids)) != len(ids):
        raise ValidationError("A product can appear in a sale only once.", error_code="DUPLICATE_PRODUCT")
    products = {p.id: p for p in db.execute(select(Product).where(Product.id.in_(ids))).scalars().all()}
    existing = {item.product_id: item for item in (sale.items if sale else [])}
    sold = _sold(db, [item.id for item in existing.values()])
    items = []
    for position, row in enumerate(raw_items):
        product = products.get(ids[position])
        if product is None:
            raise ValidationError(f"Product '{ids[position]}' doesn't exist.", error_code="PRODUCT_NOT_FOUND")
        if product.status not in ("active", "out-of-stock"):
            raise ValidationError(f"{product.name} isn't on sale in the shop (it's {product.status}).",
                                  error_code="PRODUCT_UNAVAILABLE")
        try:
            sale_price = billing.to_minor(float(row.get("salePrice")))
        except (TypeError, ValueError):
            raise ValidationError(f"Enter a sale price for {product.name}.", error_code="INVALID_PRICE") from None
        regular = billing.to_minor(float(product.price))
        if sale_price <= 0 or sale_price >= regular:
            raise ValidationError(
                f"The sale price of {product.name} must be above ₹0 and below its price of ₹{float(product.price):,.2f}.",
                error_code="INVALID_PRICE")
        stock_limit = _int_or_none(row.get("stockLimit"), f"Units for {product.name}")
        per_customer = _int_or_none(row.get("perCustomerLimit"), f"The limit per customer for {product.name}",
                                    high=100)
        previous = existing.get(product.id)
        if previous is not None and stock_limit is not None:
            taken = sold.get(previous.id, {})
            already = taken.get("reserved", 0) + taken.get("consumed", 0)
            if stock_limit < already:
                raise ValidationError(f"{already} of {product.name} have already sold at the sale price; the units "
                                      "can't be set lower than that.", error_code="STOCK_LIMIT_TOO_LOW")
        items.append({"product": product, "sale_price": billing.to_major(sale_price), "stock_limit": stock_limit,
                      "per_customer_limit": per_customer, "position": position})
    return {"name": name, "description": description, "starts_at": starts_at, "ends_at": ends_at,
            "allow_coupons": bool(payload.get("allowCoupons")), "items": items}


def _refuse_overlap(db: Session, data: dict, sale_id: Optional[int]) -> None:
    """One flash price per product at a time: no product in two overlapping published sales."""
    ids = [row["product"].id for row in data["items"]]
    clash = db.execute(
        select(FlashSale.name, Product.name)
        .join(FlashSaleItem, FlashSaleItem.sale_id == FlashSale.id)
        .join(Product, Product.id == FlashSaleItem.product_id)
        .where(FlashSaleItem.product_id.in_(ids), FlashSale.status == "published",
               FlashSale.starts_at < data["ends_at"], FlashSale.ends_at > data["starts_at"],
               FlashSale.id != (sale_id or 0))
        .limit(1)
    ).first()
    if clash:
        raise ConflictError(f"{clash[1]} is already in the {clash[0]} flash sale at that time. A product can be in "
                            "only one sale at once.", error_code="FLASH_SALE_OVERLAP")


def _apply(sale: FlashSale, data: dict) -> None:
    sale.name, sale.description = data["name"], data["description"]
    sale.starts_at, sale.ends_at, sale.allow_coupons = data["starts_at"], data["ends_at"], data["allow_coupons"]
    by_product = {item.product_id: item for item in sale.items}
    keep = []
    for row in data["items"]:
        item = by_product.get(row["product"].id) or FlashSaleItem(product_id=row["product"].id)
        item.sale_price = row["sale_price"]
        item.stock_limit = row["stock_limit"]
        item.per_customer_limit = row["per_customer_limit"]
        item.position = row["position"]
        if item.stock_limit is None or (item.sold_out_at and item.stock_limit):
            item.sold_out_at = None
        keep.append(item)
    sale.items = keep


AUDITED = ("name", "status", "starts_at", "ends_at", "allow_coupons")


def _items_snapshot(sale: FlashSale) -> dict:
    return {item.product_id: {"price": float(item.sale_price), "units": item.stock_limit,
                              "perCustomer": item.per_customer_limit} for item in sale.items}


def create(db: Session, admin: AdminUser, payload: dict) -> FlashSale:
    data = _validate(db, payload, None)
    publish = bool(payload.get("publish"))
    if publish:
        _refuse_publish_in_past(data["ends_at"])
        _refuse_overlap(db, data, None)
    now = datetime.utcnow()
    sale = FlashSale(status="published" if publish else "draft", created_by=admin.id, created_at=now, updated_at=now)
    _apply(sale, data)
    db.add(sale)
    db.flush()
    audit.record(db, "flash_sale.create", resource_type="flash-sales", resource_id=sale.id, actor=admin,
                 summary=f"Created flash sale {sale.name} ({sale.status})",
                 changes=audit.diff({}, {**audit.snapshot(sale, AUDITED), "items": _items_snapshot(sale)}))
    db.commit()
    pricing.forget_offers(db)
    return _load(db, sale.id)


def update(db: Session, admin: AdminUser, sale_id: int, payload: dict) -> FlashSale:
    sale = _load(db, sale_id, lock=True)
    if sale.status == "cancelled" or phase(sale) == "ended":
        raise ConflictError("This sale is over and can't be changed.", error_code="FLASH_SALE_CLOSED")
    before = {**audit.snapshot(sale, AUDITED), "items": _items_snapshot(sale)}
    data = _validate(db, payload, sale)
    if phase(sale) == "live" and data["starts_at"] != sale.starts_at:
        raise ConflictError("The sale has started; its start time can't change.", error_code="FLASH_SALE_STARTED")
    if sale.status == "published":
        _refuse_publish_in_past(data["ends_at"])
        _refuse_overlap(db, data, sale.id)
    _apply(sale, data)
    sale.updated_at = datetime.utcnow()
    db.flush()
    audit.record(db, "flash_sale.update", resource_type="flash-sales", resource_id=sale.id, actor=admin,
                 summary=f"Changed flash sale {sale.name}",
                 changes=audit.diff(before, {**audit.snapshot(sale, AUDITED), "items": _items_snapshot(sale)}))
    db.commit()
    pricing.forget_offers(db)
    return _load(db, sale.id)


def _refuse_publish_in_past(ends_at: datetime) -> None:
    if ends_at <= datetime.utcnow():
        raise ValidationError("The end time has already passed.", error_code="INVALID_WINDOW")


def set_status(db: Session, admin: AdminUser, sale_id: int, action: str) -> FlashSale:
    """publish | unpublish (back to draft, before it starts) | cancel | end (now)."""
    sale = _load(db, sale_id, lock=True)
    now = datetime.utcnow().replace(microsecond=0)
    current = phase(sale, now)
    before = audit.snapshot(sale, AUDITED)
    if action == "publish":
        if sale.status != "draft":
            raise ConflictError("Only a draft can be published.", error_code="FLASH_SALE_STATE")
        data = {"items": [{"product": db.get(Product, i.product_id)} for i in sale.items],
                "starts_at": sale.starts_at, "ends_at": sale.ends_at}
        if not sale.items:
            raise ValidationError("Add at least one product first.", error_code="ITEMS_REQUIRED")
        _refuse_publish_in_past(sale.ends_at)
        _refuse_overlap(db, data, sale.id)
        sale.status = "published"
    elif action == "unpublish":
        if current != "scheduled":
            raise ConflictError("Only a sale that hasn't started can go back to draft.", error_code="FLASH_SALE_STATE")
        sale.status = "draft"
    elif action == "cancel":
        if current in ("ended", "cancelled"):
            raise ConflictError("This sale is already over.", error_code="FLASH_SALE_STATE")
        sale.status = "cancelled"
    elif action == "end":
        if current != "live":
            raise ConflictError("Only a live sale can be ended early.", error_code="FLASH_SALE_STATE")
        sale.ends_at = now
    else:
        raise ValidationError("Unknown action.", error_code="INVALID_ACTION")
    sale.updated_at = now
    audit.record(db, f"flash_sale.{action}", resource_type="flash-sales", resource_id=sale.id, actor=admin,
                 summary=f"{action.capitalize()} flash sale {sale.name}",
                 changes=audit.diff(before, audit.snapshot(sale, AUDITED)))
    db.commit()
    pricing.forget_offers(db)
    return _load(db, sale.id)


def delete(db: Session, admin: AdminUser, sale_id: int) -> None:
    sale = _load(db, sale_id, lock=True)
    has_orders = db.execute(select(FlashSaleClaim.id).where(FlashSaleClaim.sale_id == sale.id).limit(1)).first()
    if has_orders:
        raise ConflictError("Orders were placed in this sale, so it is kept for the record. Cancel it instead.",
                            error_code="FLASH_SALE_HAS_ORDERS")
    audit.record(db, "flash_sale.delete", resource_type="flash-sales", resource_id=sale.id, actor=admin,
                 summary=f"Deleted flash sale {sale.name}", changes=audit.diff(audit.snapshot(sale, AUDITED), {}))
    db.delete(sale)
    db.commit()
    pricing.forget_offers(db)


# --------------------------------------------------------------- storefront


def storefront(db: Session, *, include_upcoming_days: int = 7) -> dict:
    """Live sales, and published ones starting within a week."""
    now = datetime.utcnow()
    sales = db.execute(
        select(FlashSale).options(selectinload(FlashSale.items))
        .where(FlashSale.status == "published", FlashSale.ends_at > now,
               FlashSale.starts_at <= now + timedelta(days=include_upcoming_days))
        .order_by(FlashSale.starts_at)
    ).scalars().all()
    live, upcoming = [], []
    for sale in sales:
        data = view(db, sale, now=now)
        if not data["items"]:
            continue
        if data["phase"] == "scheduled":
            # Shown with their prices, so people can plan for them.
            upcoming.append(data)
        else:
            live.append(data)
    return {"live": live, "upcoming": upcoming, "serverTime": now}


def storefront_sale(db: Session, sale_id: int) -> dict:
    sale = _load(db, sale_id)
    if sale.status != "published":
        raise NotFoundError("No such flash sale.", error_code="FLASH_SALE_NOT_FOUND")
    return {**view(db, sale), "serverTime": datetime.utcnow()}


# ------------------------------------------------------------------ claims


def record_claims(db: Session, order: Order, priced_lines, *, held: bool) -> None:
    """One claim per sale item in a new order. Called inside `place_order`'s transaction."""
    now = datetime.utcnow()
    by_item: Dict[int, dict] = {}
    for priced in priced_lines:
        offer = priced.offer
        if offer is None:
            continue
        row = by_item.setdefault(offer.item_id, {"offer": offer, "qty": 0, "regular": priced.regular_unit})
        row["qty"] += priced.line.quantity
    for item_id, row in by_item.items():
        offer = row["offer"]
        db.add(FlashSaleClaim(
            sale_id=offer.sale_id, item_id=item_id, product_id=offer.product_id, order_id=order.id,
            customer_id=order.customer_id, quantity=row["qty"], unit_price=offer.sale_price,
            regular_price=row["regular"], state="reserved" if held else "consumed", created_at=now, updated_at=now,
        ))
    if by_item:
        db.flush()
        pricing.forget_offers(db)
        _note_sell_outs(db, list(by_item))


def commit_claims(db: Session, order: Order) -> None:
    """The order was paid: its held sale units are sold."""
    _move(db, order, "reserved", "consumed")


def release_claims(db: Session, order: Order) -> None:
    """The order was cancelled or never paid: its sale units go back to the sale."""
    _move(db, order, "reserved", "released")
    _move(db, order, "consumed", "released")


def _move(db: Session, order: Order, source: str, target: str) -> None:
    claims = db.execute(select(FlashSaleClaim).where(FlashSaleClaim.order_id == order.id,
                                                     FlashSaleClaim.state == source)).scalars().all()
    now = datetime.utcnow()
    for claim in claims:
        claim.state, claim.updated_at = target, now
    if claims and target == "released":
        # Units back on offer: an item marked sold out can sell again.
        for item in db.execute(select(FlashSaleItem).where(
                FlashSaleItem.id.in_([c.item_id for c in claims]), FlashSaleItem.sold_out_at.is_not(None))).scalars():
            item.sold_out_at = None
    if claims:
        pricing.forget_offers(db)


def _note_sell_outs(db: Session, item_ids: List[int]) -> None:
    """Tell the store team, once, when an item's sale units run out."""
    from app.services import inbox

    counts = _sold(db, item_ids)
    for item in db.execute(select(FlashSaleItem).options(selectinload(FlashSaleItem.sale))
                           .where(FlashSaleItem.id.in_(item_ids))).scalars():
        if item.stock_limit is None or item.sold_out_at is not None:
            continue
        taken = counts.get(item.id, {})
        if taken.get("reserved", 0) + taken.get("consumed", 0) < item.stock_limit:
            continue
        item.sold_out_at = datetime.utcnow()
        product = db.get(Product, item.product_id)
        inbox.staff(db, "flash_sale", f"Sold out in {item.sale.name}: {product.name if product else item.product_id}",
                    f"All {item.stock_limit} units at the sale price have been ordered.",
                    f"/admin/flash-sales/detail?id={item.sale_id}", permission="flash-sales")


# --------------------------------------------------------- announcements


def announce_started(db: Session, now: Optional[datetime] = None) -> int:
    """
    For each sale that has just gone live: tell the store team, and email the
    customers who have one of its products in their wishlist. Once per sale.
    """
    from app.services import email as email_service, inbox

    now = now or datetime.utcnow()
    sales = db.execute(
        select(FlashSale).options(selectinload(FlashSale.items))
        .where(FlashSale.status == "published", FlashSale.starts_at <= now, FlashSale.ends_at > now,
               FlashSale.announced_at.is_(None))
        .with_for_update(skip_locked=True)
    ).scalars().all()
    told = 0
    for sale in sales:
        sale.announced_at = now
        product_ids = [item.product_id for item in sale.items]
        prices = {item.product_id: float(item.sale_price) for item in sale.items}
        inbox.staff(db, "flash_sale", f"Flash sale live: {sale.name}",
                    f"{len(product_ids)} product{'s' if len(product_ids) != 1 else ''} until "
                    f"{_ist(sale.ends_at)} IST.", f"/admin/flash-sales/detail?id={sale.id}", permission="flash-sales")
        wishes = db.execute(
            select(WishlistItem.customer_id, Product)
            .join(Product, Product.id == WishlistItem.product_id)
            .join(Customer, Customer.id == WishlistItem.customer_id)
            .where(WishlistItem.product_id.in_(product_ids), Customer.status == "active",
                   Product.status.in_(("active", "out-of-stock")))
            .limit(ANNOUNCE_BATCH * 5)
        ).all()
        by_customer: Dict[str, list] = {}
        for customer_id, product in wishes:
            by_customer.setdefault(customer_id, []).append(product)
        for customer_id, products in list(by_customer.items())[:ANNOUNCE_BATCH]:
            customer = db.get(Customer, customer_id)
            if customer is None or not email_service.wants(db, EMAIL_TYPE, customer.id):
                continue
            _email_started(db, customer, sale, products, prices)
            told += 1
    db.commit()
    return told


def _ist(when: datetime) -> str:
    return (when + timedelta(hours=5, minutes=30)).strftime("%d %b, %I:%M %p")


def _email_started(db: Session, customer: Customer, sale: FlashSale, products: List[Product], prices: dict) -> None:
    from app.services import email as email_service

    esc = html_lib.escape
    base = app_settings.STOREFRONT_URL.rstrip("/")
    names = ", ".join(p.name for p in products[:3]) + (f" and {len(products) - 3} more" if len(products) > 3 else "")
    rows = [(p.name, f"₹{prices[p.id]:,.2f} (was ₹{float(p.price):,.2f})") for p in products[:10]]
    title = f"Flash sale on your wishlist: {sale.name}"
    intro = (f"Hello {esc(customer.first_name or 'there')}, {esc(names)} from your wishlist "
             f"{'is' if len(products) == 1 else 'are'} in our <strong>{esc(sale.name)}</strong> flash sale until "
             f"{esc(_ist(sale.ends_at))} IST, while sale stock lasts.")
    link = f"{base}/flash-sales"
    html = email_service.layout(title, intro, rows=rows, cta=("Shop the sale", link),
                                footnote="You're getting this because these items are in your wishlist.")
    email_service.notify(db, EMAIL_TYPE, to=customer.email, customer_id=customer.id, subject=title, html=html,
                         text=f"{title}. {names}. Until {_ist(sale.ends_at)} IST. {link}",
                         reference=f"flash-sale-{sale.id}", inbox={"title": title, "href": "/flash-sales"})


def sweep(db: Session) -> None:
    announce_started(db)


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

    logger.info("Flash sales checked every %ss.", INTERVAL_SECONDS)
    while True:
        try:
            await asyncio.to_thread(jobs.tracked("flash_sales", INTERVAL_SECONDS, _sweep_once))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Flash sale sweep failed; retrying next interval.")
        await asyncio.sleep(INTERVAL_SECONDS)
