"""
Bundles: no stock of their own — what can be sold comes from the components —
priced by the server, ordered as component lines that carry the bundle, taxed
per component, and stock returned per component when an order is cancelled.
"""

from __future__ import annotations

import pytest

from app.core import rate_limit
from app.models import CartBundle, InvoiceItem, Order, OrderItem, Product
from tests.integration.wallet_helpers import fill_bag, mailbox, place  # noqa: F401

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def gadget(db, catalogue):
    """A second-category product in stock, so tax can differ per component."""
    db.add(Product(id="PRD005", slug="phone-stand", sku="DCZ-EL0005", name="Phone Stand", brand="Meridian",
                   category_id="CAT002", subcategory="accessories", price=500.0, original_price=500.0, discount=0,
                   stock=8, status="active", rating=0, review_count=0))
    db.flush()


@pytest.fixture()
def shop(client, catalogue, gadget, customer, settings_documents, admin_auth, auth):
    return client


def make_bundle(client, admin_auth, *, expect=201, **overrides):
    body = {"name": "Office Look", "description": "A kurta, a shirt and a stand", "status": "active",
            "pricing": "fixed", "fixedPrice": 2999, "maxPerOrder": 3,
            "items": [{"productId": "PRD001", "quantity": 1}, {"productId": "PRD002", "quantity": 1},
                      {"productId": "PRD005", "quantity": 2}], **overrides}
    response = client.post("/api/admin/bundles", headers=admin_auth, json=body)
    assert response.status_code == expect, response.text
    return response.json()["data"] if expect == 201 else response.json()


def add(client, auth, bundle_id, quantity=1, expect=201):
    response = client.post("/api/cart/bundles", headers=auth, json={"bundleId": bundle_id, "quantity": quantity})
    assert response.status_code == expect, response.text
    return response.json()["data"] if expect == 201 else response.json()


class TestSettingUp:
    def test_a_bundle_needs_two_products_and_a_lower_price(self, shop, admin_auth):
        assert make_bundle(shop, admin_auth, items=[{"productId": "PRD001"}], expect=422)["error_code"] == "ITEMS_REQUIRED"
        # 1,000 + 2,000 + 2 × 500 = 4,000: the bundle must cost less.
        assert make_bundle(shop, admin_auth, fixedPrice=4000, expect=422)["error_code"] == "INVALID_PRICE"
        assert make_bundle(shop, admin_auth, pricing="percent", discountPercent=95, expect=422)["error_code"] == \
            "INVALID_DISCOUNT"

    def test_availability_is_the_scarcest_component(self, shop, admin_auth):
        bundle = make_bundle(shop, admin_auth)
        # PRD002 has 3, PRD001 10, PRD005 8 ÷ 2 = 4.
        assert bundle["available"] == 3
        assert bundle["price"] == 2999 and bundle["regularPrice"] == 4000 and bundle["saving"] == 1001

    def test_a_percentage_bundle(self, shop, admin_auth):
        bundle = make_bundle(shop, admin_auth, pricing="percent", discountPercent=10)
        assert bundle["price"] == 3600

    def test_only_permitted_staff_can_manage_bundles(self, shop, auth):
        assert shop.get("/api/admin/bundles", headers=auth).status_code == 403
        assert shop.post("/api/admin/bundles", json={}).status_code == 401


class TestStorefront:
    def test_drafts_are_hidden_and_live_bundles_are_listed(self, shop, admin_auth):
        live = make_bundle(shop, admin_auth)
        make_bundle(shop, admin_auth, name="Hidden", status="draft")
        listed = shop.get("/api/bundles").json()["data"]
        assert [b["slug"] for b in listed] == [live["slug"]]
        assert shop.get("/api/bundles/hidden").status_code == 404
        on_product = shop.get("/api/bundles?productId=PRD005").json()["data"]
        assert on_product and on_product[0]["id"] == live["id"]

    def test_sizes_must_be_chosen_when_a_component_has_them(self, shop, admin_auth, auth, db):
        from app.models import ProductSize

        db.add(ProductSize(product_id="PRD001", label="M", position=0))
        db.flush()
        bundle = make_bundle(shop, admin_auth)
        assert add(shop, auth, bundle["id"], expect=422)["error_code"] == "SIZE_REQUIRED"
        response = shop.post("/api/cart/bundles", headers=auth, json={
            "bundleId": bundle["id"], "selections": [{"productId": "PRD001", "size": "XXL"}]})
        assert response.json()["error_code"] == "SIZE_UNAVAILABLE"
        response = shop.post("/api/cart/bundles", headers=auth, json={
            "bundleId": bundle["id"], "selections": [{"productId": "PRD001", "size": "M"}]})
        assert response.status_code == 201
        component = response.json()["data"]["bundles"][0]["components"][0]
        assert component["size"] == "M"

    def test_the_bag_prices_the_bundle(self, shop, admin_auth, auth):
        bundle = make_bundle(shop, admin_auth)
        bag = add(shop, auth, bundle["id"], 2)
        assert bag["bundles"][0]["lineTotal"] == 2 * 299900
        assert bag["breakdown"]["subtotal"] == 2 * 299900
        # Two bundles of 1 + 1 + 2 items: the badge and the bag agree.
        assert shop.get("/api/cart/count", headers=auth).json()["data"]["itemCount"] == 8 == bag["breakdown"]["itemCount"]

    def test_more_than_the_components_allow_is_capped(self, shop, admin_auth, auth):
        bundle = make_bundle(shop, admin_auth, maxPerOrder=10)
        bag = add(shop, auth, bundle["id"], 9)
        assert bag["bundles"][0]["quantity"] == 3

    def test_someone_elses_bundle_line_cannot_be_touched(self, shop, admin_auth, auth, db, other_customer, client):
        bundle = make_bundle(shop, admin_auth)
        add(shop, auth, bundle["id"])
        entry = db.query(CartBundle).one()
        token = client.post("/api/auth/login", json={"email": other_customer.email, "password": "Customer@123"})
        other = {"Authorization": f"Bearer {token.json()['data']['token']['accessToken']}"}
        assert shop.delete(f"/api/cart/bundles/{entry.id}", headers=other).status_code == 404
        assert db.query(CartBundle).count() == 1


class TestOrdering:
    def test_the_order_has_component_lines_that_add_up_to_the_bundle(self, shop, admin_auth, auth, db):
        bundle = make_bundle(shop, admin_auth)
        add(shop, auth, bundle["id"], 2)
        order = place(shop, auth)["order"]
        lines = db.query(OrderItem).filter_by(order_id=order["id"]).order_by(OrderItem.id).all()
        assert [(l.product_id, l.quantity) for l in lines] == [("PRD001", 2), ("PRD002", 2), ("PRD005", 4)]
        assert {l.bundle_name for l in lines} == {"Office Look"}
        assert {l.bundle_quantity for l in lines} == {2}
        assert len({l.bundle_group for l in lines}) == 1
        assert round(sum(float(l.line_total) for l in lines), 2) == 2 * 2999
        assert float(db.get(Order, order["id"]).subtotal) == 5998

    def test_each_component_is_taxed_at_its_own_rate(self, shop, admin_auth, auth, db):
        bundle = make_bundle(shop, admin_auth)
        add(shop, auth, bundle["id"])
        order = place(shop, auth)["order"]
        invoice_lines = db.query(InvoiceItem).join(InvoiceItem.invoice).filter_by(order_id=order["id"]).all()
        assert len(invoice_lines) == 3
        assert {l.bundle_name for l in invoice_lines} == {"Office Look"}
        assert sum(l.line_subtotal for l in invoice_lines) == 299900
        hsn = {l.product_id: l.hsn for l in invoice_lines}
        assert hsn["PRD001"] != hsn["PRD005"]  # women's wear and electronics keep their own codes

    def test_component_stock_is_taken_and_given_back(self, shop, admin_auth, auth, db):
        bundle = make_bundle(shop, admin_auth)
        add(shop, auth, bundle["id"])
        order = place(shop, auth, method="cod")["order"]
        db.expire_all()
        assert (db.get(Product, "PRD001").stock, db.get(Product, "PRD002").stock, db.get(Product, "PRD005").stock) == (9, 2, 6)
        assert shop.post(f"/api/orders/{order['id']}/cancel", headers=auth, json={"reason": "No"}).status_code == 200
        db.expire_all()
        assert (db.get(Product, "PRD001").stock, db.get(Product, "PRD002").stock, db.get(Product, "PRD005").stock) == (10, 3, 8)

    def test_a_bundle_and_a_loose_item_cannot_oversell_together(self, shop, admin_auth, auth, db):
        bundle = make_bundle(shop, admin_auth)
        add(shop, auth, bundle["id"], 3)  # all three linen shirts
        fill_bag(shop, auth, "PRD002", 1)  # and one more loose
        body = place(shop, auth, expect=409)
        assert body["error_code"] == "INSUFFICIENT_STOCK"
        assert db.query(Order).count() == 0

    def test_a_bundle_that_sold_out_is_refused_at_checkout(self, shop, admin_auth, auth, db):
        bundle = make_bundle(shop, admin_auth)
        add(shop, auth, bundle["id"])
        db.get(Product, "PRD002").stock = 0
        db.flush()
        body = place(shop, auth, expect=409)
        assert body["error_code"] == "INSUFFICIENT_STOCK"
        assert "Linen Shirt" in body["message"]

    def test_two_sizes_of_one_product_cannot_oversell(self, shop, auth, db):
        """Each line passed on its own; together they asked for more than the three there were."""
        from app.models import ProductSize

        db.add_all([ProductSize(product_id="PRD002", label="S", position=0),
                    ProductSize(product_id="PRD002", label="M", position=1)])
        db.flush()
        for size in ("S", "M"):
            response = shop.post("/api/cart/items", headers=auth, json={"productId": "PRD002", "size": size,
                                                                        "quantity": 2})
            assert response.status_code == 201, response.text
        body = place(shop, auth, method="cod", expect=409)
        assert body["error_code"] == "INSUFFICIENT_STOCK"
        db.expire_all()
        assert db.get(Product, "PRD002").stock == 3

    def test_an_ordered_bundle_is_kept_and_reports_its_sales(self, shop, admin_auth, auth):
        bundle = make_bundle(shop, admin_auth)
        add(shop, auth, bundle["id"], 2)
        place(shop, auth)
        assert shop.delete(f"/api/admin/bundles/{bundle['id']}", headers=admin_auth).status_code == 409
        detail = shop.get(f"/api/admin/bundles/{bundle['id']}", headers=admin_auth).json()["data"]
        assert detail["sales"] == {"orders": 1, "units": 2, "revenue": 5998.0}
