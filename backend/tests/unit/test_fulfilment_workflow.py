"""
The fulfilment lifecycle (`services/fulfilment/workflow.py`,
docs/order-fulfilment.md): every order and shipment transition, valid and
invalid, who may make it, the business guards, and the progress steps.

Pure functions: no database.
"""

from __future__ import annotations

from itertools import product
from types import SimpleNamespace

import pytest

from app.core.errors import ConflictError, ValidationError
from app.services.fulfilment import workflow as wf


def order(status, *, payment="paid", stock="consumed"):
    return SimpleNamespace(status=status, payment_status=payment, stock_state=stock)


def ok(status, target, source, **kw):
    return wf.check_order_move(order(status, **{k: kw.pop(k) for k in ("payment", "stock") if k in kw}),
                               target, source, **kw)


def refused(status, target, source="admin", code=None, **kw):
    with pytest.raises((ConflictError, ValidationError)) as caught:
        ok(status, target, source, **kw)
    if code:
        assert caught.value.error_code == code, caught.value.message
    return caught.value


# ------------------------------------------------------------- the order


VALID = [
    ("pending", "confirmed", "admin", {}),
    ("pending", "confirmed", "payment", {}),
    ("pending", "cancelled", "admin", {}),
    ("pending", "cancelled", "customer", {}),
    ("confirmed", "processing", "packing", {}),
    ("confirmed", "cancelled", "admin", {}),
    ("confirmed", "cancelled", "customer", {}),
    ("processing", "packed", "packing", {}),
    ("processing", "cancelled", "admin", {"reason": "Customer called"}),
    ("packed", "processing", "packing", {"reason": "Box damaged"}),
    ("packed", "cancelled", "admin", {"reason": "Customer called"}),
    ("packed", "shipped", "shipment", {}),
    ("shipped", "in-transit", "shipment", {}),
    ("in-transit", "out-for-delivery", "shipment", {}),
    ("out-for-delivery", "delivered", "shipment", {}),
    ("out-for-delivery", "returned", "admin", {"reason": "Refused", "latest_shipment_status": "returned-to-origin"}),
    ("in-transit", "returned", "admin", {"reason": "Lost", "latest_shipment_status": "returned-to-origin"}),
    ("shipped", "returned", "admin", {"reason": "Lost", "latest_shipment_status": "returned-to-origin"}),
    # A courier may pass over a scan it never sent.
    ("packed", "in-transit", "shipment", {}),
    ("shipped", "delivered", "shipment", {}),
]


@pytest.mark.parametrize(("status", "target", "source", "kw"), VALID)
def test_valid_order_moves(status, target, source, kw):
    move = ok(status, target, source, **kw)
    assert move is not None and move.target == target


def test_the_same_status_is_no_move():
    assert ok("packed", "packed", "admin") is None


ALL = list(wf.ORDER_FLOW) + ["cancelled", "returned"]
ALLOWED = {(s, t, src) for s, t, src, _ in VALID}


@pytest.mark.parametrize(("status", "target"), [(s, t) for s, t in product(ALL, ALL) if s != t])
def test_an_admin_can_only_confirm_cancel_or_record_a_return(status, target):
    """Every other order move by hand is refused, whatever it is."""
    if (status, target, "admin") in ALLOWED:
        return
    error = refused(status, target, "admin", reason="A good reason", latest_shipment_status="returned-to-origin")
    assert error.error_code in ("INVALID_TRANSITION", "WORKFLOW_OWNED", "ORDER_NOT_CANCELLABLE")


@pytest.mark.parametrize(("status", "target", "message"), [
    ("pending", "shipped", "directly from Pending to Shipped"),
    ("pending", "delivered", "directly from Pending to Delivered"),
    ("confirmed", "delivered", "directly from Confirmed to Delivered"),
    ("confirmed", "packed", "directly from Confirmed to Packed"),
    ("processing", "shipped", "directly from Packing to Shipped"),
    ("packed", "delivered", "directly from Packed to Delivered"),
])
def test_skipping_says_what_it_skips(status, target, message):
    error = refused(status, target, "admin", code="INVALID_TRANSITION")
    assert message in error.message and "must go through" in error.message


@pytest.mark.parametrize(("status", "target"), [
    ("confirmed", "processing"), ("processing", "packed"), ("packed", "shipped"), ("shipped", "in-transit"),
    ("in-transit", "out-for-delivery"), ("out-for-delivery", "delivered"),
])
def test_owned_stages_refuse_an_admin(status, target):
    refused(status, target, "admin", code="WORKFLOW_OWNED")


def test_packing_cannot_ship_and_a_shipment_cannot_pack():
    refused("packed", "shipped", "packing", code="WORKFLOW_OWNED")
    refused("confirmed", "processing", "shipment", code="WORKFLOW_OWNED")


def test_a_courier_never_moves_an_order_backwards_or_out_of_packing():
    refused("in-transit", "shipped", "shipment", code="INVALID_TRANSITION")
    refused("processing", "shipped", "shipment", code="INVALID_TRANSITION")


@pytest.mark.parametrize("terminal", ["cancelled", "returned"])
@pytest.mark.parametrize("target", ALL)
def test_cancelled_and_returned_are_final(terminal, target):
    if target == terminal:
        return
    refused(terminal, target, "admin", code="INVALID_TRANSITION")


def test_delivered_is_final_and_cannot_be_cancelled():
    refused("delivered", "cancelled", "admin", code="ORDER_NOT_CANCELLABLE", reason="Too late")
    refused("delivered", "returned", "admin", code="INVALID_TRANSITION", reason="Sent back",
            latest_shipment_status="returned-to-origin")
    refused("delivered", "out-for-delivery", "shipment", code="INVALID_TRANSITION")


@pytest.mark.parametrize("status", ["shipped", "in-transit", "out-for-delivery"])
def test_dispatched_orders_cannot_be_cancelled(status):
    error = refused(status, "cancelled", "admin", code="ORDER_NOT_CANCELLABLE", reason="Changed mind")
    assert "after shipment pickup" in error.message


def test_cancelling_after_picking_needs_a_reason():
    refused("processing", "cancelled", "admin", code="REASON_REQUIRED")
    refused("packed", "cancelled", "admin", code="REASON_REQUIRED", reason=" x ")


def test_customers_cancel_only_before_picking():
    refused("processing", "cancelled", "customer", code="ORDER_NOT_CANCELLABLE", reason="Changed")
    refused("packed", "cancelled", "customer", code="ORDER_NOT_CANCELLABLE", reason="Changed")


def test_an_open_shipment_blocks_cancelling():
    refused("packed", "cancelled", "admin", code="SHIPMENT_ACTIVE", reason="Changed",
            active_shipment="DCZ-SH-2026-000001")


def test_returned_needs_the_parcel_back_at_origin():
    refused("out-for-delivery", "returned", "admin", code="RETURN_NOT_ALLOWED", reason="Refused",
            latest_shipment_status="delivery-attempted")
    refused("out-for-delivery", "returned", "admin", code="REASON_REQUIRED",
            latest_shipment_status="returned-to-origin")


def test_repacking_needs_a_reason():
    refused("packed", "processing", "packing", code="REASON_REQUIRED")


# ------------------------------------------------- payment and stock guards


@pytest.mark.parametrize("payment", ["pending", "failed", "expired", "refunded"])
def test_packing_needs_a_payment_that_allows_it(payment):
    error = refused("confirmed", "processing", "packing", code="PAYMENT_REQUIRED", payment=payment)
    assert error.message == f"Order cannot be packed because payment is {payment}."


@pytest.mark.parametrize("payment", ["paid", "cod-pending", "partially-refunded"])
def test_paid_or_cash_on_delivery_may_be_packed(payment):
    assert ok("confirmed", "processing", "packing", payment=payment) is not None


def test_stock_must_be_committed_to_pack():
    refused("confirmed", "processing", "packing", code="STOCK_NOT_COMMITTED", stock="released")


def test_a_reserved_unpaid_order_waits_for_its_payment():
    refused("pending", "confirmed", "admin", code="AWAITING_PAYMENT", payment="pending", stock="reserved")
    assert ok("pending", "confirmed", "payment", payment="paid", stock="reserved") is not None
    assert ok("pending", "cancelled", "payment", payment="pending", stock="reserved") is not None


def test_confirming_needs_a_payment_or_cash_on_delivery():
    refused("pending", "confirmed", "admin", code="PAYMENT_REQUIRED", payment="failed")
    assert ok("pending", "confirmed", "admin", payment="cod-pending") is not None


@pytest.mark.parametrize("target", ["shipping", "", "PENDING", "lost"])
def test_unknown_status(target):
    refused("pending", target, "admin", code="INVALID_STATUS")


def test_an_unknown_source_is_a_programming_error():
    with pytest.raises(ValueError):
        ok("pending", "confirmed", "robot")


def test_admin_moves_offered():
    assert [m.target for m in wf.admin_order_moves(order("pending"))] == ["confirmed", "cancelled"]
    assert [m.target for m in wf.admin_order_moves(order("processing"))] == ["cancelled"]
    assert [m.target for m in wf.admin_order_moves(order("in-transit"))] == ["returned"]
    assert wf.admin_order_moves(order("delivered")) == []


# ----------------------------------------------------------- shipments


SHIPMENT_VALID = [
    ("pending", "cancelled"),
    ("ready-for-pickup", "pickup-scheduled"), ("ready-for-pickup", "picked-up"), ("ready-for-pickup", "cancelled"),
    ("pickup-scheduled", "picked-up"), ("pickup-scheduled", "ready-for-pickup"), ("pickup-scheduled", "cancelled"),
    ("picked-up", "in-transit"),
    ("in-transit", "at-destination-hub"), ("in-transit", "delivery-failed"),
    ("at-destination-hub", "out-for-delivery"), ("at-destination-hub", "delivery-failed"),
    ("out-for-delivery", "delivered"), ("out-for-delivery", "delivery-attempted"),
    ("out-for-delivery", "delivery-failed"),
    ("delivery-attempted", "out-for-delivery"), ("delivery-attempted", "returned-to-origin"),
    ("delivery-failed", "out-for-delivery"), ("delivery-failed", "returned-to-origin"),
]


@pytest.mark.parametrize(("current", "target"), [(c, t) for c, t in product(wf.SHIPMENT_STATUSES, repeat=2)
                                                 if c != t])
def test_manual_shipment_moves(current, target):
    if (current, target) in SHIPMENT_VALID:
        assert wf.check_shipment_move(current, target, reason="Courier said so").target == target
        return
    with pytest.raises(ConflictError) as caught:
        wf.check_shipment_move(current, target, reason="Courier said so")
    assert caught.value.error_code in ("INVALID_SHIPMENT_TRANSITION", "SHIPMENT_CLOSED")


def test_out_for_delivery_before_pickup_says_so():
    with pytest.raises(ConflictError) as caught:
        wf.check_shipment_move("ready-for-pickup", "out-for-delivery")
    assert caught.value.message.startswith("Shipment cannot move to Out for delivery before pickup.")


@pytest.mark.parametrize(("current", "target"), [
    ("pickup-scheduled", "ready-for-pickup"), ("out-for-delivery", "delivery-attempted"),
    ("delivery-failed", "returned-to-origin"), ("ready-for-pickup", "cancelled"),
])
def test_exceptions_and_backward_moves_need_a_reason(current, target):
    with pytest.raises(ValidationError) as caught:
        wf.check_shipment_move(current, target, reason="")
    assert caught.value.error_code == "REASON_REQUIRED"


@pytest.mark.parametrize(("current", "new", "allowed"), [
    ("ready-for-pickup", "in-transit", True),  # a missed pickup scan
    ("pending", "delivered", True),
    ("in-transit", "picked-up", False),  # never backwards
    ("delivered", "in-transit", False),
    ("picked-up", "cancelled", False),
    ("delivery-failed", "out-for-delivery", True),
    ("delivery-attempted", "out-for-delivery", True),
    ("pending", "returned-to-origin", False),
    ("in-transit", "pending", False),
])
def test_courier_moves(current, new, allowed):
    assert wf.courier_can_move(current, new) is allowed


# ----------------------------------------------------------- lifecycle


def states(**kw):
    return {s["key"]: s["state"] for s in wf.lifecycle(**kw)["steps"]}


def test_confirmed_waits_for_picking():
    got = states(order_status="confirmed", job_status="pending", had_job=True)
    assert got["placed"] == "completed" and got["confirmed"] == "current"
    assert got["picking"] == "upcoming" and got["delivered"] == "upcoming"


def test_packed_never_shows_future_steps_as_done():
    got = states(order_status="packed", job_status="packed", had_job=True)
    assert got["packed"] == "current" and got["shipment-created"] == "upcoming"


def test_a_shipment_in_transit_marks_unvisited_optional_steps_skipped():
    got = states(order_status="in-transit", job_status="ready-to-ship", shipment_status="in-transit",
                 shipment_seen=["pending", "ready-for-pickup", "picked-up", "in-transit"], had_job=True)
    assert got["pickup-scheduled"] == "skipped" and got["picked-up"] == "completed"
    assert got["in-transit"] == "current" and got["out-for-delivery"] == "upcoming"


def test_a_delivery_attempt_is_an_exception_with_delivery_still_ahead():
    result = wf.lifecycle(order_status="out-for-delivery", job_status="ready-to-ship",
                          shipment_status="delivery-attempted", had_job=True,
                          shipment_seen=["pending", "ready-for-pickup", "picked-up", "in-transit",
                                         "at-destination-hub", "out-for-delivery", "delivery-attempted"])
    keys = [s["key"] for s in result["steps"]]
    got = {s["key"]: s["state"] for s in result["steps"]}
    assert result["exception"] == "delivery-attempted" and got["delivery-attempted"] == "exception"
    assert keys.index("delivery-attempted") < keys.index("out-for-delivery")
    assert got["out-for-delivery"] == "upcoming" and got["delivered"] == "upcoming"


def test_delivered_is_all_complete():
    got = states(order_status="delivered", job_status="ready-to-ship", shipment_status="delivered", had_job=True,
                 shipment_seen=["pending", "ready-for-pickup", "pickup-scheduled", "picked-up", "in-transit",
                                "at-destination-hub", "out-for-delivery", "delivered"])
    assert set(got.values()) == {"completed"}


def test_a_cancelled_order_shows_where_it_stopped():
    result = wf.lifecycle(order_status="cancelled", job_status="cancelled", cancelled_from="processing",
                          had_job=True)
    got = {s["key"]: s["state"] for s in result["steps"]}
    assert got["confirmed"] == "completed" and got["picking"] == "completed"
    assert got["cancelled"] == "cancelled" and got["packed"] == "cancelled"


def test_a_legacy_order_shipped_without_records_is_marked_skipped():
    result = wf.lifecycle(order_status="shipped")
    got = {s["key"]: s["state"] for s in result["steps"]}
    assert result["legacy"] is True
    assert got["picking"] == "skipped" and got["shipment-created"] == "skipped" and got["picked-up"] == "current"


def test_repacking_shows_packed_as_not_done_again():
    got = states(order_status="processing", job_status="packing", had_job=True)
    assert got["packing"] == "current" and got["packed"] == "upcoming"
