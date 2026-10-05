"""
Shipments, couriers and delivery estimates. See docs/shipping-and-suppliers.md, section 6.

    GET  /api/orders/{identifier}/shipments            the customer's own order
    GET  /api/delivery/estimate                        pincode check at checkout (public)
    POST /api/shipping/webhooks/{code}                 courier webhooks (verified, public)

    /api/admin/shipments...                            shipments (permission: shipments)
    /api/admin/orders/{order_id}/shipping...           an order's shipping options and rates
    /api/admin/shipping/providers...                   courier configuration (permission: shipping-config)

Every permission is checked here, on the server. A customer sees only their
own order's shipments, and only the customer view: no errors, retries,
provider ids or internal notes.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Body, Depends, Query, Request, Response
from sqlalchemy.orm import Session

from app.core import rate_limit
from app.core.database import get_db
from app.core.errors import AuthorizationError
from app.dependencies.auth import client_ip, get_current_admin, get_current_customer, require_access
from app.models import AdminUser, Customer
from app.services.shipping import estimate as estimates
from app.services.shipping import providers as provider_config
from app.services.shipping import service, webhooks
from app.utils.response import Pagination, ok

customer_router = APIRouter(prefix="/orders", tags=["Orders"])
estimate_router = APIRouter(prefix="/delivery", tags=["Delivery"])
webhook_router = APIRouter(prefix="/shipping/webhooks", tags=["Shipping"])
admin_router = APIRouter(prefix="/admin/shipments", tags=["Admin · Shipments"])
admin_order_router = APIRouter(prefix="/admin/orders", tags=["Admin · Shipments"])
providers_router = APIRouter(prefix="/admin/shipping/providers", tags=["Admin · Shipping providers"])

shipments_access = require_access("shipments")
config_access = require_access("shipping-config")


def _holds(admin: AdminUser, permission: str) -> bool:
    from app.core.permissions import permissions_for

    return (admin.role == "super-admin" or permission in (admin.permissions or [])
            or permission in permissions_for(admin.role))


# ---------------------------------------------------------------- customer


@customer_router.get("/{identifier}/shipments", summary="Shipment tracking for one of my orders")
def my_shipments(identifier: str, db: Session = Depends(get_db),
                 customer: Customer = Depends(get_current_customer)):
    return ok(service.for_customer(db, identifier[:30], customer.id))


@estimate_router.get("/estimate", summary="When delivery to a pincode can be expected")
def delivery_estimate(request: Request, pincode: str = Query(..., max_length=10), cod: bool = Query(False),
                      db: Session = Depends(get_db)):
    # The same allowance as the pincode check: a person typing addresses, not a script mapping coverage.
    rate_limit.check(f"delivery-estimate:{client_ip(request)}", limit=60, window_seconds=300,
                     message="Too many delivery checks. Please wait a moment.")
    return ok(estimates.estimate(db, pincode, cod=cod))


@webhook_router.post("/{code}", include_in_schema=False)
async def courier_webhook(code: str, request: Request, db: Session = Depends(get_db)):
    # The raw bytes: the token is checked and the de-duplication key is
    # computed over exactly what the courier sent.
    body = await request.body()
    result = webhooks.handle(db, code[:30].lower(), dict(request.headers), body)
    return ok(result)


# ------------------------------------------------------- admin: shipments


@admin_router.get("", summary="Shipments")
def list_shipments(
    q: str = Query("", max_length=80, description="Shipment ID (number or AWB) or Order ID, exact"),
    order: str = Query("", max_length=80, description="Order ID, exact"),
    status: str = Query("", max_length=30),
    courier: str = Query("", max_length=60, description="Courier code, exact"),
    provider: str = Query("", max_length=30),
    date_from: str = Query("", alias="from", max_length=10),
    date_to: str = Query("", alias="to", max_length=10),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(shipments_access),
):
    items, total, counts = service.search(db, q=q, order=order, status=status, courier=courier, provider=provider,
                                          date_from=date_from, date_to=date_to, page=page, page_size=page_size)
    return ok({"items": items, "pagination": Pagination.build(page, page_size, total).model_dump(),
               "counts": counts})


@admin_router.post("", status_code=201, summary="Create a shipment for an order")
def create_shipment(response: Response, payload: dict = Body(...), db: Session = Depends(get_db),
                    admin: AdminUser = Depends(shipments_access)):
    shipment, created = service.create(db, admin, payload)
    if not created:
        response.status_code = 200
    view = service.admin_view(db, shipment)
    if view["technical"]["requestStatus"] == "failed":
        message = "Shipment recorded, but the courier didn't accept it yet. See the error and retry."
    else:
        message = "Shipment created." if created else "This shipment was already created."
    return ok(view, message=message)


@admin_router.get("/pipeline", summary="Packed orders waiting for a shipment, and orders missing one")
def shipment_pipeline(db: Session = Depends(get_db), admin: AdminUser = Depends(shipments_access)):
    """
    What surrounds the shipment list: packed orders a shipment can be created
    for, orders dispatched with no shipment on record (from before the
    workflow was enforced), and whether a courier is switched on. Read only.
    """
    return ok(service.pipeline(db))


@admin_router.get("/{shipment_id}", summary="A shipment")
def get_shipment(shipment_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(shipments_access)):
    return ok(service.admin_view(db, service.get(db, shipment_id)))


@admin_router.put("/{shipment_id}/package", summary="Change the package before the courier confirms it")
def update_package(shipment_id: int, payload: dict = Body(...), db: Session = Depends(get_db),
                   admin: AdminUser = Depends(shipments_access)):
    shipment = service.update_package(db, shipment_id, payload.get("package"), admin=admin)
    return ok(service.admin_view(db, shipment), message="Package saved.")


@admin_router.post("/{shipment_id}/label", summary="Generate the shipping label")
def generate_label(shipment_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(shipments_access)):
    shipment = service.label(db, shipment_id, admin=admin)
    return ok(service.admin_view(db, shipment), message="Label ready.")


@admin_router.post("/{shipment_id}/pickup", summary="Schedule a courier pickup")
def schedule_pickup(shipment_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(shipments_access)):
    shipment = service.pickup(db, shipment_id, admin=admin)
    return ok(service.admin_view(db, shipment), message="Pickup scheduled.")


@admin_router.post("/{shipment_id}/cancel", summary="Cancel a shipment before pickup")
def cancel_shipment(shipment_id: int, payload: Optional[dict] = Body(None), db: Session = Depends(get_db),
                    admin: AdminUser = Depends(shipments_access)):
    reason = (payload or {}).get("reason")
    shipment = service.cancel(db, shipment_id, admin=admin, reason=reason if isinstance(reason, str) else "")
    return ok(service.admin_view(db, shipment), message="Shipment cancelled.")


@admin_router.post("/{shipment_id}/retry", summary="Retry the last failed courier operation")
def retry_shipment(shipment_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(shipments_access)):
    shipment = service.retry(db, shipment_id, admin=admin)
    view = service.admin_view(db, shipment)
    failed = view["technical"]["requestStatus"] == "failed"
    return ok(view, message="The courier still refused it. See the error." if failed else "Done.")


@admin_router.post("/{shipment_id}/refresh", summary="Pull tracking from the courier now")
def refresh_shipment(shipment_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(shipments_access)):
    shipment = service.refresh(db, shipment_id, admin=admin)
    return ok(service.admin_view(db, shipment), message="Tracking refreshed.")


@admin_router.post("/{shipment_id}/status", summary="Move a shipment one step (docs/order-fulfilment.md)")
def move_shipment(shipment_id: int, payload: dict = Body(...), db: Session = Depends(get_db),
                  admin: AdminUser = Depends(shipments_access)):
    """
    `{ status, reason?, description?, location?, occurredAt? }`. Only the moves
    the shipment's `transitions` lists are accepted (409
    `INVALID_SHIPMENT_TRANSITION` otherwise); exceptions and backward moves
    need a reason (422 `REASON_REQUIRED`). The order follows the shipment.
    """
    shipment = service.transition(db, shipment_id, payload, admin=admin)
    return ok(service.admin_view(db, shipment), message=f"Shipment is now {service.STATUS_LABELS[shipment.status].lower()}.")


@admin_router.post("/{shipment_id}/events", status_code=201, summary="Record a tracking update by hand")
def add_event(shipment_id: int, payload: dict = Body(...), db: Session = Depends(get_db),
              admin: AdminUser = Depends(shipments_access)):
    shipment = service.add_event(db, shipment_id, payload, admin=admin)
    return ok(service.admin_view(db, shipment), message="Tracking update recorded.")


# --------------------------------------------------- admin: order shipping


@admin_order_router.get("/{order_id}/shipping", summary="An order's shipments and how it can be shipped")
def order_shipping(order_id: str, db: Session = Depends(get_db), admin: AdminUser = Depends(shipments_access)):
    return ok(service.order_overview(db, order_id[:20]))


@admin_order_router.post("/{order_id}/shipping/rates", summary="Courier rates for this order's parcel")
def order_rates(order_id: str, payload: dict = Body(...), db: Session = Depends(get_db),
                admin: AdminUser = Depends(shipments_access)):
    rate_limit.check(f"shipping-rates:{admin.id}", limit=30, window_seconds=60,
                     message="Too many rate requests. Please wait a moment.")
    return ok(service.rates(db, order_id[:20], payload))


# ------------------------------------------------------ admin: providers


@providers_router.get("", summary="Courier integrations")
def list_providers(request: Request, db: Session = Depends(get_db), admin: AdminUser = Depends(get_current_admin)):
    # Readable with `shipments` too (to pick a courier), but only `shipping-config` sees which credentials are set.
    can_configure = _holds(admin, "shipping-config")
    if not can_configure and not _holds(admin, "shipments"):
        raise AuthorizationError("Your role does not include 'shipping-config'.", error_code="PERMISSION_DENIED")
    return ok(provider_config.list_providers(db, with_credentials=can_configure, base_url=str(request.base_url)))


@providers_router.put("/{code}", summary="Configure a courier")
def save_provider(code: str, request: Request, payload: dict = Body(...), db: Session = Depends(get_db),
                  admin: AdminUser = Depends(config_access)):
    row = provider_config.save(db, code[:30].lower(), payload, actor=admin)
    return ok(provider_config.view(row.code, row, with_credentials=True, base_url=str(request.base_url)),
              message="Courier saved.")


@providers_router.post("/{code}/test", summary="Test a courier's credentials")
def test_provider(code: str, payload: Optional[dict] = Body(default=None), db: Session = Depends(get_db),
                  admin: AdminUser = Depends(config_access)):
    """Tests the saved credentials, or the ones in `credentials` (and `environment`) without saving them."""
    rate_limit.check(f"shipping-test:{code[:30]}", limit=10, window_seconds=60,
                     message="Too many connection tests. Please wait a minute.")
    result = provider_config.test(db, code[:30].lower(), actor=admin, payload=payload)
    return ok(result, message=result["message"])
