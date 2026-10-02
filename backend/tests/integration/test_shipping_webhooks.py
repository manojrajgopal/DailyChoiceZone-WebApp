"""
Courier webhooks (Shiprocket): verification, de-duplication, unknown parcels,
malformed bodies and failures, and what a delivery does to the shipment and
the order.
"""

from __future__ import annotations

import json

import pytest
from sqlalchemy import func, select

from app.models import Order
from app.models.shipping import Shipment, ShipmentEvent, ShippingWebhookEvent
from tests.integration.test_shipping_helpers import (  # noqa: F401
    WEBHOOK_TOKEN,
    created,
    order,
    shiprocket,
    shiprocket_on,
    webhook,
)

pytestmark = pytest.mark.integration


def payload(awb: str = "SR123456789", status: str = "IN TRANSIT", **extra) -> dict:
    body = {
        "awb": awb, "courier_name": "Delhivery Surface", "current_status": status,
        "current_timestamp": "2026-10-06 18:00:00", "order_id": "DCZ-SH-2026-000001", "etd": "2026-10-09 12:00:00",
        "scans": [
            {"date": "2026-10-06 10:00:00", "status": "PICKED UP", "activity": "Shipment picked up",
             "location": "Bengaluru", "sr-status-label": "PICKED UP"},
            {"date": "2026-10-06 18:00:00", "status": "IN TRANSIT", "activity": "Bag received",
             "location": "Mumbai Hub", "sr-status-label": "IN TRANSIT"},
        ],
        # A courier may include the customer's details: these must never be stored.
        "customer_name": "Asha Rao", "customer_phone": "9876500001", "customer_email": "shopper@example.com",
    }
    body.update(extra)
    return body


@pytest.fixture()
def booked(client, admin_auth, order, shiprocket_on):
    return created(client, admin_auth, order["id"], provider="shiprocket")


def records(db):
    db.expire_all()
    return list(db.execute(select(ShippingWebhookEvent).order_by(ShippingWebhookEvent.id)).scalars())


class TestVerification:
    def test_a_missing_token_is_401_and_nothing_is_recorded(self, client, booked, db):
        response = webhook(client, payload(), token=None)
        assert response.status_code == 401 and response.json()["error_code"] == "WEBHOOK_UNVERIFIED"
        assert records(db) == []

    def test_a_wrong_token_is_401(self, client, booked, db):
        assert webhook(client, payload(), token="not-the-token").status_code == 401
        assert db.get(Shipment, booked["id"]).status == "ready-for-pickup"

    def test_an_unconfigured_courier_accepts_nothing(self, client, shiprocket):
        assert webhook(client, payload()).status_code == 401

    def test_a_courier_without_webhooks_is_404(self, client):
        assert webhook(client, payload(), code="manual").status_code == 404

    def test_an_unknown_courier_is_404(self, client):
        assert webhook(client, payload(), code="fedex").status_code == 404

    def test_a_body_that_isnt_json_is_400(self, client, booked):
        response = webhook(client, b"{not json")
        assert response.status_code == 400 and response.json()["error_code"] == "WEBHOOK_MALFORMED"

    def test_a_json_list_is_400(self, client, booked):
        assert webhook(client, b"[1, 2]").status_code == 400

    def test_a_body_over_256_kb_is_413(self, client, booked):
        huge = json.dumps(payload(padding="x" * (257 * 1024)))
        assert webhook(client, huge).status_code == 413

    def test_the_token_is_checked_before_the_size_leaks_anything(self, client, booked, db):
        assert webhook(client, b"{bad", token="wrong").status_code == 401
        assert records(db) == []


class TestProcessing:
    def test_a_delivery_moves_the_shipment_and_the_order(self, client, booked, db, order):
        response = webhook(client, payload())
        assert response.status_code == 200 and response.json()["data"] == {"result": "processed"}
        db.expire_all()
        shipment = db.get(Shipment, booked["id"])
        assert shipment.status == "in-transit" and shipment.last_webhook_at is not None
        assert db.get(Order, order["id"]).status == "in-transit"
        [record] = records(db)
        assert record.status == "processed" and record.shipment_id == booked["id"]

    def test_only_courier_fields_are_stored(self, client, booked, db):
        webhook(client, payload())
        [record] = records(db)
        stored = json.dumps(record.payload)
        assert "SR123456789" in stored
        for private in ("Asha Rao", "9876500001", "shopper@example.com", "customer_"):
            assert private not in stored

    def test_the_same_delivery_twice_is_a_duplicate(self, client, booked, db):
        body = json.dumps(payload())
        webhook(client, body)
        again = webhook(client, body)
        assert again.status_code == 200 and again.json()["data"] == {"result": "duplicate"}
        [record] = records(db)
        assert record.attempts == 2
        events = db.execute(select(func.count()).select_from(ShipmentEvent).where(
            ShipmentEvent.shipment_id == booked["id"], ShipmentEvent.source == "webhook")).scalar_one()
        assert events == 2  # the two scans, once (the current status adds nothing they didn't)

    def test_a_resent_scan_in_a_new_delivery_adds_no_event(self, client, booked, db):
        webhook(client, payload())
        webhook(client, payload(status="IN TRANSIT", current_timestamp="2026-10-06 19:00:00"))
        rows = db.execute(select(ShipmentEvent.provider_status).where(
            ShipmentEvent.shipment_id == booked["id"], ShipmentEvent.source == "webhook")).scalars().all()
        assert rows.count("PICKED UP") == 1

    def test_an_unknown_awb_is_200_and_ignored(self, client, booked, db):
        response = webhook(client, payload(awb="NOPE000", order_id="nothing"))
        assert response.status_code == 200 and response.json()["data"] == {"result": "ignored"}
        assert records(db)[0].status == "ignored"

    def test_unknown_status_text_is_recorded_and_moves_nothing(self, client, booked, db):
        webhook(client, payload(status="ZONE-SHIFTED", scans=[]))
        db.expire_all()
        assert db.get(Shipment, booked["id"]).status == "ready-for-pickup"
        row = db.execute(select(ShipmentEvent).where(ShipmentEvent.provider_status == "ZONE-SHIFTED")).scalar_one()
        assert row.status == ""

    def test_a_late_scan_never_moves_a_delivered_shipment_back(self, client, booked, db):
        webhook(client, payload(status="DELIVERED", scans=[
            {"date": "2026-10-08 12:00:00", "status": "DELIVERED", "activity": "Delivered",
             "location": "Bengaluru", "sr-status-label": "DELIVERED"}]))
        webhook(client, payload(status="IN TRANSIT", current_timestamp="2026-10-09 10:00:00"))
        db.expire_all()
        assert db.get(Shipment, booked["id"]).status == "delivered"

    def test_a_processing_failure_is_500_recorded_and_safe_to_resend(self, client, booked, db, monkeypatch):
        from app.services.shipping import service

        real = service.apply_tracking

        def broken(*args, **kwargs):
            raise RuntimeError("database hiccup")

        monkeypatch.setattr(service, "apply_tracking", broken)
        body = json.dumps(payload())
        response = webhook(client, body)
        assert response.status_code == 500 and "hiccup" not in response.text
        [record] = records(db)
        assert record.status == "failed"
        assert "webhook-failed" in db.get(Shipment, booked["id"]).alerts_sent

        monkeypatch.setattr(service, "apply_tracking", real)
        resent = webhook(client, body)
        assert resent.json()["data"] == {"result": "processed"}
        [record] = records(db)
        assert record.status == "processed" and record.attempts == 2
