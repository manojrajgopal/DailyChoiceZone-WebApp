"""The wishlist. Saved against the account, one row per product."""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.integration


class TestWishlist:
    def test_needs_an_account(self, client):
        assert client.get("/api/wishlist").status_code == 401
        assert client.post("/api/wishlist/PRD001").status_code == 401

    def test_starts_empty(self, client, auth):
        assert client.get("/api/wishlist/ids", headers=auth).json()["data"] == []

    def test_save_a_product(self, client, auth, catalogue):
        response = client.post("/api/wishlist/PRD001", headers=auth)
        assert response.status_code == 201
        assert response.json()["data"] == ["PRD001"]

    def test_saving_twice_does_not_duplicate_it(self, client, auth, catalogue):
        """
        The unique constraint is the guarantee; this is the test of it.

        A merge on sign-in posts every saved id, and an account that already
        had some of them must not end up with two of each.
        """
        client.post("/api/wishlist/PRD001", headers=auth)
        response = client.post("/api/wishlist/PRD001", headers=auth)

        assert response.status_code == 201
        assert response.json()["data"] == ["PRD001"]

    def test_remove_a_product(self, client, auth, catalogue):
        client.post("/api/wishlist/PRD001", headers=auth)
        response = client.delete("/api/wishlist/PRD001", headers=auth)
        assert response.json()["data"] == []

    def test_removing_something_not_saved_is_not_an_error(self, client, auth, catalogue):
        """Idempotent: the end state is what was asked for either way."""
        assert client.delete("/api/wishlist/PRD002", headers=auth).status_code == 200

    def test_the_full_list_returns_products_not_ids(self, client, auth, catalogue):
        client.post("/api/wishlist/PRD001", headers=auth)
        response = client.get("/api/wishlist", headers=auth)

        product = response.json()["data"][0]
        assert product["id"] == "PRD001"
        assert product["name"] == "Cotton Kurta"
        assert "price" in product

    def test_cannot_save_a_product_that_does_not_exist(self, client, auth, catalogue):
        assert client.post("/api/wishlist/PRD999", headers=auth).status_code == 404

    def test_one_customers_wishlist_is_not_anothers(self, client, auth, catalogue,
                                                    db, other_customer):
        from app.models import WishlistItem

        db.add(WishlistItem(customer_id=other_customer.id, product_id="PRD002"))
        db.flush()

        assert client.get("/api/wishlist/ids", headers=auth).json()["data"] == []
