"""
The fulfilment lifecycle: the one place that says which status changes are
allowed. See docs/order-fulfilment.md.

Three records, three status fields, kept apart on purpose:

- **Order** (`orders.status`): the customer-facing stage.
  pending → confirmed → processing ("Packing") → packed → shipped →
  in-transit → out-for-delivery → delivered, or cancelled / returned.
- **Packing job** (`packing_jobs.status`): the warehouse's work.
  pending (waiting to pick) → picking → picked → packing → packed →
  ready-to-ship (handed to a shipment).
- **Shipment** (`shipments.status`): the courier's work.
  pending (shipment created) → ready-for-pickup → pickup-scheduled →
  picked-up → in-transit → at-destination-hub → out-for-delivery →
  delivered, with delivery-attempted / delivery-failed / returned-to-origin /
  cancelled off the main line.

## Who moves the order

Every order transition has an *owner*: the part of the system allowed to make
it. The order page cannot type an order into "shipped"; only a shipment can.

| From | To | Owner |
| --- | --- | --- |
| pending | confirmed | admin, payment |
| confirmed | processing | packing (picking starts) |
| processing | packed | packing (packing completed) |
| packed | processing | packing (reopened to repack, with a reason) |
| packed | shipped → … → delivered | shipment (courier milestones) |
| pending, confirmed | cancelled | admin, customer, payment, system |
| processing, packed | cancelled | admin, with a reason |
| shipped, in-transit, out-for-delivery | returned | admin, with a reason, only once the shipment has returned to origin |

Nothing leaves `delivered`, `cancelled` or `returned`. Items coming back after
delivery go through return requests (`services/returns.py`), which never touch
the order's forward status.

Manual admin moves are strictly one step at a time. Courier updates may pass
over a milestone the courier never scanned (a parcel can be "in transit"
without a "picked up" scan); the timeline records which.

This module imports no other service, so every service can import it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from app.core.errors import ConflictError, ValidationError

# ------------------------------------------------------------------ orders

ORDER_FLOW: Tuple[str, ...] = (
    "pending",
    "confirmed",
    "processing",
    "packed",
    "shipped",
    "in-transit",
    "out-for-delivery",
    "delivered",
)
ORDER_TERMINAL = frozenset({"cancelled", "returned"})
ORDER_STATUSES = frozenset(ORDER_FLOW) | ORDER_TERMINAL
# Stages a shipment drives. Courier updates may move forward within these.
SHIPMENT_DRIVEN: Tuple[str, ...] = ("packed", "shipped", "in-transit", "out-for-delivery", "delivered")
# The parcel has left the warehouse.
DISPATCHED = frozenset({"shipped", "in-transit", "out-for-delivery", "delivered"})
# Before dispatch: cancelling is still a cancellation, not a return.
CANCELLABLE = frozenset({"pending", "confirmed", "processing", "packed"})
CUSTOMER_CANCELLABLE = frozenset({"pending", "confirmed"})
# Dispatched but not delivered: with no open shipment, one may be recorded
# (legacy data) or created again (after a return to origin).
RECORDABLE_STATUSES = frozenset({"shipped", "in-transit", "out-for-delivery"})

ORDER_LABELS: Dict[str, str] = {
    "pending": "Pending",
    "confirmed": "Confirmed",
    "processing": "Packing",
    "packed": "Packed",
    "shipped": "Shipped",
    "in-transit": "In transit",
    "out-for-delivery": "Out for delivery",
    "delivered": "Delivered",
    "cancelled": "Cancelled",
    "returned": "Returned",
}

SOURCES = ("admin", "packing", "shipment", "payment", "customer", "system")

# Payment states that let fulfilment go ahead: money received, or cash to be
# collected on delivery.
PAYMENT_OK = frozenset({"paid", "cod-pending", "partially-refunded"})


@dataclass(frozen=True)
class OrderMove:
    target: str
    owners: Tuple[str, ...]
    kind: str = "forward"  # forward | back | cancel | return
    reason_required: bool = False


_ANY_CANCEL = ("admin", "customer", "payment", "system")

ORDER_TRANSITIONS: Dict[str, Tuple[OrderMove, ...]] = {
    "pending": (
        OrderMove("confirmed", ("admin", "payment")),
        OrderMove("cancelled", _ANY_CANCEL, "cancel"),
    ),
    "confirmed": (
        OrderMove("processing", ("packing",)),
        OrderMove("cancelled", _ANY_CANCEL, "cancel"),
    ),
    "processing": (
        OrderMove("packed", ("packing",)),
        OrderMove("cancelled", ("admin", "system"), "cancel", reason_required=True),
    ),
    "packed": (
        OrderMove("shipped", ("shipment",)),
        OrderMove("processing", ("packing",), "back", reason_required=True),
        OrderMove("cancelled", ("admin", "system"), "cancel", reason_required=True),
    ),
    "shipped": (
        OrderMove("in-transit", ("shipment",)),
        OrderMove("returned", ("admin",), "return", reason_required=True),
    ),
    "in-transit": (
        OrderMove("out-for-delivery", ("shipment",)),
        OrderMove("returned", ("admin",), "return", reason_required=True),
    ),
    "out-for-delivery": (
        OrderMove("delivered", ("shipment",)),
        OrderMove("returned", ("admin",), "return", reason_required=True),
    ),
    "delivered": (),
    "cancelled": (),
    "returned": (),
}


def label(status: str) -> str:
    return ORDER_LABELS.get(status, status.replace("-", " ").capitalize())


def flow_index(status: str) -> int:
    return ORDER_FLOW.index(status) if status in ORDER_FLOW else -1


def payment_blocker(order, *, action: str = "packed") -> Optional[str]:
    """Why the order's payment stops fulfilment, or None when it doesn't."""
    status = order.payment_status or ""
    if status in PAYMENT_OK:
        return None
    wording = {"pending": "pending", "failed": "failed", "expired": "expired",
               "refunded": "refunded"}.get(status, status.replace("-", " ") or "missing")
    return f"Order cannot be {action} because payment is {wording}."


def _refusal(current: str, target: str) -> Tuple[str, str]:
    """(message, error code) for a move no one may make."""
    if target == "cancelled":
        if current in DISPATCHED:
            return ("Order cannot be cancelled after shipment pickup. Use the return workflow "
                    "(return to origin, or a return request once delivered).", "ORDER_NOT_CANCELLABLE")
    if target == "returned":
        return ("Only an order that has left the warehouse can be returned. Cancel it instead.",
                "INVALID_TRANSITION")
    here, there = flow_index(current), flow_index(target)
    if here >= 0 and there > here + 1:
        between = ", ".join(label(s) for s in ORDER_FLOW[here + 1:there])
        return (f"Order cannot be moved directly from {label(current)} to {label(target)}. "
                f"It must go through {between} first.", "INVALID_TRANSITION")
    if there >= 0 and 0 <= here and there < here:
        if target == "pending":
            return ("An order cannot be moved back to Pending: only a payment moves an order out of it.",
                    "INVALID_TRANSITION")
        return (f"Order cannot be moved back from {label(current)} to {label(target)}.", "INVALID_TRANSITION")
    return (f"Order cannot be moved from {label(current)} to {label(target)}.", "INVALID_TRANSITION")


def _wrong_owner(move: OrderMove, current: str, source: str) -> Tuple[str, str]:
    owner = move.owners[0]
    if source == "customer" and move.target == "cancelled":
        return ("This order is already being packed and can no longer be cancelled online. "
                "Please contact support.", "ORDER_NOT_CANCELLABLE")
    if owner == "packing":
        if move.target == "processing" and current == "packed":
            return ("A packed order goes back to Packing by reopening its packing job, with a reason.",
                    "WORKFLOW_OWNED")
        what = "Start picking" if move.target == "processing" else "Complete packing"
        return (f"Order moves to {label(move.target)} from the packing workflow ({what}), "
                "so the warehouse record always matches.", "WORKFLOW_OWNED")
    if owner == "shipment":
        return (f"Order cannot be marked {label(move.target)} directly. It moves when its shipment does: "
                "create the shipment, then update its tracking.", "WORKFLOW_OWNED")
    return (f"Order cannot be moved to {label(move.target)} this way.", "WORKFLOW_OWNED")


def check_order_move(order, target: str, source: str, *, reason: str = "",
                     latest_shipment_status: str = "", active_shipment: str = "") -> Optional[OrderMove]:
    """
    The move from the order's status to `target`, made by `source`, or an error
    explaining why not. None when the order is already there.

    `latest_shipment_status` is the status of the order's most recent
    shipment, and `active_shipment` the number of an open one; the caller
    reads them, since this module touches no database.
    """
    if source not in SOURCES:
        raise ValueError(f"unknown source {source!r}")
    current = order.status
    if target not in ORDER_STATUSES:
        raise ValidationError(f"'{target}' is not an order status.", error_code="INVALID_STATUS")
    if target == current:
        return None
    if current in ORDER_TERMINAL:
        raise ConflictError(f"This order is {label(current).lower()}; its status can no longer change.",
                            error_code="INVALID_TRANSITION")
    if current == "delivered":
        message = ("A delivered order cannot be cancelled. Use a return request for items coming back."
                   if target == "cancelled" else
                   "A delivered order is complete. Use a return request for items coming back.")
        raise ConflictError(message, error_code="ORDER_NOT_CANCELLABLE" if target == "cancelled"
                            else "INVALID_TRANSITION")

    move = next((m for m in ORDER_TRANSITIONS.get(current, ()) if m.target == target), None)
    if (move is None and source == "shipment" and current in SHIPMENT_DRIVEN and target in SHIPMENT_DRIVEN
            and flow_index(target) > flow_index(current)):
        # A courier can skip a scan; the shipment's own rules already allowed it.
        move = OrderMove(target, ("shipment",))
    if move is None:
        message, code = _refusal(current, target)
        raise ConflictError(message, error_code=code, details={"from": current, "to": target})
    if source not in move.owners:
        message, code = _wrong_owner(move, current, source)
        raise ConflictError(message, error_code=code, details={"from": current, "to": target})
    if move.reason_required and len((reason or "").strip()) < 3:
        raise ValidationError(f"Moving this order from {label(current)} to {label(target)} needs a reason.",
                              error_code="REASON_REQUIRED", details={"field": "reason"})

    # ---- business guards
    if target == "confirmed":
        if order.stock_state == "reserved" and order.payment_status != "paid":
            raise ConflictError("This order is waiting for its payment. It is confirmed when the payment arrives.",
                                error_code="AWAITING_PAYMENT")
        blocked = payment_blocker(order, action="confirmed")
        if blocked:
            raise ConflictError(blocked, error_code="PAYMENT_REQUIRED")
    if target == "processing" and move.kind == "forward":
        blocked = payment_blocker(order)
        if blocked:
            raise ConflictError(blocked, error_code="PAYMENT_REQUIRED")
        if order.stock_state != "consumed":
            raise ConflictError("Order cannot be packed: its stock is not committed to it "
                                f"({order.stock_state}).", error_code="STOCK_NOT_COMMITTED")
    if target == "cancelled" and active_shipment:
        raise ConflictError(f"Cancel shipment {active_shipment} first: the parcel is booked with the courier.",
                            error_code="SHIPMENT_ACTIVE")
    if target == "returned" and latest_shipment_status != "returned-to-origin":
        raise ConflictError("An order is recorded as returned once its shipment has come back to origin. "
                            "For items returned after delivery, use a return request.",
                            error_code="RETURN_NOT_ALLOWED")
    return move


def admin_order_moves(order) -> List[OrderMove]:
    """The moves an admin may make by hand from here (the rest belong to packing and shipments)."""
    return [m for m in ORDER_TRANSITIONS.get(order.status, ()) if "admin" in m.owners]


# --------------------------------------------------------------- packing

PACKING_LABELS: Dict[str, str] = {
    "pending": "Waiting to pick",
    "picking": "Picking",
    "picked": "Picked",
    "packing": "Packing",
    "packed": "Packed · ready to ship",
    "ready-to-ship": "Handed to shipping",
    "cancelled": "Cancelled",
}
# Jobs still in the warehouse's hands: the active packing queue.
PACKING_OPEN = ("pending", "picking", "picked", "packing", "packed")


# -------------------------------------------------------------- shipments

SHIPMENT_STATUSES: Tuple[str, ...] = (
    "pending",
    "ready-for-pickup",
    "pickup-scheduled",
    "picked-up",
    "in-transit",
    "at-destination-hub",
    "out-for-delivery",
    "delivered",
    "delivery-attempted",
    "delivery-failed",
    "returned-to-origin",
    "cancelled",
)
SHIPMENT_LINE: Tuple[str, ...] = SHIPMENT_STATUSES[:8]
SHIPMENT_TERMINAL = frozenset({"delivered", "returned-to-origin", "cancelled"})
SHIPMENT_BEFORE_PICKUP = frozenset({"pending", "ready-for-pickup", "pickup-scheduled"})
SHIPMENT_EXCEPTIONS = frozenset({"delivery-attempted", "delivery-failed", "returned-to-origin"})

SHIPMENT_LABELS: Dict[str, str] = {
    "pending": "Shipment created",
    "ready-for-pickup": "Ready for pickup",
    "pickup-scheduled": "Pickup scheduled",
    "picked-up": "Picked up",
    "in-transit": "In transit",
    "at-destination-hub": "At destination hub",
    "out-for-delivery": "Out for delivery",
    "delivered": "Delivered",
    "delivery-attempted": "Delivery attempted",
    "delivery-failed": "Delivery failed",
    "returned-to-origin": "Returned to origin",
    "cancelled": "Cancelled",
}

# Shipment status -> the order status it implies.
SHIPMENT_TO_ORDER: Dict[str, str] = {
    "picked-up": "shipped",
    "in-transit": "in-transit",
    "at-destination-hub": "in-transit",
    "out-for-delivery": "out-for-delivery",
    "delivered": "delivered",
}


@dataclass(frozen=True)
class ShipmentMove:
    target: str
    action: str
    kind: str = "forward"  # forward | exception | back | cancel
    reason_required: bool = False


SHIPMENT_TRANSITIONS: Dict[str, Tuple[ShipmentMove, ...]] = {
    # Booking with the courier is in flight; the courier (or Retry) moves it on.
    "pending": (
        ShipmentMove("cancelled", "Cancel shipment", "cancel", True),
    ),
    "ready-for-pickup": (
        ShipmentMove("pickup-scheduled", "Schedule pickup"),
        ShipmentMove("picked-up", "Mark picked up"),
        ShipmentMove("cancelled", "Cancel shipment", "cancel", True),
    ),
    "pickup-scheduled": (
        ShipmentMove("picked-up", "Mark picked up"),
        ShipmentMove("ready-for-pickup", "Pickup cancelled by courier", "back", True),
        ShipmentMove("cancelled", "Cancel shipment", "cancel", True),
    ),
    "picked-up": (
        ShipmentMove("in-transit", "Mark in transit"),
    ),
    "in-transit": (
        ShipmentMove("at-destination-hub", "Reached destination hub"),
        ShipmentMove("delivery-failed", "Report a shipment exception", "exception", True),
    ),
    "at-destination-hub": (
        ShipmentMove("out-for-delivery", "Out for delivery"),
        ShipmentMove("delivery-failed", "Report a shipment exception", "exception", True),
    ),
    "out-for-delivery": (
        ShipmentMove("delivered", "Mark delivered"),
        ShipmentMove("delivery-attempted", "Delivery attempted", "exception", True),
        ShipmentMove("delivery-failed", "Delivery failed", "exception", True),
    ),
    "delivery-attempted": (
        ShipmentMove("out-for-delivery", "Re-attempt delivery"),
        ShipmentMove("returned-to-origin", "Return to origin", "exception", True),
    ),
    "delivery-failed": (
        ShipmentMove("out-for-delivery", "Re-attempt delivery"),
        ShipmentMove("returned-to-origin", "Return to origin", "exception", True),
    ),
    "delivered": (),
    "returned-to-origin": (),
    "cancelled": (),
}


def shipment_label(status: str) -> str:
    return SHIPMENT_LABELS.get(status, status.replace("-", " ").capitalize())


def shipment_moves(status: str) -> Tuple[ShipmentMove, ...]:
    return SHIPMENT_TRANSITIONS.get(status, ())


def check_shipment_move(current: str, target: str, *, reason: str = "") -> ShipmentMove:
    """A manual (admin) shipment move: strictly the table above."""
    if target not in SHIPMENT_STATUSES:
        raise ValidationError(f"'{target}' is not a shipment status.", error_code="INVALID_STATUS")
    if current in SHIPMENT_TERMINAL:
        raise ConflictError(f"This shipment is {shipment_label(current).lower()}; it can't move any more.",
                            error_code="SHIPMENT_CLOSED")
    move = next((m for m in shipment_moves(current) if m.target == target), None)
    if move is None:
        options = [shipment_label(m.target) for m in shipment_moves(current) if m.kind != "cancel"]
        if target in SHIPMENT_LINE and current in SHIPMENT_LINE and \
                SHIPMENT_LINE.index(target) > SHIPMENT_LINE.index(current) and \
                SHIPMENT_LINE.index(current) < SHIPMENT_LINE.index("picked-up") < SHIPMENT_LINE.index(target):
            message = f"Shipment cannot move to {shipment_label(target)} before pickup."
        elif current == "pending":
            message = ("This shipment is still being booked with the courier. "
                       "It moves on once the courier confirms it (or use Retry).")
        else:
            message = f"Shipment cannot move from {shipment_label(current)} to {shipment_label(target)}."
        if options and current != "pending":
            message += f" Next: {' or '.join(options)}."
        raise ConflictError(message, error_code="INVALID_SHIPMENT_TRANSITION",
                            details={"from": current, "to": target})
    if move.reason_required and len((reason or "").strip()) < 3:
        raise ValidationError(f"{move.action} needs a reason.", error_code="REASON_REQUIRED",
                              details={"field": "reason"})
    return move


def courier_can_move(current: str, new: str) -> bool:
    """
    Whether a courier update (webhook, poll, or a recorded scan) may move a
    shipment from `current` to `new`. Looser than the manual table: a courier
    can skip scans, but never moves backwards along the line or out of a
    terminal state.
    """
    if not new or new == current or new not in SHIPMENT_STATUSES or new == "pending":
        return False
    if current in SHIPMENT_TERMINAL:
        return False
    if new == "cancelled":
        return current in SHIPMENT_BEFORE_PICKUP
    if current in ("delivery-failed", "delivery-attempted"):
        return new in ("in-transit", "at-destination-hub", "out-for-delivery", "delivered", "returned-to-origin",
                       "delivery-failed", "delivery-attempted")
    if new == "delivery-failed":
        return current not in ("pending",)
    if new == "returned-to-origin":
        return current != "pending"
    if new == "delivery-attempted":
        return current in ("picked-up", "in-transit", "at-destination-hub", "out-for-delivery")
    if current in SHIPMENT_LINE and new in SHIPMENT_LINE:
        return SHIPMENT_LINE.index(new) > SHIPMENT_LINE.index(current)
    return False


# --------------------------------------------------------------- lifecycle

@dataclass(frozen=True)
class Step:
    key: str
    label: str
    optional: bool = False
    phase: str = "order"  # order | packing | shipment


STEPS: Tuple[Step, ...] = (
    Step("placed", "Order placed"),
    Step("confirmed", "Confirmed"),
    Step("picking", "Picking", phase="packing"),
    Step("packing", "Packing", phase="packing"),
    Step("packed", "Packed", phase="packing"),
    Step("shipment-created", "Shipment created", phase="shipment"),
    Step("ready-for-pickup", "Ready for pickup", phase="shipment"),
    Step("pickup-scheduled", "Pickup scheduled", optional=True, phase="shipment"),
    Step("picked-up", "Picked up", phase="shipment"),
    Step("in-transit", "In transit", phase="shipment"),
    Step("at-destination-hub", "At destination hub", optional=True, phase="shipment"),
    Step("out-for-delivery", "Out for delivery", phase="shipment"),
    Step("delivered", "Delivered", phase="shipment"),
)
STEP_KEYS = tuple(s.key for s in STEPS)
_SHIPMENT_STEP = {"pending": "shipment-created", "ready-for-pickup": "ready-for-pickup",
                  "pickup-scheduled": "pickup-scheduled", "picked-up": "picked-up", "in-transit": "in-transit",
                  "at-destination-hub": "at-destination-hub", "out-for-delivery": "out-for-delivery",
                  "delivered": "delivered"}
_LEGACY_ORDER_STEP = {"shipped": "picked-up", "in-transit": "in-transit", "out-for-delivery": "out-for-delivery",
                      "delivered": "delivered"}
_JOB_STEP = {"pending": "confirmed", "picking": "picking", "picked": "picking", "packing": "packing",
             "packed": "packed", "ready-to-ship": "packed"}
_ORDER_STEP = {"pending": "placed", "confirmed": "confirmed", "processing": "picking", "packed": "packed"}


def _step_for(order_status: str, job_status: Optional[str], shipment_status: Optional[str],
              seen: Iterable[str]) -> Tuple[str, bool]:
    """(the step the order is on, whether its shipment steps have no record behind them)."""
    if shipment_status and shipment_status != "cancelled":
        if shipment_status in _SHIPMENT_STEP:
            return _SHIPMENT_STEP[shipment_status], False
        # An exception: it happened after the furthest main-line step reached.
        reached = [s for s in seen if s in _SHIPMENT_STEP]
        furthest = max(reached, key=lambda s: SHIPMENT_LINE.index(s), default="pending")
        return _SHIPMENT_STEP[furthest], False
    if order_status in _LEGACY_ORDER_STEP:
        return _LEGACY_ORDER_STEP[order_status], True
    if job_status and job_status != "cancelled" and order_status in ("confirmed", "processing", "packed"):
        return _JOB_STEP.get(job_status, _ORDER_STEP.get(order_status, "placed")), False
    return _ORDER_STEP.get(order_status, "placed"), False


def lifecycle(*, order_status: str, job_status: Optional[str] = None, shipment_status: Optional[str] = None,
              shipment_seen: Sequence[str] = (), cancelled_from: str = "", had_job: bool = False) -> dict:
    """
    The order's progress along every step, each marked completed, current,
    upcoming, skipped, exception or cancelled. Derived from where the records
    *are now*, so a step moved back (a repack) reads as not done again.

    `shipment_seen` is every status the shipment has had; `cancelled_from` the
    order status before a cancellation.
    """
    seen = set(shipment_seen) | ({shipment_status} if shipment_status else set())
    exception = shipment_status if shipment_status in SHIPMENT_EXCEPTIONS else ""
    terminal = ""
    if order_status == "cancelled":
        terminal = "cancelled"
        step, legacy = _step_for(cancelled_from or "pending", job_status if job_status != "cancelled" else None,
                                 None, ())
        if cancelled_from == "processing" and job_status in (None, "cancelled"):
            step = "picking"
    elif order_status == "returned":
        terminal = "returned"
        step, legacy = _step_for(order_status, job_status, shipment_status, seen)
    else:
        step, legacy = _step_for(order_status, job_status, shipment_status, seen)

    current = STEP_KEYS.index(step)
    if exception in ("delivery-attempted", "delivery-failed"):
        # Delivery has to be tried again: out for delivery is ahead, not behind.
        ofd = STEP_KEYS.index("out-for-delivery")
        current = min(current, ofd - 1) if "out-for-delivery" in seen else current
    steps = []
    finished = bool(terminal or exception or step == "delivered")
    for index, info in enumerate(STEPS):
        if index < current or (index == current and finished):
            state = "completed"
            if info.optional and info.key not in seen:
                state = "skipped"
            elif legacy and info.phase == "shipment":
                state = "skipped"
            elif info.phase == "packing" and not had_job and order_status not in ("pending", "confirmed"):
                state = "skipped"
        elif index == current:
            state = "current"
        else:
            state = "cancelled" if terminal or exception == "returned-to-origin" else "upcoming"
        steps.append({"key": info.key, "label": info.label, "phase": info.phase, "optional": info.optional,
                      "state": state})
    if exception:
        steps.insert(current + 1, {"key": exception, "label": shipment_label(exception), "phase": "shipment",
                                   "optional": False, "state": "exception"})
    if terminal:
        steps.insert(current + 1 + (1 if exception else 0),
                     {"key": terminal, "label": label(terminal), "phase": "order", "optional": False,
                      "state": "cancelled" if terminal == "cancelled" else "exception"})
    return {"currentStep": step, "exception": exception, "terminal": terminal, "legacy": legacy, "steps": steps}
