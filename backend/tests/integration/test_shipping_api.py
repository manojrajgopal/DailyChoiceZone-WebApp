"""
Shipments through the API: courier configuration, creating a shipment (and
never two), the lifecycle at Shiprocket and by hand, courier failures and
retries, what the customer sees, and who may do what.

Nothing reaches a courier: Shiprocket is `FakeShiprocket` on a mock transport.
"""

from __future__ import annotations

import httpx
import pytest
from sqlalchemy import func, select

from app.models import Order
from app.models.shipping import Shipment, ShipmentEvent, ShippingProvider
from tests.integration.test_shipping_helpers import (  # noqa: F401
    CREDENTIALS,
    ORIGIN,
    PACKAGE,
    configure,
    create,
    created,
    event,
    manual_on,
    order,
    place_order,
    shiprocket,
    shiprocket_on,
)
from tests.integration.test_suppliers_helpers import role_headers

pytestmark = pytest.mark.integration

BASE = "/api/admin/shipments"
PROVIDERS = "/api/admin/shipping/providers"


def order_status(db, order_id: str) -> str:
    db.expire_all()
    return db.get(Order, order_id).status


# --------------------------------------------------------------- providers


class TestProviderConfiguration:
    def test_every_adapter_is_listed_configured_or_not(self, client, admin_auth):
        rows = client.get(PROVIDERS, headers=admin_auth).json()["data"]
        assert {r["code"] for r in rows} == {"shiprocket", "manual"}
        shiprocket = next(r for r in rows if r["code"] == "shiprocket")
        assert shiprocket["active"] is False and shiprocket["configured"] is False
        assert shiprocket["webhookUrl"].endswith("/api/shipping/webhooks/shiprocket")
        assert [f["key"] for f in shiprocket["credentialFields"]] == ["email", "password", "webhookToken"]

    def test_credentials_are_sealed_and_only_ever_shown_masked(self, client, admin_auth, db, shiprocket_on):
        row = db.execute(select(ShippingProvider).where(ShippingProvider.code == "shiprocket")).scalar_one()
        assert CREDENTIALS["password"] not in row.credentials and CREDENTIALS["email"] not in row.credentials
        listing = client.get(PROVIDERS, headers=admin_auth).text
        for secret in CREDENTIALS.values():
            assert secret not in listing
        view = next(r for r in client.get(PROVIDERS, headers=admin_auth).json()["data"] if r["code"] == "shiprocket")
        assert view["credentials"]["password"] == "••••••••"
        assert view["credentials"]["webhookToken"].endswith(CREDENTIALS["webhookToken"][-4:])
        assert view["credentials"]["email"].startswith("a••••@")

    def test_a_blank_credential_keeps_the_stored_value(self, client, admin_auth, db, shiprocket_on):
        response = configure(client, admin_auth, "shiprocket", credentials={"email": "", "password": "  "})
        assert response.status_code == 200
        from app.services.shipping import registry

        stored = registry.credentials_of(registry.row_for(db, "shiprocket"))
        assert stored["password"] == CREDENTIALS["password"]

    def test_activating_needs_the_required_credentials(self, client, admin_auth, shiprocket):
        response = configure(client, admin_auth, "shiprocket", active=True)
        assert response.status_code == 422
        assert response.json()["error_code"] == "CREDENTIALS_REQUIRED"

    def test_exactly_one_default(self, client, admin_auth, manual_on, shiprocket_on, db):
        db.expire_all()
        defaults = db.execute(select(ShippingProvider.code).where(ShippingProvider.is_default.is_(True))).scalars()
        assert list(defaults) == ["shiprocket"]
        configure(client, admin_auth, "manual", isDefault=True)
        db.expire_all()
        defaults = db.execute(select(ShippingProvider.code).where(ShippingProvider.is_default.is_(True))).scalars()
        assert list(defaults) == ["manual"]

    def test_an_invalid_origin_pincode_is_refused(self, client, admin_auth):
        response = configure(client, admin_auth, "manual", settings={"origin": {"pincode": "12"}})
        assert response.status_code == 422

    def test_test_connection_signs_in_and_records_the_result(self, client, admin_auth, shiprocket_on, shiprocket):
        result = client.post(f"{PROVIDERS}/shiprocket/test", headers=admin_auth).json()["data"]
        assert result == {"ok": True, "message": "Connected to Shiprocket."}
        assert shiprocket.count("POST /auth/login") >= 1

    def test_rejected_credentials_are_reported_without_echoing_them(self, client, admin_auth, shiprocket):
        configure(client, admin_auth, "shiprocket", credentials={"email": "api@example.com", "password": "wrong-pass"})
        result = client.post(f"{PROVIDERS}/shiprocket/test", headers=admin_auth).json()["data"]
        assert result["ok"] is False and "wrong-pass" not in result["message"]

    def test_an_unknown_provider_is_404(self, client, admin_auth):
        assert configure(client, admin_auth, "fedex", active=True).status_code == 404

    def test_configuring_is_the_super_admins(self, client, db):
        headers = role_headers(db, "ADM901", "admin")
        assert configure(client, headers, "manual", active=True).status_code == 403

    def test_shipments_staff_see_the_list_without_credentials(self, client, db, admin_auth, shiprocket_on):
        headers = role_headers(db, "ADM902", "staff")
        rows = client.get(PROVIDERS, headers=headers).json()["data"]
        assert all(r["credentials"] == {} for r in rows)

    def test_a_role_without_either_permission_is_refused(self, client, db):
        headers = role_headers(db, "ADM903", "editor")
        assert client.get(PROVIDERS, headers=headers).status_code == 403


# ---------------------------------------------------------------- creating


class TestCreatingManually:
    def test_a_manual_shipment_is_ready_with_the_typed_awb(self, client, admin_auth, order, manual_on, db):
        shipment = created(client, admin_auth, order["id"])
        assert shipment["status"] == "ready-for-pickup"
        assert shipment["awb"] == "LX-100200" and shipment["courierName"] == "Local Express"
        assert shipment["shipmentNumber"].startswith("DCZ-SH-")
        assert shipment["technical"]["requestStatus"] == "ok"
        assert db.get(Order, order["id"]).tracking_number == "LX-100200"

    def test_the_same_key_again_returns_the_same_shipment(self, client, admin_auth, order, manual_on, db):
        first = created(client, admin_auth, order["id"])
        again = create(client, admin_auth, order["id"])
        assert again.status_code == 200
        assert again.json()["data"]["id"] == first["id"]
        assert db.execute(select(func.count()).select_from(Shipment)).scalar_one() == 1

    def test_a_different_key_while_one_is_active_is_409(self, client, admin_auth, order, manual_on):
        created(client, admin_auth, order["id"])
        response = create(client, admin_auth, order["id"], key="key-00000002", awb="LX-999")
        assert response.status_code == 409 and response.json()["error_code"] == "SHIPMENT_EXISTS"

    def test_a_new_shipment_is_allowed_once_the_first_is_cancelled(self, client, admin_auth, order, manual_on):
        first = created(client, admin_auth, order["id"])
        client.post(f"{BASE}/{first['id']}/cancel", headers=admin_auth, json={"reason": "Wrong box"})
        second = created(client, admin_auth, order["id"], key="key-00000002", awb="LX-100201")
        assert second["id"] != first["id"]

    def test_an_awb_already_used_is_refused(self, client, admin_auth, order, manual_on, auth):
        created(client, admin_auth, order["id"])
        other = place_order(client, auth, product_id="PRD002")
        response = create(client, admin_auth, other["id"], key="key-00000009")
        assert response.status_code == 409 and response.json()["error_code"] == "AWB_EXISTS"

    def test_manual_needs_the_courier_name_and_awb(self, client, admin_auth, order, manual_on):
        assert create(client, admin_auth, order["id"], courierName="").json()["error_code"] == "COURIER_NAME_REQUIRED"
        assert create(client, admin_auth, order["id"], awb="!!").json()["error_code"] == "AWB_REQUIRED"

    def test_weight_is_required_and_checked(self, client, admin_auth, order, manual_on):
        response = create(client, admin_auth, order["id"], package={"weightGrams": None})
        assert response.status_code == 422 and response.json()["error_code"] == "PACKAGE_REQUIRED"
        response = create(client, admin_auth, order["id"], package={"weightGrams": -5})
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_PACKAGE"

    def test_a_short_idempotency_key_is_refused(self, client, admin_auth, order, manual_on):
        assert create(client, admin_auth, order["id"], key="abc").status_code == 422

    def test_an_unknown_order_is_404(self, client, admin_auth, manual_on):
        assert create(client, admin_auth, "ORD999").status_code == 404

    def test_an_order_awaiting_payment_is_refused(self, client, admin_auth, order, manual_on, db):
        # The mock gateway settles at once, so a real gateway's "not paid yet" is set by hand.
        row = db.get(Order, order["id"])
        row.status, row.payment_method, row.payment_status = "pending", "upi", "pending"
        db.flush()
        response = create(client, admin_auth, order["id"])
        assert response.status_code == 409 and response.json()["error_code"] == "AWAITING_PAYMENT"

    def test_a_cancelled_order_is_refused(self, client, admin_auth, order, manual_on, db):
        db.get(Order, order["id"]).status = "cancelled"
        db.flush()
        response = create(client, admin_auth, order["id"])
        assert response.status_code == 409 and response.json()["error_code"] == "ORDER_NOT_SHIPPABLE"

    def test_an_inactive_provider_is_refused(self, client, admin_auth, order):
        response = create(client, admin_auth, order["id"])
        assert response.status_code == 400 and response.json()["error_code"] == "PROVIDER_INACTIVE"

    def test_creation_is_audited(self, client, admin_auth, order, manual_on, db):
        from app.models import AuditLog

        created(client, admin_auth, order["id"])
        actions = db.execute(select(AuditLog.action)).scalars().all()
        assert "shipment.create" in actions


class TestCreatingAtShiprocket:
    def test_books_the_order_then_assigns_the_awb(self, client, admin_auth, order, shiprocket_on, shiprocket):
        shipment = created(client, admin_auth, order["id"], provider="shiprocket")
        assert shipment["status"] == "ready-for-pickup"
        assert shipment["awb"] == "SR123456789" and shipment["courierName"] == "Delhivery Surface"
        assert shipment["providerOrderId"] == "5551" and shipment["providerShipmentId"] == "9871"
        assert shiprocket.count("POST /orders/create/adhoc") == 1
        assert shiprocket.count("POST /courier/assign/awb") == 1
        booked = next(r for r in shiprocket.calls if r.url.path.endswith("/orders/create/adhoc"))
        body = __import__("json").loads(booked.content)
        assert body["order_id"] == shipment["shipmentNumber"] and body["pickup_location"] == "Primary"
        assert body["payment_method"] == "COD"

    def test_dimensions_are_required_for_an_api_courier(self, client, admin_auth, order, shiprocket_on):
        response = create(client, admin_auth, order["id"], provider="shiprocket", package={"weightGrams": 500})
        assert response.status_code == 422 and response.json()["error_code"] == "PACKAGE_REQUIRED"

    def test_a_timeout_leaves_a_pending_record_that_retry_continues(self, client, admin_auth, order, shiprocket_on,
                                                                    shiprocket, db):
        shiprocket.answer("POST /orders/create/adhoc", httpx.ReadTimeout("slow"))
        response = create(client, admin_auth, order["id"], provider="shiprocket")
        assert response.status_code == 201
        shipment = response.json()["data"]
        assert shipment["status"] == "pending"
        assert shipment["technical"]["requestStatus"] == "failed"
        assert shipment["technical"]["nextRetryAt"] is not None
        assert shipment["actions"]["retry"] is True and shipment["actions"]["editPackage"] is True

        shiprocket.answers.clear()
        retried = client.post(f"{BASE}/{shipment['id']}/retry", headers=admin_auth).json()["data"]
        assert retried["status"] == "ready-for-pickup" and retried["technical"]["retryCount"] == 0
        # The retry looked for the courier order before creating another.
        assert shiprocket.count("GET /orders") == 1

    def test_an_awb_failure_keeps_the_courier_order_and_retry_only_assigns(self, client, admin_auth, order,
                                                                            shiprocket_on, shiprocket):
        shiprocket.answer("POST /courier/assign/awb", httpx.Response(503, json={"message": "busy"}))
        shipment = create(client, admin_auth, order["id"], provider="shiprocket").json()["data"]
        assert shipment["providerShipmentId"] == "9871" and shipment["awb"] == ""
        shiprocket.answers.clear()
        client.post(f"{BASE}/{shipment['id']}/retry", headers=admin_auth)
        assert shiprocket.count("POST /orders/create/adhoc") == 1
        assert shiprocket.count("POST /courier/assign/awb") == 2

    def test_a_refusal_is_not_retried_automatically_and_alerts(self, client, admin_auth, order, shiprocket_on,
                                                               shiprocket, db):
        shiprocket.answer("POST /orders/create/adhoc",
                          httpx.Response(422, json={"message": "Invalid delivery pincode"}))
        shipment = create(client, admin_auth, order["id"], provider="shiprocket").json()["data"]
        assert shipment["technical"]["lastError"] == "Invalid delivery pincode"
        assert shipment["technical"]["nextRetryAt"] is None
        row = db.get(Shipment, shipment["id"])
        assert "create-failed" in row.alerts_sent

    def test_the_order_is_never_moved_by_a_failed_booking(self, client, admin_auth, order, shiprocket_on,
                                                          shiprocket, db):
        shiprocket.answer("POST /orders/create/adhoc", httpx.Response(500))
        create(client, admin_auth, order["id"], provider="shiprocket")
        assert order_status(db, order["id"]) == "confirmed"

    def test_a_secret_never_appears_in_an_error(self, client, admin_auth, order, shiprocket_on, shiprocket):
        shiprocket.answer("POST /orders/create/adhoc",
                          httpx.Response(400, json={"message": f"bad login {CREDENTIALS['password']}"}))
        text = create(client, admin_auth, order["id"], provider="shiprocket").text
        assert CREDENTIALS["password"] not in text

    def test_rates_come_from_the_courier_in_rupees(self, client, admin_auth, order, shiprocket_on):
        response = client.post(f"/api/admin/orders/{order['id']}/shipping/rates", headers=admin_auth,
                               json={"providerCode": "shiprocket", "package": PACKAGE})
        options = response.json()["data"]["options"]
        assert options[0] == {"courierCode": "12", "courierName": "Delhivery Surface", "rate": 85.5, "etaDays": 4,
                              "estimatedDeliveryAt": "2026-10-09T00:00:00", "codAvailable": True}

    def test_rates_when_the_courier_is_down_are_503(self, client, admin_auth, order, shiprocket_on, shiprocket):
        shiprocket.answer("GET /courier/serviceability/", httpx.ConnectError("down"))
        response = client.post(f"/api/admin/orders/{order['id']}/shipping/rates", headers=admin_auth,
                               json={"providerCode": "shiprocket", "package": PACKAGE})
        assert response.status_code == 503 and response.json()["error_code"] == "COURIER_UNAVAILABLE"

    def test_manual_has_no_rates(self, client, admin_auth, order, manual_on):
        response = client.post(f"/api/admin/orders/{order['id']}/shipping/rates", headers=admin_auth,
                               json={"providerCode": "manual", "package": PACKAGE})
        assert response.status_code == 400 and response.json()["error_code"] == "UNSUPPORTED"


# ------------------------------------------------------------- operating


class TestOperating:
    @pytest.fixture()
    def booked(self, client, admin_auth, order, shiprocket_on):
        return created(client, admin_auth, order["id"], provider="shiprocket")

    def test_actions_follow_the_status_and_the_provider(self, booked):
        assert booked["actions"] == {"label": True, "pickup": True, "cancel": True, "refresh": True, "retry": False,
                                     "manualEvent": True, "editPackage": False}

    def test_label_then_pickup(self, client, admin_auth, booked, shiprocket):
        labelled = client.post(f"{BASE}/{booked['id']}/label", headers=admin_auth).json()["data"]
        assert labelled["label"] == {"available": True, "url": "https://labels.example.com/l.pdf"}
        again = client.post(f"{BASE}/{booked['id']}/label", headers=admin_auth)
        assert again.status_code == 200 and shiprocket.count("POST /courier/generate/label") == 1
        picked = client.post(f"{BASE}/{booked['id']}/pickup", headers=admin_auth).json()["data"]
        assert picked["status"] == "pickup-scheduled"
        assert picked["pickup"]["status"] == "scheduled" and picked["pickup"]["token"] == "PK-77"

    def test_a_failed_pickup_is_reported_and_alerted(self, client, admin_auth, booked, shiprocket, db):
        shiprocket.answer("POST /courier/generate/pickup",
                          httpx.Response(400, json={"message": "Pickup address not verified"}))
        response = client.post(f"{BASE}/{booked['id']}/pickup", headers=admin_auth)
        assert response.status_code == 400
        assert response.json()["message"] == "Pickup address not verified"
        row = db.get(Shipment, booked["id"])
        assert row.pickup_status == "failed" and "pickup-failed" in row.alerts_sent

    def test_cancel_before_pickup_cancels_at_the_courier(self, client, admin_auth, booked, shiprocket, db, order):
        cancelled = client.post(f"{BASE}/{booked['id']}/cancel", headers=admin_auth,
                                json={"reason": "Customer changed address"}).json()["data"]
        assert cancelled["status"] == "cancelled" and cancelled["cancelReason"] == "Customer changed address"
        assert shiprocket.count("POST /orders/cancel") == 1
        db.expire_all()
        assert db.get(Shipment, booked["id"]).active_key is None
        assert db.get(Order, order["id"]).tracking_number is None

    def test_cancel_after_pickup_is_refused(self, client, admin_auth, booked):
        event(client, admin_auth, booked["id"], "picked-up")
        response = client.post(f"{BASE}/{booked['id']}/cancel", headers=admin_auth, json={"reason": "late"})
        assert response.status_code == 409 and response.json()["error_code"] == "SHIPMENT_NOT_CANCELLABLE"

    def test_a_failed_cancel_keeps_the_shipment_active(self, client, admin_auth, booked, shiprocket, db):
        shiprocket.answer("POST /orders/cancel", httpx.Response(502))
        response = client.post(f"{BASE}/{booked['id']}/cancel", headers=admin_auth, json={"reason": "x"})
        assert response.status_code == 503
        db.expire_all()
        row = db.get(Shipment, booked["id"])
        assert row.status == "ready-for-pickup" and row.active_key is not None

    def test_refresh_applies_new_scans_and_moves_the_order(self, client, admin_auth, booked, shiprocket, db, order):
        shiprocket.tracking = {"tracking_data": {
            "shipment_track": [{"current_status": "IN TRANSIT", "edd": "2026-10-09 18:00:00"}],
            "shipment_track_activities": [
                {"date": "2026-10-06 18:00:00", "status": "IN TRANSIT", "activity": "Bag received",
                 "location": "Mumbai Hub", "sr-status-label": "IN TRANSIT"},
                {"date": "2026-10-06 10:00:00", "status": "PICKED UP", "activity": "Shipment picked up",
                 "location": "Bengaluru", "sr-status-label": "PICKED UP"},
            ]}}
        shipment = client.post(f"{BASE}/{booked['id']}/refresh", headers=admin_auth).json()["data"]
        assert shipment["status"] == "in-transit"
        assert shipment["expectedDeliveryAt"] == "2026-10-09T18:00:00"
        assert order_status(db, order["id"]) == "in-transit"
        # The same scans again add nothing.
        client.post(f"{BASE}/{booked['id']}/refresh", headers=admin_auth)
        count = db.execute(select(func.count()).select_from(ShipmentEvent).where(
            ShipmentEvent.shipment_id == booked["id"], ShipmentEvent.source == "poll")).scalar_one()
        assert count == 2

    def test_refresh_is_rate_limited(self, client, admin_auth, booked):
        for _ in range(2):
            client.post(f"{BASE}/{booked['id']}/refresh", headers=admin_auth)
        assert client.post(f"{BASE}/{booked['id']}/refresh", headers=admin_auth).status_code == 429

    def test_unknown_courier_text_is_recorded_but_moves_nothing(self, client, admin_auth, booked, shiprocket, db):
        shiprocket.tracking = {"tracking_data": {"shipment_track": [{"current_status": "MISROUTED-ZONE-9"}],
                                                 "shipment_track_activities": [
            {"date": "2026-10-06 10:00:00", "status": "MISROUTED-ZONE-9", "activity": "Zone code 9",
             "location": "", "sr-status-label": "NA"}]}}
        shipment = client.post(f"{BASE}/{booked['id']}/refresh", headers=admin_auth).json()["data"]
        assert shipment["status"] == "ready-for-pickup"
        assert any(e["providerStatus"] == "MISROUTED-ZONE-9" and e["status"] == "" for e in shipment["events"])

    def test_the_package_can_change_only_while_pending(self, client, admin_auth, booked):
        response = client.put(f"{BASE}/{booked['id']}/package", headers=admin_auth, json={"package": PACKAGE})
        assert response.status_code == 409 and response.json()["error_code"] == "SHIPMENT_NOT_EDITABLE"

    def test_nothing_to_retry(self, client, admin_auth, booked):
        response = client.post(f"{BASE}/{booked['id']}/retry", headers=admin_auth)
        assert response.status_code == 409 and response.json()["error_code"] == "NOTHING_TO_RETRY"


class TestManualEvents:
    @pytest.fixture()
    def shipment(self, client, admin_auth, order, manual_on):
        return created(client, admin_auth, order["id"])

    def test_each_milestone_moves_the_order_forward(self, client, admin_auth, shipment, db, order):
        steps = [("picked-up", "shipped"), ("in-transit", "in-transit"),
                 ("out-for-delivery", "out-for-delivery"), ("delivered", "delivered")]
        for status, expected in steps:
            response = event(client, admin_auth, shipment["id"], status)
            assert response.status_code == 201, response.text
            assert order_status(db, order["id"]) == expected
        final = client.get(f"{BASE}/{shipment['id']}", headers=admin_auth).json()["data"]
        assert final["deliveredAt"] is not None
        assert final["actions"]["manualEvent"] is False

    def test_skipping_ahead_is_allowed_but_never_backwards(self, client, admin_auth, shipment, db, order):
        assert event(client, admin_auth, shipment["id"], "out-for-delivery").status_code == 201
        assert order_status(db, order["id"]) == "out-for-delivery"
        response = event(client, admin_auth, shipment["id"], "picked-up")
        assert response.status_code == 409 and response.json()["error_code"] == "INVALID_SHIPMENT_TRANSITION"

    def test_a_delivered_shipment_is_closed(self, client, admin_auth, shipment):
        event(client, admin_auth, shipment["id"], "delivered")
        response = event(client, admin_auth, shipment["id"], "in-transit")
        assert response.status_code == 409 and response.json()["error_code"] == "SHIPMENT_CLOSED"

    def test_unknown_and_reserved_statuses_are_refused(self, client, admin_auth, shipment):
        for status in ("teleported", "pending", "cancelled", ""):
            assert event(client, admin_auth, shipment["id"], status).status_code == 422

    def test_a_future_time_is_refused(self, client, admin_auth, shipment):
        response = event(client, admin_auth, shipment["id"], "picked-up", occurredAt="2099-01-01T10:00:00")
        assert response.status_code == 422

    def test_delivery_failure_alerts_and_leaves_the_order(self, client, admin_auth, shipment, db, order):
        event(client, admin_auth, shipment["id"], "picked-up")
        event(client, admin_auth, shipment["id"], "delivery-failed")
        assert order_status(db, order["id"]) == "shipped"
        assert "delivery-failed" in db.get(Shipment, shipment["id"]).alerts_sent

    def test_an_attempt_can_be_followed_by_another_run(self, client, admin_auth, shipment):
        event(client, admin_auth, shipment["id"], "out-for-delivery")
        assert event(client, admin_auth, shipment["id"], "delivery-attempted").status_code == 201
        assert event(client, admin_auth, shipment["id"], "out-for-delivery").status_code == 201

    def test_manual_has_no_tracking_to_refresh(self, client, admin_auth, shipment):
        response = client.post(f"{BASE}/{shipment['id']}/refresh", headers=admin_auth)
        assert response.status_code == 400 and response.json()["error_code"] == "UNSUPPORTED"

    def test_the_order_moves_through_its_own_state_machine(self, client, admin_auth, shipment, db, order):
        from app.models import OrderEvent

        event(client, admin_auth, shipment["id"], "picked-up")
        notes = db.execute(select(OrderEvent.status, OrderEvent.note).where(
            OrderEvent.order_id == order["id"])).all()
        assert any(status == "shipped" and note.endswith(f"Courier update for shipment {shipment['shipmentNumber']}.")
                   for status, note in notes)

    def test_courier_moments_notify_the_customer_once(self, client, admin_auth, order, manual_on, monkeypatch):
        from app.services.email import notifications

        sent = []
        monkeypatch.setattr(notifications, "notify_shipment",
                            lambda db, shipment, order, key, suffix="": sent.append((key, suffix)) or True)
        shipment = created(client, admin_auth, order["id"])
        event(client, admin_auth, shipment["id"], "out-for-delivery")
        event(client, admin_auth, shipment["id"], "delivery-attempted")
        event(client, admin_auth, shipment["id"], "delivery-failed")
        event(client, admin_auth, shipment["id"], "returned-to-origin")
        assert [key for key, _ in sent] == ["shipment_created", "delivery_attempted", "delivery_failed",
                                           "shipment_returned"]


# ------------------------------------------------------------- reading


class TestReading:
    def test_list_search_filter_and_counts(self, client, admin_auth, order, manual_on):
        shipment = created(client, admin_auth, order["id"])
        data = client.get(BASE, headers=admin_auth, params={"q": "LX-100200"}).json()["data"]
        assert [r["id"] for r in data["items"]] == [shipment["id"]]
        assert data["counts"] == {"ready-for-pickup": 1}
        assert client.get(BASE, headers=admin_auth, params={"q": "nothing-like-it"}).json()["data"]["items"] == []
        assert client.get(BASE, headers=admin_auth, params={"status": "delivered"}).json()["data"]["items"] == []
        by_number = client.get(BASE, headers=admin_auth, params={"q": order["orderNumber"]}).json()["data"]
        assert by_number["pagination"]["total"] == 1

    def test_an_unknown_shipment_is_404(self, client, admin_auth):
        response = client.get(f"{BASE}/999999", headers=admin_auth)
        assert response.status_code == 404 and response.json()["error_code"] == "SHIPMENT_NOT_FOUND"

    def test_order_overview_says_why_it_cant_create(self, client, admin_auth, order, manual_on):
        overview = client.get(f"/api/admin/orders/{order['id']}/shipping", headers=admin_auth).json()["data"]
        assert overview["canCreate"] is True and overview["providers"][0]["code"] == "manual"
        created(client, admin_auth, order["id"])
        overview = client.get(f"/api/admin/orders/{order['id']}/shipping", headers=admin_auth).json()["data"]
        assert overview["canCreate"] is False and overview["activeShipmentId"] is not None
        assert overview["reason"]

    def test_order_overview_with_no_courier_on(self, client, admin_auth, order):
        overview = client.get(f"/api/admin/orders/{order['id']}/shipping", headers=admin_auth).json()["data"]
        assert overview["canCreate"] is False and "Couriers" in overview["reason"]


class TestCustomerView:
    def test_the_customer_sees_their_timeline_and_nothing_internal(self, client, admin_auth, auth, order,
                                                                    shiprocket_on, shiprocket):
        shiprocket.answer("POST /courier/assign/awb", httpx.Response(500), )
        shipment = created(client, admin_auth, order["id"], provider="shiprocket")
        shiprocket.answers.clear()
        client.post(f"{BASE}/{shipment['id']}/retry", headers=admin_auth)
        event(client, admin_auth, shipment["id"], "picked-up", description="Collected")
        event(client, admin_auth, shipment["id"], "in-transit", visible=False, description="Internal note")

        response = client.get(f"/api/orders/{order['orderNumber']}/shipments", headers=auth)
        assert response.status_code == 200
        [mine] = response.json()["data"]
        assert set(mine) == {"shipmentNumber", "status", "statusLabel", "courierName", "service", "awb",
                             "trackingUrl", "expectedDeliveryAt", "deliveredAt", "createdAt", "events"}
        assert [e["status"] for e in mine["events"]] == ["ready-for-pickup", "picked-up"]
        assert all(set(e) == {"status", "label", "description", "location", "occurredAt", "source"}
                   for e in mine["events"])
        text = response.text
        for internal in ("Internal note", "failed", "9871", "5551", "retry", "lastError"):
            assert internal not in text

    def test_another_customers_order_is_404(self, client, admin_auth, order, manual_on, other_customer):
        from app.core.security import create_access_token

        created(client, admin_auth, order["id"])
        stranger = {"Authorization": "Bearer " + create_access_token(other_customer.id, actor="customer")}
        assert client.get(f"/api/orders/{order['orderNumber']}/shipments", headers=stranger).status_code == 404

    def test_cancelled_shipments_stay_in_the_history(self, client, admin_auth, auth, order, manual_on):
        first = created(client, admin_auth, order["id"])
        client.post(f"{BASE}/{first['id']}/cancel", headers=admin_auth, json={"reason": "Re-packed"})
        created(client, admin_auth, order["id"], key="key-00000002", awb="LX-100201")
        rows = client.get(f"/api/orders/{order['id']}/shipments", headers=auth).json()["data"]
        assert [r["status"] for r in rows] == ["cancelled", "ready-for-pickup"]
        assert rows[0]["trackingUrl"] == ""


class TestPermissions:
    def test_a_customer_token_is_refused_on_admin_routes(self, client, auth, order):
        assert client.get(BASE, headers=auth).status_code == 403
        assert client.get(f"/api/admin/orders/{order['id']}/shipping", headers=auth).status_code == 403

    @pytest.mark.parametrize("role", ["editor"])
    def test_roles_without_shipments_are_refused(self, client, db, role):
        assert client.get(BASE, headers=role_headers(db, "ADM904", role)).status_code == 403

    @pytest.mark.parametrize("role", ["staff", "manager", "admin"])
    def test_operating_roles_may_operate(self, client, db, role, order, manual_on):
        headers = role_headers(db, "ADM905", role)
        assert create(client, headers, order["id"]).status_code == 201
