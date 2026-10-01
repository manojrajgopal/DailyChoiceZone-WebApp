"""
Delivery serviceability.

    GET  /api/delivery/pincodes/{pincode}            can we deliver there? (anyone)

    GET  /api/admin/delivery/pincodes                list, search, filter
    POST /api/admin/delivery/pincodes                add one
    PUT  /api/admin/delivery/pincodes/{id}           edit one
    DEL  /api/admin/delivery/pincodes/{id}           remove one
    POST /api/admin/delivery/pincodes/import         add or update from CSV
    GET  /api/admin/delivery/pincodes/export         every entry, for a CSV
    GET/PUT /api/admin/delivery/settings             unlisted pincodes: allowed or not
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from pydantic import Field
from sqlalchemy.orm import Session

from app.core import rate_limit
from app.core.database import get_db
from app.dependencies.auth import client_ip, require_access
from app.models import AdminUser
from app.schemas.base import CamelModel
from app.services import serviceability as service
from app.utils.response import Pagination, ok

router = APIRouter(prefix="/delivery", tags=["Delivery"])
admin_router = APIRouter(prefix="/admin/delivery", tags=["Admin · Delivery"])


@router.get("/pincodes/{pincode}", summary="Can we deliver to this pincode?")
def check(pincode: str, request: Request, db: Session = Depends(get_db)):
    # Generous for a person checking a few addresses, tight for a script
    # walking the whole pincode range to map the store's coverage.
    rate_limit.check(f"pincode:{client_ip(request)}", limit=60, window_seconds=300,
                     message="Too many pincode checks. Please wait a moment.")
    return ok(service.check(db, pincode[:10]).view(db))


# ------------------------------------------------------------------ admin


@admin_router.get("/pincodes", summary="Serviceable pincodes")
def list_pincodes(
    q: str = Query("", max_length=60),
    state: str = Query("", max_length=120),
    active: str = Query("", max_length=3),
    serviceable: str = Query("", max_length=3),
    cod: str = Query("", max_length=3),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_access("shipping")),
):
    rows, total, states, counts = service.search(
        db, q=q, state=state, active=active, serviceable=serviceable, cod=cod, page=page, page_size=page_size,
    )
    return ok({
        "items": [service.view(r) for r in rows],
        "pagination": Pagination.build(page, page_size, total).model_dump(),
        "states": states,
        "counts": counts,
        "settings": service.settings(db),
    })


@admin_router.post("/pincodes", status_code=201, summary="Add a pincode")
def add_pincode(payload: dict, db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("shipping"))):
    return ok(service.view(service.save(db, payload)), message="Pincode added.")


@admin_router.put("/pincodes/{row_id}", summary="Edit a pincode")
def edit_pincode(row_id: int, payload: dict, db: Session = Depends(get_db),
                 admin: AdminUser = Depends(require_access("shipping"))):
    return ok(service.view(service.save(db, payload, row_id)), message="Pincode saved.")


@admin_router.delete("/pincodes/{row_id}", summary="Remove a pincode")
def delete_pincode(row_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("shipping"))):
    service.delete(db, row_id)
    return ok(message="Pincode removed.")


class CsvImport(CamelModel):
    content: str = Field(max_length=2_000_000)


@admin_router.post("/pincodes/import", summary="Add or update pincodes from CSV")
def import_pincodes(payload: CsvImport, db: Session = Depends(get_db),
                    admin: AdminUser = Depends(require_access("shipping"))):
    result = service.import_csv(db, payload.content)
    message = (f"Imported: {result['created']} added, {result['updated']} updated."
               if not result["errorCount"] else f"Nothing was imported — {result['errorCount']} rows need fixing.")
    return ok(result, message=message)


@admin_router.get("/pincodes/export", summary="Every pincode entry")
def export_pincodes(db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("shipping"))):
    return ok({"items": service.export_rows(db), "columns": service.CSV_COLUMNS})


@admin_router.get("/settings", summary="Serviceability settings")
def get_settings(db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("shipping"))):
    return ok(service.settings(db))


@admin_router.put("/settings", summary="Save serviceability settings")
def save_settings(payload: dict, db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("shipping"))):
    return ok(service.save_settings(db, payload), message="Delivery settings saved.")
