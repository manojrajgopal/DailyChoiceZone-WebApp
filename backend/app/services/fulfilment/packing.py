"""
Packing: the warehouse's work between "confirmed" and "handed to the courier".
See docs/packing-and-labels.md.

## The rules this module keeps

- **One active job per order** (`active_key`, the order id until the job is
  cancelled). Jobs are made *lazily and idempotently*: whenever the queue, the
  dashboard summary or an order's packing card is read, every order that is
  confirmed, processing or packed and has never had a job gets one. Nothing has
  to hook every path that confirms an order (checkout, a gateway webhook, a
  manual status change), and a job can never be missed.
- **Packing never has its own order status system.** Starting to pick moves
  the order to `processing`, marking the job packed moves it to `packed`, both
  through `orders.update_status` (so the existing "we're preparing your order"
  and "packed" messages go exactly once), and only ever forward.
- **Picking never changes stock**: it was taken at the sale. A problem on the
  shelf is recorded on the line and blocks "picked" until it's cleared or the
  admin overrides it with a reason. Writing off damaged units is a separate,
  explicit action through the stock ledger (reason `damaged`).
- **No silent edits.** Every action writes a `packing_events` row and an audit
  entry. Once packed, packages are locked; changing one means reopening the
  job with a reason.
- A cancelled order cancels its job (`on_order_cancelled`, inside the
  cancellation's own transaction; `sync` catches any that slipped past).
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from app.core import numbering
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import AdminUser, Order, OrderItem
from app.models.fulfilment import PackingEvent, PackingJob, PackingLine, PackingPackage, PackingPackageItem
from app.models.shipping import Shipment
from app.services import audit
from app.services.fulfilment import settings as fulfilment_settings

logger = logging.getLogger(__name__)

STATUSES = ("pending", "picking", "picked", "packing", "packed", "ready-to-ship", "cancelled")
STATUS_LABELS = {
    "pending": "Waiting to pick", "picking": "Picking", "picked": "Picked", "packing": "Packing",
    "packed": "Packed", "ready-to-ship": "Ready to ship", "cancelled": "Cancelled",
}
PRIORITIES = ("normal", "high", "urgent")
EXCEPTIONS = ("missing-stock", "damaged", "wrong-item")
EXCEPTION_LABELS = {"missing-stock": "Missing stock", "damaged": "Damaged", "wrong-item": "Wrong item"}
# Orders that are in the warehouse and so need packing.
PACKABLE_ORDER = ("confirmed", "processing", "packed")
# Orders that have left (or never will): their jobs drop out of the open queue.
GONE = ("shipped", "in-transit", "out-for-delivery", "delivered", "returned", "cancelled")
NOT_PACKED = ("pending", "picking", "picked", "packing")
SYNC_BATCH = 200
PINCODE = re.compile(r"^[1-9][0-9]{5}$")


def _now() -> datetime:
    return datetime.utcnow().replace(microsecond=0)


def _actor_id(admin) -> str:
    return (getattr(admin, "id", "") or "system")[:40]


# ------------------------------------------------------------------ errors


class PackingInvalid(ValidationError):
    error_code = "PACKING_INVALID"


# ------------------------------------------------------------------ reading


def get(db: Session, job_id, *, lock: bool = False) -> PackingJob:
    try:
        key = int(job_id)
    except (TypeError, ValueError):
        raise NotFoundError("No such packing job.", error_code="PACKING_NOT_FOUND") from None
    statement = select(PackingJob).where(PackingJob.id == key)
    if lock:
        statement = statement.with_for_update()
    job = db.execute(statement).scalar_one_or_none()
    if job is None:
        raise NotFoundError("No such packing job.", error_code="PACKING_NOT_FOUND")
    return job


def _order(db: Session, job: PackingJob) -> Order:
    return db.get(Order, job.order_id)


def _active_for(db: Session, order_id: str) -> Optional[PackingJob]:
    return db.execute(select(PackingJob).where(PackingJob.active_key == order_id)).scalar_one_or_none()


def _items(db: Session, job: PackingJob) -> Dict[int, OrderItem]:
    ids = [line.order_item_id for line in job.lines]
    if not ids:
        return {}
    return {item.id: item for item in db.execute(select(OrderItem).where(OrderItem.id.in_(ids))).scalars()}


def _active_packages(job: PackingJob) -> List[PackingPackage]:
    return [p for p in job.packages if p.removed_at is None]


def _allocated(job: PackingJob) -> Dict[int, int]:
    out: Dict[int, int] = {}
    for package in _active_packages(job):
        for item in package.items:
            out[item.line_id] = out.get(item.line_id, 0) + item.quantity
    return out


# ------------------------------------------------------------------ events


def _event(db: Session, job: PackingJob, action: str, *, admin=None, from_status: str = "", to_status: str = "",
           note: str = "", details: Optional[dict] = None) -> PackingEvent:
    row = PackingEvent(job_id=job.id, action=action[:30], from_status=from_status, to_status=to_status,
                       note=(note or "")[:500], details=details or {}, actor=_actor_id(admin), occurred_at=_now())
    db.add(row)
    return row


def _audit(db: Session, job: PackingJob, action: str, admin, summary: str, changes: Optional[dict] = None) -> None:
    order = _order(db, job)
    number = order.order_number if order is not None else job.order_id
    audit.record(db, f"packing.{action}", resource_type="packing", resource_id=str(job.id), actor=admin,
                 summary=f"{summary} (order {number})"[:500], changes=changes or None,
                 system=admin is None)


def _set_status(db: Session, job: PackingJob, status: str, action: str, *, admin=None, note: str = "",
                details: Optional[dict] = None) -> None:
    before = job.status
    job.status = status
    job.updated_at = _now()
    _event(db, job, action, admin=admin, from_status=before, to_status=status, note=note, details=details)


# ------------------------------------------------------------- making jobs


def _new_job(db: Session, order: Order) -> PackingJob:
    now = _now()
    job = PackingJob(order_id=order.id, active_key=order.id, status="pending",
                     priority="high" if order.delivery_method == "express" else "normal",
                     created_at=now, updated_at=now)
    job.lines = [PackingLine(order_item_id=item.id, quantity=item.quantity, picked_qty=0)
                 for item in sorted(order.items, key=lambda i: i.id)]
    db.add(job)
    db.flush()
    _event(db, job, "created", to_status="pending",
           note="Express delivery: high priority." if job.priority == "high" else "")
    return job


def _create_safely(db: Session, order: Order) -> Optional[PackingJob]:
    """Make the job inside a savepoint, so a racing request that made it first is harmless."""
    try:
        with db.begin_nested():
            return _new_job(db, order)
    except IntegrityError:
        return _active_for(db, order.id)


def sync(db: Session, *, limit: int = SYNC_BATCH) -> dict:
    """
    Make the jobs that are missing and cancel the ones whose order was
    cancelled. Idempotent; commits only when something changed.
    """
    has_job = select(PackingJob.id).where(PackingJob.order_id == Order.id).exists()
    missing = list(db.execute(
        select(Order).where(Order.status.in_(PACKABLE_ORDER), ~has_job).order_by(Order.placed_at).limit(limit)
    ).scalars())
    created = 0
    for order in missing:
        if _create_safely(db, order) is not None:
            created += 1
    stale = list(db.execute(
        select(PackingJob).join(Order, Order.id == PackingJob.order_id)
        .where(PackingJob.active_key.is_not(None), Order.status.in_(("cancelled", "returned")))
        .limit(limit)
    ).scalars())
    for job in stale:
        _cancel(db, job, note="The order was cancelled.")
    if created or stale:
        db.commit()
    return {"created": created, "cancelled": len(stale)}


def for_order(db: Session, order_id: str) -> Optional[PackingJob]:
    """The order's job (the active one, else the latest), made now if the order needs one."""
    from app.services import orders

    order = orders.get_order(db, order_id)
    job = _active_for(db, order.id)
    if job is None:
        job = db.execute(select(PackingJob).where(PackingJob.order_id == order.id)
                         .order_by(PackingJob.id.desc())).scalars().first()
    if job is None and order.status in PACKABLE_ORDER:
        job = _create_safely(db, order)
        db.commit()
    elif job is not None and job.active_key and order.status in ("cancelled", "returned"):
        _cancel(db, job, note="The order was cancelled.")
        db.commit()
    return job


def _cancel(db: Session, job: PackingJob, *, note: str) -> None:
    if job.status == "cancelled":
        return
    job.active_key = None
    job.cancelled_at = _now()
    _set_status(db, job, "cancelled", "cancelled", note=note)
    _audit(db, job, "cancel", None, "Packing cancelled")


def on_order_cancelled(db: Session, order: Order) -> None:
    """Called by `orders.update_status` inside the cancellation. Never commits."""
    job = _active_for(db, order.id)
    if job is not None:
        _cancel(db, job, note="The order was cancelled.")


# ------------------------------------------------------------------ guards


def _require(job: PackingJob, allowed, message: str) -> None:
    if job.status not in allowed:
        raise ConflictError(message, error_code="INVALID_PACKING_TRANSITION",
                            details={"status": job.status})


def _require_live_order(db: Session, job: PackingJob) -> Order:
    order = _order(db, job)
    if job.status == "cancelled" or order is None or order.status in ("cancelled", "returned"):
        raise ConflictError("This order has been cancelled; it mustn't be packed.", error_code="ORDER_CANCELLED")
    return order


def _line(job: PackingJob, line_id) -> PackingLine:
    try:
        key = int(line_id)
    except (TypeError, ValueError):
        key = None
    line = next((line for line in job.lines if line.id == key), None)
    if line is None:
        raise NotFoundError("That line isn't on this order.", error_code="LINE_NOT_FOUND")
    return line


def _whole(raw, field: str, low: int, high: int) -> int:
    if isinstance(raw, bool) or raw is None or raw == "":
        raise ValidationError(f"{field} must be a whole number.", error_code="INVALID_QUANTITY",
                              details={"field": field})
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise ValidationError(f"{field} must be a whole number.", error_code="INVALID_QUANTITY",
                              details={"field": field}) from None
    if value != value or not value.is_integer() or not low <= value <= high:
        raise ValidationError(f"{field} must be a whole number from {low} to {high}.", error_code="INVALID_QUANTITY",
                              details={"field": field})
    return int(value)


def _reason(raw, *, field: str = "reason", required: bool = True) -> str:
    text = raw.strip()[:300] if isinstance(raw, str) else ""
    if required and len(text) < 3:
        raise ValidationError("Give a short reason (at least 3 characters).", error_code="REASON_REQUIRED",
                              details={"field": field})
    return text


def _move_order(db: Session, order: Order, target: str, *, admin, note: str) -> None:
    """Forward only. `update_status` commits the job's changes with the order's."""
    from app.services import orders

    current = order.status
    if current not in orders.ORDER_FLOW or orders.ORDER_FLOW.index(target) <= orders.ORDER_FLOW.index(current):
        db.commit()
        return
    orders.update_status(db, order.id, target, actor=_actor_id(admin), confirm=True, note=note)


# ----------------------------------------------------------- assign, priority


def assignable_staff(db: Session) -> List[dict]:
    from app.core.permissions import permissions_for

    out = []
    for admin in db.execute(select(AdminUser).where(AdminUser.status == "active").order_by(AdminUser.name)).scalars():
        if admin.role == "super-admin" or "packing" in (admin.permissions or []) or \
                "packing" in permissions_for(admin.role):
            out.append({"id": admin.id, "name": admin.name, "role": admin.role})
    return out


def assign(db: Session, job_id, admin_id, *, admin) -> PackingJob:
    job = get(db, job_id, lock=True)
    _require(job, NOT_PACKED + ("packed",), "This job is finished; there's nothing to assign.")
    before = job.assigned_to
    target = None
    if admin_id not in (None, ""):
        if not isinstance(admin_id, str) or not any(s["id"] == admin_id for s in assignable_staff(db)):
            raise ValidationError("Choose an active team member who can pack.", error_code="INVALID_ASSIGNEE",
                                  details={"field": "adminId"})
        target = admin_id
    if target == before:
        db.commit()
        return job
    job.assigned_to = target
    job.assigned_at = _now() if target else None
    name = db.get(AdminUser, target).name if target else ""
    _event(db, job, "assigned" if target else "unassigned", admin=admin, from_status=job.status,
           to_status=job.status, note=f"Assigned to {name}." if target else "Unassigned.",
           details={"from": before or "", "to": target or ""})
    _audit(db, job, "assign", admin, f"Packing assigned to {name}" if target else "Packing unassigned",
           audit.diff({"assignedTo": before}, {"assignedTo": target}))
    db.commit()
    return job


def set_priority(db: Session, job_id, priority, *, admin) -> PackingJob:
    job = get(db, job_id, lock=True)
    if priority not in PRIORITIES:
        raise ValidationError("Priority must be normal, high or urgent.", error_code="INVALID_PRIORITY",
                              details={"field": "priority"})
    _require(job, NOT_PACKED + ("packed",), "This job is finished.")
    if job.priority == priority:
        db.commit()
        return job
    before = job.priority
    job.priority = priority
    _event(db, job, "priority", admin=admin, from_status=job.status, to_status=job.status,
           note=f"Priority {before} to {priority}.", details={"from": before, "to": priority})
    _audit(db, job, "priority", admin, f"Packing priority set to {priority}",
           audit.diff({"priority": before}, {"priority": priority}))
    db.commit()
    return job


# ------------------------------------------------------------------ picking


def start_picking(db: Session, job_id, *, admin) -> PackingJob:
    job = get(db, job_id, lock=True)
    order = _require_live_order(db, job)
    _require(job, ("pending",), "Picking has already started.")
    _begin_picking(db, job, order, admin=admin)
    _move_order(db, order, "processing", admin=admin, note="Picking started.")
    return job


def _begin_picking(db: Session, job: PackingJob, order: Order, *, admin) -> None:
    if order.status == "pending":
        raise ConflictError("This order is waiting for its payment.", error_code="AWAITING_PAYMENT")
    job.picking_started_at = _now()
    if not job.assigned_to and isinstance(admin, AdminUser):
        job.assigned_to = admin.id
        job.assigned_at = job.picking_started_at
    _set_status(db, job, "picking", "picking-started", admin=admin)
    _audit(db, job, "start-picking", admin, "Picking started")


def _auto_start(db: Session, job: PackingJob, *, admin) -> Optional[Order]:
    """Picking a line on a job nobody started starts it. Returns the order when it needs moving."""
    order = _require_live_order(db, job)
    if job.status == "pending":
        _begin_picking(db, job, order, admin=admin)
        return order
    _require(job, ("picking",), "Lines can be picked while the job is being picked. Reopen picking first.")
    return None


def pick_line(db: Session, job_id, line_id, quantity, *, admin) -> PackingJob:
    """Set how many of a line have been picked (0 to the ordered quantity): full or partial."""
    job = get(db, job_id, lock=True)
    to_move = _auto_start(db, job, admin=admin)
    line = _line(job, line_id)
    picked = _whole(quantity, "quantity", 0, line.quantity)
    before = line.picked_qty
    if picked != before:
        line.picked_qty = picked
        line.picked_by = _actor_id(admin)
        line.picked_at = _now()
        _event(db, job, "picked-line", admin=admin, from_status=job.status, to_status=job.status,
               note=f"{picked} of {line.quantity} picked.", details={"lineId": line.id, "from": before, "to": picked})
        _audit(db, job, "pick", admin, f"Line {line.id}: {picked} of {line.quantity} picked",
               audit.diff({"pickedQty": before}, {"pickedQty": picked}))
    if to_move is not None:
        _move_order(db, to_move, "processing", admin=admin, note="Picking started.")
    else:
        db.commit()
    return job


def pick_all(db: Session, job_id, *, admin) -> PackingJob:
    job = get(db, job_id, lock=True)
    to_move = _auto_start(db, job, admin=admin)
    now = _now()
    changed = []
    for line in job.lines:
        if line.exception:
            continue  # a line with a problem is left for a person to decide
        if line.picked_qty != line.quantity:
            changed.append(line.id)
            line.picked_qty = line.quantity
            line.picked_by = _actor_id(admin)
            line.picked_at = now
    if changed:
        _event(db, job, "picked-all", admin=admin, from_status=job.status, to_status=job.status,
               note=f"{len(changed)} line(s) marked fully picked.", details={"lineIds": changed})
        _audit(db, job, "pick-all", admin, f"{len(changed)} line(s) marked fully picked")
    if to_move is not None:
        _move_order(db, to_move, "processing", admin=admin, note="Picking started.")
    else:
        db.commit()
    return job


def record_exception(db: Session, job_id, line_id, payload: dict, *, admin) -> PackingJob:
    job = get(db, job_id, lock=True)
    to_move = _auto_start(db, job, admin=admin)
    line = _line(job, line_id)
    kind = payload.get("type")
    if kind not in EXCEPTIONS:
        raise ValidationError("Choose what's wrong: missing stock, damaged or wrong item.",
                              error_code="INVALID_EXCEPTION", details={"field": "type"})
    quantity = _whole(payload.get("quantity", 1), "quantity", 1, line.quantity)
    note = _reason(payload.get("note"), field="note")
    before = {"exception": line.exception, "exceptionQty": line.exception_qty}
    line.exception, line.exception_qty, line.exception_note = kind, quantity, note
    line.exception_by, line.exception_at = _actor_id(admin), _now()
    _event(db, job, "exception", admin=admin, from_status=job.status, to_status=job.status,
           note=f"{EXCEPTION_LABELS[kind]} x {quantity}: {note}",
           details={"lineId": line.id, "type": kind, "quantity": quantity})
    _audit(db, job, "exception", admin, f"Line {line.id}: {EXCEPTION_LABELS[kind]} x {quantity}",
           audit.diff(before, {"exception": kind, "exceptionQty": quantity}))
    if to_move is not None:
        _move_order(db, to_move, "processing", admin=admin, note="Picking started.")
    else:
        db.commit()
    return job


def clear_exception(db: Session, job_id, line_id, *, admin, note: str = "") -> PackingJob:
    job = get(db, job_id, lock=True)
    _require_live_order(db, job)
    _require(job, ("picking",), "Problems can be cleared while the job is being picked. Reopen picking first.")
    line = _line(job, line_id)
    if not line.exception:
        db.commit()
        return job
    before = line.exception
    line.exception, line.exception_qty, line.exception_note = "", 0, ""
    line.exception_by, line.exception_at = "", None
    _event(db, job, "exception-cleared", admin=admin, from_status=job.status, to_status=job.status,
           note=(note or "Problem resolved.")[:500], details={"lineId": line.id, "type": before})
    _audit(db, job, "exception-cleared", admin, f"Line {line.id}: {EXCEPTION_LABELS.get(before, before)} cleared")
    db.commit()
    return job


def record_damaged(db: Session, job_id, line_id, payload: dict, *, admin) -> PackingJob:
    """
    Write damaged units off through the stock ledger (reason `damaged`). An
    explicit action, never a side effect of picking: the units the order needs
    were already taken at the sale; this removes the broken ones from the shelf.
    """
    from app.services import products as product_service

    job = get(db, job_id, lock=True)
    _require_live_order(db, job)
    _require(job, ("picking", "picked", "packing"), "Damaged stock is recorded while the order is being picked.")
    line = _line(job, line_id)
    left = line.quantity - line.damaged_recorded_qty
    if left <= 0:
        raise ConflictError("Every unit of this line has already been written off.", error_code="ALREADY_RECORDED")
    quantity = _whole(payload.get("quantity", 1), "quantity", 1, left)
    note = _reason(payload.get("note"), field="note")
    item = db.get(OrderItem, line.order_item_id)
    product = product_service.lock_products(db, [item.product_id]).get(item.product_id)
    if product is None:
        raise NotFoundError("That product no longer exists.", error_code="PRODUCT_NOT_FOUND")
    order = _order(db, job)
    target = max(0, product.stock - quantity)
    written = product.stock - target
    line.damaged_recorded_qty += quantity
    _event(db, job, "damaged-recorded", admin=admin, from_status=job.status, to_status=job.status,
           note=f"{quantity} damaged unit(s) written off: {note}",
           details={"lineId": line.id, "quantity": quantity, "stockRemoved": written, "productId": product.id})
    _audit(db, job, "damaged-stock", admin, f"{quantity} damaged unit(s) of {product.id} written off")
    product_service.adjust_stock(db, product.id, quantity=target, reason="damaged",
                                 note=f"Damaged at packing, order {order.order_number}: {note}"[:255],
                                 actor=_actor_id(admin))
    return job


def complete_picking(db: Session, job_id, *, admin, override_reason=None) -> PackingJob:
    job = get(db, job_id, lock=True)
    _require_live_order(db, job)
    _require(job, ("picking",), "Only a job being picked can be marked picked.")
    short = [line for line in job.lines if line.picked_qty < line.quantity and not line.exception]
    if short:
        raise PackingInvalid("Some lines aren't fully picked. Pick them, or record what's wrong.",
                             error_code="PICK_INCOMPLETE",
                             details={"lineIds": [line.id for line in short]})
    problems = [line for line in job.lines if line.exception]
    reason = ""
    if problems:
        reason = _reason(override_reason, field="overrideReason", required=False)
        if len(reason) < 3:
            raise ConflictError("Some lines have problems recorded. Clear them, or confirm with a reason.",
                                error_code="PICK_EXCEPTIONS",
                                details={"lineIds": [line.id for line in problems]})
    job.picked_at = _now()
    job.pick_override_reason = reason
    _set_status(db, job, "picked", "picked", admin=admin,
                note=f"Picked despite problems: {reason}" if reason else "",
                details={"override": bool(reason)})
    _audit(db, job, "picked", admin, "Picking completed" + (f" with override: {reason}" if reason else ""))
    db.commit()
    return job


def start_packing(db: Session, job_id, *, admin) -> PackingJob:
    job = get(db, job_id, lock=True)
    _require_live_order(db, job)
    _require(job, ("picked",), "Packing starts once picking is complete.")
    _begin_packing(db, job, admin=admin)
    db.commit()
    return job


def _begin_packing(db: Session, job: PackingJob, *, admin) -> None:
    job.packing_started_at = _now()
    _set_status(db, job, "packing", "packing-started", admin=admin)
    _audit(db, job, "start-packing", admin, "Packing started")


# ----------------------------------------------------------------- packages


def _measure(raw, field: str, low: float, high: float, *, integer: bool = False):
    from app.services.shipping.service import _number

    return _number(raw, field, minimum=low, maximum=high, integer=integer)


def _clean_package(payload: dict) -> dict:
    kind = payload.get("type") or "box"
    if kind not in fulfilment_settings.PACKAGE_TYPES:
        raise ValidationError(f"The package type must be one of: {', '.join(fulfilment_settings.PACKAGE_TYPES)}.",
                              error_code="INVALID_PACKAGE", details={"field": "type"})
    notes = payload.get("notes")
    return {
        "weight_grams": _measure(payload.get("weightGrams"), "weightGrams", 1, 100000, integer=True),
        "length_cm": _measure(payload.get("lengthCm"), "lengthCm", 0.1, 300),
        "width_cm": _measure(payload.get("widthCm"), "widthCm", 0.1, 300),
        "height_cm": _measure(payload.get("heightCm"), "heightCm", 0.1, 300),
        "package_type": kind,
        "notes": notes.strip()[:300] if isinstance(notes, str) else "",
    }


def _clean_items(job: PackingJob, raw, *, exclude: Optional[PackingPackage] = None) -> List[Tuple[PackingLine, int]]:
    """What goes in a package. Nothing named: everything picked that isn't in a package yet."""
    allocated = _allocated(job)
    if exclude is not None:
        for item in exclude.items:
            allocated[item.line_id] = allocated.get(item.line_id, 0) - item.quantity
    if raw in (None, []):
        out = [(line, line.picked_qty - allocated.get(line.id, 0)) for line in job.lines]
        out = [(line, qty) for line, qty in out if qty > 0]
        if not out:
            raise ValidationError("Everything picked is already in a package.", error_code="NOTHING_TO_PACK")
        return out
    if not isinstance(raw, list) or len(raw) > 200:
        raise ValidationError("items must be a list of {lineId, quantity}.", error_code="INVALID_ITEMS",
                              details={"field": "items"})
    seen, out = set(), []
    for entry in raw:
        if not isinstance(entry, dict):
            raise ValidationError("items must be a list of {lineId, quantity}.", error_code="INVALID_ITEMS",
                                  details={"field": "items"})
        line = _line(job, entry.get("lineId"))
        if line.id in seen:
            raise ValidationError("A line is listed twice.", error_code="DUPLICATE_ITEM",
                                  details={"lineId": line.id})
        seen.add(line.id)
        quantity = _whole(entry.get("quantity"), "quantity", 0, max(line.quantity, 0))
        if quantity == 0:
            continue
        free = line.picked_qty - allocated.get(line.id, 0)
        if quantity > free:
            raise ValidationError(f"Only {max(free, 0)} more of that line can go in a package "
                                  f"({line.picked_qty} picked).", error_code="OVER_ALLOCATED",
                                  details={"lineId": line.id, "available": max(free, 0)})
        out.append((line, quantity))
    if not out:
        raise ValidationError("Put at least one item in the package.", error_code="NOTHING_TO_PACK")
    return out


def _editable(db: Session, job: PackingJob) -> None:
    _require_live_order(db, job)
    if job.status in ("packed", "ready-to-ship"):
        raise ConflictError("This order is packed. Reopen packing with a reason to change its packages.",
                            error_code="PACKING_LOCKED")
    _require(job, ("picked", "packing"), "Packages are made once picking is complete.")


def package_snapshot(package: PackingPackage) -> dict:
    def dim(value):
        return float(value) if value is not None else None

    return {"weightGrams": package.weight_grams, "lengthCm": dim(package.length_cm),
            "widthCm": dim(package.width_cm), "heightCm": dim(package.height_cm), "type": package.package_type,
            "notes": package.notes, "items": {str(i.line_id): i.quantity for i in package.items}}


def create_package(db: Session, job_id, payload: dict, *, admin) -> Tuple[PackingJob, PackingPackage]:
    job = get(db, job_id, lock=True)
    _editable(db, job)
    if not isinstance(payload, dict):
        raise ValidationError("Send the package as an object.", error_code="INVALID_PACKAGE")
    fields = _clean_package(payload)
    contents = _clean_items(job, payload.get("items"))
    if job.status == "picked":
        _begin_packing(db, job, admin=admin)
    now = _now()
    package = PackingPackage(job_id=job.id, created_by=_actor_id(admin), created_at=now, updated_at=now, **fields)
    package.items = [PackingPackageItem(line_id=line.id, quantity=qty) for line, qty in contents]
    for attempt in range(4):
        try:
            with db.begin_nested():
                package.package_number = numbering.next_yearly(db, numbering.PACKAGE,
                                                               PackingPackage.package_number, now)
                job.packages.append(package)
                db.flush()
            break
        except (IntegrityError, OperationalError):
            if package in job.packages:
                job.packages.remove(package)
            if attempt == 3:
                raise ConflictError("The package couldn't be numbered just now. Please try again.",
                                    error_code="PACKING_BUSY") from None
    _event(db, job, "package-created", admin=admin, from_status=job.status, to_status=job.status,
           note=f"Package {package.package_number}.", details={"packageId": package.id,
                                                               **package_snapshot(package)})
    _audit(db, job, "package-create", admin, f"Package {package.package_number} created",
           audit.diff({}, package_snapshot(package)))
    db.commit()
    return job, package


def _package(job: PackingJob, package_id) -> PackingPackage:
    try:
        key = int(package_id)
    except (TypeError, ValueError):
        key = None
    package = next((p for p in job.packages if p.id == key and p.removed_at is None), None)
    if package is None:
        raise NotFoundError("No such package on this job.", error_code="PACKAGE_NOT_FOUND")
    return package


def update_package(db: Session, job_id, package_id, payload: dict, *, admin) -> PackingJob:
    job = get(db, job_id, lock=True)
    _editable(db, job)
    package = _package(job, package_id)
    if not isinstance(payload, dict):
        raise ValidationError("Send the package as an object.", error_code="INVALID_PACKAGE")
    before = package_snapshot(package)
    merged = {"weightGrams": before["weightGrams"], "lengthCm": before["lengthCm"], "widthCm": before["widthCm"],
              "heightCm": before["heightCm"], "type": before["type"], "notes": before["notes"]}
    merged.update({k: v for k, v in payload.items() if k in merged})
    fields = _clean_package(merged)
    contents = _clean_items(job, payload["items"], exclude=package) if "items" in payload else None
    for key, value in fields.items():
        setattr(package, key, value)
    if contents is not None:
        package.items.clear()
        db.flush()
        package.items.extend(PackingPackageItem(line_id=line.id, quantity=qty) for line, qty in contents)
    package.updated_at = _now()
    db.flush()
    after = package_snapshot(package)
    changes = audit.diff(before, after)
    if changes:
        _event(db, job, "package-updated", admin=admin, from_status=job.status, to_status=job.status,
               note=f"Package {package.package_number} changed.", details={"packageId": package.id,
                                                                          "changes": changes})
        _audit(db, job, "package-update", admin, f"Package {package.package_number} changed", changes)
    db.commit()
    return job


def remove_package(db: Session, job_id, package_id, *, admin) -> PackingJob:
    job = get(db, job_id, lock=True)
    _editable(db, job)
    package = _package(job, package_id)
    package.removed_at = _now()
    _event(db, job, "package-removed", admin=admin, from_status=job.status, to_status=job.status,
           note=f"Package {package.package_number} removed.",
           details={"packageId": package.id, **package_snapshot(package)})
    _audit(db, job, "package-remove", admin, f"Package {package.package_number} removed",
           audit.diff(package_snapshot(package), {}))
    db.commit()
    return job


# --------------------------------------------------------------- validating


def _address_problems(order: Order) -> List[str]:
    missing = [label for label, value in (("name", order.shipping_name), ("phone", order.shipping_phone),
                                           ("address line", order.shipping_line1), ("city", order.shipping_city),
                                           ("state", order.shipping_state)) if not (value or "").strip()]
    if not PINCODE.match((order.shipping_pincode or "").strip()):
        missing.append("6-digit pincode")
    return missing


def validate(db: Session, job: PackingJob) -> dict:
    """
    What stands between this job and "packed". `errors` can't be overridden;
    `critical` can, with an explicit confirmation and a reason.
    """
    order = _order(db, job)
    errors: List[dict] = []
    critical: List[dict] = []

    def add(bucket, code, message, **details):
        bucket.append({"code": code, "message": message, **({"details": details} if details else {})})

    if job.status == "cancelled" or order is None or order.status in ("cancelled", "returned"):
        add(errors, "ORDER_CANCELLED", "The order has been cancelled.")
        return {"ready": False, "errors": errors, "critical": critical}
    if job.status in ("pending", "picking"):
        add(errors, "PICKING_INCOMPLETE", "Finish picking first.")
    packages = _active_packages(job)
    if not packages:
        add(errors, "NO_PACKAGES", "Add at least one package.")
    allocated = _allocated(job)
    items = _items(db, job)
    for line in job.lines:
        name = items[line.order_item_id].name if line.order_item_id in items else f"Line {line.id}"
        if allocated.get(line.id, 0) != line.picked_qty:
            add(errors, "LINE_NOT_ALLOCATED",
                f"{name}: {allocated.get(line.id, 0)} of {line.picked_qty} picked are in a package.",
                lineId=line.id)
        if line.picked_qty < line.quantity:
            add(critical, "SHORT_PICK", f"{name}: only {line.picked_qty} of {line.quantity} picked.",
                lineId=line.id)
        if line.exception:
            add(critical, "OPEN_EXCEPTION", f"{name}: {EXCEPTION_LABELS[line.exception].lower()} "
                                            f"({line.exception_note}).", lineId=line.id)
    for package in packages:
        if not package.items:
            add(errors, "PACKAGE_EMPTY", f"{package.package_number} is empty.", packageId=package.id)
        if not package.weight_grams:
            add(errors, "PACKAGE_WEIGHT_MISSING", f"Enter the weight of {package.package_number}.",
                packageId=package.id)
        if any(v is None for v in (package.length_cm, package.width_cm, package.height_cm)):
            add(errors, "PACKAGE_DIMENSIONS_MISSING", f"Enter the length, width and height of "
                                                      f"{package.package_number}.", packageId=package.id)
    address = _address_problems(order)
    if address:
        add(errors, "ADDRESS_INCOMPLETE", f"The delivery address is missing: {', '.join(address)}.")
    if order.payment_status not in ("paid", "cod-pending", "partially-refunded"):
        add(critical, "PAYMENT_NOT_CONFIRMED", f"The payment is {order.payment_status.replace('-', ' ')}.")
    return {"ready": not errors, "errors": errors, "critical": critical}


def mark_packed(db: Session, job_id, *, admin, confirm: bool = False, override_reason=None) -> PackingJob:
    job = get(db, job_id, lock=True)
    order = _require_live_order(db, job)
    _require(job, ("packing",), "Only a job being packed can be marked packed.")
    check = validate(db, job)
    if check["errors"]:
        raise PackingInvalid(check["errors"][0]["message"], details=check)
    reason = ""
    if check["critical"]:
        reason = _reason(override_reason, field="overrideReason", required=False)
        if not confirm or len(reason) < 3:
            raise ConflictError("Some checks need your confirmation, with a reason.",
                                error_code="CONFIRMATION_REQUIRED", details=check)
    now = _now()
    job.packed_at, job.packed_by, job.pack_override_reason = now, _actor_id(admin), reason
    for package in _active_packages(job):
        package.packed_at, package.packed_by = now, _actor_id(admin)
    _set_status(db, job, "packed", "packed", admin=admin,
                note=f"Packed with confirmation: {reason}" if reason else "",
                details={"packages": [p.package_number for p in _active_packages(job)],
                         "override": [c["code"] for c in check["critical"]] if reason else []})
    _audit(db, job, "packed", admin, f"Packed in {len(_active_packages(job))} package(s)"
           + (f", confirmed: {reason}" if reason else ""))
    shipment = db.execute(select(Shipment).where(Shipment.active_key == order.id)).scalar_one_or_none()
    if shipment is not None:
        _link(db, job, shipment, admin=admin)
    _move_order(db, order, "packed", admin=admin, note="Packed.")
    return job


def reopen(db: Session, job_id, *, admin, target: str, reason) -> PackingJob:
    """Move a job back, with a reason: packed to packing, or picked/packing to picking."""
    job = get(db, job_id, lock=True)
    _require_live_order(db, job)
    reason = _reason(reason)
    if target not in ("picking", "packing"):
        raise ValidationError("Reopen to picking or packing.", error_code="INVALID_TARGET",
                              details={"field": "target"})
    if job.status == "ready-to-ship":
        raise ConflictError("This order has been handed to a shipment. Cancel the shipment first.",
                            error_code="SHIPMENT_ACTIVE")
    allowed = {"packing": ("packed",), "picking": ("picked", "packing", "packed")}[target]
    _require(job, allowed, f"A job that is {STATUS_LABELS[job.status].lower()} can't go back to {target}.")
    if target == "picking":
        job.picked_at = None
    job.packed_at, job.packed_by = None, ""
    for package in _active_packages(job):
        package.packed_at, package.packed_by = None, ""
    _set_status(db, job, target, "reopened", admin=admin, note=reason)
    _audit(db, job, "reopen", admin, f"Packing reopened to {target}: {reason}")
    db.commit()
    return job


# ------------------------------------------------------------ the shipment


def _link(db: Session, job: PackingJob, shipment: Shipment, *, admin=None) -> None:
    job.shipment_id = shipment.id
    job.ready_at = _now()
    for package in _active_packages(job):
        package.shipment_id = shipment.id
    _set_status(db, job, "ready-to-ship", "ready", admin=admin, note=f"Handed to shipment {shipment.shipment_number}.",
                details={"shipmentId": shipment.id})
    _audit(db, job, "ready", admin, f"Ready to ship with {shipment.shipment_number}")


def mark_ready(db: Session, job_id, *, admin) -> PackingJob:
    job = get(db, job_id, lock=True)
    _require_live_order(db, job)
    _require(job, ("packed",), "Only a packed order can be made ready to ship.")
    shipment = db.execute(select(Shipment).where(Shipment.active_key == job.order_id)).scalar_one_or_none()
    if shipment is None:
        raise ConflictError("Create the shipment first (on the order page).", error_code="SHIPMENT_REQUIRED")
    _link(db, job, shipment, admin=admin)
    db.commit()
    return job


def aggregate(packages: List[PackingPackage]) -> Optional[dict]:
    """
    The packages as one shipment's package fields: total weight, package
    count, and the dimensions (and type) of the largest package by volume, which
    is what couriers that take a single size per shipment expect.
    """
    if not packages:
        return None
    weights = [p.weight_grams for p in packages]

    def volume(p):
        dims = (p.length_cm, p.width_cm, p.height_cm)
        return 0 if any(d is None for d in dims) else float(p.length_cm) * float(p.width_cm) * float(p.height_cm)

    largest = max(packages, key=volume)
    dims = {k: (float(getattr(largest, a)) if getattr(largest, a) is not None else None)
            for k, a in (("lengthCm", "length_cm"), ("widthCm", "width_cm"), ("heightCm", "height_cm"))}
    return {"weightGrams": sum(w for w in weights if w) if all(weights) else None, **dims,
            "count": len(packages), "type": largest.package_type}


def shipment_prefill(db: Session, order_id: str) -> Optional[dict]:
    """For a new shipment: the packed job's packages, aggregated. None when not packed."""
    job = _active_for(db, order_id)
    if job is None or job.status != "packed":
        return None
    return aggregate(_active_packages(job))


def on_shipment_created(db: Session, shipment: Shipment, *, admin=None) -> None:
    """A shipment created for a packed order takes its packages. Commits."""
    job = _active_for(db, shipment.order_id)
    if job is None or job.status != "packed":
        return
    _link(db, job, shipment, admin=admin)
    db.commit()


def on_shipment_cancelled(db: Session, shipment: Shipment) -> None:
    """The packages come back to the warehouse: the job is packed again. Never commits."""
    job = db.execute(select(PackingJob).where(PackingJob.shipment_id == shipment.id,
                                              PackingJob.status == "ready-to-ship")).scalar_one_or_none()
    if job is None:
        return
    job.shipment_id = None
    job.ready_at = None
    for package in job.packages:
        if package.shipment_id == shipment.id:
            package.shipment_id = None
    _set_status(db, job, "packed", "shipment-cancelled", note=f"Shipment {shipment.shipment_number} cancelled.")
    _audit(db, job, "shipment-cancelled", None, f"Shipment {shipment.shipment_number} cancelled; packed again")


def packages_for_shipment(db: Session, shipment: Shipment) -> List[PackingPackage]:
    return list(db.execute(select(PackingPackage).where(PackingPackage.shipment_id == shipment.id,
                                                        PackingPackage.removed_at.is_(None))
                           .order_by(PackingPackage.id)).scalars())


# -------------------------------------------------------------------- views


def _sla(db: Session) -> int:
    return int(fulfilment_settings.settings(db)["slaHours"])


def volumetric_kg(package: PackingPackage, divisor: int) -> Optional[float]:
    dims = (package.length_cm, package.width_cm, package.height_cm)
    if any(d is None for d in dims) or not divisor:
        return None
    from decimal import ROUND_HALF_UP, Decimal

    value = Decimal(str(package.length_cm)) * Decimal(str(package.width_cm)) * Decimal(str(package.height_cm))
    return float((value / Decimal(divisor)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _aging(job: PackingJob, order: Order, sla_hours: int, now: datetime) -> dict:
    end = job.packed_at if job.status in ("packed", "ready-to-ship") and job.packed_at else now
    hours = max(0.0, (end - order.placed_at).total_seconds() / 3600) if order.placed_at else 0.0
    return {"hours": round(hours, 1), "slaHours": sla_hours,
            "overdue": job.status in NOT_PACKED and hours > sla_hours}


def _names(db: Session, ids) -> Dict[str, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return dict(db.execute(select(AdminUser.id, AdminUser.name).where(AdminUser.id.in_(ids))).all())


def actions(job: PackingJob, order: Optional[Order], check: dict) -> dict:
    live = job.status != "cancelled" and order is not None and order.status not in ("cancelled", "returned")
    status = job.status
    return {
        "assign": live and status in NOT_PACKED + ("packed",),
        "startPicking": live and status == "pending" and order.status != "pending",
        "pick": live and status in ("pending", "picking"),
        "completePicking": live and status == "picking",
        "startPacking": live and status == "picked",
        "editPackages": live and status in ("picked", "packing"),
        "markPacked": live and status == "packing" and check["ready"],
        "reopen": live and status in ("picked", "packing", "packed"),
        "ready": live and status == "packed",
        "slip": status != "pending",
    }


def detail_view(db: Session, job: PackingJob) -> dict:
    order = _order(db, job)
    items = _items(db, job)
    allocated = _allocated(job)
    config = fulfilment_settings.settings(db)
    divisor = int(config["volumetricDivisor"])
    events = list(db.execute(select(PackingEvent).where(PackingEvent.job_id == job.id)
                             .order_by(PackingEvent.occurred_at, PackingEvent.id)).scalars())
    names = _names(db, [job.assigned_to] + [e.actor for e in events])
    shipment = db.get(Shipment, job.shipment_id) if job.shipment_id else \
        db.execute(select(Shipment).where(Shipment.active_key == job.order_id)).scalar_one_or_none()
    check = validate(db, job)
    lines = []
    line_names = {}
    for line in job.lines:
        item = items.get(line.order_item_id)
        line_names[line.id] = item
        lines.append({
            "id": line.id, "orderItemId": line.order_item_id,
            "productId": item.product_id if item else "", "name": item.name if item else "",
            "sku": item.sku if item else "", "size": (item.size or "") if item else "",
            "color": (item.color or "") if item else "", "image": item.image if item else "",
            "quantity": line.quantity, "pickedQty": line.picked_qty,
            "remainingQty": max(0, line.quantity - line.picked_qty),
            "allocatedQty": allocated.get(line.id, 0), "pickedAt": line.picked_at, "pickedBy": line.picked_by,
            "exception": ({"type": line.exception, "label": EXCEPTION_LABELS[line.exception],
                           "quantity": line.exception_qty, "note": line.exception_note, "by": line.exception_by,
                           "at": line.exception_at} if line.exception else None),
            "damagedRecordedQty": line.damaged_recorded_qty,
        })
    packages = []
    for package in _active_packages(job):
        packages.append({
            "id": package.id, "packageNumber": package.package_number, "weightGrams": package.weight_grams,
            "lengthCm": float(package.length_cm) if package.length_cm is not None else None,
            "widthCm": float(package.width_cm) if package.width_cm is not None else None,
            "heightCm": float(package.height_cm) if package.height_cm is not None else None,
            "volumetricWeightKg": volumetric_kg(package, divisor), "type": package.package_type,
            "notes": package.notes, "packedBy": package.packed_by, "packedAt": package.packed_at,
            "shipmentId": package.shipment_id, "createdAt": package.created_at, "createdBy": package.created_by,
            "items": [{"lineId": i.line_id, "quantity": i.quantity,
                       "name": line_names[i.line_id].name if line_names.get(i.line_id) else "",
                       "sku": line_names[i.line_id].sku if line_names.get(i.line_id) else "",
                       "size": (line_names[i.line_id].size or "") if line_names.get(i.line_id) else "",
                       "color": (line_names[i.line_id].color or "") if line_names.get(i.line_id) else ""}
                      for i in package.items],
        })
    from app.services.shipping.service import destination_of

    return {
        "id": job.id, "status": job.status, "statusLabel": STATUS_LABELS.get(job.status, job.status),
        "priority": job.priority,
        "assignedTo": ({"id": job.assigned_to, "name": names.get(job.assigned_to, "")} if job.assigned_to else None),
        "assignedAt": job.assigned_at,
        "order": None if order is None else {
            "id": order.id, "orderNumber": order.order_number, "status": order.status,
            "paymentStatus": order.payment_status, "paymentMethod": order.payment_method,
            "deliveryMethod": order.delivery_method, "total": float(order.total or 0),
            "itemCount": order.item_count, "placedAt": order.placed_at,
            "customer": {"id": order.customer_id, "name": order.customer_name, "email": order.customer_email,
                         "phone": order.shipping_phone},
            "shippingAddress": destination_of(order),
        },
        "lines": lines, "packages": packages,
        "aggregate": aggregate(_active_packages(job)),
        "shipment": None if shipment is None else {
            "id": shipment.id, "shipmentNumber": shipment.shipment_number, "status": shipment.status,
            "courierName": shipment.courier_name, "awb": shipment.awb or "",
            "linked": job.shipment_id == shipment.id},
        "validation": check, "actions": actions(job, order, check),
        "aging": _aging(job, order, int(config["slaHours"]), _now()) if order is not None else None,
        "pickOverrideReason": job.pick_override_reason, "packOverrideReason": job.pack_override_reason,
        "volumetricDivisor": divisor, "slipShowPrices": bool(config["slipShowPrices"]),
        "defaultPackage": config["defaultPackage"],
        "events": [{"id": e.id, "action": e.action, "fromStatus": e.from_status, "toStatus": e.to_status,
                    "note": e.note, "details": e.details or {}, "actor": e.actor,
                    "actorName": names.get(e.actor, "System" if e.actor == "system" else e.actor),
                    "at": e.occurred_at} for e in events],
        "timestamps": {"createdAt": job.created_at, "pickingStartedAt": job.picking_started_at,
                       "pickedAt": job.picked_at, "packingStartedAt": job.packing_started_at,
                       "packedAt": job.packed_at, "readyAt": job.ready_at, "cancelledAt": job.cancelled_at},
    }


def card_view(db: Session, order_id: str) -> dict:
    """The order page's packing card."""
    job = for_order(db, order_id)
    if job is None:
        return {"job": None}
    return {"job": {"id": job.id, "status": job.status, "statusLabel": STATUS_LABELS.get(job.status, job.status),
                    "priority": job.priority, "packageCount": len(_active_packages(job)),
                    "packedAt": job.packed_at,
                    "assignedTo": _names(db, [job.assigned_to]).get(job.assigned_to, "") if job.assigned_to else ""}}


# ---------------------------------------------------------------- the queue


def _parse_day(value: str) -> Optional[datetime]:
    try:
        return datetime.strptime((value or "").strip(), "%Y-%m-%d")
    except ValueError:
        return None


def search(db: Session, *, admin=None, q: str = "", status: str = "", scope: str = "open", date_from: str = "",
           date_to: str = "", payment_status: str = "", courier: str = "", priority: str = "", assigned: str = "",
           shipping_type: str = "", overdue: bool = False, page: int = 1,
           page_size: int = 25) -> Tuple[List[dict], int, Dict[str, int]]:
    sync(db)
    sla = _sla(db)
    now = _now()
    conditions = []
    if scope != "all" and status != "cancelled":
        conditions += [PackingJob.status != "cancelled", Order.status.not_in(GONE)]
    # `q` is an Order ID (docs/id-lookup.md), matched exactly: never a name or an email.
    from app.services.lookup.filters import id_condition

    by_order = id_condition("order", q)
    if by_order is not None:
        conditions.append(by_order)
    start, end = _parse_day(date_from), _parse_day(date_to)
    if start:
        conditions.append(Order.placed_at >= start)
    if end:
        conditions.append(Order.placed_at < end + timedelta(days=1))
    if payment_status:
        conditions.append(Order.payment_status == payment_status.strip()[:20])
    if (courier or "").strip():
        # A courier's code, exactly: the integration's (`shiprocket`) or the courier's own.
        code = courier.strip()[:40]
        conditions.append(or_(Shipment.provider_code == code, Shipment.courier_code == code))
    if priority in PRIORITIES:
        conditions.append(PackingJob.priority == priority)
    if assigned == "unassigned":
        conditions.append(PackingJob.assigned_to.is_(None))
    elif assigned == "me" and admin is not None:
        conditions.append(PackingJob.assigned_to == admin.id)
    elif assigned:
        # An Admin user ID, exactly (ADM001 = ADM-001); a name keeps nothing.
        by_admin = id_condition("admin_user", assigned, column=PackingJob.assigned_to, via=AdminUser.id)
        if by_admin is not None:
            conditions.append(by_admin)
    if shipping_type:
        conditions.append(Order.delivery_method == shipping_type.strip()[:30])
    if overdue:
        conditions += [PackingJob.status.in_(NOT_PACKED), Order.placed_at < now - timedelta(hours=sla)]

    def joined(statement):
        return (statement.join(Order, Order.id == PackingJob.order_id)
                .outerjoin(Shipment, and_(Shipment.active_key == Order.id)))

    counts = dict(db.execute(joined(select(PackingJob.status, func.count()).select_from(PackingJob))
                             .where(*conditions).group_by(PackingJob.status)).all())
    base = joined(select(PackingJob, Order, Shipment).select_from(PackingJob)).where(*conditions)
    if status in STATUSES:
        base = base.where(PackingJob.status == status)
    total = db.execute(select(func.count()).select_from(base.subquery())).scalar_one()
    rank = case((PackingJob.priority == "urgent", 0), (PackingJob.priority == "high", 1), else_=2)
    rows = db.execute(base.order_by(rank, Order.placed_at, PackingJob.id)
                      .offset((max(1, page) - 1) * page_size).limit(page_size)).all()
    names = _names(db, [job.assigned_to for job, _, _ in rows])
    items = []
    for job, order, shipment in rows:
        items.append({
            "id": job.id, "status": job.status, "statusLabel": STATUS_LABELS.get(job.status, job.status),
            "priority": job.priority, "orderId": order.id, "orderNumber": order.order_number,
            "customerName": order.customer_name, "placedAt": order.placed_at,
            "paymentStatus": order.payment_status, "paymentMethod": order.payment_method,
            "total": float(order.total or 0), "itemCount": order.item_count,
            "shippingMethod": order.delivery_method,
            "courierName": shipment.courier_name if shipment is not None else "",
            "assignedTo": ({"id": job.assigned_to, "name": names.get(job.assigned_to, "")}
                           if job.assigned_to else None),
            "createdAt": job.created_at, "aging": _aging(job, order, sla, now),
        })
    return items, total, {k: int(v) for k, v in counts.items()}


# ------------------------------------------------------------------ summary


def summary(db: Session) -> dict:
    """Headline numbers for the admin dashboard: the packing queue and labels."""
    from app.services.fulfilment import labels

    sync(db)
    now = _now()
    today = now.replace(hour=0, minute=0, second=0)
    sla = _sla(db)
    open_scope = [PackingJob.status != "cancelled", Order.status.not_in(GONE)]
    counts = dict(db.execute(select(PackingJob.status, func.count()).join(Order, Order.id == PackingJob.order_id)
                             .where(*open_scope).group_by(PackingJob.status)).all())
    overdue = db.execute(select(func.count()).select_from(PackingJob).join(Order, Order.id == PackingJob.order_id)
                         .where(*open_scope, PackingJob.status.in_(NOT_PACKED),
                                Order.placed_at < now - timedelta(hours=sla))).scalar_one()
    packed_today = db.execute(select(func.count()).select_from(PackingJob)
                              .where(PackingJob.packed_at >= today, PackingJob.status != "cancelled")).scalar_one()
    return {
        "waitingToPick": int(counts.get("pending", 0) + counts.get("picking", 0)),
        "waitingToPack": int(counts.get("picked", 0) + counts.get("packing", 0)),
        "packedToday": int(packed_today),
        "overdue": int(overdue),
        "slaHours": sla,
        **labels.summary(db),
    }

