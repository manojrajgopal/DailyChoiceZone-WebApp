"""
Packing through the API: the job each order gets (and never two), picking
(partial picks, problems, overrides, damaged stock), packages (several per
order, allocation checks, numbering), packing validation, the order moving
forward, cancellation, handing the packages to a shipment, the queue, the
packing slip, the dashboard numbers, audit, and who may do what.
"""

from __future__ import annotations

import re

import pytest
from sqlalchemy import func, select

from app.models import Order, OrderEvent, Product, StockAdjustment
from app.models.fulfilment import PackingEvent, PackingJob, PackingPackage
from app.models.monitoring import AuditLog
from tests.integration.test_packing_helpers import (  # noqa: F401
    BASE,
    BOX,
    call,
    detail,
    job_for,
    packed,
    packing_order,
    picked,
)
from tests.integration.test_shipping_helpers import (  # noqa: F401
    created,
    manual_on,
    place_order,
    shiprocket,
    shiprocket_on,
)
from tests.integration.test_suppliers_helpers import role_headers

pytestmark = pytest.mark.integration


def order_status(db, order_id: str) -> str:
    db.expire_all()
    return db.get(Order, order_id).status


def lines(job: dict) -> dict:
    return {line["sku"]: line for line in job["lines"]}


# ------------------------------------------------------------- the job


class TestJobs:
    def test_a_confirmed_order_gets_one_job_lazily(self, client, admin_auth, packing_order, db):
        queue = call(client, admin_auth, "GET", "")["data"]
        assert [i["orderNumber"] for i in queue["items"]] == [packing_order["orderNumber"]]
        item = queue["items"][0]
        assert item["status"] == "pending" and item["priority"] == "normal"
        assert item["itemCount"] == 3 and item["paymentStatus"] == "cod-pending"
        assert queue["counts"] == {"pending": 1}
        # Reading again (queue, card, summary) never makes a second one.
        call(client, admin_auth, "GET", "")
        job_for(client, admin_auth, packing_order["id"])
        call(client, admin_auth, "GET", "/summary")
        assert db.execute(select(func.count()).select_from(PackingJob)).scalar_one() == 1

    def test_lines_are_the_order_lines(self, client, admin_auth, packing_order):
        job = job_for(client, admin_auth, packing_order["id"])
        by_sku = lines(job)
        assert by_sku["DCZ-WO0001"]["quantity"] == 2 and by_sku["DCZ-WO0001"]["pickedQty"] == 0
        assert by_sku["DCZ-WO0002"]["remainingQty"] == 1
        assert job["actions"]["startPicking"] is True and job["actions"]["markPacked"] is False

    def test_express_delivery_is_high_priority(self, client, auth, admin_auth, catalogue, settings_documents, db):
        order = place_order(client, auth)
        db.get(Order, order["id"]).delivery_method = "express"
        db.flush()
        job = job_for(client, admin_auth, order["id"])
        assert job["priority"] == "high"

    def test_unpaid_orders_get_no_job(self, client, auth, admin_auth, catalogue, settings_documents, db):
        order = place_order(client, auth)
        db.get(Order, order["id"]).status = "pending"
        db.flush()
        response = client.get(f"/api/admin/orders/{order['id']}/packing", headers=admin_auth)
        assert response.status_code == 200 and response.json()["data"]["job"] is None

    def test_unknown_job_and_order(self, client, admin_auth, catalogue):
        assert client.get(f"{BASE}/999999", headers=admin_auth).status_code == 404
        assert client.get("/api/admin/orders/ORD999/packing", headers=admin_auth).status_code == 404


# ------------------------------------------------------------- picking


class TestPicking:
    def test_start_picking_moves_the_order_to_processing_once(self, client, admin_auth, packing_order, db):
        job = job_for(client, admin_auth, packing_order["id"])
        data = call(client, admin_auth, "POST", f"/{job['id']}/start-picking")["data"]
        assert data["status"] == "picking" and data["assignedTo"]["id"] == "ADM001"
        assert order_status(db, packing_order["id"]) == "processing"
        again = client.post(f"{BASE}/{job['id']}/start-picking", headers=admin_auth)
        assert again.status_code == 409 and again.json()["error_code"] == "INVALID_PACKING_TRANSITION"
        events = db.execute(select(OrderEvent).where(OrderEvent.order_id == packing_order["id"],
                                                     OrderEvent.status == "processing")).scalars().all()
        assert len(events) == 1

    def test_partial_pick_then_full(self, client, admin_auth, packing_order):
        job = job_for(client, admin_auth, packing_order["id"])
        kurta = lines(job)["DCZ-WO0001"]
        data = call(client, admin_auth, "POST", f"/{job['id']}/lines/{kurta['id']}/pick", {"quantity": 1})["data"]
        assert data["status"] == "picking"  # picking a line starts picking
        assert lines(data)["DCZ-WO0001"]["pickedQty"] == 1 and lines(data)["DCZ-WO0001"]["remainingQty"] == 1
        too_many = client.post(f"{BASE}/{job['id']}/lines/{kurta['id']}/pick", headers=admin_auth,
                               json={"quantity": 3})
        assert too_many.status_code == 422
        early = client.post(f"{BASE}/{job['id']}/complete-picking", headers=admin_auth)
        assert early.status_code == 422 and early.json()["error_code"] == "PICK_INCOMPLETE"
        call(client, admin_auth, "POST", f"/{job['id']}/pick-all")
        data = call(client, admin_auth, "POST", f"/{job['id']}/complete-picking")["data"]
        assert data["status"] == "picked"

    def test_picking_never_changes_stock(self, client, admin_auth, packing_order, db):
        db.expire_all()
        before = db.get(Product, "PRD001").stock
        job = job_for(client, admin_auth, packing_order["id"])
        picked(client, admin_auth, job)
        db.expire_all()
        assert db.get(Product, "PRD001").stock == before

    def test_a_problem_blocks_picked_until_overridden(self, client, admin_auth, packing_order, db):
        job = job_for(client, admin_auth, packing_order["id"])
        shirt = lines(job)["DCZ-WO0002"]
        call(client, admin_auth, "POST", f"/{job['id']}/pick-all")
        bad = client.post(f"{BASE}/{job['id']}/lines/{shirt['id']}/exception", headers=admin_auth,
                          json={"type": "lost", "quantity": 1, "note": "x"})
        assert bad.status_code == 422
        no_note = client.post(f"{BASE}/{job['id']}/lines/{shirt['id']}/exception", headers=admin_auth,
                              json={"type": "damaged", "quantity": 1})
        assert no_note.status_code == 422 and no_note.json()["error_code"] == "REASON_REQUIRED"
        data = call(client, admin_auth, "POST", f"/{job['id']}/lines/{shirt['id']}/exception",
                    {"type": "damaged", "quantity": 1, "note": "Torn seam"})["data"]
        assert lines(data)["DCZ-WO0002"]["exception"]["label"] == "Damaged"
        blocked = client.post(f"{BASE}/{job['id']}/complete-picking", headers=admin_auth)
        assert blocked.status_code == 409 and blocked.json()["error_code"] == "PICK_EXCEPTIONS"
        data = call(client, admin_auth, "POST", f"/{job['id']}/complete-picking",
                    {"overrideReason": "Spare unit found in returns"})["data"]
        assert data["status"] == "picked" and data["pickOverrideReason"] == "Spare unit found in returns"
        actions = [e.action for e in db.execute(select(PackingEvent).where(PackingEvent.job_id == job["id"])
                                                .order_by(PackingEvent.id)).scalars()]
        assert actions[-2:] == ["exception", "picked"]

    def test_clearing_a_problem(self, client, admin_auth, packing_order):
        job = job_for(client, admin_auth, packing_order["id"])
        shirt = lines(job)["DCZ-WO0002"]
        call(client, admin_auth, "POST", f"/{job['id']}/lines/{shirt['id']}/exception",
             {"type": "missing-stock", "quantity": 1, "note": "Shelf empty"})
        data = call(client, admin_auth, "DELETE", f"/{job['id']}/lines/{shirt['id']}/exception")["data"]
        assert lines(data)["DCZ-WO0002"]["exception"] is None
        # pick-all leaves a line with a problem alone; this one is clear now.
        call(client, admin_auth, "POST", f"/{job['id']}/pick-all")
        assert call(client, admin_auth, "POST", f"/{job['id']}/complete-picking")["data"]["status"] == "picked"

    def test_pick_all_skips_lines_with_problems(self, client, admin_auth, packing_order):
        job = job_for(client, admin_auth, packing_order["id"])
        shirt = lines(job)["DCZ-WO0002"]
        call(client, admin_auth, "POST", f"/{job['id']}/lines/{shirt['id']}/exception",
             {"type": "wrong-item", "quantity": 1, "note": "Blue instead of white"})
        data = call(client, admin_auth, "POST", f"/{job['id']}/pick-all")["data"]
        assert lines(data)["DCZ-WO0002"]["pickedQty"] == 0 and lines(data)["DCZ-WO0001"]["pickedQty"] == 2

    def test_damaged_stock_goes_through_the_ledger(self, client, admin_auth, packing_order, db):
        db.expire_all()
        before = db.get(Product, "PRD001").stock
        job = job_for(client, admin_auth, packing_order["id"])
        kurta = lines(job)["DCZ-WO0001"]
        refused = client.post(f"{BASE}/{job['id']}/lines/{kurta['id']}/damaged-stock", headers=admin_auth,
                              json={"quantity": 1, "note": "Stain"})
        assert refused.status_code == 409  # not picking yet
        call(client, admin_auth, "POST", f"/{job['id']}/start-picking")
        data = call(client, admin_auth, "POST", f"/{job['id']}/lines/{kurta['id']}/damaged-stock",
                    {"quantity": 1, "note": "Stain on the front"})["data"]
        assert lines(data)["DCZ-WO0001"]["damagedRecordedQty"] == 1
        db.expire_all()
        assert db.get(Product, "PRD001").stock == before - 1
        row = db.execute(select(StockAdjustment).where(StockAdjustment.product_id == "PRD001",
                                                       StockAdjustment.reason == "damaged")).scalars().one()
        assert row.delta == -1 and packing_order["orderNumber"] in row.note
        over = client.post(f"{BASE}/{job['id']}/lines/{kurta['id']}/damaged-stock", headers=admin_auth,
                           json={"quantity": 2, "note": "More"})
        assert over.status_code == 422


# ------------------------------------------------------------- packing


class TestPacking:
    def test_one_package_and_packed_moves_the_order(self, client, admin_auth, packing_order, db):
        job = job_for(client, admin_auth, packing_order["id"])
        data = packed(client, admin_auth, job)
        assert data["status"] == "packed" and len(data["packages"]) == 1
        package = data["packages"][0]
        assert re.match(r"^DCZ-PKG-\d{4}-000001$", package["packageNumber"])
        assert package["volumetricWeightKg"] == 0.6  # 30 x 20 x 5 / 5000
        assert {i["quantity"] for i in package["items"]} == {2, 1}
        assert package["packedAt"] and package["packedBy"] == "ADM001"
        assert order_status(db, packing_order["id"]) == "packed"

    def test_several_packages_must_hold_everything(self, client, admin_auth, packing_order):
        job = job_for(client, admin_auth, packing_order["id"])
        data = picked(client, admin_auth, job)
        kurta, shirt = lines(data)["DCZ-WO0001"], lines(data)["DCZ-WO0002"]
        first = call(client, admin_auth, "POST", f"/{job['id']}/packages",
                     {**BOX, "items": [{"lineId": kurta["id"], "quantity": 1}]}, expect=201)["data"]
        assert first["status"] == "packing"  # the first package starts packing
        over = client.post(f"{BASE}/{job['id']}/packages", headers=admin_auth,
                           json={**BOX, "items": [{"lineId": kurta["id"], "quantity": 2}]})
        assert over.status_code == 422 and over.json()["error_code"] == "OVER_ALLOCATED"
        short = client.post(f"{BASE}/{job['id']}/packed", headers=admin_auth, json={})
        assert short.status_code == 422 and short.json()["error_code"] == "PACKING_INVALID"
        codes = {c["code"] for c in short.json()["details"]["errors"]}
        assert codes == {"LINE_NOT_ALLOCATED"}
        call(client, admin_auth, "POST", f"/{job['id']}/packages",
             {**BOX, "items": [{"lineId": kurta["id"], "quantity": 1}]}, expect=201)
        # No items named: whatever is left (the shirt).
        data = call(client, admin_auth, "POST", f"/{job['id']}/packages", dict(BOX), expect=201)["data"]
        assert [p["items"][0]["sku"] for p in data["packages"]] == ["DCZ-WO0001", "DCZ-WO0001", "DCZ-WO0002"]
        assert data["aggregate"] == {"weightGrams": 2400, "lengthCm": 30.0, "widthCm": 20.0, "heightCm": 5.0,
                                     "count": 3, "type": "box"}
        nothing = client.post(f"{BASE}/{job['id']}/packages", headers=admin_auth, json=dict(BOX))
        assert nothing.status_code == 422 and nothing.json()["error_code"] == "NOTHING_TO_PACK"
        data = call(client, admin_auth, "POST", f"/{job['id']}/packed", {})["data"]
        assert data["status"] == "packed" and shirt["id"]

    def test_weight_and_dimensions_are_required_to_pack(self, client, admin_auth, packing_order):
        job = job_for(client, admin_auth, packing_order["id"])
        picked(client, admin_auth, job)
        call(client, admin_auth, "POST", f"/{job['id']}/packages", {"type": "box"}, expect=201)
        response = client.post(f"{BASE}/{job['id']}/packed", headers=admin_auth, json={})
        assert response.status_code == 422
        codes = {c["code"] for c in response.json()["details"]["errors"]}
        assert codes == {"PACKAGE_WEIGHT_MISSING", "PACKAGE_DIMENSIONS_MISSING"}
        out_of_range = client.post(f"{BASE}/{job['id']}/packages", headers=admin_auth,
                                   json={**BOX, "weightGrams": 0})
        assert out_of_range.status_code == 422 and out_of_range.json()["error_code"] == "INVALID_PACKAGE"
        bad_type = client.post(f"{BASE}/{job['id']}/packages", headers=admin_auth, json={**BOX, "type": "sack"})
        assert bad_type.status_code == 422

    def test_editing_a_package_and_removing_one(self, client, admin_auth, packing_order, db):
        job = job_for(client, admin_auth, packing_order["id"])
        picked(client, admin_auth, job)
        data = call(client, admin_auth, "POST", f"/{job['id']}/packages", {"type": "box"}, expect=201)["data"]
        package = data["packages"][0]
        data = call(client, admin_auth, "PUT", f"/{job['id']}/packages/{package['id']}",
                    {"weightGrams": 900, "lengthCm": 25, "widthCm": 20, "heightCm": 10})["data"]
        assert data["packages"][0]["weightGrams"] == 900 and data["packages"][0]["items"]
        data = call(client, admin_auth, "DELETE", f"/{job['id']}/packages/{package['id']}")["data"]
        assert data["packages"] == []
        # The removed package keeps its number, which is never reused.
        data = call(client, admin_auth, "POST", f"/{job['id']}/packages", dict(BOX), expect=201)["data"]
        assert data["packages"][0]["packageNumber"].endswith("000002")
        assert db.execute(select(func.count()).select_from(PackingPackage)).scalar_one() == 2

    def test_packed_is_locked_until_reopened_with_a_reason(self, client, admin_auth, packing_order):
        job = job_for(client, admin_auth, packing_order["id"])
        data = packed(client, admin_auth, job)
        package = data["packages"][0]
        locked = client.put(f"{BASE}/{job['id']}/packages/{package['id']}", headers=admin_auth,
                            json={"weightGrams": 1000})
        assert locked.status_code == 409 and locked.json()["error_code"] == "PACKING_LOCKED"
        no_reason = client.post(f"{BASE}/{job['id']}/reopen", headers=admin_auth, json={"target": "packing"})
        assert no_reason.status_code == 422
        data = call(client, admin_auth, "POST", f"/{job['id']}/reopen",
                    {"target": "packing", "reason": "Wrong box size"})["data"]
        assert data["status"] == "packing" and data["packages"][0]["packedAt"] is None
        call(client, admin_auth, "PUT", f"/{job['id']}/packages/{package['id']}", {"weightGrams": 1000})
        data = call(client, admin_auth, "POST", f"/{job['id']}/packed", {})["data"]
        assert data["status"] == "packed"
        assert any(e["action"] == "reopened" and e["note"] == "Wrong box size" for e in data["events"])

    def test_a_short_pick_needs_confirming_to_pack(self, client, admin_auth, packing_order):
        job = job_for(client, admin_auth, packing_order["id"])
        shirt = lines(job)["DCZ-WO0002"]
        call(client, admin_auth, "POST", f"/{job['id']}/pick-all")
        call(client, admin_auth, "POST", f"/{job['id']}/lines/{shirt['id']}/pick", {"quantity": 0})
        call(client, admin_auth, "POST", f"/{job['id']}/lines/{shirt['id']}/exception",
             {"type": "missing-stock", "quantity": 1, "note": "None left"})
        call(client, admin_auth, "POST", f"/{job['id']}/complete-picking", {"overrideReason": "Ship the rest"})
        call(client, admin_auth, "POST", f"/{job['id']}/packages", dict(BOX), expect=201)
        response = client.post(f"{BASE}/{job['id']}/packed", headers=admin_auth, json={})
        assert response.status_code == 409 and response.json()["error_code"] == "CONFIRMATION_REQUIRED"
        codes = {c["code"] for c in response.json()["details"]["critical"]}
        assert codes == {"SHORT_PICK", "OPEN_EXCEPTION"}
        unreasoned = client.post(f"{BASE}/{job['id']}/packed", headers=admin_auth, json={"confirm": True})
        assert unreasoned.status_code == 409
        data = call(client, admin_auth, "POST", f"/{job['id']}/packed",
                    {"confirm": True, "overrideReason": "Customer agreed to a partial shipment"})["data"]
        assert data["status"] == "packed" and data["packOverrideReason"].startswith("Customer agreed")

    def test_payment_not_confirmed_is_critical(self, client, admin_auth, packing_order, db):
        job = job_for(client, admin_auth, packing_order["id"])
        picked(client, admin_auth, job)
        call(client, admin_auth, "POST", f"/{job['id']}/packages", dict(BOX), expect=201)
        db.get(Order, packing_order["id"]).payment_status = "failed"
        db.flush()
        response = client.post(f"{BASE}/{job['id']}/packed", headers=admin_auth, json={})
        assert response.status_code == 409
        assert [c["code"] for c in response.json()["details"]["critical"]] == ["PAYMENT_NOT_CONFIRMED"]

    def test_incomplete_address_blocks_packing(self, client, admin_auth, packing_order, db):
        job = job_for(client, admin_auth, packing_order["id"])
        picked(client, admin_auth, job)
        call(client, admin_auth, "POST", f"/{job['id']}/packages", dict(BOX), expect=201)
        db.get(Order, packing_order["id"]).shipping_pincode = "12"
        db.flush()
        response = client.post(f"{BASE}/{job['id']}/packed", headers=admin_auth, json={})
        assert response.status_code == 422
        assert [c["code"] for c in response.json()["details"]["errors"]] == ["ADDRESS_INCOMPLETE"]

    def test_wrong_order_of_steps(self, client, admin_auth, packing_order):
        job = job_for(client, admin_auth, packing_order["id"])
        for path in ("/complete-picking", "/start-packing", "/packed", "/ready"):
            response = client.post(f"{BASE}/{job['id']}{path}", headers=admin_auth, json={})
            assert response.status_code == 409, path
        early = client.post(f"{BASE}/{job['id']}/packages", headers=admin_auth, json=dict(BOX))
        assert early.status_code == 409

    def test_the_order_status_endpoint_cannot_skip_packing(self, client, admin_auth, packing_order, db):
        for status in ("processing", "packed", "shipped", "delivered"):
            response = client.put(f"/api/admin/orders/{packing_order['id']}/status", headers=admin_auth,
                                  json={"status": status, "confirm": True})
            assert response.status_code == 409, status
            assert response.json()["error_code"] in ("WORKFLOW_OWNED", "INVALID_TRANSITION")
        assert order_status(db, packing_order["id"]) == "confirmed"

    def test_a_legacy_order_never_moves_backwards(self, client, admin_auth, packing_order, db):
        job = job_for(client, admin_auth, packing_order["id"])
        db.get(Order, packing_order["id"]).status = "packed"  # moved by hand before packing was enforced
        db.flush()
        call(client, admin_auth, "POST", f"/{job['id']}/start-picking")
        assert order_status(db, packing_order["id"]) == "packed"

    def test_picking_and_packing_events_name_the_job(self, client, admin_auth, packing_order, db):
        job = job_for(client, admin_auth, packing_order["id"])
        packed(client, admin_auth, job)
        rows = db.execute(select(OrderEvent).where(OrderEvent.order_id == packing_order["id"],
                                                   OrderEvent.source == "packing")
                          .order_by(OrderEvent.id)).scalars().all()
        assert [(r.from_status, r.status) for r in rows] == [("confirmed", "processing"), ("processing", "packed")]
        assert {r.related_id for r in rows} == {str(job["id"])}

    def test_repacking_a_packed_order_moves_it_back_with_a_reason(self, client, admin_auth, packing_order, db):
        job = job_for(client, admin_auth, packing_order["id"])
        packed(client, admin_auth, job)
        assert order_status(db, packing_order["id"]) == "packed"
        refused = client.post(f"{BASE}/{job['id']}/reopen", headers=admin_auth, json={"target": "packing"})
        assert refused.status_code == 422 and refused.json()["error_code"] == "REASON_REQUIRED"
        call(client, admin_auth, "POST", f"/{job['id']}/reopen", {"target": "packing", "reason": "Box damaged"})
        assert order_status(db, packing_order["id"]) == "processing"
        back = db.execute(select(OrderEvent).where(OrderEvent.order_id == packing_order["id"])
                          .order_by(OrderEvent.id.desc())).scalars().first()
        assert back.from_status == "packed" and back.status == "processing" and back.reason == "Box damaged"

    def test_unpaid_orders_cannot_be_picked(self, client, admin_auth, packing_order, db):
        job = job_for(client, admin_auth, packing_order["id"])
        db.get(Order, packing_order["id"]).payment_status = "failed"
        db.flush()
        assert detail(client, admin_auth, job["id"])["actions"]["startPicking"] is False
        response = client.post(f"{BASE}/{job['id']}/start-picking", headers=admin_auth)
        assert response.status_code == 409 and response.json()["error_code"] == "PAYMENT_REQUIRED"
        assert "payment is failed" in response.json()["message"]


# -------------------------------------------------------- cancellation


class TestCancellation:
    def test_cancelling_the_order_cancels_the_job(self, client, auth, admin_auth, packing_order, db):
        job = job_for(client, admin_auth, packing_order["id"])
        call(client, admin_auth, "POST", f"/{job['id']}/start-picking")
        # Once picking starts the customer can't cancel online, and the store needs a reason.
        customer = client.post(f"/api/orders/{packing_order['id']}/cancel", headers=auth, json={"reason": "Changed"})
        assert customer.status_code == 409 and customer.json()["error_code"] == "ORDER_NOT_CANCELLABLE"
        no_reason = client.put(f"/api/admin/orders/{packing_order['id']}/status", headers=admin_auth,
                               json={"status": "cancelled"})
        assert no_reason.status_code == 422 and no_reason.json()["error_code"] == "REASON_REQUIRED"
        response = client.put(f"/api/admin/orders/{packing_order['id']}/status", headers=admin_auth,
                              json={"status": "cancelled", "reason": "Customer called to cancel"})
        assert response.status_code == 200, response.text
        data = detail(client, admin_auth, job["id"])
        assert data["status"] == "cancelled"
        assert data["actions"]["pick"] is False and data["actions"]["editPackages"] is False
        refused = client.post(f"{BASE}/{job['id']}/pick-all", headers=admin_auth)
        assert refused.status_code == 409 and refused.json()["error_code"] == "ORDER_CANCELLED"
        assert call(client, admin_auth, "GET", "")["data"]["items"] == []
        cancelled = call(client, admin_auth, "GET", "?status=cancelled")["data"]["items"]
        assert [i["id"] for i in cancelled] == [job["id"]]

    def test_cannot_pack_a_cancelled_order(self, client, admin_auth, packing_order, db):
        job = job_for(client, admin_auth, packing_order["id"])
        picked(client, admin_auth, job)
        call(client, admin_auth, "POST", f"/{job['id']}/packages", dict(BOX), expect=201)
        # Cancelled behind the job's back (a direct status write): the sync and the guard both catch it.
        db.get(Order, packing_order["id"]).status = "cancelled"
        db.flush()
        response = client.post(f"{BASE}/{job['id']}/packed", headers=admin_auth, json={})
        assert response.status_code == 409 and response.json()["error_code"] == "ORDER_CANCELLED"
        call(client, admin_auth, "GET", "")
        db.expire_all()
        assert db.get(PackingJob, job["id"]).status == "cancelled"
        assert db.get(PackingJob, job["id"]).active_key is None


# ------------------------------------------------------------ shipment


class TestShipment:
    def test_a_shipment_for_a_packed_order_uses_its_packages(self, client, admin_auth, packing_order, manual_on,
                                                             db):
        job = job_for(client, admin_auth, packing_order["id"])
        kurta = lines(job)["DCZ-WO0001"]
        packed(client, admin_auth, job, [{**BOX, "items": [{"lineId": kurta["id"], "quantity": 2}]},
                                         {**BOX, "weightGrams": 1200, "lengthCm": 40}])
        overview = client.get(f"/api/admin/orders/{packing_order['id']}/shipping", headers=admin_auth).json()["data"]
        assert overview["packing"]["status"] == "packed"
        assert overview["packing"]["package"] == {"weightGrams": 2000, "lengthCm": 40.0, "widthCm": 20.0,
                                                  "heightCm": 5.0, "count": 2, "type": "box"}
        shipment = created(client, admin_auth, packing_order["id"], package=None)
        assert shipment["package"] == {"weightGrams": 2000, "lengthCm": 40.0, "widthCm": 20.0, "heightCm": 5.0,
                                       "count": 2, "type": "box"}
        data = detail(client, admin_auth, job["id"])
        assert data["status"] == "ready-to-ship" and data["shipment"]["linked"] is True
        assert {p["shipmentId"] for p in data["packages"]} == {shipment["id"]}
        # Packages handed over can't be reopened until the shipment is cancelled.
        refused = client.post(f"{BASE}/{job['id']}/reopen", headers=admin_auth,
                              json={"target": "packing", "reason": "Recount"})
        assert refused.status_code == 409 and refused.json()["error_code"] == "SHIPMENT_ACTIVE"
        client.post(f"/api/admin/shipments/{shipment['id']}/cancel", headers=admin_auth, json={"reason": "Re-book"})
        data = detail(client, admin_auth, job["id"])
        assert data["status"] == "packed" and {p["shipmentId"] for p in data["packages"]} == {None}

    def test_no_shipment_before_packing_is_complete(self, client, admin_auth, packing_order, manual_on):
        from tests.integration.test_shipping_helpers import create

        job = job_for(client, admin_auth, packing_order["id"])
        response = create(client, admin_auth, packing_order["id"])
        assert response.status_code == 409 and response.json()["error_code"] == "PACKING_INCOMPLETE"
        picked(client, admin_auth, job)
        assert create(client, admin_auth, packing_order["id"]).json()["error_code"] == "PACKING_INCOMPLETE"

    def test_a_shipment_takes_the_packed_job_out_of_the_open_queue(self, client, admin_auth, packing_order,
                                                                   manual_on):
        job = job_for(client, admin_auth, packing_order["id"])
        packed(client, admin_auth, job)
        shipment = created(client, admin_auth, packing_order["id"])
        data = detail(client, admin_auth, job["id"])
        assert data["status"] == "ready-to-ship" and data["shipment"]["id"] == shipment["id"]
        assert call(client, admin_auth, "GET", "")["data"]["items"] == []
        handed = call(client, admin_auth, "GET", "?status=ready-to-ship")["data"]
        assert [i["id"] for i in handed["items"]] == [job["id"]]
        assert handed["counts"]["ready-to-ship"] == 1

    def test_ready_books_the_shipment_with_the_default_courier(self, client, admin_auth, db, packing_order,
                                                               shiprocket_on, shiprocket):
        from app.models.shipping import Shipment

        job = job_for(client, admin_auth, packing_order["id"])
        packed(client, admin_auth, job)
        response = client.post(f"{BASE}/{job['id']}/ready", headers=admin_auth, json={"idempotencyKey": "ready-key-1"})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["data"]["status"] == "ready-to-ship" and body["data"]["shipment"]["linked"] is True
        assert body["message"].startswith("Shipment ") and body["message"].endswith("created — ready to ship.")
        shipment = db.execute(select(Shipment).where(Shipment.order_id == packing_order["id"])).scalar_one()
        assert shipment.provider_code == "shiprocket" and shipment.weight_grams == BOX["weightGrams"]
        assert (shipment.length_cm, shipment.width_cm, shipment.height_cm) == (30, 20, 5)
        assert shiprocket.count("POST /orders/create/adhoc") == 1
        assert {p["shipmentId"] for p in body["data"]["packages"]} == {shipment.id}

    def test_ready_asks_for_the_awb_when_the_courier_is_manual(self, client, admin_auth, db, packing_order,
                                                               manual_on):
        from app.models.shipping import Shipment

        job = job_for(client, admin_auth, packing_order["id"])
        packed(client, admin_auth, job)
        response = client.post(f"{BASE}/{job['id']}/ready", headers=admin_auth)
        assert response.status_code == 409, response.text
        body = response.json()
        assert body["error_code"] == "SHIPMENT_DETAILS_REQUIRED"
        assert body["details"] == {"orderId": packing_order["id"], "providerCode": "manual"}
        assert db.execute(select(func.count(Shipment.id))).scalar() == 0
        assert detail(client, admin_auth, job["id"])["status"] == "packed"

    def test_ready_with_the_awb_ships_manually(self, client, admin_auth, packing_order, manual_on):
        job = job_for(client, admin_auth, packing_order["id"])
        packed(client, admin_auth, job)
        response = client.post(f"{BASE}/{job['id']}/ready", headers=admin_auth,
                               json={"courierName": "Blue Dart", "awb": "BD-12345", "idempotencyKey": "ready-key-2"})
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["status"] == "ready-to-ship"
        assert data["shipment"]["courierName"] == "Blue Dart" and data["shipment"]["awb"] == "BD-12345"

    def test_ready_needs_a_courier_switched_on(self, client, admin_auth, packing_order):
        job = job_for(client, admin_auth, packing_order["id"])
        packed(client, admin_auth, job)
        response = client.post(f"{BASE}/{job['id']}/ready", headers=admin_auth)
        assert response.status_code == 409 and response.json()["error_code"] == "NO_COURIER"

    def test_ready_links_a_shipment_that_already_exists(self, client, admin_auth, db, packing_order, manual_on):
        from app.models.shipping import Shipment

        job = job_for(client, admin_auth, packing_order["id"])
        packed(client, admin_auth, job)
        shipment = created(client, admin_auth, packing_order["id"])
        # Creating the shipment already handed the job over; ready changes nothing more.
        response = client.post(f"{BASE}/{job['id']}/ready", headers=admin_auth)
        assert response.status_code == 409 and response.json()["error_code"] == "INVALID_PACKING_TRANSITION"
        assert detail(client, admin_auth, job["id"])["shipment"]["id"] == shipment["id"]
        assert db.execute(select(func.count(Shipment.id))).scalar() == 1

    def test_a_second_click_books_nothing_more(self, client, admin_auth, db, packing_order, shiprocket_on, shiprocket):
        from app.models.shipping import Shipment

        job = job_for(client, admin_auth, packing_order["id"])
        packed(client, admin_auth, job)
        url = f"{BASE}/{job['id']}/ready"
        assert client.post(url, headers=admin_auth, json={"idempotencyKey": "same-key-123"}).status_code == 200
        again = client.post(url, headers=admin_auth, json={"idempotencyKey": "same-key-123"})
        assert again.status_code == 409 and again.json()["error_code"] == "INVALID_PACKING_TRANSITION"
        assert db.execute(select(func.count(Shipment.id))).scalar() == 1
        assert shiprocket.count("POST /orders/create/adhoc") == 1

    def test_the_shipment_is_prefilled_from_the_packages(self, client, admin_auth, packing_order, manual_on):
        from tests.integration.test_shipping_helpers import create

        job = job_for(client, admin_auth, packing_order["id"])
        packed(client, admin_auth, job)
        response = create(client, admin_auth, packing_order["id"], package={})
        assert response.status_code == 201, response.text
        assert response.json()["data"]["package"]["weightGrams"] == BOX["weightGrams"]


# --------------------------------------------------------------- queue


class TestQueue:
    def test_filters_counts_and_paging(self, client, auth, admin_auth, catalogue, settings_documents, db):
        first = place_order(client, auth)
        second = place_order(client, auth, product_id="PRD002")
        jobs = {o["id"]: job_for(client, admin_auth, o["id"]) for o in (first, second)}
        call(client, admin_auth, "POST", f"/{jobs[second['id']]['id']}/priority", {"priority": "urgent"})
        call(client, admin_auth, "POST", f"/{jobs[first['id']]['id']}/start-picking")
        queue = call(client, admin_auth, "GET", "")["data"]
        assert [i["orderId"] for i in queue["items"]] == [second["id"], first["id"]]  # urgent first
        assert queue["counts"] == {"pending": 1, "picking": 1}
        assert [i["orderId"] for i in call(client, admin_auth, "GET", "?status=picking")["data"]["items"]] == \
            [first["id"]]
        assert len(call(client, admin_auth, "GET", "?priority=urgent")["data"]["items"]) == 1
        assert [i["orderId"] for i in call(client, admin_auth, "GET", "?assignedTo=me")["data"]["items"]] == \
            [first["id"]]
        assert [i["orderId"] for i in call(client, admin_auth, "GET", "?assignedTo=unassigned")["data"]["items"]] \
            == [second["id"]]
        # The search box takes an Order ID, exactly — never part of one, a name or an email.
        assert [i["orderId"] for i in call(client, admin_auth, "GET", f"?q={first['orderNumber']}")["data"]["items"]]             == [first["id"]]
        assert [i["orderId"] for i in call(client, admin_auth, "GET", f"?q={first['id']}")["data"]["items"]]             == [first["id"]]
        assert call(client, admin_auth, "GET", f"?q={first['orderNumber'][:-1]}")["data"]["items"] == []
        from urllib.parse import urlencode

        placed = db.get(Order, first["id"])
        for text in (placed.customer_name, placed.customer_email):
            assert call(client, admin_auth, "GET", f"?{urlencode({'q': text})}")["data"]["items"] == []
        assert call(client, admin_auth, "GET", "?courier=Local")["data"]["items"] == []
        assert len(call(client, admin_auth, "GET", "?paymentStatus=paid")["data"]["items"]) == 0
        assert len(call(client, admin_auth, "GET", "?shippingType=standard")["data"]["items"]) == 2
        page = call(client, admin_auth, "GET", "?pageSize=1&page=2")["data"]
        assert page["pagination"]["total"] == 2 and len(page["items"]) == 1
        assert call(client, admin_auth, "GET", "?overdue=true")["data"]["items"] == []
        from datetime import datetime, timedelta

        db.get(Order, first["id"]).placed_at = datetime.utcnow() - timedelta(hours=30)
        db.flush()
        overdue = call(client, admin_auth, "GET", "?overdue=true")["data"]["items"]
        assert [i["orderId"] for i in overdue] == [first["id"]] and overdue[0]["aging"]["overdue"] is True

    def test_assigning(self, client, admin_auth, packing_order, db, editor):
        job = job_for(client, admin_auth, packing_order["id"])
        role_headers(db, "ADM050", "staff")
        staff = call(client, admin_auth, "GET", "/staff")["data"]
        assert {s["id"] for s in staff} >= {"ADM001", "ADM050"} and "ADM002" not in {s["id"] for s in staff}
        data = call(client, admin_auth, "POST", f"/{job['id']}/assign", {"adminId": "ADM050"})["data"]
        assert data["assignedTo"] == {"id": "ADM050", "name": "Staff User"}
        # "Assigned to" filters by Admin user ID, exactly; never by a name or an email.
        queue = lambda params: [i["orderId"] for i in call(client, admin_auth, "GET", params)["data"]["items"]]  # noqa: E731
        assert queue("?assignedTo=ADM050") == [packing_order["id"]]
        assert queue("?assignedTo=adm-050") == [packing_order["id"]]
        for other in ("ADM05", "ADM0500", "Staff%20User", "Staff", "staff%40example.com",
                      "%27%3B%20DROP"):
            assert queue(f"?assignedTo={other}") == [], other
        # Assigning checks the chosen admin can pack: an ID, a name or an email of anyone else is refused.
        for target in ("ADM002", "Staff User", "ADM05", 50):
            bad = client.post(f"{BASE}/{job['id']}/assign", headers=admin_auth, json={"adminId": target})
            assert bad.status_code == 422 and bad.json()["error_code"] == "INVALID_ASSIGNEE", target
        data = call(client, admin_auth, "POST", f"/{job['id']}/assign", {"adminId": None})["data"]
        assert data["assignedTo"] is None
        bad = client.post(f"{BASE}/{job['id']}/priority", headers=admin_auth, json={"priority": "now"})
        assert bad.status_code == 422


# -------------------------------------------------------- slip, summary


class TestSlipAndSummary:
    def test_packing_slip_pdf(self, client, admin_auth, packing_order):
        job = job_for(client, admin_auth, packing_order["id"])
        packed(client, admin_auth, job)
        response = client.get(f"{BASE}/{job['id']}/slip", headers=admin_auth)
        assert response.status_code == 200 and response.headers["content-type"] == "application/pdf"
        assert response.content.startswith(b"%PDF")
        assert response.headers["content-disposition"].startswith("inline;")
        priced = client.get(f"{BASE}/{job['id']}/slip?prices=true&download=true", headers=admin_auth)
        assert priced.headers["content-disposition"].startswith("attachment;")
        assert priced.content != response.content

    def test_summary(self, client, auth, admin_auth, catalogue, settings_documents):
        first = place_order(client, auth)
        place_order(client, auth, product_id="PRD002")
        packed(client, admin_auth, job_for(client, admin_auth, first["id"]))
        data = call(client, admin_auth, "GET", "/summary")["data"]
        assert data["waitingToPick"] == 1 and data["waitingToPack"] == 0 and data["packedToday"] == 1
        assert data["overdue"] == 0 and data["slaHours"] == 24
        assert {"labelsPending", "labelsGeneratedToday", "labelFailures"} <= set(data)

    def test_settings(self, client, admin_auth, db, editor):
        data = client.get("/api/admin/fulfilment/settings", headers=admin_auth).json()["data"]
        assert data["slaHours"] == 24 and data["labelFormat"] == "thermal-4x6"
        assert {f["key"] for f in data["formats"]} == {"a4", "thermal-4x6", "standard"}
        saved = client.put("/api/admin/fulfilment/settings", headers=admin_auth,
                           json={"slaHours": 12, "labelFormat": "a4", "defaultPackage": BOX})
        assert saved.status_code == 200 and saved.json()["data"]["defaultPackage"]["weightGrams"] == 800
        for body in ({"slaHours": 0}, {"labelFormat": "huge"}, {"volumetricDivisor": "x"},
                     {"defaultPackage": {"weightGrams": 10}}):
            assert client.put("/api/admin/fulfilment/settings", headers=admin_auth, json=body).status_code == 422
        staff = role_headers(db, "ADM051", "staff")
        assert client.get("/api/admin/fulfilment/settings", headers=staff).status_code == 200
        assert client.put("/api/admin/fulfilment/settings", headers=staff, json={"slaHours": 5}).status_code == 403


# ---------------------------------------------------- audit, permissions


class TestAuditAndPermissions:
    def test_every_action_is_audited(self, client, admin_auth, packing_order, db):
        job = job_for(client, admin_auth, packing_order["id"])
        packed(client, admin_auth, job)
        actions = set(db.execute(select(AuditLog.action).where(AuditLog.resource_type == "packing")).scalars())
        assert {"packing.start-picking", "packing.pick-all", "packing.picked", "packing.start-packing",
                "packing.package-create", "packing.packed"} <= actions
        events = [e.action for e in db.execute(select(PackingEvent).where(PackingEvent.job_id == job["id"])
                                               .order_by(PackingEvent.id)).scalars()]
        assert events == ["created", "picking-started", "picked-all", "picked", "packing-started",
                          "package-created", "packed"]

    def test_who_may_pack(self, client, auth, admin_auth, packing_order, db, editor):
        job = job_for(client, admin_auth, packing_order["id"])
        assert client.get(BASE, headers=auth).status_code in (401, 403)
        editor_headers = role_headers(db, "ADM060", "editor")
        for method, path in (("GET", ""), ("GET", f"/{job['id']}"), ("POST", f"/{job['id']}/start-picking"),
                             ("GET", f"/{job['id']}/slip")):
            assert client.request(method, f"{BASE}{path}", headers=editor_headers).status_code == 403, path
        assert client.get(f"/api/admin/orders/{packing_order['id']}/packing", headers=editor_headers).status_code \
            == 403
        for n, role in enumerate(("staff", "manager", "admin")):
            headers = role_headers(db, f"ADM07{n}", role)
            assert client.get(BASE, headers=headers).status_code == 200, role
        # A permission granted to one account works too.
        granted = role_headers(db, "ADM080", "editor", permissions=["packing"])
        assert client.get(BASE, headers=granted).status_code == 200
