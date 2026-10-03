"""
Search analytics: the search log, click-through, conversions and the report.

What is kept is deliberately little: the normalised term, how many products it
found, whether the dictionary corrected it, which filter dimensions were in
use, the sort, a keyed hash of the visitor (made the same way as the funnel's,
`analytics_events.visitor_key`) and the customer id when signed in. No IP, no
user agent, no raw term.

**Conversion, simply**: a click is converted when the clicked product reached
the same signed-in customer's bag within 30 minutes of the click, or an order
of theirs within 24 hours. The job marks it; the report counts it.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from typing import List, Optional

from sqlalchemy import and_, case, delete, distinct, func, select
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.orm import Session

from app.models import AnalyticsEvent, Order, OrderItem, Product, SearchClick, SearchDailyStat, SearchQuery
from app.services.search.base import normalise

REPEAT_WINDOW = timedelta(seconds=60)
CLICK_WINDOW = timedelta(hours=24)
CART_WINDOW = timedelta(minutes=30)
ORDER_WINDOW = timedelta(hours=24)
RANGES = {"7d": 7, "30d": 30, "90d": 90}
_VISITOR = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
LIST_LIMIT = 20


def visitor_hash(visitor_id: Optional[str], customer_id: Optional[str]) -> str:
    from app.services.analytics_events import visitor_key

    if customer_id:
        return visitor_key(customer_id=customer_id)
    if visitor_id and _VISITOR.match(visitor_id):
        return visitor_key(visitor_id)
    return ""


def filters_summary(query) -> str:
    used = []
    for name, active in (
        ("category", query.category), ("subcategory", query.subcategory), ("collection", query.collection),
        ("brand", query.brands), ("size", query.sizes), ("color", query.colors),
        ("price", query.min_price is not None or query.max_price is not None),
        ("rating", query.min_rating is not None), ("discount", bool(query.min_discount)),
        ("availability", query.in_stock_only or query.availability),
        ("attributes", query.attributes),
    ):
        if active:
            used.append(name)
    return ",".join(used)[:255]


def log_search(db: Session, *, term: str, results: int, corrected: Optional[str], query,
               visitor_id: Optional[str], customer_id: Optional[str], sort: str) -> Optional[int]:
    """
    Record page 1 of a search; the id is what clicks refer to.

    The same visitor repeating the same search with the same filters within a
    minute (a re-render, a back button) reuses the earlier row. Commits.
    """
    term = normalise(term)
    if not term:
        return None
    visitor = visitor_hash(visitor_id, customer_id)
    filters = filters_summary(query)
    now = datetime.utcnow().replace(microsecond=0)
    if visitor:
        earlier = db.execute(
            select(SearchQuery.id).where(SearchQuery.visitor_hash == visitor, SearchQuery.term == term,
                                         SearchQuery.filters == filters, SearchQuery.sort == sort,
                                         SearchQuery.created_at >= now - REPEAT_WINDOW)
            .order_by(SearchQuery.id.desc()).limit(1)
        ).scalar_one_or_none()
        if earlier is not None:
            return earlier
    row = SearchQuery(term=term, results_count=int(results), zero_results=results == 0,
                      corrected_term=normalise(corrected or "") if corrected else "", visitor_hash=visitor,
                      customer_id=customer_id, filters=filters, sort=(sort or "")[:20], created_at=now)
    db.add(row)
    db.commit()
    return row.id


def record_click(db: Session, *, search_id: int, product_id: str, position: int,
                 visitor_id: Optional[str], customer_id: Optional[str]) -> bool:
    """A product opened from results. False (and nothing written) for anything that doesn't add up. Commits."""
    now = datetime.utcnow().replace(microsecond=0)
    search = db.get(SearchQuery, search_id)
    if search is None or search.created_at < now - CLICK_WINDOW:
        return False
    product = db.get(Product, product_id)
    if product is None:
        return False
    if db.execute(select(SearchClick.id).where(SearchClick.search_id == search_id,
                                               SearchClick.product_id == product_id)).first():
        return False
    db.add(SearchClick(search_id=search_id, product_id=product_id, position=max(1, min(int(position), 100_000)),
                       visitor_hash=visitor_hash(visitor_id, customer_id) or search.visitor_hash,
                       customer_id=customer_id or search.customer_id, created_at=now))
    try:
        db.commit()
    except Exception:  # noqa: BLE001 - a double click racing itself hits the unique key
        db.rollback()
        return False
    return True


# -------------------------------------------------------------- the job


def mark_conversions(db: Session, now: Optional[datetime] = None) -> int:
    """Clicks of the last 25 hours whose product reached the customer's bag or an order. Doesn't commit."""
    now = now or datetime.utcnow()
    candidates = list(db.execute(
        select(SearchClick).where(SearchClick.converted.is_(False), SearchClick.customer_id.is_not(None),
                                  SearchClick.created_at >= now - CLICK_WINDOW - timedelta(hours=1))
    ).scalars())
    marked = 0
    for click in candidates:
        added = db.execute(select(func.min(AnalyticsEvent.occurred_at)).where(
            AnalyticsEvent.event == "add_to_cart", AnalyticsEvent.customer_id == click.customer_id,
            AnalyticsEvent.product_id == click.product_id, AnalyticsEvent.occurred_at >= click.created_at,
            AnalyticsEvent.occurred_at <= click.created_at + CART_WINDOW)).scalar_one_or_none()
        ordered = None
        if added is None:
            ordered = db.execute(select(func.min(Order.placed_at)).join(OrderItem, OrderItem.order_id == Order.id).where(
                Order.customer_id == click.customer_id, OrderItem.product_id == click.product_id,
                Order.placed_at >= click.created_at, Order.placed_at <= click.created_at + ORDER_WINDOW,
                Order.status != "cancelled")).scalar_one_or_none()
        when = added or ordered
        if when is not None:
            click.converted, click.converted_at = True, when
            marked += 1
    db.flush()
    return marked


def aggregate_day(db: Session, day: date) -> int:
    """Recompute `search_daily_stats` for one day (idempotent). Doesn't commit. Returns the number of terms."""
    start = datetime.combine(day, datetime.min.time())
    end = start + timedelta(days=1)
    clicks = (
        select(SearchClick.search_id, func.count(SearchClick.id).label("clicks"),
               func.sum(case((SearchClick.converted.is_(True), 1), else_=0)).label("conversions"))
        .group_by(SearchClick.search_id).subquery()
    )
    rows = db.execute(
        select(SearchQuery.term, func.count(SearchQuery.id),
               func.sum(case((SearchQuery.zero_results.is_(True), 1), else_=0)),
               func.sum(case((clicks.c.clicks > 0, 1), else_=0)),
               func.coalesce(func.sum(clicks.c.clicks), 0), func.coalesce(func.sum(clicks.c.conversions), 0),
               func.avg(SearchQuery.results_count))
        .outerjoin(clicks, clicks.c.search_id == SearchQuery.id)
        .where(SearchQuery.created_at >= start, SearchQuery.created_at < end)
        .group_by(SearchQuery.term)
    ).all()
    db.execute(delete(SearchDailyStat).where(SearchDailyStat.day == day))
    values = [{"day": day, "term": term, "searches": int(searches or 0), "zero_results": int(zero or 0),
               "clicked_searches": int(clicked or 0), "clicks": int(n_clicks or 0),
               "conversions": int(conversions or 0), "avg_results": round(float(avg or 0), 2)}
              for term, searches, zero, clicked, n_clicks, conversions, avg in rows]
    for start_at in range(0, len(values), 500):
        db.execute(mysql_insert(SearchDailyStat).values(values[start_at:start_at + 500]))
    return len(values)


def purge(db: Session, retention_days: int, now: Optional[datetime] = None) -> int:
    """Raw searches older than the retention (their clicks cascade); the aggregates stay. Doesn't commit."""
    if retention_days <= 0:
        return 0
    cutoff = (now or datetime.utcnow()) - timedelta(days=retention_days)
    old = list(db.execute(select(SearchQuery.id).where(SearchQuery.created_at < cutoff).limit(5000)).scalars())
    if not old:
        return 0
    db.execute(delete(SearchClick).where(SearchClick.search_id.in_(old)))
    db.execute(delete(SearchQuery).where(SearchQuery.id.in_(old)))
    return len(old)


# -------------------------------------------------------------- the report


def _pct(part, whole) -> float:
    return round(part * 100.0 / whole, 1) if whole else 0.0


def _window(range_key: str, today: Optional[date] = None):
    days = RANGES.get(range_key, 30)
    today = today or datetime.utcnow().date()
    start = today - timedelta(days=days - 1)
    return days, start, today


def report(db: Session, range_key: str = "30d") -> dict:
    range_key = range_key if range_key in RANGES else "30d"
    days, start, end = _window(range_key)
    # Today moves all day: count it fresh rather than waiting for the job.
    aggregate_day(db, end)
    db.flush()

    in_range = and_(SearchDailyStat.day >= start, SearchDailyStat.day <= end)
    totals = db.execute(select(
        func.coalesce(func.sum(SearchDailyStat.searches), 0), func.count(distinct(SearchDailyStat.term)),
        func.coalesce(func.sum(SearchDailyStat.zero_results), 0),
        func.coalesce(func.sum(SearchDailyStat.clicked_searches), 0),
        func.coalesce(func.sum(SearchDailyStat.clicks), 0), func.coalesce(func.sum(SearchDailyStat.conversions), 0),
    ).where(in_range)).one()
    searches, unique_terms, zero, clicked, clicks, conversions = (int(v or 0) for v in totals)

    top = db.execute(
        select(SearchDailyStat.term, func.sum(SearchDailyStat.searches), func.sum(SearchDailyStat.clicked_searches),
               func.sum(SearchDailyStat.clicks), func.sum(SearchDailyStat.conversions),
               func.sum(SearchDailyStat.avg_results * SearchDailyStat.searches))
        .where(in_range).group_by(SearchDailyStat.term)
        .order_by(func.sum(SearchDailyStat.searches).desc(), SearchDailyStat.term).limit(LIST_LIMIT)
    ).all()
    zero_rows = db.execute(
        select(SearchDailyStat.term, func.sum(SearchDailyStat.zero_results), func.max(SearchDailyStat.day))
        .where(in_range, SearchDailyStat.zero_results > 0).group_by(SearchDailyStat.term)
        .order_by(func.sum(SearchDailyStat.zero_results).desc(), SearchDailyStat.term).limit(LIST_LIMIT)
    ).all()

    previous_start = start - timedelta(days=days)
    previous = dict(db.execute(
        select(SearchDailyStat.term, func.sum(SearchDailyStat.searches))
        .where(SearchDailyStat.day >= previous_start, SearchDailyStat.day < start).group_by(SearchDailyStat.term)
    ).all())
    current = db.execute(
        select(SearchDailyStat.term, func.sum(SearchDailyStat.searches)).where(in_range)
        .group_by(SearchDailyStat.term).having(func.sum(SearchDailyStat.searches) >= 3)
    ).all()
    trending = []
    for term, count in current:
        before = int(previous.get(term) or 0)
        count = int(count or 0)
        if count > before:
            change = round((count - before) * 100.0 / before, 1) if before else None
            trending.append({"term": term, "searches": count, "previous": before, "change": change})
    trending.sort(key=lambda t: (-(t["change"] if t["change"] is not None else 10**9), -t["searches"], t["term"]))

    by_day = {row[0]: row[1:] for row in db.execute(
        select(SearchDailyStat.day, func.sum(SearchDailyStat.searches), func.sum(SearchDailyStat.zero_results),
               func.sum(SearchDailyStat.clicks)).where(in_range).group_by(SearchDailyStat.day)
    ).all()}
    series = []
    for offset in range(days):
        day = start + timedelta(days=offset)
        s, z, c = by_day.get(day, (0, 0, 0))
        series.append({"date": day.isoformat(), "searches": int(s or 0), "zeroResults": int(z or 0),
                       "clicks": int(c or 0)})

    return {
        "range": range_key, "from": start.isoformat(), "to": end.isoformat(),
        "totals": {"searches": searches, "uniqueTerms": unique_terms, "zeroResultSearches": zero,
                   "zeroResultRate": _pct(zero, searches), "clicks": clicks, "ctr": _pct(clicked, searches),
                   "conversions": conversions, "conversionRate": _pct(conversions, searches)},
        "topSearches": [{"term": term, "searches": int(s or 0), "clicks": int(c or 0), "ctr": _pct(int(cs or 0), int(s or 0)),
                         "conversions": int(v or 0), "avgResults": round(float(w or 0) / int(s), 1) if s else 0.0}
                        for term, s, cs, c, v, w in top],
        "zeroResults": [{"term": term, "searches": int(s or 0), "lastSearchedAt": last.isoformat() if last else None}
                        for term, s, last in zero_rows],
        "trending": trending[:LIST_LIMIT],
        "series": series,
    }


def auto_popular(db: Session, limit: int = 8) -> List[str]:
    """The most searched terms of the last 30 days that found something (3+ searches)."""
    start = datetime.utcnow().date() - timedelta(days=29)
    rows = db.execute(
        select(SearchDailyStat.term).where(SearchDailyStat.day >= start)
        .group_by(SearchDailyStat.term)
        .having(and_(func.sum(SearchDailyStat.searches) >= 3,
                     func.sum(SearchDailyStat.searches) > func.sum(SearchDailyStat.zero_results)))
        .order_by(func.sum(SearchDailyStat.searches).desc(), SearchDailyStat.term).limit(limit)
    ).scalars()
    return list(rows)


def popular(db: Session, limit: int = 8) -> List[str]:
    """What the storefront offers as popular searches: the curated list, or the automatic one."""
    from app.services.search import settings as search_settings

    if search_settings.popular_mode(db) == "auto":
        found = auto_popular(db, limit)
        if found:
            return found
    return search_settings.curated_popular(db)[:limit]


def summary(db: Session) -> dict:
    """Headline numbers for the admin dashboard."""
    today = datetime.utcnow().date()
    start = datetime.combine(today, datetime.min.time())
    in_today = SearchQuery.created_at >= start
    searches, zero = db.execute(select(
        func.count(SearchQuery.id), func.coalesce(func.sum(case((SearchQuery.zero_results.is_(True), 1), else_=0)), 0),
    ).where(in_today)).one()
    since = datetime.combine(today - timedelta(days=6), datetime.min.time())
    top = db.execute(
        select(SearchQuery.term, func.count(SearchQuery.id)).where(SearchQuery.created_at >= since)
        .group_by(SearchQuery.term).order_by(func.count(SearchQuery.id).desc(), SearchQuery.term).limit(5)
    ).all()
    return {"searchesToday": int(searches or 0), "zeroResultSearchesToday": int(zero or 0),
            "topSearches": [{"term": term, "searches": int(count)} for term, count in top]}

