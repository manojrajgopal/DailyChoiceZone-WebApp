"""
Shared helpers for the shipping tests (no tests of its own).

`FakeShiprocket` answers on an `httpx.MockTransport`: nothing leaves the
machine, but the adapter's real HTTP code, its token handling and the webhook
token check all run. Each route can be told to answer differently (a 5xx, a
timeout, a body that isn't JSON) to drive the failure paths.
"""

from __future__ import annotations

import json
from typing import Callable, Dict, List, Union

import httpx
import pytest

ADDRESS = {
    "fullName": "Asha Rao", "phone": "9876500001", "line1": "4 Brigade Road",
    "line2": "", "city": "Bengaluru", "state": "Karnataka", "pincode": "560001",
    "country": "India", "email": "shopper@example.com",
}
ORIGIN = {"name": "DCZ Warehouse", "phone": "9876500099", "line1": "12 Industrial Area", "line2": "",
          "city": "Bengaluru", "state": "Karnataka", "pincode": "560058"}
PACKAGE = {"weightGrams": 800, "lengthCm": 30, "widthCm": 20, "heightCm": 5, "count": 1, "type": "box"}
WEBHOOK_TOKEN = "whk-test-token-0123456789"
CREDENTIALS = {"email": "api@example.com", "password": "sr-Secret-Pass-42", "webhookToken": WEBHOOK_TOKEN}

Answer = Union[httpx.Response, Callable[[httpx.Request], httpx.Response], Exception]


class FakeShiprocket:
    """The Shiprocket API, as far as the adapter uses it."""

    def __init__(self):
        self.calls: List[httpx.Request] = []
        self.answers: Dict[str, List[Answer]] = {}
        self.awb = "SR123456789"
        self.tracking: dict = {"tracking_data": {"shipment_track": [{"current_status": "AWB ASSIGNED"}],
                                                "shipment_track_activities": []}}

    # ------------------------------------------------------------- control

    def answer(self, key: str, *answers: Answer) -> None:
        """Queue answers for `METHOD /path` (the first is used first; the last repeats)."""
        self.answers[key] = list(answers)

    def paths(self) -> List[str]:
        return [f"{r.method} {r.url.path.split('/v1/external', 1)[-1]}" for r in self.calls]

    def count(self, key: str) -> int:
        return self.paths().count(key)

    # ------------------------------------------------------------ handling

    def _default(self, key: str, request: httpx.Request) -> httpx.Response:
        if key == "POST /auth/login":
            body = json.loads(request.content or b"{}")
            if body.get("email") == CREDENTIALS["email"] and body.get("password") == CREDENTIALS["password"]:
                return httpx.Response(200, json={"token": "tok-abc"})
            return httpx.Response(401, json={"message": "Invalid email and password combination"})
        if request.headers.get("Authorization") != "Bearer tok-abc":
            return httpx.Response(401, json={"message": "Unauthenticated"})
        if key == "POST /orders/create/adhoc":
            return httpx.Response(200, json={"order_id": 5551, "shipment_id": 9871, "status": "NEW"})
        if key == "POST /courier/assign/awb":
            return httpx.Response(200, json={"awb_assign_status": 1, "response": {"data": {
                "awb_code": self.awb, "courier_name": "Delhivery Surface", "courier_company_id": 12}}})
        if key == "POST /courier/generate/label":
            return httpx.Response(200, json={"label_created": 1, "label_url": "https://labels.example.com/l.pdf"})
        if key == "POST /courier/generate/pickup":
            return httpx.Response(200, json={"pickup_status": 1, "response": {
                "pickup_scheduled_date": "2026-10-08 10:00:00", "pickup_token_number": "PK-77"}})
        if key == "POST /orders/cancel":
            return httpx.Response(200, json={"message": "Order cancelled"})
        if key.startswith("GET /courier/track/awb/"):
            return httpx.Response(200, json=self.tracking)
        if key == "GET /courier/serviceability/":
            return httpx.Response(200, json={"status": 200, "data": {"available_courier_companies": [
                {"courier_company_id": 12, "courier_name": "Delhivery Surface", "rate": 85.5, "etd": "Oct 09, 2026",
                 "estimated_delivery_days": "4", "cod": 1},
                {"courier_company_id": 7, "courier_name": "Bluedart Air", "rate": 140, "etd": "Oct 07, 2026",
                 "estimated_delivery_days": "2", "cod": 0},
            ]}})
        if key == "GET /orders":
            return httpx.Response(200, json={"data": []})
        return httpx.Response(404, json={"message": f"no fake for {key}"})

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        path = request.url.path.split("/v1/external", 1)[-1]
        key = f"{request.method} {path}"
        lookup = "GET /courier/track/awb/" if key.startswith("GET /courier/track/awb/") else key
        queued = self.answers.get(lookup)
        if queued:
            answer = queued.pop(0) if len(queued) > 1 else queued[0]
            if isinstance(answer, Exception):
                raise answer
            if callable(answer):
                return answer(request)
            return answer
        return self._default(key, request)


@pytest.fixture()
def shiprocket(monkeypatch):
    from app.services.shipping import estimate, shiprocket as module

    fake = FakeShiprocket()
    monkeypatch.setattr(module, "TRANSPORT", httpx.MockTransport(fake))
    module.reset_tokens()
    estimate.reset_cache()
    yield fake
    module.reset_tokens()
    estimate.reset_cache()


def configure(client, headers, code: str, **payload):
    return client.put(f"/api/admin/shipping/providers/{code}", headers=headers, json=payload)


@pytest.fixture()
def manual_on(client, admin_auth):
    response = configure(client, admin_auth, "manual", active=True, isDefault=True,
                         settings={"services": ["Surface", "Express"], "defaultService": "Surface", "origin": ORIGIN})
    assert response.status_code == 200, response.text
    return response.json()["data"]


@pytest.fixture()
def shiprocket_on(client, admin_auth, shiprocket):
    response = configure(client, admin_auth, "shiprocket", active=True, isDefault=True, credentials=CREDENTIALS,
                         settings={"services": ["Surface"], "defaultService": "Surface",
                                   "pickupLocation": "Primary", "origin": ORIGIN})
    assert response.status_code == 200, response.text
    return response.json()["data"]


def place_order(client, auth, *, payment_method: str = "cod", product_id: str = "PRD001", quantity: int = 1) -> dict:
    added = client.post("/api/cart/items", headers=auth, json={"productId": product_id, "quantity": quantity})
    assert added.status_code in (200, 201), added.text
    placed = client.post("/api/orders", headers=auth, json={
        "shippingAddress": ADDRESS, "billingAddress": None, "deliveryMethod": "standard",
        "paymentMethod": payment_method, "couponCode": None, "email": "shopper@example.com", "saveAddress": False,
    })
    assert placed.status_code == 201, placed.text
    data = placed.json()["data"]
    return data.get("order", data)


@pytest.fixture()
def order(client, auth, catalogue, settings_documents) -> dict:
    """A confirmed cash-on-delivery order: shippable."""
    return place_order(client, auth)


def create(client, headers, order_id: str, provider: str = "manual", key: str = "key-00000001", **overrides):
    body = {"orderId": order_id, "providerCode": provider, "service": "Surface", "package": dict(PACKAGE),
            "idempotencyKey": key}
    if provider == "manual":
        body.update({"courierName": "Local Express", "awb": "LX-100200"})
    body.update(overrides)
    return client.post("/api/admin/shipments", headers=headers, json=body)


def created(client, headers, order_id: str, provider: str = "manual", **overrides) -> dict:
    response = create(client, headers, order_id, provider, **overrides)
    assert response.status_code == 201, response.text
    return response.json()["data"]


def event(client, headers, shipment_id: int, status: str, **overrides):
    body = {"status": status, "description": "", "location": "Bengaluru Hub"}
    body.update(overrides)
    return client.post(f"/api/admin/shipments/{shipment_id}/events", headers=headers, json=body)


def webhook(client, payload, token: str = WEBHOOK_TOKEN, code: str = "shiprocket"):
    raw = payload if isinstance(payload, (bytes, str)) else json.dumps(payload)
    headers = {"Content-Type": "application/json"}
    if token is not None:
        headers["x-api-key"] = token
    return client.post(f"/api/shipping/webhooks/{code}", content=raw, headers=headers)
