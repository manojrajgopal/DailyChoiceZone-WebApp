"""Product business rules."""

from __future__ import annotations

import math
from datetime import datetime
from typing import List, Optional, Tuple

from sqlalchemy import func, inspect, select
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import (
    Category,
    OrderItem,
    Product,
    ProductColor,
    ProductImage,
    ProductSize,
    ProductSpecification,
    ProductTag,
    StockAdjustment,
)
from app.repositories import products as repo
from app.schemas.catalogue import ProductQuery, ProductWrite
from app.utils.ids import next_id, slugify


def _discount_percent(price: float, original_price: float) -> int:
    """
    Percent off, floored.

    Always derived, never accepted from a caller: a stored discount that does
    not match the prices beside it is a badge that lies, and it is the first
    thing a customer notices.
    """
    if original_price <= 0 or original_price <= price:
        return 0
    return math.floor(((original_price - price) / original_price) * 100)


def unique_slug(db: Session, desired: str, *, ignore_id: Optional[str] = None) -> str:
    """A slug nothing else is using, suffixing only when it has to."""
    base = slugify(desired) or "product"
    if not repo.slug_exists(db, base, ignore_id=ignore_id):
        return base

    counter = 2
    while repo.slug_exists(db, f"{base}-{counter}", ignore_id=ignore_id):
        counter += 1
    return f"{base}-{counter}"


def _next_sku(db: Session, category_slug: str) -> str:
    """
    A generated SKU: the store's prefix, the department, a sequence.

    The prefix is fixed (`app.core.numbering`), and the sequence grows past
    four digits rather than wrapping. Only reached when somebody leaves the SKU
    field blank — a product listed with a real supplier code keeps it.
    """
    from app.core import numbering

    lead = f"{numbering.SKU_PREFIX}-"
    letters = (category_slug[:2] or "XX").upper()

    count = db.execute(select(func.count()).select_from(Product)).scalar_one()
    bump = count + 1
    candidate = f"{lead}{letters}{bump:04d}"

    while repo.sku_exists(db, candidate):
        bump += 1
        candidate = f"{lead}{letters}{bump:04d}"

    return candidate


def _resolve_category(db: Session, identifier: str) -> Category:
    """Accept a slug or an id — the storefront speaks slugs, the portal ids."""
    category = db.execute(
        select(Category).where((Category.slug == identifier) | (Category.id == identifier))
    ).scalar_one_or_none()

    if category is None:
        raise ValidationError(f"No category '{identifier}'.", error_code="CATEGORY_NOT_FOUND")

    return category


def _resolve_category_id(db: Session, raw: str) -> Category:
    """The category that Category ID names, exactly (`CAT001`, never a slug or `CAT0010`)."""
    from app.services.lookup.filters import id_condition

    condition = id_condition("category", raw)
    category = (
        db.execute(select(Category).where(condition)).scalar_one_or_none() if condition is not None else None
    )
    if category is None:
        raise ValidationError(
            f"Category ID {(raw or '').strip()} was not found.",
            error_code="CATEGORY_NOT_FOUND",
            details={"field": "categoryId"},
        )
    return category


def _category_for(db: Session, payload: ProductWrite) -> Optional[Category]:
    """
    The category a write names: `category_id` (exact Category ID) first, then
    the legacy `category` slug/id. None when the payload names neither.
    """
    if payload.category_id is not None and payload.category_id.strip():
        return _resolve_category_id(db, payload.category_id)
    if payload.category:
        return _resolve_category(db, payload.category)
    return None


# ---------------------------------------------------------------- reading


def list_products(db: Session, query: ProductQuery) -> Tuple[List[Product], int]:
    return repo.query_products(db, query)


def get_product(db: Session, product_id: str, *, published_only: bool = False) -> Product:
    product = repo.get_by_id(db, product_id, published_only=published_only)
    if product is None:
        raise NotFoundError(f"No product with id '{product_id}'.", error_code="PRODUCT_NOT_FOUND")
    return product


def get_product_by_slug(db: Session, slug: str, *, published_only: bool = True) -> Product:
    product = repo.get_by_slug(db, slug, published_only=published_only)
    if product is None:
        raise NotFoundError(f"No product at '{slug}'.", error_code="PRODUCT_NOT_FOUND")
    return product


def get_product_by_identifier(
    db: Session, identifier: str, *, published_only: bool = True
) -> Product:
    """By id or by slug — see `repo.get_by_identifier`."""
    product = repo.get_by_identifier(db, identifier, published_only=published_only)
    if product is None:
        raise NotFoundError(f"No product '{identifier}'.", error_code="PRODUCT_NOT_FOUND")
    return product


# ---------------------------------------------------------------- writing


def _replace(db: Session, product: Product, attribute: str, rows: list) -> None:
    """
    Make `rows` the whole of one child collection.

    On a saved product the old rows are deleted (flushed) before the new ones
    are added. In a single flush SQLAlchemy inserts before it deletes orphans,
    so keeping a tag the product already had would collide with its own old
    row on `uq_product_tag`.
    """
    if inspect(product).persistent and getattr(product, attribute):
        setattr(product, attribute, [])
        db.flush()
    setattr(product, attribute, rows)


def _apply_children(db: Session, product: Product, payload: ProductWrite) -> None:
    """
    Replace the child collections the payload mentions.

    Absent means "leave alone"; present means "this is now the whole list".
    Merging instead would make it impossible to remove the last image.
    """
    # Images and colours are rebuilt together: a colour's photographs are tied
    # to it by name, so replacing the colours replaces their images, and
    # replacing the shared images leaves every colour's own alone.
    if payload.images is not None or payload.colors is not None:
        shared = (
            list(payload.images)
            if payload.images is not None
            else [image.url for image in product.images if not image.color]
        )

        if payload.colors is not None:
            colours = list({color.name.strip(): color for color in payload.colors}.values())
            coloured = [(color.name.strip(), url) for color in colours for url in color.images]
            _replace(db, product, "colors", [
                ProductColor(name=color.name.strip(), hex=color.hex, position=index)
                for index, color in enumerate(colours)
            ])
        else:
            names = {color.name for color in product.colors}
            coloured = [
                (image.color, image.url)
                for image in product.images
                if image.color and image.color in names
            ]

        _replace(db, product, "images", [
            ProductImage(url=url, color="", position=index)
            for index, url in enumerate(dict.fromkeys(shared))
        ] + [
            ProductImage(url=url, color=name, position=index)
            for index, (name, url) in enumerate(coloured)
        ])

    if payload.sizes is not None:
        _replace(db, product, "sizes", [
            ProductSize(label=label, position=index) for index, label in enumerate(payload.sizes)
        ])

    if payload.specifications is not None:
        _replace(db, product, "specifications", [
            ProductSpecification(label=spec.label, value=spec.value, position=index)
            for index, spec in enumerate(payload.specifications)
        ])

    if payload.tags is not None:
        _replace(db, product, "tags", [ProductTag(tag=tag) for tag in dict.fromkeys(payload.tags)])


def create_product(db: Session, payload: ProductWrite, actor: Optional[str] = None) -> Product:
    """Create one. Required fields are checked here, not in the schema — see `ProductWrite`."""
    missing = [
        name
        for name, value in (
            ("name", payload.name),
            ("category", (payload.category_id or "").strip() or payload.category),
            ("price", payload.price),
        )
        if not value
    ]
    if missing:
        raise ValidationError(
            f"Missing required field(s): {', '.join(missing)}.",
            error_code="PRODUCT_INCOMPLETE",
        )

    category = _category_for(db, payload)
    price = float(payload.price)
    original_price = float(payload.original_price or price)

    product = Product(
        id=next_id(db, Product, "product"),
        slug=unique_slug(db, payload.slug or payload.name),
        sku=payload.sku or _next_sku(db, category.slug),
        name=payload.name,
        brand=payload.brand or "Daily Choice",
        category_id=category.id,
        subcategory=payload.subcategory or "",
        price=price,
        original_price=original_price,
        discount=_discount_percent(price, original_price),
        currency=payload.currency or "INR",
        is_returnable=True if payload.is_returnable is None else payload.is_returnable,
        is_replaceable=True if payload.is_replaceable is None else payload.is_replaceable,
        description=payload.description or "",
        material=payload.material or "",
        care=payload.care or "",
        is_new=payload.is_new if payload.is_new is not None else True,
        is_trending=bool(payload.is_trending),
        is_best_seller=bool(payload.is_best_seller),
        is_featured=bool(payload.is_featured),
        status=payload.status or "draft",
        stock=payload.stock or 0,
        reserved_stock=payload.reserved_stock or 0,
        low_stock_threshold=payload.low_stock_threshold or 8,
        barcode=payload.barcode or "",
        tax_rate_percent=payload.tax_rate_percent or 5,
        meta_title=payload.meta_title or f"{payload.name} | Daily Choice Zone",
        meta_description=payload.meta_description or (payload.description or "")[:155],
        updated_by=actor,
    )

    _apply_children(db, product, payload)
    _sync_status(product)

    db.add(product)
    db.commit()
    db.refresh(product)
    _catalogue_changed()
    _search_index_changed(db, product)
    return product


_NOT_NULL_FIELDS = {
    "name", "brand", "subcategory", "currency", "description", "material", "care", "is_new", "is_trending",
    "is_best_seller", "is_featured", "status", "stock", "reserved_stock", "low_stock_threshold", "barcode",
    "tax_rate_percent", "is_returnable", "is_replaceable", "meta_title", "meta_description", "price",
    "original_price",
}


def update_product(
    db: Session, product_id: str, payload: ProductWrite, actor: Optional[str] = None
) -> Product:
    """
    Apply whatever the payload contains.

    One endpoint changes a price, a category, a set of images or all three,
    which is why every field is optional. `model_dump(exclude_unset=True)` is
    what distinguishes "set this to null" from "do not touch it".
    """
    product = get_product(db, product_id)
    before_available = product.available_stock
    provided = payload.model_dump(exclude_unset=True, by_alias=False)
    old_price, old_original = float(product.price), float(product.original_price)

    # The scalar columns written below are all NOT NULL, so an explicit null is
    # a mistake to refuse, not a value to write: `float(None)` was a 500, and a
    # null name reached MySQL and came back as a misleading "already exists".
    # (category, slug, sku and the lists already treat null as "leave it".)
    nulled = sorted(field for field, value in provided.items() if value is None and field in _NOT_NULL_FIELDS)
    if nulled:
        raise ValidationError(
            f"These fields can't be empty: {', '.join(nulled)}.",
            error_code="PRODUCT_FIELD_REQUIRED",
            details={"fields": nulled},
        )

    category = _category_for(db, payload)
    if category is not None:
        product.category_id = category.id

    if "slug" in provided and payload.slug:
        product.slug = unique_slug(db, payload.slug, ignore_id=product.id)
    elif "name" in provided and payload.name and not product.slug:
        product.slug = unique_slug(db, payload.name, ignore_id=product.id)

    if "sku" in provided and payload.sku:
        if repo.sku_exists(db, payload.sku, ignore_id=product.id):
            raise ConflictError(f"SKU '{payload.sku}' is already in use.", error_code="SKU_TAKEN")
        product.sku = payload.sku

    simple = {
        "name": "name",
        "brand": "brand",
        "subcategory": "subcategory",
        "currency": "currency",
        "description": "description",
        "material": "material",
        "care": "care",
        "is_new": "is_new",
        "is_trending": "is_trending",
        "is_best_seller": "is_best_seller",
        "is_featured": "is_featured",
        "status": "status",
        "stock": "stock",
        "reserved_stock": "reserved_stock",
        "low_stock_threshold": "low_stock_threshold",
        "barcode": "barcode",
        "tax_rate_percent": "tax_rate_percent",
        "is_returnable": "is_returnable",
        "is_replaceable": "is_replaceable",
        "meta_title": "meta_title",
        "meta_description": "meta_description",
    }
    for field, attribute in simple.items():
        if field in provided:
            setattr(product, attribute, provided[field])

    if "price" in provided:
        product.price = float(payload.price)
    if "original_price" in provided:
        product.original_price = float(payload.original_price)

    # Re-derived whenever either price moved, so the badge cannot drift.
    if "price" in provided or "original_price" in provided:
        product.discount = _discount_percent(float(product.price), float(product.original_price))

    _apply_children(db, product, payload)

    # Whichever the admin changed, stock and status must agree: a restocked
    # product left "out of stock" shows Buy now but fails at checkout.
    if {"stock", "reserved_stock", "status"} & set(provided):
        _sync_status(product)
        _watch_stock(db, product, before_available)

    product.updated_by = actor or product.updated_by

    # A moved selling price is recorded for the price-drop alerts; a new
    # compare-at price alone is not a cheaper product.
    from app.services import alerts

    change = alerts.record_price_change(db, product, old_price=old_price, old_original=old_original,
                                        actor=actor or "system") if "price" in provided else None
    db.commit()
    db.refresh(product)
    _catalogue_changed()
    _search_index_changed(db, product)

    # Whoever was waiting for it — back in stock, or cheaper — hears now.
    if change is not None or {"stock", "reserved_stock", "status"} & set(provided):
        alerts.process_product(db, product.id, change_id=change.id if change is not None else None)
        db.refresh(product)
    return product


def delete_product(db: Session, product_id: str) -> None:
    """
    Remove a product.

    **Refused once it has been ordered.** An order line points at its product,
    and deleting it would either break that reference or erase the evidence of
    a sale. Archiving keeps both the history and the shopper's experience
    correct, so that is what the caller is told to do.
    """
    product = get_product(db, product_id)

    ordered = db.execute(
        select(func.count()).select_from(OrderItem).where(OrderItem.product_id == product_id)
    ).scalar_one()

    if ordered:
        raise ConflictError(
            f"{product.name} appears on {ordered} order line(s) and cannot be deleted. "
            "Archive it instead — it disappears from the storefront and the history stays intact.",
            error_code="PRODUCT_HAS_ORDERS",
        )

    db.delete(product)
    db.commit()
    _catalogue_changed()


def _catalogue_changed() -> None:
    """A product changed: cached recommendation rankings may no longer be right."""
    from app.services import recommendations

    recommendations.invalidate()


def _search_index_changed(db: Session, product: Product) -> None:
    """Search & filters: refresh the product's search text and dictionary words (best effort, logged)."""
    from app.services.search import index

    if index.refresh_quietly(db, [product.id]):
        db.refresh(product)


def duplicate_product(db: Session, product_id: str, actor: Optional[str] = None) -> Product:
    """
    Copy a product as a draft.

    A duplicate is a starting point, so it arrives unpublished with its
    merchandising flags cleared — a copy that inherited "Best seller" would be
    claiming something it has not earned.
    """
    source = get_product(db, product_id)

    copy = Product(
        id=next_id(db, Product, "product"),
        slug=unique_slug(db, f"{source.slug}-copy"),
        sku=_next_sku(db, source.category.slug if source.category else "XX"),
        name=f"{source.name} (copy)",
        brand=source.brand,
        category_id=source.category_id,
        subcategory=source.subcategory,
        price=source.price,
        original_price=source.original_price,
        discount=source.discount,
        currency=source.currency,
        description=source.description,
        material=source.material,
        care=source.care,
        status="draft",
        stock=source.stock,
        reserved_stock=0,
        low_stock_threshold=source.low_stock_threshold,
        barcode="",
        tax_rate_percent=source.tax_rate_percent,
        is_returnable=source.is_returnable,
        is_replaceable=source.is_replaceable,
        meta_title=source.meta_title,
        meta_description=source.meta_description,
        is_new=False,
        is_trending=False,
        is_best_seller=False,
        is_featured=False,
        updated_by=actor,
    )

    copy.images = [
        ProductImage(url=i.url, color=i.color, position=i.position) for i in source.images
    ]
    copy.colors = [ProductColor(name=c.name, hex=c.hex, position=c.position) for c in source.colors]
    copy.sizes = [ProductSize(label=s.label, position=s.position) for s in source.sizes]
    copy.specifications = [
        ProductSpecification(label=s.label, value=s.value, position=s.position)
        for s in source.specifications
    ]
    copy.tags = [ProductTag(tag=t.tag) for t in source.tags]

    db.add(copy)
    db.commit()
    db.refresh(copy)
    _search_index_changed(db, copy)
    return copy


# -------------------------------------------------------------- inventory


def adjust_stock(
    db: Session,
    product_id: str,
    *,
    quantity: int,
    reason: str,
    note: str = "",
    actor: str = "system",
) -> Product:
    """
    Set a product's stock, and record why.

    The status follows the number: a product that runs out becomes
    `out-of-stock` and one that is restocked becomes `active` again. Leaving an
    administrator to remember both is how a restocked product stays invisible.

    Drafts and archived products keep their status — they are not hidden
    because of stock, and restocking one must not publish it.
    """
    if quantity < 0:
        raise ValidationError("Stock cannot be negative.", error_code="NEGATIVE_STOCK")

    product = get_product(db, product_id)
    before = product.stock
    before_available = product.available_stock

    product.stock = quantity
    _sync_status(product)
    _watch_stock(db, product, before_available)

    db.add(
        StockAdjustment(
            product_id=product.id,
            reason=reason,
            quantity_before=before,
            quantity_after=quantity,
            delta=quantity - before,
            note=note,
            actor=actor,
            created_at=datetime.utcnow(),
        )
    )

    db.commit()
    db.refresh(product)

    from app.services import alerts

    alerts.process_product(db, product.id)
    db.refresh(product)
    return product


# --------------------------------------------------------------- stock
#
# Four operations, and every one of them reads the product row **under a lock**.
#
# The version these replace read the stock, checked it, and wrote it back — with
# nothing stopping a second order reading the same row in between. Two shoppers
# buying the last unit both read `stock = 1`, both passed the check, and both
# wrote `0`: one unit sold twice, and invisibly, because the result was a
# perfectly ordinary zero rather than a negative number anybody would notice.
#
# `SELECT … FOR UPDATE` makes the second reader wait until the first has
# committed, so it sees the stock the first one left behind and fails the check
# honestly. Callers lock their products in a single, sorted order —
# `lock_products` — so two carts sharing items cannot each hold one lock the
# other is waiting for.
#
# And the check is against **available** stock — what is on the shelf minus what
# is held for payments still in progress — not the raw count. A unit someone is
# paying for right now is not for sale.


def lock_products(db: Session, product_ids) -> dict:
    """
    Lock these products for the rest of the transaction, in id order.

    The ordering is the point. Two transactions that lock the same rows in
    different orders can each end up holding one lock the other needs, and the
    database resolves that by killing one of them. Always taking them sorted
    means the second simply waits its turn.
    """
    ids = sorted(set(product_ids))
    if not ids:
        return {}

    rows = db.execute(
        select(Product)
        .where(Product.id.in_(ids))
        .order_by(Product.id)
        .with_for_update()
        # Without this the lock is taken on the fresh row and the *stale* copy
        # is handed back. The cart query that runs just before this loads each
        # product into the session, and SQLAlchemy returns that cached object
        # from a locking select rather than overwriting it — so the code would
        # read the stock as it was before the other order committed, pass the
        # check, and sell the same unit twice. The concurrency test caught
        # exactly that.
        .execution_options(populate_existing=True)
    ).scalars().all()
    return {row.id: row for row in rows}


def receive_stock(
    db: Session,
    product_id: str,
    *,
    quantity: int,
    reason: str = "purchase-receipt",
    note: str = "",
    actor: str = "system",
) -> Product:
    """
    Add `quantity` units to stock: goods received from a supplier.

    The increment counterpart of `adjust_stock`, for callers that add rather
    than set: a locked read of the row (so a sale committing meanwhile isn't
    overwritten), the same ledger row, the same status rule. **Doesn't commit**:
    a goods receipt adds several products in one transaction, and either all of
    it lands or none of it does. Back-in-stock alerts are the caller's to run
    after its commit (`alerts.process_product`).
    """
    if quantity <= 0:
        raise ValidationError("The quantity received must be above zero.", error_code="INVALID_QUANTITY")

    product = _locked(db, product_id)
    before = product.stock
    product.stock = before + quantity
    _sync_status(product)

    db.add(
        StockAdjustment(
            product_id=product.id,
            reason=reason,
            quantity_before=before,
            quantity_after=product.stock,
            delta=quantity,
            note=note[:500],
            actor=actor[:40],
            created_at=datetime.utcnow(),
        )
    )
    db.flush()
    return product


def _locked(db: Session, product_id: str) -> Product:
    # Write what this transaction has already changed first. The locking read
    # below refreshes the row from the database (`populate_existing`), which
    # would otherwise throw away an unflushed change — the stock an earlier
    # line of the same order just took — and let two lines of one product
    # (two sizes, or a bundle and a loose item) sell the same unit twice.
    db.flush()
    product = db.execute(
        select(Product)
        .where(Product.id == product_id)
        .with_for_update()
        # See `lock_products`: a locking read must refresh the cached copy.
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if product is None:
        raise NotFoundError(f"No product with id '{product_id}'.", error_code="PRODUCT_NOT_FOUND")
    return product


def _available(product: Product) -> int:
    return max(0, product.stock - (product.reserved_stock or 0))


def _refuse_if_short(product: Product, quantity: int) -> None:
    available = _available(product)
    if quantity > available:
        raise ConflictError(
            f"Only {available} of {product.name} left." if available else f"{product.name} is sold out.",
            error_code="INSUFFICIENT_STOCK",
        )


def _ledger(db: Session, product: Product, *, reason: str, before: int, delta: int, note: str) -> None:
    db.add(
        StockAdjustment(
            product_id=product.id,
            reason=reason,
            quantity_before=before,
            quantity_after=product.stock,
            delta=delta,
            note=note,
            actor="system",
            created_at=datetime.utcnow(),
        )
    )


def _stock_level(available: int, threshold: int) -> int:
    """2 in stock, 1 running low, 0 out of stock."""
    return 0 if available <= 0 else (1 if available <= (threshold or 0) else 2)


def _watch_stock(db: Session, product: Product, before_available: int) -> None:
    """
    Tell the store team when a product on sale runs low or runs out — once, at
    the moment it crosses the line, not on every sale after. Settings →
    Notifications → Low stock alerts switches it off.
    """
    if product.status not in ("active", "out-of-stock"):
        return
    threshold = product.low_stock_threshold or 0
    before, after = _stock_level(before_available, threshold), _stock_level(product.available_stock, threshold)
    if after >= before:
        return
    from app.services import inbox

    day = datetime.utcnow().strftime("%Y%m%d")
    href = f"/admin/inventory?productId={product.id}"
    if after == 0:
        inbox.staff(db, "stock", f"Out of stock: {product.name}",
                    f"{product.sku} has none left to sell. Restock it, or customers can only ask to be told "
                    "when it's back.", href, permission="products", key=f"stock:{product.id}:out:{day}")
    else:
        inbox.staff(db, "stock", f"Running low: {product.name}",
                    f"{product.sku} has {product.available_stock} left (alert at {threshold}).", href,
                    permission="products", key=f"stock:{product.id}:low:{day}")


def _sync_status(product: Product) -> None:
    """
    Keep the listing status in step with what can actually be bought: an active
    product with nothing available is `out-of-stock`, and an `out-of-stock` one
    with units to sell is `active` again. Drafts and archived products keep
    their status, so restocking one doesn't publish it.
    """
    if product.status in ("active", "out-of-stock"):
        product.status = "active" if product.available_stock > 0 else "out-of-stock"


def consume_stock(db: Session, product_id: str, quantity: int, order_id: str) -> None:
    """
    Take stock outright — cash on delivery, or a payment that settled at once.

    Called inside the order transaction and never commits: if anything later in
    the order fails, the stock comes back with the rollback.
    """
    if quantity <= 0:
        raise ValidationError("A quantity must be positive.", error_code="INVALID_QUANTITY")

    product = _locked(db, product_id)
    _refuse_if_short(product, quantity)

    before = product.stock
    before_available = product.available_stock
    product.stock -= quantity
    _sync_status(product)
    _ledger(db, product, reason="sale", before=before, delta=-quantity, note=f"Order {order_id}")
    _watch_stock(db, product, before_available)


def reserve_stock(db: Session, product_id: str, quantity: int, order_id: str) -> None:
    """
    Hold stock for an order whose payment has not arrived yet.

    Nothing leaves the shelf: `stock` is untouched and `reserved_stock` goes up,
    so the unit stops being *available* without being *sold*. The inventory
    screen already shows both figures. The hold becomes a sale when the money
    arrives (`commit_reservation`) or is handed back if it never does
    (`release_reservation`).

    Not written to the ledger, because nothing has moved. The ledger records
    the sale when there is one.
    """
    if quantity <= 0:
        raise ValidationError("A quantity must be positive.", error_code="INVALID_QUANTITY")

    product = _locked(db, product_id)
    _refuse_if_short(product, quantity)
    before_available = product.available_stock
    product.reserved_stock = (product.reserved_stock or 0) + quantity
    _watch_stock(db, product, before_available)


def commit_reservation(db: Session, product_id: str, quantity: int, order_id: str) -> None:
    """
    The payment arrived: the held units are sold.

    Both figures move together — the stock goes down and the hold is released —
    so the product's *available* count does not change at this moment. It
    already changed when the hold was taken.
    """
    product = _locked(db, product_id)

    before = product.stock
    product.stock = max(0, product.stock - quantity)
    product.reserved_stock = max(0, (product.reserved_stock or 0) - quantity)
    _sync_status(product)
    _ledger(db, product, reason="sale", before=before, delta=-quantity, note=f"Order {order_id}")


def release_reservation(db: Session, product_id: str, quantity: int, order_id: str) -> None:
    """
    The payment never came: hand the held units back.

    `stock` is untouched because nothing was ever taken from it. Clamped at
    zero rather than trusted, so a release that somehow runs twice cannot drive
    the hold negative and conjure stock that does not exist.
    """
    product = _locked(db, product_id)
    product.reserved_stock = max(0, (product.reserved_stock or 0) - quantity)
