"""Categories and collections."""

from __future__ import annotations

from typing import List, Optional, Tuple

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import Category, Collection, CollectionProduct, Product
from app.schemas.catalogue import CategoryWrite, CollectionWrite
from app.utils.ids import next_id, slugify

PUBLISHED = ("active", "out-of-stock")


# ------------------------------------------------------------ categories


def list_categories(db: Session, *, with_counts: bool = False) -> List[Tuple[Category, int]]:
    """
    Every category, optionally with how many products each holds.

    Counted in one grouped query rather than one per category — eleven extra
    round trips to render a menu is eleven too many.
    """
    categories = db.execute(select(Category).order_by(Category.display_order)).scalars().all()

    if not with_counts:
        return [(category, 0) for category in categories]

    counts = dict(
        db.execute(
            select(Product.category_id, func.count(Product.id))
            .where(Product.status.in_(PUBLISHED))
            .group_by(Product.category_id)
        ).all()
    )

    return [(category, counts.get(category.id, 0)) for category in categories]


def get_category(db: Session, identifier: str) -> Category:
    category = db.execute(
        select(Category).where((Category.id == identifier) | (Category.slug == identifier))
    ).scalar_one_or_none()

    if category is None:
        raise NotFoundError(f"No category '{identifier}'.", error_code="CATEGORY_NOT_FOUND")

    return category


def save_category(db: Session, payload: CategoryWrite, category_id: Optional[str] = None) -> Category:
    """
    Create or update.

    One function because the portal has one form: it either has an id to work
    against or it does not, and the fields are identical either way.
    """
    if category_id:
        category = get_category(db, category_id)
    else:
        if not payload.name:
            raise ValidationError("A category needs a name.", error_code="CATEGORY_INCOMPLETE")
        category = Category(id=next_id(db, Category, "category"), slug="", name="")
        db.add(category)

    provided = payload.model_dump(exclude_unset=True, by_alias=False)

    if payload.name is not None:
        category.name = payload.name
    if payload.slug is not None or not category.slug:
        category.slug = _unique_category_slug(
            db, payload.slug or payload.name or category.name, ignore_id=category.id
        )
    if "description" in provided:
        category.description = payload.description or ""
    if "image" in provided:
        category.image = payload.image or ""
    if "order" in provided and payload.order is not None:
        category.display_order = payload.order
    if "featured" in provided and payload.featured is not None:
        category.featured = payload.featured
    if payload.groups is not None:
        category.groups = [group.model_dump(by_alias=True) for group in payload.groups]

    db.commit()
    db.refresh(category)
    return category


def _unique_category_slug(db: Session, desired: str, *, ignore_id: Optional[str]) -> str:
    base = slugify(desired) or "category"
    candidate = base
    counter = 2

    while True:
        clash = db.execute(
            select(Category.id).where(Category.slug == candidate, Category.id != ignore_id)
        ).scalar_one_or_none()
        if clash is None:
            return candidate
        candidate = f"{base}-{counter}"
        counter += 1


def delete_category(db: Session, category_id: str) -> None:
    """
    Remove a category.

    **Refused while products reference it.** A product must belong to a
    department; deleting the department out from under it would leave the
    catalogue unreachable from the menu, which is a worse outcome than a
    refused click.
    """
    category = get_category(db, category_id)

    in_use = db.execute(
        select(func.count()).select_from(Product).where(Product.category_id == category.id)
    ).scalar_one()

    if in_use:
        raise ConflictError(
            f"{category.name} still has {in_use} product(s). Move them first.",
            error_code="CATEGORY_IN_USE",
        )

    db.delete(category)
    db.commit()


# ----------------------------------------------------------- collections


def list_collections(db: Session) -> List[Collection]:
    return list(
        db.execute(
            select(Collection).options(selectinload(Collection.items)).order_by(Collection.id)
        )
        .unique()
        .scalars()
        .all()
    )


def get_collection(db: Session, identifier: str) -> Collection:
    collection = db.execute(
        select(Collection)
        .options(selectinload(Collection.items))
        .where((Collection.id == identifier) | (Collection.slug == identifier))
    ).unique().scalar_one_or_none()

    if collection is None:
        raise NotFoundError(f"No collection '{identifier}'.", error_code="COLLECTION_NOT_FOUND")

    return collection


def save_collection(
    db: Session, payload: CollectionWrite, collection_id: Optional[str] = None
) -> Collection:
    if collection_id:
        collection = get_collection(db, collection_id)
    else:
        if not payload.name:
            raise ValidationError("A collection needs a name.", error_code="COLLECTION_INCOMPLETE")
        collection = Collection(id=next_id(db, Collection, "collection"), slug="", name="")
        db.add(collection)

    provided = payload.model_dump(exclude_unset=True, by_alias=False)

    if payload.name is not None:
        collection.name = payload.name
    if payload.slug is not None or not collection.slug:
        collection.slug = slugify(payload.slug or payload.name or collection.name)
    for field in ("tagline", "description", "image"):
        if field in provided:
            setattr(collection, field, provided[field] or "")
    if "featured" in provided and payload.featured is not None:
        collection.featured = payload.featured

    if payload.product_ids is not None:
        # Membership is replaced wholesale and de-duplicated. Order is
        # editorial, so the position is the order the ids arrived in.
        known = set(
            db.execute(select(Product.id).where(Product.id.in_(payload.product_ids)))
            .scalars()
            .all()
        )
        collection.items = [
            CollectionProduct(product_id=product_id, position=index)
            for index, product_id in enumerate(dict.fromkeys(payload.product_ids))
            if product_id in known
        ]

    db.commit()
    db.refresh(collection)
    return collection


def delete_collection(db: Session, collection_id: str) -> None:
    """
    Remove a collection.

    Safe to delete outright, unlike a category: membership is a join row, so
    removing the collection removes the grouping and leaves every product
    exactly where it was.
    """
    collection = get_collection(db, collection_id)
    db.delete(collection)
    db.commit()
