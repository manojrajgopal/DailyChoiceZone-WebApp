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
        "DCZ9" must not out-sort "DCZ10".

        A string maximum over the column put a shorter number on top and sent
        the sequence backwards, which is the other way to collide.
        """
        from app.models import Product, SettingDocument

        db.get(SettingDocument, "billing").value = {
            **db.get(SettingDocument, "billing").value,
            "order": {"prefix": "DCZ", "startNumber": 1},
        }
        # Eleven orders of one unit each, so the sequence has to cross 9 to 10.
        db.get(Product, "PRD001").stock = 20
        db.flush()

        numbers = []
        for _ in range(11):
            response = place(client, auth)
            assert response.status_code == 201, response.text
            numbers.append(response.json()["data"]["order"]["orderNumber"])

        assert numbers[-1] == "DCZ11"
        assert len(set(numbers)) == len(numbers)

    def test_it_steps_over_a_number_already_taken(
        self, client, auth, catalogue, settings_documents, db
    ):
        """
        A gap in the series is fine; a collision is a failed checkout.

        This is the state the broken numbering left behind: an order whose
        number does not belong to the configured series at all.
        """
        from app.models import Order, SettingDocument

        first = place(client, auth)
        assert first.status_code == 201, first.text

        db.get(Order, first.json()["data"]["order"]["id"]).order_number = "1"
        db.get(SettingDocument, "billing").value = {
            **db.get(SettingDocument, "billing").value,
            "order": {"prefix": "", "startNumber": 1},
        }
        db.flush()

        second = place(client, auth)
        assert second.status_code == 201, second.text
        assert second.json()["data"]["order"]["orderNumber"] != "1"


class TestSavingConfiguration:
    def test_a_save_does_not_delete_what_it_does_not_send(
        self, client, admin_auth, settings_documents, db
    ):
        """
        The actual bug: the billing screen knows nothing about `order`.

        It posts the document it understands, and that used to be stored as the
        whole document — taking the order-number prefix with it.
        """
        from app.models import SettingDocument

        db.get(SettingDocument, "billing").value = {
            **db.get(SettingDocument, "billing").value,
            "order": {"prefix": "DCZ", "startNumber": 10001},
        }
        db.flush()

        posted = client.get("/api/admin/settings/billing", headers=admin_auth).json()["data"]
        del posted["order"]
        posted["invoice"] = {**posted["invoice"], "dueDays": 21}

        saved = client.put("/api/admin/settings/billing", headers=admin_auth, json=posted)
        assert saved.status_code == 200, saved.text

        after = client.get("/api/admin/settings/billing", headers=admin_auth).json()["data"]
        assert after["order"] == {"prefix": "DCZ", "startNumber": 10001}
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
