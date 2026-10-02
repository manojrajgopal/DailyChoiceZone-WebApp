"""
Analytics, the audit trail and system health.

The storefront may post a few events (a visit, a product viewed, checkout
opened) — checked and bounded in `services.analytics_events`. Everything else
here is for administrators, each area behind its own permission:
`analytics`, `audit-logs`, `health`. The audit trail is read-only: there is no
endpoint that changes or removes an entry.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response
from pydantic import Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core import rate_limit
from app.core.database import get_db
from app.core.errors import NotFoundError
from app.dependencies.auth import client_ip, get_optional_customer, require_access
from app.models import AdminUser, AuditLog, Customer
from app.schemas.base import CamelModel
from app.services import analytics_events, health, insights
from app.utils.dates import parse_dt
from app.utils.response import Pagination, ok

events_router = APIRouter(prefix="/analytics", tags=["Analytics"])
admin_analytics_router = APIRouter(prefix="/admin/analytics", tags=["Admin · Analytics"])
admin_audit_router = APIRouter(prefix="/admin/audit-logs", tags=["Admin · Audit logs"])
admin_health_router = APIRouter(prefix="/admin/health", tags=["Admin · Health"])


# -------------------------------------------------------------- analytics


class EventIn(CamelModel):
    event: str = Field(max_length=30)
    visitor_id: str = Field(max_length=64)
    product_id: Optional[str] = Field(default=None, max_length=40)
    referrer: str = Field(default="", max_length=500)
    utm_source: str = Field(default="", max_length=60)


@events_router.post("/events", status_code=202, summary="Record a storefront event")
def record_event(payload: EventIn, request: Request, db: Session = Depends(get_db),
                 customer: Optional[Customer] = Depends(get_optional_customer)):
    rate_limit.check(f"analytics:{client_ip(request)}", limit=120, window_seconds=60)
    kept = analytics_events.client_event(
        db, event=payload.event, visitor_id=payload.visitor_id, customer_id=customer.id if customer else None,
        product_id=payload.product_id, user_agent=request.headers.get("user-agent", ""),
        referrer=payload.referrer, utm_source=payload.utm_source,
    )
    return ok({"recorded": kept})


def _report_params(range_key: str, start: Optional[str], end: Optional[str], compare: str, unit: str) -> dict:
    return {"range_key": range_key, "start": start, "end": end, "compare": compare, "unit": unit}


@admin_analytics_router.get("/export/{kind}", summary="Download one analytics table as CSV")
def export_analytics(kind: str, range_key: str = Query("30d", alias="range", max_length=10),
                     start: Optional[str] = Query(None, max_length=10), end: Optional[str] = Query(None, max_length=10),
                     compare: str = Query("previous", max_length=10), unit: str = Query("auto", max_length=10),
                     db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("analytics"))):
    filename, body = insights.export(db, kind, **_report_params(range_key, start, end, compare, unit))
    return Response(body, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@admin_analytics_router.get("/{section}", summary="Sales, customers, products, marketing or the funnel")
def analytics_report(section: str, range_key: str = Query("30d", alias="range", max_length=10),
                     start: Optional[str] = Query(None, max_length=10), end: Optional[str] = Query(None, max_length=10),
                     compare: str = Query("previous", max_length=10), unit: str = Query("auto", max_length=10),
                     db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("analytics"))):
    return ok(insights.report(db, section, **_report_params(range_key, start, end, compare, unit)))


# ------------------------------------------------------------------- audit


def _audit_view(row: AuditLog, *, full: bool = False) -> dict:
    out = {
        "id": row.id, "occurredAt": row.occurred_at, "action": row.action, "resourceType": row.resource_type,
        "resourceId": row.resource_id, "summary": row.summary, "outcome": row.outcome,
        "statusCode": row.status_code, "errorCode": row.error_code,
        "actor": {"type": row.actor_type, "id": row.actor_id, "name": row.actor_name, "email": row.actor_email,
                  "role": row.actor_role},
        "ipAddress": row.ip_address, "hasChanges": bool(row.changes),
    }
    if full:
        out.update({"changes": row.changes, "details": row.details, "userAgent": row.user_agent,
                    "requestId": row.request_id})
    return out


def _audit_filters(q: str, action: str, resource_type: str, resource_id: str, actor: str, outcome: str,
                   date_from: Optional[str], date_to: Optional[str]) -> list:
    conditions = []
    if q:
        like = f"%{q.strip()}%"
        conditions.append(or_(AuditLog.summary.ilike(like), AuditLog.actor_name.ilike(like),
                              AuditLog.actor_email.ilike(like), AuditLog.resource_id == q.strip(),
                              AuditLog.action.ilike(like)))
    if action:
        conditions.append(AuditLog.action.like(f"{action}%"))
    if resource_type:
        conditions.append(AuditLog.resource_type == resource_type)
    if resource_id:
        conditions.append(AuditLog.resource_id == resource_id)
    if actor:
        conditions.append(AuditLog.actor_id == actor)
    if outcome in ("success", "failure", "denied"):
        conditions.append(AuditLog.outcome == outcome)
    start, end = parse_dt(date_from), parse_dt(date_to)
    if start:
        conditions.append(AuditLog.occurred_at >= start)
    if end:
        # A bare date means "through the end of that day"; a timestamp is exact.
        conditions.append(AuditLog.occurred_at < (end + timedelta(days=1) if len(date_to or "") == 10 else end))
    return conditions


@admin_audit_router.get("", summary="The audit trail")
def audit_logs(q: str = Query("", max_length=100), action: str = Query("", max_length=80),
               resource_type: str = Query("", alias="resourceType", max_length=40),
               resource_id: str = Query("", alias="resourceId", max_length=80),
               actor: str = Query("", max_length=40), outcome: str = Query("", max_length=10),
               date_from: Optional[str] = Query(None, alias="from", max_length=30),
               date_to: Optional[str] = Query(None, alias="to", max_length=30),
               page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200, alias="pageSize"),
               db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("audit-logs"))):
    conditions = _audit_filters(q, action, resource_type, resource_id, actor, outcome, date_from, date_to)
    total = db.execute(select(func.count(AuditLog.id)).where(*conditions)).scalar_one()
    rows = db.execute(select(AuditLog).where(*conditions).order_by(AuditLog.occurred_at.desc(), AuditLog.id.desc())
                      .offset((page - 1) * page_size).limit(page_size)).scalars().all()
    counts = dict(db.execute(select(AuditLog.outcome, func.count(AuditLog.id)).where(*conditions)
                             .group_by(AuditLog.outcome)).all())
    return ok({"items": [_audit_view(r) for r in rows],
               "pagination": Pagination.build(page, page_size, int(total)).model_dump(),
               "counts": {k: int(counts.get(k, 0)) for k in ("success", "failure", "denied")}})


@admin_audit_router.get("/facets", summary="The actions, record types and people in the trail, for filters")
def audit_facets(db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("audit-logs"))):
    since = datetime.utcnow() - timedelta(days=365)
    resources = db.execute(select(AuditLog.resource_type).where(AuditLog.occurred_at >= since)
                           .group_by(AuditLog.resource_type).order_by(AuditLog.resource_type)).scalars().all()
    actors = db.execute(select(AuditLog.actor_id, func.max(AuditLog.actor_name)).where(
        AuditLog.occurred_at >= since, AuditLog.actor_id.is_not(None)).group_by(AuditLog.actor_id)).all()
    return ok({"resourceTypes": [r for r in resources if r],
               "actors": [{"id": a, "name": n or a} for a, n in actors]})


@admin_audit_router.get("/export", summary="Download the filtered audit trail as CSV")
def audit_export(q: str = Query("", max_length=100), action: str = Query("", max_length=80),
                 resource_type: str = Query("", alias="resourceType", max_length=40),
                 resource_id: str = Query("", alias="resourceId", max_length=80),
                 actor: str = Query("", max_length=40), outcome: str = Query("", max_length=10),
                 date_from: Optional[str] = Query(None, alias="from", max_length=30),
                 date_to: Optional[str] = Query(None, alias="to", max_length=30),
                 db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("audit-logs"))):
    import json

    conditions = _audit_filters(q, action, resource_type, resource_id, actor, outcome, date_from, date_to)
    rows = db.execute(select(AuditLog).where(*conditions).order_by(AuditLog.occurred_at.desc()).limit(20000)).scalars().all()
    body = insights._csv(
        ["id", "occurred_at_utc", "actor_type", "actor_id", "actor_name", "actor_email", "actor_role", "action",
         "resource_type", "resource_id", "summary", "outcome", "status_code", "error_code", "changes", "ip_address"],
        [[r.id, r.occurred_at.isoformat(), r.actor_type, r.actor_id or "", r.actor_name, r.actor_email, r.actor_role,
          r.action, r.resource_type, r.resource_id, r.summary, r.outcome, r.status_code or "", r.error_code,
          json.dumps(r.changes, default=str) if r.changes else "", r.ip_address] for r in rows],
    )
    stamp = datetime.utcnow().strftime("%Y%m%d-%H%M")
    return Response(body, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="audit-log-{stamp}.csv"'})


@admin_audit_router.get("/{entry_id}", summary="One audit entry, with what changed")
def audit_entry(entry_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("audit-logs"))):
    row = db.get(AuditLog, entry_id)
    if row is None:
        raise NotFoundError("No such audit entry.", error_code="AUDIT_ENTRY_NOT_FOUND")
    return ok(_audit_view(row, full=True))


# ------------------------------------------------------------------ health


@admin_health_router.get("", summary="Every health check, with recent history")
def admin_health(hours: int = Query(24, ge=1, le=336), db: Session = Depends(get_db),
                 admin: AdminUser = Depends(require_access("health"))):
    result = health.run(db)
    return ok({**result, "history": health.history(db, hours=hours), "uptime7d": health.uptime(db, days=7)})


@admin_health_router.post("/run", summary="Run every check now, including Razorpay and storage, and keep it")
def admin_run_health(request: Request, db: Session = Depends(get_db),
                     admin: AdminUser = Depends(require_access("health"))):
    rate_limit.check(f"health-run:{admin.id}", limit=6, window_seconds=60)
    result = health.run(db, deep=True)
    health.record_and_alert(db, result)
    return ok({**result, "history": health.history(db), "uptime7d": health.uptime(db, days=7)},
              message="Health checked.")
