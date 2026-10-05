"""
The shipping rules that need no database: which status moves are allowed,
how courier text is read, package validation, credential masking, and how
the Shiprocket adapter classifies failures and verifies webhooks.
"""

from __future__ import annotations

import json
from datetime import datetime

import httpx
import pytest

from app.core.errors import ValidationError
from app.services.shipping import service, shiprocket
from app.services.shipping.base import STATUSES, TERMINAL, ProviderError, TrackingEvent, WebhookRejected
from app.services.shipping.providers import mask_credential


class TestTransitions:
    @pytest.mark.parametrize("current,new", [
        ("pending", "ready-for-pickup"), ("ready-for-pickup", "picked-up"), ("picked-up", "delivered"),
        ("in-transit", "delivery-attempted"), ("delivery-attempted", "out-for-delivery"),
        ("out-for-delivery", "delivery-failed"), ("delivery-failed", "returned-to-origin"),
        ("pickup-scheduled", "cancelled"), ("pending", "cancelled"),
    ])
    def test_allowed(self, current, new):
        assert service.can_move(current, new)

    def test_a_failed_delivery_can_be_dispatched_again(self):
        # The courier re-attempts after a failure (docs/order-fulfilment.md).
        assert service.can_move("delivery-failed", "in-transit")
        assert service.can_move("delivery-failed", "out-for-delivery")

    @pytest.mark.parametrize("current,new", [
        ("in-transit", "picked-up"), ("picked-up", "cancelled"), ("out-for-delivery", "pending"),
        ("pending", "returned-to-origin"), ("ready-for-pickup", "ready-for-pickup"), ("pending", "teleported"),
        ("delivered", "in-transit"), ("pending", "delivery-attempted"),
    ])
    def test_refused(self, current, new):
        assert not service.can_move(current, new)

    @pytest.mark.parametrize("terminal", sorted(TERMINAL))
    def test_nothing_leaves_a_terminal_status(self, terminal):
        assert not any(service.can_move(terminal, new) for new in STATUSES)


class TestCourierText:
    @pytest.mark.parametrize("text,status", [
        ("PICKED UP", "picked-up"), ("In Transit", "in-transit"), ("OUT FOR DELIVERY", "out-for-delivery"),
        ("Delivered", "delivered"), ("UNDELIVERED", "delivery-attempted"), ("RTO Initiated", "returned-to-origin"),
        ("REACHED AT DESTINATION HUB", "at-destination-hub"), ("Pickup Scheduled", "pickup-scheduled"),
        ("AWB_ASSIGNED", "ready-for-pickup"), ("Canceled", "cancelled"), ("LOST", "delivery-failed"),
        ("something new", ""), ("", ""), (None, ""), (42, ""),
    ])
    def test_mapping(self, text, status):
        assert shiprocket.map_status(text) == status

    @pytest.mark.parametrize("text", ["2026-10-06 18:00:00", "06-10-2026 18:00", "Oct 06, 2026",
                                      "2026-10-06T18:00:00+05:30"])
    def test_dates_in_the_shapes_seen(self, text):
        assert shiprocket.parse_date(text).date() == datetime(2026, 10, 6).date()

    def test_an_unreadable_date_is_none(self):
        assert shiprocket.parse_date("soon") is None and shiprocket.parse_date(None) is None

    def test_dedupe_key_is_stable_and_prefers_the_provider_id(self):
        event = TrackingEvent("in-transit", "IN TRANSIT", "Bag", "Hub", datetime(2026, 10, 6, 18))
        assert service.dedupe_key(event) == service.dedupe_key(TrackingEvent(
            "in-transit", "IN TRANSIT", "different words", "Hub", datetime(2026, 10, 6, 18)))
        event.provider_event_id = "evt-1"
        assert service.dedupe_key(event) == "evt-1"


class TestPackage:
    def test_weight_only_is_enough_without_dimensions(self):
        package = service.clean_package({"weightGrams": "800"}, require_dimensions=False)
        assert package.weight_grams == 800 and package.length_cm is None and package.count == 1

    @pytest.mark.parametrize("raw,code", [
        (None, "PACKAGE_REQUIRED"), ({}, "PACKAGE_REQUIRED"), ({"weightGrams": 0}, "INVALID_PACKAGE"),
        ({"weightGrams": 100001}, "INVALID_PACKAGE"), ({"weightGrams": 1.5}, "INVALID_PACKAGE"),
        ({"weightGrams": "abc"}, "INVALID_PACKAGE"), ({"weightGrams": True}, "PACKAGE_REQUIRED"),
        ({"weightGrams": 500, "lengthCm": 400}, "INVALID_PACKAGE"),
        ({"weightGrams": 500, "count": 0}, "INVALID_PACKAGE"),
    ])
    def test_refused(self, raw, code):
        with pytest.raises(ValidationError) as caught:
            service.clean_package(raw, require_dimensions=False)
        assert caught.value.error_code == code

    def test_an_api_courier_needs_every_dimension(self):
        with pytest.raises(ValidationError) as caught:
            service.clean_package({"weightGrams": 500, "lengthCm": 10, "widthCm": 10}, require_dimensions=True)
        assert caught.value.details == {"field": "heightCm"}


class TestMasking:
    def test_masks(self):
        assert mask_credential("password", "secret") == "••••••••"
        assert mask_credential("email", "api@example.com") == "a••••@example.com"
        assert mask_credential("webhookToken", "abcdefgh1234") == "••••1234"
        assert mask_credential("password", "") == ""


# ------------------------------------------------------------- the adapter


def adapter(handler, **credentials):
    shiprocket.reset_tokens()
    shiprocket.TRANSPORT = httpx.MockTransport(handler)
    creds = {"email": "api@example.com", "password": "pw-12345678", "webhookToken": "tok-abcdef123"}
    creds.update(credentials)
    return shiprocket.ShiprocketProvider(config={"pickupLocation": "Primary"}, credentials=creds)


@pytest.fixture(autouse=True)
def _restore_transport():
    yield
    shiprocket.TRANSPORT = None
    shiprocket.reset_tokens()


def login_then(answer):
    def handler(request):
        if request.url.path.endswith("/auth/login"):
            return httpx.Response(200, json={"token": "t"})
        return answer(request) if callable(answer) else answer
    return handler


class TestFailures:
    @pytest.mark.parametrize("answer,transient", [
        (httpx.Response(500), True), (httpx.Response(503), True), (httpx.Response(429), True),
        (httpx.Response(400, json={"message": "Invalid pincode"}), False),
        (httpx.Response(422, json={"errors": {"pincode": ["is invalid"]}}), False),
        (httpx.Response(200, text="<html>"), False),
    ])
    def test_classification(self, answer, transient):
        with pytest.raises(ProviderError) as caught:
            adapter(login_then(answer)).track(awb="A1")
        assert caught.value.transient is transient

    def test_a_timeout_is_transient(self):
        def slow(request):
            raise httpx.ReadTimeout("slow")

        with pytest.raises(ProviderError) as caught:
            adapter(slow).test_connection()
        assert caught.value.transient and caught.value.code == "TIMEOUT"

    def test_rejected_credentials_are_not_transient(self):
        with pytest.raises(ProviderError) as caught:
            adapter(lambda r: httpx.Response(401, json={"message": "bad"})).test_connection()
        assert caught.value.transient is False and caught.value.code == "CREDENTIALS_REJECTED"

    def test_an_expired_token_is_renewed_once(self):
        logins = []

        def handler(request):
            if request.url.path.endswith("/auth/login"):
                logins.append(1)
                return httpx.Response(200, json={"token": f"t{len(logins)}"})
            if request.headers["Authorization"] == "Bearer t1":
                return httpx.Response(401)
            return httpx.Response(200, json={"tracking_data": {"shipment_track_activities": []}})

        adapter(handler).track(awb="A1")
        assert len(logins) == 2

    def test_the_token_is_cached_between_calls(self):
        logins = []

        def handler(request):
            if request.url.path.endswith("/auth/login"):
                logins.append(1)
                return httpx.Response(200, json={"token": "t"})
            return httpx.Response(200, json={"tracking_data": {"shipment_track_activities": []}})

        provider = adapter(handler)
        provider.track(awb="A1")
        provider.track(awb="A1")
        assert len(logins) == 1

    def test_an_echoed_password_is_scrubbed(self):
        answer = httpx.Response(400, json={"message": "login pw-12345678 failed"})
        with pytest.raises(ProviderError) as caught:
            adapter(login_then(answer)).track(awb="A1")
        assert "pw-12345678" not in caught.value.message

    def test_an_awb_failure_carries_the_courier_order_it_made(self):
        def handler(request):
            if request.url.path.endswith("/auth/login"):
                return httpx.Response(200, json={"token": "t"})
            if request.url.path.endswith("/orders/create/adhoc"):
                return httpx.Response(200, json={"order_id": 1, "shipment_id": 2})
            return httpx.Response(200, json={"awb_assign_status": 0, "response": {"data": {
                "awb_assign_error": "Courier not serviceable"}}})

        from app.services.shipping.base import Address, CreateRequest, PackageInfo

        request = CreateRequest(reference="DCZ-SH-1", order_number="DCZ1", order_date=datetime(2026, 10, 1),
                                origin=Address(), destination=Address(name="Asha Rao"),
                                package=PackageInfo(500, 10, 10, 10), lines=[], declared_value=100, cod=False,
                                cod_amount=0)
        with pytest.raises(ProviderError) as caught:
            adapter(handler).create_shipment(request)
        assert caught.value.partial.provider_shipment_id == "2"
        assert caught.value.message == "Courier not serviceable"


class TestWebhookParsing:
    def test_needs_the_exact_token(self):
        provider = adapter(lambda r: httpx.Response(200))
        body = json.dumps({"awb": "A1", "current_status": "DELIVERED"}).encode()
        for headers in ({}, {"x-api-key": ""}, {"x-api-key": "tok-abcdef12"}, {"x-api-key": "TOK-ABCDEF123"}):
            with pytest.raises(WebhookRejected):
                provider.parse_webhook(headers, body)
        event = provider.parse_webhook({"X-Api-Key": "tok-abcdef123"}, body)
        assert event.awb == "A1" and event.status == "delivered"

    def test_no_configured_token_accepts_nothing(self):
        provider = adapter(lambda r: httpx.Response(200), webhookToken="")
        with pytest.raises(WebhookRejected):
            provider.parse_webhook({"x-api-key": ""}, b"{}")

    def test_the_same_body_gives_the_same_key(self):
        provider = adapter(lambda r: httpx.Response(200))
        body = b'{"awb": "A1", "current_status": "IN TRANSIT"}'
        headers = {"x-api-key": "tok-abcdef123"}
        assert provider.parse_webhook(headers, body).event_key == provider.parse_webhook(headers, body).event_key

    def test_malformed_scans_are_skipped_not_fatal(self):
        provider = adapter(lambda r: httpx.Response(200))
        body = json.dumps({"awb": "A1", "current_status": "IN TRANSIT", "scans": ["x", None, {"date": "?"},
                           {"date": "2026-10-06 10:00:00", "activity": "Picked up", "sr-status-label": "PICKED UP"}]})
        event = provider.parse_webhook({"x-api-key": "tok-abcdef123"}, body.encode())
        assert [e.status for e in event.events] == ["picked-up"]
