"""
Invoices, payments, refunds and credit notes, through the portal.

The mock provider settles a prepaid order at once and confirms refunds on the
spot, which makes it the simplest way to have money to give back. Where the
gateway's own behaviour matters -- a refund it refuses, one it fails days
later -- the stubbed Razorpay from `test_payment_security` stands in.

Every refund test checks the three records that must agree afterwards: the
payment's refunded amount and status, the invoice's, and the order's.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

import app.main  # noqa: F401 -- import the app before any fixture patches `get_provider`
from app.core import rate_limit
from app.models import CreditNote, Invoice, Order, Payment, Refund
from app.services import invoices
from tests.integration.test_payment_security import (  # noqa: F401 -- `gateway` is a fixture
    captured,
    gateway,
    refunds_sent,
    verify,
    webhook,
)
from tests.integration.test_payment_security import place as place_order

pytestmark = pytest.mark.integration

REFUNDS = "/api/admin/billing/refunds"


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


def raise_refund(client, admin_auth, invoice_id, amount, *, reason="Item arrived damaged", status=None):
    body = {"invoiceId": invoice_id, "amount": amount, "reason": reason}
    if status:
        body["status"] = status
    return client.post(REFUNDS, headers=admin_auth, json=body)


@pytest.fixture()
def paid(client, auth, catalogue, settings_documents):
    """A ₹1,000 order the mock provider settled at checkout."""
    placed = placed_order(client, auth)
    assert placed["paymentStatus"] == "paid"
    return placed


@pytest.fixture()
def cod(client, auth, catalogue, settings_documents):
    return placed_order(client, auth, paymentMethod="cod")


# ================================================================ reading


class TestTheLedger:
    def test_invoices_filter_by_every_field(self, client, admin_auth, paid, cod):
        def ids(**params):
            response = client.get("/api/admin/billing/invoices", headers=admin_auth, params=params)
            assert response.status_code == 200, response.text
            return {row["id"] for row in response.json()["data"]}

        both = {paid["invoiceId"], cod["invoiceId"]}
        assert ids() == both
        assert ids(status="all", paymentStatus="all") == both
        assert ids(paymentStatus="paid") == {paid["invoiceId"]}
        assert ids(orderId=cod["order"]["id"]) == {cod["invoiceId"]}
        # `search` is an ID, matched exactly: the invoice's own or its order's.
        invoice_number = client.get(f"/api/admin/billing/invoices/{paid['invoiceId']}",
                                    headers=admin_auth).json()["data"]["invoiceNumber"]
        assert ids(search=paid["order"]["orderNumber"]) == {paid["invoiceId"]}
        assert ids(search=paid["order"]["id"]) == {paid["invoiceId"]}
        assert ids(search=invoice_number) == {paid["invoiceId"]}
        assert ids(search=paid["invoiceId"].lower()) == {paid["invoiceId"]}
        # Names, emails and fragments of an ID are not IDs.
        assert ids(search="Asha") == set()
        assert ids(search="shopper@example.com") == set()
        assert ids(search=paid["order"]["orderNumber"][:-1]) == set()
        assert ids(minAmount=100000) == both
        assert ids(minAmount=100001) == set()
        yesterday = (datetime.utcnow() - timedelta(days=1)).isoformat()
        tomorrow = (datetime.utcnow() + timedelta(days=1)).isoformat()
        assert ids(**{"from": yesterday, "to": tomorrow}) == both
        assert ids(**{"from": tomorrow}) == set()

        status = client.get("/api/admin/billing/invoices", headers=admin_auth,
                            params={"status": "paid"}).json()["data"]
        assert [row["id"] for row in status] == [paid["invoiceId"]]

    def test_one_invoice_and_a_missing_one(self, client, admin_auth, paid):
        one = client.get(f"/api/admin/billing/invoices/{paid['invoiceId']}", headers=admin_auth)
        assert one.status_code == 200 and one.json()["data"]["amountPaid"] == 100000
        missing = client.get("/api/admin/billing/invoices/INV999999", headers=admin_auth)
        assert missing.status_code == 404 and missing.json()["error_code"] == "INVOICE_NOT_FOUND"

    def test_payments_filter_by_every_field(self, client, admin_auth, paid, cod):
        def ids(**params):
            response = client.get("/api/admin/billing/payments", headers=admin_auth, params=params)
            assert response.status_code == 200, response.text
            return {row["id"] for row in response.json()["data"]}

        both = {paid["paymentId"], cod["paymentId"]}
        assert ids() == both
        assert ids(status="all", method="all") == both
        assert ids(method="cod") == {cod["paymentId"]}
        assert ids(status="paid") == {paid["paymentId"]}
        assert ids(orderId=paid["order"]["id"]) == {paid["paymentId"]}
        assert ids(search=cod["order"]["orderNumber"]) == {cod["paymentId"]}
        # Any of the payment's IDs finds it — never a name or an email.
        assert ids(search=cod["paymentId"]) == {cod["paymentId"]}
        assert ids(search=cod["invoiceId"]) == {cod["paymentId"]}
        transaction = client.get(f"/api/admin/billing/payments/{paid['paymentId']}",
                                 headers=admin_auth).json()["data"]["transactionId"]
        assert ids(search=transaction) == {paid["paymentId"]}
        assert ids(search="Asha") == set()
        assert ids(search="shopper@example.com") == set()

    def test_one_payment_and_its_timeline(self, client, admin_auth, paid):
        one = client.get(f"/api/admin/billing/payments/{paid['paymentId']}", headers=admin_auth).json()["data"]
        assert one["status"] == "paid" and one["timeline"]
        assert client.get("/api/admin/billing/payments/PAY999999",
                          headers=admin_auth).json()["error_code"] == "PAYMENT_NOT_FOUND"

    def test_a_customer_sees_only_their_own_invoices(self, client, auth, paid, other_customer):
        mine = client.get("/api/invoices", headers=auth).json()["data"]
        assert [row["id"] for row in mine] == [paid["invoiceId"]]

        login = client.post("/api/auth/login", json={"email": other_customer.email, "password": "Customer@123"})
        theirs = {"Authorization": f"Bearer {login.json()['data']['token']['accessToken']}"}
        assert client.get("/api/invoices", headers=theirs).json()["data"] == []
        response = client.get(f"/api/invoices/{paid['invoiceId']}", headers=theirs)
        assert response.status_code == 404 and response.json()["error_code"] == "INVOICE_NOT_FOUND"

    def test_reading_the_ledger_needs_an_admin(self, client, auth, paid):
        assert client.get("/api/admin/billing/invoices", headers=auth).status_code in (401, 403)


# ============================================================ what is owed


class TestWhatIsOwed:
    def test_an_unpaid_invoice_past_its_due_date_is_overdue(self, db, cod):
        invoice = db.get(Invoice, cod["invoiceId"])
        assert invoices.amount_due(invoice) == invoice.grand_total == 100000
        assert not invoices.is_overdue(invoice)

        assert invoices.is_overdue(invoice, now=invoice.due_at + timedelta(seconds=1))
        assert not invoices.is_overdue(invoice, now=invoice.due_at - timedelta(seconds=1))

    def test_paid_or_cancelled_is_never_overdue(self, db, paid, cod):
        later = datetime.utcnow() + timedelta(days=365)
        assert not invoices.is_overdue(db.get(Invoice, paid["invoiceId"]), now=later)
        invoice = db.get(Invoice, cod["invoiceId"])
        invoice.status = "cancelled"
        assert not invoices.is_overdue(invoice, now=later)

    def test_settled_in_full_but_not_yet_relabelled_is_not_overdue(self, db, cod):
        invoice = db.get(Invoice, cod["invoiceId"])
        invoice.amount_paid = invoice.grand_total
        assert invoice.status != "paid"
        assert not invoices.is_overdue(invoice, now=datetime.utcnow() + timedelta(days=365))

    def test_the_amount_due_falls_with_payments_and_refunds_and_never_goes_negative(self, db, cod):
        invoice = db.get(Invoice, cod["invoiceId"])
        invoice.amount_paid = 60000
        assert invoices.amount_due(invoice) == 40000
        invoice.amount_refunded = 30000
        assert invoices.amount_due(invoice) == 10000
        invoice.amount_refunded = 90000
        assert invoices.amount_due(invoice) == 0


class TestMarkingPaid:
    def test_a_part_payment_then_the_rest(self, client, db, admin_auth, cod):
        part = client.post(f"/api/admin/billing/invoices/{cod['invoiceId']}/mark-paid", headers=admin_auth,
                           json={"amount": 40000})
        assert part.status_code == 200, part.text
        assert part.json()["data"]["amountPaid"] == 40000
        assert part.json()["data"]["paymentStatus"] == "pending"
        assert fresh(db, Payment, cod["paymentId"]).status == "pending"

        rest = client.post(f"/api/admin/billing/invoices/{cod['invoiceId']}/mark-paid", headers=admin_auth, json={})
        assert rest.json()["data"]["amountPaid"] == 100000
        assert rest.json()["data"]["status"] == "paid"
        payment = fresh(db, Payment, cod["paymentId"])
        assert payment.status == "paid" and payment.captured_at is not None
        assert payment.events[-1].note == "Marked as received."
        assert fresh(db, Order, cod["order"]["id"]).payment_status == "paid"

    def test_more_than_is_owed_records_only_what_is_owed(self, client, admin_auth, cod):
        response = client.post(f"/api/admin/billing/invoices/{cod['invoiceId']}/mark-paid", headers=admin_auth,
                               json={"amount": 10_000_000})
        assert response.json()["data"]["amountPaid"] == 100000

    def test_a_negative_amount_records_nothing(self, client, admin_auth, cod):
        response = client.post(f"/api/admin/billing/invoices/{cod['invoiceId']}/mark-paid", headers=admin_auth,
                               json={"amount": -50000})
        assert response.status_code == 200
        assert response.json()["data"]["amountPaid"] == 0

    def test_marking_paid_needs_the_orders_permission(self, client, editor, cod):
        login = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"})
        headers = {"Authorization": f"Bearer {login.json()['data']['token']['accessToken']}"}
        response = client.post(f"/api/admin/billing/invoices/{cod['invoiceId']}/mark-paid", headers=headers, json={})
        assert response.status_code == 403

    def test_a_courier_collection_is_captured(self, client, db, admin_auth, cod):
        response = client.post(f"/api/admin/billing/payments/{cod['paymentId']}/capture", headers=admin_auth)
        assert response.status_code == 200 and response.json()["message"] == "Payment received."
        invoice = fresh(db, Invoice, cod["invoiceId"])
        assert invoice.amount_paid == invoice.grand_total and invoice.status == "paid"
        assert fresh(db, Order, cod["order"]["id"]).payment_status == "paid"

    # Regression: was a real bug, fixed alongside this test.
    def test_a_refunded_payment_cannot_be_captured_again(self, client, db, admin_auth, paid):
        assert raise_refund(client, admin_auth, paid["invoiceId"], 100000).status_code == 201

        response = client.post(f"/api/admin/billing/payments/{paid['paymentId']}/capture", headers=admin_auth)

        assert response.status_code == 409
        assert fresh(db, Payment, paid["paymentId"]).status == "refunded"


# ================================================================ refunds


class TestRefunds:
    def test_a_full_refund_moves_all_three_records(self, client, db, admin_auth, paid):
        response = raise_refund(client, admin_auth, paid["invoiceId"], 100000)

        assert response.status_code == 201, response.text
        refund = response.json()["data"]
        assert refund["status"] == "completed" and refund["gatewayAmount"] == 100000
        assert refund["refundNumber"]
        payment = fresh(db, Payment, paid["paymentId"])
        assert (payment.refunded_amount, payment.status) == (100000, "refunded")
        invoice = fresh(db, Invoice, paid["invoiceId"])
        assert invoice.amount_refunded == 100000 and invoice.payment_status == "refunded"
        assert fresh(db, Order, paid["order"]["id"]).payment_status == "refunded"
        assert invoices.amount_due(invoice) == 0

    def test_partial_refunds_add_up_and_an_over_refund_is_refused(self, client, db, admin_auth, paid):
        assert raise_refund(client, admin_auth, paid["invoiceId"], 30000).status_code == 201
        assert raise_refund(client, admin_auth, paid["invoiceId"], 50000).status_code == 201
        payment = fresh(db, Payment, paid["paymentId"])
        assert (payment.refunded_amount, payment.status) == (80000, "partially-refunded")
        assert fresh(db, Order, paid["order"]["id"]).payment_status == "paid"

        over = raise_refund(client, admin_auth, paid["invoiceId"], 20001)
        assert over.status_code == 409 and over.json()["error_code"] == "REFUND_EXCEEDS_PAYMENT"
        assert fresh(db, Payment, paid["paymentId"]).refunded_amount == 80000

        last = raise_refund(client, admin_auth, paid["invoiceId"], 20000)
        assert last.status_code == 201
        assert fresh(db, Payment, paid["paymentId"]).status == "refunded"
        assert db.query(Refund).count() == 3

        nothing = raise_refund(client, admin_auth, paid["invoiceId"], 1)
        assert nothing.status_code == 409 and nothing.json()["error_code"] == "NOTHING_TO_REFUND"
        assert "already been refunded" in nothing.json()["message"]

    def test_a_refund_with_line_items(self, client, db, admin_auth, paid):
        response = client.post(REFUNDS, headers=admin_auth, json={
            "invoiceId": paid["invoiceId"], "amount": 100000, "reason": "Returned",
            "lines": [{"productId": "PRD001", "name": "Cotton Kurta", "quantity": 1, "amount": 100000}]})
        assert response.status_code == 201
        assert response.json()["data"]["lines"] == [
            {"productId": "PRD001", "name": "Cotton Kurta", "quantity": 1, "amount": 100000}]

    def test_nothing_to_refund_before_anything_is_collected(self, client, admin_auth, cod):
        response = raise_refund(client, admin_auth, cod["invoiceId"], 100)
        assert response.status_code == 409 and response.json()["error_code"] == "NOTHING_TO_REFUND"
        assert "Nothing has been collected" in response.json()["message"]

    @pytest.mark.parametrize("amount", [0, -100])
    def test_the_amount_must_be_positive(self, client, admin_auth, paid, amount):
        assert raise_refund(client, admin_auth, paid["invoiceId"], amount).status_code == 422

    def test_a_blank_reason_is_refused(self, client, admin_auth, paid):
        response = raise_refund(client, admin_auth, paid["invoiceId"], 100, reason="    ")
        assert response.status_code == 422 and response.json()["error_code"] == "REASON_REQUIRED"

    def test_an_invoice_with_no_payment(self, client, db, admin_auth, paid):
        db.delete(db.get(Payment, paid["paymentId"]))
        db.flush()
        response = raise_refund(client, admin_auth, paid["invoiceId"], 100)
        assert response.status_code == 409 and response.json()["error_code"] == "NO_PAYMENT"

    def test_the_service_refuses_non_positive_amounts_too(self, db, paid):
        from app.core.errors import ValidationError

        with pytest.raises(ValidationError) as raised:
            invoices.create_refund(db, invoice_id=paid["invoiceId"], amount=0, reason="x")
        assert raised.value.error_code == "INVALID_AMOUNT"

    def test_a_missing_refund(self, client, admin_auth):
        response = client.put(f"{REFUNDS}/RFD999999", headers=admin_auth, json={"status": "completed"})
        assert response.status_code == 404 and response.json()["error_code"] == "REFUND_NOT_FOUND"

    def test_refunds_filter_and_search(self, client, admin_auth, paid):
        raise_refund(client, admin_auth, paid["invoiceId"], 10000, reason="Late delivery")
        raise_refund(client, admin_auth, paid["invoiceId"], 10000, reason="Colour differs", status="pending")

        def reasons(**params):
            response = client.get(REFUNDS, headers=admin_auth, params=params)
            assert response.status_code == 200
            return sorted(row["reason"] for row in response.json()["data"])

        assert reasons() == ["Colour differs", "Late delivery"]
        assert reasons(status="pending") == ["Colour differs"]
        assert reasons(status="all", orderId=paid["order"]["id"]) == ["Colour differs", "Late delivery"]
        # `search` is an ID — the refund's, its order's or its invoice's — never the reason or a name.
        rows = client.get(REFUNDS, headers=admin_auth).json()["data"]
        colour = next(row for row in rows if row["reason"] == "Colour differs")
        assert reasons(search=colour["refundNumber"]) == ["Colour differs"]
        assert reasons(search=colour["id"]) == ["Colour differs"]
        assert reasons(search=paid["order"]["orderNumber"]) == ["Colour differs", "Late delivery"]
        assert reasons(search=paid["invoiceId"]) == ["Colour differs", "Late delivery"]
        assert reasons(search="Colour differs") == []
        assert reasons(search="Asha") == []


class TestRefundsThatWait:
    def test_a_requested_refund_moves_no_money_until_completed(self, client, db, admin_auth, paid):
        # "pending" was never an official status; it is read as "requested" (docs/refunds.md).
        response = raise_refund(client, admin_auth, paid["invoiceId"], 40000, status="pending")
        assert response.status_code == 201 and response.json()["data"]["status"] == "requested"
        assert fresh(db, Payment, paid["paymentId"]).refunded_amount == 0

        overview = client.get("/api/admin/billing/overview", headers=admin_auth).json()["data"]
        assert [r["id"] for r in overview["openRefunds"]] == [response.json()["data"]["id"]]

        done = client.put(f"{REFUNDS}/{response.json()['data']['id']}", headers=admin_auth,
                          json={"status": "completed"})
        assert done.status_code == 200 and done.json()["data"]["status"] == "completed"
        assert done.json()["message"] == "Refund completed."
        assert fresh(db, Payment, paid["paymentId"]).refunded_amount == 40000

        again = client.put(f"{REFUNDS}/{response.json()['data']['id']}", headers=admin_auth,
                           json={"status": "completed"})
        assert again.status_code == 409 and again.json()["error_code"] == "REFUND_COMPLETE"
        assert fresh(db, Payment, paid["paymentId"]).refunded_amount == 40000

    def test_a_rejected_request_leaves_the_money_where_it_is(self, client, db, admin_auth, paid):
        refund_id = raise_refund(client, admin_auth, paid["invoiceId"], 40000, status="pending").json()["data"]["id"]

        rejected = client.put(f"{REFUNDS}/{refund_id}", headers=admin_auth, json={"status": "rejected"})

        assert rejected.json()["data"]["status"] == "rejected"
        assert fresh(db, Payment, paid["paymentId"]).status == "paid"
        assert fresh(db, Invoice, paid["invoiceId"]).amount_refunded == 0

    # Regression (partial refunds, bug 4): a requested refund used to hold no
    # money, so a second one could be raised against the same rupees and only
    # completing it caught the over-refund. Requested refunds are now reserved.
    def test_two_requests_that_together_exceed_the_payment(self, client, db, admin_auth, paid):
        """Each fits on its own; the second is refused when it is raised."""
        first = raise_refund(client, admin_auth, paid["invoiceId"], 70000, status="pending").json()["data"]["id"]
        refused = raise_refund(client, admin_auth, paid["invoiceId"], 70000, status="pending")
        assert refused.status_code == 409 and refused.json()["error_code"] == "REFUND_EXCEEDS_PAYMENT"

        assert client.put(f"{REFUNDS}/{first}", headers=admin_auth, json={"status": "completed"}).status_code == 200
        payment = fresh(db, Payment, paid["paymentId"])
        assert payment.refunded_amount == 70000 and payment.status == "partially-refunded"
        assert db.query(Refund).count() == 1


class TestRefundsAtTheGateway:
    @pytest.fixture()
    def gateway_paid(self, client, auth, gateway, catalogue, settings_documents):
        placed = placed_order(client, auth)
        ref = placed["gateway"]["orderReference"]
        gateway.responses["/payments/pay_gw0001"] = captured(ref, "pay_gw0001", placed["amount"])
        assert verify(client, auth, placed, "pay_gw0001").status_code == 200
        return placed

    def test_a_refund_the_gateway_refuses_records_nothing(self, client, db, admin_auth, gateway, gateway_paid):
        from app.services.payments.razorpay import RazorpayError

        def refuse():
            raise RazorpayError("Insufficient balance in the account.", status=400)

        gateway.responses["/payments/pay_gw0001/refund"] = refuse

        response = raise_refund(client, admin_auth, gateway_paid["invoiceId"], 50000)

        assert response.status_code == 409 and response.json()["error_code"] == "PROVIDER_REFUSED"
        db.rollback()
        # Recorded before it was sent (partial refunds, bug 1), so the refusal is
        # on record — failed, with the gateway's reason — and nothing moved.
        refund = db.query(Refund).one()
        assert refund.status == "failed" and "Insufficient balance" in refund.failure_reason
        payment = fresh(db, Payment, gateway_paid["paymentId"])
        assert payment.refunded_amount == 0 and payment.status == "paid"

    def test_a_partial_refund_that_fails_later_is_given_back(self, client, db, admin_auth, gateway, gateway_paid):
        replies = iter([{"id": "rfnd_p1", "status": "pending"}, {"id": "rfnd_p2", "status": "pending"}])
        gateway.responses["/payments/pay_gw0001/refund"] = lambda: next(replies)
        raise_refund(client, admin_auth, gateway_paid["invoiceId"], 30000)
        raise_refund(client, admin_auth, gateway_paid["invoiceId"], 20000)
        assert fresh(db, Payment, gateway_paid["paymentId"]).refunded_amount == 50000

        webhook(client, {"event": "refund.failed", "payload": {"refund": {"entity": {"id": "rfnd_p1"}}}},
                event_id="evt_rf_fail")

        payment = fresh(db, Payment, gateway_paid["paymentId"])
        assert (payment.refunded_amount, payment.status) == (20000, "partially-refunded")
        assert fresh(db, Invoice, gateway_paid["invoiceId"]).amount_refunded == 20000
        assert payment.events[-1].status == "refund-failed"
        # Room has come back: what failed can be refunded again.
        gateway.responses["/payments/pay_gw0001/refund"] = {"id": "rfnd_p3", "status": "processed"}
        assert raise_refund(client, admin_auth, gateway_paid["invoiceId"], 80000).status_code == 201

    def test_a_full_refund_that_fails_unmarks_the_order(self, client, db, admin_auth, gateway, gateway_paid):
        gateway.responses["/payments/pay_gw0001/refund"] = {"id": "rfnd_full", "status": "processed"}
        raise_refund(client, admin_auth, gateway_paid["invoiceId"], gateway_paid["amount"])
        assert fresh(db, Order, gateway_paid["order"]["id"]).payment_status == "refunded"
        # Completed at once, so a later failure report is an outcome already final.
        assert invoices.apply_refund_outcome(db, "rfnd_full", "failed").status == "completed"

        refund = db.query(Refund).one()
        refund.status = "processing"
        db.flush()
        invoices.apply_refund_outcome(db, "rfnd_full", "failed")
        db.flush()

        assert fresh(db, Order, gateway_paid["order"]["id"]).payment_status == "paid"
        assert fresh(db, Payment, gateway_paid["paymentId"]).status == "paid"

    def test_an_outcome_that_is_neither_is_left_alone(self, client, db, admin_auth, gateway, gateway_paid):
        gateway.responses["/payments/pay_gw0001/refund"] = {"id": "rfnd_odd", "status": "pending"}
        raise_refund(client, admin_auth, gateway_paid["invoiceId"], 10000)

        refund = invoices.apply_refund_outcome(db, "rfnd_odd", "on-hold")

        assert refund.status == "processing"
        assert invoices.apply_refund_outcome(db, "rfnd_unknown", "processed") is None

    # Regression: was a real bug, fixed alongside this test.
    def test_a_refund_of_a_cash_order_is_paid_back_directly(self, client, db, admin_auth, gateway, catalogue,
                                                            settings_documents, auth):
        cod = placed_order(client, auth, paymentMethod="cod")
        client.post(f"/api/admin/billing/payments/{cod['paymentId']}/capture", headers=admin_auth)

        response = raise_refund(client, admin_auth, cod["invoiceId"], 25000)

        assert response.status_code == 201 and response.json()["data"]["status"] == "completed"
        # A COD- reference never reaches the gateway's refund endpoint.
        assert refunds_sent(gateway) == []
        payment = fresh(db, Payment, cod["paymentId"])
        assert "paid back directly" in payment.events[-1].note


# =========================================================== credit notes


class TestCreditNotes:
    def test_a_partial_credit_carries_its_own_tax(self, client, db, admin_auth, paid):
        response = client.post("/api/admin/billing/credit-notes", headers=admin_auth, json={
            "invoiceId": paid["invoiceId"], "total": 52500, "reason": "Price adjustment"})

        assert response.status_code == 201, response.text
        note = response.json()["data"]
        # 5% GST included: ₹525 is ₹500 + ₹25 tax.
        assert (note["total"], note["amount"], note["tax"]) == (52500, 50000, 2500)
        assert note["creditNoteNumber"] and note["status"] == "issued"

    def test_the_list_finds_notes_by_id_only(self, client, admin_auth, paid, cod):
        note = client.post("/api/admin/billing/credit-notes", headers=admin_auth, json={
            "invoiceId": paid["invoiceId"], "total": 1000, "reason": "Price adjustment"}).json()["data"]
        other = client.post("/api/admin/billing/credit-notes", headers=admin_auth, json={
            "invoiceId": cod["invoiceId"], "total": 1000, "reason": "Price adjustment"}).json()["data"]

        def ids(**params):
            response = client.get("/api/admin/billing/credit-notes", headers=admin_auth, params=params)
            assert response.status_code == 200, response.text
            return {row["id"] for row in response.json()["data"]}

        assert ids() == {note["id"], other["id"]}
        assert ids(q=note["creditNoteNumber"]) == {note["id"]}
        assert ids(q=note["id"]) == {note["id"]}
        assert ids(q=note["invoiceNumber"]) == {note["id"]}
        assert ids(q=paid["order"]["orderNumber"]) == {note["id"]}
        assert ids(q=cod["order"]["id"]) == {other["id"]}
        assert ids(q="Asha") == set()
        assert ids(q="Price adjustment") == set()
        assert ids(q=note["creditNoteNumber"][:-1]) == set()

    def test_it_cannot_exceed_the_invoice(self, client, admin_auth, paid):
        response = client.post("/api/admin/billing/credit-notes", headers=admin_auth, json={
            "invoiceId": paid["invoiceId"], "total": 100001, "reason": "Too much"})
        assert response.status_code == 422 and response.json()["error_code"] == "CREDIT_EXCEEDS_INVOICE"

    def test_a_blank_reason_is_refused(self, client, admin_auth, paid):
        response = client.post("/api/admin/billing/credit-notes", headers=admin_auth, json={
            "invoiceId": paid["invoiceId"], "total": 100, "reason": "   "})
        assert response.json()["error_code"] == "REASON_REQUIRED"

    def test_the_service_refuses_a_zero_note(self, db, paid):
        from app.core.errors import ValidationError

        with pytest.raises(ValidationError) as raised:
            invoices.create_credit_note(db, invoice_id=paid["invoiceId"], total=0, reason="x")
        assert raised.value.error_code == "INVALID_AMOUNT"

    # Regression: was a real bug, fixed alongside this test.
    def test_notes_together_cannot_exceed_the_invoice(self, client, admin_auth, paid):
        first = client.post("/api/admin/billing/credit-notes", headers=admin_auth, json={
            "invoiceId": paid["invoiceId"], "total": 80000, "reason": "First adjustment"})
        assert first.status_code == 201

        second = client.post("/api/admin/billing/credit-notes", headers=admin_auth, json={
            "invoiceId": paid["invoiceId"], "total": 80000, "reason": "Second adjustment"})

        assert second.status_code == 422

    def test_a_note_for_a_refund_is_linked_to_it(self, client, db, admin_auth, paid):
        refund_id = raise_refund(client, admin_auth, paid["invoiceId"], 100000).json()["data"]["id"]

        note = client.post("/api/admin/billing/credit-notes", headers=admin_auth, json={
            "invoiceId": paid["invoiceId"], "total": 100000, "reason": "Full refund", "refundId": refund_id,
            "status": "draft"}).json()["data"]

        assert note["refundId"] == refund_id and note["status"] == "draft"
        assert fresh(db, Refund, refund_id).credit_note_id == note["id"]
        listed = client.get("/api/admin/billing/refunds", headers=admin_auth).json()["data"]
        assert listed[0]["creditNoteId"] == note["id"]

    def test_a_note_is_issued_or_cancelled_never_deleted(self, client, db, admin_auth, paid, cod):
        note = client.post("/api/admin/billing/credit-notes", headers=admin_auth, json={
            "invoiceId": paid["invoiceId"], "total": 1000, "reason": "Goodwill", "status": "draft"}).json()["data"]
        client.post("/api/admin/billing/credit-notes", headers=admin_auth, json={
            "invoiceId": cod["invoiceId"], "total": 1000, "reason": "Goodwill"})

        issued = client.put(f"/api/admin/billing/credit-notes/{note['id']}", headers=admin_auth,
                            json={"status": "cancelled"})
        assert issued.status_code == 200 and issued.json()["data"]["status"] == "cancelled"
        assert db.query(CreditNote).count() == 2

        mine = client.get("/api/admin/billing/credit-notes", headers=admin_auth,
                          params={"orderId": paid["order"]["id"]}).json()["data"]
        assert [n["id"] for n in mine] == [note["id"]]
        assert len(client.get("/api/admin/billing/credit-notes", headers=admin_auth).json()["data"]) == 2

        missing = client.put("/api/admin/billing/credit-notes/CN999999", headers=admin_auth,
                             json={"status": "issued"})
        assert missing.status_code == 404 and missing.json()["error_code"] == "CREDIT_NOTE_NOT_FOUND"


# ============================================================== reporting


class TestReporting:
    def test_the_overview_totals_by_method(self, client, admin_auth, paid, cod):
        overview = client.get("/api/admin/billing/overview", headers=admin_auth).json()["data"]

        assert {i["id"] for i in overview["recentInvoices"]} == {paid["invoiceId"], cod["invoiceId"]}
        assert overview["openRefunds"] == []
        by_method = {row["method"]: row["amount"] for row in overview["paymentsByMethod"]}
        assert by_method == {"upi": 100000, "cod": 100000}

    def test_stats_net_out_refunds(self, client, admin_auth, paid, cod):
        raise_refund(client, admin_auth, paid["invoiceId"], 25000)

        stats = client.get("/api/admin/billing/stats", headers=admin_auth).json()["data"]

        assert stats["revenue"] == 200000 and stats["paid"] == 100000 and stats["pending"] == 100000
        assert stats["refunded"] == 25000 and stats["netSales"] == 75000
        assert stats["invoiceCount"] == 2 and stats["paymentCount"] == 2 and stats["refundCount"] == 1

    def test_stats_and_tax_respect_the_window(self, client, admin_auth, paid):
        tomorrow = (datetime.utcnow() + timedelta(days=1)).isoformat()
        empty = client.get("/api/admin/billing/stats", headers=admin_auth, params={"from": tomorrow}).json()["data"]
        assert empty["revenue"] == 0 and empty["invoiceCount"] == 0

        yesterday = (datetime.utcnow() - timedelta(days=1)).isoformat()
        rows = client.get("/api/admin/billing/tax-report", headers=admin_auth,
                          params={"from": yesterday, "to": tomorrow}).json()["data"]
        assert len(rows) == 1 and rows[0]["ratePercent"] == 5.0
        assert rows[0]["taxableAmount"] + rows[0]["totalTax"] == 100000
        assert rows[0]["cgst"] + rows[0]["sgst"] == rows[0]["totalTax"]

    def test_a_cancelled_invoice_is_not_revenue(self, client, db, admin_auth, cod):
        db.get(Invoice, cod["invoiceId"]).status = "cancelled"
        db.flush()
        stats = client.get("/api/admin/billing/stats", headers=admin_auth).json()["data"]
        assert stats["revenue"] == 0
        assert client.get("/api/admin/billing/tax-report", headers=admin_auth).json()["data"] == []
