"""
Payment monitoring for the portal: Razorpay webhook events and reconciliation.

Reading needs `payments`; anything that acts — replaying an event, running a
reconciliation, resolving a finding — needs `payments-manage`. Neither ever
changes a payment directly: a replay goes through the same idempotent
settlement as a delivery, and reconciliation only records what it found.

    GET  /api/admin/payments/webhooks                 list, filter
    GET  /api/admin/payments/webhooks/metrics         totals, failures, duplicates
    GET  /api/admin/payments/webhooks/{event_id}      one event, its attempts
    POST /api/admin/payments/webhooks/{event_id}/replay   run a failed event again

    GET  /api/admin/payments/reconciliation           findings, filter
    POST /api/admin/payments/reconciliation/run       reconcile a date range
    GET  /api/admin/payments/reconciliation/{id}      one finding, its history
    POST /api/admin/payments/reconciliation/{id}/recheck
    POST /api/admin/payments/reconciliation/{id}/resolve   with a note
    POST /api/admin/payments/reconciliation/{id}/reopen    with a note
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import Field
from sqlalchemy.orm import Session

from app.core import rate_limit
from app.core.database import get_db
from app.core.errors import ValidationError
from app.dependencies.auth import require_access
from app.models import AdminUser
from app.schemas.base import CamelModel
from app.services import reconciliation, webhooks
from app.utils.response import Pagination, ok

admin_router = APIRouter(prefix="/admin/payments", tags=["Admin · Payments"])


def _day_range(start: Optional[date], end: Optional[date]) -> tuple:
    """Whole days, the end inclusive: 1–3 June is 1 June 00:00 to 4 June 00:00 (UTC)."""
    begin = datetime.combine(start, time.min) if start else None
    finish = datetime.combine(end, time.min) + timedelta(days=1) if end else None
    if begin and finish and finish <= begin:
        raise ValidationError("The end date must be on or after the start date.", error_code="INVALID_RANGE")
    return begin, finish


# ------------------------------------------------------------------ webhooks


@admin_router.get("/webhooks", summary="Razorpay webhook events")
def list_webhooks(
    status: str = Query("", max_length=20),
    event: str = Query("", max_length=60),
    q: str = Query("", max_length=80),
    days: Optional[int] = Query(None, ge=1, le=365),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_access("payments")),
):
    since = datetime.utcnow() - timedelta(days=days) if days else None
    items, total, events = webhooks.search(db, status=status, event=event, q=q, since=since, page=page,
                                           page_size=page_size)
    return ok({"items": items, "pagination": Pagination.build(page, page_size, total).model_dump(),
               "events": events})


@admin_router.get("/webhooks/metrics", summary="Webhook health")
def webhook_metrics(days: int = Query(7, ge=1, le=365), db: Session = Depends(get_db),
                    admin: AdminUser = Depends(require_access("payments"))):
    return ok(webhooks.metrics(db, since=datetime.utcnow() - timedelta(days=days)))


@admin_router.get("/webhooks/{event_id}", summary="One webhook event")
def webhook_detail(event_id: str, db: Session = Depends(get_db),
                   admin: AdminUser = Depends(require_access("payments"))):
    return ok(webhooks.view(webhooks.get(db, event_id[:64]), detail=True))


@admin_router.post("/webhooks/{event_id}/replay", summary="Process a failed event again")
def replay_webhook(event_id: str, db: Session = Depends(get_db),
                   admin: AdminUser = Depends(require_access("payments-manage"))):
    rate_limit.check(f"webhook-replay:{admin.id}", limit=20, window_seconds=300)
    outcome = webhooks.replay(db, event_id[:64], admin.id)
    row = webhooks.get(db, event_id[:64])
    message = "Replayed — processing failed again." if outcome.get("failed") else "Replayed and processed."
    return ok({"outcome": outcome, "event": webhooks.view(row, detail=True)}, message=message)


# ----------------------------------------------------------- reconciliation


@admin_router.get("/reconciliation", summary="Reconciliation findings")
def list_reconciliation(
    status: str = Query("", max_length=20),
    resolution: str = Query("", max_length=10),
    q: str = Query("", max_length=80),
    start: Optional[date] = Query(None, alias="from"),
    end: Optional[date] = Query(None, alias="to"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_access("payments")),
):
    begin, finish = _day_range(start, end)
    items, total, summary = reconciliation.search(db, status=status, resolution=resolution, q=q, start=begin,
                                                  end=finish, page=page, page_size=page_size)
    return ok({"items": items, "pagination": Pagination.build(page, page_size, total).model_dump(), **summary})


class RunRequest(CamelModel):
    start: date = Field(alias="from")
    end: date = Field(alias="to")


@admin_router.post("/reconciliation/run", summary="Reconcile payments in a date range")
def run_reconciliation(payload: RunRequest, db: Session = Depends(get_db),
                       admin: AdminUser = Depends(require_access("payments-manage"))):
    # Each run pages through the gateway's API; a few a minute is plenty.
    rate_limit.check(f"reconcile-run:{admin.id}", limit=5, window_seconds=60,
                     message="A reconciliation has just run. Please wait a minute.")
    begin, finish = _day_range(payload.start, payload.end)
    result = reconciliation.run(db, begin, finish)
    issues = result["checked"] - result["counts"].get("matched", 0)
    message = (f"Checked {result['checked']} payments: all match." if not issues
               else f"Checked {result['checked']} payments: {issues} need a look.")
    return ok(result, message=message)


@admin_router.get("/reconciliation/{row_id}", summary="One reconciliation finding")
def reconciliation_detail(row_id: int, db: Session = Depends(get_db),
                          admin: AdminUser = Depends(require_access("payments"))):
    return ok(reconciliation.view(reconciliation.get(db, row_id), detail=True))


@admin_router.post("/reconciliation/{row_id}/recheck", summary="Check one payment again")
def recheck(row_id: int, db: Session = Depends(get_db),
            admin: AdminUser = Depends(require_access("payments-manage"))):
    rate_limit.check(f"reconcile-recheck:{admin.id}", limit=30, window_seconds=60)
    row = reconciliation.recheck(db, row_id)
    return ok(reconciliation.view(row, detail=True), message="Checked again.")


class NoteRequest(CamelModel):
    note: str = Field(default="", max_length=1000)


@admin_router.post("/reconciliation/{row_id}/resolve", summary="Mark a finding reviewed")
def resolve(row_id: int, payload: NoteRequest, db: Session = Depends(get_db),
            admin: AdminUser = Depends(require_access("payments-manage"))):
    row = reconciliation.resolve(db, row_id, admin, payload.note)
    return ok(reconciliation.view(row, detail=True), message="Marked resolved.")


@admin_router.post("/reconciliation/{row_id}/reopen", summary="Reopen a finding")
def reopen(row_id: int, payload: NoteRequest, db: Session = Depends(get_db),
           admin: AdminUser = Depends(require_access("payments-manage"))):
    row = reconciliation.reopen(db, row_id, admin, payload.note)
    return ok(reconciliation.view(row, detail=True), message="Reopened.")
