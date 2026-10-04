"""
Packing and shipping labels. See docs/packing-and-labels.md, section 6.

    /api/admin/packing...                      the packing queue and workspace (permission: packing)
    /api/admin/orders/{order_id}/packing       the order page's packing card (packing)
    /api/admin/shipments/{id}/labels...        a shipment's labels (shipments)
    /api/admin/shipping-labels...              a label version's PDF, bulk generate and download (shipments)
    /api/admin/fulfilment/settings             packing and label settings (read: packing or shipments;
                                               write: settings)

Every permission is checked here, on the server.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Body, Depends, Query, Response
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import AuthorizationError
from app.dependencies.auth import get_current_admin, require_access
from app.models import AdminUser
from app.services.fulfilment import labels, packing, slip
from app.services.fulfilment import settings as fulfilment_settings
from app.utils.response import Pagination, ok

packing_router = APIRouter(prefix="/admin/packing", tags=["Admin · Packing"])
order_packing_router = APIRouter(prefix="/admin/orders", tags=["Admin · Packing"])
shipment_labels_router = APIRouter(prefix="/admin/shipments", tags=["Admin · Shipping labels"])
labels_router = APIRouter(prefix="/admin/shipping-labels", tags=["Admin · Shipping labels"])
settings_router = APIRouter(prefix="/admin/fulfilment", tags=["Admin · Packing"])

packing_access = require_access("packing")
shipments_access = require_access("shipments")
settings_access = require_access("settings")


def _body(payload) -> dict:
    return payload if isinstance(payload, dict) else {}


def _pdf(content: bytes, name: str, *, download: bool) -> Response:
    disposition = "attachment" if download else "inline"
    return Response(content=content, media_type="application/pdf",
                    headers={"Content-Disposition": f'{disposition}; filename="{name}"',
                             "Cache-Control": "no-store"})


def _detail(db: Session, job, message: Optional[str] = None):
    return ok(packing.detail_view(db, job), message=message)


# --------------------------------------------------------------- the queue


@packing_router.get("", summary="The packing queue")
def packing_queue(
    q: str = Query("", max_length=80, description="Order ID, exact"),
    status: str = Query("", max_length=20),
    scope: str = Query("open", max_length=10),
    date_from: str = Query("", alias="from", max_length=10),
    date_to: str = Query("", alias="to", max_length=10),
    payment_status: str = Query("", alias="paymentStatus", max_length=20),
    courier: str = Query("", max_length=60, description="Courier code, exact"),
    priority: str = Query("", max_length=10),
    assigned: str = Query("", alias="assignedTo", max_length=20),
    shipping_type: str = Query("", alias="shippingType", max_length=30),
    overdue: bool = Query(False),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(packing_access),
):
    items, total, counts = packing.search(
        db, admin=admin, q=q, status=status, scope=scope, date_from=date_from, date_to=date_to,
        payment_status=payment_status, courier=courier, priority=priority, assigned=assigned,
        shipping_type=shipping_type, overdue=overdue, page=page, page_size=page_size)
    return ok({"items": items, "pagination": Pagination.build(page, page_size, total).model_dump(),
               "counts": counts, "slaHours": fulfilment_settings.settings(db)["slaHours"]})


@packing_router.get("/summary", summary="Packing and label numbers for the dashboard")
def packing_summary(db: Session = Depends(get_db), admin: AdminUser = Depends(packing_access)):
    return ok(packing.summary(db))


@packing_router.get("/staff", summary="Who packing can be assigned to")
def packing_staff(db: Session = Depends(get_db), admin: AdminUser = Depends(packing_access)):
    return ok(packing.assignable_staff(db))


@packing_router.get("/{job_id}", summary="A packing job")
def packing_job(job_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(packing_access)):
    return _detail(db, packing.get(db, job_id))


@packing_router.post("/{job_id}/assign", summary="Assign or unassign a packing job")
def assign(job_id: int, payload: Optional[dict] = Body(None), db: Session = Depends(get_db),
           admin: AdminUser = Depends(packing_access)):
    job = packing.assign(db, job_id, _body(payload).get("adminId"), admin=admin)
    return _detail(db, job, "Assigned." if job.assigned_to else "Unassigned.")


@packing_router.post("/{job_id}/priority", summary="Set a packing job's priority")
def priority(job_id: int, payload: dict = Body(...), db: Session = Depends(get_db),
             admin: AdminUser = Depends(packing_access)):
    return _detail(db, packing.set_priority(db, job_id, _body(payload).get("priority"), admin=admin),
                   "Priority saved.")


@packing_router.post("/{job_id}/start-picking", summary="Start picking")
def start_picking(job_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(packing_access)):
    return _detail(db, packing.start_picking(db, job_id, admin=admin), "Picking started.")


@packing_router.post("/{job_id}/lines/{line_id}/pick", summary="Record how many of a line are picked")
def pick_line(job_id: int, line_id: int, payload: dict = Body(...), db: Session = Depends(get_db),
              admin: AdminUser = Depends(packing_access)):
    return _detail(db, packing.pick_line(db, job_id, line_id, _body(payload).get("quantity"), admin=admin))


@packing_router.post("/{job_id}/pick-all", summary="Mark every line fully picked")
def pick_all(job_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(packing_access)):
    return _detail(db, packing.pick_all(db, job_id, admin=admin), "Every line is picked.")


@packing_router.post("/{job_id}/lines/{line_id}/exception", summary="Record a problem with a line")
def line_exception(job_id: int, line_id: int, payload: dict = Body(...), db: Session = Depends(get_db),
                   admin: AdminUser = Depends(packing_access)):
    return _detail(db, packing.record_exception(db, job_id, line_id, _body(payload), admin=admin),
                   "Problem recorded.")


@packing_router.delete("/{job_id}/lines/{line_id}/exception", summary="Clear a line's problem")
def clear_exception(job_id: int, line_id: int, db: Session = Depends(get_db),
                    admin: AdminUser = Depends(packing_access)):
    return _detail(db, packing.clear_exception(db, job_id, line_id, admin=admin), "Problem cleared.")


@packing_router.post("/{job_id}/lines/{line_id}/damaged-stock", summary="Write damaged units off stock")
def damaged_stock(job_id: int, line_id: int, payload: dict = Body(...), db: Session = Depends(get_db),
                  admin: AdminUser = Depends(packing_access)):
    return _detail(db, packing.record_damaged(db, job_id, line_id, _body(payload), admin=admin),
                   "Damaged stock recorded.")


@packing_router.post("/{job_id}/complete-picking", summary="Mark picking complete")
def complete_picking(job_id: int, payload: Optional[dict] = Body(None), db: Session = Depends(get_db),
                     admin: AdminUser = Depends(packing_access)):
    job = packing.complete_picking(db, job_id, admin=admin, override_reason=_body(payload).get("overrideReason"))
    return _detail(db, job, "Picking complete.")


@packing_router.post("/{job_id}/start-packing", summary="Start packing")
def start_packing(job_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(packing_access)):
    return _detail(db, packing.start_packing(db, job_id, admin=admin), "Packing started.")


@packing_router.post("/{job_id}/packages", status_code=201, summary="Add a package")
def create_package(job_id: int, payload: dict = Body(...), db: Session = Depends(get_db),
                   admin: AdminUser = Depends(packing_access)):
    job, package = packing.create_package(db, job_id, _body(payload), admin=admin)
    return _detail(db, job, f"Package {package.package_number} added.")


@packing_router.put("/{job_id}/packages/{package_id}", summary="Change a package")
def update_package(job_id: int, package_id: int, payload: dict = Body(...), db: Session = Depends(get_db),
                   admin: AdminUser = Depends(packing_access)):
    return _detail(db, packing.update_package(db, job_id, package_id, _body(payload), admin=admin),
                   "Package saved.")


@packing_router.delete("/{job_id}/packages/{package_id}", summary="Remove a package")
def remove_package(job_id: int, package_id: int, db: Session = Depends(get_db),
                   admin: AdminUser = Depends(packing_access)):
    return _detail(db, packing.remove_package(db, job_id, package_id, admin=admin), "Package removed.")


@packing_router.get("/{job_id}/validation", summary="What stands between this job and packed")
def validation(job_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(packing_access)):
    return ok(packing.validate(db, packing.get(db, job_id)))


@packing_router.post("/{job_id}/packed", summary="Mark the order packed")
def mark_packed(job_id: int, payload: Optional[dict] = Body(None), db: Session = Depends(get_db),
                admin: AdminUser = Depends(packing_access)):
    body = _body(payload)
    job = packing.mark_packed(db, job_id, admin=admin, confirm=body.get("confirm") is True,
                              override_reason=body.get("overrideReason"))
    return _detail(db, job, "Packed." if job.status == "packed" else "Packed and handed to the shipment.")


@packing_router.post("/{job_id}/reopen", summary="Move a job back, with a reason")
def reopen(job_id: int, payload: dict = Body(...), db: Session = Depends(get_db),
           admin: AdminUser = Depends(packing_access)):
    body = _body(payload)
    target = body.get("target") if isinstance(body.get("target"), str) else ""
    return _detail(db, packing.reopen(db, job_id, admin=admin, target=target, reason=body.get("reason")),
                   "Reopened.")


@packing_router.post("/{job_id}/ready", summary="Hand the packages to the order's shipment")
def ready(job_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(packing_access)):
    return _detail(db, packing.mark_ready(db, job_id, admin=admin), "Ready to ship.")


@packing_router.get("/{job_id}/slip", summary="The packing slip (PDF)")
def packing_slip(job_id: int, prices: Optional[bool] = Query(None), download: bool = Query(False),
                 db: Session = Depends(get_db), admin: AdminUser = Depends(packing_access)):
    job = packing.get(db, job_id)
    show = bool(fulfilment_settings.settings(db)["slipShowPrices"]) if prices is None else prices
    order = packing._order(db, job)
    return _pdf(slip.render(db, job, show_prices=show), slip.filename(order), download=download)


@order_packing_router.get("/{order_id}/packing", summary="An order's packing job (made now if it needs one)")
def order_packing(order_id: str, db: Session = Depends(get_db), admin: AdminUser = Depends(packing_access)):
    return ok(packing.card_view(db, order_id[:20]))


# ------------------------------------------------------------------ labels


@shipment_labels_router.get("/{shipment_id}/labels", summary="A shipment's label and its history")
def shipment_labels(shipment_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(shipments_access)):
    return ok(labels.overview(db, shipment_id))


@shipment_labels_router.post("/{shipment_id}/labels", status_code=201, summary="Generate the shipment's label")
def generate_label(shipment_id: int, response: Response, payload: Optional[dict] = Body(None),
                   db: Session = Depends(get_db), admin: AdminUser = Depends(shipments_access)):
    label, created = labels.generate(db, shipment_id, admin=admin, format_key=_body(payload).get("format"))
    if not created:
        response.status_code = 200
    return ok(labels.overview(db, shipment_id),
              message="Label generated." if created else "The label was already generated.")


@shipment_labels_router.post("/{shipment_id}/labels/regenerate", status_code=201,
                             summary="Make a new version of the label, with a reason")
def regenerate_label(shipment_id: int, payload: dict = Body(...), db: Session = Depends(get_db),
                     admin: AdminUser = Depends(shipments_access)):
    body = _body(payload)
    labels.regenerate(db, shipment_id, admin=admin, reason=body.get("reason"), format_key=body.get("format"))
    return ok(labels.overview(db, shipment_id), message="A new label version was generated.")


@shipment_labels_router.post("/{shipment_id}/labels/cancel", summary="Cancel the shipment's current label")
def cancel_label(shipment_id: int, payload: Optional[dict] = Body(None), db: Session = Depends(get_db),
                 admin: AdminUser = Depends(shipments_access)):
    reason = _body(payload).get("reason")
    labels.cancel(db, shipment_id, admin=admin, reason=reason if isinstance(reason, str) else "")
    return ok(labels.overview(db, shipment_id), message="Label cancelled.")


@labels_router.post("/bulk", summary="Generate labels for many shipments (at most 100)")
def bulk_generate(payload: dict = Body(...), db: Session = Depends(get_db),
                  admin: AdminUser = Depends(shipments_access)):
    body = _body(payload)
    result = labels.bulk_generate(db, body.get("shipmentIds"), admin=admin, format_key=body.get("format"))
    return ok(result, message=f"{result['succeeded']} label(s) ready, {result['failed']} failed.")


@labels_router.get("/bulk-download", summary="Current labels as a ZIP, or one merged PDF to print")
def bulk_download(ids: str = Query(..., max_length=1200), mode: str = Query("zip", max_length=10),
                  db: Session = Depends(get_db), admin: AdminUser = Depends(shipments_access)):
    content, name, media, skipped = labels.bulk_file(db, ids, mode="merged" if mode == "merged" else "zip")
    disposition = "inline" if media == "application/pdf" else "attachment"
    return Response(content=content, media_type=media,
                    headers={"Content-Disposition": f'{disposition}; filename="{name}"', "Cache-Control": "no-store",
                             "X-Labels-Skipped": ",".join(str(s) for s in skipped)})


@labels_router.get("/{label_id}/preview", summary="A label version's PDF, inline")
def preview_label(label_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(shipments_access)):
    content, name = labels.pdf(db, label_id)
    return _pdf(content, name, download=False)


@labels_router.get("/{label_id}/download", summary="A label version's PDF, as a download")
def download_label(label_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(shipments_access)):
    content, name = labels.pdf(db, label_id)
    return _pdf(content, name, download=True)


# ---------------------------------------------------------------- settings


@settings_router.get("/settings", summary="Packing and label settings")
def get_settings(db: Session = Depends(get_db), admin: AdminUser = Depends(get_current_admin)):
    from app.core.permissions import permissions_for
    from app.services.fulfilment.label_pdf import formats

    held = set(admin.permissions or []) | set(permissions_for(admin.role))
    if admin.role != "super-admin" and not held & {"packing", "shipments", "settings"}:
        raise AuthorizationError("Your role does not include 'packing'.", error_code="PERMISSION_DENIED")
    return ok({**fulfilment_settings.settings(db), "formats": formats(),
               "packageTypes": list(fulfilment_settings.PACKAGE_TYPES)})


@settings_router.put("/settings", summary="Save packing and label settings")
def save_settings(payload: dict = Body(...), db: Session = Depends(get_db),
                  admin: AdminUser = Depends(settings_access)):
    from app.services.fulfilment.label_pdf import formats

    saved = fulfilment_settings.save(db, payload, actor=admin)
    return ok({**saved, "formats": formats(), "packageTypes": list(fulfilment_settings.PACKAGE_TYPES)},
              message="Settings saved.")
