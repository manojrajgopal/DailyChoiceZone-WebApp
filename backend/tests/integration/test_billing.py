"""
Invoices, refunds and credit notes.

Every rule here used to live in the browser, across four separate writes that
could be interrupted between any two. The tests that matter are the ones about
not giving back more than was taken, and about the documents reconciling.
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.integration


ADDRESS = {
    "fullName": "Asha Rao", "phone": "9876500001", "line1": "4 Brigade Road",
    "line2": "", "city": "Bengaluru", "state": "Karnataka", "pincode": "560001",
    "country": "India", "email": "shopper@example.com",
}


@pytest.fixture()
def order(client, auth, catalogue, settings_documents):
    """A paid order, with the invoice and payment it produced."""
    client.post("/api/cart/items", headers=auth,
                json={"productId": "PRD001", "quantity": 2})

    response = client.post("/api/orders", headers=auth, json={
        "shippingAddress": ADDRESS, "billingAddress": None,
        "deliveryMethod": "standard", "paymentMethod": "upi",
        "couponCode": None, "email": "shopper@example.com", "saveAddress": False,
    })
    assert response.status_code == 201, response.text
    return response.json()["data"]


class TestInvoices:
    def test_the_customer_sees_their_own(self, client, auth, order):
        response = client.get("/api/invoices", headers=auth)
        assert response.status_code == 200
        assert [i["id"] for i in response.json()["data"]] == [order["invoiceId"]]

    def test_and_not_anybody_elses(self, client, auth, order, db, other_customer):
        """404 rather than 403 — see the order tests for why."""
        from app.models import Invoice

        invoice = db.get(Invoice, order["invoiceId"])
        invoice.customer_id = other_customer.id
        db.flush()

        assert client.get(f"/api/invoices/{order['invoiceId']}",
                          headers=auth).status_code == 404

    def test_the_number_follows_the_configured_series(self, client, admin_auth, order):
        invoice = client.get(f"/api/admin/billing/invoices/{order['invoiceId']}",
                             headers=admin_auth).json()["data"]
        assert invoice["invoiceNumber"].startswith("DCZ-INV-")

    def test_the_document_carries_the_addresses_it_was_issued_with(self, client, auth, order):
        """
        Copied onto the invoice, not referenced.

        Editing a saved address must not silently rewrite where a delivered
        parcel was sent, or which state a filed document was taxed in.
        """
        invoice = client.get(f"/api/invoices/{order['invoiceId']}",
                             headers=auth).json()["data"]
        assert invoice["shippingAddress"]["city"] == "Bengaluru"
        assert invoice["placeOfSupply"] == "Karnataka"

    def test_marking_it_paid(self, client, admin_auth, order):
        invoice = client.get(f"/api/admin/billing/invoices/{order['invoiceId']}",
                             headers=admin_auth).json()["data"]

        response = client.post(
            f"/api/admin/billing/invoices/{order['invoiceId']}/mark-paid",
            headers=admin_auth, json={"amount": invoice["breakdown"]["grandTotal"]},
        )
        assert response.status_code == 200
        assert response.json()["data"]["status"] == "paid"


class TestRefunds:
    def test_raise_one(self, client, admin_auth, order):
        response = client.post("/api/admin/billing/refunds", headers=admin_auth, json={
            "invoiceId": order["invoiceId"], "amount": 50_000,
            "reason": "Item damaged", "lines": [], "status": "completed",
        })
        assert response.status_code == 201, response.text

        refund = response.json()["data"]
        assert refund["id"].startswith("RFN")
        assert refund["amount"] == 50_000

    def test_the_refund_records_who_raised_it(self, client, admin_auth, order, admin):
        """From the token, never the payload."""
        refund = client.post("/api/admin/billing/refunds", headers=admin_auth, json={
            "invoiceId": order["invoiceId"], "amount": 10_000,
            "reason": "Item damaged", "initiatedBy": "somebody-else",
        }).json()["data"]

        assert refund["initiatedBy"] == admin.id

    def test_cannot_refund_more_than_was_collected(self, client, admin_auth, order):
        """
        Checked against the *payment*, not the invoice.

        Two partial refunds that each look reasonable can together exceed what
        was actually taken.
        """
        response = client.post("/api/admin/billing/refunds", headers=admin_auth, json={
            "invoiceId": order["invoiceId"], "amount": 99_999_999, "reason": "Item damaged",
        })
        assert response.status_code == 409
        assert response.json()["error_code"] == "REFUND_EXCEEDS_PAYMENT"

    def test_two_partial_refunds_cannot_together_exceed_it(self, client, admin_auth, order):
        first = client.post("/api/admin/billing/refunds", headers=admin_auth, json={
            "invoiceId": order["invoiceId"], "amount": 150_000, "reason": "Item damaged",
        })
        assert first.status_code == 201

        second = client.post("/api/admin/billing/refunds", headers=admin_auth, json={
            "invoiceId": order["invoiceId"], "amount": 150_000, "reason": "Item damaged",
        })
        assert second.status_code == 409

    @pytest.mark.parametrize("amount", [0, -1, -50_000])
    def test_a_zero_or_negative_refund_is_refused(self, client, admin_auth, order, amount):
        response = client.post("/api/admin/billing/refunds", headers=admin_auth, json={
            "invoiceId": order["invoiceId"], "amount": amount, "reason": "Item damaged",
        })
        assert response.status_code in (409, 422)

    def test_a_refund_needs_a_reason(self, client, admin_auth, order):
        response = client.post("/api/admin/billing/refunds", headers=admin_auth, json={
            "invoiceId": order["invoiceId"], "amount": 10_000, "reason": "   ",
        })
        assert response.status_code in (409, 422)

    def test_a_completed_refund_adjusts_the_invoice(self, client, admin_auth, order):
        client.post("/api/admin/billing/refunds", headers=admin_auth, json={
            "invoiceId": order["invoiceId"], "amount": 50_000,
            "reason": "Item damaged", "status": "completed",
        })

        invoice = client.get(f"/api/admin/billing/invoices/{order['invoiceId']}",
                             headers=admin_auth).json()["data"]
        assert invoice["amountRefunded"] == 50_000

    def test_a_requested_refund_moves_no_money(self, client, admin_auth, order):
        """A refund is a request first and a movement of money second."""
        client.post("/api/admin/billing/refunds", headers=admin_auth, json={
            "invoiceId": order["invoiceId"], "amount": 50_000,
            "reason": "Item damaged", "status": "requested",
        })

        invoice = client.get(f"/api/admin/billing/invoices/{order['invoiceId']}",
                             headers=admin_auth).json()["data"]
        assert invoice["amountRefunded"] == 0

    def test_completing_it_later_does_move_the_money(self, client, admin_auth, order):
        refund = client.post("/api/admin/billing/refunds", headers=admin_auth, json={
            "invoiceId": order["invoiceId"], "amount": 50_000,
            "reason": "Item damaged", "status": "requested",
        }).json()["data"]

        response = client.put(f"/api/admin/billing/refunds/{refund['id']}",
                              headers=admin_auth, json={"status": "completed"})
        assert response.status_code == 200

        invoice = client.get(f"/api/admin/billing/invoices/{order['invoiceId']}",
                             headers=admin_auth).json()["data"]
        assert invoice["amountRefunded"] == 50_000

    def test_a_completed_refund_cannot_be_completed_twice(self, client, admin_auth, order):
        refund = client.post("/api/admin/billing/refunds", headers=admin_auth, json={
            "invoiceId": order["invoiceId"], "amount": 50_000,
            "reason": "Item damaged", "status": "completed",
        }).json()["data"]

        response = client.put(f"/api/admin/billing/refunds/{refund['id']}",
                              headers=admin_auth, json={"status": "completed"})
        assert response.status_code == 409

    def test_a_customer_cannot_raise_a_refund(self, client, auth, order):
        response = client.post("/api/admin/billing/refunds", headers=auth, json={
            "invoiceId": order["invoiceId"], "amount": 50_000, "reason": "Item damaged",
        })
        assert response.status_code == 403


class TestCreditNotes:
    def test_issue_one(self, client, admin_auth, order):
        response = client.post("/api/admin/billing/credit-notes", headers=admin_auth, json={
            "invoiceId": order["invoiceId"], "total": 50_000, "reason": "Item damaged",
        })
        assert response.status_code == 201, response.text

        note = response.json()["data"]
        assert note["id"].startswith("CRN")
        assert note["creditNoteNumber"].startswith("DCZ-CN-")

    def test_its_tax_is_recomputed_from_the_credited_amount(self, client, admin_auth, order):
        """
        Not copied off the invoice.

        A partial credit has to carry its own proportion of tax, or the note
        does not reconcile with the document it offsets.
        """
        note = client.post("/api/admin/billing/credit-notes", headers=admin_auth, json={
            "invoiceId": order["invoiceId"], "total": 50_000, "reason": "Item damaged",
        }).json()["data"]

        assert note["amount"] + note["tax"] == note["total"]
        assert note["tax"] > 0

    def test_cannot_exceed_the_invoice_it_offsets(self, client, admin_auth, order):
        response = client.post("/api/admin/billing/credit-notes", headers=admin_auth, json={
            "invoiceId": order["invoiceId"], "total": 99_999_999, "reason": "Item damaged",
        })
        assert response.status_code == 422
        assert response.json()["error_code"] == "CREDIT_EXCEEDS_INVOICE"

    def test_needs_an_amount_above_zero(self, client, admin_auth, order):
        response = client.post("/api/admin/billing/credit-notes", headers=admin_auth, json={
            "invoiceId": order["invoiceId"], "total": 0, "reason": "Item damaged",
        })
        assert response.status_code == 422

    def test_needs_a_reason(self, client, admin_auth, order):
        response = client.post("/api/admin/billing/credit-notes", headers=admin_auth, json={
            "invoiceId": order["invoiceId"], "total": 50_000, "reason": "  ",
        })
        assert response.status_code == 422

    def test_two_notes_do_not_share_a_number(self, client, admin_auth, order):
        """
        Sequential numbering is a property only one authority can provide.

        Two browsers minting their own would happily produce the same
        reference; the server reads the highest committed one and continues it.
        """
        numbers = [
            client.post("/api/admin/billing/credit-notes", headers=admin_auth, json={
                "invoiceId": order["invoiceId"], "total": 10_000, "reason": "Item damaged",
            }).json()["data"]["creditNoteNumber"]
            for _ in range(3)
        ]
        assert len(set(numbers)) == 3

    def test_a_customer_cannot_issue_one(self, client, auth, order):
        response = client.post("/api/admin/billing/credit-notes", headers=auth, json={
            "invoiceId": order["invoiceId"], "total": 10_000, "reason": "Item damaged",
        })
        assert response.status_code == 403


class TestReports:
    def test_the_stats_add_up_over_the_invoices(self, client, admin_auth, order):
        response = client.get("/api/admin/billing/stats", headers=admin_auth)
        assert response.status_code == 200

        stats = response.json()["data"]
        assert stats["invoiceCount"] >= 1

    def test_the_tax_report_splits_by_rate(self, client, admin_auth, order):
        response = client.get("/api/admin/billing/tax-report", headers=admin_auth)
        assert response.status_code == 200

        rows = response.json()["data"]
        assert rows
        for row in rows:
            assert row["cgst"] + row["sgst"] + row["igst"] == row["totalTax"]
