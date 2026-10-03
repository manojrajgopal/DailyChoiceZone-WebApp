"""
Store-chosen product relationships, managed in the portal.

"On the steel plate's page, show the bowl, the spoon and the glass" — one row
each, in the order the store wants, by type (`related`, `similar`,
`frequently-bought-together`, `alternative`, `accessory`). The storefront puts
these ahead of anything worked out automatically (`services.recommendations`).

Every write forgets the cached recommendation rankings, so the change shows on
the next page view.
"""

from __future__ import annotations

from typing import Iterable, List, Optional

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import Product, ProductRelationship
from app.models.discovery import RELATIONSHIP_TYPES
from app.services import recommendations

MAX_PER_TYPE = 40


def _product(db: Session, product_id: str) -> Product:
    product = db.get(Product, product_id)
    if product is None:
        raise NotFoundError("No such product.", error_code="PRODUCT_NOT_FOUND")
    return product


def _type(value: Optional[str]) -> str:
    kind = (value or "related").strip()
    if kind not in RELATIONSHIP_TYPES:
        raise ValidationError(f"Type must be one of: {', '.join(RELATIONSHIP_TYPES)}.",
                              error_code="INVALID_RELATIONSHIP_TYPE")
    return kind


def view(row: ProductRelationship, related: Optional[Product]) -> dict:
    return {
        "id": row.id,
        "productId": row.product_id,
        "relatedProductId": row.related_product_id,
        "type": row.type,
        "position": row.position,
        "active": row.active,
        "createdBy": row.created_by,
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
        "related": None if related is None else {
            "id": related.id, "name": related.name, "sku": related.sku, "status": related.status,
            "price": float(related.price), "stock": related.available_stock,
            "image": related.images[0].url if related.images else "",
        },
    }


def listing(db: Session, product_id: str, *, kind: Optional[str] = None) -> List[dict]:
    """Every relationship from this product, by type and position, with the other product summarised."""
    _product(db, product_id)
    statement = select(ProductRelationship).where(ProductRelationship.product_id == product_id)
    if kind:
        statement = statement.where(ProductRelationship.type == _type(kind))
    rows = db.execute(statement.order_by(ProductRelationship.type, ProductRelationship.position,
                                         ProductRelationship.id)).scalars().all()
    others = {p.id: p for p in db.execute(
        select(Product).where(Product.id.in_([r.related_product_id for r in rows]))).scalars()} if rows else {}
    return [view(r, others.get(r.related_product_id)) for r in rows]


def _next_position(db: Session, product_id: str, kind: str) -> int:
    highest = db.execute(select(func.max(ProductRelationship.position)).where(
        ProductRelationship.product_id == product_id, ProductRelationship.type == kind)).scalar_one()
    return 0 if highest is None else int(highest) + 1


def _count(db: Session, product_id: str, kind: str) -> int:
    return int(db.execute(select(func.count()).select_from(ProductRelationship).where(
        ProductRelationship.product_id == product_id, ProductRelationship.type == kind)).scalar_one())


def create(db: Session, product_id: str, payload: dict, *, actor: str = "") -> List[ProductRelationship]:
    """
    Relate `relatedProductIds` (or one `relatedProductId`) to this product.

    Refuses the product itself and an unknown product; a pair that already has
    this type is reported as a conflict rather than silently ignored, so the
    portal can say so. `reciprocal: true` adds the reverse too, where it is
    missing.
    """
    product = _product(db, product_id)
    kind = _type(payload.get("type"))
    raw = payload.get("relatedProductIds") or ([payload["relatedProductId"]] if payload.get("relatedProductId")
                                               else [])
    wanted = [str(pid).strip() for pid in dict.fromkeys(raw) if str(pid).strip()]
    if not wanted:
        raise ValidationError("Choose at least one product to relate.", error_code="RELATED_PRODUCT_REQUIRED")
    if product.id in wanted:
        raise ValidationError("A product can't be related to itself.", error_code="SELF_RELATIONSHIP")
    found = {p.id: p for p in db.execute(select(Product).where(Product.id.in_(wanted))).scalars()}
    missing = [pid for pid in wanted if pid not in found]
    if missing:
        raise NotFoundError(f"Unknown products: {', '.join(missing)}.", error_code="PRODUCT_NOT_FOUND")
    existing = set(db.execute(select(ProductRelationship.related_product_id).where(
        ProductRelationship.product_id == product.id, ProductRelationship.type == kind,
        ProductRelationship.related_product_id.in_(wanted))).scalars())
    if existing:
        names = ", ".join(found[pid].name for pid in wanted if pid in existing)
        raise ConflictError(f"Already related as {kind}: {names}.", error_code="DUPLICATE_RELATIONSHIP")
    if _count(db, product.id, kind) + len(wanted) > MAX_PER_TYPE:
        raise ValidationError(f"Up to {MAX_PER_TYPE} {kind} products per product.", error_code="TOO_MANY")

    active = payload.get("active", True) is not False
    position = _next_position(db, product.id, kind)
    created = []
    try:
        for offset, pid in enumerate(wanted):
            row = ProductRelationship(product_id=product.id, related_product_id=pid, type=kind,
                                      position=position + offset, active=active, created_by=actor)
            db.add(row)
            created.append(row)
            if payload.get("reciprocal"):
                back = db.execute(select(ProductRelationship.id).where(
                    ProductRelationship.product_id == pid, ProductRelationship.related_product_id == product.id,
                    ProductRelationship.type == kind)).first()
                if back is None and _count(db, pid, kind) < MAX_PER_TYPE:
                    db.add(ProductRelationship(product_id=pid, related_product_id=product.id, type=kind,
                                               position=_next_position(db, pid, kind), active=active,
                                               created_by=actor))
            db.flush()
    except IntegrityError:
        db.rollback()
        raise ConflictError("That relationship was just added by someone else.",
                            error_code="DUPLICATE_RELATIONSHIP") from None
    recommendations.invalidate()
    return created


def _owned(db: Session, product_id: str, relationship_id: int) -> ProductRelationship:
    row = db.get(ProductRelationship, relationship_id)
    if row is None or row.product_id != product_id:
        raise NotFoundError("No such relationship on this product.", error_code="RELATIONSHIP_NOT_FOUND")
    return row


def update(db: Session, product_id: str, relationship_id: int, payload: dict) -> ProductRelationship:
    """Switch a relationship on or off, or change its type (moved to the end of the new type)."""
    row = _owned(db, product_id, relationship_id)
    if "active" in payload:
        row.active = bool(payload["active"])
    if "type" in payload:
        kind = _type(payload["type"])
        if kind != row.type:
            clash = db.execute(select(ProductRelationship.id).where(
                ProductRelationship.product_id == product_id, ProductRelationship.type == kind,
                ProductRelationship.related_product_id == row.related_product_id)).first()
            if clash is not None:
                raise ConflictError(f"Already related as {kind}.", error_code="DUPLICATE_RELATIONSHIP")
            row.type = kind
            row.position = _next_position(db, product_id, kind)
    db.flush()
    recommendations.invalidate()
    return row


def delete(db: Session, product_id: str, relationship_id: int) -> None:
    db.delete(_owned(db, product_id, relationship_id))
    db.flush()
    recommendations.invalidate()


def reorder(db: Session, product_id: str, kind: str, ordered_ids: Iterable[int]) -> List[dict]:
    """Set the order of one type's relationships: `ordered_ids` must be exactly that type's ids."""
    _product(db, product_id)
    kind = _type(kind)
    ids = [int(i) for i in ordered_ids]
    rows = {r.id: r for r in db.execute(select(ProductRelationship).where(
        ProductRelationship.product_id == product_id, ProductRelationship.type == kind)).scalars()}
    if len(ids) != len(set(ids)) or set(ids) != set(rows):
        raise ValidationError("Send every relationship of this type exactly once.", error_code="INVALID_ORDER")
    for position, rid in enumerate(ids):
        rows[rid].position = position
    db.flush()
    recommendations.invalidate()
    return listing(db, product_id, kind=kind)
