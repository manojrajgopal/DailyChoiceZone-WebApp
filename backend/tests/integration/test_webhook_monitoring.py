"""
Razorpay webhook monitoring: the record each delivery leaves, duplicates,
failures and retries, replays, and what is — and isn't — kept of the payload.
"""

from __future__ import annotations

import json

import pytest

from app.core import rate_limit
from app.models import WebhookEvent, WebhookEventAttempt
from tests.integration.test_payments_razorpay import ADDRESS, WEBHOOK_SECRET, razorpay, sign  # noqa: F401

pytestmark = pytest.mark.integration

HOOK = "/api/payments/webhook/razorpay"


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def placed(client, auth, catalogue, settings_documents, razorpay):  # noqa: F811
    razorpay.responses["/orders"] = {"id": "order_mon01"}
    client.post("/api/cart/items", headers=auth, json={"productId": "PRD001", "quantity": 1})
    response = client.post("/api/orders", headers=auth, json={
        "shippingAddress": ADDRESS, "billingAddress": None, "deliveryMethod": "standard",
        "paymentMethod": "card", "couponCode": None, "email": "shopper@example.com", "saveAddress": False,
    })
    assert response.status_code == 201, response.text
    return response.json()["data"]


def captured(amount, pay_id="pay_mon01"):
    return json.dumps({
        "entity": "event", "event": "payment.captured", "contains": ["payment"],
        "payload": {"payment": {"entity": {
            "id": pay_id, "order_id": "order_mon01", "status": "captured", "amount": amount,
            "currency": "INR", "method": "upi", "vpa": "asha.rao@okhdfc", "email": "shopper@example.com",
            "contact": "+919876500001", "card": None, "bank": None,
            "notes": {"paymentId": "ignored", "customerPhone": "9876500001"},
        }}},
    }).encode()


def deliver(client, raw, event_id="evt_mon01", signature=None):
    headers = {"Content-Type": "application/json",
               "X-Razorpay-Signature": signature if signature is not None else sign(raw.decode(), WEBHOOK_SECRET)}
    if event_id:
        headers["X-Razorpay-Event-Id"] = event_id
    return client.post(HOOK, content=raw, headers=headers)


def record(db, event_id="evt_mon01") -> WebhookEvent:
    db.expire_all()
    return db.get(WebhookEvent, event_id)


class TestTheRecord:
    def test_a_delivery_is_recorded_as_processed(self, client, db, placed):
        response = deliver(client, captured(placed["amount"]))
        assert response.status_code == 200
        row = record(db)
        assert row.status == "processed"
        assert row.attempts == 1 and row.duplicates == 0
        assert row.payment_id == placed["paymentId"]
        assert row.order_id == placed["order"]["id"]
        assert row.gateway_payment_id == "pay_mon01"
        assert row.completed_at is not None
        assert [a.outcome for a in row.attempt_log] == ["processed"]

    def test_an_unknown_event_is_recorded_as_ignored(self, client, db, placed):
        raw = json.dumps({"event": "subscription.charged", "payload": {}}).encode()
        assert deliver(client, raw, "evt_ignored").status_code == 200
        assert record(db, "evt_ignored").status == "ignored"

    def test_a_forged_delivery_leaves_no_record(self, client, db, placed):
        assert deliver(client, captured(placed["amount"]), signature="0" * 64).status_code == 422
        assert record(db) is None

    def test_personal_details_are_not_kept(self, client, db, placed):
        deliver(client, captured(placed["amount"]))
        kept = json.dumps(record(db).payload)
        for secret in ("shopper@example.com", "+919876500001", "asha.rao", "9876500001"):
            assert secret not in kept
        entity = record(db).payload["payload"]["payment"]["entity"]
        assert entity["vpa"] == "•••••@okhdfc"
        assert entity["amount"] == placed["amount"]
        assert "customerPhone" not in entity.get("notes", {})

    def test_a_delivery_without_an_event_id_is_still_deduplicated(self, client, db, placed):
        raw = captured(placed["amount"])
        deliver(client, raw, event_id="")
        deliver(client, raw, event_id="")
        rows = db.query(WebhookEvent).all()
        assert len(rows) == 1 and rows[0].duplicates == 1


class TestDuplicatesAndFailures:
    def test_a_duplicate_is_counted_not_applied(self, client, db, placed, monkeypatch):
        from app.services import settlement

        raw = captured(placed["amount"])
        deliver(client, raw)
        calls = []
        real = settlement.settle_from_webhook
        monkeypatch.setattr(settlement, "settle_from_webhook", lambda *a, **k: calls.append(1) or real(*a, **k))
        response = deliver(client, raw)
        assert response.status_code == 200
        assert response.json()["data"]["duplicate"] is True
        assert calls == []
        row = record(db)
        assert row.duplicates == 1 and row.last_duplicate_at is not None and row.attempts == 1

    def test_a_failure_is_recorded_and_answered_500_so_razorpay_retries(self, client, db, placed, monkeypatch):
        from app.services import settlement

        def broken(db, body):
            raise RuntimeError("database went away")

        monkeypatch.setattr(settlement, "settle_from_webhook", broken)
        response = deliver(client, captured(placed["amount"]))
        assert response.status_code == 500
        row = record(db)
        assert row.status == "failed"
        assert "database went away" in row.error
        assert row.payload is not None

    def test_a_redelivery_after_a_failure_is_processed(self, client, db, auth, placed, monkeypatch):
        from app.services import settlement

        real = settlement.settle_from_webhook
        monkeypatch.setattr(settlement, "settle_from_webhook",
                            lambda db, body: (_ for _ in ()).throw(RuntimeError("temporary")))
        raw = captured(placed["amount"])
        assert deliver(client, raw).status_code == 500
        monkeypatch.setattr(settlement, "settle_from_webhook", real)
        assert deliver(client, raw).status_code == 200

        row = record(db)
        assert row.status == "processed" and row.attempts == 2 and row.error == ""
        assert [(a.trigger, a.outcome) for a in row.attempt_log] == [("delivery", "failed"),
                                                                      ("redelivery", "processed")]
        order = client.get(f"/api/orders/{placed['order']['id']}", headers=auth).json()["data"]
        assert order["paymentStatus"] == "paid"


class TestReplay:
    @pytest.fixture()
    def failed(self, client, placed, monkeypatch):
        from app.services import settlement

        real = settlement.settle_from_webhook
        monkeypatch.setattr(settlement, "settle_from_webhook",
                            lambda db, body: (_ for _ in ()).throw(RuntimeError("temporary")))
        assert deliver(client, captured(placed["amount"])).status_code == 500
        monkeypatch.setattr(settlement, "settle_from_webhook", real)
        return placed

    def test_a_failed_event_can_be_replayed_once(self, client, db, auth, admin_auth, failed):
        response = client.post("/api/admin/payments/webhooks/evt_mon01/replay", headers=admin_auth)
        assert response.status_code == 200, response.text
        assert response.json()["data"]["event"]["status"] == "processed"
        order = client.get(f"/api/orders/{failed['order']['id']}", headers=auth).json()["data"]
        assert order["paymentStatus"] == "paid"

        again = client.post("/api/admin/payments/webhooks/evt_mon01/replay", headers=admin_auth)
        assert again.status_code == 409
        attempts = db.query(WebhookEventAttempt).filter_by(event_id="evt_mon01").all()
        assert [a.trigger for a in attempts] == ["delivery", "replay"]
        assert attempts[1].admin_id == "ADM001"

    def test_a_replay_does_not_pay_twice(self, client, db, auth, admin_auth, failed):
        from app.models import Invoice

        client.post("/api/admin/payments/webhooks/evt_mon01/replay", headers=admin_auth)
        # A second, different delivery of the same payment arrives too.
        deliver(client, captured(failed["amount"]), "evt_mon02")
        db.expire_all()
        invoice = db.get(Invoice, failed["invoiceId"])
        assert invoice.amount_paid == invoice.grand_total

    def test_a_processed_event_cannot_be_replayed(self, client, admin_auth, placed):
        deliver(client, captured(placed["amount"]))
        assert client.post("/api/admin/payments/webhooks/evt_mon01/replay", headers=admin_auth).status_code == 409

    def test_replay_needs_payments_manage(self, client, db, failed):
        from tests.conftest import ADMIN_PASSWORD
        from app.core.security import hash_password
        from app.models import AdminUser
        from datetime import datetime

        db.add(AdminUser(id="ADM009", email="viewer@example.com", password_hash=hash_password(ADMIN_PASSWORD),
                         name="Payments viewer", role="admin", permissions=["payments"], status="active",
                         created_at=datetime(2026, 1, 1)))
        db.flush()
        token = client.post("/api/admin/auth/login", json={"email": "viewer@example.com",
                                                           "password": ADMIN_PASSWORD}).json()["data"]["token"]["accessToken"]
        headers = {"Authorization": f"Bearer {token}"}
        assert client.get("/api/admin/payments/webhooks", headers=headers).status_code == 200
        assert client.post("/api/admin/payments/webhooks/evt_mon01/replay", headers=headers).status_code == 403


class TestTheDashboard:
    def test_list_detail_and_metrics(self, client, admin_auth, placed):
        deliver(client, captured(placed["amount"]))
        deliver(client, captured(placed["amount"]))
        listing = client.get("/api/admin/payments/webhooks", headers=admin_auth).json()["data"]
        assert listing["items"][0]["eventId"] == "evt_mon01"
        assert "payment.captured" in listing["events"]
        found = client.get(f"/api/admin/payments/webhooks?q={placed['order']['orderNumber']}",
                           headers=admin_auth).json()["data"]
        assert found["pagination"]["total"] == 1

        detail = client.get("/api/admin/payments/webhooks/evt_mon01", headers=admin_auth).json()["data"]
        assert detail["attemptLog"][0]["outcome"] == "processed"
        assert detail["orderNumber"] == placed["order"]["orderNumber"]

        metrics = client.get("/api/admin/payments/webhooks/metrics", headers=admin_auth).json()["data"]
        assert metrics["processed"] == 1 and metrics["duplicates"] == 1 and metrics["successRate"] == 100.0

    def test_customers_and_other_roles_are_refused(self, client, auth, editor):
        assert client.get("/api/admin/payments/webhooks", headers=auth).status_code in (401, 403)
        token = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"}
                            ).json()["data"]["token"]["accessToken"]
        assert client.get("/api/admin/payments/webhooks",
                          headers={"Authorization": f"Bearer {token}"}).status_code == 403
