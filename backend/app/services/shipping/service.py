"""
Shipments: creating them, operating them at the courier, and applying what
the courier reports. See docs/shipping-and-suppliers.md, sections 4, 6-8.

## The rules this module keeps

- An order has at most one *active* shipment (`active_key`), and creation is
  idempotent on the client's `idempotencyKey`. The row is committed **before**
  the courier is called, so a failure or a timeout leaves a `pending` record
  that a retry continues from, never a second courier order.
- A shipment's status moves forward only (a delivery attempt may fall back to
  out-for-delivery or in-transit); a terminal status never changes through a
  courier. Unknown courier text is recorded and moves nothing.
- The order moves **forward only**, through `orders.update_status`, so every
  order email and side effect keeps working. A refusal is recorded, never raised
  into a webhook.
- Staff alerts go once per shipment per kind (`alerts_sent`).
"""

from __future__ import annotations

import hashlib
import logging
import re
import secrets
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from app.core import numbering, rate_limit
from app.core.errors import AppError, ConflictError, NotFoundError, ValidationError
from app.models import Order
from app.models.shipping import Shipment, ShipmentEvent
from app.services import audit, billing
from app.services.shipping import registry
from app.services.shipping.base import (
    BEFORE_PICKUP,
    STATUS_LABELS,
    STATUSES,
    TERMINAL,
    Address,
    CreateRequest,
    PackageInfo,
    ProviderError,
    ShipmentLine,
    TrackingEvent,
    Unsupported,
)

logger = logging.getLogger(__name__)

# The main line, in order. Off it: delivery-attempted, delivery-failed,
# returned-to-origin, cancelled.
LINE = ("pending", "ready-for-pickup", "pickup-scheduled", "picked-up", "in-transit", "at-destination-hub",
        "out-for-delivery", "delivered")
# A parcel with the courier and moving (or meant to be): polled, and watched for being stuck.
IN_TRANSIT = {"picked-up", "in-transit", "at-destination-hub", "out-for-delivery", "delivery-attempted"}
# Shipment status -> the order status it implies (forward only).
ORDER_MOVE = {"picked-up": "shipped", "in-transit": "in-transit", "at-destination-hub": "in-transit",
              "out-for-delivery": "out-for-delivery", "delivered": "delivered"}
SHIPPABLE = {"confirmed", "processing", "packed"}

BACKOFF_MINUTES = (2, 4, 8, 16, 32)
MAX_ATTEMPTS = 6
UNREACHABLE_AFTER = 5
STUCK_DAYS = 5
REFRESH_LIMIT = (2, 60)  # per shipment: 2 manual refreshes a minute

AWB_PATTERN = re.compile(r"^[A-Za-z0-9-]{4,40}$")


class CourierUnavailable(AppError):
    status_code = 503
    error_code = "COURIER_UNAVAILABLE"


class UnsupportedOperation(AppError):
    status_code = 400
    error_code = "UNSUPPORTED"


class ProviderRefused(AppError):
    status_code = 400
    error_code = "PROVIDER_ERROR"


def _now() -> datetime:
    return datetime.utcnow().replace(microsecond=0)


def _label_date(value: datetime) -> str:
    return f"{value:%a}, {value.day} {value:%b}"


def _raise_for(error: ProviderError):
    if error.transient:
        raise CourierUnavailable(error.message, details={"providerCode": error.code})
    raise ProviderRefused(error.message, details={"providerCode": error.code})


# ------------------------------------------------------------------ package


def _number(raw, field: str, *, minimum: float, maximum: float, integer: bool = False):
    if isinstance(raw, bool) or raw is None or raw == "":
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise ValidationError(f"{field} must be a number.", error_code="INVALID_PACKAGE",
                              details={"field": field}) from None
    if value != value or not minimum <= value <= maximum:
        raise ValidationError(f"{field} must be between {minimum:g} and {maximum:g}.", error_code="INVALID_PACKAGE",
                              details={"field": field})
    if integer:
        if not value.is_integer():
            raise ValidationError(f"{field} must be a whole number.", error_code="INVALID_PACKAGE",
                                  details={"field": field})
        return int(value)
    return round(value, 2)


def clean_package(raw, *, require_dimensions: bool) -> PackageInfo:
    """
    The package as entered by the team. Weight is always required (1 g to
    100 kg); length, width and height (0.1 to 300 cm) are required for courier
    APIs. Nothing is invented when a field is missing.
    """
    if not isinstance(raw, dict):
        raise ValidationError("Enter the package weight.", error_code="PACKAGE_REQUIRED",
                              details={"field": "package"})
    weight = _number(raw.get("weightGrams"), "weightGrams", minimum=1, maximum=100000, integer=True)
    if weight is None:
        raise ValidationError("Enter the package weight in grams.", error_code="PACKAGE_REQUIRED",
                              details={"field": "weightGrams"})
    dims = {key: _number(raw.get(key), key, minimum=0.1, maximum=300)
            for key in ("lengthCm", "widthCm", "heightCm")}
    if require_dimensions and any(value is None for value in dims.values()):
        raise ValidationError("Enter the package's length, width and height.", error_code="PACKAGE_REQUIRED",
                              details={"field": next(k for k, v in dims.items() if v is None)})
    count = _number(raw.get("count"), "count", minimum=1, maximum=50, integer=True) or 1
    kind = raw.get("type") or "box"
    if not isinstance(kind, str) or len(kind.strip()) > 30 or not kind.strip():
        raise ValidationError("The package type must be a short name.", error_code="INVALID_PACKAGE",
                              details={"field": "type"})
    return PackageInfo(weight_grams=weight, length_cm=dims["lengthCm"], width_cm=dims["widthCm"],
                       height_cm=dims["heightCm"], count=count, type=kind.strip())


def package_view(package) -> dict:
    if isinstance(package, PackageInfo):
        return {"weightGrams": package.weight_grams, "lengthCm": package.length_cm, "widthCm": package.width_cm,
                "heightCm": package.height_cm, "count": package.count, "type": package.type}
    shipment = package

    def dim(value):
        return float(value) if value is not None else None

    return {"weightGrams": shipment.weight_grams, "lengthCm": dim(shipment.length_cm),
            "widthCm": dim(shipment.width_cm), "heightCm": dim(shipment.height_cm),
            "count": shipment.package_count, "type": shipment.package_type}


# ------------------------------------------------------------- transitions


def can_move(current: str, new: str) -> bool:
    """Whether a shipment may go from `current` to `new` (see the module docstring)."""
    if not new or new == current or new not in STATUSES or new == "pending":
        return False
    if current in TERMINAL:
        return False
    if new == "cancelled":
        return current in BEFORE_PICKUP
    if current == "delivery-failed":
        return new in ("returned-to-origin", "delivered")
    if new == "delivery-failed":
        return True
    if new == "returned-to-origin":
        return current != "pending"
    if current == "delivery-attempted":
        return new in ("in-transit", "at-destination-hub", "out-for-delivery", "delivered")
    if new == "delivery-attempted":
        return current in ("picked-up", "in-transit", "at-destination-hub", "out-for-delivery")
    if current in LINE and new in LINE:
        return LINE.index(new) > LINE.index(current)
    return False


def dedupe_key(event: TrackingEvent) -> str:
    if event.provider_event_id:
        return event.provider_event_id[:80]
    raw = f"{event.occurred_at.isoformat()}|{event.provider_status}|{event.location}"
    return hashlib.sha1(raw.encode()).hexdigest()


def next_sync_at(shipment: Shipment, now: Optional[datetime] = None) -> Optional[datetime]:
    """When tracking should next be pulled (contract section 8). None: never polled."""
    now = now or _now()
    if shipment.provider_code == "manual" or not shipment.awb or shipment.status in TERMINAL:
        return None
    if shipment.last_webhook_at and now - shipment.last_webhook_at < timedelta(hours=24):
        return now + timedelta(hours=12)
    if shipment.status == "out-for-delivery":
        return now + timedelta(hours=2)
    return now + timedelta(hours=6)


# ------------------------------------------------------------------ helpers


def _adapter(shipment: Shipment, *, timeout: Optional[float] = None):
    return registry.adapter_for(shipment.provider_code, shipment.provider, timeout=timeout)


def get(db: Session, shipment_id, *, lock: bool = False) -> Shipment:
    try:
        key = int(shipment_id)
    except (TypeError, ValueError):
        key = None
    statement = select(Shipment).where(Shipment.id == key) if key is not None else None
    if statement is None:
        raise NotFoundError("No such shipment.", error_code="SHIPMENT_NOT_FOUND")
    if lock:
        statement = statement.with_for_update()
    shipment = db.execute(statement).scalar_one_or_none()
    if shipment is None:
        raise NotFoundError("No such shipment.", error_code="SHIPMENT_NOT_FOUND")
    return shipment


def _active_for(db: Session, order_id: str) -> Optional[Shipment]:
    return db.execute(select(Shipment).where(Shipment.active_key == order_id)).scalar_one_or_none()


def _by_key(db: Session, key: str) -> Optional[Shipment]:
    return db.execute(select(Shipment).where(Shipment.idempotency_key == key)).scalar_one_or_none()


def _event(db: Session, shipment: Shipment, *, status: str, description: str, source: str, actor: str = "",
           visible: bool = True, provider_status: str = "", location: str = "", occurred_at=None,
           key: Optional[str] = None) -> ShipmentEvent:
    now = _now()
    row = ShipmentEvent(
        shipment_id=shipment.id, status=status, provider_status=(provider_status or "")[:120],
        description=(description or "")[:500], location=(location or "")[:160],
        occurred_at=occurred_at or now, received_at=now, source=source, actor=(actor or "")[:40],
        visible=visible, dedupe_key=(key or f"{source}:{secrets.token_hex(12)}")[:80],
    )
    db.add(row)
    return row


def _alert(db: Session, shipment: Shipment, kind: str, title: str, body: str) -> bool:
    """A staff alert, once per shipment per kind."""
    sent = list(shipment.alerts_sent or [])
    if kind in sent:
        return False
    shipment.alerts_sent = sent + [kind]
    from app.services import inbox

    inbox.staff(db, f"shipment-{kind}"[:30], title, body, href=f"/admin/shipments/detail?id={shipment.id}",
                permission="shipments")
    return True


def _succeeded(shipment: Shipment) -> None:
    shipment.request_status = "ok"
    shipment.last_error = ""
    shipment.last_error_at = None
    shipment.last_error_transient = False
    shipment.retry_count = 0
    shipment.next_retry_at = None


def _failed(db: Session, shipment: Shipment, operation: str, error: ProviderError) -> None:
    """Record a courier failure, schedule the retry, alert when it's worth a person's attention."""
    now = _now()
    shipment.request_status = "failed"
    shipment.last_operation = operation
    shipment.last_error = (error.message or "The courier call failed.")[:500]
    shipment.last_error_at = now
    shipment.last_error_transient = bool(error.transient)
    shipment.retry_count = (shipment.retry_count or 0) + 1
    if error.transient and shipment.retry_count < MAX_ATTEMPTS:
        wait = BACKOFF_MINUTES[min(shipment.retry_count, len(BACKOFF_MINUTES)) - 1]
        shipment.next_retry_at = now + timedelta(minutes=wait)
    else:
        shipment.next_retry_at = None
    _event(db, shipment, status="", description=f"{operation.capitalize()} failed: {shipment.last_error}",
           source="system", visible=False)
    number = shipment.shipment_number
    if error.transient and shipment.retry_count >= UNREACHABLE_AFTER:
        _alert(db, shipment, "courier-unreachable", f"Courier unreachable for {number}",
               f"{shipment.retry_count} attempts in a row have failed: {shipment.last_error}")
    exhausted = not error.transient or shipment.retry_count >= MAX_ATTEMPTS
    if operation == "create" and exhausted:
        _alert(db, shipment, "create-failed", f"Shipment {number} couldn't be booked",
               f"The courier refused or kept failing: {shipment.last_error}")
    elif operation == "pickup":
        _alert(db, shipment, "pickup-failed", f"Pickup failed for {number}", shipment.last_error)
    elif exhausted and error.transient:
        _alert(db, shipment, f"{operation}-failed", f"{operation.capitalize()} failed for {number}",
               shipment.last_error)


# ------------------------------------------------------------------ views


def _order_view(order: Order) -> dict:
    return {
        "id": order.id, "orderNumber": order.order_number, "status": order.status,
        "paymentStatus": order.payment_status, "paymentMethod": order.payment_method,
        "total": float(order.total or 0), "placedAt": order.placed_at,
        "customer": {"id": order.customer_id, "name": order.customer_name, "email": order.customer_email,
                     "phone": order.shipping_phone},
        "items": [{"productId": item.product_id, "name": item.name, "sku": item.sku, "quantity": item.quantity,
                   "size": item.size, "color": item.color, "lineTotal": float(item.line_total or 0)}
                  for item in order.items],
    }


def destination_of(order: Order) -> dict:
    return {"name": order.shipping_name or order.customer_name, "phone": order.shipping_phone,
            "line1": order.shipping_line1, "line2": order.shipping_line2 or "", "city": order.shipping_city,
            "state": order.shipping_state, "pincode": order.shipping_pincode,
            "country": order.shipping_country or "India"}


def actions(shipment: Shipment, supports: Dict[str, bool]) -> dict:
    status = shipment.status
    open_ = status not in TERMINAL
    has_awb = bool(shipment.awb)
    return {
        "label": bool(supports.get("label") and has_awb and shipment.provider_shipment_id
                      and status in ("ready-for-pickup", "pickup-scheduled")),
        "pickup": bool(supports.get("pickup") and has_awb and shipment.provider_shipment_id
                       and status == "ready-for-pickup"),
        "cancel": status in BEFORE_PICKUP,
        "refresh": bool(supports.get("tracking") and has_awb and open_),
        "retry": shipment.request_status == "failed",
        "manualEvent": open_ and status != "pending",
        "editPackage": status == "pending",
    }


def _event_view(event: ShipmentEvent) -> dict:
    return {"id": event.id, "status": event.status, "label": STATUS_LABELS.get(event.status, "Update"),
            "providerStatus": event.provider_status, "description": event.description, "location": event.location,
            "occurredAt": event.occurred_at, "receivedAt": event.received_at, "source": event.source,
            "actor": event.actor, "visible": event.visible}


def _events(db: Session, shipment: Shipment) -> List[ShipmentEvent]:
    return list(db.execute(
        select(ShipmentEvent).where(ShipmentEvent.shipment_id == shipment.id)
        .order_by(ShipmentEvent.occurred_at, ShipmentEvent.id)
    ).scalars())


def admin_view(db: Session, shipment: Shipment) -> dict:
    order = db.get(Order, shipment.order_id)
    adapter = _adapter(shipment)
    supports = adapter.supports()
    provider = shipment.provider
    return {
        "id": shipment.id, "shipmentNumber": shipment.shipment_number, "status": shipment.status,
        "statusLabel": STATUS_LABELS.get(shipment.status, shipment.status),
        "order": _order_view(order) if order is not None else None,
        "provider": {"code": shipment.provider_code, "name": (provider.name if provider is not None else "")
                     or adapter.name},
        "courierName": shipment.courier_name, "courierCode": shipment.courier_code, "service": shipment.service,
        "awb": shipment.awb or "", "providerShipmentId": shipment.provider_shipment_id or "",
        "providerOrderId": shipment.provider_order_id or "",
        "trackingUrl": adapter.tracking_url(shipment.awb or "") if shipment.awb else "",
        "package": package_view(shipment),
        "cod": shipment.cod, "codAmount": billing.to_major(shipment.cod_amount or 0),
        "declaredValue": billing.to_major(shipment.declared_value or 0),
        "origin": shipment.origin or {}, "destination": shipment.destination or {},
        "expectedDeliveryAt": shipment.expected_delivery_at, "deliveredAt": shipment.delivered_at,
        "cancelledAt": shipment.cancelled_at, "cancelReason": shipment.cancel_reason,
        "label": {"available": bool(shipment.label_url), "url": shipment.label_url or ""},
        "pickup": {"status": shipment.pickup_status or "", "scheduledAt": shipment.pickup_scheduled_at,
                   "token": shipment.pickup_token or ""},
        "events": [_event_view(e) for e in _events(db, shipment)],
        "technical": {"requestStatus": shipment.request_status, "lastOperation": shipment.last_operation,
                      "lastError": shipment.last_error, "lastErrorAt": shipment.last_error_at,
                      "retryCount": shipment.retry_count, "nextRetryAt": shipment.next_retry_at,
                      "lastSyncedAt": shipment.last_synced_at, "nextSyncAt": shipment.next_sync_at,
                      "lastWebhookAt": shipment.last_webhook_at},
        "actions": actions(shipment, supports),
        "createdAt": shipment.created_at, "updatedAt": shipment.updated_at, "createdBy": shipment.created_by,
    }


def summary_view(shipment: Shipment, order: Optional[Order]) -> dict:
    return {
        "id": shipment.id, "shipmentNumber": shipment.shipment_number, "status": shipment.status,
        "statusLabel": STATUS_LABELS.get(shipment.status, shipment.status), "orderId": shipment.order_id,
        "orderNumber": order.order_number if order is not None else "",
        "customerName": order.customer_name if order is not None else "",
        "courierName": shipment.courier_name, "awb": shipment.awb or "", "providerCode": shipment.provider_code,
        "requestStatus": shipment.request_status, "lastError": shipment.last_error,
        "expectedDeliveryAt": shipment.expected_delivery_at, "createdAt": shipment.created_at,
        "updatedAt": shipment.updated_at,
    }


def customer_view(db: Session, shipment: Shipment) -> dict:
    """What the customer may see: no errors, retries, provider ids, actors or internal notes."""
    adapter = _adapter(shipment)
    events = [e for e in _events(db, shipment) if e.visible]
    return {
        "shipmentNumber": shipment.shipment_number, "status": shipment.status,
        "statusLabel": STATUS_LABELS.get(shipment.status, shipment.status),
        "courierName": shipment.courier_name, "service": shipment.service, "awb": shipment.awb or "",
        "trackingUrl": (adapter.tracking_url(shipment.awb) if shipment.awb and shipment.status != "cancelled"
                        else ""),
        "expectedDeliveryAt": shipment.expected_delivery_at, "deliveredAt": shipment.delivered_at,
        "createdAt": shipment.created_at,
        "events": [{"status": e.status, "label": STATUS_LABELS.get(e.status, "Update"),
                    "description": e.description, "location": e.location, "occurredAt": e.occurred_at,
                    "source": "courier" if e.source in ("webhook", "poll") else "store"} for e in events],
    }


def for_customer(db: Session, identifier: str, customer_id: str) -> List[dict]:
    from app.services import orders

    order = orders.get_order(db, identifier, customer_id=customer_id)
    shipments = db.execute(select(Shipment).where(Shipment.order_id == order.id)
                           .order_by(Shipment.created_at, Shipment.id)).scalars()
    return [customer_view(db, s) for s in shipments]


# --------------------------------------------------------------- searching


def _parse_day(value: str) -> Optional[datetime]:
    try:
        return datetime.strptime((value or "").strip(), "%Y-%m-%d")
    except ValueError:
        return None


def search(db: Session, *, q: str = "", status: str = "", courier: str = "", provider: str = "", date_from: str = "",
           date_to: str = "", page: int = 1, page_size: int = 25) -> Tuple[List[dict], int, Dict[str, int]]:
    conditions = []
    text = (q or "").strip()[:80]
    if text:
        like = f"%{text}%"
        conditions.append(or_(Shipment.shipment_number.like(like), Order.order_number.like(like),
                              Shipment.awb.like(like), Order.customer_name.ilike(like),
                              Order.customer_email.ilike(like)))
    if courier:
        conditions.append(or_(Shipment.courier_name.ilike(f"%{courier.strip()[:60]}%"),
                              Shipment.courier_code == courier.strip()[:40]))
    if provider:
        conditions.append(Shipment.provider_code == provider.strip()[:30])
    start, end = _parse_day(date_from), _parse_day(date_to)
    if start:
        conditions.append(Shipment.created_at >= start)
    if end:
        conditions.append(Shipment.created_at < end + timedelta(days=1))
    base = select(Shipment, Order).join(Order, Order.id == Shipment.order_id).where(*conditions)
    counts = dict(db.execute(
        select(Shipment.status, func.count()).join(Order, Order.id == Shipment.order_id)
        .where(*conditions).group_by(Shipment.status)
    ).all())
    if status in STATUSES:
        base = base.where(Shipment.status == status)
    total = db.execute(select(func.count()).select_from(base.subquery())).scalar_one()
    rows = db.execute(base.order_by(Shipment.created_at.desc(), Shipment.id.desc())
                      .offset((max(1, page) - 1) * page_size).limit(page_size)).all()
    return [summary_view(s, o) for s, o in rows], total, {k: int(v) for k, v in counts.items()}


# --------------------------------------------------------- order overview


def _shippable_reason(order: Order) -> Tuple[Optional[str], str]:
    """(error code, reason) when this order can't have a shipment created, else (None, "")."""
    if order.status == "pending":
        return "AWAITING_PAYMENT", "This order is waiting for its payment."
    if order.status not in SHIPPABLE:
        return "ORDER_NOT_SHIPPABLE", f"This order is {order.status.replace('-', ' ')}; it can't be shipped."
    return None, ""


def order_overview(db: Session, order_id: str) -> dict:
    from app.services import orders
    from app.services.shipping import providers as provider_config

    order = orders.get_order(db, order_id)
    shipments = list(db.execute(select(Shipment).where(Shipment.order_id == order.id)
                                .order_by(Shipment.created_at.desc(), Shipment.id.desc())).scalars())
    active = next((s for s in shipments if s.active_key), None)
    rows = registry.active_rows(db)
    can_create, reason = True, ""
    code, why = _shippable_reason(order)
    if active is not None:
        can_create, reason = False, "This order already has an active shipment."
    elif code:
        can_create, reason = False, why
    elif not rows:
        can_create, reason = False, "No courier is switched on. Set one up in Settings, Couriers."
    default = registry.default_row(db)
    default_package = provider_config.settings_of(default)["defaultPackage"] if default is not None else None
    provider_list = []
    for row in rows:
        adapter = registry.adapter_for(row.code, row)
        provider_list.append({"code": row.code, "name": row.name or adapter.name, "isDefault": bool(row.is_default),
                              "services": adapter.services(), "supports": adapter.supports()})
    return {
        "order": _order_view(order), "destination": destination_of(order),
        "shipments": [summary_view(s, order) for s in shipments],
        "activeShipmentId": active.id if active is not None else None,
        "canCreate": can_create, "reason": reason, "providers": provider_list,
        "defaultPackage": default_package,
    }


def rates(db: Session, order_id: str, payload: dict) -> dict:
    from app.services import orders
    from app.services.shipping import providers as provider_config

    order = orders.get_order(db, order_id)
    code = payload.get("providerCode") if isinstance(payload.get("providerCode"), str) else ""
    row, adapter = registry.active_provider(db, code)
    if not adapter.supports().get("rates"):
        raise UnsupportedOperation(f"{adapter.name} doesn't offer courier rates.")
    package = clean_package(payload.get("package"), require_dimensions=False)
    origin = provider_config.settings_of(row)["origin"].get("pincode", "")
    if not origin:
        raise ValidationError("Set the pickup address pincode in the courier settings first.",
                              error_code="ORIGIN_REQUIRED")
    cod = order.payment_method == "cod" and order.payment_status != "paid"
    try:
        result = adapter.serviceability(pickup_pincode=origin, delivery_pincode=order.shipping_pincode,
                                        weight_grams=package.weight_grams, cod=cod)
    except Unsupported:
        raise UnsupportedOperation(f"{adapter.name} doesn't offer courier rates.") from None
    except ProviderError as error:
        raise CourierUnavailable(error.message) from None
    return {
        "options": [{"courierCode": o.courier_code, "courierName": o.courier_name, "rate": billing.to_major(o.rate),
                     "etaDays": o.eta_days, "estimatedDeliveryAt": o.estimated_delivery_at,
                     "codAvailable": o.cod_available} for o in result.options],
        "source": row.code, "serviceable": result.serviceable, "message": result.message,
    }


# ----------------------------------------------------------------- creating


def _clean_text(value, limit: int) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def create(db: Session, admin, payload: dict) -> Tuple[Shipment, bool]:
    """
    Record a shipment, then book it with the courier. Returns (shipment,
    created). The same `idempotencyKey` again returns the same shipment.
    """
    from app.services import orders
    from app.services.shipping import providers as provider_config

    key = _clean_text(payload.get("idempotencyKey"), 80)
    if len(key) < 8:
        raise ValidationError("idempotencyKey is required (8 to 80 characters).", error_code="IDEMPOTENCY_KEY_REQUIRED")
    order_id = _clean_text(payload.get("orderId"), 20)

    existing = _by_key(db, key)
    if existing is not None:
        if existing.order_id != order_id and order_id:
            order = db.get(Order, existing.order_id)
            if order is None or (order_id not in (order.id, order.order_number)):
                raise ConflictError("That request key was already used for another shipment.",
                                    error_code="IDEMPOTENCY_KEY_REUSED")
        return existing, False

    order = orders.get_order(db, order_id)
    active = _active_for(db, order.id)
    if active is not None:
        raise ConflictError(f"This order already has an active shipment ({active.shipment_number}).",
                            error_code="SHIPMENT_EXISTS", details={"shipmentId": active.id})
    code, why = _shippable_reason(order)
    if code:
        raise ConflictError(why, error_code=code)

    provider_code = payload.get("providerCode") if isinstance(payload.get("providerCode"), str) else ""
    row, adapter = registry.active_provider(db, provider_code)
    config = provider_config.settings_of(row)
    raw_package = payload.get("package")
    if raw_package in (None, {}) and config.get("defaultPackage"):
        raw_package = config["defaultPackage"]
    package = clean_package(raw_package, require_dimensions=not adapter.manual_awb)
    service_name = _clean_text(payload.get("service"), 60) or config.get("defaultService") or ""
    courier_code = _clean_text(payload.get("courierCode"), 40)

    awb, courier_name = None, ""
    if adapter.manual_awb:
        awb = _clean_text(payload.get("awb"), 64)
        courier_name = _clean_text(payload.get("courierName"), 120)
        if not courier_name:
            raise ValidationError("Enter the courier's name.", error_code="COURIER_NAME_REQUIRED",
                                  details={"field": "courierName"})
        if not AWB_PATTERN.match(awb or ""):
            raise ValidationError("Enter the AWB: 4 to 40 letters, digits or hyphens.", error_code="AWB_REQUIRED",
                                  details={"field": "awb"})
        clash = db.execute(select(Shipment.id).where(Shipment.provider_id == row.id, Shipment.awb == awb)).first()
        if clash:
            raise ConflictError("That AWB is already used by another shipment.", error_code="AWB_EXISTS")

    cod = order.payment_method == "cod" and order.payment_status != "paid"
    total = billing.to_minor(order.total or 0)
    origin = {k: v for k, v in config["origin"].items()}
    if config.get("pickupLocation"):
        origin["pickupLocation"] = config["pickupLocation"]

    shipment = None
    for attempt in range(4):
        now = _now()
        shipment = Shipment(
            order_id=order.id, provider_id=row.id, provider_code=row.code, active_key=order.id,
            idempotency_key=key, courier_name=courier_name, courier_code=courier_code, service=service_name,
            awb=awb or None, status="pending",
            weight_grams=package.weight_grams, length_cm=package.length_cm, width_cm=package.width_cm,
            height_cm=package.height_cm, package_count=package.count, package_type=package.type,
            cod=cod, cod_amount=total if cod else 0, declared_value=total,
            origin=origin, destination=destination_of(order), request_status="pending", last_operation="create",
            alerts_sent=[], created_by=getattr(admin, "id", "") or "", created_at=now, updated_at=now,
        )
        try:
            shipment.shipment_number = numbering.next_yearly(db, numbering.SHIPMENT, Shipment.shipment_number, now)
            db.add(shipment)
            db.flush()
            _event(db, shipment, status="pending", description="Shipment recorded.", source="admin",
                   actor=getattr(admin, "id", ""), visible=False, key="created")
            audit.record(db, "shipment.create", resource_type="shipment", resource_id=shipment.shipment_number,
                         actor=admin, summary=f"Shipment {shipment.shipment_number} for order {order.order_number} "
                                              f"with {adapter.name}",
                         changes=audit.diff({}, {"provider": row.code, "package": package_view(package),
                                                 "awb": awb or "", "courierName": courier_name}))
            db.commit()
            break
        except (IntegrityError, OperationalError) as error:
            # Another request got there first (same key, or another shipment for
            # this order), or the number lock deadlocked with it.
            db.rollback()
            winner = _by_key(db, key)
            if winner is not None:
                return winner, False
            active = _active_for(db, order.id)
            if active is not None:
                raise ConflictError(f"This order already has an active shipment ({active.shipment_number}).",
                                    error_code="SHIPMENT_EXISTS", details={"shipmentId": active.id}) from None
            if awb and db.execute(select(Shipment.id).where(Shipment.provider_id == row.id,
                                                            Shipment.awb == awb)).first():
                raise ConflictError("That AWB is already used by another shipment.",
                                    error_code="AWB_EXISTS") from None
            if attempt == 3:
                logger.warning("Shipment for order %s could not be recorded: %s", order.id, type(error).__name__)
                raise ConflictError("The shipment couldn't be recorded just now. Please try again.",
                                    error_code="SHIPMENT_BUSY") from None

    attempt_create(db, shipment, adapter=adapter, actor=getattr(admin, "id", "") or "system")
    return shipment, True


def _lines(db: Session, order: Order) -> List[ShipmentLine]:
    from app.models import Invoice, InvoiceItem

    hsn: Dict[str, str] = {}
    invoice = db.execute(select(Invoice).where(Invoice.order_id == order.id)).scalars().first()
    if invoice is not None:
        for item in db.execute(select(InvoiceItem).where(InvoiceItem.invoice_id == invoice.id)).scalars():
            hsn.setdefault(item.product_id, item.hsn or "")
    return [ShipmentLine(name=item.name, sku=item.sku or "", quantity=item.quantity,
                         unit_price=billing.to_minor(item.unit_price or 0), hsn=hsn.get(item.product_id, ""))
            for item in order.items]


def _request(db: Session, shipment: Shipment, order: Order) -> CreateRequest:
    dest = dict(shipment.destination or {})
    origin = dict(shipment.origin or {})
    return CreateRequest(
        reference=shipment.shipment_number, order_number=order.order_number, order_date=order.placed_at,
        origin=Address(**{k: str(origin.get(k) or "") for k in ("name", "phone", "line1", "line2", "city", "state",
                                                                 "pincode")}),
        destination=Address(name=str(dest.get("name") or ""), phone=str(dest.get("phone") or ""),
                            email=order.customer_email or "", line1=str(dest.get("line1") or ""),
                            line2=str(dest.get("line2") or ""), city=str(dest.get("city") or ""),
                            state=str(dest.get("state") or ""), pincode=str(dest.get("pincode") or ""),
                            country=str(dest.get("country") or "India")),
        package=PackageInfo(weight_grams=shipment.weight_grams or 0,
                            length_cm=float(shipment.length_cm) if shipment.length_cm is not None else None,
                            width_cm=float(shipment.width_cm) if shipment.width_cm is not None else None,
                            height_cm=float(shipment.height_cm) if shipment.height_cm is not None else None,
                            count=shipment.package_count, type=shipment.package_type),
        lines=_lines(db, order), declared_value=shipment.declared_value, cod=shipment.cod,
        cod_amount=shipment.cod_amount, service=shipment.service, courier_code=shipment.courier_code,
        provider_order_id=shipment.provider_order_id or "", provider_shipment_id=shipment.provider_shipment_id or "",
        awb=shipment.awb or "", courier_name=shipment.courier_name,
        # An earlier attempt may have created the courier order before timing out.
        lookup_existing=bool(shipment.retry_count and not shipment.provider_shipment_id),
    )


def attempt_create(db: Session, shipment: Shipment, *, adapter=None, actor: str = "system") -> Shipment:
    """Book a recorded shipment with the courier, continuing from whatever an earlier attempt achieved."""
    order = db.get(Order, shipment.order_id)
    adapter = adapter or _adapter(shipment)
    shipment.last_operation = "create"
    request = _request(db, shipment, order)
    try:
        result = adapter.create_shipment(request)
    except ProviderError as error:
        partial = error.partial
        if partial is not None:
            shipment.provider_order_id = partial.provider_order_id or shipment.provider_order_id
            shipment.provider_shipment_id = partial.provider_shipment_id or shipment.provider_shipment_id
        _failed(db, shipment, "create", error)
        db.commit()
        return shipment

    shipment.provider_order_id = result.provider_order_id or shipment.provider_order_id
    shipment.provider_shipment_id = result.provider_shipment_id or shipment.provider_shipment_id
    shipment.awb = result.awb or shipment.awb
    shipment.courier_name = (result.courier_name or shipment.courier_name or "")[:120]
    shipment.courier_code = (result.courier_code or shipment.courier_code or "")[:40]
    if result.expected_delivery_at:
        shipment.expected_delivery_at = result.expected_delivery_at
    if result.label_url:
        shipment.label_url = result.label_url[:1000]
    _succeeded(shipment)
    courier = shipment.courier_name or "the courier"
    _event(db, shipment, status="ready-for-pickup", description=f"Booked with {courier}. Tracking number {shipment.awb}.",
           source="system", key=f"awb:{shipment.awb}"[:80])
    moved = _move(db, shipment, "ready-for-pickup", when=_now(), key=f"awb:{shipment.awb}")
    shipment.next_sync_at = next_sync_at(shipment)
    try:
        _finish(db, shipment, order, moved, actor=actor)
    except IntegrityError:
        # The courier handed out an AWB another shipment already has.
        db.rollback()
        shipment = db.get(Shipment, shipment.id)
        _failed(db, shipment, "create",
                ProviderError("The courier returned an AWB that another shipment already uses.", transient=False))
        db.commit()
    return shipment


# ------------------------------------------------------- applying updates


def _move(db: Session, shipment: Shipment, new: str, *, when: datetime, key: str = "") -> List[tuple]:
    """
    Move the shipment if the rules allow. Returns the follow-ups to send once
    it is saved: [(notification event, idempotency suffix)].
    """
    from app.services.messaging.catalogue import SHIPMENT_EVENTS

    if not can_move(shipment.status, new):
        return []
    shipment.status = new
    shipment.updated_at = _now()
    if new == "delivered":
        shipment.delivered_at = when
    if new == "cancelled":
        shipment.active_key = None
        shipment.cancelled_at = shipment.cancelled_at or _now()
    follow = []
    event = SHIPMENT_EVENTS.get(new)
    if event:
        follow.append((event, key if new == "delivery-attempted" else ""))
    number = shipment.shipment_number
    if new == "delivery-failed":
        _alert(db, shipment, "delivery-failed", f"Delivery failed for {number}",
               "The courier couldn't deliver this parcel. Decide whether to re-ship or record a return.")
    if new == "returned-to-origin":
        _alert(db, shipment, "returned", f"Shipment {number} is returning to origin",
               "The parcel is on its way back. Re-ship it or record a return on the order.")
    return follow


def apply_events(db: Session, shipment: Shipment, events: List[TrackingEvent], *, source: str, actor: str = "",
                 current_status: str = "", provider_status: str = "") -> List[tuple]:
    """
    Record the courier's events (each once) and move the shipment through
    them in time order. Returns the follow-up notifications.
    """
    now = _now()
    existing = {row.dedupe_key: row for row in db.execute(
        select(ShipmentEvent).where(ShipmentEvent.shipment_id == shipment.id)).scalars()}
    status_times = [row.occurred_at for row in existing.values() if row.status]
    latest = max(status_times) if status_times else None
    follow: List[tuple] = []
    for event in sorted(events, key=lambda e: e.occurred_at):
        key = dedupe_key(event)
        if key in existing:
            continue
        row = ShipmentEvent(shipment_id=shipment.id, status=event.status if event.status in STATUSES else "",
                            provider_status=(event.provider_status or "")[:120],
                            description=(event.description or event.provider_status or "")[:500],
                            location=(event.location or "")[:160], occurred_at=event.occurred_at, received_at=now,
                            source=source, actor=(actor or "")[:40], visible=True, dedupe_key=key)
        db.add(row)
        existing[key] = row
        if not row.status:
            continue
        # A scan older than the latest status we already know must not pull the
        # shipment back off a delivery attempt.
        if latest is not None and event.occurred_at < latest and shipment.status == "delivery-attempted":
            continue
        moved = _move(db, shipment, row.status, when=event.occurred_at, key=key)
        if moved or row.status == shipment.status:
            latest = max(latest, event.occurred_at) if latest else event.occurred_at
        follow += moved
    if current_status and can_move(shipment.status, current_status):
        key = f"current:{current_status}"
        if key not in existing:
            _event(db, shipment, status=current_status, provider_status=provider_status,
                   description=provider_status or STATUS_LABELS.get(current_status, ""), source=source, actor=actor,
                   key=key)
            follow += _move(db, shipment, current_status, when=now, key=key)
    return follow


def _order_target(db: Session, shipment: Shipment) -> Optional[str]:
    """The furthest order status this shipment's history implies."""
    from app.services.orders import ORDER_FLOW

    seen = set(db.execute(select(ShipmentEvent.status).where(ShipmentEvent.shipment_id == shipment.id,
                                                             ShipmentEvent.status != "")).scalars())
    seen.add(shipment.status)
    targets = [ORDER_MOVE[s] for s in seen if s in ORDER_MOVE]
    if not targets or shipment.status == "cancelled":
        return None
    return max(targets, key=ORDER_FLOW.index)


def _finish(db: Session, shipment: Shipment, order: Optional[Order], follow: List[tuple], *, actor: str) -> None:
    """Keep the order in step, send what's due, save, and move the order forward if the shipment implies it."""
    from app.services.email import notifications

    if order is not None:
        if shipment.status != "cancelled" and shipment.awb and order.tracking_number != shipment.awb:
            order.tracking_number = shipment.awb[:60]
        if shipment.status != "cancelled" and shipment.expected_delivery_at:
            label = _label_date(shipment.expected_delivery_at)
            if order.expected_delivery != label:
                order.expected_delivery = label
        for event, suffix in follow:
            try:
                notifications.notify_shipment(db, shipment, order, event, suffix=suffix)
            except Exception:  # a notification must never undo a courier update
                logger.exception("Could not send %s for shipment %s", event, shipment.id)
    db.commit()
    if order is not None:
        move_order(db, shipment, order, actor=actor)


def move_order(db: Session, shipment: Shipment, order: Order, *, actor: str) -> None:
    """Forward only, never from a terminal state. A refusal is recorded on the shipment, not raised."""
    from app.services import orders

    target = _order_target(db, shipment)
    if not target:
        return
    db.refresh(order)
    current = order.status
    if current not in orders.ORDER_FLOW or current == "delivered":
        return
    if orders.ORDER_FLOW.index(target) <= orders.ORDER_FLOW.index(current):
        return
    try:
        orders.update_status(db, order.id, target, actor=actor or "courier", confirm=True,
                             note=f"Courier update for shipment {shipment.shipment_number}.")
    except (ConflictError, ValidationError) as error:
        db.rollback()
        key = f"order-move:{current}:{target}"[:80]
        seen = db.execute(select(ShipmentEvent.id).where(ShipmentEvent.shipment_id == shipment.id,
                                                         ShipmentEvent.dedupe_key == key)).first()
        if not seen:
            _event(db, shipment, status="", source="system", visible=False, key=key,
                   description=f"The order wasn't moved to {target}: {error.message}")
            db.commit()


def apply_tracking(db: Session, shipment: Shipment, result, *, source: str) -> Shipment:
    """A TrackingResult (poll) or WebhookEvent: events, status, dates, sync times; then the order."""
    now = _now()
    follow = apply_events(db, shipment, list(result.events or []), source=source, actor="",
                          current_status=getattr(result, "status", "") or "",
                          provider_status=getattr(result, "provider_status", "") or "")
    expected = getattr(result, "expected_delivery_at", None)
    if expected and shipment.status not in TERMINAL:
        shipment.expected_delivery_at = expected
    delivered = getattr(result, "delivered_at", None)
    if delivered and shipment.status == "delivered":
        shipment.delivered_at = delivered
    if source == "webhook":
        shipment.last_webhook_at = now
    else:
        shipment.last_synced_at = now
    shipment.next_sync_at = next_sync_at(shipment, now)
    _finish(db, shipment, db.get(Order, shipment.order_id), follow, actor="courier")
    return shipment


# -------------------------------------------------------------- operations


def _require(supports: dict, what: str, name: str) -> None:
    if not supports.get(what):
        raise UnsupportedOperation(f"{name} can't do that.")


def _do_label(db: Session, shipment: Shipment) -> Optional[ProviderError]:
    adapter = _adapter(shipment)
    shipment.last_operation = "label"
    try:
        result = adapter.generate_label(provider_shipment_id=shipment.provider_shipment_id or "",
                                        awb=shipment.awb or "")
    except ProviderError as error:
        _failed(db, shipment, "label", error)
        db.commit()
        return error
    shipment.label_url = result.url[:1000]
    _succeeded(shipment)
    _event(db, shipment, status="", description="Label generated.", source="system", visible=False)
    db.commit()
    return None


def label(db: Session, shipment_id, *, admin) -> Shipment:
    shipment = get(db, shipment_id, lock=True)
    adapter = _adapter(shipment)
    _require(adapter.supports(), "label", adapter.name)
    if not shipment.awb or not shipment.provider_shipment_id or shipment.status not in ("ready-for-pickup",
                                                                                         "pickup-scheduled"):
        raise ConflictError("A label can be made once the courier has assigned the AWB, before pickup.",
                            error_code="LABEL_NOT_READY")
    if shipment.label_url:
        db.commit()
        return shipment
    audit.record(db, "shipment.label", resource_type="shipment", resource_id=shipment.shipment_number, actor=admin,
                 summary=f"Label requested for {shipment.shipment_number}")
    error = _do_label(db, shipment)
    if error is not None:
        _raise_for(error)
    return shipment


def _do_pickup(db: Session, shipment: Shipment) -> Optional[ProviderError]:
    adapter = _adapter(shipment)
    shipment.last_operation = "pickup"
    try:
        result = adapter.schedule_pickup(provider_shipment_id=shipment.provider_shipment_id or "",
                                         awb=shipment.awb or "")
    except ProviderError as error:
        shipment.pickup_status = "failed"
        _failed(db, shipment, "pickup", error)
        db.commit()
        return error
    shipment.pickup_status = "scheduled"
    shipment.pickup_scheduled_at = result.scheduled_at
    shipment.pickup_token = (result.token or "")[:64]
    _succeeded(shipment)
    when = f" for {result.scheduled_at:%d %b %Y}" if result.scheduled_at else ""
    _event(db, shipment, status="pickup-scheduled", description=f"Pickup scheduled{when}.", source="system",
           key=f"pickup:{shipment.pickup_token or secrets.token_hex(6)}")
    follow = _move(db, shipment, "pickup-scheduled", when=_now())
    _finish(db, shipment, db.get(Order, shipment.order_id), follow, actor="courier")
    return None


def pickup(db: Session, shipment_id, *, admin) -> Shipment:
    shipment = get(db, shipment_id, lock=True)
    adapter = _adapter(shipment)
    _require(adapter.supports(), "pickup", adapter.name)
    if shipment.status != "ready-for-pickup" or not shipment.awb or not shipment.provider_shipment_id:
        raise ConflictError("A pickup can be scheduled once the AWB is assigned and before it's picked up.",
                            error_code="PICKUP_NOT_ALLOWED")
    audit.record(db, "shipment.pickup", resource_type="shipment", resource_id=shipment.shipment_number, actor=admin,
                 summary=f"Pickup requested for {shipment.shipment_number}")
    error = _do_pickup(db, shipment)
    if error is not None:
        _raise_for(error)
    return shipment


def _do_cancel(db: Session, shipment: Shipment, *, reason: str, actor: str) -> Optional[ProviderError]:
    adapter = _adapter(shipment)
    shipment.last_operation = "cancel"
    shipment.cancel_reason = (reason or shipment.cancel_reason or "")[:300]
    if shipment.provider_order_id and adapter.supports().get("cancel"):
        try:
            adapter.cancel_shipment(provider_order_id=shipment.provider_order_id or "",
                                    provider_shipment_id=shipment.provider_shipment_id or "", awb=shipment.awb or "")
        except ProviderError as error:
            _failed(db, shipment, "cancel", error)
            db.commit()
            return error
        except Unsupported:
            pass
    _succeeded(shipment)
    shipment.status = "cancelled"
    shipment.active_key = None
    shipment.cancelled_at = _now()
    shipment.next_sync_at = None
    _event(db, shipment, status="cancelled", description="Shipment cancelled.", source="admin", actor=actor,
           key="cancelled")
    order = db.get(Order, shipment.order_id)
    if order is not None and shipment.awb and order.tracking_number == shipment.awb:
        order.tracking_number = None
    db.commit()
    return None


def cancel(db: Session, shipment_id, *, admin, reason: str) -> Shipment:
    shipment = get(db, shipment_id, lock=True)
    if shipment.status not in BEFORE_PICKUP:
        raise ConflictError("This shipment has been picked up and can't be cancelled. Record a return instead.",
                            error_code="SHIPMENT_NOT_CANCELLABLE")
    reason = (reason or "").strip()[:300] or "Cancelled by the team."
    audit.record(db, "shipment.cancel", resource_type="shipment", resource_id=shipment.shipment_number, actor=admin,
                 summary=f"Cancelled {shipment.shipment_number}: {reason}",
                 changes=audit.diff({"status": shipment.status}, {"status": "cancelled"}))
    error = _do_cancel(db, shipment, reason=reason, actor=admin.id)
    if error is not None:
        _raise_for(error)
    return shipment


def retry(db: Session, shipment_id, *, admin=None, automatic: bool = False) -> Shipment:
    """Retry the last failed courier operation, continuing from what is already known."""
    shipment = get(db, shipment_id, lock=True)
    if shipment.request_status != "failed":
        raise ConflictError("Nothing has failed on this shipment.", error_code="NOTHING_TO_RETRY")
    if automatic and (not shipment.last_error_transient or shipment.retry_count >= MAX_ATTEMPTS):
        db.commit()
        return shipment
    operation = shipment.last_operation
    if admin is not None:
        audit.record(db, "shipment.retry", resource_type="shipment", resource_id=shipment.shipment_number,
                     actor=admin, summary=f"Retried {operation} for {shipment.shipment_number}")
    if operation == "create":
        if shipment.status != "pending":
            _succeeded(shipment)
            db.commit()
            return shipment
        return attempt_create(db, shipment, actor=getattr(admin, "id", "") or "system")
    if operation == "label":
        _do_label(db, shipment)
    elif operation == "pickup":
        _do_pickup(db, shipment)
    elif operation == "cancel":
        _do_cancel(db, shipment, reason=shipment.cancel_reason, actor=getattr(admin, "id", "") or "system")
    else:
        raise ConflictError("Nothing has failed on this shipment.", error_code="NOTHING_TO_RETRY")
    return shipment


def refresh(db: Session, shipment_id, *, admin=None, automatic: bool = False) -> Shipment:
    """Pull tracking now. Rate-limited per shipment when a person asks."""
    shipment = get(db, shipment_id)
    adapter = _adapter(shipment)
    if not adapter.supports().get("tracking"):
        raise UnsupportedOperation(f"{adapter.name} has no tracking to pull; record updates by hand.")
    if not shipment.awb:
        raise ConflictError("This shipment has no AWB to track yet.", error_code="NO_AWB")
    if shipment.status in TERMINAL:
        raise ConflictError("This shipment is closed.", error_code="SHIPMENT_CLOSED")
    if not automatic:
        rate_limit.check(f"shipment-refresh:{shipment.id}", limit=REFRESH_LIMIT[0], window_seconds=REFRESH_LIMIT[1],
                         message="Tracking was just refreshed. Please wait a minute.")
    try:
        result = adapter.track(awb=shipment.awb, provider_shipment_id=shipment.provider_shipment_id or "")
    except ProviderError as error:
        now = _now()
        shipment.next_sync_at = now + (timedelta(minutes=30) if error.transient else timedelta(hours=6))
        db.commit()
        if automatic:
            raise
        _raise_for(error)
    return apply_tracking(db, shipment, result, source="poll")


def update_package(db: Session, shipment_id, payload, *, admin) -> Shipment:
    shipment = get(db, shipment_id, lock=True)
    if shipment.status != "pending":
        raise ConflictError("The package can be changed only before the courier confirms the shipment.",
                            error_code="SHIPMENT_NOT_EDITABLE")
    adapter = _adapter(shipment)
    package = clean_package(payload, require_dimensions=not adapter.manual_awb)
    before = package_view(shipment)
    shipment.weight_grams = package.weight_grams
    shipment.length_cm = package.length_cm
    shipment.width_cm = package.width_cm
    shipment.height_cm = package.height_cm
    shipment.package_count = package.count
    shipment.package_type = package.type
    audit.record(db, "shipment.package", resource_type="shipment", resource_id=shipment.shipment_number, actor=admin,
                 summary=f"Package changed on {shipment.shipment_number}",
                 changes=audit.diff(before, package_view(package)))
    db.commit()
    return shipment


def _parse_when(value) -> Optional[datetime]:
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise ValidationError("occurredAt must be a date and time.", error_code="INVALID_DATE")
    text = value.strip().replace("Z", "")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        raise ValidationError("occurredAt must be a date and time.", error_code="INVALID_DATE") from None
    if parsed.tzinfo is not None:
        parsed = parsed.replace(tzinfo=None)
    return parsed.replace(microsecond=0)


def add_event(db: Session, shipment_id, payload: dict, *, admin) -> Shipment:
    """A tracking update entered by the team. It moves the shipment and order like a courier event."""
    shipment = get(db, shipment_id, lock=True)
    status = payload.get("status") if isinstance(payload.get("status"), str) else ""
    if status not in STATUSES or status in ("pending", "cancelled"):
        raise ValidationError("Choose a tracking status (cancel the shipment to cancel it).",
                              error_code="INVALID_STATUS")
    if shipment.status in TERMINAL:
        raise ConflictError(f"This shipment is {STATUS_LABELS[shipment.status].lower()}; it can't move any more.",
                            error_code="SHIPMENT_CLOSED")
    if status != shipment.status and not can_move(shipment.status, status):
        raise ConflictError(f"A shipment can't go from {STATUS_LABELS[shipment.status]} to {STATUS_LABELS[status]}.",
                            error_code="INVALID_SHIPMENT_TRANSITION")
    if not shipment.awb:
        raise ConflictError("Record the AWB first.", error_code="AWB_REQUIRED")
    when = _parse_when(payload.get("occurredAt")) or _now()
    if when > datetime.utcnow() + timedelta(minutes=5):
        raise ValidationError("occurredAt can't be in the future.", error_code="INVALID_DATE")
    description = _clean_text(payload.get("description"), 500) or STATUS_LABELS[status]
    location = _clean_text(payload.get("location"), 160)
    visible = payload.get("visible")
    visible = True if visible is None else bool(visible)
    key = f"admin:{secrets.token_hex(16)}"
    _event(db, shipment, status=status, description=description, location=location, source="admin",
           actor=admin.id, visible=visible, occurred_at=when, key=key)
    follow = _move(db, shipment, status, when=when, key=key)
    shipment.next_sync_at = next_sync_at(shipment)
    audit.record(db, "shipment.event", resource_type="shipment", resource_id=shipment.shipment_number, actor=admin,
                 summary=f"Tracking update on {shipment.shipment_number}: {STATUS_LABELS[status]}")
    _finish(db, shipment, db.get(Order, shipment.order_id), follow, actor=admin.id)
    return shipment
