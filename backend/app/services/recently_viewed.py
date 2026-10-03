"""
Recently viewed products, for signed-in customers.

Guests keep their history in the browser — the same arrangement as the guest
bag — and hand it over once, when they sign in (`merge`). From then on the
server holds it, so it follows the customer between devices.

## The rules

- **Only real views.** A product that doesn't exist or isn't published is
  refused, so a 404 page or a mistyped id never lands in anybody's history.
- **One row per product.** Viewing again moves the product to the front; the
  unique constraint makes that true under concurrent requests too.
- **Bounded.** `RECENTLY_VIEWED_LIMIT` products per customer; the oldest fall
  off as new ones arrive, and nothing older than
  `RECENTLY_VIEWED_RETENTION_DAYS` is kept at all (`sweep`).
- **Throttled.** A view of the product already at the front within
  `REPEAT_SECONDS` is not written again — a refresh, a re-render or a
  StrictMode double effect costs one indexed read and no write.
- **Honest on read.** A product unpublished since it was viewed is left out
  (not shown as something you can buy); an out-of-stock one is shown, marked
  out of stock.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Iterable, List, Optional, Tuple

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import NotFoundError, ValidationError
from app.models import Customer, Product, RecentlyViewedProduct
from app.repositories import products as product_repo

logger = logging.getLogger(__name__)

REPEAT_SECONDS = 30
MAX_MERGE_ITEMS = 50
SOURCES = {"", "search", "category", "collection", "home", "recommendation", "recently-viewed", "wishlist",
           "cart", "compare", "direct", "other"}


def limit() -> int:
    return max(1, int(settings.RECENTLY_VIEWED_LIMIT))


def _variant(product: Product, color: Optional[str], size: Optional[str]) -> Tuple[str, str]:
    """The colour and size to remember — only ones the product actually comes in."""
    colors = {c.name for c in product.colors}
    sizes = {s.label for s in product.sizes}
    return ((color or "") if (color or "") in colors else "", (size or "") if (size or "") in sizes else "")


def _source(value: Optional[str]) -> str:
    value = (value or "").strip().lower()
    return value if value in SOURCES else "other"


def record(db: Session, customer: Customer, product_id: str, *, color: Optional[str] = None,
           size: Optional[str] = None, source: Optional[str] = None, now: Optional[datetime] = None) -> bool:
    """
    Remember a view. Returns whether anything was written.

    Raises `NotFoundError` for a product that isn't published — the caller
    asked to record something that can't be viewed.
    """
    product = product_repo.get_by_id(db, product_id, published_only=True)
    if product is None:
        raise NotFoundError("That product is not available.", error_code="PRODUCT_NOT_FOUND")
    now = now or datetime.utcnow()
    color, size = _variant(product, color, size)
    try:
        written = _upsert(db, customer.id, product.id, now, color=color, size=size, source=_source(source))
        if written:
            _trim(db, customer.id)
        db.commit()
        return written
    except IntegrityError:
        # Two first views of the same product at once: the other request
        # inserted the row. Treat this one as the repeat it is.
        db.rollback()
        return False


def _upsert(db: Session, customer_id: str, product_id: str, at: datetime, *, color: str, size: str,
            source: str, count: int = 1) -> bool:
    row = db.execute(
        select(RecentlyViewedProduct).where(
            RecentlyViewedProduct.customer_id == customer_id,
            RecentlyViewedProduct.product_id == product_id,
        )
    ).scalar_one_or_none()
    if row is None:
        db.add(RecentlyViewedProduct(
            customer_id=customer_id, product_id=product_id, color=color, size=size, source=source,
            view_count=count, first_viewed_at=at, viewed_at=at,
        ))
        db.flush()
        return True
    if at <= row.viewed_at:
        # An older view than the one held (a guest's history being merged):
        # never move the newer one back.
        return False
    if (at - row.viewed_at).total_seconds() < REPEAT_SECONDS and row.color == color and row.size == size:
        return False
    row.viewed_at = at
    row.view_count = (row.view_count or 0) + count
    row.color, row.size = color, size
    if source:
        row.source = source
    return True


def _trim(db: Session, customer_id: str) -> int:
    """Drop whatever is past the limit, oldest first."""
    stale = db.execute(
        select(RecentlyViewedProduct.id)
        .where(RecentlyViewedProduct.customer_id == customer_id)
        .order_by(RecentlyViewedProduct.viewed_at.desc(), RecentlyViewedProduct.id.desc())
        .offset(limit())
    ).scalars().all()
    if stale:
        db.execute(delete(RecentlyViewedProduct).where(RecentlyViewedProduct.id.in_(list(stale))))
    return len(stale)


def _visible(customer_id: str):
    return (
        select(RecentlyViewedProduct)
        .join(Product, Product.id == RecentlyViewedProduct.product_id)
        .where(
            RecentlyViewedProduct.customer_id == customer_id,
            Product.status.in_(product_repo.PUBLISHED_STATUSES),
        )
    )


def listing(db: Session, customer: Customer, *, page: int = 1, page_size: int = 12,
            exclude: Optional[str] = None) -> Tuple[List[dict], int]:
    """
    One page of history, newest first, with each product resolved.

    Two queries for the page (the rows, then the products with everything a
    card needs, in one `selectin` batch) and one for the count — no matter how
    long the history is.
    """
    statement = _visible(customer.id)
    if exclude:
        statement = statement.where(RecentlyViewedProduct.product_id != exclude)
    total = db.execute(select(func.count()).select_from(statement.subquery())).scalar_one()
    rows = db.execute(
        statement.order_by(RecentlyViewedProduct.viewed_at.desc(), RecentlyViewedProduct.id.desc())
        .offset((max(1, page) - 1) * page_size).limit(page_size)
    ).scalars().all()
    products = {p.id: p for p in product_repo.get_many(db, [r.product_id for r in rows])}
    items = []
    for row in rows:
        product = products.get(row.product_id)
        if product is None:
            continue
        items.append({"row": row, "product": product})
    return items, total


def view(entry: dict) -> dict:
    from app.schemas.catalogue import ProductOut

    row, product = entry["row"], entry["product"]
    available = product.status == "active" and product.available_stock > 0
    return {
        "productId": row.product_id,
        "color": row.color or None,
        "size": row.size or None,
        "viewedAt": row.viewed_at,
        "viewCount": row.view_count,
        "available": available,
        "availability": "in-stock" if available else "out-of-stock",
        "product": ProductOut.from_model(product).model_dump(by_alias=True),
    }


def remove(db: Session, customer: Customer, product_id: str) -> bool:
    """Forget one product. Only ever the caller's own row — the customer is part of the WHERE."""
    result = db.execute(delete(RecentlyViewedProduct).where(
        RecentlyViewedProduct.customer_id == customer.id,
        RecentlyViewedProduct.product_id == product_id,
    ))
    _event(db, "recently_viewed_remove", customer.id, product_id)
    db.commit()
    return bool(result.rowcount)


def clear(db: Session, customer: Customer) -> int:
    result = db.execute(delete(RecentlyViewedProduct).where(RecentlyViewedProduct.customer_id == customer.id))
    _event(db, "recently_viewed_clear", customer.id, None)
    db.commit()
    return int(result.rowcount or 0)


def _event(db: Session, event: str, customer_id: str, product_id: Optional[str]) -> None:
    from app.services import analytics_events

    analytics_events.server_event(db, event, customer_id=customer_id, product_id=product_id)


def _parse_time(value, now: datetime) -> datetime:
    """A guest's own timestamp, kept within [retention window, now]."""
    at: Optional[datetime] = None
    if isinstance(value, datetime):
        at = value
    elif isinstance(value, (int, float)):
        # Milliseconds since the epoch, as the browser keeps them.
        try:
            at = datetime.utcfromtimestamp(value / 1000)
        except (OverflowError, OSError, ValueError):
            at = None
    elif isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            at = parsed.replace(tzinfo=None) - (parsed.utcoffset() or timedelta(0))
        except ValueError:
            at = None
    if at is None or at > now:
        return now
    floor = now - timedelta(days=max(1, settings.RECENTLY_VIEWED_RETENTION_DAYS))
    return max(at, floor)


def merge(db: Session, customer: Customer, items: Iterable[dict], *, now: Optional[datetime] = None) -> dict:
    """
    Fold a guest's browser history into the account, once, at sign-in.

    Duplicates collapse onto the existing row, and only a *newer* guest view
    moves it — an old guest view never overwrites a newer one on the account.
    Products that don't exist or aren't published are skipped. The result is
    trimmed to the limit like any other write.
    """
    now = now or datetime.utcnow()
    entries = list(items or [])
    if len(entries) > MAX_MERGE_ITEMS:
        raise ValidationError(f"Send at most {MAX_MERGE_ITEMS} products at a time.", error_code="TOO_MANY_ITEMS")

    newest: dict = {}
    for entry in entries:
        product_id = str(entry.get("productId") or entry.get("product_id") or "")[:20]
        if not product_id:
            continue
        # 0 is a real answer ("time unknown, treat as oldest"), not a missing one.
        at = _parse_time(entry["viewedAt"] if "viewedAt" in entry else entry.get("viewed_at"), now)
        if product_id not in newest or at > newest[product_id][0]:
            newest[product_id] = (at, entry)

    published = {p.id: p for p in product_repo.get_many(db, list(newest))}
    merged = skipped = 0
    for attempt in range(2):
        try:
            merged = skipped = 0
            for product_id, (at, entry) in newest.items():
                product = published.get(product_id)
                if product is None:
                    skipped += 1
                    continue
                color, size = _variant(product, entry.get("color"), entry.get("size"))
                if _upsert(db, customer.id, product_id, at, color=color, size=size, source=""):
                    merged += 1
            _trim(db, customer.id)
            db.commit()
            break
        except IntegrityError:
            # A view recorded by another tab mid-merge; run it again against
            # the rows as they are now.
            db.rollback()
            if attempt:
                raise
    return {"merged": merged, "skipped": skipped}


def sweep(db: Session, *, now: Optional[datetime] = None) -> int:
    """Forget views older than the retention window. Run by the discovery job."""
    now = now or datetime.utcnow()
    cutoff = now - timedelta(days=max(1, settings.RECENTLY_VIEWED_RETENTION_DAYS))
    result = db.execute(delete(RecentlyViewedProduct).where(RecentlyViewedProduct.viewed_at < cutoff))
    db.commit()
    return int(result.rowcount or 0)


def admin_summary(db: Session, *, days: int = 30, top: int = 10) -> dict:
    """For the portal: how much history is held, and what people keep coming back to."""
    since = datetime.utcnow() - timedelta(days=days)
    customers = db.execute(select(func.count(func.distinct(RecentlyViewedProduct.customer_id)))).scalar_one()
    rows = db.execute(select(func.count()).select_from(RecentlyViewedProduct)).scalar_one()
    revisited = db.execute(
        select(Product.id, Product.name, func.count().label("customers"),
               func.sum(RecentlyViewedProduct.view_count).label("views"))
        .join(Product, Product.id == RecentlyViewedProduct.product_id)
        .where(RecentlyViewedProduct.viewed_at >= since)
        .group_by(Product.id, Product.name)
        .order_by(func.count().desc(), Product.id)
        .limit(top)
    ).all()
    return {
        "customers": int(customers or 0),
        "entries": int(rows or 0),
        "limit": limit(),
        "retentionDays": settings.RECENTLY_VIEWED_RETENTION_DAYS,
        "topProducts": [
            {"productId": pid, "name": name, "customers": int(c), "views": int(v or 0)}
            for pid, name, c, v in revisited
        ],
    }


def for_customer(db: Session, customer_id: str, *, limit_to: int = 20) -> List[dict]:
    """A customer's recent history for the portal's customer screen (read-only)."""
    rows = db.execute(
        select(RecentlyViewedProduct, Product.name, Product.status)
        .join(Product, Product.id == RecentlyViewedProduct.product_id)
        .where(RecentlyViewedProduct.customer_id == customer_id)
        .order_by(RecentlyViewedProduct.viewed_at.desc())
        .limit(limit_to)
    ).all()
    return [{"productId": r.product_id, "name": name, "status": status, "viewedAt": r.viewed_at,
             "viewCount": r.view_count} for r, name, status in rows]
