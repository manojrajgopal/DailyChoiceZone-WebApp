"""
The catalogue, beyond the listing basics: writing products through the API,
every sort and filter the query offers, paging at the edges, facets, the
portal's own product list, inventory adjustments and the stock primitives
checkout relies on.

The main suite (`test_catalogue.py`) covers reading; these are the writes and
the less travelled query branches -- the ones a refactor is most likely to
break without anybody noticing until a shopper does.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.models import AdminUser, Product, ProductColor, ProductSize, ProductTag, StockAdjustment
from tests.integration.test_catalogue import ids

pytestmark = pytest.mark.integration


NEW_PRODUCT = {
    "name": "Silk Saree",
    "category": "women",
    "price": 4000,
    "originalPrice": 5000,
    "stock": 6,
    "status": "active",
    "description": "Handwoven silk.",
}


def create(client, admin_auth, **overrides):
    return client.post("/api/products", headers=admin_auth, json={**NEW_PRODUCT, **overrides})


def update(client, admin_auth, product_id="PRD001", **fields):
    return client.put(f"/api/products/{product_id}", headers=admin_auth, json=fields)


def admin_login(client, email, password="Admin@123") -> dict:
    response = client.post("/api/admin/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}


@pytest.fixture()
def support_admin(db):
    """An administrator whose role does not include products."""
    from app.core.security import hash_password

    user = AdminUser(
        id="ADM003", email="support@dailychoicezone.com", password_hash=hash_password("Admin@123"),
        name="Support Person", role="support", permissions=["orders"], status="active",
        created_at=datetime(2026, 1, 1),
    )
    db.add(user)
    db.flush()
    return user


# ================================================================== creating


class TestCreatingAProduct:
    def test_create_returns_the_admin_projection(self, client, db, admin_auth, catalogue):
        response = create(client, admin_auth)
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["success"] is True and body["message"] == "Product created."
        data = body["data"]
        assert data["name"] == "Silk Saree" and data["slug"] == "silk-saree"
        assert data["category"] == "women" and data["status"] == "active"
        assert data["price"] == 4000 and data["originalPrice"] == 5000 and data["discount"] == 20
        assert data["sku"].startswith("DCZ-WO")
        assert data["seo"]["metaTitle"] == "Silk Saree | Daily Choice Zone"
        assert data["seo"]["metaDescription"] == "Handwoven silk."
        assert data["updatedBy"] == "ADM001"
        stored = db.get(Product, data["id"])
        assert stored.stock == 6 and stored.brand == "Daily Choice" and stored.low_stock_threshold == 8
        # Published, so the shop sees it.
        assert client.get(f"/api/products/{data['id']}").status_code == 200

    def test_a_product_is_a_draft_unless_told_otherwise(self, client, admin_auth, catalogue):
        payload = {key: value for key, value in NEW_PRODUCT.items() if key != "status"}
        data = client.post("/api/products", headers=admin_auth, json=payload).json()["data"]
        assert data["status"] == "draft"
        assert client.get(f"/api/products/{data['id']}").status_code == 404
        assert data["id"] not in ids(client.get("/api/products"))
        # The portal still reads it.
        portal = client.get(f"/api/admin/products/{data['id']}", headers=admin_auth)
        assert portal.status_code == 200 and portal.json()["data"]["status"] == "draft"

    def test_the_category_can_be_named_by_id(self, client, admin_auth, catalogue):
        data = create(client, admin_auth, category="CAT002").json()["data"]
        assert data["category"] == "electronics"
        assert data["sku"].startswith("DCZ-EL")

    def test_an_unknown_category_is_refused(self, client, db, admin_auth, catalogue):
        response = create(client, admin_auth, category="atlantis")
        assert response.status_code == 422
        assert response.json()["error_code"] == "CATEGORY_NOT_FOUND"
        assert db.query(Product).count() == 4

    @pytest.mark.parametrize("missing", ["name", "category", "price"])
    def test_required_fields_are_checked(self, client, db, admin_auth, catalogue, missing):
        payload = {key: value for key, value in NEW_PRODUCT.items() if key != missing}
        response = client.post("/api/products", headers=admin_auth, json=payload)
        assert response.status_code == 422
        body = response.json()
        assert body["success"] is False and body["error_code"] == "PRODUCT_INCOMPLETE"
        assert missing in body["message"]
        assert db.query(Product).count() == 4

    @pytest.mark.parametrize("field, value", [
        ("price", -1), ("originalPrice", -5), ("stock", -3), ("taxRatePercent", 101),
        ("status", "published"), ("lowStockThreshold", -1),
    ])
    def test_invalid_values_are_a_422(self, client, db, admin_auth, catalogue, field, value):
        response = create(client, admin_auth, **{field: value})
        assert response.status_code == 422
        assert response.json()["error_code"] == "VALIDATION_ERROR"
        assert db.query(Product).count() == 4

    def test_the_discount_is_derived_not_accepted(self, client, admin_auth, catalogue):
        data = create(client, admin_auth, price=799, originalPrice=1000, discount=90).json()["data"]
        assert data["discount"] == 20  # floor(20.1)

    def test_no_compare_at_price_means_no_discount(self, client, admin_auth, catalogue):
        data = create(client, admin_auth, originalPrice=None).json()["data"]
        assert data["originalPrice"] == 4000 and data["discount"] == 0

    def test_a_compare_at_price_below_the_price_is_no_discount(self, client, admin_auth, catalogue):
        data = create(client, admin_auth, price=4000, originalPrice=3000).json()["data"]
        assert data["discount"] == 0

    def test_a_taken_slug_is_suffixed(self, client, admin_auth, catalogue):
        first = create(client, admin_auth).json()["data"]
        second = create(client, admin_auth).json()["data"]
        third = create(client, admin_auth).json()["data"]
        assert [first["slug"], second["slug"], third["slug"]] == ["silk-saree", "silk-saree-2", "silk-saree-3"]
        # And a slug that is an existing product's is suffixed too.
        assert create(client, admin_auth, slug="Cotton Kurta").json()["data"]["slug"] == "cotton-kurta-2"

    def test_a_given_sku_is_kept(self, client, admin_auth, catalogue):
        assert create(client, admin_auth, sku="SUP-123").json()["data"]["sku"] == "SUP-123"

    def test_a_generated_sku_skips_one_in_use(self, client, db, admin_auth, catalogue):
        # Five products exist after this one, so the first candidate is WO0006 -- taken.
        db.add(Product(id="PRD050", slug="taken-sku", sku="DCZ-WO0006", name="Taken", brand="Anvi",
                       category_id="CAT001", subcategory="", price=10, original_price=10, discount=0, stock=1,
                       status="draft", rating=0, review_count=0))
        db.flush()
        assert create(client, admin_auth).json()["data"]["sku"] == "DCZ-WO0007"

    def test_children_are_stored_in_order_and_deduplicated(self, client, db, admin_auth, catalogue):
        data = create(
            client, admin_auth,
            images=["https://img.example.com/a.jpg", "https://img.example.com/a.jpg", "https://img.example.com/b.jpg"],
            colors=[{"name": "Ruby", "hex": "#aa0000", "images": ["https://img.example.com/ruby.jpg"]},
                    {"name": " Ruby ", "hex": "#bb0000"},
                    {"name": "Emerald", "hex": "#00aa00"}],
            sizes=["Free"], tags=["silk", "festive", "silk"],
            specifications=[{"label": "Length", "value": "5.5 m"}],
        ).json()["data"]
        assert data["images"] == ["https://img.example.com/a.jpg", "https://img.example.com/b.jpg"]
        assert data["sharedImages"] == data["images"]
        assert [c["name"] for c in data["colors"]] == ["Ruby", "Emerald"]
        assert data["sizes"] == ["Free"]
        assert sorted(data["tags"]) == ["festive", "silk"]
        assert data["specifications"] == [{"label": "Length", "value": "5.5 m"}]

    def test_flags_and_policies_default_sensibly(self, client, admin_auth, catalogue):
        data = create(client, admin_auth).json()["data"]
        assert data["isNew"] is True and data["isFeatured"] is False and data["isBestSeller"] is False
        assert data["isReturnable"] is True and data["isReplaceable"] is True
        explicit = create(client, admin_auth, isNew=False, isReturnable=False, isReplaceable=False,
                          isFeatured=True).json()["data"]
        assert explicit["isNew"] is False and explicit["isFeatured"] is True
        assert explicit["isReturnable"] is False and explicit["isReplaceable"] is False


class TestWhoMayWrite:
    def test_anonymous_writes_are_refused(self, client, db, catalogue):
        assert client.post("/api/products", json=NEW_PRODUCT).status_code == 401
        assert client.put("/api/products/PRD001", json={"price": 1}).status_code == 401
        assert client.delete("/api/products/PRD001").status_code == 401
        assert client.post("/api/products/PRD001/duplicate").status_code == 401
        assert db.get(Product, "PRD001") is not None

    def test_a_customer_cannot_write(self, client, db, auth, catalogue):
        assert client.post("/api/products", headers=auth, json=NEW_PRODUCT).status_code in (401, 403)
        assert client.put("/api/products/PRD001", headers=auth, json={"price": 1}).status_code in (401, 403)
        assert client.delete("/api/products/PRD001", headers=auth).status_code in (401, 403)
        db.expire_all()
        assert float(db.get(Product, "PRD001").price) == 1000

    def test_an_admin_without_the_permission_cannot_write(self, client, db, catalogue, support_admin):
        headers = admin_login(client, support_admin.email)
        response = client.post("/api/products", headers=headers, json=NEW_PRODUCT)
        assert response.status_code == 403 and response.json()["error_code"] == "PERMISSION_DENIED"
        assert client.delete("/api/products/PRD001", headers=headers).status_code == 403
        # Reading the portal list only needs to be an administrator.
        assert client.get("/api/admin/products", headers=headers).status_code == 200

    def test_an_editor_with_the_permission_can_write(self, client, catalogue, editor):
        headers = admin_login(client, editor.email)
        response = client.post("/api/products", headers=headers, json=NEW_PRODUCT)
        assert response.status_code == 201
        assert response.json()["data"]["updatedBy"] == "ADM002"

    def test_a_customer_cannot_read_the_portal_list(self, client, auth, catalogue):
        assert client.get("/api/admin/products", headers=auth).status_code in (401, 403)
        assert client.get("/api/admin/products").status_code == 401


# ================================================================== updating


class TestUpdatingAProduct:
    def test_only_what_is_sent_changes(self, client, db, admin_auth, catalogue):
        response = update(client, admin_auth, name="Cotton Kurta Classic")
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["name"] == "Cotton Kurta Classic"
        assert data["price"] == 1000 and data["slug"] == "cotton-kurta" and data["sku"] == "DCZ-WO0001"

    def test_moving_the_price_rederives_the_discount(self, client, admin_auth, catalogue):
        data = update(client, admin_auth, price=625).json()["data"]
        assert data["price"] == 625 and data["discount"] == 50
        data = update(client, admin_auth, originalPrice=625).json()["data"]
        assert data["discount"] == 0

    def test_the_category_can_change(self, client, admin_auth, catalogue):
        data = update(client, admin_auth, category="electronics").json()["data"]
        assert data["category"] == "electronics"
        assert set(ids(client.get("/api/products?category=electronics"))) == {"PRD001", "PRD003"}

    def test_an_unknown_category_on_update_is_refused(self, client, db, admin_auth, catalogue):
        response = update(client, admin_auth, category="atlantis")
        assert response.status_code == 422 and response.json()["error_code"] == "CATEGORY_NOT_FOUND"
        db.expire_all()
        assert db.get(Product, "PRD001").category_id == "CAT001"

    def test_a_new_slug_is_made_unique(self, client, admin_auth, catalogue):
        data = update(client, admin_auth, slug="linen-shirt").json()["data"]
        assert data["slug"] == "linen-shirt-2"
        # Its own slug is not a clash with itself.
        assert update(client, admin_auth, "PRD002", slug="linen-shirt").json()["data"]["slug"] == "linen-shirt"

    def test_a_product_without_a_slug_gets_one_from_its_name(self, client, db, admin_auth, catalogue):
        db.get(Product, "PRD001").slug = ""
        db.flush()
        assert update(client, admin_auth, name="Block Print Kurta").json()["data"]["slug"] == "block-print-kurta"

    def test_a_renamed_product_keeps_its_slug(self, client, admin_auth, catalogue):
        assert update(client, admin_auth, name="Renamed").json()["data"]["slug"] == "cotton-kurta"

    def test_a_sku_in_use_is_refused(self, client, db, admin_auth, catalogue):
        response = update(client, admin_auth, sku="DCZ-WO0002")
        assert response.status_code == 409 and response.json()["error_code"] == "SKU_TAKEN"
        db.expire_all()
        assert db.get(Product, "PRD001").sku == "DCZ-WO0001"

    def test_a_free_sku_is_taken(self, client, admin_auth, catalogue):
        assert update(client, admin_auth, sku="DCZ-NEW-1").json()["data"]["sku"] == "DCZ-NEW-1"
        # Saving its own SKU again is fine.
        assert update(client, admin_auth, sku="DCZ-NEW-1").status_code == 200

    def test_children_left_out_are_left_alone(self, client, admin_auth, catalogue):
        update(client, admin_auth, images=["https://img.example.com/k.jpg"], sizes=["S", "M"], tags=["cotton"],
               specifications=[{"label": "Fabric", "value": "Cotton"}])
        data = update(client, admin_auth, name="Still Kurta").json()["data"]
        assert data["images"] == ["https://img.example.com/k.jpg"]
        assert data["sizes"] == ["S", "M"] and data["tags"] == ["cotton"]
        assert data["specifications"] == [{"label": "Fabric", "value": "Cotton"}]

    def test_an_empty_list_clears_a_collection(self, client, admin_auth, catalogue):
        update(client, admin_auth, sizes=["S", "M"])
        assert update(client, admin_auth, sizes=[]).json()["data"]["sizes"] == []

    def test_replacing_shared_images_keeps_colour_images(self, client, admin_auth, catalogue):
        update(client, admin_auth, colors=[{"name": "Teal", "hex": "#008080",
                                            "images": ["https://img.example.com/teal.jpg"]}])
        data = update(client, admin_auth, images=["https://img.example.com/shared.jpg"]).json()["data"]
        assert data["sharedImages"] == ["https://img.example.com/shared.jpg"]
        assert data["colors"][0]["images"] == ["https://img.example.com/teal.jpg"]

    def test_stock_and_status_can_be_set(self, client, db, admin_auth, catalogue):
        data = update(client, admin_auth, "PRD003", stock=4, status="active").json()["data"]
        assert data["stock"] == 4 and data["status"] == "active"
        assert "PRD003" in ids(client.get("/api/products?inStockOnly=true"))

    def test_archiving_hides_it_from_the_shop(self, client, admin_auth, catalogue):
        update(client, admin_auth, status="archived")
        assert client.get("/api/products/PRD001").status_code == 404
        assert "PRD001" not in ids(client.get("/api/products"))

    def test_the_change_is_audited(self, client, db, admin_auth, catalogue):
        from app.models import AuditLog

        update(client, admin_auth, price=900)
        entry = db.query(AuditLog).filter_by(action="products.update").one()
        assert entry.resource_id == "PRD001" and "price" in entry.summary

    def test_an_unknown_product(self, client, admin_auth, catalogue):
        response = update(client, admin_auth, "PRD999", price=10)
        assert response.status_code == 404 and response.json()["error_code"] == "PRODUCT_NOT_FOUND"

    # Regression: was a real bug, fixed alongside this test.
    def test_a_null_price_is_refused_not_a_server_error(self, client, admin_auth, catalogue):
        response = update(client, admin_auth, price=None)
        assert response.status_code == 422


# ============================================================ deleting / copying


class TestDeletingAProduct:
    def test_a_product_never_ordered_is_deleted(self, client, db, admin_auth, catalogue):
        response = client.delete("/api/products/PRD002", headers=admin_auth)
        assert response.status_code == 200 and response.json()["message"] == "Product deleted."
        db.expire_all()
        assert db.get(Product, "PRD002") is None
        assert client.get("/api/products/PRD002").status_code == 404

    def test_a_product_that_was_ordered_is_kept(self, client, db, admin_auth, auth, catalogue, settings_documents):
        from tests.integration.wallet_helpers import fill_bag, place

        fill_bag(client, auth, "PRD001", 1)
        place(client, auth, method="cod")
        response = client.delete("/api/products/PRD001", headers=admin_auth)
        assert response.status_code == 409
        assert response.json()["error_code"] == "PRODUCT_HAS_ORDERS"
        assert "Archive" in response.json()["message"]
        db.expire_all()
        assert db.get(Product, "PRD001") is not None

    def test_an_unknown_product(self, client, admin_auth, catalogue):
        response = client.delete("/api/products/PRD999", headers=admin_auth)
        assert response.status_code == 404 and response.json()["error_code"] == "PRODUCT_NOT_FOUND"


class TestDuplicating:
    def test_the_copy_is_an_unflagged_draft_with_the_same_children(self, client, db, admin_auth, catalogue):
        update(client, admin_auth, isBestSeller=True, isFeatured=True, sizes=["S"], tags=["cotton"],
               images=["https://img.example.com/k.jpg"], specifications=[{"label": "Fabric", "value": "Cotton"}],
               colors=[{"name": "Teal", "hex": "#008080"}], barcode="8901234")
        response = client.post("/api/products/PRD001/duplicate", headers=admin_auth)
        assert response.status_code == 201, response.text
        copy = response.json()["data"]
        assert copy["id"] != "PRD001" and copy["name"] == "Cotton Kurta (copy)"
        assert copy["slug"] == "cotton-kurta-copy" and copy["status"] == "draft"
        assert copy["isBestSeller"] is False and copy["isFeatured"] is False and copy["isNew"] is False
        assert copy["sizes"] == ["S"] and copy["tags"] == ["cotton"]
        assert copy["images"] == ["https://img.example.com/k.jpg"]
        assert [c["name"] for c in copy["colors"]] == ["Teal"]
        assert copy["barcode"] == "" and copy["reservedStock"] == 0
        assert copy["price"] == 1000 and copy["stock"] == 10
        assert client.get(f"/api/products/{copy['id']}").status_code == 404

    def test_duplicating_twice_makes_two_slugs(self, client, admin_auth, catalogue):
        first = client.post("/api/products/PRD001/duplicate", headers=admin_auth).json()["data"]
        second = client.post("/api/products/PRD001/duplicate", headers=admin_auth).json()["data"]
        assert first["slug"] != second["slug"] and first["sku"] != second["sku"]

    def test_an_unknown_product(self, client, admin_auth, catalogue):
        assert client.post("/api/products/PRD999/duplicate", headers=admin_auth).status_code == 404


# ================================================================== listing


@pytest.fixture()
def merchandised(db, catalogue):
    """Flags, sizes, colours, tags and dates on the fixture products, so every filter has an answer."""
    by_id = {p.id: p for p in catalogue}
    by_id["PRD001"].is_new, by_id["PRD001"].is_featured = True, True
    by_id["PRD002"].is_trending, by_id["PRD002"].is_new = True, False
    by_id["PRD003"].is_best_seller, by_id["PRD003"].is_new = True, False
    by_id["PRD001"].created_at = datetime(2026, 1, 1)
    by_id["PRD002"].created_at = datetime(2026, 3, 1)
    by_id["PRD003"].created_at = datetime(2026, 2, 1)
    db.add_all([
        ProductSize(product_id="PRD001", label="S", position=0),
        ProductSize(product_id="PRD001", label="M", position=1),
        ProductSize(product_id="PRD002", label="M", position=0),
        ProductColor(product_id="PRD001", name="Indigo", hex="#222244", position=0),
        ProductColor(product_id="PRD002", name="White", hex="#ffffff", position=0),
        ProductTag(product_id="PRD002", tag="summer"),
    ])
    db.flush()
    return catalogue


class TestEverySort:
    @pytest.mark.parametrize("sort, expected", [
        ("newest", ["PRD002", "PRD003", "PRD001"]),
        ("price-asc", ["PRD001", "PRD002", "PRD003"]),
        ("price-desc", ["PRD003", "PRD002", "PRD001"]),
        ("discount", ["PRD003", "PRD001", "PRD002"]),
        ("rating", ["PRD001", "PRD003", "PRD002"]),
        ("popular", ["PRD003", "PRD001", "PRD002"]),
        ("recommended", ["PRD001", "PRD003", "PRD002"]),
    ])
    def test_each_sort_orders_the_whole_list(self, client, merchandised, sort, expected):
        assert ids(client.get(f"/api/products?sort={sort}")) == expected

    def test_recommended_is_the_default(self, client, merchandised):
        assert ids(client.get("/api/products")) == ids(client.get("/api/products?sort=recommended"))

    def test_an_unlisted_sort_falls_back_to_recommended_in_the_query(self, db, merchandised):
        from app.repositories import products as repo
        from app.schemas.catalogue import ProductQuery

        query = ProductQuery()
        query.sort = "nonsense"  # past the Literal, as a direct caller could
        items, total = repo.query_products(db, query)
        assert [p.id for p in items] == ["PRD001", "PRD003", "PRD002"] and total == 3


class TestEveryFilter:
    @pytest.mark.parametrize("query, expected", [
        ("brands=Anvi", {"PRD001", "PRD002"}),
        ("brands=Anvi,Meridian", {"PRD001", "PRD002", "PRD003"}),
        ("brands=Nobody", set()),
        ("sizes=M", {"PRD001", "PRD002"}),
        ("sizes=S", {"PRD001"}),
        ("colors=White", {"PRD002"}),
        ("colors=Indigo,White", {"PRD001", "PRD002"}),
        ("subcategory=tops", {"PRD002"}),
        ("minRating=4.1", {"PRD001", "PRD003"}),
        ("minDiscount=20", {"PRD001", "PRD003"}),
        ("minDiscount=0", {"PRD001", "PRD002", "PRD003"}),
        ("minPrice=2000", {"PRD002", "PRD003"}),
        ("maxPrice=999", set()),
        ("minPrice=2500&maxPrice=1500", set()),
        ("isNew=true", {"PRD001"}),
        ("isNew=false", {"PRD002", "PRD003"}),
        ("isTrending=true", {"PRD002"}),
        ("isBestSeller=true", {"PRD003"}),
        ("isFeatured=true", {"PRD001"}),
        ("isFeatured=false", {"PRD002", "PRD003"}),
        ("category=CAT002", {"PRD003"}),
        ("search=summer", {"PRD002"}),
        ("search=DCZ-EL0003", {"PRD003"}),
        ("search=Meridian", {"PRD003"}),
        ("search=linen%20shirt", {"PRD002"}),
        ("search=linen%20kurta", set()),
        ("sizes=M&colors=White", {"PRD002"}),
    ])
    def test_the_filter_narrows_the_list(self, client, merchandised, query, expected):
        response = client.get(f"/api/products?{query}")
        assert response.status_code == 200, response.text
        assert set(ids(response)) == expected
        assert response.json()["pagination"]["total"] == len(expected)

    # Regression: was a real bug, fixed alongside this test.
    def test_a_blank_search_is_no_search(self, client, merchandised):
        assert set(ids(client.get("/api/products?search=%20%20"))) == {"PRD001", "PRD002", "PRD003"}

    def test_a_draft_never_appears_whatever_the_filter(self, client, merchandised):
        for query in ("brands=Anvi", "subcategory=outerwear", "search=Draft", "minPrice=4000", "isNew=true"):
            assert "PRD004" not in ids(client.get(f"/api/products?{query}"))

    def test_a_collection_filters_by_slug_or_id(self, client, db, admin_auth, merchandised):
        response = client.post("/api/admin/collections", headers=admin_auth,
                               json={"name": "Summer Edit", "productIds": ["PRD002", "PRD003", "PRD004"]})
        assert response.status_code == 201, response.text
        collection = response.json()["data"]
        assert set(ids(client.get("/api/products?collection=summer-edit"))) == {"PRD002", "PRD003"}
        assert set(ids(client.get(f"/api/products?collection={collection['id']}"))) == {"PRD002", "PRD003"}
        assert ids(client.get("/api/products?collection=nothing")) == []

    @pytest.mark.parametrize("query", ["minPrice=cheap", "isNew=perhaps", "minDiscount=1.5", "inStockOnly=maybe"])
    def test_a_malformed_filter_is_a_422(self, client, catalogue, query):
        response = client.get(f"/api/products?{query}")
        assert response.status_code == 422 and response.json()["error_code"] == "VALIDATION_ERROR"


class TestPaging:
    def test_a_page_past_the_end_is_empty_not_an_error(self, client, catalogue):
        body = client.get("/api/products?page=9&pageSize=2").json()
        assert body["data"] == []
        assert body["pagination"]["total"] == 3 and body["pagination"]["page"] == 9

    @pytest.mark.parametrize("query", ["page=0", "page=-1", "pageSize=0", "pageSize=101"])
    def test_out_of_bounds_paging_is_a_422(self, client, catalogue, query):
        assert client.get(f"/api/products?{query}").status_code == 422

    def test_the_largest_page_is_allowed(self, client, catalogue):
        body = client.get("/api/products?pageSize=100").json()
        assert len(body["data"]) == 3 and body["pagination"]["total_pages"] == 1

    def test_one_per_page_walks_every_product_once(self, client, catalogue):
        seen = [ids(client.get(f"/api/products?pageSize=1&page={page}&sort=price-asc"))[0] for page in (1, 2, 3)]
        assert seen == ["PRD001", "PRD002", "PRD003"]


class TestThePortalList:
    def test_drafts_are_included(self, client, admin_auth, catalogue):
        response = client.get("/api/admin/products", headers=admin_auth)
        assert response.status_code == 200
        body = response.json()
        assert set(ids(response)) == {"PRD001", "PRD002", "PRD003", "PRD004"}
        assert body["pagination"]["total"] == 4
        assert "lowStockThreshold" in body["data"][0] and "reservedStock" in body["data"][0]

    @pytest.mark.parametrize("status, expected", [
        ("draft", {"PRD004"}), ("active", {"PRD001", "PRD002"}), ("out-of-stock", {"PRD003"}),
        ("all", {"PRD001", "PRD002", "PRD003", "PRD004"}), ("archived", set()),
    ])
    def test_the_status_filter(self, client, admin_auth, catalogue, status, expected):
        assert set(ids(client.get(f"/api/admin/products?status={status}", headers=admin_auth))) == expected

    def test_the_portal_list_takes_the_same_filters(self, client, admin_auth, catalogue):
        response = client.get("/api/admin/products?search=jacket&sort=price-desc", headers=admin_auth)
        assert ids(response) == ["PRD004"]

    def test_the_portal_reads_one_product_including_a_draft(self, client, admin_auth, catalogue):
        data = client.get("/api/admin/products/PRD004", headers=admin_auth).json()["data"]
        assert data["status"] == "draft" and data["seo"]["metaTitle"] is not None
        assert client.get("/api/admin/products/PRD999", headers=admin_auth).status_code == 404


class TestFacets:
    def test_facets_count_every_dimension(self, client, merchandised):
        data = client.get("/api/products/facets").json()["data"]
        assert {c["value"]: c["count"] for c in data["categories"]} == {"women": 2, "electronics": 1}
        assert {b["value"]: b["count"] for b in data["brands"]} == {"Anvi": 2, "Meridian": 1}
        assert {s["value"]: s["count"] for s in data["sizes"]} == {"M": 2, "S": 1}
        assert {c["value"]: c["count"] for c in data["colors"]} == {"Indigo": 1, "White": 1}
        assert {s["value"] for s in data["subcategories"]} == {"ethnic", "tops", "audio"}
        assert data["priceRange"] == {"min": 1000.0, "max": 3000.0}

    def test_facets_follow_the_scope_not_the_ticked_filters(self, client, merchandised):
        """Ticking one brand must not make every other brand read zero."""
        data = client.get("/api/products/facets?category=women&brands=Nobody").json()["data"]
        assert {b["value"]: b["count"] for b in data["brands"]} == {"Anvi": 2}
        assert data["priceRange"] == {"min": 1000.0, "max": 2000.0}

    def test_an_empty_scope_has_a_zero_price_range(self, client, merchandised):
        data = client.get("/api/products/facets?search=zzzz").json()["data"]
        assert data["brands"] == [] and data["categories"] == []
        assert data["priceRange"] == {"min": 0.0, "max": 0.0}

    def test_facets_leave_drafts_out(self, client, catalogue):
        data = client.get("/api/products/facets").json()["data"]
        assert "outerwear" not in {s["value"] for s in data["subcategories"]}


class TestRelated:
    def test_nearest_first_then_wider(self, client, db, catalogue):
        db.add_all([
            Product(id="PRD010", slug="kurta-two", sku="DCZ-WO0010", name="Kurta Two", brand="Other",
                    category_id="CAT001", subcategory="ethnic", price=900, original_price=900, discount=0,
                    stock=2, status="active", rating=3.0, review_count=0),
            Product(id="PRD011", slug="meridian-cable", sku="DCZ-EL0011", name="Cable", brand="Anvi",
                    category_id="CAT002", subcategory="cables", price=100, original_price=100, discount=0,
                    stock=2, status="active", rating=1.0, review_count=0),
        ])
        db.flush()
        related = ids(client.get("/api/products/PRD001/related"))
        # Same subcategory, then same category, then same brand.
        assert related == ["PRD010", "PRD002", "PRD011"]
        assert ids(client.get("/api/products/PRD001/related?limit=1")) == ["PRD010"]

    def test_the_limit_is_bounded(self, client, catalogue):
        assert client.get("/api/products/PRD001/related?limit=0").status_code == 422
        assert client.get("/api/products/PRD001/related?limit=25").status_code == 422

    def test_a_draft_has_no_related_page(self, client, catalogue):
        assert client.get("/api/products/PRD004/related").status_code == 404


class TestRepositoryAndServiceReads:
    def test_get_many_keeps_the_order_asked_for(self, db, catalogue):
        from app.repositories import products as repo

        assert [p.id for p in repo.get_many(db, ["PRD003", "PRD001", "PRD999"])] == ["PRD003", "PRD001"]
        assert repo.get_many(db, []) == []
        assert [p.id for p in repo.get_many(db, ["PRD004"])] == []
        assert [p.id for p in repo.get_many(db, ["PRD004"], published_only=False)] == ["PRD004"]

    def test_by_slug_hides_drafts_unless_asked(self, db, catalogue):
        from app.core.errors import NotFoundError
        from app.services import products

        assert products.get_product_by_slug(db, "cotton-kurta").id == "PRD001"
        with pytest.raises(NotFoundError):
            products.get_product_by_slug(db, "draft-jacket")
        assert products.get_product_by_slug(db, "draft-jacket", published_only=False).id == "PRD004"

    def test_by_id_can_be_limited_to_published(self, db, catalogue):
        from app.core.errors import NotFoundError
        from app.services import products

        assert products.get_product(db, "PRD004").id == "PRD004"
        with pytest.raises(NotFoundError):
            products.get_product(db, "PRD004", published_only=True)

    def test_an_identifier_prefers_the_id(self, db, catalogue):
        from app.repositories import products as repo

        # A slug that is literally another product's id.
        db.get(Product, "PRD002").slug = "PRD001"
        db.flush()
        assert repo.get_by_identifier(db, "PRD001").id == "PRD001"
        assert repo.get_by_identifier(db, "draft-jacket", published_only=False).id == "PRD004"

    def test_slug_and_sku_checks_can_ignore_one_product(self, db, catalogue):
        from app.repositories import products as repo

        assert repo.slug_exists(db, "cotton-kurta") is True
        assert repo.slug_exists(db, "cotton-kurta", ignore_id="PRD001") is False
        assert repo.sku_exists(db, "DCZ-WO0001", ignore_id="PRD001") is False
        assert repo.sku_exists(db, "DCZ-WO0001", ignore_id="PRD002") is True

    def test_unique_slug_falls_back_for_an_unsluggable_name(self, db, catalogue):
        from app.services import products

        assert products.unique_slug(db, "!!!") == "product"

    def test_the_admin_query_can_include_everything(self, db, catalogue):
        from app.repositories import products as repo
        from app.schemas.catalogue import ProductQuery

        items, total = repo.query_products(db, ProductQuery(include_unpublished=True))
        assert total == 4
        items, total = repo.query_products(db, ProductQuery(include_unpublished=True, status="draft"))
        assert [p.id for p in items] == ["PRD004"]


# ================================================================= inventory


def set_stock(client, admin_auth, product_id, quantity, **extra):
    return client.put(f"/api/admin/inventory/{product_id}", headers=admin_auth,
                      json={"quantity": quantity, **extra})


class TestInventory:
    def test_the_inventory_rows_say_low_in_and_out(self, client, db, admin_auth, catalogue):
        rows = {r["productId"]: r for r in client.get("/api/admin/inventory", headers=admin_auth).json()["data"]}
        assert rows["PRD001"]["status"] == "in-stock" and rows["PRD001"]["available"] == 10
        assert rows["PRD002"]["status"] == "low-stock"
        assert rows["PRD003"]["status"] == "out-of-stock"
        assert rows["PRD001"]["category"] == "women"

    def test_held_stock_is_not_available(self, client, db, admin_auth, catalogue):
        db.get(Product, "PRD001").reserved_stock = 10
        db.flush()
        rows = {r["productId"]: r for r in client.get("/api/admin/inventory", headers=admin_auth).json()["data"]}
        assert rows["PRD001"]["available"] == 0 and rows["PRD001"]["status"] == "out-of-stock"
        assert rows["PRD001"]["reserved"] == 10

    def test_restocking_a_sold_out_product_lists_it_again(self, client, db, admin_auth, catalogue):
        response = set_stock(client, admin_auth, "PRD003", 20, reason="restock", note="New shipment")
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["stock"] == 20 and data["status"] == "in-stock"
        assert "stock set to 20" in response.json()["message"]
        db.expire_all()
        assert db.get(Product, "PRD003").status == "active"
        entry = db.query(StockAdjustment).filter_by(product_id="PRD003").one()
        assert (entry.quantity_before, entry.quantity_after, entry.delta) == (0, 20, 20)
        assert entry.reason == "restock" and entry.note == "New shipment" and entry.actor == "ADM001"

    def test_restocking_what_is_all_held_keeps_it_sold_out(self, client, db, admin_auth, catalogue):
        db.get(Product, "PRD003").reserved_stock = 2
        db.flush()
        set_stock(client, admin_auth, "PRD003", 2)
        db.expire_all()
        assert db.get(Product, "PRD003").status == "out-of-stock"

    def test_a_draft_keeps_its_status_whatever_the_stock(self, client, db, admin_auth, catalogue):
        set_stock(client, admin_auth, "PRD004", 0)
        db.expire_all()
        assert db.get(Product, "PRD004").status == "draft"
        set_stock(client, admin_auth, "PRD004", 20)
        db.expire_all()
        assert db.get(Product, "PRD004").status == "draft"
        assert client.get("/api/products/PRD004").status_code == 404

    def test_the_log_honours_its_limit_newest_first(self, client, admin_auth, catalogue):
        for quantity in (5, 6, 7):
            set_stock(client, admin_auth, "PRD001", quantity)
        entries = client.get("/api/admin/inventory/log?limit=2", headers=admin_auth).json()["data"]
        assert len(entries) == 2
        assert all(e["productId"] == "PRD001" and e["by"] == "ADM001" for e in entries)

    def test_an_admin_without_products_cannot_set_stock(self, client, db, catalogue, support_admin):
        headers = admin_login(client, support_admin.email)
        assert set_stock(client, headers, "PRD001", 1).status_code == 403
        db.expire_all()
        assert db.get(Product, "PRD001").stock == 10
        # Reading the inventory is fine.
        assert client.get("/api/admin/inventory", headers=headers).status_code == 200

    def test_negative_stock_is_refused_by_the_service_too(self, db, catalogue):
        from app.core.errors import ValidationError
        from app.services import products

        with pytest.raises(ValidationError) as caught:
            products.adjust_stock(db, "PRD001", quantity=-1, reason="correction")
        assert caught.value.error_code == "NEGATIVE_STOCK"


class TestStockPrimitives:
    """The four locked operations checkout uses, called directly."""

    def test_consuming_takes_stock_and_writes_the_ledger(self, db, catalogue):
        from app.services import products

        products.consume_stock(db, "PRD002", 3, "ORD123")
        db.flush()
        product = db.get(Product, "PRD002")
        assert product.stock == 0 and product.status == "out-of-stock"
        entry = db.query(StockAdjustment).filter_by(product_id="PRD002").one()
        assert entry.reason == "sale" and entry.delta == -3 and entry.note == "Order ORD123"

    @pytest.mark.parametrize("operation", ["consume_stock", "reserve_stock"])
    @pytest.mark.parametrize("quantity", [0, -2])
    def test_a_quantity_must_be_positive(self, db, catalogue, operation, quantity):
        from app.core.errors import ValidationError
        from app.services import products

        with pytest.raises(ValidationError) as caught:
            getattr(products, operation)(db, "PRD001", quantity, "ORD1")
        assert caught.value.error_code == "INVALID_QUANTITY"

    def test_asking_for_more_than_is_left_is_refused(self, db, catalogue):
        from app.core.errors import ConflictError
        from app.services import products

        with pytest.raises(ConflictError) as caught:
            products.consume_stock(db, "PRD002", 4, "ORD1")
        assert caught.value.error_code == "INSUFFICIENT_STOCK" and "Only 3" in caught.value.message
        with pytest.raises(ConflictError) as caught:
            products.reserve_stock(db, "PRD003", 1, "ORD1")
        assert "sold out" in caught.value.message

    def test_an_unknown_product_cannot_be_locked(self, db, catalogue):
        from app.core.errors import NotFoundError
        from app.services import products

        with pytest.raises(NotFoundError):
            products.consume_stock(db, "PRD999", 1, "ORD1")

    def test_reserve_commit_and_release(self, db, catalogue):
        from app.services import products

        products.reserve_stock(db, "PRD001", 4, "ORD1")
        db.flush()
        product = db.get(Product, "PRD001")
        assert (product.stock, product.reserved_stock, product.available_stock) == (10, 4, 6)
        # Held units are not for sale to the next order.
        products.reserve_stock(db, "PRD001", 6, "ORD2")
        db.flush()
        assert db.get(Product, "PRD001").available_stock == 0

        products.commit_reservation(db, "PRD001", 4, "ORD1")
        db.flush()
        product = db.get(Product, "PRD001")
        assert (product.stock, product.reserved_stock) == (6, 6)

        products.release_reservation(db, "PRD001", 6, "ORD2")
        products.release_reservation(db, "PRD001", 6, "ORD2")  # twice: clamped, not negative
        db.flush()
        product = db.get(Product, "PRD001")
        assert (product.stock, product.reserved_stock) == (6, 0)

    def test_committing_the_last_units_sells_it_out(self, db, catalogue):
        from app.services import products

        products.reserve_stock(db, "PRD002", 3, "ORD1")
        products.commit_reservation(db, "PRD002", 3, "ORD1")
        db.flush()
        assert db.get(Product, "PRD002").status == "out-of-stock"

    def test_sync_status_relists_a_restocked_product(self, db, catalogue):
        from app.services import products

        product = db.get(Product, "PRD003")
        product.stock = 2
        products._sync_status(product)
        assert product.status == "active"

    def test_locking_nothing_is_nothing(self, db, catalogue):
        from app.services import products

        assert products.lock_products(db, []) == {}
        locked = products.lock_products(db, ["PRD002", "PRD001", "PRD001"])
        assert list(locked) == ["PRD001", "PRD002"]
