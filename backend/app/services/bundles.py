"""
Bundles and combos: existing products sold together for one price.

A bundle owns no stock. How many can be sold is worked out from its
components every time (`pricing.quote_bundle`): the smallest of each
component's available units divided by how many the bundle needs. At checkout
a bundle becomes one order line per component, priced with its share of the
bundle price, so stock is reserved, taken, released and restocked per
component by the code that already does it for every order line — and tax is
worked out on each component at its own rate.
"""

from __future__ import annotations

from datetime import datetime
from typing import Dict, List, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import AdminUser, Bundle, BundleItem, CartBundle, Customer, OrderItem, Order, Product
from app.repositories.products import _with_relations
from app.services import audit, billing, pricing
from app.services.lookup.filters import id_condition
from app.utils.dates import parse_dt
from app.utils.ids import slugify

STATUSES = ("draft", "active", "archived")
MAX_COMPONENTS = 10
MAX_COMPONENT_QUANTITY = 10
SELLABLE = ("active", "out-of-stock")


# ---------------------------------------------------------------- reading


def _products(db: Session, ids) -> Dict[str, Product]:
    ids = list(set(ids))
    if not ids:
        return {}
    return {p.id: p for p in db.execute(_with_relations(select(Product).where(Product.id.in_(ids)))).unique()
            .scalars().all()}


def _load(db: Session, bundle_id: int) -> Bundle:
    bundle = db.execute(select(Bundle).options(selectinload(Bundle.items)).where(Bundle.id == bundle_id)).scalar_one_or_none()
    if bundle is None:
        raise NotFoundError("No such bundle.", error_code="BUNDLE_NOT_FOUND")
    return bundle


def view(db: Session, bundle: Bundle, *, admin: bool = False, products: Optional[Dict[str, Product]] = None) -> dict:
    from app.schemas.catalogue import ProductOut

    products = products if products is not None else _products(db, [i.product_id for i in bundle.items])
    quote = pricing.quote_bundle(bundle, products)
    components = []
    for item in bundle.items:
        product = products.get(item.product_id)
        if product is None:
            continue
        row = {
            "productId": product.id,
            "quantity": item.quantity,
            "unitPrice": billing.to_major(quote.unit_prices.get(product.id, 0)),
            "regularPrice": float(product.price),
            "available": product.available_stock,
        }
        if admin:
            row["product"] = {"id": product.id, "name": product.name, "sku": product.sku, "slug": product.slug,
                              "status": product.status, "stock": product.stock,
                              "image": next(iter(pricing._images(product, None)), "")}
        else:
            row["product"] = ProductOut.from_model(product, offers=False).model_dump(by_alias=True)
        components.append(row)
    image = bundle.image or next((next(iter(pricing._images(products[i.product_id], None)), "")
                                  for i in bundle.items if i.product_id in products), "")
    out = {
        "id": bundle.id,
        "slug": bundle.slug,
        "name": bundle.name,
        "description": bundle.description,
        "image": image,
        "price": billing.to_major(quote.price),
        "regularPrice": billing.to_major(quote.regular_total),
        "saving": billing.to_major(quote.saving),
        "savingPercent": round(quote.saving / quote.regular_total * 100) if quote.regular_total else 0,
        "available": quote.available,
        "purchasable": not quote.reason,
        "reason": quote.reason or None,
        "maxPerOrder": bundle.max_per_order,
        "startsAt": bundle.starts_at,
        "endsAt": bundle.ends_at,
        "components": components,
    }
    if admin:
        out.update({
            "status": bundle.status, "pricing": bundle.pricing,
            "fixedPrice": float(bundle.price) if bundle.price is not None else None,
            "discountPercent": float(bundle.discount_percent) if bundle.discount_percent is not None else None,
            "ownImage": bundle.image, "createdAt": bundle.created_at, "updatedAt": bundle.updated_at,
        })
    return out


def _sales(db: Session, bundle_ids: List[int]) -> Dict[int, dict]:
    """
    Bundles sold — orders, bundles and revenue — from orders that went ahead
    (paid, or cash on delivery) and weren't cancelled. One query, grouped by
    each bundle in each order.
    """
    out: Dict[int, dict] = {b: {"orders": 0, "units": 0, "revenue": 0.0} for b in bundle_ids}
    if not bundle_ids:
        return out
    for bundle_id, _order, _group, units, revenue in db.execute(
        select(OrderItem.bundle_id, OrderItem.order_id, OrderItem.bundle_group,
               func.max(OrderItem.bundle_quantity), func.coalesce(func.sum(OrderItem.line_total), 0))
        .join(Order, Order.id == OrderItem.order_id)
        .where(OrderItem.bundle_id.in_(bundle_ids), Order.status != "cancelled",
               Order.payment_status.in_(("paid", "cod-pending", "partially-refunded")))
        .group_by(OrderItem.bundle_id, OrderItem.order_id, OrderItem.bundle_group)
    ).all():
        row = out[int(bundle_id)]
        row["orders"] += 1
        row["units"] += int(units or 0)
        row["revenue"] = round(row["revenue"] + float(revenue or 0), 2)
    return out


def admin_list(db: Session, *, status: str = "", q: str = "", page: int = 1, page_size: int = 25) -> tuple:
    conditions = []
    if status in STATUSES:
        conditions.append(Bundle.status == status)
    # A Bundle ID, exactly (docs/id-lookup.md): names match nothing.
    condition = id_condition("bundle", q)
    if condition is not None:
        conditions.append(condition)
    counts = dict(db.execute(select(Bundle.status, func.count()).group_by(Bundle.status)).all())
    total = db.execute(select(func.count()).select_from(Bundle).where(*conditions)).scalar_one()
    bundles = db.execute(select(Bundle).options(selectinload(Bundle.items)).where(*conditions)
                         .order_by(Bundle.updated_at.desc(), Bundle.id.desc())
                         .offset((page - 1) * page_size).limit(page_size)).scalars().all()
    products = _products(db, [i.product_id for b in bundles for i in b.items])
    sales = _sales(db, [b.id for b in bundles])
    rows = []
    for bundle in bundles:
        row = view(db, bundle, admin=True, products=products)
        row["sales"] = sales[bundle.id]
        rows.append(row)
    return rows, int(total), {s: int(counts.get(s, 0)) for s in STATUSES}


def admin_detail(db: Session, bundle_id: int) -> dict:
    bundle = _load(db, bundle_id)
    row = view(db, bundle, admin=True)
    row["sales"] = _sales(db, [bundle.id])[bundle.id]
    return row


# ---------------------------------------------------------------- writing


def _unique_slug(db: Session, desired: str, ignore_id: Optional[int]) -> str:
    base = slugify(desired) or "bundle"
    candidate, counter = base, 2
    while db.execute(select(Bundle.id).where(Bundle.slug == candidate, Bundle.id != (ignore_id or 0))).first():
        candidate = f"{base}-{counter}"
        counter += 1
    return candidate


def _validate(db: Session, payload: dict) -> dict:
    name = str(payload.get("name") or "").strip()
    if not 3 <= len(name) <= 200:
        raise ValidationError("Give the bundle a name (3 to 200 characters).", error_code="INVALID_NAME")
    status = payload.get("status") or "draft"
    if status not in STATUSES:
        raise ValidationError("Choose draft, active or archived.", error_code="INVALID_STATUS")
    pricing_mode = payload.get("pricing") or "fixed"
    if pricing_mode not in ("fixed", "percent"):
        raise ValidationError("Choose a fixed price or a percentage off.", error_code="INVALID_PRICING")
    raw = payload.get("items") or []
    if not isinstance(raw, list) or len(raw) < 2:
        raise ValidationError("A bundle needs at least two products.", error_code="ITEMS_REQUIRED")
    if len(raw) > MAX_COMPONENTS:
        raise ValidationError(f"A bundle can have at most {MAX_COMPONENTS} products.", error_code="TOO_MANY_ITEMS")
    ids = [str((r or {}).get("productId") or "") for r in raw]
    if len(set(ids)) != len(ids):
        raise ValidationError("Each product can appear once; set its quantity instead.", error_code="DUPLICATE_PRODUCT")
    products = _products(db, ids)
    items, regular = [], 0
    for position, row in enumerate(raw):
        product = products.get(ids[position])
        if product is None:
            raise ValidationError(f"Product '{ids[position]}' doesn't exist.", error_code="PRODUCT_NOT_FOUND")
        if product.status not in SELLABLE and status == "active":
            raise ValidationError(f"{product.name} isn't on sale in the shop (it's {product.status}).",
                                  error_code="PRODUCT_UNAVAILABLE")
        try:
            quantity = int(row.get("quantity") or 1)
        except (TypeError, ValueError):
            raise ValidationError("Quantities must be whole numbers.", error_code="INVALID_QUANTITY") from None
        if not 1 <= quantity <= MAX_COMPONENT_QUANTITY:
            raise ValidationError(f"The quantity of {product.name} must be 1 to {MAX_COMPONENT_QUANTITY}.",
                                  error_code="INVALID_QUANTITY")
        regular += billing.to_minor(float(product.price)) * quantity
        items.append({"product_id": product.id, "quantity": quantity, "position": position})
    price = discount = None
    if pricing_mode == "fixed":
        try:
            price = billing.to_minor(float(payload.get("fixedPrice")))
        except (TypeError, ValueError):
            raise ValidationError("Enter the bundle price.", error_code="INVALID_PRICE") from None
        if price <= 0 or price >= regular:
            raise ValidationError(f"The bundle price must be above ₹0 and below the products' total of "
                                  f"₹{billing.to_major(regular):,.2f}.", error_code="INVALID_PRICE")
    else:
        try:
            discount = float(payload.get("discountPercent"))
        except (TypeError, ValueError):
            raise ValidationError("Enter the percentage off.", error_code="INVALID_DISCOUNT") from None
        if not 1 <= discount <= 90:
            raise ValidationError("The percentage off must be between 1 and 90.", error_code="INVALID_DISCOUNT")
    starts_at = parse_dt(payload.get("startsAt")) if payload.get("startsAt") else None
    ends_at = parse_dt(payload.get("endsAt")) if payload.get("endsAt") else None
    if starts_at and ends_at and ends_at <= starts_at:
        raise ValidationError("The bundle must end after it starts.", error_code="INVALID_WINDOW")
    try:
        max_per_order = int(payload.get("maxPerOrder") or 5)
    except (TypeError, ValueError):
        max_per_order = 0
    if not 1 <= max_per_order <= 20:
        raise ValidationError("The limit per order must be 1 to 20.", error_code="INVALID_LIMIT")
    image = str(payload.get("image") or "").strip()
    if image and not (image.startswith("/") or image.startswith("https://") or image.startswith("http://")):
        raise ValidationError("The image must be an uploaded image or a web address.", error_code="INVALID_IMAGE")
    return {
        "name": name, "slug": str(payload.get("slug") or name), "description": str(payload.get("description") or "")[:5000],
        "image": image[:500], "pricing": pricing_mode,
        "price": billing.to_major(price) if price is not None else None, "discount_percent": discount,
        "status": status, "starts_at": starts_at, "ends_at": ends_at, "max_per_order": max_per_order, "items": items,
    }


AUDITED = ("name", "slug", "status", "pricing", "price", "discount_percent", "starts_at", "ends_at", "max_per_order")


def _components(bundle: Bundle) -> dict:
    return {i.product_id: i.quantity for i in bundle.items}


def save(db: Session, admin: AdminUser, payload: dict, bundle_id: Optional[int] = None) -> dict:
    data = _validate(db, payload)
    now = datetime.utcnow()
    if bundle_id is None:
        bundle = Bundle(created_by=admin.id, created_at=now)
        before = {}
        db.add(bundle)
    else:
        bundle = db.execute(select(Bundle).options(selectinload(Bundle.items)).where(Bundle.id == bundle_id)
                            .with_for_update()).scalar_one_or_none()
        if bundle is None:
            raise NotFoundError("No such bundle.", error_code="BUNDLE_NOT_FOUND")
        before = {**audit.snapshot(bundle, AUDITED), "components": _components(bundle)}
    bundle.name, bundle.description, bundle.image = data["name"], data["description"], data["image"]
    bundle.slug = _unique_slug(db, data["slug"], bundle.id)
    bundle.pricing, bundle.price, bundle.discount_percent = data["pricing"], data["price"], data["discount_percent"]
    bundle.status, bundle.starts_at, bundle.ends_at = data["status"], data["starts_at"], data["ends_at"]
    bundle.max_per_order, bundle.updated_at = data["max_per_order"], now
    existing = {i.product_id: i for i in bundle.items}
    bundle.items = [
        _item(existing.get(row["product_id"]), row) for row in data["items"]
    ]
    db.flush()
    audit.record(db, "bundle.create" if bundle_id is None else "bundle.update", resource_type="bundles",
                 resource_id=bundle.id, actor=admin,
                 summary=f"{'Created' if bundle_id is None else 'Changed'} bundle {bundle.name}",
                 changes=audit.diff(before, {**audit.snapshot(bundle, AUDITED), "components": _components(bundle)}))
    db.commit()
    return admin_detail(db, bundle.id)


def _item(item: Optional[BundleItem], row: dict) -> BundleItem:
    item = item or BundleItem(product_id=row["product_id"])
    item.quantity, item.position = row["quantity"], row["position"]
    return item


def delete(db: Session, admin: AdminUser, bundle_id: int) -> None:
    bundle = _load(db, bundle_id)
    if db.execute(select(OrderItem.id).where(OrderItem.bundle_id == bundle.id).limit(1)).first():
        raise ConflictError("This bundle has been ordered, so it's kept for the record. Archive it instead.",
                            error_code="BUNDLE_HAS_ORDERS")
    audit.record(db, "bundle.delete", resource_type="bundles", resource_id=bundle.id, actor=admin,
                 summary=f"Deleted bundle {bundle.name}", changes=audit.diff(audit.snapshot(bundle, AUDITED), {}))
    db.delete(bundle)
    db.commit()


# ------------------------------------------------------------- storefront


def _live(db: Session):
    now = datetime.utcnow()
    return (select(Bundle).options(selectinload(Bundle.items))
            .where(Bundle.status == "active",
                   (Bundle.starts_at.is_(None)) | (Bundle.starts_at <= now),
                   (Bundle.ends_at.is_(None)) | (Bundle.ends_at > now)))


def storefront_list(db: Session, *, product_id: Optional[str] = None, limit: int = 48) -> List[dict]:
    query = _live(db)
    if product_id:
        query = query.where(Bundle.id.in_(select(BundleItem.bundle_id).where(BundleItem.product_id == product_id)))
    bundles = db.execute(query.order_by(Bundle.updated_at.desc()).limit(limit)).scalars().all()
    products = _products(db, [i.product_id for b in bundles for i in b.items])
    rows = []
    for bundle in bundles:
        if any(products.get(i.product_id) is None or products[i.product_id].status not in SELLABLE
               for i in bundle.items):
            continue
        rows.append(view(db, bundle, products=products))
    return rows


def storefront_detail(db: Session, slug: str) -> dict:
    bundle = db.execute(_live(db).where(Bundle.slug == slug)).scalar_one_or_none()
    if bundle is None:
        raise NotFoundError("That bundle isn't available.", error_code="BUNDLE_NOT_FOUND")
    return view(db, bundle)


# -------------------------------------------------------------- the bag


def _clean_selections(bundle: Bundle, products: Dict[str, Product], selections) -> List[dict]:
    """One size and colour per component, each one the product really comes in."""
    given = {}
    for row in selections or []:
        if not isinstance(row, dict):
            continue
        pid = str(row.get("productId") or "")
        if pid not in {i.product_id for i in bundle.items}:
            raise ValidationError("That choice isn't part of this bundle.", error_code="INVALID_SELECTION")
        given[pid] = row
    clean = []
    for item in bundle.items:
        product = products[item.product_id]
        row = given.get(product.id, {})
        size = str(row.get("size") or "")[:30]
        color = str(row.get("color") or "")[:60]
        sizes = [s.label for s in product.sizes]
        colours = [c.name for c in product.colors]
        if sizes and not size:
            raise ValidationError(f"Choose a size for {product.name}.", error_code="SIZE_REQUIRED")
        if size and sizes and size not in sizes:
            raise ValidationError(f"{product.name} does not come in {size}.", error_code="SIZE_UNAVAILABLE")
        if color and colours and color not in colours:
            raise ValidationError(f"{product.name} does not come in {color}.", error_code="COLOR_UNAVAILABLE")
        clean.append({"productId": product.id, "size": size, "color": color or (colours[0] if colours else "")})
    return clean


def add_to_cart(db: Session, customer: Customer, bundle_id: int, quantity: int, selections) -> CartBundle:
    from app.services import cart_recovery

    bundle = db.execute(_live(db).where(Bundle.id == bundle_id)).scalar_one_or_none()
    if bundle is None:
        raise NotFoundError("That bundle isn't available.", error_code="BUNDLE_NOT_FOUND")
    products = _products(db, [i.product_id for i in bundle.items])
    quote = pricing.quote_bundle(bundle, products)
    if quote.reason:
        raise ConflictError(quote.reason, error_code="BUNDLE_UNAVAILABLE")
    if quantity <= 0:
        raise ValidationError("A quantity must be at least 1.", error_code="INVALID_QUANTITY")
    clean = _clean_selections(bundle, products, selections)
    key = pricing.selection_key(clean)
    existing = db.execute(select(CartBundle).where(CartBundle.customer_id == customer.id,
                                                   CartBundle.bundle_id == bundle.id,
                                                   CartBundle.selection_key == key)).scalar_one_or_none()
    wanted = (existing.quantity if existing else 0) + quantity
    capped = max(1, min(wanted, bundle.max_per_order, quote.available))
    now = datetime.utcnow()
    if existing:
        existing.quantity, existing.updated_at = capped, now
        entry = existing
    else:
        entry = CartBundle(customer_id=customer.id, bundle_id=bundle.id, quantity=capped, selections=clean,
                           selection_key=key, created_at=now, updated_at=now)
        db.add(entry)
    cart_recovery.touch(db, customer.id)
    db.flush()
    _record_add(db, customer, bundle, capped)
    db.commit()
    db.refresh(entry)
    return entry


def _record_add(db: Session, customer: Customer, bundle: Bundle, quantity: int) -> None:
    from app.services import analytics_events

    for item in bundle.items:
        analytics_events.server_event(db, "add_to_cart", customer_id=customer.id, product_id=item.product_id,
                                      quantity=item.quantity * quantity)


def update_quantity(db: Session, customer: Customer, entry_id: int, quantity: int) -> None:
    from app.services import cart_recovery

    entry = db.get(CartBundle, entry_id)
    if entry is None or entry.customer_id != customer.id:
        raise NotFoundError("That bundle is not in your bag.", error_code="CART_BUNDLE_NOT_FOUND")
    if quantity <= 0:
        db.delete(entry)
    else:
        bundle = _load(db, entry.bundle_id)
        quote = pricing.quote_bundle(bundle, _products(db, [i.product_id for i in bundle.items]))
        entry.quantity = max(1, min(quantity, bundle.max_per_order, max(1, quote.available)))
        entry.updated_at = datetime.utcnow()
    cart_recovery.touch(db, customer.id)
    db.commit()


def remove(db: Session, customer: Customer, entry_id: int) -> None:
    update_quantity(db, customer, entry_id, 0)


def load_cart_bundles(db: Session, customer_id: str) -> List[CartBundle]:
    return list(db.execute(
        select(CartBundle).options(selectinload(CartBundle.bundle).selectinload(Bundle.items))
        .where(CartBundle.customer_id == customer_id).order_by(CartBundle.created_at, CartBundle.id)
    ).scalars().all())
