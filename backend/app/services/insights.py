"""
Advanced analytics for the portal: sales, customers, products, marketing and
the conversion funnel, over any period, compared with the one before.

## Where every number comes from

From the tables that record what happened — orders, order lines, refunds,
customers, coupons, flash-sale claims, bundles, referrals, gift cards — read
at the moment they are asked for. Visits, product views, bag additions and
checkouts opened come from `analytics_events` (see `services.analytics_events`),
because no other table holds them. Nothing is estimated, sampled or typed in.

## Rules applied everywhere

- **Revenue** is the total of orders placed in the period that weren't
  cancelled — what was charged, including tax and delivery. **Net revenue**
  takes away refunds completed in the period.
- Days start at midnight **India time** (the store's), not UTC.
- A comparison is against the period of the same length just before, or the
  same dates a year earlier. A change from zero is shown as "new", never as an
  invented percentage.

## Speed

Every figure is a grouped query on indexed columns (order placed time, event
type and time). Results are cached for a minute, keyed by the question *and*
by a fingerprint of the data (how many orders, the latest change to one, the
latest event, refund and customer), so a new order shows at once rather than
a minute later.
"""

from __future__ import annotations

import csv
import io
import threading
import time
from datetime import date, datetime, timedelta
from typing import Callable, Dict, List, Optional, Tuple

from sqlalchemy import distinct, func, literal_column, select
from sqlalchemy.orm import Session

from app.core.errors import ValidationError
from app.models import (
    AnalyticsEvent,
    Bundle,
    CartRecovery,
    Category,
    Customer,
    FlashSale,
    FlashSaleClaim,
    GiftCard,
    Order,
    OrderItem,
    Product,
    Referral,
    Refund,
    ReturnRequest,
    ReturnRequestItem,
)
from app.services import billing

IST = timedelta(hours=5, minutes=30)
PRESETS = {"today": 1, "7d": 7, "30d": 30, "90d": 90, "12m": 365}
MAX_DAYS = 731
CACHE_SECONDS = 60
NOT_CANCELLED = Order.status != "cancelled"
SUCCESSFUL_PAYMENT = ("paid", "cod-pending", "partially-refunded", "refunded")

_cache: Dict[tuple, Tuple[float, object]] = {}
_lock = threading.Lock()


# ------------------------------------------------------------------ periods


class Period:
    """A window in UTC, built from whole days in India time."""

    def __init__(self, start: datetime, end: datetime, label: str):
        self.start, self.end, self.label = start, end, label

    @property
    def days(self) -> int:
        return max(1, round((self.end - self.start).total_seconds() / 86400))

    def view(self) -> dict:
        return {"start": self.start, "end": self.end, "label": self.label,
                "startDate": (self.start + IST).date().isoformat(),
                "endDate": (self.end + IST - timedelta(seconds=1)).date().isoformat()}


def _ist_midnight(day: date) -> datetime:
    return datetime(day.year, day.month, day.day) - IST


def period(range_key: str = "30d", start: Optional[str] = None, end: Optional[str] = None,
           now: Optional[datetime] = None) -> Period:
    now = now or datetime.utcnow()
    today = (now + IST).date()
    if range_key == "custom":
        try:
            first = date.fromisoformat(start or "")
            last = date.fromisoformat(end or "")
        except ValueError:
            raise ValidationError("Choose a start and end date.", error_code="INVALID_RANGE") from None
        if last < first:
            raise ValidationError("The end date is before the start date.", error_code="INVALID_RANGE")
        if (last - first).days + 1 > MAX_DAYS:
            raise ValidationError("Choose at most two years.", error_code="INVALID_RANGE")
        return Period(_ist_midnight(first), _ist_midnight(last + timedelta(days=1)),
                      f"{first:%d %b %Y} – {last:%d %b %Y}")
    if range_key == "ytd":
        first = date(today.year, 1, 1)
        return Period(_ist_midnight(first), _ist_midnight(today + timedelta(days=1)), "Year to date")
    days = PRESETS.get(range_key)
    if days is None:
        raise ValidationError("Unknown period.", error_code="INVALID_RANGE")
    first = today - timedelta(days=days - 1)
    labels = {"today": "Today", "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days",
              "12m": "Last 12 months"}
    return Period(_ist_midnight(first), _ist_midnight(today + timedelta(days=1)), labels[range_key])


def comparison(current: Period, mode: str) -> Optional[Period]:
    if mode == "none":
        return None
    if mode == "year":
        def shift(when: datetime) -> datetime:
            local = when + IST
            try:
                return local.replace(year=local.year - 1) - IST
            except ValueError:  # 29 February
                return local.replace(year=local.year - 1, day=28) - IST
        return Period(shift(current.start), shift(current.end), "Same period last year")
    if mode != "previous":
        raise ValidationError("Compare with the previous period, last year, or nothing.", error_code="INVALID_COMPARE")
    span = current.end - current.start
    return Period(current.start - span, current.start, "Previous period")


def granularity(current: Period, wanted: str = "auto") -> str:
    if wanted in ("day", "week", "month"):
        return wanted
    return "day" if current.days <= 62 else "week" if current.days <= 200 else "month"


def _local_day(column):
    """The India-time calendar date of a UTC column, in SQL."""
    return func.date(func.date_add(column, literal_column("INTERVAL 330 MINUTE")))


def _bucket(day: date, unit: str) -> date:
    if unit == "week":
        return day - timedelta(days=day.weekday())
    if unit == "month":
        return day.replace(day=1)
    return day


def _buckets(p: Period, unit: str) -> List[date]:
    first = (p.start + IST).date()
    last = (p.end + IST - timedelta(seconds=1)).date()
    out, day = [], _bucket(first, unit)
    while day <= last:
        out.append(day)
        if unit == "day":
            day += timedelta(days=1)
        elif unit == "week":
            day += timedelta(days=7)
        else:
            day = (day.replace(day=28) + timedelta(days=4)).replace(day=1)
    return out


def _as_date(value) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value))


def delta(current: float, previous: Optional[float]) -> Optional[float]:
    if previous is None:
        return None
    if not previous:
        return None
    return round((current - previous) / abs(previous) * 100, 1)


def _metric(current: float, previous: Optional[float], fmt: str) -> dict:
    return {"value": current, "previous": previous, "delta": delta(current, previous),
            "isNew": bool(previous == 0 and current), "format": fmt}


# ------------------------------------------------------------------ cache


def _fingerprint(db: Session) -> tuple:
    orders = db.execute(select(func.count(Order.id), func.max(Order.updated_at))).one()
    return (
        int(orders[0] or 0), orders[1],
        db.execute(select(func.max(AnalyticsEvent.id))).scalar(),
        db.execute(select(func.max(Refund.updated_at))).scalar(),
        db.execute(select(func.count(Customer.id))).scalar(),
        db.execute(select(func.max(Referral.updated_at))).scalar(),
        db.execute(select(func.max(FlashSaleClaim.updated_at))).scalar(),
    )


def cached(db: Session, key: tuple, build: Callable[[], object]) -> object:
    full = key + _fingerprint(db)
    now = time.monotonic()
    with _lock:
        hit = _cache.get(full)
        if hit and hit[0] > now:
            return hit[1]
    value = build()
    with _lock:
        if len(_cache) > 200:
            for stale in [k for k, (expires, _) in _cache.items() if expires <= now] or list(_cache)[:100]:
                _cache.pop(stale, None)
        _cache[full] = (now + CACHE_SECONDS, value)
    return value


def clear_cache() -> None:
    with _lock:
        _cache.clear()


# -------------------------------------------------------------------- sales


def _orders_in(p: Period) -> list:
    return [Order.placed_at >= p.start, Order.placed_at < p.end]


def _sales_totals(db: Session, p: Period) -> dict:
    row = db.execute(select(
        func.coalesce(func.sum(Order.total), 0), func.count(Order.id), func.count(distinct(Order.customer_id)),
        func.coalesce(func.sum(Order.item_count), 0), func.coalesce(func.sum(Order.tax_amount), 0),
        func.coalesce(func.sum(Order.delivery_fee), 0),
        func.coalesce(func.sum(Order.coupon_discount + Order.member_discount), 0),
        func.coalesce(func.sum(Order.catalogue_savings), 0),
    ).where(NOT_CANCELLED, *_orders_in(p))).one()
    refunds = db.execute(select(func.coalesce(func.sum(Refund.amount), 0)).where(
        Refund.status == "completed", Refund.updated_at >= p.start, Refund.updated_at < p.end)).scalar_one()
    cancelled = db.execute(select(func.count(Order.id)).where(Order.status == "cancelled", *_orders_in(p))).scalar_one()
    revenue = float(row[0])
    orders = int(row[1])
    refunded = billing.to_major(int(refunds))
    return {
        "revenue": round(revenue, 2), "orders": orders, "buyers": int(row[2]), "units": int(row[3]),
        "tax": float(row[4]), "shipping": float(row[5]), "discounts": float(row[6]), "catalogueSavings": float(row[7]),
        "refunds": refunded, "netRevenue": round(revenue - refunded, 2),
        "averageOrderValue": round(revenue / orders, 2) if orders else 0.0,
        "cancelled": int(cancelled),
    }


def _series(db: Session, p: Period, unit: str) -> List[dict]:
    day = _local_day(Order.placed_at)
    rows = db.execute(select(day, func.coalesce(func.sum(Order.total), 0), func.count(Order.id),
                             func.coalesce(func.sum(Order.item_count), 0))
                      .where(NOT_CANCELLED, *_orders_in(p)).group_by(day)).all()
    by_bucket: Dict[date, list] = {}
    for when, revenue, orders, units in rows:
        bucket = _bucket(_as_date(when), unit)
        acc = by_bucket.setdefault(bucket, [0.0, 0, 0])
        acc[0] += float(revenue)
        acc[1] += int(orders)
        acc[2] += int(units)
    return [{"label": b.isoformat(), "revenue": round(by_bucket.get(b, [0, 0, 0])[0], 2),
             "orders": by_bucket.get(b, [0, 0, 0])[1], "units": by_bucket.get(b, [0, 0, 0])[2]}
            for b in _buckets(p, unit)]


def _breakdown(db: Session, p: Period, column, label_fn=lambda v: v or "Unknown") -> List[dict]:
    rows = db.execute(select(column, func.coalesce(func.sum(Order.total), 0), func.count(Order.id))
                      .where(NOT_CANCELLED, *_orders_in(p)).group_by(column)
                      .order_by(func.sum(Order.total).desc())).all()
    total = sum(float(r[1]) for r in rows) or 0
    return [{"label": label_fn(value), "key": value or "", "revenue": float(revenue), "orders": int(orders),
             "share": round(float(revenue) / total * 100, 1) if total else 0} for value, revenue, orders in rows]


def _by_category(db: Session, p: Period) -> List[dict]:
    rows = db.execute(
        select(Category.name, func.coalesce(func.sum(OrderItem.line_total), 0), func.coalesce(func.sum(OrderItem.quantity), 0))
        .select_from(OrderItem).join(Order, Order.id == OrderItem.order_id)
        .join(Product, Product.id == OrderItem.product_id).join(Category, Category.id == Product.category_id)
        .where(NOT_CANCELLED, *_orders_in(p)).group_by(Category.name).order_by(func.sum(OrderItem.line_total).desc())
    ).all()
    total = sum(float(r[1]) for r in rows) or 0
    return [{"label": name, "key": name, "revenue": float(rev), "units": int(units),
             "share": round(float(rev) / total * 100, 1) if total else 0} for name, rev, units in rows]


PAYMENT_LABELS = {"cod": "Cash on delivery", "upi": "UPI", "card": "Card", "netbanking": "Net banking",
                  "wallet": "Wallet", "tender": "Gift card / credit / points", "qr": "UPI QR", "link": "Payment link"}


def sales(db: Session, p: Period, cmp: Optional[Period], unit: str) -> dict:
    current = _sales_totals(db, p)
    previous = _sales_totals(db, cmp) if cmp else None
    formats = {"revenue": "currency", "netRevenue": "currency", "orders": "number", "averageOrderValue": "currency",
               "units": "number", "buyers": "number", "refunds": "currency", "discounts": "currency",
               "tax": "currency", "shipping": "currency", "cancelled": "number"}
    return {
        "metrics": {k: _metric(current[k], previous[k] if previous else None, f) for k, f in formats.items()},
        "series": _series(db, p, unit),
        "previousSeries": _series(db, cmp, unit) if cmp else None,
        "breakdowns": {
            "category": _by_category(db, p),
            "paymentMethod": _breakdown(db, p, Order.payment_method, lambda v: PAYMENT_LABELS.get(v, (v or "Unknown").title())),
            "state": _breakdown(db, p, Order.shipping_state),
            "deliveryMethod": _breakdown(db, p, Order.delivery_method, lambda v: (v or "Unknown").title()),
            "status": [{"label": s.replace("-", " ").title(), "key": s, "orders": int(n)} for s, n in db.execute(
                select(Order.status, func.count(Order.id)).where(*_orders_in(p)).group_by(Order.status)
                .order_by(func.count(Order.id).desc())).all()],
        },
    }


# ---------------------------------------------------------------- customers


def _customer_totals(db: Session, p: Period) -> dict:
    signups = db.execute(select(func.count(Customer.id)).where(Customer.joined_at >= p.start,
                                                               Customer.joined_at < p.end)).scalar_one()
    buyers = db.execute(select(Order.customer_id, func.count(Order.id)).where(NOT_CANCELLED, *_orders_in(p))
                        .group_by(Order.customer_id)).all()
    ids = [b[0] for b in buyers]
    first_orders = dict(db.execute(select(Order.customer_id, func.min(Order.placed_at)).where(
        NOT_CANCELLED, Order.customer_id.in_(ids)).group_by(Order.customer_id)).all()) if ids else {}
    new = sum(1 for cid in ids if first_orders.get(cid) and first_orders[cid] >= p.start)
    repeat = sum(1 for _, n in buyers if n >= 2)
    orders = sum(int(n) for _, n in buyers)
    return {"signups": int(signups), "buyers": len(ids), "newBuyers": new, "returningBuyers": len(ids) - new,
            "repeatRate": round(repeat / len(ids) * 100, 1) if ids else 0.0,
            "ordersPerBuyer": round(orders / len(ids), 2) if ids else 0.0}


def customers(db: Session, p: Period, cmp: Optional[Period], unit: str) -> dict:
    current = _customer_totals(db, p)
    previous = _customer_totals(db, cmp) if cmp else None
    formats = {"signups": "number", "buyers": "number", "newBuyers": "number", "returningBuyers": "number",
               "repeatRate": "percent", "ordersPerBuyer": "decimal"}
    lifetime = db.execute(select(func.coalesce(func.sum(Order.total), 0), func.count(distinct(Order.customer_id)))
                          .where(NOT_CANCELLED)).one()
    top = db.execute(select(Order.customer_id, func.sum(Order.total), func.count(Order.id))
                     .where(NOT_CANCELLED, *_orders_in(p)).group_by(Order.customer_id)
                     .order_by(func.sum(Order.total).desc()).limit(10)).all()
    people = {c.id: c for c in db.execute(select(Customer).where(Customer.id.in_([t[0] for t in top]))).scalars()} if top else {}
    day = _local_day(Customer.joined_at)
    signup_rows = db.execute(select(day, func.count(Customer.id)).where(
        Customer.joined_at >= p.start, Customer.joined_at < p.end).group_by(day)).all()
    by_bucket: Dict[date, int] = {}
    for when, n in signup_rows:
        b = _bucket(_as_date(when), unit)
        by_bucket[b] = by_bucket.get(b, 0) + int(n)
    return {
        "metrics": {k: _metric(current[k], previous[k] if previous else None, f) for k, f in formats.items()},
        "lifetimeValue": round(float(lifetime[0]) / int(lifetime[1]), 2) if lifetime[1] else 0.0,
        "signupSeries": [{"label": b.isoformat(), "value": by_bucket.get(b, 0)} for b in _buckets(p, unit)],
        "topCustomers": [{"id": cid, "name": people[cid].full_name if cid in people else cid,
                          "email": people[cid].email if cid in people else "", "revenue": float(rev), "orders": int(n)}
                         for cid, rev, n in top],
    }


# ----------------------------------------------------------------- products


def products(db: Session, p: Period, limit: int = 20) -> dict:
    sold = db.execute(
        select(OrderItem.product_id, func.max(OrderItem.name), func.sum(OrderItem.quantity),
               func.sum(OrderItem.line_total), func.count(distinct(Order.customer_id)))
        .join(Order, Order.id == OrderItem.order_id).where(NOT_CANCELLED, *_orders_in(p))
        .group_by(OrderItem.product_id)
    ).all()
    views = dict(db.execute(select(AnalyticsEvent.product_id, func.count(distinct(AnalyticsEvent.visitor_id))).where(
        AnalyticsEvent.event == "product_view", AnalyticsEvent.occurred_at >= p.start,
        AnalyticsEvent.occurred_at < p.end).group_by(AnalyticsEvent.product_id)).all())
    carts = dict(db.execute(select(AnalyticsEvent.product_id, func.count(distinct(AnalyticsEvent.customer_id))).where(
        AnalyticsEvent.event == "add_to_cart", AnalyticsEvent.occurred_at >= p.start,
        AnalyticsEvent.occurred_at < p.end).group_by(AnalyticsEvent.product_id)).all())
    returned = dict(db.execute(select(ReturnRequestItem.product_id, func.sum(ReturnRequestItem.quantity))
                               .join(ReturnRequest, ReturnRequest.id == ReturnRequestItem.request_id)
                               .where(ReturnRequest.created_at >= p.start, ReturnRequest.created_at < p.end,
                                      ReturnRequest.status.notin_(("rejected", "cancelled")))
                               .group_by(ReturnRequestItem.product_id)).all())
    ids = set(views) | {r[0] for r in sold}
    catalogue = {pr.id: pr for pr in db.execute(select(Product).where(Product.id.in_(ids))).scalars()} if ids else {}

    rows = []
    for pid, name, units, revenue, buyers in sold:
        viewers = int(views.get(pid, 0))
        rows.append({"productId": pid, "name": name, "units": int(units or 0), "revenue": float(revenue or 0),
                     "buyers": int(buyers or 0), "views": viewers, "addedToBag": int(carts.get(pid, 0)),
                     "conversion": round(int(buyers or 0) / viewers * 100, 1) if viewers else None,
                     "returned": int(returned.get(pid, 0)),
                     "returnRate": round(int(returned.get(pid, 0)) / int(units) * 100, 1) if units else 0,
                     "stock": catalogue[pid].available_stock if pid in catalogue else None})
    by_revenue = sorted(rows, key=lambda r: r["revenue"], reverse=True)[:limit]
    by_units = sorted(rows, key=lambda r: r["units"], reverse=True)[:limit]
    sold_ids = {r["productId"] for r in rows}
    viewed_unsold = sorted(
        ({"productId": pid, "name": catalogue[pid].name, "views": int(n), "addedToBag": int(carts.get(pid, 0))}
         for pid, n in views.items() if pid not in sold_ids and pid in catalogue),
        key=lambda r: r["views"], reverse=True)[:limit]
    sellable = db.execute(select(func.count(Product.id)).where(Product.status.in_(("active", "out-of-stock")))).scalar_one()
    low = db.execute(select(Product).where(Product.status.in_(("active", "out-of-stock")),
                                           (Product.stock - Product.reserved_stock) <= Product.low_stock_threshold)
                     .order_by((Product.stock - Product.reserved_stock)).limit(limit)).scalars().all()
    return {
        "topByRevenue": by_revenue,
        "topByUnits": by_units,
        "mostViewed": sorted(
            ({"productId": pid, "name": catalogue[pid].name if pid in catalogue else pid, "views": int(n),
              "buyers": next((r["buyers"] for r in rows if r["productId"] == pid), 0)}
             for pid, n in views.items()), key=lambda r: r["views"], reverse=True)[:limit],
        "viewedNotBought": viewed_unsold,
        "highestReturns": sorted([r for r in rows if r["returned"]], key=lambda r: r["returnRate"], reverse=True)[:limit],
        "productsSold": len(rows),
        "productsWithoutSales": max(0, int(sellable) - len(rows)),
        "lowStock": [{"productId": pr.id, "name": pr.name, "available": pr.available_stock,
                      "threshold": pr.low_stock_threshold} for pr in low],
    }


# ---------------------------------------------------------------- marketing


def marketing(db: Session, p: Period) -> dict:
    coupons = db.execute(
        select(Order.coupon_code, func.count(Order.id), func.sum(Order.coupon_discount), func.sum(Order.total))
        .where(NOT_CANCELLED, *_orders_in(p), Order.coupon_code.is_not(None), Order.coupon_code != "")
        .group_by(Order.coupon_code).order_by(func.count(Order.id).desc()).limit(20)
    ).all()
    flash = db.execute(
        select(FlashSale.id, FlashSale.name, func.sum(FlashSaleClaim.quantity),
               func.sum(FlashSaleClaim.quantity * FlashSaleClaim.unit_price),
               func.sum(FlashSaleClaim.quantity * (FlashSaleClaim.regular_price - FlashSaleClaim.unit_price)))
        .join(FlashSale, FlashSale.id == FlashSaleClaim.sale_id)
        .where(FlashSaleClaim.state == "consumed", FlashSaleClaim.created_at >= p.start,
               FlashSaleClaim.created_at < p.end)
        .group_by(FlashSale.id, FlashSale.name).order_by(func.sum(FlashSaleClaim.quantity).desc())
    ).all()
    bundle_groups = db.execute(
        select(OrderItem.bundle_id, OrderItem.order_id, OrderItem.bundle_group, func.max(OrderItem.bundle_quantity),
               func.sum(OrderItem.line_total))
        .join(Order, Order.id == OrderItem.order_id)
        .where(NOT_CANCELLED, *_orders_in(p), OrderItem.bundle_id.is_not(None))
        .group_by(OrderItem.bundle_id, OrderItem.order_id, OrderItem.bundle_group)
    ).all()
    bundle_stats: Dict[int, dict] = {}
    for bundle_id, _o, _g, qty, revenue in bundle_groups:
        row = bundle_stats.setdefault(int(bundle_id), {"orders": 0, "units": 0, "revenue": 0.0})
        row["orders"] += 1
        row["units"] += int(qty or 0)
        row["revenue"] = round(row["revenue"] + float(revenue or 0), 2)
    names = {b.id: b.name for b in db.execute(select(Bundle).where(Bundle.id.in_(list(bundle_stats)))).scalars()} if bundle_stats else {}
    referral_signups = db.execute(select(func.count(Referral.id)).where(
        Referral.created_at >= p.start, Referral.created_at < p.end)).scalar_one()
    referral_rewarded = db.execute(select(func.count(Referral.id), func.coalesce(func.sum(Referral.referrer_reward + Referral.referee_reward), 0))
                                   .where(Referral.status == "rewarded", Referral.reward_type == "store_credit",
                                          Referral.rewarded_at >= p.start, Referral.rewarded_at < p.end)).one()
    referral_points = db.execute(select(func.count(Referral.id)).where(
        Referral.status == "rewarded", Referral.reward_type == "points",
        Referral.rewarded_at >= p.start, Referral.rewarded_at < p.end)).scalar_one()
    gift = db.execute(select(func.count(GiftCard.id), func.coalesce(func.sum(GiftCard.initial_amount), 0)).where(
        GiftCard.source == "purchase", GiftCard.paid_at >= p.start, GiftCard.paid_at < p.end)).one()
    tenders = db.execute(select(func.coalesce(func.sum(Order.gift_card_amount), 0),
                                func.coalesce(func.sum(Order.store_credit_amount), 0),
                                func.coalesce(func.sum(Order.points_amount), 0))
                         .where(NOT_CANCELLED, *_orders_in(p))).one()
    recovered = db.execute(select(func.count(CartRecovery.id), func.coalesce(func.sum(CartRecovery.recovered_value), 0))
                           .where(CartRecovery.recovered_at >= p.start, CartRecovery.recovered_at < p.end)).one()
    abandoned = db.execute(select(func.count(CartRecovery.id)).where(
        CartRecovery.abandoned_at >= p.start, CartRecovery.abandoned_at < p.end)).scalar_one()
    in_period = [AnalyticsEvent.event == "visit", AnalyticsEvent.occurred_at >= p.start, AnalyticsEvent.occurred_at < p.end]
    sources = db.execute(select(AnalyticsEvent.source, func.count(AnalyticsEvent.id)).where(*in_period)
                         .group_by(AnalyticsEvent.source).order_by(func.count(AnalyticsEvent.id).desc()).limit(15)).all()
    devices = db.execute(select(AnalyticsEvent.device, func.count(AnalyticsEvent.id)).where(*in_period)
                         .group_by(AnalyticsEvent.device)).all()
    return {
        "coupons": [{"code": code, "orders": int(n), "discount": float(d or 0), "revenue": float(r or 0)}
                    for code, n, d, r in coupons],
        "flashSales": [{"id": sid, "name": name, "units": int(u or 0), "revenue": billing.to_major(int(r or 0)),
                        "savings": billing.to_major(int(s or 0))} for sid, name, u, r, s in flash],
        "bundles": [{"id": bid, "name": names.get(bid, f"Bundle {bid}"), **stats}
                    for bid, stats in sorted(bundle_stats.items(), key=lambda kv: kv[1]["revenue"], reverse=True)],
        "referrals": {"signups": int(referral_signups), "rewarded": int(referral_rewarded[0]) + int(referral_points),
                      "creditCost": billing.to_major(int(referral_rewarded[1]))},
        "giftCards": {"sold": int(gift[0]), "value": billing.to_major(int(gift[1]))},
        "tenders": {"giftCards": float(tenders[0]), "storeCredit": float(tenders[1]), "points": float(tenders[2])},
        "abandonedCarts": {"abandoned": int(abandoned), "recovered": int(recovered[0]),
                           "recoveredValue": billing.to_major(int(recovered[1] or 0))},
        "trafficSources": [{"label": (s or "Unknown"), "visits": int(n)} for s, n in sources],
        "devices": [{"label": (d or "Unknown").title(), "visits": int(n)} for d, n in devices],
    }


# ------------------------------------------------------------------- funnel


def _funnel_counts(db: Session, p: Period) -> List[dict]:
    def events(name: str, column):
        return int(db.execute(select(func.count(distinct(column))).where(
            AnalyticsEvent.event == name, AnalyticsEvent.occurred_at >= p.start, AnalyticsEvent.occurred_at < p.end,
            column.is_not(None), column != "")).scalar_one())

    placed = int(db.execute(select(func.count(distinct(Order.customer_id))).where(*_orders_in(p))).scalar_one())
    bought = int(db.execute(select(func.count(distinct(Order.customer_id))).where(
        NOT_CANCELLED, *_orders_in(p),
        Order.payment_status.in_(SUCCESSFUL_PAYMENT) | (Order.payment_method == "cod"))).scalar_one())
    stages = [
        ("visitors", "Visitors", events("visit", AnalyticsEvent.visitor_id)),
        ("productViews", "Viewed a product", events("product_view", AnalyticsEvent.visitor_id)),
        ("addToCart", "Added to bag", events("add_to_cart", AnalyticsEvent.customer_id)),
        ("checkout", "Started checkout", events("checkout_start", AnalyticsEvent.visitor_id)),
        ("paymentAttempt", "Placed an order", placed),
        ("purchase", "Completed a purchase", bought),
    ]
    out, top = [], stages[0][2]
    for index, (key, label, count) in enumerate(stages):
        prev = stages[index - 1][2] if index else None
        out.append({"key": key, "label": label, "count": count,
                    "fromPrevious": round(count / prev * 100, 1) if prev else None,
                    "fromTop": round(count / top * 100, 1) if top else None})
    return out


def funnel(db: Session, p: Period, cmp: Optional[Period]) -> dict:
    stages = _funnel_counts(db, p)
    previous = _funnel_counts(db, cmp) if cmp else None
    if previous:
        for stage, before in zip(stages, previous):
            stage["previous"] = before["count"]
            stage["delta"] = delta(stage["count"], before["count"])
    visitors, purchases = stages[0]["count"], stages[-1]["count"]
    return {"stages": stages, "conversionRate": round(purchases / visitors * 100, 2) if visitors else None,
            "note": "Visitors, product views and checkouts come from the storefront; orders and purchases from the "
                    "order records. People are counted once per stage."}


# ------------------------------------------------------------------ report


SECTIONS = ("sales", "customers", "products", "marketing", "funnel")


def report(db: Session, section: str, *, range_key: str = "30d", start: Optional[str] = None,
           end: Optional[str] = None, compare: str = "previous", unit: str = "auto") -> dict:
    if section not in SECTIONS:
        raise ValidationError("Unknown report.", error_code="INVALID_REPORT")
    p = period(range_key, start, end)
    cmp = comparison(p, compare)
    g = granularity(p, unit)

    def build():
        if section == "sales":
            body = sales(db, p, cmp, g)
        elif section == "customers":
            body = customers(db, p, cmp, g)
        elif section == "products":
            body = products(db, p)
        elif section == "marketing":
            body = marketing(db, p)
        else:
            body = funnel(db, p, cmp)
        return {"section": section, "period": p.view(), "comparison": cmp.view() if cmp else None,
                "granularity": g, "generatedAt": datetime.utcnow(), **body}

    return cached(db, (section, range_key, start, end, compare, g), build)


# --------------------------------------------------------------------- CSV


def _csv(header: List[str], rows: List[list]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(header)
    for row in rows:
        # A cell starting with = + - @ is a formula to a spreadsheet; neutralise it.
        writer.writerow([f"'{c}" if isinstance(c, str) and c[:1] in ("=", "+", "-", "@") else c for c in row])
    return buffer.getvalue()


EXPORTS = ("sales", "categories", "payment-methods", "states", "products", "customers", "coupons", "funnel",
           "flash-sales", "bundles")


def export(db: Session, kind: str, **params) -> Tuple[str, str]:
    """(filename, CSV text) for one table of the report."""
    if kind not in EXPORTS:
        raise ValidationError("Unknown export.", error_code="INVALID_EXPORT")
    section = {"sales": "sales", "categories": "sales", "payment-methods": "sales", "states": "sales",
               "products": "products", "customers": "customers", "coupons": "marketing", "funnel": "funnel",
               "flash-sales": "marketing", "bundles": "marketing"}[kind]
    data = report(db, section, **params)
    period_view = data["period"]
    name = f"{kind}-{period_view['startDate']}-to-{period_view['endDate']}.csv"
    if kind == "sales":
        prev = data.get("previousSeries") or []
        rows = [[r["label"], r["revenue"], r["orders"], r["units"],
                 prev[i]["revenue"] if i < len(prev) else "", prev[i]["orders"] if i < len(prev) else ""]
                for i, r in enumerate(data["series"])]
        return name, _csv(["period", "revenue", "orders", "units", "previous_revenue", "previous_orders"], rows)
    if kind in ("categories", "payment-methods", "states"):
        key = {"categories": "category", "payment-methods": "paymentMethod", "states": "state"}[kind]
        rows = [[r["label"], r["revenue"], r.get("orders", r.get("units", "")), r["share"]] for r in data["breakdowns"][key]]
        return name, _csv(["label", "revenue", "orders_or_units", "share_percent"], rows)
    if kind == "products":
        rows = [[r["productId"], r["name"], r["units"], r["revenue"], r["buyers"], r["views"], r["addedToBag"],
                 r["conversion"] if r["conversion"] is not None else "", r["returned"], r["returnRate"]]
                for r in data["topByRevenue"]]
        return name, _csv(["product_id", "name", "units", "revenue", "buyers", "viewers", "added_to_bag",
                           "conversion_percent", "returned", "return_rate_percent"], rows)
    if kind == "customers":
        rows = [[r["id"], r["name"], r["email"], r["revenue"], r["orders"]] for r in data["topCustomers"]]
        return name, _csv(["customer_id", "name", "email", "revenue", "orders"], rows)
    if kind == "coupons":
        return name, _csv(["code", "orders", "discount", "revenue"],
                          [[r["code"], r["orders"], r["discount"], r["revenue"]] for r in data["coupons"]])
    if kind == "flash-sales":
        return name, _csv(["sale_id", "name", "units", "revenue", "customer_savings"],
                          [[r["id"], r["name"], r["units"], r["revenue"], r["savings"]] for r in data["flashSales"]])
    if kind == "bundles":
        return name, _csv(["bundle_id", "name", "orders", "units", "revenue"],
                          [[r["id"], r["name"], r["orders"], r["units"], r["revenue"]] for r in data["bundles"]])
    rows = [[s["label"], s["count"], s.get("fromPrevious") or "", s.get("fromTop") or "", s.get("previous", "")]
            for s in data["stages"]]
    return name, _csv(["stage", "count", "percent_of_previous", "percent_of_visitors", "previous_period"], rows)


