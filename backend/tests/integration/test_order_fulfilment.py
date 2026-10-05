"""
The order page's fulfilment view and actions (`GET/POST
/api/admin/orders/{id}/fulfilment`), and the Shipments page's pipeline
(`GET /api/admin/shipments/pipeline`). See docs/order-fulfilment.md.

The end-to-end flow: confirmed → packing → packed → shipment → delivered, the
next actions offered at each step (and only those), controlled backward
moves with reasons, the history across order, packing and shipment, legacy
orders without records, payment and permission guards.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app.models import Order, OrderEvent
from tests.integration.fulfilment_helpers import _shipment, advance, manual_courier
from tests.integration.test_shipping_helpers import place_order
from tests.integration.test_suppliers_helpers import role_headers

pytestmark = pytest.mark.integration


def view(client, headers, order_id):
    response = client.get(f"/api/admin/orders/{order_id}/fulfilment", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def act(client, headers, order_id, action, expect=200, **body):
    response = client.post(f"/api/admin/orders/{order_id}/fulfilment/actions", headers=headers,
                           json={"action": action, **body})
    assert response.status_code == expect, response.text
    return response.json()


def keys(data):
    return [a["key"] for a in data["nextActions"]]


def primary(data):
    return next(a for a in data["nextActions"] if a["primary"])


def step(data, key):
    return next(s for s in data["progress"]["steps"] if s["key"] == key)["state"]


@pytest.fixture()
def order(client, auth, catalogue, settings_documents):
    return place_order(client, auth)


class TestTheFlowFromTheOrderPage:
    def test_a_confirmed_order_offers_move_to_packing(self, client, admin_auth, order):
        data = view(client, admin_auth, order["id"])
        assert data["order"]["status"] == "confirmed"
        assert data["progress"]["currentStep"] == "confirmed"
        assert primary(data)["key"] == "start-packing" and primary(data)["label"] == "Move to packing"
        assert "cancel" in keys(data) and "create-shipment" not in keys(data)
        assert data["packing"]["status"] == "pending" and data["shipment"] is None
        assert step(data, "picking") == "upcoming" and step(data, "delivered") == "upcoming"

    def test_each_step_offers_only_the_next_one(self, client, admin_auth, order):
        done = act(client, admin_auth, order["id"], "start-packing")
        data = done["data"]
        assert data["order"]["status"] == "processing" and primary(data)["key"] == "open-packing"
        assert primary(data)["label"] == "Continue picking"

        advance(client, admin_auth, order["id"], "packed")
        data = view(client, admin_auth, order["id"])
        assert primary(data)["key"] == "create-shipment"
        assert primary(data)["allowed"] is False and "No courier" in primary(data)["blockedReason"]
        manual_courier(client, admin_auth)
        data = view(client, admin_auth, order["id"])
        assert primary(data)["allowed"] is True and "repack" in keys(data)

        _shipment(client, admin_auth, order["id"])
        data = view(client, admin_auth, order["id"])
        assert data["shipment"]["status"] == "ready-for-pickup"
        assert data["progress"]["currentStep"] == "ready-for-pickup"
        assert primary(data)["kind"] == "shipment" and primary(data)["target"] == "pickup-scheduled"
        cancel = next(a for a in data["nextActions"] if a["key"] == "cancel")
        assert cancel["allowed"] is False and "Cancel shipment" in cancel["blockedReason"]
        assert "repack" not in keys(data) and "create-shipment" not in keys(data)

        advance(client, admin_auth, order["id"], "delivered")
        data = view(client, admin_auth, order["id"])
        assert data["nextActions"] == []
        assert all(s["state"] in ("completed", "skipped") for s in data["progress"]["steps"])
        assert step(data, "pickup-scheduled") == "skipped"

    def test_starting_packing_needs_a_payment_that_allows_it(self, client, admin_auth, order, db):
        db.get(Order, order["id"]).payment_status = "failed"
        db.flush()
        data = view(client, admin_auth, order["id"])
        start = next(a for a in data["nextActions"] if a["key"] == "start-packing")
        assert start["allowed"] is False and start["blockedReason"] == "Order cannot be packed because payment is failed."
        refused = act(client, admin_auth, order["id"], "start-packing", expect=409)
        assert refused["error_code"] == "PAYMENT_REQUIRED"

    def test_repacking_from_the_order_page_needs_a_reason(self, client, admin_auth, order, db):
        advance(client, admin_auth, order["id"], "packed")
        assert act(client, admin_auth, order["id"], "repack", expect=422)["error_code"] == "REASON_REQUIRED"
        data = act(client, admin_auth, order["id"], "repack", reason="Package damaged")["data"]
        assert data["order"]["status"] == "processing" and data["packing"]["status"] == "packing"
        assert step(data, "packed") == "upcoming"
        moved_back = [h for h in data["history"] if h["kind"] == "order" and h["title"] == "Moved back to packing"]
        assert moved_back and moved_back[-1]["reason"] == "Package damaged"

    def test_cancel_and_return_to_origin(self, client, admin_auth, order, db):
        advance(client, admin_auth, order["id"], "out-for-delivery")
        shipment = _shipment(client, admin_auth, order["id"])
        for status, reason in (("delivery-attempted", "Nobody home"), ("returned-to-origin", "Refused")):
            client.post(f"/api/admin/shipments/{shipment}/status", headers=admin_auth,
                        json={"status": status, "reason": reason})
        data = view(client, admin_auth, order["id"])
        assert {"record-return", "create-shipment"} <= set(keys(data))
        assert data["progress"]["exception"] == "returned-to-origin"
        assert act(client, admin_auth, order["id"], "record-return", expect=422)["error_code"] == "REASON_REQUIRED"
        data = act(client, admin_auth, order["id"], "record-return", reason="Back in the warehouse")["data"]
        assert data["order"]["status"] == "returned" and data["nextActions"] == []

    def test_unknown_actions_are_refused(self, client, admin_auth, order):
        assert act(client, admin_auth, order["id"], "teleport", expect=422)["error_code"] == "INVALID_ACTION"


class TestHistory:
    def test_one_history_across_order_packing_and_shipment(self, client, admin_auth, order, db):
        advance(client, admin_auth, order["id"], "shipped")
        data = view(client, admin_auth, order["id"])
        kinds = {h["kind"] for h in data["history"]}
        assert kinds == {"order", "packing", "shipment"}
        titles = [h["title"] for h in data["history"]]
        for expected in ("Order placed", "Added to the packing queue", "Moved to packing", "Picking completed",
                         "Order packed", "Shipped: picked up by the courier", "Shipment picked up"):
            assert expected in titles, expected
        shipped = next(h for h in data["history"] if h["kind"] == "order" and h["status"] == "shipped")
        assert shipped["source"] == "shipment" and shipped["entity"]["type"] == "shipment"
        assert shipped["actorName"]  # an admin's name, never blank
        assert [h["at"] for h in data["history"]] == sorted(h["at"] for h in data["history"])

    def test_events_are_never_overwritten(self, client, admin_auth, order, db):
        advance(client, admin_auth, order["id"], "packed")
        act(client, admin_auth, order["id"], "repack", reason="Wrong size packed")
        advance(client, admin_auth, order["id"], "packed")
        statuses = list(db.execute(select(OrderEvent.status).where(OrderEvent.order_id == order["id"])
                                   .order_by(OrderEvent.id)).scalars())
        assert statuses[-5:] == ["confirmed", "processing", "packed", "processing", "packed"]


class TestLegacyData:
    def test_an_order_dispatched_without_a_shipment_is_flagged_and_can_record_one(self, client, admin_auth, order,
                                                                                   db):
        db.get(Order, order["id"]).status = "shipped"  # moved by hand before shipments were required
        db.flush()
        manual_courier(client, admin_auth)
        data = view(client, admin_auth, order["id"])
        assert [w["code"] for w in data["warnings"]] == ["NO_SHIPMENT_RECORD"]
        assert data["progress"]["legacy"] is True and step(data, "shipment-created") == "skipped"
        record = next(a for a in data["nextActions"] if a["key"] == "create-shipment")
        assert record["label"] == "Record missing shipment" and record["allowed"] is True
        overview = client.get(f"/api/admin/orders/{order['id']}/shipping", headers=admin_auth).json()["data"]
        assert overview["canCreate"] is True and overview["createMode"] == "record-missing"
        _shipment(client, admin_auth, order["id"])
        assert view(client, admin_auth, order["id"])["warnings"] == []

    def test_nothing_is_fabricated(self, client, admin_auth, order, db):
        from app.models.shipping import Shipment

        db.get(Order, order["id"]).status = "delivered"
        db.flush()
        view(client, admin_auth, order["id"])
        client.get("/api/admin/shipments/pipeline", headers=admin_auth)
        assert db.execute(select(Shipment)).first() is None


class TestPipeline:
    def test_ready_to_ship_and_missing_shipments(self, client, auth, admin_auth, order, db):
        advance(client, admin_auth, order["id"], "packed")
        legacy = place_order(client, auth)
        db.get(Order, legacy["id"]).status = "in-transit"
        delivered = place_order(client, auth)
        db.get(Order, delivered["id"]).status = "delivered"
        db.flush()
        data = client.get("/api/admin/shipments/pipeline", headers=admin_auth).json()["data"]
        assert data["readyToShip"]["count"] == 1
        assert data["readyToShip"]["items"][0]["orderId"] == order["id"]
        assert data["readyToShip"]["items"][0]["packageCount"] == 1
        assert [i["orderId"] for i in data["missingShipments"]["items"]] == [legacy["id"]]
        assert data["deliveredWithoutShipment"] == 1 and data["couriersActive"] is False

    def test_a_shipped_order_leaves_ready_to_ship(self, client, admin_auth, order):
        advance(client, admin_auth, order["id"], "packed")
        _shipment(client, admin_auth, order["id"])
        data = client.get("/api/admin/shipments/pipeline", headers=admin_auth).json()["data"]
        assert data["readyToShip"]["count"] == 0
        listed = client.get("/api/admin/shipments", headers=admin_auth).json()["data"]
        assert listed["pagination"]["total"] == 1
        row = listed["items"][0]
        assert row["orderStatus"] == "packed" and row["nextAction"]["status"] == "pickup-scheduled"

    def test_the_packing_queue_never_lists_shipped_orders(self, client, admin_auth, order):
        advance(client, admin_auth, order["id"], "in-transit")
        queue = client.get("/api/admin/packing", headers=admin_auth).json()["data"]
        assert queue["items"] == []


class TestPermissions:
    def test_a_role_without_packing_or_orders_sees_nothing_it_can_do(self, client, order, db):
        headers = role_headers(db, "ADM901", "editor")
        data = view(client, headers, order["id"])
        assert data["nextActions"] and not any(a["allowed"] for a in data["nextActions"])
        assert act(client, headers, order["id"], "start-packing", expect=403)["error_code"] == "PERMISSION_DENIED"
        assert act(client, headers, order["id"], "cancel", expect=403)["error_code"] == "PERMISSION_DENIED"

    def test_staff_may_pack(self, client, order, db):
        headers = role_headers(db, "ADM902", "staff", permissions=["orders", "packing", "shipments"])
        assert act(client, headers, order["id"], "start-packing")["data"]["order"]["status"] == "processing"
