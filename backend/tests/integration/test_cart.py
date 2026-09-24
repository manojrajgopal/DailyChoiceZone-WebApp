"""
The cart, and the fact that the server prices it.

The important tests here are the ones about *authority*: a cart belongs to an
account, and every figure on it is worked out by the server. A client that
could name its own total would eventually name a smaller one.
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.integration


def add(client, auth, product_id="PRD001", quantity=1, **extra):
    return client.post("/api/cart/items", headers=auth,
                       json={"productId": product_id, "quantity": quantity, **extra})


class TestAccess:
    def test_the_cart_needs_an_account(self, client):
        assert client.get("/api/cart").status_code == 401

    def test_an_admin_token_is_not_a_customer_token(self, client, admin_auth, catalogue):
        """
        A valid token for the wrong actor must not open a customer's cart.

        The signature checks out either way — it is the `actor` claim that
        makes this a 403 rather than a way to read somebody's bag.
        """
        assert client.get("/api/cart", headers=admin_auth).status_code == 403


class TestAddingAndRemoving:
    def test_add_an_item(self, client, auth, catalogue, settings_documents):
        response = add(client, auth, "PRD001", 2)
        assert response.status_code == 201, response.text

        items = response.json()["data"]["items"]
        assert len(items) == 1
        assert items[0]["quantity"] == 2
        assert items[0]["product"]["id"] == "PRD001"

    def test_the_same_variant_twice_is_one_line(self, client, auth, catalogue, settings_documents):
        """Two of the same shirt in the same size is quantity two, not two lines."""
        add(client, auth, "PRD001", 1)
        response = add(client, auth, "PRD001", 2)

        items = response.json()["data"]["items"]
        assert len(items) == 1
        assert items[0]["quantity"] == 3

    def test_different_sizes_are_different_lines(self, client, auth, catalogue, settings_documents):
        add(client, auth, "PRD001", 1, size="M")
        response = add(client, auth, "PRD001", 1, size="L")
        assert len(response.json()["data"]["items"]) == 2

    def test_change_a_quantity(self, client, auth, catalogue, settings_documents):
        line = add(client, auth, "PRD001", 1).json()["data"]["items"][0]["id"]
        response = client.put(f"/api/cart/items/{line}", headers=auth, json={"quantity": 4})
        assert response.json()["data"]["items"][0]["quantity"] == 4

    def test_a_quantity_of_zero_removes_the_line(self, client, auth, catalogue, settings_documents):
        line = add(client, auth, "PRD001", 2).json()["data"]["items"][0]["id"]
        response = client.put(f"/api/cart/items/{line}", headers=auth, json={"quantity": 0})
        assert response.json()["data"]["items"] == []

    def test_remove_a_line(self, client, auth, catalogue, settings_documents):
        line = add(client, auth, "PRD001", 1).json()["data"]["items"][0]["id"]
        assert client.delete(f"/api/cart/items/{line}", headers=auth).json()["data"]["items"] == []

    def test_empty_the_cart(self, client, auth, catalogue, settings_documents):
        add(client, auth, "PRD001", 1)
        add(client, auth, "PRD002", 1)
        assert client.delete("/api/cart", headers=auth).json()["data"]["items"] == []

    def test_cannot_touch_a_line_in_someone_elses_cart(self, client, auth, catalogue,
                                                       settings_documents, db, other_customer):
        from app.models import CartItem

        theirs = CartItem(customer_id=other_customer.id, product_id="PRD001", quantity=1)
        db.add(theirs)
        db.flush()

        assert client.put(f"/api/cart/items/{theirs.id}", headers=auth,
                          json={"quantity": 99}).status_code == 404
        assert client.delete(f"/api/cart/items/{theirs.id}", headers=auth).status_code == 404


class TestStock:
    def test_a_quantity_beyond_the_stock_is_capped_to_it(self, client, auth, catalogue,
                                                         settings_documents):
        """
        PRD002 has three. Asking for four puts three in the bag.

        Capping rather than refusing is the kinder answer — somebody who wants
        four of something with three left almost certainly wants the three —
        and it is safe because the *order* re-checks the stock inside the
        transaction that takes it.
        """
        response = add(client, auth, "PRD002", 4)
        assert response.status_code == 201
        assert response.json()["data"]["items"][0]["quantity"] == 3

    def test_cannot_add_something_sold_out(self, client, auth, catalogue, settings_documents):
        response = add(client, auth, "PRD003", 1)
        assert response.status_code in (409, 422)

    def test_cannot_add_a_draft_product(self, client, auth, catalogue, settings_documents):
        """Not published means not buyable, not merely not listed."""
        response = add(client, auth, "PRD004", 1)
        assert response.status_code in (404, 409, 422)

    def test_raising_a_quantity_is_capped_the_same_way(self, client, auth, catalogue,
                                                       settings_documents):
        line = add(client, auth, "PRD002", 1).json()["data"]["items"][0]["id"]
        response = client.put(f"/api/cart/items/{line}", headers=auth, json={"quantity": 10})
        assert response.status_code == 200
        assert response.json()["data"]["items"][0]["quantity"] == 3


class TestPricing:
    def test_the_server_returns_the_whole_breakdown(self, client, auth, catalogue,
                                                    settings_documents):
        breakdown = add(client, auth, "PRD001", 2).json()["data"]["breakdown"]

        assert breakdown["subtotal"] == 200_000  # 2 x 1000 rupees, in paise
        assert breakdown["productDiscount"] == 50_000  # 2 x 250 off the list price
        assert breakdown["itemCount"] == 2
        assert breakdown["grandTotal"] > 0

    def test_tax_is_extracted_not_added_when_prices_include_it(self, client, auth, catalogue,
                                                               settings_documents):
        breakdown = add(client, auth, "PRD001", 1).json()["data"]["breakdown"]
        tax = breakdown["tax"]

        assert tax["totalTax"] > 0
        assert tax["taxableAmount"] + tax["totalTax"] == breakdown["subtotal"]
        assert breakdown["grandTotal"] == breakdown["subtotal"] + breakdown["shipping"]

    def test_free_delivery_above_the_threshold(self, client, auth, catalogue, settings_documents):
        """The threshold is ₹999; one kurta is ₹1000."""
        assert add(client, auth, "PRD001", 1).json()["data"]["breakdown"]["shipping"] == 0

    def test_an_empty_cart_totals_nothing(self, client, auth, settings_documents):
        breakdown = client.get("/api/cart", headers=auth).json()["data"]["breakdown"]
        assert breakdown["grandTotal"] == 0
        assert breakdown["itemCount"] == 0

    def test_a_coupon_reduces_the_total(self, client, auth, catalogue, settings_documents, coupon):
        add(client, auth, "PRD001", 2)

        plain = client.get("/api/cart", headers=auth).json()["data"]["breakdown"]
        discounted = client.get("/api/cart?coupon=SAVE10",
                                headers=auth).json()["data"]["breakdown"]

        assert discounted["couponDiscount"] == 20_000  # 10% of ₹2000, under the ₹500 cap
        assert discounted["grandTotal"] == plain["grandTotal"] - 20_000

    def test_an_unknown_coupon_changes_nothing(self, client, auth, catalogue, settings_documents):
        add(client, auth, "PRD001", 1)

        plain = client.get("/api/cart", headers=auth).json()["data"]["breakdown"]
        bogus = client.get("/api/cart?coupon=FREEMONEY",
                           headers=auth).json()["data"]["breakdown"]

        assert bogus["grandTotal"] == plain["grandTotal"]
        assert bogus["couponDiscount"] == 0

    def test_the_place_of_supply_changes_the_split_not_the_total(self, client, auth, catalogue,
                                                                 settings_documents):
        """
        Crossing a state line moves the tax from CGST+SGST to IGST.

        The rate is the same, so the customer pays the same — only the
        composition on the invoice changes.
        """
        add(client, auth, "PRD001", 1)

        home = client.get("/api/cart?placeOfSupply=Karnataka",
                          headers=auth).json()["data"]["breakdown"]
        away = client.get("/api/cart?placeOfSupply=Maharashtra",
                          headers=auth).json()["data"]["breakdown"]

        assert home["tax"]["cgst"] > 0 and home["tax"]["igst"] == 0
        assert away["tax"]["igst"] > 0 and away["tax"]["cgst"] == 0
        assert home["grandTotal"] == away["grandTotal"]
        assert home["tax"]["totalTax"] == away["tax"]["totalTax"]
