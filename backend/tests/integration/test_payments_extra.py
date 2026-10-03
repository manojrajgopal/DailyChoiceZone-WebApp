"""
The payment gateway, beyond the happy paths the main suites cover.

Three layers, each tested where it lives:

- **The Razorpay transport.** `_request` and `methods` are exercised against an
  `httpx.MockTransport`, so timeouts, 5xx answers and bodies that are not JSON
  are real HTTP behaviour rather than a stubbed function. Nothing reaches the
  network.
- **Settlement.** Every webhook event shape, the QR and payment link rails,
  late and duplicate money, refunds that fail at the gateway, and a declined
  attempt that must not cancel the order. Signatures are real HMACs.
- **The routes.** `/methods`, `/session`, the QR image, the link callback and
  the webhook's own refusals.

The gateway fixtures are the existing suites' own (`gateway` from
`test_payment_security`, which answers unstubbed paths with `{}`), imported
rather than re-implemented.
"""

from __future__ import annotations

import base64
import io
import json
import types
from datetime import datetime, timedelta

import httpx
import pytest

import app.main  # noqa: F401 -- import the app before any fixture patches `get_provider`
from app.core import rate_limit
from app.models import Invoice, Order, Payment, Product, WebhookEvent
from app.services import settlement
from app.services.payments import PaymentResult
from app.services.payments.razorpay import RazorpayError
from tests.integration.test_payment_security import (  # noqa: F401 -- `gateway` is a fixture
    KEY_ID,
    KEY_SECRET,
    WEBHOOK_SECRET,
    captured,
    gateway,
    lapse,
    refunds_sent,
    sign,
    verify,
    webhook,
)
from tests.integration.test_payment_security import place as place_order

pytestmark = pytest.mark.integration

DOT = "•"


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


def placed_order(client, auth, **overrides) -> dict:
    response = place_order(client, auth, **overrides)
    assert response.status_code == 201, response.text
    return response.json()["data"]


def fresh(db, model, key):
    row = db.get(model, key)
    db.refresh(row)
    return row


def raw_webhook(client, raw: bytes, *, signature=None, event_id="evt_raw"):
    headers = {"Content-Type": "application/json", "X-Razorpay-Event-Id": event_id}
    if signature is not None:
        headers["X-Razorpay-Signature"] = signature
    return client.post("/api/payments/webhook/razorpay", content=raw, headers=headers)


def raising(message="The payment provider could not be reached.", status=None):
    def answer():
        raise RazorpayError(message, status=status)

    return answer


# ===================================================== the Razorpay transport


@pytest.fixture()
def live_provider(monkeypatch):
    """
    The real provider with its real `_request`, over a mock HTTP transport.

    `install(handler)` decides what every request is answered with. The
    `httpx` the provider module sees is replaced by a namespace whose `Client`
    is bound to the mock transport, so the rest of the process -- the test
    client included -- keeps the genuine library.
    """
    from app.core.config import settings
    from app.services.payments import razorpay as module

    monkeypatch.setattr(settings, "RAZOR_KEY_ID", KEY_ID)
    monkeypatch.setattr(settings, "RAZOR_KEY_SECRET", KEY_SECRET)
    monkeypatch.setattr(settings, "RAZOR_WEBHOOK_SECRET", WEBHOOK_SECRET)

    provider = module.RazorpayPaymentProvider()
    provider.seen = []
    real_client = httpx.Client

    def install(handler):
        def recording(request):
            provider.seen.append(request)
            return handler(request)

        def factory(*args, **kwargs):
            return real_client(transport=httpx.MockTransport(recording), timeout=5.0)

        monkeypatch.setattr(module, "httpx", types.SimpleNamespace(Client=factory, HTTPError=httpx.HTTPError))

    provider.install = install
    return provider


class TestTheTransport:
    def test_a_call_is_authenticated_with_the_key_pair(self, live_provider):
        from app.services.payments.base import PaymentRequest

        live_provider.install(lambda request: httpx.Response(200, json={"id": "order_tx01"}))

        result = live_provider.create(PaymentRequest(
            order_id="ORD9", invoice_id="INV9", customer_id="CUS001", customer_name="Asha Rao",
            customer_email="shopper@example.com", amount=4999, currency="INR", method="card",
        ))

        assert result.provider_reference == "order_tx01" and result.status == "pending"
        request = live_provider.seen[0]
        assert request.url.path == "/v1/orders" and request.method == "POST"
        expected = base64.b64encode(f"{KEY_ID}:{KEY_SECRET}".encode()).decode()
        assert request.headers["authorization"] == f"Basic {expected}"
        body = json.loads(request.content)
        assert body["amount"] == 4999 and body["payment_capture"] == 1
        # Without an order number the receipt falls back to our own id.
        assert body["receipt"] == "ORD9"

    def test_a_5xx_carries_the_gateways_own_reason(self, live_provider):
        live_provider.install(lambda request: httpx.Response(
            502, json={"error": {"code": "SERVER_ERROR", "description": "Upstream bank is down."}}))

        with pytest.raises(RazorpayError) as raised:
            live_provider.payment_entity("pay_x")

        assert str(raised.value) == "Upstream bank is down."
        assert raised.value.status == 502

    def test_an_error_page_that_is_not_json_still_raises_cleanly(self, live_provider):
        live_provider.install(lambda request: httpx.Response(503, text="<html>Service Unavailable</html>"))

        with pytest.raises(RazorpayError) as raised:
            live_provider.payment_entity("pay_x")

        assert str(raised.value) == "The payment provider refused the request."
        assert raised.value.status == 503

    def test_a_timeout_is_an_unreachable_gateway(self, live_provider):
        def timeout(request):
            raise httpx.ReadTimeout("timed out", request=request)

        live_provider.install(timeout)

        with pytest.raises(RazorpayError) as raised:
            live_provider.order_payment_entities("order_x")
        assert raised.value.status is None
        assert "could not be reached" in str(raised.value)

    def test_a_timeout_on_read_back_is_not_a_payment(self, live_provider):
        """`fetch` turns an outage into None, which `verify` reports as a failure."""
        def timeout(request):
            raise httpx.ConnectTimeout("timed out", request=request)

        live_provider.install(timeout)

        result = live_provider.verify("order_abc", {
            "razorpay_order_id": "order_abc", "razorpay_payment_id": "pay_abc",
            "razorpay_signature": sign("order_abc|pay_abc"),
        })

        assert not result.ok and result.status == "failed"
        assert "read back" in result.failure_reason

    # Regression: was a real bug, fixed alongside this test.
    def test_a_2xx_that_is_not_json_is_treated_as_unreadable(self, live_provider):
        live_provider.install(lambda request: httpx.Response(200, text="<html>OK</html>"))

        assert live_provider.fetch("pay_garbled") is None

    def test_a_refund_the_gateway_refuses_is_rejected_with_its_reason(self, live_provider):
        live_provider.install(lambda request: httpx.Response(
            400, json={"error": {"description": "The refund amount exceeds the payment."}}))

        result = live_provider.refund("pay_r1", 10_000, "Customer returned it")

        assert not result.ok and result.status == "rejected"
        assert result.failure_reason == "The refund amount exceeds the payment."

    def test_a_cash_order_has_nothing_to_refund(self, live_provider):
        live_provider.install(lambda request: httpx.Response(500))
        result = live_provider.refund("COD-ORD1", 100, "x")
        assert not result.ok and live_provider.seen == []

    def test_an_unknown_refund_status_is_processing(self, live_provider):
        live_provider.install(lambda request: httpx.Response(200, json={"id": "rfnd_q", "status": "queued"}))
        result = live_provider.refund("pay_q", 100, "x" * 400)
        assert result.ok and result.status == "processing"
        # The reason is clipped to what Razorpay accepts.
        assert len(json.loads(live_provider.seen[0].content)["notes"]["reason"]) == 255


class TestReadingTheGateway:
    def test_an_order_with_no_payments_is_still_pending(self, live_provider):
        live_provider.install(lambda request: httpx.Response(200, json={"items": []}))
        result = live_provider.fetch("order_empty")
        assert result.ok and result.status == "pending" and result.transaction_id == "order_empty"

    def test_an_order_reports_its_captured_payment_over_later_attempts(self, live_provider):
        live_provider.install(lambda request: httpx.Response(200, json={"items": [
            {"id": "pay_a", "status": "failed", "amount": 500, "method": "card"},
            {"id": "pay_b", "status": "captured", "amount": 500, "method": "netbanking", "bank": "HDFC",
             "currency": "INR", "order_id": "order_two"},
            {"id": "pay_c", "status": "failed", "amount": 500, "method": "card"},
        ]}))

        result = live_provider.fetch("order_two")

        assert result.transaction_id == "pay_b" and result.status == "paid"
        assert result.instrument_hint == "HDFC" and result.currency == "INR"
        assert live_provider.seen[0].url.path == "/v1/orders/order_two/payments"

    def test_without_a_capture_the_latest_attempt_is_reported(self, live_provider):
        live_provider.install(lambda request: httpx.Response(200, json={"items": [
            {"id": "pay_a", "status": "failed", "amount": 500, "method": "card"},
            {"id": "pay_z", "status": "authorized", "amount": 500, "method": "card"},
        ]}))
        result = live_provider.fetch("order_auth")
        assert result.transaction_id == "pay_z" and result.status == "authorized" and result.ok

    def test_an_unreadable_payment_is_none(self, live_provider):
        live_provider.install(lambda request: httpx.Response(404, json={"error": {"description": "No such id"}}))
        assert live_provider.fetch("pay_missing") is None

    def test_listing_pages_through_the_gateway(self, live_provider):
        def pages(request):
            skip = int(request.url.params["skip"])
            size = 100 if skip < 200 else 7
            return httpx.Response(200, json={"items": [{"id": f"pay_{skip + i}"} for i in range(size)]})

        live_provider.install(pages)

        items = live_provider.payments_between(1_700_000_000, 1_700_086_400)

        assert len(items) == 207
        assert [int(r.url.params["skip"]) for r in live_provider.seen] == [0, 100, 200]
        assert live_provider.seen[0].url.params["from"] == "1700000000"

    def test_listing_stops_at_the_limit(self, live_provider):
        live_provider.install(lambda request: httpx.Response(
            200, json={"items": [{"id": f"pay_{i}"} for i in range(100)]}))
        assert len(live_provider.payments_between(0, 1, limit=150)) == 150
        assert len(live_provider.seen) == 2

    def test_qr_payments_swallow_an_outage(self, live_provider):
        live_provider.install(lambda request: httpx.Response(500, json={}))
        assert live_provider.qr_payments("qr_down") == []

    def test_closing_a_code_or_a_link_never_fails(self, live_provider):
        live_provider.install(lambda request: httpx.Response(
            400, json={"error": {"description": "Already closed."}}))

        live_provider.close_qr("qr_done")
        live_provider.cancel_payment_link("plink_done")

        assert [r.url.path for r in live_provider.seen] == [
            "/v1/payments/qr_codes/qr_done/close", "/v1/payment_links/plink_done/cancel"]

    def test_the_poster_url_is_read_from_the_code(self, live_provider):
        live_provider.install(lambda request: httpx.Response(200, json={"id": "qr_1", "image_url": "https://rzp.io/q"}))
        assert live_provider.qr_poster_url("qr_1") == "https://rzp.io/q"

    def test_a_qr_code_is_minted_single_use_with_a_deadline(self, live_provider):
        live_provider.install(lambda request: httpx.Response(200, json={
            "id": "qr_new", "image_url": "https://rzp.io/x", "payment_amount": 2500, "close_by": 1}))
        deadline = datetime(2030, 1, 1, 12, 0, 0)

        code = live_provider.create_qr(amount=2500, name="", description="d" * 300, notes={"paymentId": "PAY1"},
                                       close_by=deadline)

        sent = json.loads(live_provider.seen[0].content)
        assert sent["name"] == "Payment" and len(sent["description"]) == 120
        assert sent["close_by"] == 1893499200
        assert code == {"id": "qr_new", "imageUrl": "https://rzp.io/x", "amount": 2500, "status": "active",
                        "closeBy": 1}

    def test_a_payment_link_without_a_phone_sends_no_sms(self, live_provider):
        live_provider.install(lambda request: httpx.Response(200, json={"id": "plink_1", "short_url": "https://rzp.io/l"}))

        link = live_provider.create_payment_link(
            amount=1000, currency="INR", reference_id="PAY" + "9" * 50, description="Order X",
            customer={"name": "Asha", "email": "shopper@example.com", "contact": ""},
            expire_by=datetime(2030, 1, 1), callback_url="https://shop.example.com/back")

        sent = json.loads(live_provider.seen[0].content)
        assert sent["notify"] == {"sms": False, "email": True}
        assert len(sent["reference_id"]) == 40 and "contact" not in sent["customer"]
        assert link["status"] == "created" and link["shortUrl"] == "https://rzp.io/l"

    def test_a_link_signature_needs_every_field(self, live_provider):
        assert not live_provider.verify_payment_link_signature({
            "razorpay_payment_link_id": "plink_1", "razorpay_payment_link_reference_id": "PAY1",
            "razorpay_payment_link_status": "paid", "razorpay_payment_id": "",
            "razorpay_signature": "x"})
        fields = ("plink_1", "PAY1", "paid", "pay_1")
        assert live_provider.verify_payment_link_signature({
            "razorpay_payment_link_id": fields[0], "razorpay_payment_link_reference_id": fields[1],
            "razorpay_payment_link_status": fields[2], "razorpay_payment_id": fields[3],
            "razorpay_signature": sign("|".join(fields))})


class TestTheMethodsList:
    def test_banks_and_wallets_are_named(self, live_provider):
        live_provider.install(lambda request: httpx.Response(200, json={"methods": {
            "card": True, "upi": True, "upi_intent": False, "emi": True,
            "netbanking": {"HDFC": "HDFC Bank", "XYZB": ""},
            "wallet": {"mobikwik": True, "some_new_wallet": True},
        }}))

        methods = live_provider.methods()

        assert live_provider.seen[0].url.params["key_id"] == KEY_ID
        assert methods["netbanking"] == [{"code": "HDFC", "name": "HDFC Bank"}, {"code": "XYZB", "name": "Xyzb"}]
        assert methods["wallet"] == [{"code": "mobikwik", "name": "MobiKwik"},
                                     {"code": "some_new_wallet", "name": "Some New Wallet"}]
        assert methods["upiQr"] is True and methods["upiIntent"] is False and methods["emi"] is True

    def test_a_flat_answer_and_a_list_of_banks(self, live_provider):
        """Not every account answers under `methods`; a list is not a map of names."""
        live_provider.install(lambda request: httpx.Response(200, json={"card": False, "netbanking": ["HDFC"]}))
        methods = live_provider.methods()
        assert methods["card"] is False and methods["netbanking"] == []

    @pytest.mark.parametrize("answer", [
        lambda request: httpx.Response(500, json={}),
        lambda request: httpx.Response(200, text="not json"),
    ])
    def test_an_unreadable_answer_is_empty_not_a_guess(self, live_provider, answer):
        live_provider.install(answer)
        assert live_provider.methods() == {}


class TestInstrumentHints:
    @pytest.mark.parametrize("payment,expected", [
        ({"method": "emi"}, "EMI"),
        ({"method": "card", "card": {"network": "RuPay"}}, "RuPay"),
        ({"method": "upi", "vpa": ""}, "UPI"),
        ({"method": "netbanking"}, "Net banking"),
        ({"method": "wallet"}, "Wallet"),
        ({"method": "bank_transfer"}, "Bank Transfer"),
        ({}, ""),
    ])
    def test_the_fallbacks(self, payment, expected):
        from app.services.payments.razorpay import instrument_hint

        assert instrument_hint(payment) == expected

    def test_the_mock_provider_hints_each_method(self, monkeypatch):
        from app.services.payments.base import PaymentRequest
        from app.services.payments.mock import MockPaymentProvider

        mock = MockPaymentProvider()
        hints = {}
        for method in ("card", "upi", "netbanking", "wallet", "cod", "other"):
            hints[method] = mock.create(PaymentRequest(
                order_id="ORD1", invoice_id="INV1", customer_id="C", customer_name="A", customer_email="a@example.com",
                amount=100, currency="INR", method=method)).instrument_hint
        assert hints["card"].startswith(DOT * 4) and "@" in hints["upi"]
        assert "Bank" in hints["netbanking"] and hints["cod"] == "Collect on delivery" and hints["other"] == ""
        assert mock.fetch("TXN1").status == "paid" and mock.verify("TXN1", {}).ok
        assert mock.refund("TXN0001", 100, "x").reference == "RFND0001"

    def test_an_unknown_provider_refuses_to_start(self, monkeypatch):
        from app.core.config import settings
        from app.services import payments

        monkeypatch.setattr(settings, "PAYMENT_PROVIDER", "stripe")
        payments.get_provider.cache_clear()
        with pytest.raises(RuntimeError, match="stripe"):
            payments.get_provider()
        payments.get_provider.cache_clear()


# ======================================================= the public routes


class TestTheMethodsRoute:
    def test_net_banking_and_wallets_when_both_sides_allow_them(self, client, gateway, settings_documents, db,
                                                                monkeypatch):
        from app.models import SettingDocument

        document = db.get(SettingDocument, "billing")
        document.value = {**document.value, "payment": {"enabledMethods": ["netbanking", "wallet", "debit-card"]}}
        db.flush()
        monkeypatch.setattr(gateway, "methods", lambda: {
            "card": True, "netbanking": [{"code": "HDFC", "name": "HDFC Bank"}],
            "wallet": [{"code": "paytm", "name": "Paytm"}], "upi": True, "upiIntent": False, "upiQr": True,
        })

        body = client.get("/api/payments/methods").json()["data"]

        assert body["methods"] == ["card", "netbanking", "wallet"]
        # The store offers no UPI, so neither UPI nor scan-to-pay appears.
        assert body["qrCodes"] is False and body["upiQr"] is True


class TestTheWebhookRefuses:
    def test_when_razorpay_is_not_the_provider(self, client):
        response = raw_webhook(client, b"{}", signature="x")
        assert response.status_code == 422
        assert response.json()["error_code"] == "PROVIDER_INACTIVE"

    def test_a_body_too_large_to_be_a_webhook(self, client, gateway):
        raw = b'{"event":"' + b"x" * (256 * 1024) + b'"}'
        response = raw_webhook(client, raw, signature=sign(raw.decode(), WEBHOOK_SECRET))
        assert response.status_code == 422
        assert response.json()["error_code"] == "WEBHOOK_TOO_LARGE"

    def test_a_missing_signature(self, client, gateway, db):
        response = raw_webhook(client, b'{"event":"payment.captured"}')
        assert response.status_code == 422
        assert response.json()["error_code"] == "WEBHOOK_UNVERIFIED"
        assert db.query(WebhookEvent).count() == 0

    def test_a_signature_over_different_bytes(self, client, gateway):
        response = raw_webhook(client, b'{"event":"payment.captured"}',
                               signature=sign('{"event": "payment.captured"}', WEBHOOK_SECRET))
        assert response.json()["error_code"] == "WEBHOOK_UNVERIFIED"

    @pytest.mark.parametrize("raw", [b"not json at all", b'["payment.captured"]'])
    def test_a_signed_body_that_is_not_a_json_object(self, client, gateway, db, raw):
        response = raw_webhook(client, raw, signature=sign(raw.decode(), WEBHOOK_SECRET))
        assert response.status_code == 422
        assert response.json()["error_code"] == "WEBHOOK_MALFORMED"
        assert db.query(WebhookEvent).count() == 0


# ============================================================== settlement


@pytest.fixture()
def pending(client, auth, gateway, catalogue, settings_documents):
    """A prepaid order waiting on the gateway."""
    return placed_order(client, auth)


class TestTheBrowserReturns:
    def test_a_declined_payment_fails_the_attempt_not_the_order(self, client, auth, db, gateway, pending):
        ref = pending["gateway"]["orderReference"]
        gateway.responses["/payments/pay_dec01"] = {
            "id": "pay_dec01", "status": "failed", "order_id": ref, "amount": pending["amount"],
            "method": "card", "error_description": "Card declined by the bank."}

        response = verify(client, auth, pending, "pay_dec01")

        assert response.status_code == 422
        assert response.json()["error_code"] == "PAYMENT_UNVERIFIED"
        assert response.json()["message"] == "Card declined by the bank."
        payment = fresh(db, Payment, pending["paymentId"])
        assert payment.status == "failed"
        assert any(e.status == "failed" and "declined" in e.note for e in payment.events)
        order = fresh(db, Order, pending["order"]["id"])
        assert (order.status, order.payment_status, order.stock_state) == ("pending", "failed", "reserved")
        assert fresh(db, Invoice, pending["invoiceId"]).payment_status == "failed"

    def test_a_retry_after_a_decline_can_still_pay(self, client, auth, db, gateway, pending):
        ref = pending["gateway"]["orderReference"]
        gateway.responses["/payments/pay_dec02"] = {
            "id": "pay_dec02", "status": "failed", "order_id": ref, "amount": pending["amount"], "method": "card"}
        assert verify(client, auth, pending, "pay_dec02").status_code == 422
        gateway.responses["/payments/pay_ok02"] = captured(ref, "pay_ok02", pending["amount"])

        response = verify(client, auth, pending, "pay_ok02")

        assert response.status_code == 200, response.text
        assert response.json()["message"] == "Payment confirmed."
        assert fresh(db, Order, pending["order"]["id"]).status == "confirmed"

    def test_a_forged_signature_records_a_failed_attempt(self, client, auth, db, gateway, pending):
        ref = pending["gateway"]["orderReference"]
        response = client.post(f"/api/payments/{pending['paymentId']}/verify", headers=auth, json={
            "razorpayOrderId": ref, "razorpayPaymentId": "pay_forged",
            "razorpaySignature": sign(f"{ref}|pay_forged", "not_the_secret")})

        assert response.status_code == 422
        assert fresh(db, Payment, pending["paymentId"]).status == "failed"
        # Nothing was asked of the gateway about a payment nobody proved.
        assert not [c for c in gateway.calls if c["path"].startswith("/payments/pay_")]

    def test_a_payment_still_processing_is_recorded_not_confirmed(self, client, auth, db, gateway, pending):
        ref = pending["gateway"]["orderReference"]
        gateway.responses["/payments/pay_slow01"] = {
            "id": "pay_slow01", "status": "created", "order_id": ref, "amount": pending["amount"], "method": "upi"}

        response = verify(client, auth, pending, "pay_slow01")

        assert response.status_code == 200
        assert response.json()["message"] == "Payment recorded."
        payment = fresh(db, Payment, pending["paymentId"])
        assert payment.status == "pending"
        # The gateway's payment id is adopted; the order id moves aside.
        assert payment.transaction_id == "pay_slow01" and payment.provider_reference == ref

    def test_verifying_a_settled_payment_is_a_no_op(self, client, auth, db, gateway, pending):
        ref = pending["gateway"]["orderReference"]
        gateway.responses["/payments/pay_once01"] = captured(ref, "pay_once01", pending["amount"])
        verify(client, auth, pending, "pay_once01")
        calls = len(gateway.calls)

        again = verify(client, auth, pending, "pay_once01")

        assert again.status_code == 200 and again.json()["data"]["status"] == "paid"
        assert len(gateway.calls) == calls

    def test_an_overpayment_is_refused_too(self, client, auth, db, gateway, pending):
        ref = pending["gateway"]["orderReference"]
        gateway.responses["/payments/pay_over01"] = captured(ref, "pay_over01", pending["amount"] + 1)

        response = verify(client, auth, pending, "pay_over01")

        assert response.status_code == 409
        assert response.json()["error_code"] == "PAYMENT_AMOUNT_MISMATCH"
        assert fresh(db, Invoice, pending["invoiceId"]).amount_paid == 0


class TestTheSession:
    def test_returning_after_the_hold_lapsed_expires_the_order(self, client, auth, db, gateway, pending):
        lapse(db, pending["order"]["id"])

        session = client.get(f"/api/payments/{pending['paymentId']}/session", headers=auth).json()["data"]

        assert session["status"] == "expired" and session["gateway"] is None
        assert session["orderNumber"] == pending["order"]["orderNumber"]
        order = fresh(db, Order, pending["order"]["id"])
        assert (order.status, order.stock_state) == ("cancelled", "released")
        assert fresh(db, Product, "PRD001").reserved_stock == 0

    def test_without_a_gateway_there_is_no_handoff(self, client, auth, gateway, pending, monkeypatch):
        from app.core.config import settings

        monkeypatch.setattr(settings, "PAYMENT_PROVIDER", "mock")
        session = client.get(f"/api/payments/{pending['paymentId']}/session", headers=auth).json()["data"]
        assert session["status"] == "pending" and session["gateway"] is None


class TestWebhookEvents:
    def test_an_authorisation_holds_and_a_capture_settles(self, client, auth, db, gateway, pending):
        ref = pending["gateway"]["orderReference"]
        held = {**captured(ref, "pay_auth01", pending["amount"]), "status": "authorized"}

        first = webhook(client, {"event": "payment.authorized", "payload": {"payment": {"entity": held}}},
                        event_id="evt_auth_1")

        assert first.status_code == 200 and first.json()["data"]["handled"] is True
        payment = fresh(db, Payment, pending["paymentId"])
        assert payment.status == "authorized" and payment.captured_at is None
        order = fresh(db, Order, pending["order"]["id"])
        assert order.status == "pending" and order.stock_state == "reserved"
        assert fresh(db, Invoice, pending["invoiceId"]).amount_paid == 0
        # An authorisation is money held; the sweeper must not cancel it.
        assert settlement.expire_payment(db, payment) is False

        webhook(client, {"event": "payment.captured",
                         "payload": {"payment": {"entity": captured(ref, "pay_auth01", pending["amount"])}}},
                event_id="evt_auth_2")

        payment = fresh(db, Payment, pending["paymentId"])
        assert payment.status == "paid" and payment.captured_at is not None
        assert fresh(db, Order, pending["order"]["id"]).status == "confirmed"

    def test_a_late_failure_cannot_undo_a_capture(self, client, auth, db, gateway, pending):
        ref = pending["gateway"]["orderReference"]
        webhook(client, {"event": "payment.captured",
                         "payload": {"payment": {"entity": captured(ref, "pay_ooo01", pending["amount"])}}},
                event_id="evt_ooo_1")
        failed = {**captured(ref, "pay_ooo00", pending["amount"]), "status": "failed"}

        response = webhook(client, {"event": "payment.failed", "payload": {"payment": {"entity": failed}}},
                           event_id="evt_ooo_2")

        assert response.status_code == 200
        assert fresh(db, Payment, pending["paymentId"]).status == "paid"
        assert fresh(db, Order, pending["order"]["id"]).payment_status == "paid"

    def test_a_status_that_is_not_money_is_ignored(self, client, db, gateway, pending):
        ref = pending["gateway"]["orderReference"]
        entity = {**captured(ref, "pay_cr01", pending["amount"]), "status": "created"}

        response = webhook(client, {"event": "order.paid", "payload": {"payment": {"entity": entity}}},
                           event_id="evt_created")

        assert response.json()["data"]["handled"] is False
        row = db.get(WebhookEvent, "evt_created")
        assert row.status == "ignored" and row.result == "ignored: payment created"
        assert fresh(db, Payment, pending["paymentId"]).status == "pending"

    @pytest.mark.parametrize("body,result", [
        ({"event": "payment.captured", "payload": {}}, "ignored: no payment entity"),
        ({"event": "refund.processed", "payload": {"refund": {"entity": {}}}}, "ignored: refund with no id"),
        ({"event": "refund.failed", "payload": {"refund": {"entity": {"id": "rfnd_nobody"}}}},
         "ignored: unknown refund"),
        ({"event": "payment.captured", "payload": {"payment": {"entity": {
            "id": "pay_stranger", "order_id": "order_not_ours", "status": "captured", "amount": 100}}}},
         "ignored: not ours"),
    ])
    def test_what_is_acknowledged_and_left_alone(self, client, db, gateway, body, result):
        response = webhook(client, body, event_id="evt_ignored")
        assert response.status_code == 200 and response.json()["data"]["handled"] is False
        assert db.get(WebhookEvent, "evt_ignored").result == result

    def test_a_payment_known_only_by_its_own_id(self, client, db, gateway, pending):
        """A redelivery with no order id and no notes is matched on the payment id itself."""
        ref = pending["gateway"]["orderReference"]
        webhook(client, {"event": "payment.captured",
                         "payload": {"payment": {"entity": captured(ref, "pay_self01", pending["amount"])}}},
                event_id="evt_self_1")
        bare = captured(None, "pay_self01", pending["amount"])
        bare.pop("order_id")

        response = webhook(client, {"event": "payment.captured", "payload": {"payment": {"entity": bare}}},
                           event_id="evt_self_2")

        assert response.json()["data"]["handled"] is True
        assert db.get(WebhookEvent, "evt_self_2").result.endswith("paid")
        assert refunds_sent(gateway) == []

    def test_an_amount_mismatch_fails_the_event_so_it_can_be_replayed(self, client, db, admin_auth, gateway, pending):
        ref = pending["gateway"]["orderReference"]
        body = {"event": "payment.captured",
                "payload": {"payment": {"entity": captured(ref, "pay_short9", pending["amount"] - 100)}}}

        response = webhook(client, body, event_id="evt_short")

        assert response.status_code == 409
        assert response.json()["error_code"] == "PAYMENT_AMOUNT_MISMATCH"
        row = fresh(db, WebhookEvent, "evt_short")
        assert row.status == "failed" and "amount" in row.error.lower()
        assert fresh(db, Payment, pending["paymentId"]).status == "pending"

        replay = client.post("/api/admin/payments/webhooks/evt_short/replay", headers=admin_auth)
        assert replay.status_code == 409
        assert fresh(db, Invoice, pending["invoiceId"]).amount_paid == 0

    def test_a_crash_is_replayable_and_then_applies_once(self, client, db, admin_auth, gateway, pending, monkeypatch):
        ref = pending["gateway"]["orderReference"]
        body = {"event": "payment.captured",
                "payload": {"payment": {"entity": captured(ref, "pay_crash1", pending["amount"])}}}
        real = settlement.settle_from_webhook

        def broken(db, body):
            raise RuntimeError("database went away")

        monkeypatch.setattr(settlement, "settle_from_webhook", broken)
        assert webhook(client, body, event_id="evt_crash").status_code == 500

        again = client.post("/api/admin/payments/webhooks/evt_crash/replay", headers=admin_auth)
        assert again.status_code == 200
        assert again.json()["message"] == "Replayed — processing failed again."
        assert again.json()["data"]["outcome"]["failed"] is True

        monkeypatch.setattr(settlement, "settle_from_webhook", real)
        fixed = client.post("/api/admin/payments/webhooks/evt_crash/replay", headers=admin_auth)
        assert fixed.status_code == 200 and fixed.json()["message"] == "Replayed and processed."
        assert fixed.json()["data"]["event"]["status"] == "processed"
        invoice = fresh(db, Invoice, pending["invoiceId"])
        assert invoice.amount_paid == invoice.grand_total

        detail = client.get("/api/admin/payments/webhooks/evt_crash", headers=admin_auth)
        assert detail.status_code == 200
        listing = client.get("/api/admin/payments/webhooks", headers=admin_auth, params={"days": 1})
        assert listing.status_code == 200 and listing.json()["data"]["pagination"]["total"] >= 1
        metrics = client.get("/api/admin/payments/webhooks/metrics", headers=admin_auth)
        assert metrics.status_code == 200


class TestLateAndStrayMoney:
    def test_a_capture_for_a_cancelled_order_goes_back(self, client, auth, db, gateway, pending):
        """The shopper abandons the payment sheet and cancels; the bank completes anyway."""
        ref = pending["gateway"]["orderReference"]
        cancelled = client.post(f"/api/orders/{pending['order']['id']}/cancel", headers=auth,
                                json={"reason": "Changed my mind"})
        assert cancelled.status_code == 200, cancelled.text

        webhook(client, {"event": "payment.captured",
                         "payload": {"payment": {"entity": captured(ref, "pay_after9", pending["amount"])}}},
                event_id="evt_after_cancel")

        sent = refunds_sent(gateway)
        assert [c["path"] for c in sent] == ["/payments/pay_after9/refund"]
        assert sent[0]["json"]["amount"] == pending["amount"]
        order = fresh(db, Order, pending["order"]["id"])
        assert order.status == "cancelled" and order.payment_status != "paid"
        assert fresh(db, Product, "PRD001").stock == 10

    def test_a_late_refund_the_gateway_refuses_is_flagged_for_a_person(self, client, auth, db, gateway, pending):
        ref = pending["gateway"]["orderReference"]
        lapse(db, pending["order"]["id"])
        gateway.responses["/payments/pay_late99"] = captured(ref, "pay_late99", pending["amount"])
        gateway.responses["/payments/pay_late99/refund"] = raising("Refunds are disabled on this account.", 400)

        verify(client, auth, pending, "pay_late99")

        payment = fresh(db, Payment, pending["paymentId"])
        due = [e for e in payment.events if e.status == "refund-due"]
        assert len(due) == 1 and "[pay_late99]" in due[0].note and "manually" in due[0].note
        assert fresh(db, Order, pending["order"]["id"]).status == "cancelled"

    def test_a_stray_payment_is_refunded_once_however_often_it_is_reported(self, client, auth, db, gateway, pending):
        ref = pending["gateway"]["orderReference"]
        lapse(db, pending["order"]["id"])
        body = {"event": "payment.captured",
                "payload": {"payment": {"entity": captured(ref, "pay_twice", pending["amount"])}}}
        webhook(client, body, event_id="evt_twice_1")
        webhook(client, {**body, "event": "order.paid"}, event_id="evt_twice_2")

        assert [c["path"] for c in refunds_sent(gateway)] == ["/payments/pay_twice/refund"]

    def test_a_late_scan_without_a_gateway_payment_id_is_not_refunded_blindly(self, client, auth, db, gateway,
                                                                              pending):
        lapse(db, pending["order"]["id"])
        from app.services.payment_expiry import sweep

        assert sweep(db) == 1
        payment = fresh(db, Payment, pending["paymentId"])

        settled = settlement.apply_result(db, payment, PaymentResult(
            ok=True, transaction_id="qr_not_a_payment", status="paid", amount=pending["amount"]))

        assert settled.status == "expired"
        assert refunds_sent(gateway) == []

    def test_expiring_refuses_what_is_not_a_held_checkout(self, client, auth, db, gateway, catalogue,
                                                          settings_documents):
        cod = placed_order(client, auth, paymentMethod="cod")
        payment = db.get(Payment, cod["paymentId"])
        assert settlement.expire_payment(db, payment) is False
        assert fresh(db, Order, cod["order"]["id"]).status == "confirmed"


class TestScanToPay:
    def _open(self, client, auth, gateway, pending, qr_id="qr_scan0001"):
        gateway.responses["/payments/qr_codes"] = {
            "id": qr_id, "image_url": "https://rzp.io/poster", "status": "active",
            "payment_amount": pending["amount"]}
        response = client.post(f"/api/payments/{pending['paymentId']}/qr", headers=auth)
        assert response.status_code == 200, response.text
        return response.json()["data"]

    def _scan(self, pending, pay_id, *, payment_id=None, status="captured"):
        return {"id": pay_id, "status": status, "amount": pending["amount"], "currency": "INR",
                "method": "upi", "vpa": "asha@ybl", "notes": {"paymentId": payment_id or pending["paymentId"]}}

    def test_the_page_is_given_our_own_image_url(self, client, auth, gateway, pending):
        code = self._open(client, auth, gateway, pending)
        assert code["imageUrl"] == "/payments/qr-image/qr_scan0001"
        assert code["posterUrl"] == "https://rzp.io/poster"
        assert code["expiresAt"].endswith("Z")

    def test_polling_before_anyone_scans(self, client, auth, db, gateway, pending):
        self._open(client, auth, gateway, pending)
        gateway.responses["/payments/qr_codes/qr_scan0001/payments"] = {"items": [
            self._scan(pending, "pay_qrfail", status="failed")]}

        polled = client.get(f"/api/payments/{pending['paymentId']}/qr/qr_scan0001", headers=auth).json()["data"]

        assert polled == {"status": "pending", "paid": False}

    def test_a_scan_settles_the_order_and_retires_the_code(self, client, auth, db, gateway, pending):
        self._open(client, auth, gateway, pending)
        gateway.responses["/payments/qr_codes/qr_scan0001/payments"] = {"items": [
            self._scan(pending, "pay_qr0001")]}

        polled = client.get(f"/api/payments/{pending['paymentId']}/qr/qr_scan0001", headers=auth).json()["data"]

        assert polled == {"status": "paid", "paid": True}
        payment = fresh(db, Payment, pending["paymentId"])
        assert payment.transaction_id == "pay_qr0001" and payment.instrument_hint == DOT * 5 + "@ybl"
        assert "/payments/qr_codes/qr_scan0001/close" in [c["path"] for c in gateway.calls]
        # Polling a settled payment asks the gateway nothing more.
        calls = len(gateway.calls)
        client.get(f"/api/payments/{pending['paymentId']}/qr/qr_scan0001", headers=auth)
        assert len(gateway.calls) == calls

    def test_a_scan_noted_for_another_payment_is_ignored(self, client, auth, db, gateway, pending):
        self._open(client, auth, gateway, pending)
        gateway.responses["/payments/qr_codes/qr_scan0001/payments"] = {"items": [
            self._scan(pending, "pay_qrother", payment_id="PAY_SOMEONE_ELSE")]}

        polled = client.get(f"/api/payments/{pending['paymentId']}/qr/qr_scan0001", headers=auth).json()["data"]

        assert polled["paid"] is False
        assert fresh(db, Payment, pending["paymentId"]).status == "pending"

    def test_polling_after_the_hold_lapsed_expires_it_and_closes_the_code(self, client, auth, db, gateway, pending):
        self._open(client, auth, gateway, pending)
        gateway.responses["/payments/qr_codes/qr_scan0001/payments"] = {"items": []}
        lapse(db, pending["order"]["id"])

        polled = client.get(f"/api/payments/{pending['paymentId']}/qr/qr_scan0001", headers=auth).json()["data"]

        assert polled == {"status": "expired", "paid": False}
        assert "/payments/qr_codes/qr_scan0001/close" in [c["path"] for c in gateway.calls]

    def test_no_code_for_a_settled_or_expired_payment(self, client, auth, db, gateway, pending):
        ref = pending["gateway"]["orderReference"]
        gateway.responses["/payments/pay_qrpaid"] = captured(ref, "pay_qrpaid", pending["amount"])
        verify(client, auth, pending, "pay_qrpaid")

        paid = client.post(f"/api/payments/{pending['paymentId']}/qr", headers=auth)
        assert paid.status_code == 409 and paid.json()["error_code"] == "ALREADY_PAID"

    def test_no_code_once_the_payment_has_expired(self, client, auth, db, gateway, pending):
        from app.services.payment_expiry import sweep

        lapse(db, pending["order"]["id"])
        sweep(db)

        expired = client.post(f"/api/payments/{pending['paymentId']}/qr", headers=auth)
        assert expired.status_code == 409 and expired.json()["error_code"] == "PAYMENT_WINDOW_CLOSED"

    def test_the_sweeper_closes_the_codes_of_what_it_expires(self, client, auth, db, gateway, pending):
        from app.services.payment_expiry import sweep

        self._open(client, auth, gateway, pending, qr_id="qr_swept001")
        lapse(db, pending["order"]["id"])

        assert sweep(db) == 1
        assert "/payments/qr_codes/qr_swept001/close" in [c["path"] for c in gateway.calls]

    def test_retiring_a_code_from_the_page(self, client, auth, gateway, pending):
        self._open(client, auth, gateway, pending)
        response = client.delete(f"/api/payments/{pending['paymentId']}/qr/qr_scan0001", headers=auth)
        assert response.status_code == 200 and response.json()["data"] == {"closed": True}
        assert gateway.calls[-1]["path"] == "/payments/qr_codes/qr_scan0001/close"

    def test_the_webhook_credits_a_code_we_issued(self, client, auth, db, gateway, pending):
        self._open(client, auth, gateway, pending)
        body = {"event": "qr_code.credited", "payload": {
            "payment": {"entity": self._scan(pending, "pay_qrhook1")},
            "qr_code": {"entity": {"id": "qr_scan0001"}}}}

        response = webhook(client, body, event_id="evt_qr_ok")

        assert response.json()["data"]["handled"] is True
        assert fresh(db, Payment, pending["paymentId"]).status == "paid"

    def test_the_webhook_refuses_a_code_we_did_not_issue_for_this_payment(self, client, auth, db, gateway, pending):
        self._open(client, auth, gateway, pending)
        body = {"event": "qr_code.credited", "payload": {
            "payment": {"entity": self._scan(pending, "pay_qrhook2")},
            "qr_code": {"entity": {"id": "qr_someone_else"}}}}

        response = webhook(client, body, event_id="evt_qr_bad")

        assert response.json()["data"]["handled"] is False
        assert fresh(db, Payment, pending["paymentId"]).status == "pending"


def poster_png(code_side=240) -> bytes:
    """A poster like Razorpay's: a banner, a square code, a caption."""
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (400, 640), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 399, 60), fill=(20, 60, 200))
    left, top = 80, 180
    module = 12
    for row in range(code_side // module):
        for col in range(code_side // module):
            if (row * 7 + col * 3) % 5 < 3 or row in (0, 1) or col in (0, 1):
                x, y = left + col * module, top + row * module
                draw.rectangle((x, y, x + module - 1, y + module - 1), fill=(10, 10, 10))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


class TestTheQrImage:
    def test_the_code_is_cut_out_of_the_poster(self, client, gateway, monkeypatch):
        from PIL import Image

        from app.services.payments import qr_image

        gateway.responses["/payments/qr_codes/qr_img0001"] = {"id": "qr_img0001",
                                                              "image_url": "https://rzp.io/poster.png"}
        fetched = []

        def fake_get(url, **kwargs):
            fetched.append(url)
            return httpx.Response(200, content=poster_png(), request=httpx.Request("GET", url))

        monkeypatch.setattr(qr_image.httpx, "get", fake_get)

        response = client.get("/api/payments/qr-image/qr_img0001")

        assert response.status_code == 200
        assert response.headers["content-type"] == "image/png"
        assert response.headers["cache-control"] == "private, max-age=120"
        assert fetched == ["https://rzp.io/poster.png"]
        cropped = Image.open(io.BytesIO(response.content))
        # Square, smaller than the poster, with a quiet zone around the code.
        assert cropped.width == cropped.height and cropped.width < 400
        assert cropped.getpixel((0, 0)) in (1, 255)

    def test_a_poster_that_cannot_be_fetched_is_a_404(self, client, gateway, monkeypatch):
        from app.services.payments import qr_image

        gateway.responses["/payments/qr_codes/qr_gone001"] = {"id": "qr_gone001", "image_url": "https://rzp.io/x"}

        def down(url, **kwargs):
            raise httpx.ConnectError("refused", request=httpx.Request("GET", url))

        monkeypatch.setattr(qr_image.httpx, "get", down)

        response = client.get("/api/payments/qr-image/qr_gone001")

        assert response.status_code == 404
        assert response.json()["error_code"] == "QR_UNAVAILABLE"

    def test_an_image_that_is_not_a_code_is_served_whole(self, client, gateway, monkeypatch):
        from PIL import Image

        from app.services.payments import qr_image

        blank = io.BytesIO()
        Image.new("RGB", (100, 100), (255, 255, 255)).save(blank, format="PNG")
        gateway.responses["/payments/qr_codes/qr_blank01"] = {"id": "qr_blank01", "image_url": "https://rzp.io/b"}
        monkeypatch.setattr(qr_image.httpx, "get", lambda url, **kw: httpx.Response(
            200, content=blank.getvalue(), request=httpx.Request("GET", url)))

        response = client.get("/api/payments/qr-image/qr_blank01")

        assert response.status_code == 200 and response.content == blank.getvalue()


class TestPaymentLinks:
    @pytest.fixture()
    def cod(self, client, auth, gateway, catalogue, settings_documents):
        return placed_order(client, auth, paymentMethod="cod")

    def _raise(self, client, admin_auth, gateway, placed, link_id="plink_x0001"):
        gateway.responses["/payment_links"] = {"id": link_id, "short_url": "https://rzp.io/i/x", "status": "created"}
        return client.post(f"/api/admin/orders/{placed['order']['id']}/payment-link", headers=admin_auth)

    def _legacy_link(self, db, gateway, placed, link_id="plink_x0001"):
        """A Razorpay Payment Link raised before the store switched to its own payment page.

        No new ones are raised (see `test_the_request_is_our_own_page_not_a_razorpay_link`), but
        links already in customers' inboxes must still settle when paid.
        """
        gateway.responses["/payment_links"] = {"id": link_id, "short_url": "https://rzp.io/i/x", "status": "created"}
        settlement.open_payment_link(db, db.get(Payment, placed["paymentId"]))

    def _callback(self, client, link_id, reference, status, pay_id, secret=KEY_SECRET):
        fields = (link_id, reference, status, pay_id)
        return client.get("/api/payments/link-callback", params={
            "razorpay_payment_link_id": link_id, "razorpay_payment_link_reference_id": reference,
            "razorpay_payment_link_status": status, "razorpay_payment_id": pay_id,
            "razorpay_signature": sign("|".join(fields), secret)})

    def test_the_request_is_our_own_page_not_a_razorpay_link(self, client, db, admin_auth, gateway, cod):
        response = self._raise(client, admin_auth, gateway, cod)
        assert response.status_code == 201, response.text
        url = response.json()["data"]["url"]
        assert url.endswith(f"/checkout/payment?payment={cod['paymentId']}&online=1")
        assert "rzp.io" not in url
        # Nothing was asked of Razorpay's Payment Links.
        assert not [c for c in gateway.calls if c["path"].startswith("/payment_links")]

    def test_a_request_can_be_sent_again(self, client, db, admin_auth, gateway, cod):
        from app.models import PaymentEvent

        assert self._raise(client, admin_auth, gateway, cod).status_code == 201
        assert self._raise(client, admin_auth, gateway, cod).status_code == 201
        sent = db.query(PaymentEvent).filter_by(payment_id=cod["paymentId"], status="link-sent").count()
        assert sent == 2

    def test_a_paid_order_gets_no_link(self, client, admin_auth, gateway, cod):
        captured_now = client.post(f"/api/admin/billing/payments/{cod['paymentId']}/capture", headers=admin_auth)
        assert captured_now.status_code == 200
        response = self._raise(client, admin_auth, gateway, cod)
        assert response.status_code == 409 and response.json()["error_code"] == "ALREADY_PAID"

    def test_a_cancelled_order_gets_no_link(self, client, auth, admin_auth, gateway, cod):
        client.post(f"/api/orders/{cod['order']['id']}/cancel", headers=auth, json={"reason": "No longer needed"})
        response = self._raise(client, admin_auth, gateway, cod)
        assert response.status_code == 409 and response.json()["error_code"] == "ORDER_NOT_PAYABLE"

    def test_the_mock_provider_cannot_raise_links(self, client, auth, admin_auth, catalogue, settings_documents):
        cod = placed_order(client, auth, paymentMethod="cod")
        response = client.post(f"/api/admin/orders/{cod['order']['id']}/payment-link", headers=admin_auth)
        assert response.status_code == 409 and response.json()["error_code"] == "PROVIDER_UNSUPPORTED"

    def test_the_mock_provider_has_no_link_callback(self, client):
        response = client.get("/api/payments/link-callback", params={"razorpay_payment_link_id": "plink_1"})
        assert response.status_code == 404 and response.json()["error_code"] == "LINK_NOT_FOUND"

    def test_a_signed_callback_for_an_unknown_link(self, client, db, admin_auth, gateway, cod):
        self._legacy_link(db, gateway, cod)
        response = self._callback(client, "plink_other", cod["paymentId"], "paid", "pay_l0")
        assert response.status_code == 404 and response.json()["error_code"] == "LINK_NOT_FOUND"

    def test_a_link_not_yet_paid_settles_nothing(self, client, db, admin_auth, gateway, cod):
        self._legacy_link(db, gateway, cod)
        response = self._callback(client, "plink_x0001", cod["paymentId"], "cancelled", "pay_l1")
        assert response.status_code == 200 and response.json()["data"]["paid"] is False
        assert not [c for c in gateway.calls if c["path"] == "/payments/pay_l1"]

    def test_a_gateway_that_cannot_confirm_settles_nothing(self, client, db, admin_auth, gateway, cod):
        self._legacy_link(db, gateway, cod)
        gateway.responses["/payments/pay_l2"] = raising()
        response = self._callback(client, "plink_x0001", cod["paymentId"], "paid", "pay_l2")
        assert response.status_code == 200 and response.json()["data"]["paid"] is False
        assert fresh(db, Payment, cod["paymentId"]).status == "pending"

    def test_the_webhook_settles_a_paid_link(self, client, db, admin_auth, gateway, cod):
        self._legacy_link(db, gateway, cod)
        body = {"event": "payment_link.paid", "payload": {
            "payment_link": {"entity": {"id": "plink_x0001", "reference_id": cod["paymentId"]}},
            "payment": {"entity": {"id": "pay_lhook1", "status": "captured", "amount": cod["amount"],
                                   "currency": "INR", "method": "upi", "vpa": "a@okaxis", "notes": {}}}}}

        response = webhook(client, body, event_id="evt_link_ok")

        assert response.json()["data"]["handled"] is True
        payment = fresh(db, Payment, cod["paymentId"])
        assert payment.status == "paid" and payment.transaction_id == "pay_lhook1"
        order = fresh(db, Order, cod["order"]["id"])
        assert order.payment_status == "paid" and order.status == "confirmed"

    def test_the_webhook_refuses_a_link_that_is_not_the_payments_own(self, client, db, admin_auth, gateway, cod):
        self._legacy_link(db, gateway, cod)
        body = {"event": "payment_link.paid", "payload": {
            "payment_link": {"entity": {"id": "plink_forged", "reference_id": cod["paymentId"]}},
            "payment": {"entity": {"id": "pay_lhook2", "status": "captured", "amount": cod["amount"]}}}}

        response = webhook(client, body, event_id="evt_link_bad")

        assert response.json()["data"]["handled"] is False
        assert fresh(db, Payment, cod["paymentId"]).status == "pending"


# =========================================================== the sweeper


class TestTheSweeper:
    def test_one_bad_order_does_not_stop_the_rest(self, client, auth, db, gateway, catalogue, settings_documents,
                                                  monkeypatch):
        from app.services import payment_expiry

        first = placed_order(client, auth)
        second = placed_order(client, auth)
        lapse(db, first["order"]["id"])
        lapse(db, second["order"]["id"])
        real = settlement.expire_payment
        seen = []

        def flaky(db, payment, **kwargs):
            seen.append(payment.id)
            if len(seen) == 1:
                raise RuntimeError("gateway timeout while closing a code")
            return real(db, payment, **kwargs)

        monkeypatch.setattr(settlement, "expire_payment", flaky)

        assert payment_expiry.sweep(db) == 1
        assert len(seen) == 2

    def test_an_order_without_a_payment_is_skipped(self, client, auth, db, gateway, catalogue, settings_documents):
        from app.services import payment_expiry

        placed = placed_order(client, auth)
        lapse(db, placed["order"]["id"])
        db.delete(db.get(Payment, placed["paymentId"]))
        db.flush()

        assert payment_expiry.sweep(db) == 0
        assert fresh(db, Order, placed["order"]["id"]).status == "pending"

    def test_nothing_lapsed_nothing_cancelled(self, client, auth, db, gateway, pending):
        from app.services import payment_expiry

        assert payment_expiry.sweep(db, now=datetime.utcnow() - timedelta(minutes=30)) == 0

    def test_the_loop_runs_a_tracked_sweep_and_survives_a_failure(self, monkeypatch):
        import asyncio

        from app.core import database
        from app.services import jobs, payment_expiry

        class Dummy:
            closed = False

            def close(self):
                Dummy.closed = True

        swept = []
        monkeypatch.setattr(database, "SessionLocal", lambda: Dummy())
        monkeypatch.setattr(payment_expiry, "sweep", lambda db: swept.append(db))
        rounds = []

        def tracked(name, interval, fn):
            rounds.append((name, interval))
            if len(rounds) == 1:
                def boom():
                    raise RuntimeError("first pass failed")
                return boom
            return fn

        async def sleep(seconds):
            if len(rounds) >= 2:
                raise asyncio.CancelledError
        monkeypatch.setattr(jobs, "tracked", tracked)
        monkeypatch.setattr(payment_expiry.asyncio, "sleep", sleep)

        with pytest.raises(asyncio.CancelledError):
            asyncio.run(payment_expiry.run_forever())

        assert [name for name, _ in rounds] == ["payment_expiry", "payment_expiry"]
        assert len(swept) == 1 and Dummy.closed
