"""
Reorder: a past order's items back in the bag — at today's prices, through
the bag's own checks, partly when only some can be, never for someone
else's order, and without doubling what's already in the bag.
"""

from __future__ import annotations

import pytest

from app.core import rate_limit
from app.models import CartItem, Product, ProductSize, ReorderEvent
from tests.integration.wallet_helpers import fill_bag, mailbox, place  # noqa: F401

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def shop(client, catalogue, customer, settings_documents, admin_auth, auth):
    return client


@pytest.fixture()
def past_order(shop, auth, db):
    """An order of two kurtas and one linen shirt, already placed (the bag is empty again)."""
    fill_bag(shop, auth, "PRD001", 2)
    fill_bag(shop, auth, "PRD002", 1)
    order = place(shop, auth)["order"]
    assert db.query(CartItem).count() == 0
    return order


def lines(client, auth, order_id):
    response = client.get(f"/api/orders/{order_id}/reorder", headers=auth)
    assert response.status_code == 200, response.text
    return {line["productId"]: line for line in response.json()["data"]["items"]}


class TestReorder:
    def test_everything_available_goes_back_in_the_bag(self, shop, auth, past_order, db):
        response = shop.post(f"/api/orders/{past_order['id']}/reorder", headers=auth, json={})
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["units"] == 3 and data["skipped"] == []
        assert response.json()["message"] == "3 items added to your bag."
        bag = {i.product_id: i.quantity for i in db.query(CartItem).all()}
        assert bag == {"PRD001": 2, "PRD002": 1}
        assert db.query(ReorderEvent).one().items_added == 2

    def test_current_prices_are_used_not_the_old_ones(self, shop, auth, past_order, db):
        db.get(Product, "PRD001").price = 1200.0
        db.flush()
        assert lines(shop, auth, past_order["id"])["PRD001"]["currentPrice"] == 1200
        assert lines(shop, auth, past_order["id"])["PRD001"]["orderedUnitPrice"] == 1000
        shop.post(f"/api/orders/{past_order['id']}/reorder", headers=auth, json={})
        bag = shop.get("/api/cart", headers=auth).json()["data"]
        assert bag["breakdown"]["subtotal"] == 2 * 120000 + 200000

    def test_out_of_stock_and_discontinued_items_are_left_out_with_reasons(self, shop, auth, past_order, db):
        db.get(Product, "PRD002").stock = 0
        db.flush()
        data = shop.post(f"/api/orders/{past_order['id']}/reorder", headers=auth, json={}).json()["data"]
        assert [line["productId"] for line in data["added"]] == ["PRD001"]
        assert data["skipped"][0]["status"] == "out_of_stock" and data["skipped"][0]["reason"] == "Out of stock"
        db.get(Product, "PRD001").status = "archived"
        db.flush()
        checked = lines(shop, auth, past_order["id"])
        assert checked["PRD001"]["status"] == "discontinued"

    def test_a_partial_reorder_of_chosen_lines(self, shop, auth, past_order, db):
        keys = {line["productId"]: line["key"] for line in lines(shop, auth, past_order["id"]).values()}
        response = shop.post(f"/api/orders/{past_order['id']}/reorder", headers=auth, json={"keys": [keys["PRD002"]]})
        assert response.json()["data"]["units"] == 1
        assert {i.product_id for i in db.query(CartItem).all()} == {"PRD002"}
        bad = shop.post(f"/api/orders/{past_order['id']}/reorder", headers=auth, json={"keys": ["item:999999"]})
        assert bad.status_code == 422 and bad.json()["error_code"] == "NOTHING_SELECTED"

    def test_stock_limits_what_is_added(self, shop, auth, past_order, db):
        product = db.get(Product, "PRD001")
        product.stock, product.reserved_stock = 1, 0
        db.flush()
        line = lines(shop, auth, past_order["id"])["PRD001"]
        assert line["status"] == "limited" and line["quantity"] == 1
        shop.post(f"/api/orders/{past_order['id']}/reorder", headers=auth, json={})
        assert db.query(CartItem).filter_by(product_id="PRD001").one().quantity == 1

    def test_a_size_no_longer_offered_is_refused(self, shop, auth, db):
        db.add(ProductSize(product_id="PRD002", label="M", position=0))
        db.flush()
        response = shop.post("/api/cart/items", headers=auth, json={"productId": "PRD002", "size": "M"})
        assert response.status_code == 201
        order = place(shop, auth)["order"]
        db.query(ProductSize).filter_by(product_id="PRD002").delete()
        db.add(ProductSize(product_id="PRD002", label="L", position=0))
        db.flush()
        db.expire_all()
        assert lines(shop, auth, order["id"])["PRD002"]["status"] == "variant_unavailable"

    def test_reordering_twice_does_not_double_the_bag(self, shop, auth, past_order, db):
        shop.post(f"/api/orders/{past_order['id']}/reorder", headers=auth, json={})
        again = shop.post(f"/api/orders/{past_order['id']}/reorder", headers=auth, json={}).json()["data"]
        assert again["units"] == 0 and {s["status"] for s in again["skipped"]} == {"in_bag"}
        assert {i.product_id: i.quantity for i in db.query(CartItem).all()} == {"PRD001": 2, "PRD002": 1}

    def test_nothing_is_ordered_or_paid_for(self, shop, auth, past_order, db):
        from app.models import Order

        before = db.query(Order).count()
        shop.post(f"/api/orders/{past_order['id']}/reorder", headers=auth, json={})
        assert db.query(Order).count() == before

    def test_someone_elses_order_cannot_be_reordered(self, shop, auth, past_order, other_customer, client):
        token = client.post("/api/auth/login", json={"email": other_customer.email, "password": "Customer@123"})
        other = {"Authorization": f"Bearer {token.json()['data']['token']['accessToken']}"}
        assert shop.get(f"/api/orders/{past_order['id']}/reorder", headers=other).status_code == 404
        assert shop.post(f"/api/orders/{past_order['id']}/reorder", headers=other, json={}).status_code == 404
        assert shop.get(f"/api/orders/{past_order['id']}/reorder").status_code == 401


class TestFigures:
    def test_the_portal_sees_reorders_and_conversion(self, shop, auth, admin_auth, past_order):
        shop.post(f"/api/orders/{past_order['id']}/reorder", headers=auth, json={})
        place(shop, auth)  # bought again within the week
        report = shop.get("/api/admin/analytics/customers?range=7d", headers=admin_auth).json()["data"]
        reorders = report["reorders"]
        assert reorders["reorders"] == 1 and reorders["converted"] == 1 and reorders["conversion"] == 100.0
        assert {p["productId"] for p in reorders["topProducts"]} == {"PRD001", "PRD002"}
        assert reorders["repeatCustomers"] == 1
