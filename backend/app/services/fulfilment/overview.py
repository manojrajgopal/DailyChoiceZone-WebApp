"""
One order's fulfilment, as the order page shows it: where it is on the
lifecycle, what can be done next (and by whom), the packing job, packages,
shipment, tracking and returns it involves, and every status change across
all three records in one history. See docs/order-fulfilment.md.

Everything here is read from the database and decided on the server: the
order page draws the buttons this returns, and each button is checked again
by the service it calls.
"""

from __future__ import annotations

from datetime import datetime
from typing import Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import AuthorizationError, ValidationError
from app.models import AdminUser, Order, OrderEvent
from app.models.fulfilment import PackingEvent, PackingJob
from app.models.shipping import Shipment, ShipmentEvent
from app.services import audit
from app.services.fulfilment import workflow

# Packing events worth a line in the order's history (the rest are per-line detail).
_PACKING_TITLES = {
    "created": "Added to the packing queue",
    "picking-started": "Picking started",
    "picked": "Picking completed",
    "packing-started": "Packing started",
    "packed": "Packing completed",
    "ready": "Handed to shipping",
    "reopened": "Packing reopened",
    "cancelled": "Packing cancelled",
    "shipment-cancelled": "Shipment cancelled: packages back in the warehouse",
    "exception": "Problem recorded while picking",
    "exception-cleared": "Picking problem cleared",
    "damaged-recorded": "Damaged stock written off",
}
_ORDER_TITLES = {
    "pending": "Order placed",
    "confirmed": "Order confirmed",
    "processing": "Moved to packing",
    "packed": "Order packed",
    "shipped": "Shipped: picked up by the courier",
    "in-transit": "In transit",
    "out-for-delivery": "Out for delivery",
    "delivered": "Delivered",
    "cancelled": "Order cancelled",
    "returned": "Order returned to origin",
}


def holds(admin, permission: str) -> bool:
    """The same test as `require_access`: the stored list or the role's current one."""
    from app.core.permissions import permissions_for

    if admin is None:
        return False
    return (admin.role == "super-admin" or permission in (admin.permissions or [])
            or permission in permissions_for(admin.role))


def _require(admin, permission: str) -> None:
    if not holds(admin, permission):
        raise AuthorizationError(f"Your role does not include '{permission}'.", error_code="PERMISSION_DENIED")


# ------------------------------------------------------------------ reading


def _records(db: Session, order: Order):
    from app.services.fulfilment import packing

    job = packing.for_order(db, order.id)
    shipments = list(db.execute(select(Shipment).where(Shipment.order_id == order.id)
                                .order_by(Shipment.created_at.desc(), Shipment.id.desc())).scalars())
    active = next((s for s in shipments if s.active_key), None)
    # The shipment the order's progress follows: the open one, else the most
    # recent that wasn't cancelled (delivered, or back to origin).
    current = active or next((s for s in shipments if s.status != "cancelled"), None)
    return job, shipments, active, current


def _seen(db: Session, shipment: Optional[Shipment]) -> List[str]:
    if shipment is None:
        return []
    return list(db.execute(select(ShipmentEvent.status).where(ShipmentEvent.shipment_id == shipment.id,
                                                              ShipmentEvent.status != "")).scalars())


def _names(db: Session, ids) -> Dict[str, str]:
    ids = {i for i in ids if i and i not in ("system", "customer", "courier")}
    if not ids:
        return {}
    return dict(db.execute(select(AdminUser.id, AdminUser.name).where(AdminUser.id.in_(ids))).all())


def _actor_name(actor: str, names: Dict[str, str]) -> str:
    if not actor or actor == "system":
        return "System"
    if actor == "customer":
        return "Customer"
    if actor == "courier":
        return "Courier"
    return names.get(actor, actor)


def _cancelled_from(order: Order) -> str:
    for event in reversed(order.events):
        if event.status == "cancelled":
            if event.from_status:
                return event.from_status
            earlier = [e for e in order.events if e.occurred_at <= event.occurred_at and e is not event]
            return earlier[-1].status if earlier else "pending"
    return "pending"


def _packing_view(db: Session, job: Optional[PackingJob]) -> Optional[dict]:
    if job is None:
        return None
    packages = [p for p in job.packages if p.removed_at is None]
    names = _names(db, [job.assigned_to, job.packed_by])
    return {
        "id": job.id, "status": job.status, "statusLabel": workflow.PACKING_LABELS.get(job.status, job.status),
        "priority": job.priority, "assignedTo": names.get(job.assigned_to, "") if job.assigned_to else "",
        "pickingStartedAt": job.picking_started_at, "pickedAt": job.picked_at,
        "packingStartedAt": job.packing_started_at, "packedAt": job.packed_at,
        "packedBy": _actor_name(job.packed_by, names) if job.packed_by else "",
        "notes": job.notes,
        "packageCount": len(packages),
        "packages": [{"packageNumber": p.package_number, "type": p.package_type, "weightGrams": p.weight_grams,
                      "lengthCm": float(p.length_cm) if p.length_cm is not None else None,
                      "widthCm": float(p.width_cm) if p.width_cm is not None else None,
                      "heightCm": float(p.height_cm) if p.height_cm is not None else None,
                      "itemCount": sum(i.quantity for i in p.items)} for p in packages],
        "href": f"/admin/packing/job?id={job.id}",
    }


def _shipment_view(db: Session, shipment: Shipment) -> dict:
    from app.services.fulfilment import labels
    from app.services.shipping import service as shipping

    events = list(db.execute(select(ShipmentEvent).where(ShipmentEvent.shipment_id == shipment.id)).scalars())
    return {
        "id": shipment.id, "shipmentNumber": shipment.shipment_number, "status": shipment.status,
        "statusLabel": workflow.shipment_label(shipment.status), "courierName": shipment.courier_name,
        "courierCode": shipment.courier_code, "providerCode": shipment.provider_code, "awb": shipment.awb or "",
        "expectedDeliveryAt": shipment.expected_delivery_at, "deliveredAt": shipment.delivered_at,
        "pickupScheduledAt": shipment.pickup_scheduled_at, "createdAt": shipment.created_at,
        "labelStatus": labels.states(db, [shipment.id]).get(shipment.id, "not-generated"),
        "deliveryAttempts": sum(1 for e in events if e.status == "delivery-attempted"),
        "requestStatus": shipment.request_status, "lastError": shipment.last_error,
        "transitions": shipping.transitions(shipment),
        "href": f"/admin/shipments/detail?id={shipment.id}",
    }


def _returns(db: Session, order: Order) -> List[dict]:
    from app.models.returns import ReturnRequest

    rows = db.execute(select(ReturnRequest).where(ReturnRequest.order_id == order.id)
                      .order_by(ReturnRequest.created_at)).scalars()
    return [{"id": r.id, "kind": r.kind, "status": r.status, "statusLabel": r.status.replace("-", " ").capitalize(),
             "reason": r.reason, "href": f"/admin/returns?q={r.id}"} for r in rows]


# ------------------------------------------------------------------ actions


def _action(key: str, label: str, kind: str, *, allowed: bool = True, blocked: str = "", primary: bool = False,
            reason: bool = False, destructive: bool = False, description: str = "", **extra) -> dict:
    return {"key": key, "label": label, "kind": kind, "allowed": allowed and not blocked,
            "blockedReason": blocked or ("" if allowed else "Your role can't do this."),
            "primary": primary, "requiresReason": reason, "destructive": destructive,
            "description": description, **extra}


def next_actions(db: Session, order: Order, job: Optional[PackingJob], active: Optional[Shipment],
                 current: Optional[Shipment], admin) -> List[dict]:
    """
    The valid next steps from where the order is now, primary first. Each is
    one of: `order` (POST .../fulfilment/actions), `shipment` (POST
    /admin/shipments/{id}/status), `create-shipment` (the create dialog) or
    `link` (a workspace page). `allowed: false` with `blockedReason` when the
    step exists but can't be taken yet (payment, permission, courier).
    """
    from app.services.fulfilment import packing
    from app.services.shipping import registry

    status = order.status
    out: List[dict] = []
    can_orders, can_pack, can_ship = holds(admin, "orders"), holds(admin, "packing"), holds(admin, "shipments")

    if status == "pending":
        blocked = ""
        if order.stock_state == "reserved" and order.payment_status != "paid":
            blocked = "Waiting for the customer's payment: the order is confirmed when it arrives."
        else:
            blocked = workflow.payment_blocker(order, action="confirmed") or ""
        out.append(_action("confirm", "Confirm order", "order", target="confirmed", allowed=can_orders,
                           blocked=blocked, primary=True,
                           description="Accept the order. It then joins the packing queue."))

    if status in ("confirmed", "processing", "packed") and job is not None and job.active_key:
        href = f"/admin/packing/job?id={job.id}"
        if job.status == "pending":
            blocked = packing.picking_blocker(order)
            out.append(_action("start-packing", "Move to packing", "order", target="processing", allowed=can_pack,
                               blocked=blocked[1] if blocked else "", primary=True,
                               description="Start picking this order's items in the warehouse."))
        elif job.status == "picking":
            out.append(_action("open-packing", "Continue picking", "link", href=href, allowed=can_pack, primary=True,
                               description="Pick every item, then mark picking complete in the packing workspace."))
        elif job.status == "picked":
            out.append(_action("begin-packing", "Start packing", "order", allowed=can_pack, primary=True,
                               description="Picking is complete. Start packing the items into parcels."))
        elif job.status == "packing":
            out.append(_action("open-packing", "Complete packing", "link", href=href, allowed=can_pack, primary=True,
                               description="Put every picked item into a package, then mark it packed."))
        elif job.status == "packed" and active is None:
            couriers = bool(registry.active_rows(db))
            out.append(_action("create-shipment", "Create shipment", "create-shipment", allowed=can_ship,
                               blocked="" if couriers else
                               "No courier is switched on. Set one up in Settings → Couriers (Manual works "
                               "without an integration).",
                               primary=True, description="Book the packed parcel with a courier."))
            out.append(_action("repack", "Move back to packing", "order", target="processing", allowed=can_pack,
                               reason=True, destructive=True,
                               description="Reopen packing (a damaged parcel, a wrong item). Needs a reason."))

    if active is not None:
        for move in _shipment_moves(active):
            out.append(_action(f"shipment:{move['status']}", move["action"], "shipment", target=move["status"],
                               shipmentId=active.id, allowed=can_ship, reason=move["requiresReason"],
                               destructive=move["kind"] in ("cancel", "back", "exception"),
                               primary=move["kind"] == "forward" and not any(a["primary"] for a in out),
                               description=_shipment_hint(move)))
        if active.status == "pending":
            out.append(_action("open-shipment", "Open shipment", "link", href=f"/admin/shipments/detail?id={active.id}",
                               allowed=can_ship, primary=not any(a["primary"] for a in out),
                               description="The courier hasn't confirmed this shipment yet. Retry or check the "
                                           "error on the shipment page."))

    if status in workflow.RECORDABLE_STATUSES and active is None:
        returned = current is not None and current.status == "returned-to-origin"
        if returned:
            out.append(_action("record-return", "Record return to origin", "order", target="returned",
                               allowed=can_orders, reason=True, destructive=True,
                               description="The parcel is back: close the order, restock it and refund what "
                                           "was paid."))
        couriers = bool(registry.active_rows(db))
        out.append(_action("create-shipment", "Re-ship order" if returned else "Record missing shipment",
                           "create-shipment", allowed=can_ship,
                           blocked="" if couriers else "No courier is switched on. Set one up in Settings → Couriers.",
                           primary=not returned and not any(a["primary"] for a in out),
                           description="Send the order again with a new shipment." if returned else
                           "This order was marked dispatched without a shipment record. Record the shipment "
                           "(courier and AWB) that carried it."))

    if status in workflow.CANCELLABLE:
        blocked = ""
        if active is not None:
            blocked = f"Cancel shipment {active.shipment_number} first: the parcel is booked with the courier."
        out.append(_action("cancel", "Cancel order", "order", target="cancelled", allowed=can_orders,
                           blocked=blocked, reason=status in ("processing", "packed"), destructive=True,
                           description="Stock goes back, the packing job stops and anything paid is refunded."
                           + (" Needs a reason once picking has started." if status in ("processing", "packed")
                              else "")))
    return out


def _shipment_moves(shipment: Shipment) -> List[dict]:
    from app.services.shipping import service as shipping

    return shipping.transitions(shipment)


def _shipment_hint(move: dict) -> str:
    return {
        "forward": f"Shipment moves to {move['label'].lower()}; the order follows.",
        "exception": "Records a delivery exception. Needs a reason.",
        "back": "Moves the shipment back a step. Needs a reason.",
        "cancel": "Cancels the booking with the courier; the packages go back to the warehouse. Needs a reason.",
    }.get(move["kind"], "")


# ------------------------------------------------------------------ history


def history(db: Session, order: Order, job: Optional[PackingJob], shipments: List[Shipment]) -> List[dict]:
    """Every status change across the order, its packing jobs and shipments, oldest first."""
    rows: List[dict] = []
    jobs = list(db.execute(select(PackingJob).where(PackingJob.order_id == order.id)).scalars())
    job_ids = [j.id for j in jobs]
    packing_events = list(db.execute(select(PackingEvent).where(PackingEvent.job_id.in_(job_ids))).scalars()) \
        if job_ids else []
    by_shipment = {s.id: s for s in shipments}
    shipment_events = list(db.execute(select(ShipmentEvent).where(ShipmentEvent.shipment_id.in_(list(by_shipment)))
                                      ).scalars()) if by_shipment else []
    names = _names(db, [e.actor for e in order.events] + [e.actor for e in packing_events]
                   + [e.actor for e in shipment_events])

    order_moves = [(e.status, e.occurred_at) for e in order.events]

    def mirrored_by_order(status: str, when: datetime) -> bool:
        # The order's event and the job's are written in one request, a moment apart.
        return any(s == status and abs((at - when).total_seconds()) <= 5 for s, at in order_moves)

    for event in order.events:
        title = _ORDER_TITLES.get(event.status, workflow.label(event.status))
        if event.status == "processing" and event.from_status == "packed":
            title = "Moved back to packing"
        rows.append({
            "at": event.occurred_at, "kind": "order", "status": event.status,
            "statusLabel": workflow.label(event.status), "fromStatus": event.from_status,
            "title": title, "note": event.note, "reason": event.reason, "source": event.source,
            "actor": event.actor, "actorName": _actor_name(event.actor, names),
            "entity": ({"type": event.related_type, "id": event.related_id} if event.related_type else None),
        })
    for event in packing_events:
        if event.action not in _PACKING_TITLES:
            continue
        # The order's own event already says "Moved to packing" / "Order packed".
        mirrored = {"picking-started": "processing", "packed": "packed"}.get(event.action)
        if mirrored and mirrored_by_order(mirrored, event.occurred_at):
            continue
        title = _PACKING_TITLES[event.action]
        if event.action == "reopened":
            title = f"Packing reopened to {event.to_status}"
        rows.append({
            "at": event.occurred_at, "kind": "packing", "status": event.to_status,
            "statusLabel": workflow.PACKING_LABELS.get(event.to_status, event.to_status),
            "fromStatus": event.from_status, "title": title,
            "note": "" if event.action == "reopened" else event.note,
            "reason": event.note if event.action == "reopened" else "",
            "source": "packing", "actor": event.actor, "actorName": _actor_name(event.actor, names),
            "entity": {"type": "packing", "id": str(event.job_id)},
        })
    for event in shipment_events:
        shipment = by_shipment[event.shipment_id]
        if not event.status and event.source != "admin" and not event.visible:
            # A courier-side technical note (a retry, a refused order move).
            title = "Shipment note"
        elif not event.status:
            title = "Tracking update"
        else:
            title = f"Shipment {workflow.shipment_label(event.status).lower()}"
        rows.append({
            "at": event.occurred_at, "kind": "shipment", "status": event.status,
            "statusLabel": workflow.shipment_label(event.status) if event.status else "",
            "fromStatus": "", "title": title, "note": event.description, "reason": "",
            "location": event.location,
            "source": {"webhook": "courier", "poll": "courier"}.get(event.source, event.source),
            "actor": event.actor or ("courier" if event.source in ("webhook", "poll") else "system"),
            "actorName": _actor_name(event.actor or ("courier" if event.source in ("webhook", "poll") else "system"),
                                     names),
            "entity": {"type": "shipment", "id": shipment.shipment_number, "shipmentId": shipment.id},
        })
    rows.sort(key=lambda r: (r["at"] or datetime.min))
    return rows


# ------------------------------------------------------------------ warnings


def _warnings(order: Order, job: Optional[PackingJob], current: Optional[Shipment]) -> List[dict]:
    """Records that don't agree with each other (data from before the workflow was enforced)."""
    out = []
    if order.status in workflow.DISPATCHED and current is None:
        out.append({"code": "NO_SHIPMENT_RECORD",
                    "message": f"This order is marked {workflow.label(order.status).lower()}, but no shipment was "
                               "ever recorded for it (it was moved by hand before shipments were required)."})
    if order.status == "processing" and job is not None and job.status == "pending":
        out.append({"code": "PICKING_NOT_STARTED",
                    "message": "The order is marked Packing, but the warehouse hasn't started picking it. "
                               "Move it to packing to continue."})
    if order.status == "packed" and job is not None and job.status in ("pending", "picking", "picked", "packing"):
        out.append({"code": "PACKING_NOT_COMPLETE",
                    "message": "The order is marked Packed, but its packing job isn't. Complete packing before "
                               "creating the shipment."})
    return out


# ------------------------------------------------------------------ the view


def view(db: Session, order_id: str, admin) -> dict:
    from app.services import orders

    order = orders.get_order(db, order_id)
    job, shipments, active, current = _records(db, order)
    progress = workflow.lifecycle(
        order_status=order.status, job_status=job.status if job is not None else None,
        shipment_status=current.status if current is not None else None, shipment_seen=_seen(db, current),
        cancelled_from=_cancelled_from(order) if order.status == "cancelled" else "",
        had_job=job is not None,
    )
    return {
        "order": {"id": order.id, "orderNumber": order.order_number, "status": order.status,
                  "statusLabel": workflow.label(order.status), "paymentStatus": order.payment_status,
                  "paymentMethod": order.payment_method, "stockState": order.stock_state},
        "payment": {"status": order.payment_status, "method": order.payment_method,
                    "blocked": workflow.payment_blocker(order) if order.status not in workflow.DISPATCHED
                    and order.status not in workflow.ORDER_TERMINAL else None},
        "progress": progress,
        "nextActions": next_actions(db, order, job, active, current, admin),
        "packing": _packing_view(db, job) if holds(admin, "packing") or holds(admin, "orders") else None,
        "shipment": _shipment_view(db, current) if current is not None else None,
        "shipments": [{"id": s.id, "shipmentNumber": s.shipment_number, "status": s.status,
                       "statusLabel": workflow.shipment_label(s.status), "createdAt": s.created_at,
                       "href": f"/admin/shipments/detail?id={s.id}"} for s in shipments],
        "returns": _returns(db, order),
        "warnings": _warnings(order, job, current),
        "history": history(db, order, job, shipments),
    }


# ----------------------------------------------------------------- perform


ORDER_ACTIONS = ("confirm", "cancel", "record-return", "start-packing", "begin-packing", "repack")


def perform(db: Session, order_id: str, payload: dict, admin) -> str:
    """
    Do one of the order page's `order` actions. Each is checked by the
    service that owns it, exactly as if it had been called from its own page;
    this only routes. Returns a confirmation message.
    """
    from app.services import orders
    from app.services.fulfilment import packing

    action = payload.get("action") if isinstance(payload.get("action"), str) else ""
    reason = payload.get("reason").strip()[:300] if isinstance(payload.get("reason"), str) else ""
    note = payload.get("note").strip()[:500] if isinstance(payload.get("note"), str) else ""
    if action not in ORDER_ACTIONS:
        raise ValidationError("Choose a fulfilment action.", error_code="INVALID_ACTION", details={"field": "action"})
    order = orders.get_order(db, order_id)

    if action in ("confirm", "cancel", "record-return"):
        _require(admin, "orders")
        target = {"confirm": "confirmed", "cancel": "cancelled", "record-return": "returned"}[action]
        previous = order.status
        order = orders.update_status(db, order.id, target, note=note, reason=reason, actor=admin.id, source="admin")
        audit.record(db, "orders.status", resource_type="orders", resource_id=order.id, actor=admin,
                     summary=f"Moved order {order.order_number} from {previous} to {order.status}",
                     changes={"status": {"from": previous, "to": order.status}},
                     details={"reason": reason} if reason else None)
        db.commit()
        return f"Order {order.order_number} is now {workflow.label(order.status).lower()}."

    _require(admin, "packing")
    job = packing.for_order(db, order.id)
    if job is None or not job.active_key:
        from app.core.errors import ConflictError

        raise ConflictError("This order isn't in the packing queue: it joins once it is confirmed.",
                            error_code="PACKING_NOT_AVAILABLE")
    if action == "start-packing":
        packing.start_picking(db, job.id, admin=admin)
        return "Picking started. The order is now in packing."
    if action == "begin-packing":
        packing.start_packing(db, job.id, admin=admin)
        return "Packing started."
    packing.reopen(db, job.id, admin=admin, target="packing", reason=reason)
    return "Packing reopened. The order is back in packing."
