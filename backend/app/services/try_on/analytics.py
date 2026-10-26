"""
The try-on dashboard's numbers — every one aggregated in the database from
recorded requests, attempts and credentials. Nothing is estimated except the
cost, and only from a per-call cost an administrator entered on a model.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Optional

from sqlalchemy import and_, case, func, select
from sqlalchemy.orm import Session

from app.models import (
    Category,
    Customer,
    VtoAttempt,
    VtoCapability,
    VtoCleanupTask,
    VtoCredential,
    VtoModel,
    VtoProvider,
    VtoRequest,
)
from app.services.try_on import credentials as credential_service
from app.services.try_on import storage
from app.services.try_on.errors import describe

ACTIVE = ("queued", "processing", "retrying")


def filters(*, date_from: Optional[date] = None, date_to: Optional[date] = None, provider_id: str = "",
            model_id: str = "", credential_id: str = "", customer_id: str = "", plan_id: str = "",
            capability: str = "", category_id: str = "", status: str = "", error_code: str = "",
            query: str = "") -> list:
    conditions = []
    if date_from:
        conditions.append(VtoRequest.created_at >= datetime.combine(date_from, datetime.min.time()))
    if date_to:
        conditions.append(VtoRequest.created_at < datetime.combine(date_to + timedelta(days=1), datetime.min.time()))
    for value, column in ((provider_id, VtoRequest.provider_id), (model_id, VtoRequest.model_id),
                          (credential_id, VtoRequest.credential_id), (customer_id, VtoRequest.customer_id),
                          (category_id, VtoRequest.category_id), (capability, VtoRequest.capability_key),
                          (error_code, VtoRequest.error_code)):
        if value:
            conditions.append(column == value[:60])
    if plan_id == "trial":
        conditions.append(VtoRequest.source == "trial")
    elif plan_id == "allocation":
        conditions.append(VtoRequest.source == "allocation")
    elif plan_id:
        conditions.append(VtoRequest.plan_id == plan_id[:20])
    if status == "active":
        conditions.append(VtoRequest.status.in_(ACTIVE))
    elif status:
        conditions.append(VtoRequest.status == status[:12])
    if query:
        q = query.strip()[:20].upper()
        conditions.append((VtoRequest.id == q) | (VtoRequest.customer_id == q) | (VtoRequest.product_id == q))
    return conditions


def _rate(part: int, whole: int) -> float:
    return round(100.0 * part / whole, 1) if whole else 0.0


def _breakdown(db: Session, column, conditions: list, limit: int = 12) -> list:
    rows = db.execute(
        select(column, func.count(), func.sum(case((VtoRequest.status.in_(("succeeded", "expired")), 1), else_=0)),
               func.sum(case((VtoRequest.status == "failed", 1), else_=0)))
        .where(*conditions).group_by(column).order_by(func.count().desc()).limit(limit)
    ).all()
    return [{"key": key or "", "requests": int(n), "succeeded": int(s or 0), "failed": int(f or 0),
             "successRate": _rate(int(s or 0), int(s or 0) + int(f or 0))} for key, n, s, f in rows]


def _trend(db: Session, conditions: list, granularity: str, start: datetime, end: datetime) -> list:
    if granularity == "month":
        bucket = func.date_format(VtoRequest.created_at, "%Y-%m")
    elif granularity == "week":
        bucket = func.date_format(VtoRequest.created_at, "%x-W%v")
    else:
        bucket = func.date(VtoRequest.created_at)
    rows = db.execute(
        select(bucket, func.count(), func.sum(case((VtoRequest.status.in_(("succeeded", "expired")), 1), else_=0)),
               func.sum(case((VtoRequest.status == "failed", 1), else_=0)))
        .where(*conditions, VtoRequest.created_at >= start, VtoRequest.created_at < end)
        .group_by(bucket).order_by(bucket)
    ).all()
    return [{"period": str(p), "requests": int(n), "succeeded": int(s or 0), "failed": int(f or 0)}
            for p, n, s, f in rows]


def overview(db: Session, conditions: list, *, granularity: str = "day") -> dict:
    now = datetime.utcnow()
    base = select(func.count()).select_from(VtoRequest)
    by_status = dict(db.execute(select(VtoRequest.status, func.count()).where(*conditions)
                                .group_by(VtoRequest.status)).all())
    total = sum(by_status.values())
    succeeded = int(by_status.get("succeeded", 0)) + int(by_status.get("expired", 0))
    failed = int(by_status.get("failed", 0))
    finished = succeeded + failed

    # Labels for the breakdowns.
    providers = {p.id: p for p in db.execute(select(VtoProvider)).scalars()}
    models = {m.id: m for m in db.execute(select(VtoModel)).scalars()}
    capability_names = dict(db.execute(select(VtoCapability.key, VtoCapability.name)).all())
    category_names = dict(db.execute(select(Category.id, Category.name)).all())

    by_provider = _breakdown(db, VtoRequest.provider_id, conditions)
    for row in by_provider:
        row["label"] = providers[row["key"]].name if row["key"] in providers else (row["key"] or "Not started")
    by_model = _breakdown(db, VtoRequest.model_id, conditions)
    cost_total, cost_currency = 0.0, ""
    for row in by_model:
        model = models.get(row["key"])
        row["label"] = model.name if model else (row["key"] or "Not started")
        if model is not None and model.cost_per_call is not None:
            calls = db.execute(select(func.count()).select_from(VtoAttempt).join(
                VtoRequest, VtoRequest.id == VtoAttempt.request_id).where(
                VtoAttempt.model_id == model.id, *conditions)).scalar_one()
            row["cost"] = round(float(model.cost_per_call) * calls, 4)
            cost_total += row["cost"]
            cost_currency = model.cost_currency
    by_capability = _breakdown(db, VtoRequest.capability_key, conditions)
    for row in by_capability:
        row["label"] = capability_names.get(row["key"], row["key"])
    by_category = _breakdown(db, VtoRequest.category_id, conditions)
    for row in by_category:
        row["label"] = category_names.get(row["key"], row["key"] or "—")
    by_plan = _breakdown(db, VtoRequest.plan_name, conditions)
    for row in by_plan:
        row["label"] = row["key"] or "—"
    by_customer = _breakdown(db, VtoRequest.customer_id, conditions, limit=10)
    names = {c.id: c.full_name for c in db.execute(select(Customer).where(
        Customer.id.in_([r["key"] for r in by_customer]))).scalars()} if by_customer else {}
    for row in by_customer:
        row["label"] = names.get(row["key"], row["key"])
    by_error = _breakdown(db, VtoRequest.error_code, conditions + [VtoRequest.status == "failed"])
    for row in by_error:
        failure = describe(row["key"])
        row["label"], row["badge"] = failure.admin, failure.badge

    # Credential usage, from attempts (a request that fell back used several).
    attempt_conditions = [VtoRequest.id == VtoAttempt.request_id, *conditions]
    usage_rows = db.execute(
        select(VtoAttempt.credential_id, VtoAttempt.provider_id, func.count(),
               func.sum(case((VtoAttempt.outcome == "succeeded", 1), else_=0)), func.max(VtoAttempt.started_at))
        .select_from(VtoAttempt).join(VtoRequest, and_(*attempt_conditions))
        .group_by(VtoAttempt.credential_id, VtoAttempt.provider_id).order_by(func.count().desc()).limit(50)
    ).all()
    labels = {c.id: c.label for c in db.execute(select(VtoCredential)).scalars()}
    by_credential = [{"key": cid or "", "label": labels.get(cid, cid or "No credential"),
                      "provider": providers[pid].name if pid in providers else pid, "attempts": int(n),
                      "succeeded": int(s or 0), "failed": int(n) - int(s or 0), "lastUsedAt": last}
                     for cid, pid, n, s, last in usage_rows]

    starts = {"day": now - timedelta(days=30), "week": now - timedelta(weeks=12), "month": now - timedelta(days=365)}
    granularity = granularity if granularity in starts else "day"

    recent = lambda status: [_brief(r, models, capability_names) for r in db.execute(  # noqa: E731
        select(VtoRequest).where(*conditions, VtoRequest.status == status)
        .order_by(VtoRequest.created_at.desc()).limit(8)).scalars()]

    provider_rows = []
    for provider in providers.values():
        provider_models = [m for m in models.values() if m.provider_id == provider.id]
        provider_rows.append({
            "id": provider.id, "name": provider.name, "kind": provider.kind, "enabled": provider.enabled,
            "health": provider.health, "healthDetail": provider.health_detail, "lastCheckedAt": provider.last_checked_at,
            "models": len(provider_models), "enabledModels": sum(1 for m in provider_models if m.enabled and m.verified),
        })
    tally = credential_service.counts(db)
    pending_cleanup = db.execute(select(func.count()).select_from(VtoCleanupTask).where(
        VtoCleanupTask.done_at.is_(None))).scalar_one()
    durations = db.execute(select(func.avg(VtoRequest.duration_ms)).where(
        *conditions, VtoRequest.status.in_(("succeeded", "expired")))).scalar()

    return {
        "totals": {
            "requests": total, "succeeded": succeeded, "failed": failed,
            "cancelled": int(by_status.get("cancelled", 0)),
            "successRate": _rate(succeeded, finished), "failureRate": _rate(failed, finished),
            "inProgress": int(by_status.get("processing", 0)) + int(by_status.get("retrying", 0)),
            "queued": db.execute(base.where(VtoRequest.status == "queued")).scalar_one(),
            "averageSeconds": round(float(durations) / 1000, 1) if durations else None,
            "estimatedCost": round(cost_total, 2) if cost_currency else None,
            "costCurrency": cost_currency or None,
        },
        "providers": {
            "active": sum(1 for p in providers.values() if p.enabled),
            "inactive": sum(1 for p in providers.values() if not p.enabled),
            "items": provider_rows,
        },
        "credentials": tally,
        "storage": storage.status(),
        "pendingCleanup": pending_cleanup,
        "byProvider": by_provider,
        "byModel": by_model,
        "byCapability": by_capability,
        "byCategory": by_category,
        "byPlan": by_plan,
        "byCustomer": by_customer,
        "byCredential": by_credential,
        "byError": by_error,
        "trend": {"granularity": granularity, "points": _trend(db, conditions, granularity, starts[granularity],
                                                                 now + timedelta(days=1))},
        "recentSucceeded": recent("succeeded"),
        "recentFailed": recent("failed"),
    }


def _brief(request: VtoRequest, models: dict, capability_names: dict) -> dict:
    model = models.get(request.model_id or "")
    failure = describe(request.error_code) if request.error_code else None
    return {
        "id": request.id, "customerId": request.customer_id, "productId": request.product_id,
        "productName": request.product_name, "capability": capability_names.get(request.capability_key,
                                                                                 request.capability_key),
        "model": model.name if model else "", "credentialLabel": request.credential_label,
        "status": request.status, "badge": request.error_badge or (failure.badge if failure else ""),
        "error": failure.admin if failure else "", "createdAt": request.created_at, "durationMs": request.duration_ms,
    }


def badge_for(request: VtoRequest) -> str:
    if request.status == "failed":
        return request.error_badge or "Failed"
    return {"succeeded": "Success", "processing": "Processing", "queued": "Queued", "retrying": "Retrying",
            "cancelled": "Cancelled", "expired": "Expired"}.get(request.status, request.status.title())


def admin_request_out(db: Session, request: VtoRequest, *, detail: bool = False) -> dict:
    failure = describe(request.error_code) if request.error_code else None
    model = db.get(VtoModel, request.model_id) if request.model_id else None
    provider = db.get(VtoProvider, request.provider_id) if request.provider_id else None
    capability = db.get(VtoCapability, request.capability_key)
    out = {
        "id": request.id, "customerId": request.customer_id, "productId": request.product_id,
        "productName": request.product_name, "color": request.color, "size": request.size,
        "capability": request.capability_key, "capabilityName": capability.name if capability else request.capability_key,
        "categoryId": request.category_id, "providerId": request.provider_id,
        "providerName": provider.name if provider else "", "modelId": request.model_id,
        "modelName": model.name if model else "", "credentialId": request.credential_id,
        "credentialLabel": request.credential_label, "allocationId": request.allocation_id,
        "source": request.source, "planId": request.plan_id, "planName": request.plan_name,
        "status": request.status, "badge": badge_for(request),
        "error": {"code": request.error_code, "badge": request.error_badge, "explanation": failure.admin,
                  "customerMessage": failure.customer, "retryable": request.retryable}
        if failure else None,
        "attempts": request.attempts, "retriesUsed": request.retries_used,
        "storageMode": request.storage_mode, "resultStorage": request.result_storage,
        "resultExpiresAt": request.result_expires_at, "resultDeletedAt": request.result_deleted_at,
        "deletedByCustomer": request.deleted_at is not None, "feedbackRating": request.feedback_rating,
        "createdAt": request.created_at, "startedAt": request.started_at, "finishedAt": request.finished_at,
        "durationMs": request.duration_ms,
    }
    if detail:
        out["technicalDetail"] = request.technical_detail
        out["feedbackComment"] = request.feedback_comment
        out["attemptLog"] = [
            {"number": a.number, "providerId": a.provider_id, "modelId": a.model_id, "credentialId": a.credential_id,
             "credentialLabel": a.credential_label, "outcome": a.outcome, "errorCode": a.error_code,
             "badge": describe(a.error_code).badge if a.error_code else "Success",
             "explanation": describe(a.error_code).admin if a.error_code else "",
             "technicalDetail": a.technical_detail, "latencyMs": a.latency_ms, "startedAt": a.started_at}
            for a in db.execute(select(VtoAttempt).where(VtoAttempt.request_id == request.id)
                                .order_by(VtoAttempt.number)).scalars()
        ]
    return out


def list_requests(db: Session, conditions: list, *, page: int = 1, page_size: int = 25) -> tuple:
    total = db.execute(select(func.count()).select_from(VtoRequest).where(*conditions)).scalar_one()
    counts = dict(db.execute(select(VtoRequest.status, func.count()).where(*conditions)
                             .group_by(VtoRequest.status)).all())
    rows = db.execute(select(VtoRequest).where(*conditions).order_by(VtoRequest.created_at.desc(),
                                                                     VtoRequest.id.desc())
                      .offset((max(page, 1) - 1) * page_size).limit(page_size)).scalars().all()
    return list(rows), total, counts
