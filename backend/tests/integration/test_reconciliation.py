"""
Payment reconciliation against a stubbed Razorpay.

The gateway is replaced by `FakeGateway`, which answers the three questions
reconciliation asks. Throughout, the rule is checked that a run *records*
what it found and never changes a payment, invoice or order.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest

from app.core import rate_limit
from app.models import Order, Payment, PaymentReconciliation
from app.services import reconciliation
from app.services.payments.razorpay import RazorpayError
from tests.integration.test_payments_razorpay import ADDRESS, razorpay  # noqa: F401

pytestmark = pytest.mark.integration

RUN = "/api/admin/payments/reconciliation/run"


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


class FakeGateway:
    def __init__(self):
        self.payments = []
        self.down = False

    def _check(self):
        if self.down:
            raise RazorpayError("The payment provider could not be reached.")

    def payments_between(self, start, end, limit=2000):
        self._check()
        return [p for p in self.payments if start <= p["created_at"] <= end]

    def payment_entity(self, payment_id):
        self._check()
        for entity in self.payments:
            if entity["id"] == payment_id:
                return entity
        raise RazorpayError("The id provided does not exist", status=400)

    def order_payment_entities(self, order_id):
        self._check()
        return [p for p in self.payments if p.get("order_id") == order_id]


@pytest.fixture()
def gateway(monkeypatch):
    fake = FakeGateway()
    monkeypatch.setattr(reconciliation, "gateway", lambda: fake)
    return fake


@pytest.fixture()
def placed(client, auth, catalogue, settings_documents, razorpay):  # noqa: F811
    razorpay.responses["/orders"] = {"id": "order_rec01"}
    client.post("/api/cart/items", headers=auth, json={"productId": "PRD001", "quantity": 1})
    response = client.post("/api/orders", headers=auth, json={
        "shippingAddress": ADDRESS, "billingAddress": None, "deliveryMethod": "standard",
        "paymentMethod": "card", "couponCode": None, "email": "shopper@example.com", "saveAddress": False,
    })
    assert response.status_code == 201, response.text
    return response.json()["data"]


def utc_today() -> date:
    """
    Today as the API counts days: in UTC (see `payments_monitor._day_range`).

    Not `date.today()`, which is the machine's local date. On a machine in IST
    the two differ from midnight to 05:30, and a run "for today" sent the local
    date missed every payment made in the last few UTC hours of the day before.
    """
    return datetime.utcnow().date()


def now_epoch():
    import calendar

    return calendar.timegm(datetime.utcnow().utctimetuple())


def entity(pay_id="pay_rec01", amount=100000, status="captured", refunded=0, currency="INR",
           order_id="order_rec01", **extra):
    return {"id": pay_id, "order_id": order_id, "amount": amount, "status": status, "currency": currency,
            "amount_refunded": refunded, "method": "upi", "created_at": now_epoch(), "notes": {}, **extra}


def mark_paid(db, placed, transaction="pay_rec01", refunded=0):
    """Settle our side directly, as a completed checkout would have."""
    payment = db.get(Payment, placed["paymentId"])
    payment.status = "paid"
    payment.transaction_id = transaction
    payment.refunded_amount = refunded
    payment.captured_at = datetime.utcnow()
    order = db.get(Order, placed["order"]["id"])
    order.payment_status = "paid"
    db.flush()
    return payment


def run(client, admin_auth):
    today = utc_today().isoformat()
    response = client.post(RUN, headers=admin_auth, json={"from": today, "to": today})
    assert response.status_code == 200, response.text
    return response.json()["data"]


def finding(db, **by):
    db.expire_all()
    return db.query(PaymentReconciliation).filter_by(**by).one()


def snapshot(db, placed):
    """The financial records, to check a run didn't change them."""
    db.expire_all()
    payment = db.get(Payment, placed["paymentId"])
    order = db.get(Order, placed["order"]["id"])
    return (payment.status, payment.amount, payment.refunded_amount, order.status, order.payment_status)


class TestMatching:
    def test_a_payment_that_agrees_is_matched(self, client, db, admin_auth, placed, gateway):
        mark_paid(db, placed)
        gateway.payments = [entity(amount=placed["amount"])]
        result = run(client, admin_auth)
        assert result["counts"]["matched"] == 1
        row = finding(db, payment_id=placed["paymentId"])
        assert row.status == "matched" and row.issues == []
        assert row.gateway_payment_id == "pay_rec01"

    def test_an_unpaid_payment_with_nothing_captured_is_matched(self, client, db, admin_auth, placed, gateway):
        gateway.payments = []
        run(client, admin_auth)
        assert finding(db, payment_id=placed["paymentId"]).status == "matched"


class TestMismatches:
    def test_a_different_amount(self, client, db, admin_auth, placed, gateway):
        mark_paid(db, placed)
        gateway.payments = [entity(amount=placed["amount"] - 100)]
        before = snapshot(db, placed)
        run(client, admin_auth)
        row = finding(db, payment_id=placed["paymentId"])
        assert row.status == "mismatch" and "amount-mismatch" in row.issues
        assert snapshot(db, placed) == before  # nothing financial changed

    def test_a_different_currency(self, client, db, admin_auth, placed, gateway):
        mark_paid(db, placed)
        gateway.payments = [entity(amount=placed["amount"], currency="USD")]
        run(client, admin_auth)
        assert "currency-mismatch" in finding(db, payment_id=placed["paymentId"]).issues

    def test_captured_there_but_not_paid_here(self, client, db, admin_auth, placed, gateway):
        gateway.payments = [entity(amount=placed["amount"])]
        before = snapshot(db, placed)
        run(client, admin_auth)
        row = finding(db, payment_id=placed["paymentId"])
        assert row.status == "mismatch" and "payment-not-reflected" in row.issues
        # Reported, not "fixed": the order is still unpaid.
        assert snapshot(db, placed) == before

    def test_paid_here_but_nothing_at_the_gateway(self, client, db, admin_auth, placed, gateway):
        mark_paid(db, placed)
        gateway.payments = []
        run(client, admin_auth)
        row = finding(db, payment_id=placed["paymentId"])
        assert row.status == "missing-externally" and "missing-at-gateway" in row.issues

    def test_a_captured_payment_we_have_no_record_of(self, client, db, admin_auth, placed, gateway):
        gateway.payments = [entity(pay_id="pay_stranger", order_id="order_unknown", amount=4200)]
        run(client, admin_auth)
        row = finding(db, gateway_payment_id="pay_stranger")
        assert row.status == "missing-locally" and row.payment_id is None and row.amount == 4200

    def test_refunded_amounts_that_differ(self, client, db, admin_auth, placed, gateway):
        mark_paid(db, placed, refunded=0)
        gateway.payments = [entity(amount=placed["amount"], status="refunded", refunded=5000)]
        run(client, admin_auth)
        assert "refund-mismatch" in finding(db, payment_id=placed["paymentId"]).issues

    def test_two_captured_payments_for_one_order(self, client, db, admin_auth, placed, gateway):
        mark_paid(db, placed)
        gateway.payments = [entity(amount=placed["amount"]), entity(pay_id="pay_rec02", amount=placed["amount"])]
        run(client, admin_auth)
        row = finding(db, payment_id=placed["paymentId"])
        assert "duplicate-payment" in row.issues
        assert len(row.gateway["captured"]) == 2

    def test_a_paid_payment_on_an_order_not_marked_paid(self, client, db, admin_auth, placed, gateway):
        mark_paid(db, placed)
        db.get(Order, placed["order"]["id"]).payment_status = "pending"
        db.flush()
        gateway.payments = [entity(amount=placed["amount"])]
        run(client, admin_auth)
        assert "order-not-updated" in finding(db, payment_id=placed["paymentId"]).issues

    def test_a_failed_webhook_needs_review(self, client, db, admin_auth, placed, gateway):
        from app.models import WebhookEvent

        mark_paid(db, placed)
        db.add(WebhookEvent(event_id="evt_broken", event="payment.captured", result="", status="failed",
                            received_at=datetime.utcnow(), payment_id=placed["paymentId"], error="boom"))
        db.flush()
        gateway.payments = [entity(amount=placed["amount"])]
        run(client, admin_auth)
        row = finding(db, payment_id=placed["paymentId"])
        assert row.status == "requires-review" and row.issues == ["webhook-failed"]


class TestEvidence:
    def test_an_unreachable_gateway_is_an_error_not_a_match(self, client, db, admin_auth, placed, gateway):
        gateway.down = True
        today = utc_today().isoformat()
        response = client.post(RUN, headers=admin_auth, json={"from": today, "to": today})
        assert response.status_code == 502
        assert db.query(PaymentReconciliation).count() == 0

    def test_a_payment_that_cannot_be_looked_up_needs_review(self, client, db, admin_auth, placed, gateway,
                                                              monkeypatch):
        mark_paid(db, placed, transaction="pay_elsewhere")
        gateway.payments = []

        def unreachable(payment_id):
            raise RazorpayError("timeout")

        monkeypatch.setattr(gateway, "payment_entity", unreachable)
        run(client, admin_auth)
        row = finding(db, payment_id=placed["paymentId"])
        assert row.status == "requires-review" and row.check_error == "timeout"

    def test_reconciliation_needs_razorpay(self, client, admin_auth):
        today = utc_today().isoformat()
        response = client.post(RUN, headers=admin_auth, json={"from": today, "to": today})
        assert response.status_code == 422
        assert response.json()["error_code"] == "RECONCILIATION_UNAVAILABLE"

    def test_the_range_is_bounded(self, client, admin_auth, gateway):
        start = (utc_today() - timedelta(days=40)).isoformat()
        response = client.post(RUN, headers=admin_auth, json={"from": start, "to": utc_today().isoformat()})
        assert response.status_code == 422


class TestIdempotency:
    def test_running_twice_updates_the_same_row(self, client, db, admin_auth, placed, gateway):
        mark_paid(db, placed)
        gateway.payments = [entity(amount=placed["amount"] - 1)]
        run(client, admin_auth)
        run(client, admin_auth)
        rows = db.query(PaymentReconciliation).all()
        assert len(rows) == 1
        assert rows[0].check_count == 2
        # One "checked" event for the finding; the unchanged re-run adds none.
        assert [e.action for e in rows[0].events] == ["checked"]

    def test_a_resolved_finding_stays_resolved_while_the_evidence_is_the_same(self, client, db, admin_auth,
                                                                               placed, gateway):
        mark_paid(db, placed)
        gateway.payments = [entity(amount=placed["amount"] - 1)]
        run(client, admin_auth)
        row_id = finding(db, payment_id=placed["paymentId"]).id
        resolved = client.post(f"/api/admin/payments/reconciliation/{row_id}/resolve", headers=admin_auth,
                               json={"note": "Customer paid ₹1 less; approved by finance."})
        assert resolved.status_code == 200, resolved.text
        run(client, admin_auth)
        assert finding(db, id=row_id).resolution == "resolved"

        # New evidence reopens it.
        gateway.payments = [entity(amount=placed["amount"] - 1, currency="USD")]
        run(client, admin_auth)
        assert finding(db, id=row_id).resolution == "open"


class TestResolution:
    @pytest.fixture()
    def mismatch(self, client, db, admin_auth, placed, gateway):
        mark_paid(db, placed)
        gateway.payments = [entity(amount=placed["amount"] - 1)]
        run(client, admin_auth)
        return finding(db, payment_id=placed["paymentId"]).id

    def test_resolving_needs_a_note_and_changes_no_money(self, client, db, admin_auth, placed, mismatch):
        before = snapshot(db, placed)
        url = f"/api/admin/payments/reconciliation/{mismatch}/resolve"
        assert client.post(url, headers=admin_auth, json={"note": ""}).status_code == 422
        response = client.post(url, headers=admin_auth, json={"note": "Checked with the bank statement."})
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["resolution"] == "resolved" and data["status"] == "mismatch"
        assert data["events"][-1]["action"] == "resolved" and data["events"][-1]["adminName"] == "Manoj Rajan"
        assert snapshot(db, placed) == before

    def test_reopening(self, client, admin_auth, mismatch):
        base = f"/api/admin/payments/reconciliation/{mismatch}"
        client.post(f"{base}/resolve", headers=admin_auth, json={"note": "Looked fine at first."})
        response = client.post(f"{base}/reopen", headers=admin_auth, json={"note": "Finance disagrees."})
        assert response.json()["data"]["resolution"] == "open"

    def test_recheck_asks_the_gateway_again(self, client, db, admin_auth, placed, gateway, mismatch):
        gateway.payments = [entity(amount=placed["amount"])]
        response = client.post(f"/api/admin/payments/reconciliation/{mismatch}/recheck", headers=admin_auth)
        assert response.status_code == 200
        assert response.json()["data"]["status"] == "matched"

    def test_the_list_and_detail(self, client, admin_auth, mismatch):
        listing = client.get("/api/admin/payments/reconciliation?status=issues", headers=admin_auth).json()["data"]
        assert listing["pagination"]["total"] == 1
        assert listing["open"]["mismatch"] == 1
        detail = client.get(f"/api/admin/payments/reconciliation/{mismatch}", headers=admin_auth).json()["data"]
        assert detail["local"]["paymentId"] and detail["gateway"]["id"] == "pay_rec01"

    def test_the_gateway_snapshot_keeps_no_personal_details(self, client, db, admin_auth, placed, gateway):
        mark_paid(db, placed)
        gateway.payments = [entity(amount=placed["amount"], email="shopper@example.com", contact="+919876500001",
                                   vpa="asha@okhdfc")]
        run(client, admin_auth)
        kept = str(finding(db, payment_id=placed["paymentId"]).gateway)
        assert "shopper@example.com" not in kept and "9876500001" not in kept and "asha" not in kept

    def test_permissions(self, client, db, gateway, mismatch):
        from datetime import datetime as dt

        from app.core.security import hash_password
        from app.models import AdminUser
        from tests.conftest import ADMIN_PASSWORD

        db.add(AdminUser(id="ADM010", email="viewer2@example.com", password_hash=hash_password(ADMIN_PASSWORD),
                         name="Viewer", role="admin", permissions=["payments"], status="active",
                         created_at=dt(2026, 1, 1)))
        db.flush()
        token = client.post("/api/admin/auth/login", json={"email": "viewer2@example.com",
                                                           "password": ADMIN_PASSWORD}).json()["data"]["token"]["accessToken"]
        headers = {"Authorization": f"Bearer {token}"}
        assert client.get("/api/admin/payments/reconciliation", headers=headers).status_code == 200
        today = utc_today().isoformat()
        assert client.post(RUN, headers=headers, json={"from": today, "to": today}).status_code == 403
        assert client.post(f"/api/admin/payments/reconciliation/{mismatch}/resolve", headers=headers,
                           json={"note": "Trying to close it."}).status_code == 403
