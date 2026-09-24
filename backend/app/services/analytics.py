"""Dashboard and report figures.

Every number is a query. Nothing is stored, nothing is cached and nothing is
seeded — a dashboard reading a precomputed total is a dashboard that is wrong
the moment somebody places an order, and being slightly slower is a much
cheaper problem than being confidently wrong about money.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

from sqlalchemy import Select, and_, case, func, select
from sqlalchemy.orm import Session

from app.models import (
    Category,
    Customer,
    Order,
    OrderItem,
    Product,
    Review,
)

# The ranges the portal offers, in days. `None` means all time.
RANGES: Dict[str, Optional[int]] = {
    "today": 1,
    "7d": 7,
    "30d": 30,
    "3m": 90,
    "1y": 365,
    "all": None,
}

# Cancelled orders are excluded everywhere: they are not revenue, and counting
# them makes every conversion figure flattering and wrong.
SELLABLE = ("active", "out-of-stock")


def window(range_key: str, now: Optional[datetime] = None) -> Tuple[Optional[datetime], datetime]:
    now = now or datetime.utcnow()
    days = RANGES.get(range_key, 30)
    return (now - timedelta(days=days) if days else None, now)


def _order_conditions(start: Optional[datetime], end: datetime) -> list:
    conditions = [Order.status != "cancelled", Order.placed_at <= end]
    if start:
        conditions.append(Order.placed_at >= start)
    return conditions


def sales_summary(db: Session, range_key: str = "30d") -> dict:
    """
    Revenue, orders, average order value, units and buyers — plus the movement
    against the period before, which is the only thing that makes a number
    mean anything.
    """
    start, end = window(range_key)
    conditions = _order_conditions(start, end)

    row = db.execute(
        select(
            func.coalesce(func.sum(Order.total), 0),
            func.count(Order.id),
            func.count(func.distinct(Order.customer_id)),
            func.coalesce(func.sum(Order.item_count), 0),
        ).where(*conditions)
    ).one()

    revenue, orders, customers, units = row
    revenue = float(revenue)
    orders = int(orders)

    previous = {"revenue": 0.0, "orders": 0}
    if start:
        span = end - start
        prior_start, prior_end = start - span, start
        prior = db.execute(
            select(func.coalesce(func.sum(Order.total), 0), func.count(Order.id)).where(
                Order.status != "cancelled",
                Order.placed_at >= prior_start,
                Order.placed_at < prior_end,
            )
        ).one()
        previous = {"revenue": float(prior[0]), "orders": int(prior[1])}

    return {
        "range": range_key,
        "revenue": revenue,
        "orders": orders,
        "customers": int(customers),
        "unitsSold": int(units),
        "averageOrderValue": round(revenue / orders, 2) if orders else 0.0,
        "revenueDelta": _delta(revenue, previous["revenue"]),
        "ordersDelta": _delta(orders, previous["orders"]),
    }


def _delta(current: float, previous: float) -> Optional[float]:
    """
    Percentage change, or None when there is nothing to compare against.

    None rather than 0 or 100: "up 100%" from a base of zero is not a fact, and
    printing one is how a dashboard starts flattering itself.
    """
    if not previous:
        return None
    return round(((current - previous) / previous) * 100, 1)


def revenue_series(db: Session, range_key: str = "30d") -> List[dict]:
    """Revenue and orders per day, for the chart."""
    start, end = window(range_key)
    conditions = _order_conditions(start, end)

    day = func.date(Order.placed_at)
    rows = db.execute(
        select(day, func.coalesce(func.sum(Order.total), 0), func.count(Order.id))
        .where(*conditions)
        .group_by(day)
        .order_by(day)
    ).all()

    return [
        {"label": str(bucket), "revenue": float(total), "orders": int(count)}
        for bucket, total, count in rows
    ]


def revenue_by_category(db: Session, range_key: str = "30d") -> List[dict]:
    start, end = window(range_key)
    conditions = _order_conditions(start, end)

    rows = db.execute(
        select(
            Category.name,
            func.coalesce(func.sum(OrderItem.line_total), 0),
            func.coalesce(func.sum(OrderItem.quantity), 0),
        )
        .select_from(OrderItem)
        .join(Order, Order.id == OrderItem.order_id)
        .join(Product, Product.id == OrderItem.product_id)
        .join(Category, Category.id == Product.category_id)
        .where(*conditions)
        .group_by(Category.name)
        .order_by(func.sum(OrderItem.line_total).desc())
    ).all()

    return [
        {"label": name, "value": float(revenue), "units": int(units)}
        for name, revenue, units in rows
    ]


def top_products(db: Session, range_key: str = "30d", limit: int = 8) -> List[dict]:
    start, end = window(range_key)
    conditions = _order_conditions(start, end)

    rows = db.execute(
        select(
            OrderItem.product_id,
            OrderItem.name,
            OrderItem.sku,
            func.coalesce(func.sum(OrderItem.quantity), 0),
            func.coalesce(func.sum(OrderItem.line_total), 0),
        )
        .join(Order, Order.id == OrderItem.order_id)
        .where(*conditions)
        .group_by(OrderItem.product_id, OrderItem.name, OrderItem.sku)
        .order_by(func.sum(OrderItem.line_total).desc())
        .limit(limit)
    ).all()

    stock = dict(db.execute(select(Product.id, Product.stock)).all())

    return [
        {
            "productId": product_id,
            "name": name,
            "sku": sku,
            "units": int(units),
            "revenue": float(revenue),
            "stock": stock.get(product_id, 0),
        }
        for product_id, name, sku, units, revenue in rows
    ]


def order_status_breakdown(db: Session, range_key: str = "30d") -> List[dict]:
    start, end = window(range_key)
    conditions = [Order.placed_at <= end]
    if start:
        conditions.append(Order.placed_at >= start)

    rows = db.execute(
        select(Order.status, func.count(Order.id))
        .where(*conditions)
        .group_by(Order.status)
        .order_by(func.count(Order.id).desc())
    ).all()

    return [{"label": status, "value": int(count)} for status, count in rows]


def dashboard(db: Session) -> dict:
    """
    The headline tiles.

    Product count is **sellable** products — drafts and archived ones are not
    something the shop has to offer, and counting them overstates the catalogue.
    Low stock counts *available* units, which is stock minus what is already
    reserved.
    """
    summary = sales_summary(db, "30d")

    product_count = db.execute(
        select(func.count()).select_from(Product).where(Product.status.in_(SELLABLE))
    ).scalar_one()

    customer_count = db.execute(select(func.count()).select_from(Customer)).scalar_one()

    available = Product.stock - Product.reserved_stock
    low_stock = db.execute(
        select(func.count())
        .select_from(Product)
        .where(
            Product.status.in_(SELLABLE),
            available > 0,
            available <= Product.low_stock_threshold,
        )
    ).scalar_one()

    open_orders = db.execute(
        select(func.count())
        .select_from(Order)
        .where(Order.status.in_(("pending", "confirmed", "processing")))
    ).scalar_one()

    pending_reviews = db.execute(
        select(func.count()).select_from(Review).where(Review.status == "pending")
    ).scalar_one()

    return {
        "generatedAt": datetime.utcnow(),
        "stats": [
            {
                "id": "sales",
                "label": "Total sales",
                "value": summary["revenue"],
                "format": "currency",
                "delta": summary["revenueDelta"],
                "href": "/admin/reports",
                "icon": "sales",
            },
            {
                "id": "orders",
                "label": "Orders",
                "value": summary["orders"],
                "format": "number",
                "delta": summary["ordersDelta"],
                "href": "/admin/orders",
                "icon": "orders",
            },
            {
                "id": "customers",
                "label": "Customers",
                "value": int(customer_count),
                "format": "number",
                "delta": None,
                "href": "/admin/customers",
                "icon": "customers",
            },
            {
                "id": "products",
                "label": "Products",
                "value": int(product_count),
                "format": "number",
                "delta": None,
                "href": "/admin/products",
                "icon": "products",
            },
            {
                "id": "lowStock",
                "label": "Low stock",
                "value": int(low_stock),
                "format": "number",
                "delta": None,
                "href": "/admin/inventory",
                "icon": "alert",
            },
        ],
        "badges": {
            "openOrders": int(open_orders),
            "lowStock": int(low_stock),
            "pendingReviews": int(pending_reviews),
        },
    }


def analytics(db: Session, range_key: str = "30d") -> dict:
    """Everything the reports page and the dashboard charts read, in one call."""
    summary = sales_summary(db, range_key)

    return {
        **summary,
        "series": revenue_series(db, range_key),
        "byCategory": revenue_by_category(db, range_key),
        "topProducts": top_products(db, range_key),
        "orderStatus": order_status_breakdown(db, range_key),
    }
