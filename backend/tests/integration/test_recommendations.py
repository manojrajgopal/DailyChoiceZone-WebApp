"""
Related products and recommendations: the store's own choices first, then a
score over what products share, then fallbacks — never the product itself,
never anything unpublished, out of stock only after everything in stock — and
the portal screens that manage the choices.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

pytestmark = pytest.mark.integration


@pytest.fixture()
def shelf(db, catalogue):
    """
    A kitchen shelf around PRD010 (a steel plate):

    PRD011 bowl      same subcategory, same brand, shares two tags
    PRD012 spoon     same category, other subcategory
    PRD013 glass     other category, same brand
    PRD014 tray      same subcategory, but out of stock
    PRD015 jug       same subcategory, draft
    PRD016 mat       other category and brand entirely
    """
    from app.models import Category, Product, ProductTag

    db.add(Category(id="CAT010", slug="kitchen", name="Kitchen", display_order=3))
    db.add(Category(id="CAT011", slug="dining", name="Dining", display_order=4))

    def product(pid, name, category, sub, brand, price, *, stock=10, status="active", rating=4.0, seller=False):
        return Product(id=pid, slug=name.lower().replace(" ", "-"), sku=f"DCZ-KT{pid[3:]}", name=name, brand=brand,
                       category_id=category, subcategory=sub, price=price, original_price=price, discount=0,
                       stock=stock, status=status, rating=rating, review_count=3, is_best_seller=seller)

    db.add_all([
        product("PRD010", "Steel Plate", "CAT010", "tableware", "Ardent", 500),
        product("PRD011", "Steel Bowl", "CAT010", "tableware", "Ardent", 450),
        product("PRD012", "Steel Spoon", "CAT010", "cutlery", "Other", 150),
        product("PRD013", "Steel Glass", "CAT011", "drinkware", "Ardent", 300),
        product("PRD014", "Steel Tray", "CAT010", "tableware", "Ardent", 520, stock=0, status="out-of-stock"),
        product("PRD015", "Steel Jug", "CAT010", "tableware", "Ardent", 510, status="draft"),
        product("PRD016", "Table Mat", "CAT011", "linen", "Loom", 999, seller=True, rating=4.9),
    ])
    db.flush()
    db.add_all([ProductTag(product_id="PRD010", tag="steel"), ProductTag(product_id="PRD010", tag="dinner"),
                ProductTag(product_id="PRD011", tag="steel"), ProductTag(product_id="PRD011", tag="dinner")])
    db.flush()


def related(client, pid="PRD010", **params):
    response = client.get(f"/api/products/{pid}/related", params=params)
    assert response.status_code == 200, response.text
    return [p["id"] for p in response.json()["data"]]


class TestAutomatic:
    def test_closest_first(self, client, shelf):
        out = related(client, limit=6)
        assert out[0] == "PRD011"  # same subcategory, brand and tags
        assert out.index("PRD012") < out.index("PRD016")

    def test_never_itself_and_never_unpublished(self, client, shelf):
        out = related(client, limit=24)
        assert "PRD010" not in out
        assert "PRD015" not in out  # draft
        assert "PRD004" not in out  # the catalogue fixture's draft

    def test_out_of_stock_comes_after_everything_in_stock(self, client, shelf):
        out = related(client, limit=24)
        assert "PRD014" in out
        in_stock_after = [pid for pid in out[out.index("PRD014") + 1:] if pid not in ("PRD003",)]
        assert in_stock_after == []

    def test_a_product_with_nothing_in_common_still_gets_a_rail(self, client, db, shelf):
        """Fallback to best sellers rather than an empty section."""
        from app.models import Category, Product

        db.add(Category(id="CAT099", slug="lonely", name="Lonely", display_order=9))
        db.add(Product(id="PRD099", slug="lonely", sku="DCZ-LN0099", name="Lonely", brand="Nobody",
                       category_id="CAT099", subcategory="none", price=10, original_price=10, discount=0,
                       stock=1, status="active", rating=0, review_count=0))
        db.flush()
        out = related(client, "PRD099", limit=3)
        assert out and out[0] == "PRD016"  # the best seller

    def test_stable_between_requests(self, client, shelf):
        assert related(client, limit=6) == related(client, limit=6)

    def test_bought_together_counts(self, client, db, customer, shelf):
        from app.models import Order, OrderItem

        for n in range(3):
            order = Order(id=f"ORD9{n}", order_number=f"DCZ-T-{n}", customer_id=customer.id, customer_name="A",
                          customer_email="a@example.com", placed_at=datetime.utcnow() - timedelta(days=n + 1),
                          status="delivered", payment_status="paid", payment_method="cod",
                          delivery_method="standard", delivery_fee=0, item_count=2, subtotal=0, total=0)
            db.add(order)
            db.flush()
            for pid in ("PRD010", "PRD016"):
                db.add(OrderItem(order_id=order.id, product_id=pid, name=pid, unit_price=1, quantity=1,
                                 line_total=1))
        db.flush()
        out = related(client, type="frequently-bought-together")
        assert out == ["PRD016"]

    def test_frequently_bought_together_is_honest_when_empty(self, client, shelf):
        assert related(client, type="frequently-bought-together") == []

    def test_alternatives_are_same_kind_similar_price(self, client, shelf):
        out = related(client, type="alternative", limit=10)
        assert "PRD011" in out
        assert "PRD016" not in out and "PRD012" not in out

    def test_an_unknown_type_is_refused(self, client, shelf):
        response = client.get("/api/products/PRD010/related?type=random")
        assert response.status_code == 422

    def test_an_unknown_product_is_a_404(self, client, shelf):
        assert client.get("/api/products/PRD777/related").status_code == 404


class TestManual:
    def test_store_choices_come_first_in_their_order(self, client, admin_auth, shelf):
        response = client.post("/api/admin/products/PRD010/relationships", headers=admin_auth,
                               json={"relatedProductIds": ["PRD016", "PRD013"], "type": "related"})
        assert response.status_code == 201, response.text
        assert related(client, limit=4)[:2] == ["PRD016", "PRD013"]

    def test_reorder(self, client, admin_auth, shelf):
        rows = client.post("/api/admin/products/PRD010/relationships", headers=admin_auth,
                           json={"relatedProductIds": ["PRD016", "PRD013"]}).json()["data"]
        ids = {r["relatedProductId"]: r["id"] for r in rows}
        response = client.put("/api/admin/products/PRD010/relationships/order", headers=admin_auth,
                              json={"type": "related", "ids": [ids["PRD013"], ids["PRD016"]]})
        assert response.status_code == 200, response.text
        assert related(client, limit=4)[:2] == ["PRD013", "PRD016"]

    def test_a_reorder_must_name_every_row(self, client, admin_auth, shelf):
        rows = client.post("/api/admin/products/PRD010/relationships", headers=admin_auth,
                           json={"relatedProductIds": ["PRD016", "PRD013"]}).json()["data"]
        response = client.put("/api/admin/products/PRD010/relationships/order", headers=admin_auth,
                              json={"type": "related", "ids": [rows[0]["id"]]})
        assert response.status_code == 422

    def test_a_disabled_relationship_is_not_shown(self, client, admin_auth, shelf):
        rows = client.post("/api/admin/products/PRD010/relationships", headers=admin_auth,
                           json={"relatedProductId": "PRD016"}).json()["data"]
        client.put(f"/api/admin/products/PRD010/relationships/{rows[0]['id']}", headers=admin_auth,
                   json={"active": False})
        assert related(client, limit=2)[0] != "PRD016"

    def test_a_chosen_product_that_is_unpublished_is_not_shown(self, client, admin_auth, shelf):
        client.post("/api/admin/products/PRD010/relationships", headers=admin_auth,
                    json={"relatedProductId": "PRD015"})
        assert "PRD015" not in related(client, limit=24)

    def test_self_relationship_is_refused(self, client, admin_auth, shelf):
        response = client.post("/api/admin/products/PRD010/relationships", headers=admin_auth,
                               json={"relatedProductId": "PRD010"})
        assert response.status_code == 422
        assert response.json()["error_code"] == "SELF_RELATIONSHIP"

    def test_a_duplicate_is_refused(self, client, admin_auth, shelf):
        body = {"relatedProductId": "PRD016", "type": "accessory"}
        assert client.post("/api/admin/products/PRD010/relationships", headers=admin_auth,
                           json=body).status_code == 201
        again = client.post("/api/admin/products/PRD010/relationships", headers=admin_auth, json=body)
        assert again.status_code == 409
        assert again.json()["error_code"] == "DUPLICATE_RELATIONSHIP"

    def test_the_same_pair_can_have_two_types(self, client, admin_auth, shelf):
        for kind in ("related", "frequently-bought-together"):
            assert client.post("/api/admin/products/PRD010/relationships", headers=admin_auth,
                               json={"relatedProductId": "PRD016", "type": kind}).status_code == 201
        assert related(client, type="frequently-bought-together") == ["PRD016"]

    def test_reciprocal(self, client, admin_auth, shelf):
        client.post("/api/admin/products/PRD010/relationships", headers=admin_auth,
                    json={"relatedProductId": "PRD016", "reciprocal": True})
        assert related(client, "PRD016", limit=1) == ["PRD010"]

    def test_an_unknown_product_or_type(self, client, admin_auth, shelf):
        assert client.post("/api/admin/products/PRD010/relationships", headers=admin_auth,
                           json={"relatedProductId": "PRD777"}).status_code == 404
        assert client.post("/api/admin/products/PRD010/relationships", headers=admin_auth,
                           json={"relatedProductId": "PRD016", "type": "cousin"}).status_code == 422

    def test_remove(self, client, admin_auth, shelf):
        rows = client.post("/api/admin/products/PRD010/relationships", headers=admin_auth,
                           json={"relatedProductId": "PRD016"}).json()["data"]
        response = client.delete(f"/api/admin/products/PRD010/relationships/{rows[0]['id']}", headers=admin_auth)
        assert response.status_code == 200 and response.json()["data"] == []

    def test_a_relationship_belongs_to_its_product(self, client, admin_auth, shelf):
        rows = client.post("/api/admin/products/PRD010/relationships", headers=admin_auth,
                           json={"relatedProductId": "PRD016"}).json()["data"]
        assert client.delete(f"/api/admin/products/PRD011/relationships/{rows[0]['id']}",
                             headers=admin_auth).status_code == 404

    def test_the_preview_says_where_each_came_from(self, client, admin_auth, shelf):
        client.post("/api/admin/products/PRD010/relationships", headers=admin_auth,
                    json={"relatedProductId": "PRD013"})
        items = client.get("/api/admin/products/PRD010/recommendations?type=related",
                           headers=admin_auth).json()["data"]["items"]
        assert items[0]["source"] == "manual" and items[0]["product"]["id"] == "PRD013"
        assert {i["source"] for i in items[1:]} <= {"score", "fallback-category", "fallback-best-sellers"}


class TestCache:
    def test_a_new_relationship_shows_at_once(self, client, admin_auth, shelf):
        before = related(client, limit=3)
        client.post("/api/admin/products/PRD010/relationships", headers=admin_auth,
                    json={"relatedProductId": "PRD016"})
        assert related(client, limit=3)[0] == "PRD016" != before[0]

    def test_a_product_unpublished_since_the_list_was_cached_is_gone(self, client, db, shelf):
        from app.models import Product

        assert "PRD011" in related(client, limit=6)
        db.get(Product, "PRD011").status = "archived"
        db.flush()
        assert "PRD011" not in related(client, limit=6)

    def test_a_product_edit_clears_the_cache(self, client, admin_auth, shelf):
        from app.core import cache

        related(client, limit=6)
        version_before = dict(cache._versions)
        response = client.put("/api/products/PRD012", headers=admin_auth, json={"subcategory": "tableware"})
        assert response.status_code == 200, response.text
        assert cache._versions.get("recommendations", 0) > version_before.get("recommendations", 0)
        assert related(client, limit=6).index("PRD012") <= 1


class TestPermissions:
    def test_a_customer_cannot_manage_relationships(self, client, auth, shelf):
        response = client.post("/api/admin/products/PRD010/relationships", headers=auth,
                               json={"relatedProductId": "PRD016"})
        assert response.status_code in (401, 403)

    def test_a_role_without_products_cannot(self, client, db, shelf):
        from app.core.security import hash_password
        from app.models import AdminUser

        db.add(AdminUser(id="ADM009", email="support@dailychoicezone.com", password_hash=hash_password("Admin@123"),
                         name="Support", role="staff", permissions=["support"], status="active",
                         created_at=datetime(2026, 1, 1)))
        db.flush()
        from app.core import permissions

        assert "products" in permissions.permissions_for("staff")  # the role grants it…
        db.get(AdminUser, "ADM009").role = "custom"  # …so use a role that doesn't
        db.flush()
        token = client.post("/api/admin/auth/login", json={"email": "support@dailychoicezone.com",
                                                           "password": "Admin@123"}).json()["data"]["token"]
        auth = {"Authorization": f"Bearer {token['accessToken']}"}
        assert client.post("/api/admin/products/PRD010/relationships", headers=auth,
                           json={"relatedProductId": "PRD016"}).status_code == 403
        assert client.get("/api/admin/size-guides", headers=auth).status_code == 403


class TestForYou:
    def test_a_guest_with_history(self, client, shelf):
        response = client.get("/api/recommendations/for-you?seed=PRD010&limit=4")
        assert response.status_code == 200
        out = [p["id"] for p in response.json()["data"]]
        assert "PRD010" not in out and out[0] == "PRD011"

    def test_no_history_is_best_sellers(self, client, shelf):
        out = [p["id"] for p in client.get("/api/recommendations/for-you?limit=3").json()["data"]]
        assert out[0] == "PRD016"

    def test_signed_in_uses_the_accounts_history(self, client, db, auth, customer, shelf):
        from app.services import recently_viewed

        recently_viewed.record(db, customer, "PRD010")
        out = [p["id"] for p in client.get("/api/recommendations/for-you?limit=4", headers=auth).json()["data"]]
        assert "PRD010" not in out and out[0] == "PRD011"


class TestAttribution:
    def test_a_purchase_after_adding_from_a_rail_is_counted(self, client, db, auth, catalogue, settings_documents):
        from app.models import AnalyticsEvent

        client.post("/api/cart/items", headers=auth, json={"productId": "PRD001", "source": "rec:pdp-related"})
        order = client.post("/api/orders", headers=auth, json={
            "shippingAddress": {"fullName": "Asha Rao", "phone": "9876500001", "line1": "4 Brigade Road",
                                "line2": "", "city": "Bengaluru", "state": "Karnataka", "pincode": "560001",
                                "country": "India"},
            "billingAddress": None, "deliveryMethod": "standard", "paymentMethod": "cod", "couponCode": None,
            "email": "shopper@example.com", "saveAddress": False,
        })
        assert order.status_code == 201, order.text
        events = db.query(AnalyticsEvent).filter_by(event="recommendation_purchase").all()
        assert [(e.product_id, e.source) for e in events] == [("PRD001", "rec:pdp-related")]

    def test_rail_events_from_the_browser(self, client, db, shelf):
        from app.models import AnalyticsEvent

        body = {"event": "recommendation_click", "visitorId": "visitor-12345678", "productId": "PRD011",
                "placement": "rec:pdp-related"}
        assert client.post("/api/analytics/events", json=body).json()["data"]["recorded"] is True
        row = db.query(AnalyticsEvent).filter_by(event="recommendation_click").one()
        assert row.source == "rec:pdp-related"
        # A draft can't be "clicked".
        body["productId"] = "PRD015"
        assert client.post("/api/analytics/events", json=body).json()["data"]["recorded"] is False


class TestGuestSeeds:
    def test_a_draft_named_as_a_seed_steers_nothing(self, client, shelf):
        """A guest's seeds come from the browser: an unpublished id is ignored, so best sellers come back."""
        out = [p["id"] for p in client.get("/api/recommendations/for-you?seed=PRD015&limit=3").json()["data"]]
        assert out[0] == "PRD016"
        assert "PRD015" not in out
