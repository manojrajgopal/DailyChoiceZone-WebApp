"""
Partial refunds: `app/api/routes/refunds.py` and `app/services/refunds.py`.

The order context and calculation (cumulative line shares, the limits and
their error codes), raising a refund (idempotency, approval threshold,
store credit), approving / rejecting / cancelling / retrying, the portal
list, summary and settings, and the customer's view.
"""

from __future__ import annotations

from datetime import datetime

import pytest
from sqlalchemy import text

from app.core import rate_limit
from app.core.security import create_access_token, hash_password
from app.models import AdminUser, AuditLog, Payment, Refund, SettingDocument
from app.services import store_credit
from app.services.payments.base import RefundResult
from app.services.payments.mock import MockPaymentProvider
from tests.integration.wallet_helpers import fill_bag, mailbox, place  # noqa: F401

pytestmark = pytest.mark.integration

BASE = "/api/admin/refunds"


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def manager_auth(db):
    """`refunds` through the manager role, but not `refunds-large`."""
    db.add(AdminUser(id="ADM030", email="refund.manager@example.com", password_hash=hash_password("Admin@123"),
                     name="Refund Manager", role="manager", permissions=[], status="active",
                     created_at=datetime(2026, 1, 1)))
    db.flush()
    return {"Authorization": "Bearer " + create_access_token("ADM030", actor="admin", role="manager")}


@pytest.fixture()
def staff_auth(db):
    """No `refunds` at all."""
    db.add(AdminUser(id="ADM031", email="packer@example.com", password_hash=hash_password("Admin@123"),
                     name="Packer", role="staff", permissions=[], status="active", created_at=datetime(2026, 1, 1)))
    db.flush()
    return {"Authorization": "Bearer " + create_access_token("ADM031", actor="admin", role="staff")}


@pytest.fixture()
def seven(client, auth, catalogue, settings_documents, coupon, mailbox):  # noqa: F811
    """Seven kurtas with SAVE10: a line of ₹6,500 that 7 doesn't divide (paise)."""
    fill_bag(client, auth, "PRD001", 7)
    return place(client, auth, coupon="SAVE10")


@pytest.fixture()
def shipped(client, auth, db, catalogue, settings_documents, mailbox):  # noqa: F811
    """One kurta and one shirt, with the ₹79 delivery fee charged."""
    store = db.get(SettingDocument, "store")
    store.value = {"shipping": {"freeDeliveryThreshold": 100000, "standardFee": 79, "expressFee": 149}}
    db.flush()
    fill_bag(client, auth, "PRD001", 1)
    fill_bag(client, auth, "PRD002", 1)
    return place(client, auth)


def oid(placed) -> str:
    return placed["order"]["id"]


def context(client, headers, order_id) -> dict:
    response = client.get(f"{BASE}/orders/{order_id}", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def item_ids(client, headers, order_id) -> list:
    return [line["orderItemId"] for line in context(client, headers, order_id)["breakdown"]["lines"]]


def calc(client, headers, order_id, **body):
    return client.post(f"{BASE}/orders/{order_id}/calculate", headers=headers, json=body)


def create(client, headers, order_id, key, **body):
    payload = {"idempotencyKey": key, "reasonCode": "damaged", **body}
    return client.post(f"{BASE}/orders/{order_id}", headers=headers, json=payload)


def error_code(response) -> str:
    return response.json().get("error_code")


def actions(db, resource_id) -> list:
    return [row.action for row in db.query(AuditLog).filter(AuditLog.resource_type == "refund",
                                                              AuditLog.resource_id == resource_id)
            .order_by(AuditLog.id)]


def gateway_declines(monkeypatch, reason="Refunds are paused on this account."):
    monkeypatch.setattr(MockPaymentProvider, "refund", lambda self, *a, **k: RefundResult(
        ok=False, reference="", status="rejected", failure_reason=reason))


def low_threshold(client, admin_auth, rupees=500):
    response = client.put(f"{BASE}/settings", headers=admin_auth, json={"approvalThreshold": rupees})
    assert response.status_code == 200, response.text


# ------------------------------------------------------------ the context


class TestContextAndCalculation:
    def test_the_order_context_shows_everything_left(self, client, admin_auth, seven):
        data = context(client, admin_auth, oid(seven))
        b = data["breakdown"]
        assert data["refunds"] == []
        assert b["orderId"] == oid(seven) and b["invoiceId"] == seven["invoiceId"]
        assert b["paid"]["total"] == 650000 and b["remaining"] == 650000 and b["refunded"] == 0
        (line,) = b["lines"]
        assert (line["ordered"], line["refunded"], line["refundable"], line["quantity"]) == (7, 0, 7, 0)
        assert line["lineTotal"] == 650000 and line["remainingAmount"] == 650000
        assert line["lineDiscount"] == 50000
        assert b["totals"]["total"] == 0 and b["fullRefund"] is False
        assert b["method"] == "original" and b["allowedMethods"] == ["original", "store-credit"]
        assert b["approvalThreshold"] == 1_000_000 and b["requiresApproval"] is False

    def test_the_context_is_found_by_order_number_too(self, client, admin_auth, seven):
        number = seven["order"]["orderNumber"]
        assert context(client, admin_auth, number)["breakdown"]["orderId"] == oid(seven)

    def test_an_unknown_order(self, client, admin_auth, catalogue):
        response = client.get(f"{BASE}/orders/ORD-NOPE", headers=admin_auth)
        assert response.status_code == 404 and error_code(response) == "ORDER_NOT_FOUND"

    def test_shares_are_cumulative_so_partial_refunds_add_up_to_the_line(self, client, admin_auth, db, seven):
        order_id = oid(seven)
        (item,) = item_ids(client, admin_auth, order_id)
        line = context(client, admin_auth, order_id)["breakdown"]["lines"][0]
        amounts, taxes = [], []
        for n, quantity in enumerate((2, 2, 3)):
            preview = calc(client, admin_auth, order_id, lines=[{"orderItemId": item, "quantity": quantity}])
            assert preview.status_code == 200, preview.text
            shown = preview.json()["data"]["lines"][0]
            made = create(client, admin_auth, order_id, f"cumulative-{n}",
                          lines=[{"orderItemId": item, "quantity": quantity}])
            assert made.status_code == 201, made.text
            refund = made.json()["data"]
            assert refund["status"] == "completed"
            # What was shown is what was refunded.
            assert refund["amount"] == shown["amount"] and refund["items"][0]["tax"] == shown["tax"]
            amounts.append(refund["amount"])
            taxes.append(refund["items"][0]["tax"])
        # 650000 × 2 ÷ 7 = 185714 (rounded down); the next two = 371428 − 185714; the last takes the rest.
        assert amounts == [185714, 185714, 278572]
        assert sum(amounts) == line["lineTotal"] == 650000
        assert sum(taxes) == line["lineTax"]
        after = context(client, admin_auth, order_id)["breakdown"]
        assert after["remaining"] == 0 and after["lines"][0]["refundable"] == 0
        assert after["lines"][0]["refunded"] == 7 and after["lines"][0]["remainingAmount"] == 0
        assert db.get(Payment, seven["paymentId"]).status == "refunded"

    def test_a_quantity_beyond_what_is_refundable(self, client, admin_auth, seven):
        (item,) = item_ids(client, admin_auth, oid(seven))
        response = calc(client, admin_auth, oid(seven), lines=[{"orderItemId": item, "quantity": 8}])
        assert response.status_code == 422 and error_code(response) == "QUANTITY_EXCEEDS_REFUNDABLE"
        assert response.json()["details"]["refundable"] == 7

    def test_refunded_units_are_no_longer_refundable(self, client, admin_auth, seven):
        (item,) = item_ids(client, admin_auth, oid(seven))
        assert create(client, admin_auth, oid(seven), "first-five",
                      lines=[{"orderItemId": item, "quantity": 5}]).status_code == 201
        response = calc(client, admin_auth, oid(seven), lines=[{"orderItemId": item, "quantity": 3}])
        assert response.status_code == 422 and error_code(response) == "QUANTITY_EXCEEDS_REFUNDABLE"
        assert response.json()["details"]["refundable"] == 2

    def test_an_item_from_another_order(self, client, admin_auth, seven):
        response = calc(client, admin_auth, oid(seven), lines=[{"orderItemId": 987654, "quantity": 1}])
        assert response.status_code == 422 and error_code(response) == "ITEM_NOT_IN_ORDER"
        assert response.json()["details"]["orderItemIds"] == [987654]

    def test_a_line_listed_twice(self, client, admin_auth, seven):
        (item,) = item_ids(client, admin_auth, oid(seven))
        response = calc(client, admin_auth, oid(seven), lines=[{"orderItemId": item, "quantity": 1},
                                                               {"orderItemId": item, "quantity": 1}])
        assert response.status_code == 422 and error_code(response) == "DUPLICATE_LINE"

    def test_more_than_is_left_on_the_order(self, client, admin_auth, seven):
        response = calc(client, admin_auth, oid(seven), adjustmentAmount=650001)
        assert response.status_code == 409 and error_code(response) == "REFUND_EXCEEDS_PAYMENT"
        assert response.json()["details"] == {"remaining": 650000, "total": 650001}

    def test_waiting_refunds_count_against_what_is_left(self, client, admin_auth, manager_auth, seven):
        low_threshold(client, admin_auth)
        assert create(client, manager_auth, oid(seven), "waits-0001",
                      adjustmentAmount=600000).json()["data"]["status"] == "requested"
        response = calc(client, admin_auth, oid(seven), adjustmentAmount=60000)
        assert response.status_code == 409 and error_code(response) == "REFUND_EXCEEDS_PAYMENT"
        assert response.json()["details"]["remaining"] == 50000

    def test_shipping_limits(self, client, admin_auth, shipped):
        b = context(client, admin_auth, oid(shipped))["breakdown"]
        assert b["shipping"] == {"charged": 7900, "refunded": 0, "refundable": 7900, "amount": 0}
        too_much = calc(client, admin_auth, oid(shipped), shippingAmount=7901)
        assert too_much.status_code == 422 and error_code(too_much) == "SHIPPING_EXCEEDS_REFUNDABLE"
        assert too_much.json()["details"]["refundable"] == 7900
        assert create(client, admin_auth, oid(shipped), "ship-part", shippingAmount=5000).status_code == 201
        after = context(client, admin_auth, oid(shipped))["breakdown"]["shipping"]
        assert (after["refunded"], after["refundable"]) == (5000, 2900)
        again = calc(client, admin_auth, oid(shipped), shippingAmount=3000)
        assert again.status_code == 422 and error_code(again) == "SHIPPING_EXCEEDS_REFUNDABLE"
        ok = calc(client, admin_auth, oid(shipped), includeShipping=True).json()["data"]
        assert ok["shipping"]["amount"] == 2900 and ok["totals"]["total"] == 2900

    def test_a_full_refund_takes_every_unit_and_the_delivery_fee(self, client, admin_auth, shipped):
        data = calc(client, admin_auth, oid(shipped), fullRefund=True).json()["data"]
        assert [line["quantity"] for line in data["lines"]] == [1, 1]
        assert data["totals"]["items"] == 300000 and data["totals"]["shipping"] == 7900
        assert data["totals"]["total"] == 307900 == data["remaining"] and data["fullRefund"] is True

    def test_a_cancelled_order_has_nothing_refundable(self, client, auth, admin_auth, seven):
        response = client.post(f"/api/orders/{oid(seven)}/cancel", headers=auth, json={"reason": "No longer needed"})
        assert response.status_code == 200, response.text
        b = context(client, admin_auth, oid(seven))["breakdown"]
        line = b["lines"][0]
        assert b["orderStatus"] == "cancelled"
        assert (line["cancelled"], line["refundable"]) == (7, 0) and b["shipping"]["refundable"] == 0
        # Asking for a unit (or the delivery) of a cancelled order says why, not "only 0 left".
        response = calc(client, admin_auth, oid(seven), lines=[{"orderItemId": line["orderItemId"], "quantity": 1}])
        assert response.status_code == 409 and error_code(response) == "ORDER_CANCELLED"
        response = calc(client, admin_auth, oid(seven), includeShipping=True)
        assert response.status_code == 409 and error_code(response) == "ORDER_CANCELLED"

    def test_an_order_without_an_invoice(self, client, admin_auth, db, seven):
        db.flush()
        db.execute(text("SET FOREIGN_KEY_CHECKS = 0"))
        try:
            db.execute(text("DELETE FROM invoices WHERE id = :id"), {"id": seven["invoiceId"]})
        finally:
            db.execute(text("SET FOREIGN_KEY_CHECKS = 1"))
        db.expire_all()
        response = calc(client, admin_auth, oid(seven))
        assert response.status_code == 409 and error_code(response) == "NO_INVOICE"

    def test_the_portal_needs_refunds(self, client, staff_auth, seven):
        assert client.get(f"{BASE}/orders/{oid(seven)}", headers=staff_auth).status_code == 403
        assert client.get(BASE, headers=staff_auth).status_code == 403
        assert create(client, staff_auth, oid(seven), "staff-0001", adjustmentAmount=100).status_code == 403


# --------------------------------------------------------------- creating


class TestCreating:
    def test_the_same_key_twice_makes_one_refund(self, client, admin_auth, db, seven):
        (item,) = item_ids(client, admin_auth, oid(seven))
        body = {"lines": [{"orderItemId": item, "quantity": 1}], "reason": "Torn seam"}
        first = create(client, admin_auth, oid(seven), "double-click-1", **body)
        second = create(client, admin_auth, oid(seven), "double-click-1", **body)
        assert first.status_code == second.status_code == 201
        assert first.json()["data"]["id"] == second.json()["data"]["id"]
        assert db.query(Refund).filter(Refund.order_id == oid(seven)).count() == 1
        assert context(client, admin_auth, oid(seven))["breakdown"]["lines"][0]["refunded"] == 1

    def test_a_key_reused_on_another_order(self, client, auth, admin_auth, seven):
        assert create(client, admin_auth, oid(seven), "shared-key-1", adjustmentAmount=100).status_code == 201
        fill_bag(client, auth, "PRD002", 1)
        other = place(client, auth)
        response = create(client, admin_auth, oid(other), "shared-key-1", adjustmentAmount=100)
        assert response.status_code == 409 and error_code(response) == "IDEMPOTENCY_KEY_REUSED"

    def test_the_refund_records_its_lines_and_reason(self, client, admin_auth, db, seven):
        (item,) = item_ids(client, admin_auth, oid(seven))
        response = create(client, admin_auth, oid(seven), "recorded-01", lines=[{"orderItemId": item, "quantity": 1}],
                          internalNote="Checked the photos", manualReference="")
        assert response.status_code == 201, response.text
        assert response.json()["message"] == "Refund completed."
        data = response.json()["data"]
        assert data["reasonCode"] == "damaged" and data["reason"] == "Arrived damaged"
        assert data["internalNote"] == "Checked the photos" and data["initiatedBy"] == "ADM001"
        assert data["gatewayReference"].startswith("RFND")
        assert data["items"][0]["orderItemId"] == item and data["items"][0]["quantity"] == 1
        assert data["amount"] == 650000 // 7
        payment = db.get(Payment, seven["paymentId"])
        assert payment.status == "partially-refunded" and payment.refunded_amount == 650000 // 7
        assert actions(db, data["id"]) == ["refund.created"]

    @pytest.mark.parametrize("body, code", [
        ({}, "NOTHING_SELECTED"),
        ({"adjustmentAmount": 100, "reasonCode": "because"}, "INVALID_REASON_CODE"),
    ])
    def test_bad_requests(self, client, admin_auth, seven, body, code):
        payload = {"idempotencyKey": "bad-request-1", "reasonCode": "other", **body}
        response = client.post(f"{BASE}/orders/{oid(seven)}", headers=admin_auth, json=payload)
        assert response.status_code == 422 and error_code(response) == code

    def test_a_short_idempotency_key_is_refused(self, client, admin_auth, seven):
        response = create(client, admin_auth, oid(seven), "short", adjustmentAmount=100)
        assert response.status_code == 422

    def test_a_method_the_settings_dont_allow(self, client, admin_auth, seven):
        assert client.put(f"{BASE}/settings", headers=admin_auth,
                          json={"allowedMethods": ["original"]}).status_code == 200
        response = create(client, admin_auth, oid(seven), "credit-off-1", adjustmentAmount=100,
                          method="store-credit")
        assert response.status_code == 422 and error_code(response) == "METHOD_NOT_ALLOWED"
        assert response.json()["details"]["allowed"] == ["original"]

    def test_store_credit_credits_the_wallet(self, client, auth, admin_auth, db, seven):
        (item,) = item_ids(client, admin_auth, oid(seven))
        response = create(client, admin_auth, oid(seven), "to-wallet-1", method="store-credit",
                          lines=[{"orderItemId": item, "quantity": 2}])
        assert response.status_code == 201, response.text
        data = response.json()["data"]
        assert (data["status"], data["method"], data["amount"]) == ("completed", "store-credit", 185714)
        db.expire_all()
        assert store_credit.balance(db, "CUS001") == 185714
        # The gateway never saw it: the payment's own refunded amount is untouched.
        assert db.get(Payment, seven["paymentId"]).refunded_amount == 0
        mine = client.get("/api/account/store-credit", headers=auth).json()["data"]
        assert mine["balance"] == 1857.14
        assert context(client, admin_auth, oid(seven))["breakdown"]["remaining"] == 650000 - 185714


# ---------------------------------------------------------------- approval


class TestApproval:
    def test_over_the_threshold_without_refunds_large_waits(self, client, admin_auth, manager_auth, db, seven):
        low_threshold(client, admin_auth)
        (item,) = item_ids(client, manager_auth, oid(seven))
        preview = calc(client, manager_auth, oid(seven), lines=[{"orderItemId": item, "quantity": 1}]).json()["data"]
        assert preview["approvalThreshold"] == 50000 and preview["requiresApproval"] is True
        response = create(client, manager_auth, oid(seven), "big-one-01", lines=[{"orderItemId": item, "quantity": 1}])
        assert response.status_code == 201, response.text
        data = response.json()["data"]
        assert (data["status"], data["requiresApproval"]) == ("requested", True)
        assert response.json()["message"] == "Refund recorded; it needs approval before it is sent."
        assert db.get(Payment, seven["paymentId"]).refunded_amount == 0

    def test_under_the_threshold_a_manager_refunds_at_once(self, client, admin_auth, manager_auth, seven):
        low_threshold(client, admin_auth)
        response = create(client, manager_auth, oid(seven), "small-one1", adjustmentAmount=50000)
        assert response.json()["data"]["status"] == "completed"
        assert response.json()["data"]["requiresApproval"] is False

    def test_a_refunds_large_admin_is_not_held(self, client, admin_auth, seven):
        low_threshold(client, admin_auth)
        response = create(client, admin_auth, oid(seven), "big-by-root", adjustmentAmount=60000)
        assert response.json()["data"]["status"] == "completed"
        assert response.json()["data"]["requiresApproval"] is False

    def test_approving_needs_refunds_large(self, client, admin_auth, manager_auth, db, seven):
        low_threshold(client, admin_auth)
        refund = create(client, manager_auth, oid(seven), "approve-me", adjustmentAmount=60000).json()["data"]
        denied = client.post(f"{BASE}/{refund['id']}/approve", headers=manager_auth)
        assert denied.status_code == 403 and error_code(denied) == "PERMISSION_DENIED"
        approved = client.post(f"{BASE}/{refund['id']}/approve", headers=admin_auth)
        assert approved.status_code == 200, approved.text
        data = approved.json()["data"]
        assert data["status"] == "completed" and data["approvedBy"] == "ADM001" and data["approvedAt"]
        assert db.get(Payment, seven["paymentId"]).refunded_amount == 60000
        assert actions(db, refund["id"]) == ["refund.created", "refund.approved"]
        again = client.post(f"{BASE}/{refund['id']}/approve", headers=admin_auth)
        assert again.status_code == 409 and error_code(again) == "INVALID_TRANSITION"

    def test_rejecting(self, client, admin_auth, manager_auth, db, seven):
        low_threshold(client, admin_auth)
        refund = create(client, manager_auth, oid(seven), "reject-me1", adjustmentAmount=60000,
                        internalNote="Customer insists").json()["data"]
        denied = client.post(f"{BASE}/{refund['id']}/reject", headers=manager_auth, json={"note": "no"})
        assert denied.status_code == 403
        response = client.post(f"{BASE}/{refund['id']}/reject", headers=admin_auth, json={"note": "Not eligible"})
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["status"] == "rejected"
        assert data["internalNote"] == "Customer insists\nRejected: Not eligible"
        assert db.get(Payment, seven["paymentId"]).refunded_amount == 0
        # A rejected refund holds no money: the whole order is refundable again.
        assert context(client, admin_auth, oid(seven))["breakdown"]["remaining"] == 650000
        assert actions(db, refund["id"]) == ["refund.created", "refund.rejected"]

    def test_cancelling_a_requested_refund(self, client, admin_auth, manager_auth, db, seven):
        low_threshold(client, admin_auth)
        refund = create(client, manager_auth, oid(seven), "cancel-me1", adjustmentAmount=60000).json()["data"]
        response = client.post(f"{BASE}/{refund['id']}/cancel", headers=admin_auth, json={"note": "Raised twice"})
        assert response.status_code == 200, response.text
        assert response.json()["data"]["status"] == "cancelled"
        assert response.json()["data"]["internalNote"] == "Cancelled: Raised twice"
        assert actions(db, refund["id"]) == ["refund.created", "refund.cancelled"]
        again = client.post(f"{BASE}/{refund['id']}/cancel", headers=admin_auth, json={})
        assert again.status_code == 409 and error_code(again) == "INVALID_TRANSITION"

    def test_a_refund_awaiting_approval_is_withdrawn_only_by_its_raiser_or_a_manager(
            self, client, db, admin_auth, manager_auth, seven):
        low_threshold(client, admin_auth)
        refund = create(client, manager_auth, oid(seven), "withdraw-01", adjustmentAmount=60000).json()["data"]
        assert refund["requiresApproval"] is True
        # Another admin with `refunds` but not `refunds-large` can't withdraw it.
        db.add(AdminUser(id="ADM032", email="other.manager@example.com", password_hash=hash_password("Admin@123"),
                         name="Other Manager", role="manager", permissions=[], status="active",
                         created_at=datetime(2026, 1, 1)))
        db.flush()
        other_auth = {"Authorization": "Bearer " + create_access_token("ADM032", actor="admin", role="manager")}
        refused = client.post(f"{BASE}/{refund['id']}/cancel", headers=other_auth, json={})
        assert refused.status_code == 403 and error_code(refused) == "PERMISSION_DENIED"
        # The manager who raised it can take it back.
        response = client.post(f"{BASE}/{refund['id']}/cancel", headers=manager_auth, json={"note": "Raised in error"})
        assert response.status_code == 200 and response.json()["data"]["status"] == "cancelled"

    def test_a_completed_refund_cant_be_cancelled_or_rejected(self, client, admin_auth, seven):
        refund = create(client, admin_auth, oid(seven), "done-done1", adjustmentAmount=100).json()["data"]
        for action in ("cancel", "reject"):
            response = client.post(f"{BASE}/{refund['id']}/{action}", headers=admin_auth, json={})
            assert response.status_code == 409 and error_code(response) == "INVALID_TRANSITION"
        retry = client.post(f"{BASE}/{refund['id']}/retry", headers=admin_auth)
        assert retry.status_code == 409 and error_code(retry) == "INVALID_TRANSITION"

    def test_an_unknown_refund(self, client, admin_auth, catalogue):
        assert client.get(f"{BASE}/RFD-NOPE", headers=admin_auth).status_code == 404
        assert client.post(f"{BASE}/RFD-NOPE/approve", headers=admin_auth).status_code == 404


# ----------------------------------------------------------------- retrying


class TestRetry:
    def test_a_declined_refund_is_recorded_failed_and_retried(self, client, auth, admin_auth, db, seven, monkeypatch):
        with monkeypatch.context() as patch:
            gateway_declines(patch)
            response = create(client, admin_auth, oid(seven), "flaky-gate", adjustmentAmount=10000)
            assert response.status_code == 201, response.text
            assert response.json()["message"].startswith("The payment gateway declined this refund.")
            failed = response.json()["data"]
            assert failed["status"] == "failed" and failed["attempts"] == 1
            assert failed["failureReason"] == "Refunds are paused on this account."
            assert failed["canRetry"] is True and failed["canCancel"] is True
            assert db.get(Payment, seven["paymentId"]).refunded_amount == 0
            # A failed refund holds no money.
            assert context(client, admin_auth, oid(seven))["breakdown"]["remaining"] == 650000

            # Declined again.
            again = client.post(f"{BASE}/{failed['id']}/retry", headers=admin_auth)
            assert again.status_code == 200, again.text
            assert again.json()["message"] == "The payment gateway declined it again."
            assert again.json()["data"]["status"] == "failed" and again.json()["data"]["attempts"] == 2

        ok = client.post(f"{BASE}/{failed['id']}/retry", headers=admin_auth)
        assert ok.status_code == 200, ok.text
        data = ok.json()["data"]
        assert data["status"] == "completed" and data["attempts"] == 3 and data["failureReason"] == ""
        assert ok.json()["message"] == "Refund completed."
        db.expire_all()
        assert db.get(Payment, seven["paymentId"]).refunded_amount == 10000
        assert db.query(Refund).filter(Refund.order_id == oid(seven)).count() == 1
        trail = actions(db, failed["id"])
        assert trail[0] == "refund.created" and trail.count("refund.retried") == 2 and "refund.failed" in trail

    def test_a_failed_refund_can_be_cancelled(self, client, admin_auth, seven, monkeypatch):
        gateway_declines(monkeypatch)
        failed = create(client, admin_auth, oid(seven), "flaky-gat2", adjustmentAmount=10000).json()["data"]
        response = client.post(f"{BASE}/{failed['id']}/cancel", headers=admin_auth, json={})
        assert response.status_code == 200 and response.json()["data"]["status"] == "cancelled"
        retry = client.post(f"{BASE}/{failed['id']}/retry", headers=admin_auth)
        assert retry.status_code == 409


# ---------------------------------------------------- list, summary, settings


class TestListAndSummary:
    @pytest.fixture()
    def three(self, client, admin_auth, manager_auth, seven, monkeypatch):
        low_threshold(client, admin_auth)
        done = create(client, admin_auth, oid(seven), "list-done1", adjustmentAmount=1000).json()["data"]
        waiting = create(client, manager_auth, oid(seven), "list-wait1", adjustmentAmount=60000,
                         reasonCode="defective").json()["data"]
        with monkeypatch.context() as patch:
            gateway_declines(patch)
            failed = create(client, admin_auth, oid(seven), "list-fail1", adjustmentAmount=2000,
                            method="original").json()["data"]
        credit = create(client, admin_auth, oid(seven), "list-cred1", adjustmentAmount=3000,
                        method="store-credit").json()["data"]
        return {"done": done, "waiting": waiting, "failed": failed, "credit": credit}

    def listing(self, client, headers, **params):
        response = client.get(BASE, headers=headers, params=params)
        assert response.status_code == 200, response.text
        return response.json()["data"]

    def test_filters(self, client, manager_auth, three):
        ids = lambda data: {item["id"] for item in data["items"]}  # noqa: E731
        assert len(self.listing(client, manager_auth)["items"]) == 4
        assert ids(self.listing(client, manager_auth, status="failed")) == {three["failed"]["id"]}
        assert ids(self.listing(client, manager_auth, status="pending")) == {three["waiting"]["id"]}
        assert ids(self.listing(client, manager_auth, awaitingApproval="true")) == {three["waiting"]["id"]}
        assert ids(self.listing(client, manager_auth, method="store-credit")) == {three["credit"]["id"]}
        assert ids(self.listing(client, manager_auth, reasonCode="defective")) == {three["waiting"]["id"]}
        assert ids(self.listing(client, manager_auth, q=three["done"]["refundNumber"])) == {three["done"]["id"]}

    def test_the_search_box_takes_ids_only(self, client, manager_auth, three):
        ids = lambda data: {item["id"] for item in data["items"]}  # noqa: E731
        done = three["done"]
        everyone = {row["id"] for row in three.values()}
        assert ids(self.listing(client, manager_auth, q=done["refundNumber"].lower())) == {done["id"]}
        assert ids(self.listing(client, manager_auth, q=done["id"])) == {done["id"]}
        assert ids(self.listing(client, manager_auth, q=done["orderNumber"])) == everyone
        assert ids(self.listing(client, manager_auth, q=done["invoiceNumber"])) == everyone
        # A name, a part of a number or a reason is not an ID.
        assert self.listing(client, manager_auth, q=done["customerName"])["items"] == []
        assert self.listing(client, manager_auth, q=done["refundNumber"][:-1])["items"] == []
        assert self.listing(client, manager_auth, q="defective")["items"] == []
        assert len(self.listing(client, manager_auth, orderId=three["done"]["orderId"])["items"]) == 4
        assert self.listing(client, manager_auth, orderId="ORD-NONE")["items"] == []

    def test_an_unknown_status(self, client, manager_auth, three):
        response = client.get(BASE, headers=manager_auth, params={"status": "lost"})
        assert response.status_code == 422 and error_code(response) == "INVALID_STATUS"

    def test_pagination(self, client, manager_auth, three):
        first = self.listing(client, manager_auth, page=1, pageSize=3)
        second = self.listing(client, manager_auth, page=2, pageSize=3)
        assert len(first["items"]) == 3 and len(second["items"]) == 1
        assert first["pagination"]["total"] == 4
        assert {i["id"] for i in first["items"]}.isdisjoint({i["id"] for i in second["items"]})

    def test_summary(self, client, manager_auth, three):
        response = client.get(f"{BASE}/summary", headers=manager_auth)
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert (data["requested"], data["awaitingApproval"], data["processing"], data["failed"]) == (1, 1, 0, 1)
        assert data["refundedTodayCount"] == 2 and data["refundedToday"] == 4000

    def test_one_refund(self, client, manager_auth, three):
        response = client.get(f"{BASE}/{three['waiting']['id']}", headers=manager_auth)
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["refundNumber"] == three["waiting"]["refundNumber"] and data["canApprove"] is True


class TestSettings:
    def test_defaults(self, client, manager_auth):
        response = client.get(f"{BASE}/settings", headers=manager_auth)
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["approvalThreshold"] == 10000 and data["allowedMethods"] == ["original", "store-credit"]
        assert (data["pollMinutes"], data["maxAttempts"]) == (30, 3)
        assert data["methods"] == ["original", "store-credit"]

    def test_saving_needs_refunds_large(self, client, manager_auth):
        response = client.put(f"{BASE}/settings", headers=manager_auth, json={"approvalThreshold": 1})
        assert response.status_code == 403

    def test_saving_and_the_audit_row(self, client, admin_auth, db):
        response = client.put(f"{BASE}/settings", headers=admin_auth, json={
            "approvalThreshold": 2500, "pollMinutes": 5, "maxAttempts": 10, "codMethod": "original",
            "autoCreditNote": True})
        assert response.status_code == 200, response.text
        assert response.json()["message"] == "Refund settings saved."
        data = client.get(f"{BASE}/settings", headers=admin_auth).json()["data"]
        assert (data["approvalThreshold"], data["pollMinutes"], data["maxAttempts"]) == (2500, 5, 10)
        assert data["codMethod"] == "original" and data["autoCreditNote"] is True
        row = db.query(AuditLog).filter(AuditLog.action == "refunds.settings.updated").one()
        assert row.resource_id == "refunds"

    @pytest.mark.parametrize("body", [
        {"approvalThreshold": -1}, {"approvalThreshold": 10_000_001},
        {"pollMinutes": 4}, {"pollMinutes": 1441},
        {"maxAttempts": 0}, {"maxAttempts": 11},
        {"allowedMethods": []}, {"allowedMethods": ["cash"]},
        {"returnsMethod": "cheque"}, {"codMethod": "cash"},
    ])
    def test_out_of_range(self, client, admin_auth, body):
        response = client.put(f"{BASE}/settings", headers=admin_auth, json=body)
        assert response.status_code == 422 and error_code(response) == "INVALID_SETTING"
        assert client.get(f"{BASE}/settings", headers=admin_auth).json()["data"]["approvalThreshold"] == 10000


# ------------------------------------------------------------- the customer


INTERNAL = {"internalNote", "gatewayReference", "failureReason", "initiatedBy", "approvedBy", "manualReference",
            "attempts", "id", "customerId", "paymentId"}


class TestCustomer:
    def test_your_refunds_without_anything_internal(self, client, auth, admin_auth, seven, monkeypatch):
        (item,) = item_ids(client, admin_auth, oid(seven))
        create(client, admin_auth, oid(seven), "cust-view1", lines=[{"orderItemId": item, "quantity": 1}],
               internalNote="Staff only note", manualReference="UTR123")
        with monkeypatch.context() as patch:
            gateway_declines(patch, "Bank says no")
            create(client, admin_auth, oid(seven), "cust-view2", adjustmentAmount=500, internalNote="Secret")
        response = client.get("/api/account/refunds", headers=auth)
        assert response.status_code == 200, response.text
        items = response.json()["data"]["items"]
        assert len(items) == 2
        for item_view in items:
            assert not INTERNAL & set(item_view)
        assert "Staff only note" not in response.text and "Bank says no" not in response.text
        assert "UTR123" not in response.text and "RFND" not in response.text
        by_amount = {i["amount"]: i for i in items}
        assert by_amount[650000 // 7]["status"] == "completed" and by_amount[650000 // 7]["statusLabel"] == "Refunded"
        assert by_amount[650000 // 7]["items"] == [{"name": "Cotton Kurta", "quantity": 1, "amount": 650000 // 7}]
        # A failed attempt is the store's to retry: to the customer it is in progress.
        assert by_amount[500]["status"] == "processing" and by_amount[500]["completedAt"] is None

    def test_one_order_s_refunds(self, client, auth, admin_auth, seven):
        create(client, admin_auth, oid(seven), "cust-order", adjustmentAmount=700)
        response = client.get(f"/api/account/orders/{oid(seven)}/refunds", headers=auth)
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["orderNumber"] == seven["order"]["orderNumber"]
        assert [i["amount"] for i in data["items"]] == [700]
        by_number = client.get(f"/api/account/orders/{seven['order']['orderNumber']}/refunds", headers=auth)
        assert [i["amount"] for i in by_number.json()["data"]["items"]] == [700]

    def test_someone_else_s_order(self, client, admin_auth, db, other_customer, seven):
        create(client, admin_auth, oid(seven), "not-theirs", adjustmentAmount=700)
        token = client.post("/api/auth/login", json={"email": other_customer.email, "password": "Customer@123"}
                            ).json()["data"]["token"]["accessToken"]
        theirs = {"Authorization": f"Bearer {token}"}
        response = client.get(f"/api/account/orders/{oid(seven)}/refunds", headers=theirs)
        assert response.status_code == 404 and error_code(response) == "ORDER_NOT_FOUND"
        assert client.get("/api/account/refunds", headers=theirs).json()["data"]["items"] == []
        filtered = client.get("/api/account/refunds", headers=theirs, params={"order": oid(seven)})
        assert filtered.json()["data"]["items"] == []

    def test_withdrawn_refunds_are_not_shown(self, client, auth, admin_auth, manager_auth, seven):
        low_threshold(client, admin_auth)
        refund = create(client, manager_auth, oid(seven), "withdrawn1", adjustmentAmount=60000).json()["data"]
        assert client.get("/api/account/refunds", headers=auth).json()["data"]["items"][0]["status"] == "requested"
        client.post(f"{BASE}/{refund['id']}/reject", headers=admin_auth, json={})
        assert client.get("/api/account/refunds", headers=auth).json()["data"]["items"] == []

    def test_signed_out(self, client):
        assert client.get("/api/account/refunds").status_code == 401
