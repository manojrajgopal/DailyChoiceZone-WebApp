"""Product business rules."""

from __future__ import annotations

import math
from datetime import datetime
from typing import List, Optional, Tuple

from sqlalchemy import func, select
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
    """`DCZ-WO0140` — the prefix names the department, the number is sequential."""
    letters = (category_slug[:2] or "XX").upper()
    count = db.execute(select(func.count()).select_from(Product)).scalar_one()
    candidate = f"DCZ-{letters}{count + 1:04d}"

    bump = count + 1
    while repo.sku_exists(db, candidate):
        bump += 1
        candidate = f"DCZ-{letters}{bump:04d}"

    return candidate


def _resolve_category(db: Session, identifier: str) -> Category:
    """Accept a slug or an id — the storefront speaks slugs, the portal ids."""
    category = db.execute(
        select(Category).where((Category.slug == identifier) | (Category.id == identifier))
    ).scalar_one_or_none()

    if category is None:
        raise ValidationError(f"No category '{identifier}'.", error_code="CATEGORY_NOT_FOUND")

    return category


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


# ---------------------------------------------------------------- writing


def _apply_children(db: Session, product: Product, payload: ProductWrite) -> None:
    """
    Replace the child collections the payload mentions.

    Absent means "leave alone"; present means "this is now the whole list".
    Merging instead would make it impossible to remove the last image.
    """
    if payload.images is not None:
        product.images = [
            ProductImage(url=url, position=index) for index, url in enumerate(payload.images)
        ]

    if payload.colors is not None:
        product.colors = [
            ProductColor(name=color.name, hex=color.hex, position=index)
            for index, color in enumerate(payload.colors)
        ]

    if payload.sizes is not None:
        product.sizes = [
            ProductSize(label=label, position=index) for index, label in enumerate(payload.sizes)
        ]

    if payload.specifications is not None:
        product.specifications = [
            ProductSpecification(label=spec.label, value=spec.value, position=index)
            for index, spec in enumerate(payload.specifications)
        ]

    if payload.tags is not None:
        product.tags = [ProductTag(tag=tag) for tag in dict.fromkeys(payload.tags)]


def create_product(db: Session, payload: ProductWrite, actor: Optional[str] = None) -> Product:
    """Create one. Required fields are checked here, not in the schema — see `ProductWrite`."""
    missing = [
        name
        for name, value in (
            ("name", payload.name),
            ("category", payload.category),
            ("price", payload.price),
        )
        if not value
    ]
    if missing:
        raise ValidationError(
            f"Missing required field(s): {', '.join(missing)}.",
            error_code="PRODUCT_INCOMPLETE",
        )

    category = _resolve_category(db, payload.category)
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

    db.add(product)
    db.commit()
    db.refresh(product)
    return product


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
    provided = payload.model_dump(exclude_unset=True, by_alias=False)

    if "category" in provided and payload.category:
        product.category_id = _resolve_category(db, payload.category).id

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

    product.updated_by = actor or product.updated_by
    db.commit()
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
        meta_title=source.meta_title,
        meta_description=source.meta_description,
        is_new=False,
        is_trending=False,
        is_best_seller=False,
        is_featured=False,
        updated_by=actor,
    )

    copy.images = [ProductImage(url=i.url, position=i.position) for i in source.images]
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

    product.stock = quantity
    if product.status in ("active", "out-of-stock"):
        available = max(0, quantity - product.reserved_stock)
        product.status = "active" if available > 0 else "out-of-stock"

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
    return product


def consume_stock(db: Session, product_id: str, quantity: int, order_id: str) -> None:
    """
    Take stock for a confirmed order.

    Called inside the order transaction, so it does not commit: if anything
    later in the order fails, this rolls back with it and the stock is never
    quietly consumed by an order that does not exist.

    Refuses to go negative — overselling is a promise the shop cannot keep.
    """
    product = db.get(Product, product_id)
    if product is None:
        raise NotFoundError(f"No product with id '{product_id}'.", error_code="PRODUCT_NOT_FOUND")

    if product.stock < quantity:
        raise ConflictError(
            f"Only {product.stock} of {product.name} left.",
            error_code="INSUFFICIENT_STOCK",
        )

    before = product.stock
    product.stock -= quantity

    if product.status == "active" and product.stock <= 0:
        product.status = "out-of-stock"

    db.add(
        StockAdjustment(
            product_id=product.id,
            reason="sale",
            quantity_before=before,
            quantity_after=product.stock,
            delta=-quantity,
            note=f"Order {order_id}",
            actor="system",
            created_at=datetime.utcnow(),
        )
    )
