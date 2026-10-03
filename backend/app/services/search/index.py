"""
`product_search_index`: each product's `search_text` and `units_sold`.

`search_text` holds what search must match that lives in other tables (the
category and collection names, colour names, specification values and
searchable attribute values). It is refreshed for one product when that
product or its attribute values are saved, and for the whole catalogue by the
`search` job and by "Rebuild now".

Refreshing on save is **best effort**: it runs in a savepoint and a failure is
logged, never raised. The product itself was saved; a stale index entry only
means a product is found by its own columns until the next rebuild, while a
product save that failed because of the search index would be a real outage.

`units_sold` is the number of units on orders that went ahead (anything but
`pending` and `cancelled`), for the best-selling sort.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import datetime
from typing import Dict, Iterable, List, Optional

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.orm import Session

from app.models import (
    Category,
    Collection,
    CollectionProduct,
    Order,
    OrderItem,
    Product,
    ProductAttribute,
    ProductAttributeValue,
    ProductColor,
    ProductSearchIndex,
    ProductSpecification,
)

logger = logging.getLogger(__name__)

MAX_TEXT = 1000
UNCOUNTED_ORDER_STATUSES = ("pending", "cancelled")


def _compose(parts: Iterable[str]) -> str:
    seen: List[str] = []
    for part in parts:
        part = " ".join((part or "").lower().split())
        if part and part not in seen:
            seen.append(part)
    return " ".join(seen)[:MAX_TEXT]


def _texts(db: Session, product_ids: Optional[List[str]] = None) -> Dict[str, str]:
    """product id → search text, for these products (or all)."""
    def scoped(statement, column):
        return statement.where(column.in_(product_ids)) if product_ids is not None else statement

    parts: Dict[str, List[str]] = defaultdict(list)
    for pid, category, subcategory in db.execute(scoped(
        select(Product.id, Category.name, Product.subcategory).join(Category, Category.id == Product.category_id),
        Product.id,
    )):
        parts[pid] += [category, (subcategory or "").replace("-", " ")]
    for pid, name in db.execute(scoped(
        select(CollectionProduct.product_id, Collection.name)
        .join(Collection, Collection.id == CollectionProduct.collection_id), CollectionProduct.product_id,
    )):
        parts[pid].append(name)
    for pid, name in db.execute(scoped(select(ProductColor.product_id, ProductColor.name), ProductColor.product_id)):
        parts[pid].append(name)
    for pid, value in db.execute(scoped(
        select(ProductSpecification.product_id, ProductSpecification.value), ProductSpecification.product_id,
    )):
        parts[pid].append(value)
    for pid, value in db.execute(scoped(
        select(ProductAttributeValue.product_id, ProductAttributeValue.value)
        .join(ProductAttribute, ProductAttribute.id == ProductAttributeValue.attribute_id)
        .where(ProductAttribute.status == "active", ProductAttribute.searchable.is_(True),
               ProductAttribute.type.in_(("select", "multi"))),
        ProductAttributeValue.product_id,
    )):
        parts[pid].append(value)
    return {pid: _compose(values) for pid, values in parts.items()}


def units_sold(db: Session, product_ids: Optional[List[str]] = None) -> Dict[str, int]:
    statement = (
        select(OrderItem.product_id, func.coalesce(func.sum(OrderItem.quantity), 0))
        .join(Order, Order.id == OrderItem.order_id)
        .where(Order.status.notin_(UNCOUNTED_ORDER_STATUSES))
        .group_by(OrderItem.product_id)
    )
    if product_ids is not None:
        statement = statement.where(OrderItem.product_id.in_(product_ids))
    return {pid: int(units or 0) for pid, units in db.execute(statement) if pid}


def _upsert(db: Session, rows: List[dict], *, with_units: bool) -> None:
    for start in range(0, len(rows), 500):
        chunk = rows[start:start + 500]
        statement = mysql_insert(ProductSearchIndex).values(chunk)
        update = {"search_text": statement.inserted.search_text, "updated_at": statement.inserted.updated_at}
        if with_units:
            update["units_sold"] = statement.inserted.units_sold
        db.execute(statement.on_duplicate_key_update(**update))


def rebuild(db: Session) -> dict:
    """Every product's search text and units sold. Doesn't commit."""
    ids = list(db.execute(select(Product.id)).scalars())
    texts = _texts(db)
    sold = units_sold(db)
    now = datetime.utcnow().replace(microsecond=0)
    rows = [{"product_id": pid, "search_text": texts.get(pid, ""), "units_sold": sold.get(pid, 0), "updated_at": now}
            for pid in ids]
    _upsert(db, rows, with_units=True)
    return {"products": len(rows), "unitsSold": sum(1 for pid in ids if sold.get(pid))}


def refresh(db: Session, product_ids: List[str]) -> None:
    """These products' search text (and their words in the dictionary). Doesn't commit."""
    ids = [pid for pid in dict.fromkeys(product_ids) if pid]
    if not ids:
        return
    texts = _texts(db, ids)
    sold = units_sold(db, ids)
    now = datetime.utcnow().replace(microsecond=0)
    _upsert(db, [{"product_id": pid, "search_text": texts.get(pid, ""), "units_sold": sold.get(pid, 0),
                  "updated_at": now} for pid in ids], with_units=False)

    from app.services.search import dictionary

    words: List[str] = list(texts.values())
    for name, brand in db.execute(select(Product.name, Product.brand).where(Product.id.in_(ids))):
        words += [name or "", brand or ""]
    dictionary.add_words(db, words)


def refresh_quietly(db: Session, product_ids: List[str]) -> bool:
    """`refresh` in a savepoint, committed; logs instead of raising (see the module docstring)."""
    try:
        with db.begin_nested():
            refresh(db, product_ids)
        db.commit()
        return True
    except Exception:  # noqa: BLE001 - the index is secondary to the product save
        logger.warning("Could not refresh the search index for %s", product_ids, exc_info=True)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return False


def remove_missing(db: Session) -> int:
    """Index rows whose product is gone (the FK cascades; this is for safety after manual SQL)."""
    result = db.execute(delete(ProductSearchIndex).where(ProductSearchIndex.product_id.notin_(select(Product.id))))
    return result.rowcount or 0
