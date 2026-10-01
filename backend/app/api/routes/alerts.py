"""
Back-in-stock and price-drop alerts.

    GET    /api/alerts                       your alerts (stock and price)
    GET    /api/alerts/products/{id}         your active alerts on one product
    POST   /api/alerts/stock                 notify me when it's back
    POST   /api/alerts/price                 notify me when it's cheaper (any drop, or a target)
    DELETE /api/alerts/{kind}/{id}           unsubscribe

    GET    /api/admin/alerts/{kind}          stock or price alerts: search, filter, page
    POST   /api/admin/alerts/{kind}/{id}/resend   send again (failed, bounced, or overdue)
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Path, Query
from pydantic import Field
from sqlalchemy.orm import Session

from app.core import rate_limit
from app.core.database import get_db
from app.dependencies.auth import get_current_customer, require_access
from app.models import AdminUser, Customer
from app.schemas.base import CamelModel
from app.services import alerts as service
from app.utils.response import Pagination, ok

router = APIRouter(prefix="/alerts", tags=["Alerts"])
admin_router = APIRouter(prefix="/admin/alerts", tags=["Admin · Alerts"])

KIND = Path(..., pattern="^(stock|price)$")


class StockAlertRequest(CamelModel):
    product_id: str = Field(min_length=1, max_length=160)
    size: str = Field(default="", max_length=30)
    color: str = Field(default="", max_length=60)


class PriceAlertRequest(CamelModel):
    product_id: str = Field(min_length=1, max_length=160)
    mode: str = Field(default="any", pattern="^(any|target)$")
    target_price: Optional[float] = Field(default=None, gt=0, le=10_000_000)


def _limit(customer: Customer) -> None:
    rate_limit.check(f"alerts:{customer.id}", limit=30, window_seconds=600,
                     message="That's a lot of alerts at once. Please try again in a few minutes.")


@router.get("", summary="Your stock and price alerts")
def mine(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    return ok(service.mine(db, customer))


@router.get("/products/{product_id}", summary="Your alerts on one product")
def for_product(product_id: str, db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    return ok(service.for_product(db, customer, product_id[:160]))


@router.post("/stock", status_code=201, summary="Tell me when it's back in stock")
def subscribe_stock(payload: StockAlertRequest, db: Session = Depends(get_db),
                    customer: Customer = Depends(get_current_customer)):
    _limit(customer)
    alert, created = service.subscribe_stock(db, customer, payload.product_id, size=payload.size, color=payload.color)
    message = ("We'll email you when it's back in stock." if created
               else "You're already on the list — we'll email you when it's back.")
    return ok({**service.stock_view(alert), "alreadySubscribed": not created}, message=message)


@router.post("/price", status_code=201, summary="Tell me when it's cheaper")
def subscribe_price(payload: PriceAlertRequest, db: Session = Depends(get_db),
                    customer: Customer = Depends(get_current_customer)):
    _limit(customer)
    alert, created = service.subscribe_price(db, customer, payload.product_id, mode=payload.mode,
                                             target_price=payload.target_price)
    message = "We'll email you when the price drops." if created else "Your price alert is updated."
    return ok({**service.price_view(alert), "alreadySubscribed": not created}, message=message)


@router.delete("/{kind}/{alert_id}", summary="Stop an alert")
def unsubscribe(alert_id: int, kind: str = KIND, db: Session = Depends(get_db),
                customer: Customer = Depends(get_current_customer)):
    alert = service.unsubscribe(db, customer, kind, alert_id)
    view = service.stock_view(alert) if kind == "stock" else service.price_view(alert)
    return ok(view, message="Alert removed.")


# ------------------------------------------------------------------ admin


@admin_router.get("/{kind}", summary="Stock or price alerts")
def list_alerts(
    kind: str = KIND,
    status: str = Query("", max_length=20),
    q: str = Query("", max_length=80),
    product_id: str = Query("", max_length=20, alias="productId"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_access("alerts")),
):
    items, total, counts = service.admin_search(db, kind, status=status, q=q, product_id=product_id, page=page,
                                                page_size=page_size)
    return ok({"items": items, "pagination": Pagination.build(page, page_size, total).model_dump(), "counts": counts})


@admin_router.post("/{kind}/{alert_id}/resend", summary="Send an alert again")
def resend(alert_id: int, kind: str = KIND, db: Session = Depends(get_db),
           admin: AdminUser = Depends(require_access("alerts"))):
    rate_limit.check(f"alert-resend:{admin.id}", limit=60, window_seconds=600)
    outcome = service.admin_resend(db, kind, alert_id)
    messages = {"sent": "Sent.", "waiting": "Tried recently; it will go on the next check.",
                "not-sent": "Couldn't send — see the reason on the alert."}
    return ok({"outcome": outcome}, message=messages.get(outcome, "Done."))
