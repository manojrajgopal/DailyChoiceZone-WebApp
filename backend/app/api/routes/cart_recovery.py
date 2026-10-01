"""
Abandoned carts.

    POST /api/cart/recover                     a reminder's link was followed (the owner only)

    GET  /api/admin/carts/abandoned            list, filter by status and date
    GET  /api/admin/carts/abandoned/metrics    abandoned, recovered, rate, revenue
    GET/PUT /api/admin/carts/settings          when a bag counts as abandoned, the reminders
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query, Request
from pydantic import Field
from sqlalchemy.orm import Session

from app.core import rate_limit
from app.core.database import get_db
from app.dependencies.auth import get_current_customer, require_access
from app.models import AdminUser, Customer
from app.schemas.base import CamelModel
from app.services import cart_recovery as service
from app.utils.response import Pagination, ok

router = APIRouter(prefix="/cart", tags=["Cart"])
admin_router = APIRouter(prefix="/admin/carts", tags=["Admin · Abandoned carts"])

STATUSES = ("active", "abandoned", "recovered", "converted", "emptied", "expired")


class RecoverRequest(CamelModel):
    token: str = Field(min_length=1, max_length=100)


@router.post("/recover", summary="Back from a bag reminder")
def recover(payload: RecoverRequest, request: Request, db: Session = Depends(get_db),
            customer: Customer = Depends(get_current_customer)):
    rate_limit.check(f"cart-recover:{customer.id}", limit=20, window_seconds=900)
    result = service.open_link(db, customer, payload.token)
    return ok(result)


def _since(days: Optional[int]) -> Optional[datetime]:
    return datetime.utcnow() - timedelta(days=days) if days else None


@admin_router.get("/abandoned", summary="Abandoned carts")
def list_abandoned(
    status: str = Query("", max_length=20),
    q: str = Query("", max_length=80),
    days: Optional[int] = Query(None, ge=1, le=365),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_access("carts")),
):
    status = status if status in STATUSES else ""
    items, total = service.search(db, status=status, q=q, since=_since(days), page=page, page_size=page_size)
    return ok({"items": items, "pagination": Pagination.build(page, page_size, total).model_dump()})


@admin_router.get("/abandoned/metrics", summary="Abandoned-cart metrics")
def abandoned_metrics(days: Optional[int] = Query(30, ge=1, le=365), db: Session = Depends(get_db),
                      admin: AdminUser = Depends(require_access("carts"))):
    return ok(service.metrics(db, since=_since(days)))


@admin_router.get("/settings", summary="Abandoned-cart settings")
def get_settings(db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("carts"))):
    return ok(service.settings(db))


@admin_router.put("/settings", summary="Save abandoned-cart settings")
def save_settings(payload: dict, db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("carts"))):
    return ok(service.save_settings(db, payload), message="Abandoned-cart settings saved.")
