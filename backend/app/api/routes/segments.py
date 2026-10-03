"""
Customer segments (admin only). See docs/customer-segmentation.md, section 6.

    /api/admin/segments...            segments, preview, members, RFM settings (permission: segments)
    /api/admin/segments/{id}/export   CSV of the members, unmasked (permission: segments-export)

Static paths are declared before `/{segment_id}` so they are never read as an id.
"""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, Query
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.dependencies.auth import require_access
from app.models import AdminUser
from app.services.segments import metrics, rules, service
from app.utils.response import Pagination, ok

router = APIRouter(prefix="/admin/segments", tags=["Admin · Segments"])

segments_access = require_access("segments")
export_access = require_access("segments-export")


def _page(page: int, size: int, total: int) -> dict:
    return Pagination.build(page, size, total).model_dump()


@router.get("", summary="Segments")
def list_segments(
    q: str = Query("", max_length=120),
    status: str = Query("active", max_length=20),
    kind: str = Query("", max_length=20),
    page: int = Query(1, ge=1, le=100_000),
    page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(segments_access),
):
    items, total, counts = service.list_segments(db, q=q, status=status, kind=kind, page=page, page_size=page_size)
    return ok({"items": items, "pagination": _page(page, page_size, total), "counts": counts})


@router.get("/fields", summary="What a segment rule can filter on")
def fields(db: Session = Depends(get_db), admin: AdminUser = Depends(segments_access)):
    return ok(rules.registry(db))


@router.post("/preview", summary="Count and sample the customers some rules describe (nothing is saved)")
def preview(payload: dict = Body(...), db: Session = Depends(get_db), admin: AdminUser = Depends(segments_access)):
    return ok(service.preview(db, admin, payload))


@router.get("/summary", summary="Headline numbers for the dashboard")
def summary(db: Session = Depends(get_db), admin: AdminUser = Depends(segments_access)):
    return ok(service.summary(db))


@router.get("/settings", summary="RFM settings and the metrics' freshness")
def get_settings(db: Session = Depends(get_db), admin: AdminUser = Depends(segments_access)):
    return ok({"settings": metrics.settings(db), "status": metrics.status(db)})


@router.put("/settings", summary="Change the RFM settings (re-scores every customer)")
def put_settings(payload: dict = Body(...), db: Session = Depends(get_db),
                 admin: AdminUser = Depends(segments_access)):
    saved = metrics.save_settings(db, admin, payload)
    service.recalculate_active(db)
    return ok({"settings": saved, "status": metrics.status(db)}, message="RFM settings saved.")


@router.post("/metrics/refresh", summary="Refresh every customer's metrics and recalculate every segment now")
def refresh_metrics(db: Session = Depends(get_db), admin: AdminUser = Depends(segments_access)):
    result = service.refresh_everything(db, admin)
    return ok(result, message=f"Refreshed {result['refreshed']} customers and {result['segments']} segments.")


@router.post("", status_code=201, summary="Create a segment")
def create_segment(payload: dict = Body(...), db: Session = Depends(get_db),
                   admin: AdminUser = Depends(segments_access)):
    row = service.create(db, admin, payload)
    return ok(service.detail(db, admin, row), message="Segment saved.")


@router.get("/{segment_id}", summary="A segment, with its RFM spread and history")
def get_segment(segment_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(segments_access)):
    return ok(service.detail(db, admin, service.load(db, segment_id)))


@router.put("/{segment_id}", summary="Change a segment")
def update_segment(segment_id: int, payload: dict = Body(...), db: Session = Depends(get_db),
                   admin: AdminUser = Depends(segments_access)):
    row = service.update(db, admin, segment_id, payload)
    return ok(service.detail(db, admin, row), message="Segment saved.")


@router.post("/{segment_id}/recalculate", summary="Recalculate a segment's members now")
def recalculate(segment_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(segments_access)):
    result = service.recalculate_now(db, admin, segment_id)
    row = service.load(db, segment_id)
    return ok(service.detail(db, admin, row),
              message=f"Recalculated: {result['before']:,} → {result['after']:,} customers.")


@router.post("/{segment_id}/archive", summary="Archive a segment")
def archive(segment_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(segments_access)):
    row = service.set_archived(db, admin, segment_id, True)
    return ok(service.detail(db, admin, row), message="Segment archived.")


@router.post("/{segment_id}/restore", summary="Restore an archived segment")
def restore(segment_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(segments_access)):
    row = service.set_archived(db, admin, segment_id, False)
    return ok(service.detail(db, admin, row), message="Segment restored.")


@router.get("/{segment_id}/members", summary="A segment's members")
def members(
    segment_id: int,
    q: str = Query("", max_length=120),
    page: int = Query(1, ge=1, le=100_000),
    page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(segments_access),
):
    items, total, masked = service.members(db, admin, segment_id, q=q, page=page, page_size=page_size)
    return ok({"items": items, "pagination": _page(page, page_size, total), "masked": masked})


@router.get("/{segment_id}/export", summary="Download a segment's members as CSV (audited)")
def export(segment_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(export_access)):
    filename, text = service.export_csv(db, admin, segment_id)
    return Response(content="﻿" + text, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"',
                             "Cache-Control": "no-store"})
