"""
The `shipping` background job (retry with backoff, refresh only what is due,
flag stuck parcels) and the checkout delivery estimate.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import httpx
import pytest
from sqlalchemy import select

from app.models import DeliveryPincode
from app.models.shipping import Shipment, ShipmentEvent
from app.services.shipping import jobs
from tests.integration.test_shipping_helpers import (  # noqa: F401
    configure,
    create,
    created,
    event,
    manual_on,
    order,
    shiprocket,
    shiprocket_on,
)

pytestmark = pytest.mark.integration


def due_now(db, shipment_id: int, **fields):
    row = db.get(Shipment, shipment_id)
    for key, value in fields.items():
        setattr(row, key, value)
    db.flush()
    return row


class TestRetry:
    def test_a_transient_failure_is_retried_when_due(self, client, admin_auth, order, shiprocket_on, shiprocket, db):
        shiprocket.answer("POST /orders/create/adhoc", httpx.ConnectError("down"))
        shipment = create(client, admin_auth, order["id"], provider="shiprocket").json()["data"]
        assert jobs.sweep(db)["retried"] == 0  # not due yet: two minutes of backoff

        shiprocket.answers.clear()
        due_now(db, shipment["id"], next_retry_at=datetime.utcnow() - timedelta(seconds=1))
        assert jobs.sweep(db)["retried"] == 1
        db.expire_all()
        assert db.get(Shipment, shipment["id"]).status == "ready-for-pickup"

    def test_backoff_doubles_and_stops_after_six_attempts(self, client, admin_auth, order, shiprocket_on, shiprocket,
                                                          db):
        shiprocket.answer("POST /orders/create/adhoc", httpx.Response(503))
        shipment = create(client, admin_auth, order["id"], provider="shiprocket").json()["data"]
        waits = []
        for _ in range(6):
            db.expire_all()
            row = db.get(Shipment, shipment["id"])
            if row.next_retry_at is None:
                break
            waits.append(round((row.next_retry_at - row.last_error_at).total_seconds() / 60))
            due_now(db, shipment["id"], next_retry_at=datetime.utcnow() - timedelta(seconds=1))
            jobs.sweep(db)
        db.expire_all()
        row = db.get(Shipment, shipment["id"])
        assert waits == [2, 4, 8, 16, 32]
        assert row.retry_count == 6 and row.next_retry_at is None
        assert {"courier-unreachable", "create-failed"} <= set(row.alerts_sent)
        assert shiprocket.count("POST /orders/create/adhoc") == 6

    def test_a_refusal_is_never_retried_automatically(self, client, admin_auth, order, shiprocket_on, shiprocket, db):
        shiprocket.answer("POST /orders/create/adhoc", httpx.Response(422, json={"message": "bad pincode"}))
        shipment = create(client, admin_auth, order["id"], provider="shiprocket").json()["data"]
        due_now(db, shipment["id"], next_retry_at=datetime.utcnow() - timedelta(minutes=1))
        jobs.sweep(db)
        assert shiprocket.count("POST /orders/create/adhoc") == 1


class TestRefresh:
    @pytest.fixture()
    def booked(self, client, admin_auth, order, shiprocket_on):
        return created(client, admin_auth, order["id"], provider="shiprocket")

    def test_only_due_shipments_are_polled(self, booked, db, shiprocket):
        assert jobs.sweep(db)["refreshed"] == 0  # six hours away
        due_now(db, booked["id"], next_sync_at=datetime.utcnow() - timedelta(seconds=1))
        assert jobs.sweep(db)["refreshed"] == 1
        db.expire_all()
        row = db.get(Shipment, booked["id"])
        assert row.last_synced_at is not None and row.next_sync_at > datetime.utcnow() + timedelta(hours=5)

    def test_a_recent_webhook_spaces_polling_out(self, booked, db):
        from app.services.shipping import service

        row = due_now(db, booked["id"], last_webhook_at=datetime.utcnow())
        assert service.next_sync_at(row) > datetime.utcnow() + timedelta(hours=11)
        row.status = "out-for-delivery"
        row.last_webhook_at = None
        assert service.next_sync_at(row) < datetime.utcnow() + timedelta(hours=3)

    def test_closed_and_manual_shipments_are_never_polled(self, client, admin_auth, booked, db, shiprocket):
        due_now(db, booked["id"], status="delivered", next_sync_at=datetime.utcnow() - timedelta(hours=1))
        jobs.sweep(db)
        assert shiprocket.count("GET /courier/track/awb/") == 0

    def test_a_switched_off_courier_is_not_polled(self, client, admin_auth, booked, db, shiprocket, manual_on):
        configure(client, admin_auth, "shiprocket", active=False)
        due_now(db, booked["id"], next_sync_at=datetime.utcnow() - timedelta(seconds=1))
        jobs.sweep(db)
        assert shiprocket.count("GET /courier/track/awb/") == 0

    def test_a_courier_outage_pushes_the_poll_back(self, booked, db, shiprocket):
        shiprocket.answer("GET /courier/track/awb/", httpx.ReadTimeout("slow"))
        due_now(db, booked["id"], next_sync_at=datetime.utcnow() - timedelta(seconds=1))
        jobs.sweep(db)
        db.expire_all()
        assert db.get(Shipment, booked["id"]).next_sync_at > datetime.utcnow() + timedelta(minutes=20)


class TestStuck:
    def test_a_parcel_with_no_movement_for_five_days_is_flagged_once(self, client, admin_auth, order, manual_on, db):
        shipment = created(client, admin_auth, order["id"])
        event(client, admin_auth, shipment["id"], "picked-up")
        old = datetime.utcnow() - timedelta(days=6)
        due_now(db, shipment["id"], created_at=old)
        for row in db.execute(select(ShipmentEvent).where(ShipmentEvent.shipment_id == shipment["id"])).scalars():
            row.occurred_at = old
        db.flush()
        assert jobs.sweep(db)["flagged"] == 1
        assert jobs.sweep(db)["flagged"] == 0
        assert "stuck" in db.get(Shipment, shipment["id"]).alerts_sent

    def test_a_parcel_that_moved_recently_is_not_flagged(self, client, admin_auth, order, manual_on, db):
        shipment = created(client, admin_auth, order["id"])
        event(client, admin_auth, shipment["id"], "picked-up")
        due_now(db, shipment["id"], created_at=datetime.utcnow() - timedelta(days=9))
        assert jobs.sweep(db)["flagged"] == 0


# ---------------------------------------------------------------- estimate


ESTIMATE = "/api/delivery/estimate"
NOW = datetime(2026, 10, 1)


class TestDeliveryEstimate:
    def test_the_store_table_wins(self, client, db, settings_documents, shiprocket_on, shiprocket):
        db.add(DeliveryPincode(pincode="560001", city="Bengaluru", state="Karnataka", serviceable=True,
                               cod_available=True, min_days=2, max_days=4, active=True, created_at=NOW, updated_at=NOW))
        db.flush()
        data = client.get(ESTIMATE, params={"pincode": "560001"}).json()["data"]
        assert data["source"] == "store" and data["serviceable"] is True
        assert data["etaDays"] == {"min": 2, "max": 4} and data["label"].startswith("Delivery by ")
        assert shiprocket.count("GET /courier/serviceability/") == 0

    def test_a_listed_unserviceable_pincode_says_so(self, client, db, settings_documents):
        db.add(DeliveryPincode(pincode="560002", serviceable=False, active=True, created_at=NOW, updated_at=NOW))
        db.flush()
        data = client.get(ESTIMATE, params={"pincode": "560002"}).json()["data"]
        assert data["source"] == "store" and data["serviceable"] is False and data["message"]

    def test_the_courier_is_asked_only_when_switched_on(self, client, admin_auth, settings_documents, shiprocket_on,
                                                        shiprocket):
        data = client.get(ESTIMATE, params={"pincode": "110001"}).json()["data"]
        assert data["source"] == "none" and data["serviceable"] is None
        assert shiprocket.count("GET /courier/serviceability/") == 0

        configure(client, admin_auth, "shiprocket", settings={"checkoutServiceability": True})
        data = client.get(ESTIMATE, params={"pincode": "110001"}).json()["data"]
        assert data["source"] == "courier" and data["serviceable"] is True and data["codAvailable"] is True
        assert data["etaDays"] == {"min": 2, "max": 4} and data["label"].startswith("Delivery by ")

    def test_courier_answers_are_cached(self, client, admin_auth, settings_documents, shiprocket_on, shiprocket):
        configure(client, admin_auth, "shiprocket", settings={"checkoutServiceability": True})
        for _ in range(3):
            client.get(ESTIMATE, params={"pincode": "110001"})
        assert shiprocket.count("GET /courier/serviceability/") == 1

    def test_a_courier_failure_never_blocks(self, client, admin_auth, settings_documents, shiprocket_on, shiprocket):
        configure(client, admin_auth, "shiprocket", settings={"checkoutServiceability": True})
        shiprocket.answer("GET /courier/serviceability/", httpx.ReadTimeout("slow"))
        response = client.get(ESTIMATE, params={"pincode": "110001"})
        assert response.status_code == 200
        assert response.json()["data"]["serviceable"] is None

    def test_a_courier_that_cant_reach_it(self, client, admin_auth, settings_documents, shiprocket_on, shiprocket):
        configure(client, admin_auth, "shiprocket", settings={"checkoutServiceability": True})
        shiprocket.answer("GET /courier/serviceability/",
                          httpx.Response(200, json={"status": 404, "message": "No courier serviceable"}))
        data = client.get(ESTIMATE, params={"pincode": "110001"}).json()["data"]
        assert data["source"] == "courier" and data["serviceable"] is False

    def test_an_invalid_pincode(self, client, settings_documents):
        data = client.get(ESTIMATE, params={"pincode": "12ab"}).json()["data"]
        assert data["serviceable"] is False and data["message"]

    def test_it_is_rate_limited(self, client, settings_documents):
        codes = [client.get(ESTIMATE, params={"pincode": "560001"}).status_code for _ in range(61)]
        assert codes[-1] == 429
