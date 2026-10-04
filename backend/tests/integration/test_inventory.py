"""
Stock, and the ledger of changes to it.

Stock lives on the product — one number, not two that can disagree — and every
change to it is recorded as an adjustment, so "why is this figure what it is"
has an answer.
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.integration


class TestReading:
    def test_lists_products_with_their_stock(self, client, admin_auth, catalogue):
        response = client.get("/api/admin/inventory", headers=admin_auth)
        assert response.status_code == 200

        by_id = {item["productId"]: item for item in response.json()["data"]}
        assert by_id["PRD001"]["stock"] == 10
        assert by_id["PRD003"]["stock"] == 0

    def test_a_draft_product_is_still_stock_to_manage(self, client, admin_auth, catalogue):
        """Unlike the storefront, the warehouse view shows everything."""
        ids = {item["productId"] for item in
               client.get("/api/admin/inventory", headers=admin_auth).json()["data"]}
        assert "PRD004" in ids

    def test_the_adjustment_log_starts_empty(self, client, admin_auth, catalogue):
        response = client.get("/api/admin/inventory/log", headers=admin_auth)
        assert response.status_code == 200
        assert response.json()["data"] == []


class TestAdjusting:
    def test_set_a_new_level(self, client, admin_auth, catalogue, db):
        from app.models import Product

        response = client.put("/api/admin/inventory/PRD001", headers=admin_auth,
                              json={"quantity": 25, "reason": "Stock count"})
        assert response.status_code == 200

        db.expire_all()
        assert db.get(Product, "PRD001").stock == 25

    def test_the_change_is_written_to_the_ledger(self, client, admin_auth, catalogue):
        client.put("/api/admin/inventory/PRD001", headers=admin_auth,
                   json={"quantity": 25, "reason": "Stock count"})

        entries = client.get("/api/admin/inventory/log", headers=admin_auth).json()["data"]
        assert len(entries) == 1

        entry = entries[0]
        assert entry["productId"] == "PRD001"
        assert entry["reason"] == "Stock count"
        assert entry["quantityBefore"] == 10
        assert entry["quantityAfter"] == 25
        assert entry["delta"] == 15

    def test_the_ledger_records_who_did_it(self, client, admin_auth, catalogue, admin):
        """
        Taken from the token, not from the payload.

        An audit trail a client can write its own name into is not one.
        """
        client.put("/api/admin/inventory/PRD001", headers=admin_auth,
                   json={"quantity": 5, "reason": "Damaged", "by": "somebody-else"})

        entry = client.get("/api/admin/inventory/log", headers=admin_auth).json()["data"][0]
        assert entry["by"] == admin.id

    def test_selling_out_a_product_is_recorded_too(self, client, admin_auth, catalogue, db):
        from app.models import Product

        client.put("/api/admin/inventory/PRD001", headers=admin_auth,
                   json={"quantity": 0, "reason": "Withdrawn"})

        db.expire_all()
        assert db.get(Product, "PRD001").stock == 0

    def test_negative_stock_is_refused(self, client, admin_auth, catalogue):
        response = client.put("/api/admin/inventory/PRD001", headers=admin_auth,
                              json={"quantity": -5, "reason": "Nonsense"})
        assert response.status_code == 422

    def test_an_unknown_product(self, client, admin_auth, catalogue):
        response = client.put("/api/admin/inventory/PRD999", headers=admin_auth,
                              json={"quantity": 5, "reason": "Nowhere"})
        assert response.status_code == 404

    def test_adjusting_stock_needs_a_token(self, client, catalogue):
        assert client.put("/api/admin/inventory/PRD001",
                          json={"quantity": 5, "reason": "Nope"}).status_code == 401

    def test_a_customer_cannot_adjust_stock(self, client, auth, catalogue):
        assert client.put("/api/admin/inventory/PRD001", headers=auth,
                          json={"quantity": 5, "reason": "Nope"}).status_code == 403


class TestOrdersMoveStock:
    def test_an_order_writes_an_adjustment(self, client, auth, admin_auth, catalogue,
                                           settings_documents):
        """
        The ledger explains the level.

        Stock that moves without a record is a number nobody can account for,
        so a sale leaves the same kind of entry a manual count does.
        """
        client.post("/api/cart/items", headers=auth,
                    json={"productId": "PRD001", "quantity": 2})
        client.post("/api/orders", headers=auth, json={
            "shippingAddress": {
                "fullName": "Asha Rao", "phone": "9876500001", "line1": "4 Brigade Road",
                "line2": "", "city": "Bengaluru", "state": "Karnataka",
                "pincode": "560001", "country": "India", "email": "shopper@example.com",
            },
            "billingAddress": None, "deliveryMethod": "standard",
            "paymentMethod": "cod", "couponCode": None,
            "email": "shopper@example.com", "saveAddress": False,
        })

        entries = client.get("/api/admin/inventory/log", headers=admin_auth).json()["data"]
        sale = [e for e in entries if e["productId"] == "PRD001"]

        assert sale, "the sale left no trace in the ledger"
        assert sale[0]["quantityBefore"] == 10
        assert sale[0]["quantityAfter"] == 8
        assert sale[0]["delta"] == -2


class TestLogByProductId:
    """`productId` keeps one product's movements, matched exactly by Product ID or SKU."""

    @pytest.fixture
    def movements(self, client, admin_auth, catalogue):
        for product_id, quantity in (("PRD001", 25), ("PRD002", 7), ("PRD001", 30)):
            assert client.put(f"/api/admin/inventory/{product_id}", headers=admin_auth,
                              json={"quantity": quantity, "reason": "Stock count"}).status_code == 200

    def _log(self, client, admin_auth, **params):
        response = client.get("/api/admin/inventory/log", headers=admin_auth, params=params)
        assert response.status_code == 200, response.text
        return response.json()["data"]

    def test_unfiltered_shows_every_movement(self, client, admin_auth, movements):
        assert len(self._log(client, admin_auth)) == 3

    def test_product_id_keeps_only_that_product(self, client, admin_auth, movements):
        entries = self._log(client, admin_auth, productId="PRD001")
        assert [e["productId"] for e in entries] == ["PRD001", "PRD001"]
        assert [e["quantityAfter"] for e in entries] == [30, 25]

    def test_sku_and_spacing_normalise_to_the_same_product(self, client, admin_auth, movements):
        assert len(self._log(client, admin_auth, productId=" prd-002 ")) == 1
        assert len(self._log(client, admin_auth, productId="DCZ-WO0002")) == 1

    def test_a_prefix_is_not_a_match(self, client, admin_auth, movements):
        assert self._log(client, admin_auth, productId="PRD00") == []

    def test_a_name_matches_nothing(self, client, admin_auth, movements):
        assert self._log(client, admin_auth, productId="Cotton Kurta") == []

    def test_junk_is_an_empty_list_not_an_error(self, client, admin_auth, movements):
        assert self._log(client, admin_auth, productId="'; DROP TABLE stock_adjustments; --") == []
