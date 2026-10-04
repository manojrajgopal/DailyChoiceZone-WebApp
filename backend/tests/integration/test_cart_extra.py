"""
The bag, at its edges: quantities the API must refuse, variants that don't
exist, products that are not for sale, one shopper's bag against another's,
and the totals the server works out. Also the comparison list, the wishlist
and the abandoned-cart machinery's less common paths.

`test_cart.py` covers the everyday add/change/remove; these are the inputs a
client could send that a well-behaved storefront never would.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from sqlalchemy import select

from app.core import rate_limit
from app.models import CartItem, CartRecovery, Product, ProductColor, ProductSize, WishlistItem
from app.services import cart_recovery
from tests.integration.test_abandoned_carts import later, mailbox, row  # noqa: F401
from tests.integration.test_cart import add

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def other_auth(client, other_customer) -> dict:
    token = client.post("/api/auth/login", json={"email": other_customer.email, "password": "Customer@123"})
    assert token.status_code == 200, token.text
    return {"Authorization": f"Bearer {token.json()['data']['token']['accessToken']}"}


@pytest.fixture()
def variants(db, catalogue):
    """PRD001 in two sizes and two colours."""
    db.add_all([
        ProductSize(product_id="PRD001", label="S", position=0),
        ProductSize(product_id="PRD001", label="M", position=1),
        ProductColor(product_id="PRD001", name="Indigo", hex="#222244", position=0),
        ProductColor(product_id="PRD001", name="Rust", hex="#aa4400", position=1),
    ])
    db.flush()
    return catalogue


def reminders(mailbox) -> list:
    return [m for m in mailbox if m["key"] == "cart_reminders"]


def lines(client, auth) -> list:
    return client.get("/api/cart", headers=auth).json()["data"]["items"]


# ================================================================= quantities


class TestQuantitiesTheApiRefuses:
    @pytest.mark.parametrize("quantity", [0, -1, -50, 11, 1000])
    def test_adding_an_out_of_range_quantity_is_a_422(self, client, db, auth, catalogue, settings_documents,
                                                       quantity):
        response = add(client, auth, quantity=quantity)
        assert response.status_code == 422
        body = response.json()
        assert body["success"] is False and body["error_code"] == "VALIDATION_ERROR"
        assert any(d["field"] == "quantity" for d in body["details"])
        assert db.query(CartItem).count() == 0

    @pytest.mark.parametrize("quantity", [-1, 11])
    def test_changing_to_an_out_of_range_quantity_is_a_422(self, client, db, auth, catalogue, settings_documents,
                                                            quantity):
        line = add(client, auth).json()["data"]["items"][0]["id"]
        response = client.put(f"/api/cart/items/{line}", headers=auth, json={"quantity": quantity})
        assert response.status_code == 422
        assert db.query(CartItem).one().quantity == 1

    def test_a_quantity_must_be_a_number(self, client, auth, catalogue):
        assert add(client, auth, quantity="lots").status_code == 422

    def test_the_service_refuses_a_non_positive_quantity_too(self, db, customer, catalogue):
        from app.core.errors import ValidationError
        from app.services import cart

        with pytest.raises(ValidationError) as caught:
            cart.add_item(db, customer, product_id="PRD001", size=None, color=None, quantity=0)
        assert caught.value.error_code == "INVALID_QUANTITY"

    def test_the_line_is_capped_at_ten_however_it_is_reached(self, client, db, auth, catalogue, settings_documents):
        add(client, auth, quantity=7)
        response = add(client, auth, quantity=7)
        assert response.status_code == 201
        assert response.json()["data"]["items"][0]["quantity"] == 10
        assert db.query(CartItem).count() == 1

    def test_lowering_a_quantity_is_always_allowed(self, client, db, auth, catalogue, settings_documents):
        line = add(client, auth, quantity=5).json()["data"]["items"][0]["id"]
        response = client.put(f"/api/cart/items/{line}", headers=auth, json={"quantity": 2})
        assert response.status_code == 200
        assert response.json()["data"]["items"][0]["quantity"] == 2

    def test_a_line_whose_stock_is_all_held_keeps_a_quantity_of_one(self, client, db, auth, catalogue,
                                                                     settings_documents):
        line = add(client, auth, quantity=2).json()["data"]["items"][0]["id"]
        db.get(Product, "PRD001").reserved_stock = 10
        db.flush()
        response = client.put(f"/api/cart/items/{line}", headers=auth, json={"quantity": 5})
        assert response.status_code == 200
        assert response.json()["data"]["items"][0]["quantity"] == 1

    def test_an_unknown_line_cannot_be_changed_or_removed(self, client, auth, catalogue, settings_documents):
        response = client.put("/api/cart/items/999999", headers=auth, json={"quantity": 2})
        assert response.status_code == 404 and response.json()["error_code"] == "CART_ITEM_NOT_FOUND"
        assert client.delete("/api/cart/items/999999", headers=auth).status_code == 404


# ============================================================ what can be added


class TestWhatCanBeAdded:
    def test_an_unknown_product_is_a_404(self, client, db, auth, catalogue):
        response = add(client, auth, product_id="PRD999")
        assert response.status_code == 404 and response.json()["error_code"] == "PRODUCT_NOT_FOUND"
        assert db.query(CartItem).count() == 0

    def test_a_sold_out_product_is_a_409(self, client, auth, catalogue):
        response = add(client, auth, product_id="PRD003")
        assert response.status_code == 409 and response.json()["error_code"] == "OUT_OF_STOCK"

    def test_a_product_whose_stock_is_all_held_is_out_of_stock(self, client, db, auth, catalogue):
        db.get(Product, "PRD002").reserved_stock = 3
        db.flush()
        assert add(client, auth, product_id="PRD002").json()["error_code"] == "OUT_OF_STOCK"

    def test_an_archived_product_cannot_be_added(self, client, db, auth, catalogue):
        db.get(Product, "PRD001").status = "archived"
        db.flush()
        assert add(client, auth).status_code == 404

    def test_an_empty_or_huge_product_id_is_a_422(self, client, auth, catalogue):
        assert add(client, auth, product_id="").status_code == 422
        assert add(client, auth, product_id="P" * 41).status_code == 422

    def test_a_size_is_required_when_the_product_has_sizes(self, client, auth, variants):
        response = add(client, auth)
        assert response.status_code == 422 and response.json()["error_code"] == "SIZE_REQUIRED"

    def test_a_size_it_does_not_come_in(self, client, auth, variants):
        response = add(client, auth, size="XXL")
        assert response.status_code == 422 and response.json()["error_code"] == "SIZE_UNAVAILABLE"

    def test_a_colour_it_does_not_come_in(self, client, auth, variants):
        response = add(client, auth, size="M", color="Neon")
        assert response.status_code == 422 and response.json()["error_code"] == "COLOR_UNAVAILABLE"

    def test_no_colour_given_means_the_first_colour(self, client, auth, variants, settings_documents):
        item = add(client, auth, size="M").json()["data"]["items"][0]
        assert item["size"] == "M" and item["color"] == "Indigo"

    def test_each_variant_is_its_own_line_and_the_same_one_merges(self, client, db, auth, variants,
                                                                  settings_documents):
        add(client, auth, size="M", color="Indigo")
        add(client, auth, size="M", color="Rust")
        add(client, auth, size="M", color="Indigo", quantity=2)
        rows = {(i["size"], i["color"]): i["quantity"] for i in lines(client, auth)}
        assert rows == {("M", "Indigo"): 3, ("M", "Rust"): 1}

    def test_a_size_given_for_a_product_without_sizes_is_kept_as_sent(self, client, auth, catalogue,
                                                                       settings_documents):
        item = add(client, auth, product_id="PRD002", size="L").json()["data"]["items"][0]
        assert item["size"] == "L"


# ================================================================ isolation


class TestOneBagPerAccount:
    def test_two_customers_have_separate_bags(self, client, auth, other_auth, catalogue, settings_documents):
        add(client, auth, quantity=2)
        add(client, other_auth, product_id="PRD002")
        assert [i["productId"] for i in lines(client, auth)] == ["PRD001"]
        assert [i["productId"] for i in lines(client, other_auth)] == ["PRD002"]

    def test_emptying_one_bag_leaves_the_other(self, client, auth, other_auth, catalogue, settings_documents):
        add(client, auth)
        add(client, other_auth)
        client.delete("/api/cart", headers=auth)
        assert lines(client, auth) == []
        assert len(lines(client, other_auth)) == 1

    def test_someone_elses_line_reads_as_not_found(self, client, db, auth, other_auth, catalogue, settings_documents):
        line = add(client, other_auth).json()["data"]["items"][0]["id"]
        assert client.put(f"/api/cart/items/{line}", headers=auth, json={"quantity": 0}).status_code == 404
        assert db.query(CartItem).count() == 1

    @pytest.mark.parametrize("method, path", [
        ("get", "/api/cart"), ("get", "/api/cart/count"), ("post", "/api/cart/items"),
        ("put", "/api/cart/items/1"), ("delete", "/api/cart/items/1"), ("delete", "/api/cart"),
    ])
    def test_every_cart_route_needs_an_account(self, client, catalogue, method, path):
        kwargs = {"json": {"productId": "PRD001", "quantity": 1}} if method in ("post", "put") else {}
        assert getattr(client, method)(path, **kwargs).status_code == 401

    def test_a_forged_token_is_refused(self, client, catalogue):
        response = client.get("/api/cart", headers={"Authorization": "Bearer not.a.token"})
        assert response.status_code == 401


# ==================================================================== totals


class TestTotals:
    def test_lines_and_the_breakdown_agree(self, client, auth, catalogue, settings_documents):
        add(client, auth, quantity=2)
        add(client, auth, product_id="PRD002", quantity=3)
        data = client.get("/api/cart", headers=auth).json()["data"]
        assert [(i["productId"], i["unitPrice"], i["lineTotal"]) for i in data["items"]] == [
            ("PRD001", 100000, 200000), ("PRD002", 200000, 600000)]
        assert data["breakdown"]["subtotal"] == 800000
        assert data["breakdown"]["itemCount"] == 5
        assert data["freeDeliveryShortfall"] == 0
        assert client.get("/api/cart/count", headers=auth).json()["data"]["itemCount"] == 5

    def test_a_withdrawn_product_drops_out_of_the_bag(self, client, db, auth, catalogue, settings_documents):
        add(client, auth)
        add(client, auth, product_id="PRD002")
        db.get(Product, "PRD002").status = "draft"
        db.flush()
        data = client.get("/api/cart", headers=auth).json()["data"]
        assert [i["productId"] for i in data["items"]] == ["PRD001"]
        assert data["breakdown"]["subtotal"] == 100000

    def test_the_bag_prices_from_the_catalogue_as_it_is_now(self, client, db, auth, catalogue, settings_documents):
        add(client, auth)
        db.get(Product, "PRD001").price = 850
        db.flush()
        item = lines(client, auth)[0]
        assert item["unitPrice"] == 85000

    def test_a_free_shipping_coupon_waives_delivery(self, client, db, auth, catalogue, settings_documents):
        from app.models import Coupon

        db.add(Coupon(id="CPN010", code="SHIPFREE", description="Free delivery", type="free-shipping", value=0,
                      min_subtotal=0, max_discount=None, active=True,
                      starts_at=datetime.utcnow() - timedelta(days=1), ends_at=datetime.utcnow() + timedelta(days=1),
                      usage_limit=10, usage_count=0))
        # Below the free delivery threshold, so standard delivery has a fee to waive.
        db.add(Product(id="PRD020", slug="hair-tie", sku="DCZ-WO0020", name="Hair Tie", brand="Anvi",
                       category_id="CAT001", subcategory="accessories", price=200, original_price=200, discount=0,
                       stock=5, status="active", rating=0, review_count=0))
        db.flush()
        add(client, auth, product_id="PRD020")
        plain = client.get("/api/cart", headers=auth).json()["data"]
        waived = client.get("/api/cart?coupon=SHIPFREE", headers=auth).json()["data"]
        assert plain["breakdown"]["shipping"] == 7900
        assert plain["freeDeliveryShortfall"] == 99900 - 20000
        assert waived["appliedCoupon"]["code"] == "SHIPFREE"
        assert waived["breakdown"]["shipping"] == 0

    def test_a_bad_coupon_is_said_not_swallowed(self, client, auth, catalogue, settings_documents):
        add(client, auth)
        data = client.get("/api/cart?coupon=NOPE", headers=auth).json()["data"]
        assert data["appliedCoupon"] is None and data["couponError"]

    def test_a_pincode_is_checked_for_delivery(self, client, auth, catalogue, settings_documents):
        add(client, auth)
        response = client.get("/api/cart?pincode=560001", headers=auth)
        assert response.status_code == 200
        assert response.json()["data"]["delivery"] is not None

    def test_a_pincode_that_is_too_long_is_a_422(self, client, auth, catalogue):
        assert client.get("/api/cart?pincode=12345678901", headers=auth).status_code == 422


# ================================================================== wishlist


class TestWishlist:
    def test_save_list_and_remove(self, client, db, auth, catalogue):
        assert client.post("/api/wishlist/PRD002", headers=auth).status_code == 201
        assert client.post("/api/wishlist/PRD002", headers=auth).status_code == 201  # twice is once
        assert db.query(WishlistItem).count() == 1
        assert client.get("/api/wishlist/ids", headers=auth).json()["data"] == ["PRD002"]
        listed = client.get("/api/wishlist", headers=auth).json()["data"]
        assert [p["id"] for p in listed] == ["PRD002"]
        assert client.delete("/api/wishlist/PRD002", headers=auth).status_code == 200
        assert client.get("/api/wishlist/ids", headers=auth).json()["data"] == []

    def test_drafts_and_unknown_products_cannot_be_saved(self, client, auth, catalogue):
        assert client.post("/api/wishlist/PRD004", headers=auth).status_code == 404
        assert client.post("/api/wishlist/PRD999", headers=auth).status_code == 404

    def test_a_saved_product_that_is_withdrawn_drops_off_the_list(self, client, db, auth, catalogue):
        client.post("/api/wishlist/PRD001", headers=auth)
        db.get(Product, "PRD001").status = "archived"
        db.flush()
        assert client.get("/api/wishlist", headers=auth).json()["data"] == []

    def test_the_wishlist_is_per_account(self, client, auth, other_auth, catalogue):
        client.post("/api/wishlist/PRD001", headers=auth)
        assert client.get("/api/wishlist/ids", headers=other_auth).json()["data"] == []
        assert client.get("/api/wishlist").status_code == 401


# ================================================================ comparison


class TestComparison:
    def test_replacing_something_not_in_the_list_is_refused(self, client, auth, catalogue):
        client.post("/api/compare/PRD001", headers=auth)
        response = client.post("/api/compare/PRD002?replace=PRD003", headers=auth)
        assert response.status_code == 422
        assert response.json()["error_code"] == "NOT_IN_COMPARISON"
        assert client.get("/api/compare/ids", headers=auth).json()["data"]["productIds"] == ["PRD001"]

    def test_merging_fewer_than_the_limit_brings_them_all(self, client, auth, catalogue):
        response = client.post("/api/compare/merge", headers=auth, json={"productIds": ["PRD002", "PRD999", "PRD001"]})
        assert response.status_code == 200
        assert sorted(response.json()["data"]["productIds"]) == ["PRD001", "PRD002"]

    def test_adding_the_same_product_twice_is_once(self, client, auth, catalogue):
        client.post("/api/compare/PRD001", headers=auth)
        again = client.post("/api/compare/PRD001", headers=auth)
        assert again.status_code == 200 and again.json()["data"]["productIds"] == ["PRD001"]


# ============================================================ abandoned carts


@pytest.mark.usefixtures("mailbox")
class TestAbandonedCartEdges:
    def test_settings_can_be_read_and_saved_twice(self, client, db, admin_auth):
        default = client.get("/api/admin/carts/settings", headers=admin_auth).json()["data"]
        assert default["abandonAfterMinutes"] == 60 and default["expireAfterDays"] == 14
        first = client.put("/api/admin/carts/settings", headers=admin_auth,
                           json={"abandonAfterMinutes": 30, "expireAfterDays": 7, "reminders": [45, {"afterMinutes": 90}]})
        assert first.status_code == 200, first.text
        assert first.json()["data"]["reminders"] == [{"afterMinutes": 45}, {"afterMinutes": 90}]
        second = client.put("/api/admin/carts/settings", headers=admin_auth, json={"expireAfterDays": 30})
        assert second.status_code == 200
        saved = client.get("/api/admin/carts/settings", headers=admin_auth).json()["data"]
        assert saved["abandonAfterMinutes"] == 30 and saved["expireAfterDays"] == 30

    @pytest.mark.parametrize("bad", [
        {"abandonAfterMinutes": True},
        {"reminders": [{"afterMinutes": 10}]},
        {"reminders": [30, 60, 90, 120]},
        {"expireAfterDays": 91},
    ])
    def test_more_bad_settings_are_refused(self, client, admin_auth, bad):
        response = client.put("/api/admin/carts/settings", headers=admin_auth, json=bad)
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_SETTING"

    def test_a_bag_emptied_behind_the_trackers_back_is_closed(self, client, db, auth, catalogue):
        add(client, auth)
        db.query(CartItem).delete()
        db.flush()
        counts = cart_recovery.sweep(db, now=later(61))
        assert counts["emptied"] == 1 and row(db).status == "emptied"

    def test_a_reminder_is_not_sent_within_the_minimum_gap(self, client, db, auth, catalogue, mailbox):  # noqa: F811
        add(client, auth)
        cart_recovery.sweep(db, now=later(61))
        tracked = row(db)
        tracked.last_reminder_at = later(120)
        db.flush()
        cart_recovery.sweep(db, now=later(125))
        assert reminders(mailbox) == []

    def test_a_blocked_customer_is_not_reminded(self, client, db, auth, customer, catalogue, mailbox):  # noqa: F811
        add(client, auth)
        cart_recovery.sweep(db, now=later(61))
        customer.status = "blocked"
        db.flush()
        cart_recovery.sweep(db, now=later(125))
        assert reminders(mailbox) == []

    def test_a_bag_emptied_before_its_reminder_is_closed(self, client, db, auth, catalogue, mailbox):  # noqa: F811
        add(client, auth)
        cart_recovery.sweep(db, now=later(61))
        db.query(CartItem).delete()
        db.flush()
        cart_recovery.sweep(db, now=later(125))
        assert reminders(mailbox) == [] and row(db).status == "emptied"

    def test_a_failing_row_does_not_stop_the_sweep(self, client, db, auth, catalogue, monkeypatch, mailbox):  # noqa: F811
        add(client, auth)
        real = cart_recovery._snapshot
        monkeypatch.setattr(cart_recovery, "_snapshot", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
        counts = cart_recovery.sweep(db, now=later(61))
        assert counts["abandoned"] == 0
        monkeypatch.setattr(cart_recovery, "_snapshot", real)
        assert cart_recovery.sweep(db, now=later(61))["abandoned"] == 1
        monkeypatch.setattr(cart_recovery, "_send_reminder",
                            lambda *a, **k: (_ for _ in ()).throw(RuntimeError("smtp down")))
        assert cart_recovery.sweep(db, now=later(125))["reminded"] == 0
        assert row(db).reminders_sent == 0

    def test_every_stage_sent_means_no_more(self, client, db, auth, catalogue, mailbox):  # noqa: F811
        client.put("/api/account/email-preferences", headers=auth, json={"cart_reminders": True})
        add(client, auth)
        cart_recovery.sweep(db, now=later(61))
        tracked = row(db)
        tracked.reminders_sent = 2
        db.flush()
        assert cart_recovery.sweep(db, now=later(3000))["reminded"] == 0

    def test_following_the_link_reports_a_sold_out_item_and_a_lost_variant(self, client, db, auth, catalogue,
                                                                          mailbox):  # noqa: F811
        add(client, auth)
        add(client, auth, product_id="PRD002")
        cart_recovery.sweep(db, now=later(61))
        cart_recovery.sweep(db, now=later(125))
        token = reminders(mailbox)[0]["token"]
        db.query(CartItem).delete()
        db.get(Product, "PRD002").reserved_stock = 3
        # PRD001 now needs a size the saved line never had.
        db.add(ProductSize(product_id="PRD001", label="M", position=0))
        db.flush()
        data = client.post("/api/cart/recover", headers=auth, json={"token": token}).json()["data"]
        kinds = {c["name"]: c["kind"] for c in data["changes"]}
        assert kinds == {"Linen Shirt": "sold-out", "Cotton Kurta": "unavailable"}
        assert data["restored"] == 0

    def test_a_link_that_is_not_a_token(self, client, auth, catalogue):
        response = client.post("/api/cart/recover", headers=auth, json={"token": "x" * 40})
        assert response.status_code == 404 and response.json()["error_code"] == "RECOVERY_NOT_FOUND"

    def test_the_admin_list_filters_by_customer_id_and_date_and_shows_active(self, client, db, auth, admin_auth,
                                                                              catalogue):
        add(client, auth)
        cart_recovery.sweep(db, now=later(61))
        found = client.get("/api/admin/carts/abandoned?q=CUS001&days=30", headers=admin_auth).json()["data"]
        assert found["pagination"]["total"] == 1
        # The box takes a Customer ID (docs/id-lookup.md): a name, or another ID, finds nothing.
        for q in ("Asha", "CUS002", "CUS00"):
            assert client.get(f"/api/admin/carts/abandoned?q={q}", headers=admin_auth).json()["data"]["items"] == [], q
        # "active" lists bags that were never abandoned too.
        db.query(CartRecovery).update({"status": "active", "abandoned_at": None})
        db.flush()
        active = client.get("/api/admin/carts/abandoned?status=active", headers=admin_auth).json()["data"]
        assert active["pagination"]["total"] == 1
        # An unknown status is ignored rather than refused.
        assert client.get("/api/admin/carts/abandoned?status=weird", headers=admin_auth).status_code == 200

    def test_metrics_with_nothing_abandoned(self, client, admin_auth, catalogue):
        data = client.get("/api/admin/carts/abandoned/metrics?days=7", headers=admin_auth).json()["data"]
        assert data["abandoned"] == 0 and data["recoveryRate"] is None

    def test_a_snapshot_skips_withdrawn_products(self, client, db, auth, catalogue):
        add(client, auth)
        add(client, auth, product_id="PRD002")
        db.get(Product, "PRD002").status = "archived"
        db.flush()
        lines_, value, count = cart_recovery._snapshot(db, "CUS001")
        assert [l["productId"] for l in lines_] == ["PRD001"] and value == 100000 and count == 1
        assert db.execute(select(CartItem)).scalars().all()
