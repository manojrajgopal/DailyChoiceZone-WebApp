"""
Two bugs that fed each other, and the rules that stop them recurring.

Saving billing settings replaced the whole configuration document, so the one
screen that does not model the order-number section *deleted* it. Order
numbering then fell back to its starting number on every order, and the second
order asked the unique index for a number the first one already had. Checkout
returned a 409 from then on and nothing on either screen said why.

So there are two rules here: a save may not delete what it does not send, and
numbering may not hand out a number that exists.
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.integration


ADDRESS = {
    "fullName": "Asha Rao", "phone": "9876500001", "line1": "4 Brigade Road",
    "line2": "", "city": "Bengaluru", "state": "Karnataka", "pincode": "560001",
    "country": "India", "email": "shopper@example.com",
}


def place(client, auth, product_id="PRD001"):
    client.post("/api/cart/items", headers=auth,
                json={"productId": product_id, "quantity": 1})
    return client.post("/api/orders", headers=auth, json={
        "shippingAddress": ADDRESS, "billingAddress": None,
        "deliveryMethod": "standard", "paymentMethod": "upi",
        "couponCode": None, "email": "shopper@example.com", "saveAddress": False,
    })


class TestOrderNumbering:
    def test_two_orders_in_a_row(self, client, auth, catalogue, settings_documents):
        """
        The regression.

        The fixture's billing document has no `order` section, which is the
        state a settings save used to leave a real store in. Both orders must
        still get a number, and it must not be the same number.
        """
        first = place(client, auth)
        second = place(client, auth)

        assert first.status_code == 201, first.text
        assert second.status_code == 201, second.text

        numbers = [r.json()["data"]["order"]["orderNumber"] for r in (first, second)]
        assert numbers[0] != numbers[1]

    def test_it_counts_numerically_not_alphabetically(
        self, client, auth, admin_auth, catalogue, settings_documents, db
    ):
        """
        "DCZ99999" must be followed by "DCZ100000".

        A string maximum ranks "DCZ99999" above "DCZ100000" and sends the
        sequence backwards into numbers already used — and the number has to
        be free to grow a digit rather than stop at a fixed length.
        """
        from app.models import Order

        first = place(client, auth)
        assert first.status_code == 201, first.text
        db.get(Order, first.json()["data"]["order"]["id"]).order_number = "DCZ99999"
        db.flush()

        numbers = []
        for _ in range(2):
            response = place(client, auth)
            assert response.status_code == 201, response.text
            numbers.append(response.json()["data"]["order"]["orderNumber"])

        assert numbers == ["DCZ100000", "DCZ100001"]

    def test_it_steps_over_a_number_already_taken(
        self, client, auth, catalogue, settings_documents, db
    ):
        """
        A gap in the series is fine; a collision is a failed checkout.

        This is the state the broken numbering left behind: an order whose
        number does not belong to the configured series at all.
        """
        from app.models import Order

        first = place(client, auth)
        assert first.status_code == 201, first.text

        db.get(Order, first.json()["data"]["order"]["id"]).order_number = "1"
        db.flush()

        second = place(client, auth)
        assert second.status_code == 201, second.text
        number = second.json()["data"]["order"]["orderNumber"]
        assert number != "1" and number.startswith("DCZ")


class TestSavingConfiguration:
    def test_a_save_does_not_delete_what_it_does_not_send(
        self, client, admin_auth, settings_documents, db
    ):
        """
        The actual bug: a screen posts only the sections it understands.

        That used to be stored as the whole document, deleting every section
        the screen did not send.
        """
        posted = client.get("/api/admin/settings/billing", headers=admin_auth).json()["data"]
        kept = posted["payment"]
        del posted["payment"]
        posted["invoice"] = {**posted["invoice"], "dueDays": 21}

        saved = client.put("/api/admin/settings/billing", headers=admin_auth, json=posted)
        assert saved.status_code == 200, saved.text

        after = client.get("/api/admin/settings/billing", headers=admin_auth).json()["data"]
        assert after["payment"] == kept
        assert after["invoice"]["dueDays"] == 21

    def test_a_section_that_is_sent_is_replaced(self, client, admin_auth, settings_documents):
        """
        The merge is one level deep, deliberately.

        A screen that sends a section owns it — otherwise removing a refund
        reason or a payment method would be impossible.
        """
        current = client.get("/api/admin/settings/billing", headers=admin_auth).json()["data"]

        saved = client.put("/api/admin/settings/billing", headers=admin_auth, json={
            **current,
            "refund": {"windowDays": 30, "refundShipping": True, "reasons": ["Changed mind"]},
        })
        assert saved.status_code == 200, saved.text

        after = client.get("/api/admin/settings/billing", headers=admin_auth).json()["data"]
        assert after["refund"]["reasons"] == ["Changed mind"]
        assert after["refund"]["windowDays"] == 30

    def test_an_editor_still_may_not_save_settings(self, client, editor, settings_documents):
        """The merge changed how a save is stored, not who may make one."""
        response = client.post("/api/admin/auth/login",
                               json={"email": editor.email, "password": "Admin@123"})
        token = response.json()["data"]["token"]["accessToken"]

        assert client.put("/api/admin/settings/billing",
                          headers={"Authorization": f"Bearer {token}"},
                          json={"currency": {}}).status_code == 403


class TestNumberFormatsAreFixed:
    """Prefixes, starting numbers and lengths are code, not settings."""

    def test_the_formats_cannot_be_changed_through_settings(self, client, admin_auth, settings_documents):
        current = client.get("/api/admin/settings/billing", headers=admin_auth).json()["data"]
        assert current["invoice"]["prefix"] == "DCZ-INV" and current["order"]["prefix"] == "DCZ"
        for section, field, value in (
            ("invoice", "prefix", "HACK"), ("invoice", "startNumber", 900), ("invoice", "padding", 2),
            ("creditNote", "prefix", "X"), ("refund", "prefix", ""), ("order", "prefix", "ORD"),
            ("order", "startNumber", 1), ("sku", "prefix", "ZZ"),
        ):
            body = {section: {**current[section], field: value}}
            response = client.put("/api/admin/settings/billing", headers=admin_auth, json=body)
            assert response.status_code == 422, (section, field, response.text)
            assert response.json()["error_code"] == "NUMBERING_LOCKED"
        after = client.get("/api/admin/settings/billing", headers=admin_auth).json()["data"]
        assert after["invoice"]["prefix"] == "DCZ-INV" and after["refund"]["prefix"] == "DCZ-RF"

    def test_sending_the_formats_back_unchanged_still_saves(self, client, admin_auth, settings_documents, db):
        from app.models import SettingDocument

        current = client.get("/api/admin/settings/billing", headers=admin_auth).json()["data"]
        current["invoice"] = {**current["invoice"], "dueDays": 30}
        assert client.put("/api/admin/settings/billing", headers=admin_auth, json=current).status_code == 200
        stored = db.get(SettingDocument, "billing").value
        # The fixed fields are never written into the document.
        assert "prefix" not in stored["invoice"] and stored["invoice"]["dueDays"] == 30

    def test_an_old_document_with_other_formats_is_overruled(self, client, admin_auth, settings_documents, db):
        from app.models import SettingDocument

        row = db.get(SettingDocument, "billing")
        row.value = {**row.value, "invoice": {**row.value["invoice"], "prefix": "OLD", "padding": 2},
                     "order": {"prefix": "", "startNumber": 1}}
        db.flush()
        data = client.get("/api/admin/settings/billing", headers=admin_auth).json()["data"]
        assert data["invoice"]["prefix"] == "DCZ-INV" and data["invoice"]["padding"] == 6
        assert data["order"] == {"prefix": "DCZ", "startNumber": 10001}

    def test_yearly_numbers_grow_past_their_minimum_length(self, db):
        from datetime import datetime

        from app.core import numbering
        from app.models import CreditNote

        assert numbering.INVOICE.yearly(2026, 214) == "DCZ-INV-2026-000214"
        assert numbering.INVOICE.yearly(2026, 1234567) == "DCZ-INV-2026-1234567"
        # The highest is read as a number: 99999 then 100000, not back to 1.
        assert numbering.highest(db, CreditNote.credit_note_number) == 0
        assert numbering.next_yearly(db, numbering.CREDIT_NOTE, CreditNote.credit_note_number,
                                     datetime(2026, 1, 1)) == "DCZ-CN-2026-00001"

    def test_the_support_request_prefix_is_fixed(self, client, admin_auth):
        response = client.put("/api/admin/support/config/settings", headers=admin_auth, json={"ticketPrefix": "ABC"})
        assert response.status_code == 422 and response.json()["error_code"] == "NUMBERING_LOCKED"
        unchanged = client.put("/api/admin/support/config/settings", headers=admin_auth, json={"ticketPrefix": "DCZ"})
        assert unchanged.status_code == 200

    def test_the_highest_number_survives_a_malformed_one(self, client, auth, catalogue, settings_documents, db):
        """A refund once went out as "-2026-22"; the series must carry on from 22."""
        from app.core import numbering
        from app.models import Order

        ids = [place(client, auth).json()["data"]["order"]["id"] for _ in range(2)]
        db.get(Order, ids[0]).order_number = "-2026-22"
        db.get(Order, ids[1]).order_number = "DCZ-RF-2026-00002"
        db.flush()
        assert numbering.highest(db, Order.order_number) == 22
        db.get(Order, ids[1]).order_number = "DCZ-RF-2026-1000000"
        db.flush()
        assert numbering.highest(db, Order.order_number) == 1000000
