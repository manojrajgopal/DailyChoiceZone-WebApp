"""The comparison list: adding, the limit, replacing, merging a guest list, and who may see it."""

from __future__ import annotations

import pytest

from app.core import rate_limit
from app.models import ComparisonItem, Product

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def more_products(db, catalogue):
    """Two more listed products, so the limit of four can be reached."""
    for index in (5, 6):
        db.add(Product(id=f"PRD00{index}", slug=f"extra-{index}", sku=f"DCZ-EX000{index}", name=f"Extra {index}",
                       brand="Anvi", category_id="CAT001", subcategory="tops", price=500.0, original_price=500.0,
                       discount=0, stock=5, status="active"))
    db.flush()


def add(client, auth, product, replace=""):
    suffix = f"?replace={replace}" if replace else ""
    return client.post(f"/api/compare/{product}{suffix}", headers=auth)


class TestTheList:
    def test_add_and_read_back(self, client, auth, catalogue):
        assert add(client, auth, "PRD001").json()["data"]["productIds"] == ["PRD001"]
        add(client, auth, "linen-shirt")  # by slug too
        data = client.get("/api/compare", headers=auth).json()["data"]
        assert [p["id"] for p in data["items"]] == ["PRD001", "PRD002"]
        assert data["items"][0]["specifications"] is not None and data["limit"] == 4

    def test_adding_twice_keeps_one(self, client, db, auth, catalogue):
        add(client, auth, "PRD001")
        add(client, auth, "PRD001")
        assert db.query(ComparisonItem).count() == 1

    def test_unlisted_and_unknown_products_are_refused(self, client, auth, catalogue):
        assert add(client, auth, "PRD004").status_code == 404  # a draft
        assert add(client, auth, "NOPE").status_code == 404

    def test_out_of_stock_products_can_be_compared(self, client, auth, catalogue):
        assert add(client, auth, "PRD003").status_code == 200

    def test_the_fifth_is_refused_with_the_list(self, client, auth, more_products):
        for product in ("PRD001", "PRD002", "PRD003", "PRD005"):
            assert add(client, auth, product).status_code == 200
        full = add(client, auth, "PRD006")
        assert full.status_code == 409
        assert full.json()["error_code"] == "COMPARISON_FULL"

    def test_replacing_one_when_full(self, client, auth, more_products):
        for product in ("PRD001", "PRD002", "PRD003", "PRD005"):
            add(client, auth, product)
        swapped = add(client, auth, "PRD006", replace="PRD002")
        assert swapped.status_code == 200
        assert swapped.json()["data"]["productIds"] == ["PRD001", "PRD003", "PRD005", "PRD006"]

    def test_a_product_that_is_unlisted_drops_out(self, client, db, auth, catalogue):
        add(client, auth, "PRD001")
        add(client, auth, "PRD002")
        db.get(Product, "PRD002").status = "archived"
        db.flush()
        assert client.get("/api/compare/ids", headers=auth).json()["data"]["productIds"] == ["PRD001"]

    def test_remove_and_clear(self, client, auth, catalogue):
        add(client, auth, "PRD001")
        add(client, auth, "PRD002")
        assert client.delete("/api/compare/PRD001", headers=auth).json()["data"]["productIds"] == ["PRD002"]
        assert client.delete("/api/compare", headers=auth).json()["data"]["productIds"] == []

    def test_a_guest_list_is_merged_at_sign_in(self, client, auth, more_products):
        add(client, auth, "PRD001")
        merged = client.post("/api/compare/merge", headers=auth,
                             json={"productIds": ["PRD002", "PRD001", "BOGUS", "PRD004", "PRD003", "PRD005", "PRD006"]})
        assert merged.json()["data"]["productIds"] == ["PRD001", "PRD002", "PRD003", "PRD005"]

    def test_lists_are_private(self, client, auth, other_customer, catalogue):
        add(client, auth, "PRD001")
        token = client.post("/api/auth/login", json={"email": other_customer.email, "password": "Customer@123"}
                            ).json()["data"]["token"]["accessToken"]
        theirs = client.get("/api/compare/ids", headers={"Authorization": f"Bearer {token}"}).json()["data"]
        assert theirs["productIds"] == []
        assert client.get("/api/compare").status_code == 401
