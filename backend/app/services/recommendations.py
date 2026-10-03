"""
Product recommendations: what to show next to a product, and for a shopper.

## Where a list comes from, in order

1. **What the store chose.** Relationships set in the portal
   (`ProductRelationship`), in their editorial order. These always come first.
2. **A score, not a shuffle.** Every candidate that shares something with the
   product is scored on what it shares:

   | signal                    | weight                                     |
   |---------------------------|--------------------------------------------|
   | same subcategory          | 40                                         |
   | same category             | 25                                         |
   | bought in the same orders | up to 35 (log of the number of orders)     |
   | same collection           | 15                                         |
   | same brand                | 12                                         |
   | shared tags               | 6 each, at most 4                          |
   | similar price             | up to 10 (by the ratio of the two prices)  |
   | popularity                | up to 10 (rating, reviews, best-seller)    |
   | out of stock              | −60: shown only after everything in stock  |

   Ties break on rating and then id, so a list is stable between requests.
3. **Fallbacks**, so a rail is never empty while the shop has something
   suitable: the category's best, then the shop's best sellers.

## What is never recommended

The product itself; anything not published (draft, archived, deleted); and —
for "frequently bought together", which claims something about real orders —
anything that wasn't chosen by the store or actually bought together.

## Caching

The *ranking* is cached for `RECOMMENDATION_CACHE_SECONDS` per product and
type, and forgotten the moment a product or a relationship changes
(`invalidate`). What the ranking is applied to is always read live: a product
unpublished a second ago is gone from the list, and stock decides the order
on every read.
"""

from __future__ import annotations

import logging
import math
from datetime import datetime, timedelta
from typing import Dict, Iterable, List, Optional, Sequence

from sqlalchemy import and_, distinct, func, or_, select
from sqlalchemy.orm import Session

from app.core import cache
from app.core.config import settings
from app.core.errors import ValidationError
from app.models import (
    CollectionProduct,
    Order,
    OrderItem,
    Product,
    ProductRelationship,
    ProductTag,
    RecentlyViewedProduct,
)
from app.repositories import products as product_repo

logger = logging.getLogger(__name__)

TYPES = ("related", "similar", "frequently-bought-together", "alternative", "accessory")
# Which store-set relationships feed each list. "Related" is the broad rail,
# so the store's accessories belong in it too.
MANUAL_TYPES: Dict[str, Sequence[str]] = {
    "related": ("related", "accessory"),
    "similar": ("similar",),
    "frequently-bought-together": ("frequently-bought-together",),
    "alternative": ("alternative",),
    "accessory": ("accessory",),
}

WEIGHTS = {
    "subcategory": 40.0,
    "category": 25.0,
    "copurchase": 35.0,
    "collection": 15.0,
    "brand": 12.0,
    "tag": 6.0,
    "price": 10.0,
    "popularity": 10.0,
    "out_of_stock": -60.0,
}
MAX_TAGS_COUNTED = 4
CANDIDATE_POOL = 300
COPURCHASE_WINDOW_DAYS = 365
NAMESPACE = "recommendations"
# Orders that never happened don't say anything about what goes together.
_UNCOUNTED_ORDER_STATUSES = ("cancelled",)


def invalidate() -> None:
    """Forget every cached ranking. Called when a product or a relationship changes."""
    cache.invalidate(NAMESPACE)


def _ttl() -> int:
    return max(0, int(settings.RECOMMENDATION_CACHE_SECONDS))


def _published():
    return Product.status.in_(product_repo.PUBLISHED_STATUSES)


# ------------------------------------------------------------- signals


def _manual(db: Session, product_id: str, kinds: Sequence[str]) -> List[str]:
    rows = db.execute(
        select(ProductRelationship.related_product_id)
        .join(Product, Product.id == ProductRelationship.related_product_id)
        .where(
            ProductRelationship.product_id == product_id,
            ProductRelationship.type.in_(list(kinds)),
            ProductRelationship.active.is_(True),
            ProductRelationship.related_product_id != product_id,
            _published(),
        )
        .order_by(ProductRelationship.position, ProductRelationship.id)
    ).scalars().all()
    seen, out = set(), []
    for pid in rows:
        if pid not in seen:
            seen.add(pid)
            out.append(pid)
    return out


def copurchased(db: Session, product_id: str, *, limit: int = 50) -> Dict[str, int]:
    """Products bought in the same orders as this one in the last year: id → number of orders."""
    mine = OrderItem.__table__.alias("mine")
    other = OrderItem.__table__.alias("other")
    since = datetime.utcnow() - timedelta(days=COPURCHASE_WINDOW_DAYS)
    rows = db.execute(
        select(other.c.product_id, func.count(distinct(other.c.order_id)).label("orders"))
        .select_from(mine)
        .join(other, and_(other.c.order_id == mine.c.order_id, other.c.product_id != mine.c.product_id))
        .join(Order, Order.id == mine.c.order_id)
        .where(mine.c.product_id == product_id, Order.placed_at >= since,
               Order.status.notin_(_UNCOUNTED_ORDER_STATUSES))
        .group_by(other.c.product_id)
        .order_by(func.count(distinct(other.c.order_id)).desc(), other.c.product_id)
        .limit(limit)
    ).all()
    return {pid: int(n) for pid, n in rows}


def _popularity(row) -> float:
    rating = float(row.rating or 0)
    reviews = int(row.review_count or 0)
    score = rating * 1.2 + math.log1p(reviews) + (3.0 if row.is_best_seller else 0.0)
    return min(WEIGHTS["popularity"], score)


def _price_similarity(a: float, b: float) -> float:
    if a <= 0 or b <= 0:
        return 0.0
    ratio = min(a, b) / max(a, b)
    # Within a factor of two counts, scaled; further apart says nothing.
    return WEIGHTS["price"] * (ratio - 0.5) / 0.5 if ratio >= 0.5 else 0.0


def score_candidates(db: Session, product: Product, *, use_copurchase: bool = True,
                     same_subcategory_only: bool = False, price_band: Optional[float] = None) -> List[dict]:
    """
    Every candidate sharing something with `product`, scored, best first.

    Reads columns, not whole products: a pool of a few hundred rows costs four
    small queries, however large the catalogue is.
    """
    seed_tags = [t.tag for t in product.tags]
    collections = select(CollectionProduct.collection_id).where(CollectionProduct.product_id == product.id)
    in_collection = set(db.execute(
        select(CollectionProduct.product_id)
        .where(CollectionProduct.collection_id.in_(collections), CollectionProduct.product_id != product.id)
    ).scalars())
    tag_overlap: Dict[str, int] = {}
    if seed_tags:
        tag_overlap = {pid: int(n) for pid, n in db.execute(
            select(ProductTag.product_id, func.count())
            .where(ProductTag.tag.in_(seed_tags), ProductTag.product_id != product.id)
            .group_by(ProductTag.product_id)
        ).all()}
    bought = copurchased(db, product.id) if use_copurchase else {}

    linked = set(in_collection) | set(tag_overlap) | set(bought)
    shares = [Product.category_id == product.category_id]
    if product.brand:
        shares.append(Product.brand == product.brand)
    if linked:
        shares.append(Product.id.in_(list(linked)[:1000]))
    conditions = [Product.id != product.id, _published(), or_(*shares)]
    if same_subcategory_only:
        conditions += [Product.category_id == product.category_id, Product.subcategory == product.subcategory]
    seed_price = float(product.price or 0)
    if price_band and seed_price > 0:
        conditions += [Product.price >= seed_price * (1 - price_band), Product.price <= seed_price * (1 + price_band)]

    rows = db.execute(
        select(Product.id, Product.category_id, Product.subcategory, Product.brand, Product.price, Product.rating,
               Product.review_count, Product.stock, Product.reserved_stock, Product.status, Product.is_best_seller)
        .where(*conditions)
        .order_by(Product.is_best_seller.desc(), Product.rating.desc(), Product.id)
        .limit(CANDIDATE_POOL)
    ).all()

    scored = []
    for row in rows:
        score = 0.0
        same_category = row.category_id == product.category_id
        if same_category:
            score += WEIGHTS["category"]
            if product.subcategory and row.subcategory == product.subcategory:
                score += WEIGHTS["subcategory"]
        if product.brand and row.brand == product.brand:
            score += WEIGHTS["brand"]
        if row.id in in_collection:
            score += WEIGHTS["collection"]
        score += WEIGHTS["tag"] * min(MAX_TAGS_COUNTED, tag_overlap.get(row.id, 0))
        if row.id in bought:
            score += min(WEIGHTS["copurchase"], 12.0 * math.log1p(bought[row.id]))
        score += _price_similarity(seed_price, float(row.price or 0))
        score += _popularity(row)
        in_stock = row.status == "active" and (row.stock or 0) - (row.reserved_stock or 0) > 0
        if not in_stock:
            score += WEIGHTS["out_of_stock"]
        scored.append({"id": row.id, "score": round(score, 2), "inStock": in_stock, "rating": float(row.rating or 0)})
    scored.sort(key=lambda c: (-c["score"], -c["rating"], c["id"]))
    return scored


def best_sellers(db: Session, *, exclude: Iterable[str] = (), category_id: Optional[str] = None,
                 limit: int = 12) -> List[str]:
    """The fallback: in stock, best sellers first, then the best rated."""
    conditions = [Product.status == "active", Product.stock - Product.reserved_stock > 0]
    excluded = [pid for pid in exclude if pid]
    if excluded:
        conditions.append(Product.id.notin_(excluded))
    if category_id:
        conditions.append(Product.category_id == category_id)
    return list(db.execute(
        select(Product.id).where(*conditions)
        .order_by(Product.is_best_seller.desc(), Product.rating.desc(), Product.review_count.desc(), Product.id)
        .limit(limit)
    ).scalars())


# ------------------------------------------------------------- per product


def _rank(db: Session, product: Product, kind: str, limit: int) -> List[dict]:
    """The ranked list for one product and type: `[{id, source, score}]`."""
    manual = _manual(db, product.id, MANUAL_TYPES[kind])
    out: List[dict] = [{"id": pid, "source": "manual", "score": None} for pid in manual]
    seen = {product.id, *manual}

    def extend(entries: Iterable[dict], source: str) -> None:
        for entry in entries:
            if len(out) >= limit:
                return
            if entry["id"] in seen:
                continue
            seen.add(entry["id"])
            out.append({"id": entry["id"], "source": source, "score": entry.get("score")})

    if kind == "frequently-bought-together":
        # Only what was really bought together: an honest empty list beats a
        # made-up "frequently".
        bought = copurchased(db, product.id)
        published = set(db.execute(select(Product.id).where(Product.id.in_(list(bought)), _published())).scalars()) \
            if bought else set()
        extend(({"id": pid, "score": float(n)} for pid, n in bought.items() if pid in published), "copurchase")
    elif kind == "similar":
        extend(score_candidates(db, product, use_copurchase=False), "score")
    elif kind == "alternative":
        extend(score_candidates(db, product, use_copurchase=False, same_subcategory_only=True, price_band=0.35),
               "score")
    else:
        extend(score_candidates(db, product), "score")
        if len(out) < limit:
            extend(({"id": pid} for pid in best_sellers(db, exclude=seen, category_id=product.category_id,
                                                         limit=limit)), "fallback-category")
        if len(out) < limit:
            extend(({"id": pid} for pid in best_sellers(db, exclude=seen, limit=limit)), "fallback-best-sellers")
    return out[:limit]


def ranked(db: Session, product: Product, kind: str = "related", limit: int = 8) -> List[dict]:
    """`_rank`, cached. Errors are logged and answered with no list, never a broken page."""
    if kind not in TYPES:
        raise ValidationError(f"Unknown recommendation type '{kind}'.", error_code="INVALID_TYPE")
    limit = max(1, min(int(limit), 24))
    try:
        return cache.get_or_set(NAMESPACE, ("product", product.id, kind, limit), _ttl(),
                                lambda: _rank(db, product, kind, limit))
    except Exception:  # noqa: BLE001 — a recommendation rail must never take the product page down
        logger.exception("Recommendations failed for %s (%s)", product.id, kind)
        return []


def _resolve(db: Session, entries: List[dict], limit: int) -> List[Product]:
    """
    The ranked ids as products, read live: unpublished ones dropped, and
    anything out of stock moved behind everything in stock (store-chosen
    entries keep their place among themselves).
    """
    products = product_repo.get_many(db, [e["id"] for e in entries])
    in_stock = [p for p in products if p.status == "active" and p.available_stock > 0]
    sold_out = [p for p in products if not (p.status == "active" and p.available_stock > 0)]
    return (in_stock + sold_out)[:limit]


def for_product(db: Session, product: Product, kind: str = "related", limit: int = 8) -> List[Product]:
    return _resolve(db, ranked(db, product, kind, limit), limit)


def explain(db: Session, product: Product, kind: str, limit: int = 12) -> List[dict]:
    """For the portal's preview: the list as the storefront gets it, with where each entry came from."""
    entries = {e["id"]: e for e in _rank(db, product, kind, limit)}
    products = _resolve(db, list(entries.values()), limit)
    from app.schemas.catalogue import ProductOut

    return [{"source": entries[p.id]["source"], "score": entries[p.id]["score"],
             "inStock": p.status == "active" and p.available_stock > 0,
             "product": ProductOut.from_model(p).model_dump(by_alias=True)} for p in products]


# ------------------------------------------------------------- per shopper


def _seeds_for(db: Session, customer_id: str) -> List[str]:
    """What a signed-in customer has looked at most recently, then what they've bought."""
    viewed = list(db.execute(
        select(RecentlyViewedProduct.product_id)
        .where(RecentlyViewedProduct.customer_id == customer_id)
        .order_by(RecentlyViewedProduct.viewed_at.desc()).limit(5)
    ).scalars())
    bought = list(db.execute(
        select(OrderItem.product_id)
        .join(Order, Order.id == OrderItem.order_id)
        .where(Order.customer_id == customer_id, Order.status.notin_(_UNCOUNTED_ORDER_STATUSES))
        .order_by(Order.placed_at.desc()).limit(10)
    ).scalars())
    seeds: List[str] = []
    for pid in viewed + bought:
        if pid not in seeds:
            seeds.append(pid)
    return seeds[:6]


def _purchased(db: Session, customer_id: str) -> set:
    return set(db.execute(
        select(OrderItem.product_id).join(Order, Order.id == OrderItem.order_id)
        .where(Order.customer_id == customer_id, Order.status.notin_(_UNCOUNTED_ORDER_STATUSES))
    ).scalars())


def for_shopper(db: Session, *, customer_id: Optional[str] = None, seed_ids: Sequence[str] = (),
                limit: int = 8) -> List[Product]:
    """
    "Recommended for you".

    Built from the customer's own recent views and purchases — or, for a guest,
    the recently viewed ids the browser holds — each seed's scored list
    weighted by how recent it is (1, 0.8, 0.6 …). What they already bought or
    are looking at is left out. With no history at all, the shop's best sellers.
    """
    limit = max(1, min(int(limit), 24))
    seeds = _seeds_for(db, customer_id) if customer_id else [s for s in seed_ids if s][:6]

    def compute() -> List[str]:
        excluded = set(seeds) | (_purchased(db, customer_id) if customer_id else set())
        totals: Dict[str, float] = {}
        # A customer's own purchases count even if since withdrawn; a guest's
        # seeds are only ids the browser sent, so only published ones count.
        seed_products = product_repo.get_many(db, seeds, published_only=not customer_id)
        for index, seed in enumerate(seed_products):
            weight = max(0.2, 1 - index * 0.2)
            for entry in ranked(db, seed, "related", 24):
                if entry["id"] in excluded or entry.get("score") is None and entry["source"] != "manual":
                    continue
                base = entry["score"] if entry["score"] is not None else 80.0
                totals[entry["id"]] = totals.get(entry["id"], 0.0) + base * weight
        ordered = [pid for pid, _ in sorted(totals.items(), key=lambda kv: (-kv[1], kv[0]))]
        if len(ordered) < limit:
            ordered += [pid for pid in best_sellers(db, exclude=excluded | set(ordered), limit=limit)]
        return ordered[:limit]

    key = ("shopper", customer_id or "", tuple(seeds), limit)
    try:
        ids = cache.get_or_set(NAMESPACE, key, _ttl(), compute)
    except Exception:  # noqa: BLE001
        logger.exception("Personal recommendations failed")
        ids = best_sellers(db, limit=limit)
    return _resolve(db, [{"id": pid} for pid in ids], limit)


# ------------------------------------------------------------- attribution


def attribute_purchase(db: Session, customer_id: str, order_id: str, product_ids: Iterable[str]) -> int:
    """
    Record "bought from a recommendation" for the order's products that the
    customer added to the bag from a recommendation rail in the last week.
    Added to the caller's transaction; returns how many were attributed.
    """
    from app.models import AnalyticsEvent
    from app.services import analytics_events

    ids = list({pid for pid in product_ids if pid})
    if not ids:
        return 0
    since = datetime.utcnow() - timedelta(days=7)
    try:
        rows = db.execute(
            select(AnalyticsEvent.product_id, func.max(AnalyticsEvent.source))
            .where(AnalyticsEvent.event == "add_to_cart", AnalyticsEvent.customer_id == customer_id,
                   AnalyticsEvent.product_id.in_(ids), AnalyticsEvent.occurred_at >= since,
                   AnalyticsEvent.source.like("rec:%"))
            .group_by(AnalyticsEvent.product_id)
        ).all()
    except Exception:  # noqa: BLE001 — a report figure must never stop an order
        logger.exception("Could not attribute order %s to recommendations", order_id)
        return 0
    for product_id, source in rows:
        analytics_events.server_event(db, "recommendation_purchase", customer_id=customer_id, product_id=product_id,
                                      source=source or "")
    return len(rows)
