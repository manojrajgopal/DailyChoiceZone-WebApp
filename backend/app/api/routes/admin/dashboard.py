"""The portal dashboard."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.dependencies.auth import get_current_admin
from app.models import AdminUser, Invoice, Order
from app.schemas.orders import OrderOut
from app.services import analytics as service, orders as order_service
from app.utils.response import ok

router = APIRouter(prefix="/admin/dashboard", tags=["Reports"])


@router.get("", summary="Headline figures and what needs attention")
def dashboard(
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    """
    Every figure is a live aggregate.

    Nothing here is seeded or cached: placing an order moves the sales tile,
    restocking moves the low-stock tile, and approving a review moves the
    badge — without anything else having to run.
    """
    payload = service.dashboard(db)

    recent = order_service.list_orders(db)[:8]
    invoices = {
        invoice.order_id: invoice for invoice in db.execute(select(Invoice)).scalars()
    }

    payload["recentOrders"] = [
        OrderOut.from_model(order, invoices.get(order.id)).model_dump(by_alias=True)
        for order in recent
    ]
    payload["topProducts"] = service.top_products(db, "30d")
    payload["lowStock"] = _low_stock(db)

    return ok(payload)


def _low_stock(db: Session, limit: int = 5):
    from app.models import Product

    available = Product.stock - Product.reserved_stock
    rows = (
        db.execute(
            select(Product)
            .where(Product.status.in_(service.SELLABLE), available <= Product.low_stock_threshold)
            .order_by(available.asc())
            .limit(limit)
        )
        .unique()
        .scalars()
        .all()
    )

    return [
        {
            "productId": product.id,
            "name": product.name,
            "sku": product.sku,
            "stock": product.stock,
            "available": max(0, product.stock - product.reserved_stock),
        }
        for product in rows
    ]
