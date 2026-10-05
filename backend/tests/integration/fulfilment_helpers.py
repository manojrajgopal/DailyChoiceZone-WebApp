"""
Shared helper (no tests of its own): take an order to a status the way the
store really does it (docs/order-fulfilment.md).

The order status endpoint no longer moves an order to Packing, Packed or any
shipping stage: packing and shipments do. So a test that needs a delivered
order confirms it, picks and packs it, books a Manual-courier shipment and
walks the shipment, through the same API calls the portal makes.
"""

from __future__ import annotations

from app.services.fulfilment.workflow import ORDER_FLOW

ORIGIN = {"name": "DCZ Warehouse", "phone": "9876500099", "line1": "12 Industrial Area", "line2": "",
          "city": "Bengaluru", "state": "Karnataka", "pincode": "560058"}
BOX = {"weightGrams": 800, "lengthCm": 30, "widthCm": 20, "heightCm": 5, "type": "box"}
# Shipment steps, and the order status each leaves the order in.
SHIPMENT_WALK = (("picked-up", "shipped"), ("in-transit", "in-transit"), ("at-destination-hub", "in-transit"),
                 ("out-for-delivery", "out-for-delivery"), ("delivered", "delivered"))


def _ok(response, expect=(200, 201)):
    expect = (expect,) if isinstance(expect, int) else expect
    assert response.status_code in expect, response.text
    return response.json().get("data")


def _status(client, headers, order_id: str) -> str:
    return _ok(client.get(f"/api/admin/orders/{order_id}", headers=headers))["status"]


def manual_courier(client, headers) -> None:
    """Switch the Manual courier on (idempotent)."""
    _ok(client.put("/api/admin/shipping/providers/manual", headers=headers, json={
        "active": True, "isDefault": True, "settings": {"services": ["Surface"], "defaultService": "Surface",
                                                        "origin": ORIGIN}}))


def _job(client, headers, order_id: str) -> dict:
    job = _ok(client.get(f"/api/admin/orders/{order_id}/packing", headers=headers))["job"]
    assert job is not None, "the order has no packing job"
    return job


def _shipment(client, headers, order_id: str) -> int:
    overview = _ok(client.get(f"/api/admin/orders/{order_id}/shipping", headers=headers))
    if overview["activeShipmentId"]:
        return overview["activeShipmentId"]
    manual_courier(client, headers)
    created = _ok(client.post("/api/admin/shipments", headers=headers, json={
        "orderId": order_id, "providerCode": "manual", "service": "Surface", "courierName": "Local Express",
        "awb": f"LX-{order_id}"[:40], "package": {**BOX, "count": 1}, "idempotencyKey": f"walk-{order_id}"}))
    return created["id"]


def _move_shipment(client, headers, shipment_id: int, status: str, reason: str = "") -> None:
    _ok(client.post(f"/api/admin/shipments/{shipment_id}/status", headers=headers,
                    json={"status": status, "reason": reason}))


def advance(client, headers, order_id: str, target: str) -> None:
    """Take `order_id` to `target` (any order status) through the real workflow."""
    current = _status(client, headers, order_id)
    if current == target:
        return
    if target == "cancelled":
        body = {"status": "cancelled", "reason": "Cancelled in a test"}
        _ok(client.put(f"/api/admin/orders/{order_id}/status", headers=headers, json=body))
        return
    if target == "returned":
        advance(client, headers, order_id, "out-for-delivery")
        shipment = _shipment(client, headers, order_id)
        _move_shipment(client, headers, shipment, "delivery-attempted", "Nobody home")
        _move_shipment(client, headers, shipment, "returned-to-origin", "Refused by the customer")
        _ok(client.put(f"/api/admin/orders/{order_id}/status", headers=headers,
                       json={"status": "returned", "reason": "Back at the warehouse"}))
        return

    goal = ORDER_FLOW.index(target)
    if current == "pending":
        _ok(client.put(f"/api/admin/orders/{order_id}/status", headers=headers, json={"status": "confirmed"}))
    if goal <= ORDER_FLOW.index("confirmed"):
        return
    job = _job(client, headers, order_id)
    base = f"/api/admin/packing/{job['id']}"
    if job["status"] == "pending":
        _ok(client.post(f"{base}/start-picking", headers=headers))
    if goal <= ORDER_FLOW.index("processing"):
        return
    if job["status"] in ("pending", "picking"):
        _ok(client.post(f"{base}/pick-all", headers=headers))
        _ok(client.post(f"{base}/complete-picking", headers=headers))
    if job["status"] in ("pending", "picking", "picked"):
        _ok(client.post(f"{base}/packages", headers=headers, json=dict(BOX)))
    if job["status"] != "packed" and job["status"] != "ready-to-ship":
        _ok(client.post(f"{base}/packed", headers=headers, json={}))
    if goal <= ORDER_FLOW.index("packed"):
        return
    shipment = _shipment(client, headers, order_id)
    steps = [step for step, _ in SHIPMENT_WALK]
    for step, leaves in SHIPMENT_WALK:
        status = _ok(client.get(f"/api/admin/shipments/{shipment}", headers=headers))["status"]
        if status in steps and steps.index(status) >= steps.index(step):
            continue
        _move_shipment(client, headers, shipment, step)
        if leaves == target:
            return
