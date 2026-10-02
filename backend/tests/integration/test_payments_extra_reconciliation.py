"""
Reconciliation, beyond the main suite: rechecking each kind of finding, the
refusals on resolve and reopen, the list filters, and gateway payments that are
not store payments at all.

The gateway is `FakeGateway` from `test_reconciliation`, which answers the
three questions reconciliation asks. A run records what it found and never
changes a payment; the checks below hold it to that.
"""

from __future__ import annotations

import calendar
from datetime import datetime, timedelta

import pytest

import app.main  # noqa: F401 -- import the app before any fixture patches `get_provider`
from app.core import rate_limit
from app.models import Order, Payment, PaymentReconciliation
from app.services import reconciliation
from app.services.payments.razorpay import RazorpayError
from tests.integration.test_payments_razorpay import razorpay  # noqa: F401 -- fixture
from tests.integration.test_reconciliation import (
    RUN,
    FakeGateway,
    entity,
    finding,
    mark_paid,
    run,
    utc_today,
)
from tests.integration.test_reconciliation import placed as placed  # noqa: F401 -- fixture

pytestmark = pytest.mark.integration

BASE = "/api/admin/payments/reconciliation"


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def gateway(monkeypatch):
    fake = FakeGateway()
    monkeypatch.setattr(reconciliation, "gateway", lambda: fake)
    return fake


def epoch(moment: datetime) -> int:
    return calendar.timegm(moment.utctimetuple())


class TestTheGatewaySeam:
    def test_with_razorpay_active_the_provider_is_the_gateway(self, razorpay):  # noqa: F811
        assert reconciliation.gateway() is razorpay

    def test_a_range_that_runs_backwards(self, client, admin_auth, gateway):
        today = utc_today()
        response = client.post(RUN, headers=admin_auth, json={
            "from": today.isoformat(), "to": (today - timedelta(days=1)).isoformat()})
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_RANGE"
        listing = client.get(BASE, headers=admin_auth, params={
            "from": today.isoformat(), "to": (today - timedelta(days=2)).isoformat()})
        assert listing.status_code == 422

    def test_the_service_refuses_an_empty_range(self, db, gateway):
        from app.core.errors import ValidationError

        now = datetime.utcnow()
        with pytest.raises(ValidationError):
            reconciliation.run(db, now, now)


class TestPaymentsThatAreNotTheStores:
    def test_membership_gift_card_and_out_of_range_payments_are_not_flagged(self, client, db, admin_auth, gateway):
        long_ago = epoch(datetime.utcnow() - timedelta(days=3))
        gateway.payments = [
            entity(pay_id="pay_mem", order_id="order_m", notes={"membershipId": "MEM1"}),
            entity(pay_id="pay_gift", order_id="order_g", notes={"giftCardId": "7"}),
            entity(pay_id="pay_old", order_id="order_o"),
        ]
        gateway.payments[2]["created_at"] = long_ago
        # The listing asks for a little either side of the range; keep the old one inside that window.
        real = gateway.payments_between
        gateway.payments_between = lambda start, end, limit=2000: real(0, end, limit)

        result = run(client, admin_auth)

        assert result["checked"] == 0 and db.query(PaymentReconciliation).count() == 0

    def test_an_order_marked_paid_with_no_payment_behind_it(self, client, db, admin_auth, gateway, placed):
        mark_paid(db, placed)
        db.delete(db.get(Payment, placed["paymentId"]))
        db.flush()

        result = run(client, admin_auth)

        assert result["counts"].get("matched", 0) == 0
        row = finding(db, order_id=placed["order"]["id"])
        assert row.issues == ["paid-without-payment"] and row.payment_id is None

        # Rechecking it looks at the order again; once it is not marked paid the issue is gone.
        db.get(Order, placed["order"]["id"]).payment_status = "pending"
        db.flush()
        rechecked = client.post(f"{BASE}/{row.id}/recheck", headers=admin_auth)
        assert rechecked.status_code == 200 and rechecked.json()["data"]["issues"] == []


class TestRechecking:
    def test_a_gateway_payment_we_had_no_record_of(self, client, db, admin_auth, gateway):
        gateway.payments = [entity(pay_id="pay_orphan", order_id="order_orphan", amount=4200)]
        run(client, admin_auth)
        row_id = finding(db, gateway_payment_id="pay_orphan").id

        # Still captured, still nobody's.
        again = client.post(f"{BASE}/{row_id}/recheck", headers=admin_auth).json()["data"]
        assert again["status"] == "missing-locally"

        # The gateway now reports it failed: no money moved, nothing to account for.
        gateway.payments[0]["status"] = "failed"
        failed = client.post(f"{BASE}/{row_id}/recheck", headers=admin_auth).json()["data"]
        assert failed["issues"] == []

    def test_a_gateway_payment_that_turns_out_to_be_ours(self, client, db, admin_auth, gateway, placed):
        gateway.payments = [entity(pay_id="pay_later", order_id="order_unrelated", amount=placed["amount"])]
        run(client, admin_auth)
        row = finding(db, gateway_payment_id="pay_later")
        mark_paid(db, placed, transaction="pay_later")

        response = client.post(f"{BASE}/{row.id}/recheck", headers=admin_auth)

        assert response.status_code == 200
        assert response.json()["data"]["paymentId"] == placed["paymentId"]

    def test_the_gateway_down_on_recheck(self, client, db, admin_auth, gateway):
        gateway.payments = [entity(pay_id="pay_down", order_id="order_down")]
        run(client, admin_auth)
        row_id = finding(db, gateway_payment_id="pay_down").id
        gateway.down = True

        response = client.post(f"{BASE}/{row_id}/recheck", headers=admin_auth)

        assert response.status_code == 502 and response.json()["error_code"] == "GATEWAY_UNAVAILABLE"

    def test_nothing_left_to_check_against(self, client, db, admin_auth, gateway):
        now = datetime.utcnow()
        row = PaymentReconciliation(created_at=now, updated_at=now, checked_at=now, check_count=1,
                                    resolution="open", resolution_note="", status="mismatch", issues=[],
                                    summary="", order_number="")
        db.add(row)
        db.flush()

        response = client.post(f"{BASE}/{row.id}/recheck", headers=admin_auth)

        assert response.status_code == 422 and response.json()["error_code"] == "NOTHING_TO_CHECK"

    def test_a_missing_finding(self, client, admin_auth, gateway):
        response = client.get(f"{BASE}/999999", headers=admin_auth)
        assert response.status_code == 404 and response.json()["error_code"] == "RECONCILIATION_NOT_FOUND"

    def test_an_order_lookup_that_fails_with_a_real_error_is_raised(self, db, gateway, placed, monkeypatch):
        """Not-found means 'no such payment'; anything else must not be read as one."""
        mark_paid(db, placed, transaction="pay_elsewhere")

        def broken(payment_id):
            raise RazorpayError("Bad gateway", status=502)

        monkeypatch.setattr(gateway, "payment_entity", broken)
        payment = db.get(Payment, placed["paymentId"])
        with pytest.raises(RazorpayError):
            reconciliation._entities_for(gateway, payment, {})


class TestResolvingAndReopening:
    @pytest.fixture()
    def matched(self, client, db, admin_auth, gateway, placed):
        mark_paid(db, placed)
        gateway.payments = [entity(amount=placed["amount"])]
        run(client, admin_auth)
        return finding(db, payment_id=placed["paymentId"]).id

    @pytest.fixture()
    def mismatch(self, client, db, admin_auth, gateway, placed):
        mark_paid(db, placed)
        gateway.payments = [entity(amount=placed["amount"] - 1)]
        run(client, admin_auth)
        return finding(db, payment_id=placed["paymentId"]).id

    def test_a_match_has_nothing_to_resolve(self, client, admin_auth, matched):
        response = client.post(f"{BASE}/{matched}/resolve", headers=admin_auth, json={"note": "Looks right to me."})
        assert response.status_code == 422 and response.json()["error_code"] == "NOTHING_TO_RESOLVE"

    def test_resolved_once_and_reopened_once(self, client, admin_auth, mismatch):
        note = {"note": "Checked against the statement."}
        assert client.post(f"{BASE}/{mismatch}/reopen", headers=admin_auth,
                           json=note).json()["error_code"] == "NOT_RESOLVED"
        assert client.post(f"{BASE}/{mismatch}/resolve", headers=admin_auth, json=note).status_code == 200
        twice = client.post(f"{BASE}/{mismatch}/resolve", headers=admin_auth, json=note)
        assert twice.status_code == 422 and twice.json()["error_code"] == "ALREADY_RESOLVED"
        reopened = client.post(f"{BASE}/{mismatch}/reopen", headers=admin_auth, json=note)
        assert reopened.status_code == 200 and reopened.json()["message"] == "Reopened."

    def test_the_list_filters(self, client, db, admin_auth, mismatch, placed):
        def total(**params):
            response = client.get(BASE, headers=admin_auth, params=params)
            assert response.status_code == 200, response.text
            return response.json()["data"]["pagination"]["total"]

        today = utc_today().isoformat()
        assert total() == 1
        assert total(status="mismatch", resolution="open") == 1
        assert total(status="matched") == 0
        assert total(resolution="resolved") == 0
        assert total(**{"from": today, "to": today}) == 1
        assert total(q=placed["paymentId"]) == 1
        assert total(q="pay_rec01") == 1
        assert total(q=placed["order"]["orderNumber"]) == 1
        assert total(q="nothing-like-it") == 0
