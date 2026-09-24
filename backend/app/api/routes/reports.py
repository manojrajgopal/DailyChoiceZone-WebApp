"""Reports."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.dependencies.auth import get_current_admin
from app.models import AdminUser
from app.services import analytics as service
from app.utils.response import ok

router = APIRouter(prefix="/admin/reports", tags=["Reports"])


@router.get("", summary="Sales, products, categories and order status")
def reports(
    range_key: str = Query("30d", alias="range"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    """
    One endpoint, parameterised by range.

    Five endpoints that each returned one statistic would be five things to
    keep consistent and five round trips to render one page. Billing reports
    live under `/admin/billing` with the records they describe.
    """
    if range_key not in service.RANGES:
        range_key = "30d"
    return ok(service.analytics(db, range_key))
