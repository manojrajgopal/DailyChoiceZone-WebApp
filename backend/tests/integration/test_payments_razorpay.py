"""
The Razorpay integration.

Nothing here touches the network. The gateway's HTTP calls are stubbed at
`_request`, which is the seam the provider was given for exactly this reason —
a test that depended on Razorpay's uptime would be a test that fails for
reasons having nothing to do with this code.

What is tested for real, with no stub at all, is the part that decides whether
money was taken: the signature check, and the rule that a valid signature is
not on its own permission to mark an order paid.
"""

from __future__ import annotations

import hashlib
import hmac
import json

import pytest

pytestmark = pytest.mark.integration


KEY_ID = "rzp_test_abcdefghijklmn"
KEY_SECRET = "secret_for_tests_only_xx"
WEBHOOK_SECRET = "webhook_secret_for_tests"

ADDRESS = {
    "fullName": "Asha Rao", "phone": "9876500001", "line1": "4 Brigade Road",
    "line2": "", "city": "Bengaluru", "state": "Karnataka", "pincode": "560001",
    "country": "India", "email": "shopper@example.com",
}


def sign(body: str, secret: str = KEY_SECRET) -> str:
    return hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()


@pytest.fixture()
def razorpay(monkeypatch):
    """
    The provider, with credentials and with the network taken away.

    `calls` records what would have gone to the gateway, so a test can assert
    on the request as well as the response — the amount sent to Razorpay is as
    important as the amount it reports back.
    """
    from app.core.config import settings
    from app.services import payments
    from app.services.payments.razorpay import RazorpayPaymentProvider

    monkeypatch.setattr(settings, "PAYMENT_PROVIDER", "razorpay")
    monkeypatch.setattr(settings, "RAZOR_KEY_ID", KEY_ID)
    monkeypatch.setattr(settings, "RAZOR_KEY_SECRET", KEY_SECRET)
    monkeypatch.setattr(settings, "RAZOR_WEBHOOK_SECRET", WEBHOOK_SECRET)

    provider = RazorpayPaymentProvider()
    provider.calls = []
    provider.responses = {}

    def fake_request(method, path, **kwargs):
        provider.calls.append({"method": method, "path": path, **kwargs})
        try:
            return provider.responses[path]
        except KeyError:  # pragma: no cover - a test forgot to stub something
            raise AssertionError(f"no stubbed response for {method} {path}")

    monkeypatch.setattr(provider, "_request", fake_request)

    # Everything that asks for "the provider" gets this one.
    payments.get_provider.cache_clear()
    monkeypatch.setattr(payments, "get_provider", lambda: provider)
    monkeypatch.setattr("app.services.orders.get_provider", lambda: provider)
    monkeypatch.setattr("app.services.settlement.get_provider", lambda: provider)
    monkeypatch.setattr("app.services.invoices.get_provider", lambda: provider)

    return provider


class TestCredentials:
    def test_it_refuses_to_start_without_keys(self, monkeypatch):
        """
        Better a startup failure than a storefront that takes no money.

        A provider that quietly did nothing would let every order through as
        unpaid, which is the one failure mode worse than not booting.
        """
        from app.core.config import settings
        from app.services.payments.razorpay import RazorpayPaymentProvider

        monkeypatch.setattr(settings, "RAZOR_KEY_ID", "")
        monkeypatch.setattr(settings, "RAZOR_KEY_SECRET", "")

        with pytest.raises(RuntimeError, match="RAZOR_KEY_ID"):
            RazorpayPaymentProvider()


class TestOpeningAnOrder:
    def test_it_sends_the_amount_in_minor_units(self, razorpay):
        from app.services.payments.base import PaymentRequest

        razorpay.responses["/orders"] = {"id": "order_test01"}

        result = razorpay.create(
            PaymentRequest(
                order_id="ORD001", invoice_id="INV001", customer_id="CUS001",
                customer_name="Asha Rao", customer_email="shopper@example.com",
                amount=123456, currency="INR", method="upi",
                notes={"orderNumber": "DCZ10001"},
            )
        )

        sent = razorpay.calls[0]["json"]
        assert sent["amount"] == 123456
        assert sent["currency"] == "INR"
        # The number a customer would quote, not our internal id.
        assert sent["receipt"] == "DCZ10001"
        assert sent["notes"]["orderId"] == "ORD001"

        assert result.status == "pending"
        assert result.provider_reference == "order_test01"

    def test_a_new_order_is_never_already_paid(self, razorpay):
        """
        `create` opens an order; it does not take money.

        Returning anything settled here would mark an order paid before the
        shopper had even seen a payment sheet.
        """
        from app.services.payments.base import PaymentRequest

        razorpay.responses["/orders"] = {"id": "order_test02"}

        result = razorpay.create(
            PaymentRequest(
                order_id="ORD002", invoice_id="INV002", customer_id="CUS001",
                customer_name="Asha Rao", customer_email="shopper@example.com",
                amount=1000, currency="INR", method="card",
            )
        )
        assert result.status == "pending"

    def test_cash_on_delivery_never_reaches_the_gateway(self, razorpay):
        """There is nothing for Razorpay to do with a COD order."""
        from app.services.payments.base import PaymentRequest

        result = razorpay.create(
            PaymentRequest(
                order_id="ORD003", invoice_id="INV003", customer_id="CUS001",
                customer_name="Asha Rao", customer_email="shopper@example.com",
                amount=1000, currency="INR", method="cod",
            )
        )

        assert razorpay.calls == []
        assert result.status == "pending"
        assert result.instrument_hint == "Collect on delivery"


class TestVerifyingAPayment:
    """
    The part that decides whether money was taken.

    No stub on the signature check — it is the real HMAC, because a test that
    stubbed it would be testing nothing.
    """

    def test_a_good_signature_and_a_captured_payment(self, razorpay):
        razorpay.responses["/payments/pay_ok"] = {
            "id": "pay_ok", "status": "captured", "amount": 5000,
            "order_id": "order_abc", "method": "upi", "vpa": "someone@okhdfc",
        }

        result = razorpay.verify("order_abc", {
            "razorpay_order_id": "order_abc",
            "razorpay_payment_id": "pay_ok",
            "razorpay_signature": sign("order_abc|pay_ok"),
        })

        assert result.ok
        assert result.status == "paid"
        assert result.amount == 5000
        # A masked remnant, and only that.
        assert result.instrument_hint == "•••••@okhdfc"

    def test_a_forged_signature_is_refused(self, razorpay):
        result = razorpay.verify("order_abc", {
            "razorpay_order_id": "order_abc",
            "razorpay_payment_id": "pay_ok",
            "razorpay_signature": "0" * 64,
        })

        assert not result.ok
        assert result.status == "failed"
        # Nothing was read back: a bad signature stops before the gateway call.
        assert razorpay.calls == []

    def test_a_signature_from_another_secret_is_refused(self, razorpay):
        """The one thing a browser cannot produce is a digest over our secret."""
        result = razorpay.verify("order_abc", {
            "razorpay_order_id": "order_abc",
            "razorpay_payment_id": "pay_ok",
            "razorpay_signature": sign("order_abc|pay_ok", "a_different_secret"),
        })
        assert not result.ok

    def test_a_signature_for_a_different_order_is_refused(self, razorpay):
        """
        A real signature, correctly computed — for somebody else's order.

        Without this check a shopper could pay ₹1 on an order of their own and
        present it against an order for ₹10,000.
        """
        result = razorpay.verify("order_ours", {
            "razorpay_order_id": "order_theirs",
            "razorpay_payment_id": "pay_theirs",
            "razorpay_signature": sign("order_theirs|pay_theirs"),
        })

        assert not result.ok
        assert "different order" in (result.failure_reason or "")
        assert razorpay.calls == []

    def test_an_incomplete_response_is_refused(self, razorpay):
        assert not razorpay.verify("order_abc", {}).ok

    def test_a_valid_signature_on_a_failed_payment_is_not_paid(self, razorpay):
        """
        The reason the gateway is read back at all.

        The signature proves the payment belongs to the order. It says nothing
        whatever about the outcome.
        """
        razorpay.responses["/payments/pay_bad"] = {
            "id": "pay_bad", "status": "failed", "amount": 5000,
            "order_id": "order_abc", "method": "card",
            "error_description": "Your bank declined the payment.",
        }

        result = razorpay.verify("order_abc", {
            "razorpay_order_id": "order_abc",
            "razorpay_payment_id": "pay_bad",
            "razorpay_signature": sign("order_abc|pay_bad"),
        })

        assert result.status == "failed"
        assert result.failure_reason == "Your bank declined the payment."


class TestWebhookSignature:
    def test_the_raw_body_is_what_is_signed(self, razorpay):
        raw = b'{"event":"payment.captured"}'
        assert razorpay.verify_webhook(raw, sign(raw.decode(), WEBHOOK_SECRET))

    def test_a_reserialised_body_does_not_verify(self, razorpay):
        """
        Why the route reads bytes rather than a parsed object.

        Re-serialising changes the spacing, which changes the digest.
        """
        raw = b'{"event":"payment.captured"}'
        signature = sign(raw.decode(), WEBHOOK_SECRET)
        reserialised = json.dumps(json.loads(raw)).encode()

        assert reserialised != raw
        assert not razorpay.verify_webhook(reserialised, signature)

    def test_the_key_secret_is_not_the_webhook_secret(self, razorpay):
        raw = b'{"event":"payment.captured"}'
        assert not razorpay.verify_webhook(raw, sign(raw.decode(), KEY_SECRET))

    def test_no_webhook_secret_means_nothing_is_trusted(self, razorpay, monkeypatch):
        """
        An unconfigured webhook must refuse everything.

        Accepting unverified deliveries would be an open endpoint for marking
        any order paid.
        """
        from app.core.config import settings

        monkeypatch.setattr(settings, "RAZOR_WEBHOOK_SECRET", "")
        raw = b'{"event":"payment.captured"}'
        assert not razorpay.verify_webhook(raw, sign(raw.decode(), WEBHOOK_SECRET))


class TestRefunds:
    def test_it_refunds_against_the_payment(self, razorpay):
        razorpay.responses["/payments/pay_ok/refund"] = {
            "id": "rfnd_1", "status": "processed",
        }

        result = razorpay.refund("pay_ok", 2500, "Item damaged")

        assert razorpay.calls[0]["json"]["amount"] == 2500
        assert result.ok
        assert result.status == "completed"
        assert result.reference == "rfnd_1"

    def test_a_pending_refund_is_processing_not_complete(self, razorpay):
        razorpay.responses["/payments/pay_ok/refund"] = {
            "id": "rfnd_2", "status": "pending",
        }
        assert razorpay.refund("pay_ok", 100, "x").status == "processing"

    def test_there_is_nothing_to_refund_on_an_unpaid_order(self, razorpay):
        """
        An order reference means Checkout never completed.

        Sending it to the refund endpoint would be asking for money back that
        was never taken.
        """
        result = razorpay.refund("order_abc", 100, "x")
        assert not result.ok
        assert razorpay.calls == []


class TestInstrumentHint:
    """
    What may be kept from a payment, and what may not.

    The hint is the only payment detail this system stores, and it must stay a
    remnant — never anything that identifies an instrument on its own.
    """

    @pytest.mark.parametrize(
        "payment,expected",
        [
            ({"method": "card", "card": {"last4": "1111", "network": "Visa"}}, "Visa •••• 1111"),
            ({"method": "upi", "vpa": "someone@okaxis"}, "•••••@okaxis"),
            ({"method": "netbanking", "bank": "HDFC"}, "HDFC"),
            ({"method": "wallet", "wallet": "paytm"}, "Paytm Wallet"),
            ({"method": "cod"}, "Cod"),
        ],
    )
    def test_it_masks(self, payment, expected):
        from app.services.payments.razorpay import instrument_hint

        assert instrument_hint(payment) == expected

    def test_it_keeps_no_card_number_and_no_local_part(self):
        from app.services.payments.razorpay import instrument_hint

        card = instrument_hint(
            {"method": "card", "card": {"last4": "1111", "network": "Visa", "name": "A Rao"}}
        )
        assert "A Rao" not in card

        upi = instrument_hint({"method": "upi", "vpa": "asha.rao.1990@okhdfc"})
        assert "asha" not in upi


class TestTheCheckoutFlow:
    """The two-step checkout a real gateway requires, end to end."""

    @pytest.fixture()
    def placed(self, client, auth, catalogue, settings_documents, razorpay):
        razorpay.responses["/orders"] = {"id": "order_flow01"}

        client.post("/api/cart/items", headers=auth,
                    json={"productId": "PRD001", "quantity": 1})
        response = client.post("/api/orders", headers=auth, json={
            "shippingAddress": ADDRESS, "billingAddress": None,
            "deliveryMethod": "standard", "paymentMethod": "upi",
            "couponCode": None, "email": "shopper@example.com", "saveAddress": False,
        })
        assert response.status_code == 201, response.text
        return response.json()["data"]

    def test_the_order_is_held_until_the_money_arrives(self, placed):
        assert placed["order"]["status"] == "pending"
        assert placed["paymentStatus"] == "pending"

    def test_the_handoff_carries_no_secret(self, placed):
        gateway = placed["gateway"]
        assert gateway["keyId"] == KEY_ID
        assert gateway["orderReference"] == "order_flow01"

        serialised = json.dumps(gateway)
        assert KEY_SECRET not in serialised
        assert WEBHOOK_SECRET not in serialised
        assert "signature" not in serialised.lower()

    def test_the_handoff_amount_is_what_the_invoice_says(self, placed):
        assert placed["gateway"]["amount"] == placed["amount"]

    def test_verifying_confirms_the_order(self, client, auth, placed, razorpay):
        razorpay.responses["/payments/pay_flow01"] = {
            "id": "pay_flow01", "status": "captured", "order_id": "order_flow01",
            "amount": placed["amount"], "method": "upi", "vpa": "asha@okhdfc",
        }

        response = client.post(
            f"/api/payments/{placed['paymentId']}/verify", headers=auth,
            json={
                "razorpayOrderId": "order_flow01",
                "razorpayPaymentId": "pay_flow01",
                "razorpaySignature": sign("order_flow01|pay_flow01"),
            },
        )
        assert response.status_code == 200, response.text

        order = client.get(f"/api/orders/{placed['order']['id']}", headers=auth).json()["data"]
        assert order["status"] == "confirmed"
        assert order["paymentStatus"] == "paid"

    def test_the_refund_reference_becomes_the_payment_id(
        self, client, auth, placed, razorpay, db
    ):
        """
        Why `transaction_id` is replaced on settlement.

        A refund is issued against the *payment*, so once there is a payment id
        that is the reference worth keeping; the order id moves aside.
        """
        razorpay.responses["/payments/pay_flow01"] = {
            "id": "pay_flow01", "status": "captured", "order_id": "order_flow01",
            "amount": placed["amount"], "method": "upi", "vpa": "asha@okhdfc",
        }
        client.post(
            f"/api/payments/{placed['paymentId']}/verify", headers=auth,
            json={
                "razorpayOrderId": "order_flow01",
                "razorpayPaymentId": "pay_flow01",
                "razorpaySignature": sign("order_flow01|pay_flow01"),
            },
        )

        from app.models import Payment

        row = db.get(Payment, placed["paymentId"])
        assert row.transaction_id == "pay_flow01"
        assert row.provider_reference == "order_flow01"

    def test_an_underpayment_is_refused(self, client, auth, placed, razorpay):
        """
        A verified payment for the wrong amount is not a paid order.

        This is the check that makes a tampered gateway order harmless.
        """
        razorpay.responses["/payments/pay_short"] = {
            "id": "pay_short", "status": "captured", "order_id": "order_flow01",
            "amount": 100, "method": "upi",
        }

        response = client.post(
            f"/api/payments/{placed['paymentId']}/verify", headers=auth,
            json={
                "razorpayOrderId": "order_flow01",
                "razorpayPaymentId": "pay_short",
                "razorpaySignature": sign("order_flow01|pay_short"),
            },
        )
        assert response.status_code >= 400, response.text

        order = client.get(f"/api/orders/{placed['order']['id']}", headers=auth).json()["data"]
        assert order["paymentStatus"] != "paid"

    def test_another_customer_cannot_verify_it(self, client, placed, razorpay,
                                               other_customer):
        response = client.post("/api/auth/login", json={
            "email": other_customer.email, "password": "Customer@123"})
        headers = {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}

        assert client.post(
            f"/api/payments/{placed['paymentId']}/verify", headers=headers,
            json={
                "razorpayOrderId": "order_flow01",
                "razorpayPaymentId": "pay_flow01",
                "razorpaySignature": sign("order_flow01|pay_flow01"),
            },
        ).status_code == 404

    def test_verifying_needs_an_account(self, client, placed):
        assert client.post(
            f"/api/payments/{placed['paymentId']}/verify",
            json={"razorpayOrderId": "x", "razorpayPaymentId": "y", "razorpaySignature": "z"},
        ).status_code == 401

    def test_the_retry_session_reuses_the_same_gateway_order(self, client, auth, placed):
        """
        Two open gateway orders for one invoice is how somebody gets charged
        twice.
        """
        session = client.get(
            f"/api/payments/{placed['paymentId']}/session", headers=auth
        ).json()["data"]

        assert session["gateway"]["orderReference"] == "order_flow01"

    def test_a_settled_payment_offers_no_session(self, client, auth, placed, razorpay):
        razorpay.responses["/payments/pay_flow01"] = {
            "id": "pay_flow01", "status": "captured", "order_id": "order_flow01",
            "amount": placed["amount"], "method": "upi",
        }
        client.post(
            f"/api/payments/{placed['paymentId']}/verify", headers=auth,
            json={
                "razorpayOrderId": "order_flow01",
                "razorpayPaymentId": "pay_flow01",
                "razorpaySignature": sign("order_flow01|pay_flow01"),
            },
        )

        session = client.get(
            f"/api/payments/{placed['paymentId']}/session", headers=auth
        ).json()["data"]

        assert session["status"] == "paid"
        assert session["gateway"] is None


class TestTheWebhook:
    @pytest.fixture()
    def placed(self, client, auth, catalogue, settings_documents, razorpay):
        razorpay.responses["/orders"] = {"id": "order_hook01"}
        client.post("/api/cart/items", headers=auth,
                    json={"productId": "PRD001", "quantity": 1})
        response = client.post("/api/orders", headers=auth, json={
            "shippingAddress": ADDRESS, "billingAddress": None,
            "deliveryMethod": "standard", "paymentMethod": "card",
            "couponCode": None, "email": "shopper@example.com", "saveAddress": False,
        })
        assert response.status_code == 201, response.text
        return response.json()["data"]

    @staticmethod
    def delivery(amount: int, event: str = "payment.captured") -> bytes:
        return json.dumps({
            "event": event,
            "payload": {"payment": {"entity": {
                "id": "pay_hook01", "order_id": "order_hook01", "status": "captured",
                "amount": amount, "method": "card",
                "card": {"last4": "4242", "network": "Visa"},
            }}},
        }).encode()

    def test_an_unsigned_delivery_is_refused(self, client, placed):
        assert client.post(
            "/api/payments/webhook/razorpay",
            content=self.delivery(placed["amount"]),
            headers={"Content-Type": "application/json"},
        ).status_code >= 400

    def test_a_signed_delivery_settles_the_order(self, client, auth, placed):
        raw = self.delivery(placed["amount"])
        response = client.post(
            "/api/payments/webhook/razorpay", content=raw,
            headers={
                "Content-Type": "application/json",
                "X-Razorpay-Signature": sign(raw.decode(), WEBHOOK_SECRET),
            },
        )
        assert response.status_code == 200, response.text
        assert response.json()["data"]["handled"] is True

        order = client.get(f"/api/orders/{placed['order']['id']}", headers=auth).json()["data"]
        assert order["status"] == "confirmed"
        assert order["paymentStatus"] == "paid"

    def test_a_redelivery_does_not_double_count(self, client, auth, placed):
        """
        Razorpay retries, and may deliver twice. Settling twice must not pay
        an invoice twice.
        """
        raw = self.delivery(placed["amount"])
        headers = {
            "Content-Type": "application/json",
            "X-Razorpay-Signature": sign(raw.decode(), WEBHOOK_SECRET),
        }

        client.post("/api/payments/webhook/razorpay", content=raw, headers=headers)
        again = client.post("/api/payments/webhook/razorpay", content=raw, headers=headers)
        assert again.status_code == 200

        invoice = client.get(
            f"/api/invoices/{placed['invoiceId']}", headers=auth
        ).json()["data"]
        assert invoice["amountPaid"] == invoice["breakdown"]["grandTotal"]

    def test_an_unknown_event_is_still_a_200(self, client, placed):
        """
        Answering 4xx would have Razorpay redeliver it for days.

        An event this system does not model is not a failure.
        """
        raw = json.dumps({"event": "subscription.charged", "payload": {}}).encode()
        response = client.post(
            "/api/payments/webhook/razorpay", content=raw,
            headers={
                "Content-Type": "application/json",
                "X-Razorpay-Signature": sign(raw.decode(), WEBHOOK_SECRET),
            },
        )
        assert response.status_code == 200
        assert response.json()["data"]["handled"] is False

    def test_a_failure_does_not_cancel_the_order(self, client, auth, placed):
        """
        A declined card is not a cancelled order.

        The shopper can try another one, and cancelling here would take the
        stock back from somebody still paying.
        """
        raw = json.dumps({
            "event": "payment.failed",
            "payload": {"payment": {"entity": {
                "id": "pay_hookfail", "order_id": "order_hook01", "status": "failed",
                "amount": placed["amount"], "method": "card",
                "error_description": "Insufficient funds.",
            }}},
        }).encode()

        response = client.post(
            "/api/payments/webhook/razorpay", content=raw,
            headers={
                "Content-Type": "application/json",
                "X-Razorpay-Signature": sign(raw.decode(), WEBHOOK_SECRET),
            },
        )
        assert response.status_code == 200

        order = client.get(f"/api/orders/{placed['order']['id']}", headers=auth).json()["data"]
        assert order["status"] == "pending"
        assert order["paymentStatus"] == "failed"

    def test_the_browser_and_the_webhook_do_not_fight(self, client, auth, placed, razorpay):
        """
        Both paths settle the same payment, and only one outcome results.

        Whichever arrives first wins; the other is a no-op.
        """
        razorpay.responses["/payments/pay_hook01"] = {
            "id": "pay_hook01", "status": "captured", "order_id": "order_hook01",
            "amount": placed["amount"], "method": "card",
            "card": {"last4": "4242", "network": "Visa"},
        }

        raw = self.delivery(placed["amount"])
        client.post("/api/payments/webhook/razorpay", content=raw, headers={
            "Content-Type": "application/json",
            "X-Razorpay-Signature": sign(raw.decode(), WEBHOOK_SECRET),
        })

        # The browser now reports the same payment.
        response = client.post(
            f"/api/payments/{placed['paymentId']}/verify", headers=auth,
            json={
                "razorpayOrderId": "order_hook01",
                "razorpayPaymentId": "pay_hook01",
                "razorpaySignature": sign("order_hook01|pay_hook01"),
            },
        )
        assert response.status_code == 200, response.text

        invoice = client.get(
            f"/api/invoices/{placed['invoiceId']}", headers=auth
        ).json()["data"]
        assert invoice["amountPaid"] == invoice["breakdown"]["grandTotal"]


class TestTheMethodsEndpoint:
    """
    What the payment page is allowed to offer.

    The rule being tested is the intersection: a method has to be switched on
    in the store's own settings *and* available on the gateway account. One
    without the other is a method a shopper picks and the gateway then
    refuses — a failure after the decision.
    """

    @pytest.fixture()
    def gateway_methods(self, razorpay, monkeypatch):
        monkeypatch.setattr(
            razorpay,
            "methods",
            lambda: {
                "card": True,
                "netbanking": [{"code": "HDFC", "name": "HDFC Bank"}],
                "wallet": [{"code": "mobikwik", "name": "MobiKwik"}],
                "upi": False,
                "upiIntent": True,
                "upiQr": False,
                "emi": False,
            },
        )
        return razorpay

    def test_it_offers_only_what_both_sides_allow(
        self, client, gateway_methods, settings_documents
    ):
        """
        The fixture's store enables upi, card and cod — not net banking.

        So net banking must not be offered even though the gateway has a bank
        list for it, and wallet must not be offered at all.
        """
        body = client.get("/api/payments/methods").json()["data"]

        assert "card" in body["methods"]
        assert "cod" in body["methods"]
        assert "netbanking" not in body["methods"]
        assert "wallet" not in body["methods"]

    def test_upi_is_offered_on_intent_alone(
        self, client, gateway_methods, settings_documents
    ):
        """An intent-only account can still hand off to an app on a phone."""
        body = client.get("/api/payments/methods").json()["data"]

        assert "upi" in body["methods"]
        assert body["upiIntent"] is True
        # No QR, because a QR is the collect rail and that is switched off.
        assert body["upiQr"] is False

    def test_a_disabled_gateway_method_is_dropped(
        self, client, razorpay, monkeypatch, settings_documents
    ):
        monkeypatch.setattr(
            razorpay,
            "methods",
            lambda: {
                "card": False,
                "netbanking": [],
                "wallet": [],
                "upi": False,
                "upiIntent": False,
                "upiQr": False,
                "emi": False,
            },
        )

        body = client.get("/api/payments/methods").json()["data"]

        # Cash on delivery survives because it is ours, not the gateway's —
        # and scan-to-pay survives because Razorpay's QR Codes are their own
        # product with no flag in this response. An account can have every
        # Checkout rail switched off and still take a scan, so it is offered
        # and fails with the gateway's own reason if it cannot be minted.
        assert body["methods"] == ["cod", "qr"]

    def test_a_gateway_that_cannot_be_reached_offers_no_rails(
        self, client, razorpay, monkeypatch, settings_documents
    ):
        """
        An empty answer, not a guess.

        Promising a method the gateway may not have is worse than offering
        fewer.
        """
        monkeypatch.setattr(razorpay, "methods", dict)

        body = client.get("/api/payments/methods").json()["data"]

        # Not even scan-to-pay: an empty answer means the gateway could not be
        # reached, and a code we cannot mint is worse than one not offered.
        assert body["methods"] == ["cod"]
        assert body["qrCodes"] is False

    def test_without_a_gateway_the_store_settings_stand(
        self, client, monkeypatch, settings_documents
    ):
        from app.core.config import settings

        monkeypatch.setattr(settings, "PAYMENT_PROVIDER", "mock")
        body = client.get("/api/payments/methods").json()["data"]

        assert body["gateway"] is False
        # Whatever the store configured, unfiltered — there is no gateway to
        # disagree with it.
        assert set(body["methods"]) == {"upi", "card", "cod"}


class TestTheConfigEndpoint:
    def test_it_publishes_the_key_id_and_nothing_else(self, client, razorpay):
        body = client.get("/api/payments/config").json()["data"]

        assert body["keyId"] == KEY_ID
        assert body["gateway"] is True
        assert body["mode"] == "test"

        serialised = json.dumps(body)
        assert KEY_SECRET not in serialised
        assert WEBHOOK_SECRET not in serialised

    def test_live_keys_report_live(self, client, razorpay, monkeypatch):
        from app.core.config import settings

        monkeypatch.setattr(settings, "RAZOR_KEY_ID", "rzp_live_abcdefghijklmn")
        assert client.get("/api/payments/config").json()["data"]["mode"] == "live"

    def test_no_gateway_reports_none(self, client, monkeypatch):
        from app.core.config import settings

        monkeypatch.setattr(settings, "PAYMENT_PROVIDER", "mock")
        body = client.get("/api/payments/config").json()["data"]

        assert body["gateway"] is False
        assert body["mode"] == "none"
        assert body["keyId"] == ""
