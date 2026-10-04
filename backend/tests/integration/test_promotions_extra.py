"""
Bundles and flash sales, past the paths `test_bundles.py` and
`test_flash_sales.py` walk: every validation the portal applies, editing and
deleting, the state machine of a sale (publish, unpublish, cancel, end), what
the storefront hides, and the bag's warnings when a bundle or a sale price can
no longer be honoured.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from app.core import rate_limit
from app.models import (
    Bundle,
    CartBundle,
    FlashSale,
    FlashSaleClaim,
    FlashSaleItem,
    Order,
    Product,
    ProductColor,
    WishlistItem,
)
from tests.integration.test_bundles import add as add_bundle, make_bundle
from tests.integration.test_flash_sales import iso, make_sale
from tests.integration.wallet_helpers import fill_bag, mailbox, place  # noqa: F401

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def gadget(db, catalogue):
    db.add(Product(id="PRD005", slug="phone-stand", sku="DCZ-EL0005", name="Phone Stand", brand="Meridian",
                   category_id="CAT002", subcategory="accessories", price=500.0, original_price=500.0, discount=0,
                   stock=8, status="active", rating=0, review_count=0))
    db.flush()


@pytest.fixture()
def shop(client, db, catalogue, gadget, customer, settings_documents, admin_auth, auth):
    from app.services import pricing

    yield client
    pricing.forget_offers(db)


def two(**overrides):
    """A two-component bundle body, for the validation cases."""
    return {"items": [{"productId": "PRD001", "quantity": 1}, {"productId": "PRD002", "quantity": 1}], **overrides}


# =================================================================== bundles


class TestBundleValidation:
    @pytest.mark.parametrize("overrides, code", [
        ({"name": "ab"}, "INVALID_NAME"),
        ({"status": "live"}, "INVALID_STATUS"),
        ({"pricing": "bogo"}, "INVALID_PRICING"),
        ({"items": [{"productId": f"PRD{i:03d}"} for i in range(11)]}, "TOO_MANY_ITEMS"),
        ({"items": [{"productId": "PRD001"}, {"productId": "PRD001"}]}, "DUPLICATE_PRODUCT"),
        ({"items": [{"productId": "PRD001"}, {"productId": "PRD999"}]}, "PRODUCT_NOT_FOUND"),
        ({"items": [{"productId": "PRD001"}, {"productId": "PRD004"}]}, "PRODUCT_UNAVAILABLE"),
        (two(items=[{"productId": "PRD001", "quantity": "two"}, {"productId": "PRD002"}]), "INVALID_QUANTITY"),
        (two(items=[{"productId": "PRD001", "quantity": 11}, {"productId": "PRD002"}]), "INVALID_QUANTITY"),
        (two(fixedPrice=None), "INVALID_PRICE"),
        (two(fixedPrice="cheap"), "INVALID_PRICE"),
        (two(fixedPrice=0), "INVALID_PRICE"),
        (two(pricing="percent", discountPercent=None), "INVALID_DISCOUNT"),
        (two(pricing="percent", discountPercent=0.5), "INVALID_DISCOUNT"),
        (two(startsAt="2026-12-02T00:00:00Z", endsAt="2026-12-01T00:00:00Z"), "INVALID_WINDOW"),
        (two(maxPerOrder="many"), "INVALID_LIMIT"),
        (two(maxPerOrder=21), "INVALID_LIMIT"),
        (two(image="ftp://example.com/x.png"), "INVALID_IMAGE"),
    ])
    def test_the_portal_refuses_a_bad_bundle(self, shop, db, admin_auth, overrides, code):
        body = make_bundle(shop, admin_auth, expect=422, **overrides)
        assert body["success"] is False and body["error_code"] == code
        assert db.query(Bundle).count() == 0

    def test_a_draft_may_include_a_product_that_is_not_on_sale(self, shop, admin_auth):
        bundle = make_bundle(shop, admin_auth, status="draft",
                             items=[{"productId": "PRD001"}, {"productId": "PRD004"}], fixedPrice=5000)
        assert bundle["status"] == "draft"

    def test_a_valid_image_and_window_are_kept(self, shop, admin_auth):
        bundle = make_bundle(shop, admin_auth, image="/uploads/office.jpg",
                             startsAt="2026-01-01T00:00:00Z", endsAt="2099-01-01T00:00:00Z")
        assert bundle["image"] == "/uploads/office.jpg" and bundle["ownImage"] == "/uploads/office.jpg"
        assert bundle["purchasable"] is True

    def test_the_same_name_gets_a_new_slug(self, shop, admin_auth):
        first = make_bundle(shop, admin_auth)
        second = make_bundle(shop, admin_auth)
        assert (first["slug"], second["slug"]) == ("office-look", "office-look-2")


class TestBundleEditing:
    def test_an_edit_replaces_the_components_and_price(self, shop, db, admin_auth):
        bundle = make_bundle(shop, admin_auth)
        response = shop.put(f"/api/admin/bundles/{bundle['id']}", headers=admin_auth, json={
            "name": "Office Look", "status": "active", "pricing": "percent", "discountPercent": 20,
            "items": [{"productId": "PRD001", "quantity": 2}, {"productId": "PRD005", "quantity": 1}],
        })
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["slug"] == "office-look"  # its own slug is not a clash
        assert [(c["productId"], c["quantity"]) for c in data["components"]] == [("PRD001", 2), ("PRD005", 1)]
        assert data["price"] == 2000 and data["regularPrice"] == 2500
        assert data["components"][0]["product"]["sku"] == "DCZ-WO0001"

    def test_an_unknown_bundle_cannot_be_edited_read_or_deleted(self, shop, admin_auth):
        body = {"name": "Office Look", "fixedPrice": 1000, **two()}
        assert shop.put("/api/admin/bundles/99999", headers=admin_auth, json=body).status_code == 404
        response = shop.get("/api/admin/bundles/99999", headers=admin_auth)
        assert response.status_code == 404 and response.json()["error_code"] == "BUNDLE_NOT_FOUND"
        assert shop.delete("/api/admin/bundles/99999", headers=admin_auth).status_code == 404

    def test_a_bundle_nobody_ordered_is_deleted(self, shop, db, admin_auth):
        bundle = make_bundle(shop, admin_auth)
        response = shop.delete(f"/api/admin/bundles/{bundle['id']}", headers=admin_auth)
        assert response.status_code == 200
        assert db.query(Bundle).count() == 0
        assert shop.get(f"/api/admin/bundles/{bundle['id']}", headers=admin_auth).status_code == 404

    def test_the_portal_list_filters_and_counts(self, shop, admin_auth):
        office = make_bundle(shop, admin_auth)
        make_bundle(shop, admin_auth, name="Weekend Set", status="draft")
        response = shop.get("/api/admin/bundles?status=draft", headers=admin_auth)
        assert response.status_code == 200
        data = response.json()["data"]
        assert [b["name"] for b in data["items"]] == ["Weekend Set"]
        assert data["counts"] == {"draft": 1, "active": 1, "archived": 0}
        assert data["items"][0]["sales"] == {"orders": 0, "units": 0, "revenue": 0.0}
        found = shop.get(f"/api/admin/bundles?q={office['id']}", headers=admin_auth).json()["data"]
        assert [b["name"] for b in found["items"]] == ["Office Look"]
        # The box takes a Bundle ID (docs/id-lookup.md): a name finds nothing.
        empty = shop.get("/api/admin/bundles?q=office", headers=admin_auth).json()["data"]
        assert empty["items"] == [] and empty["pagination"]["total"] == 0


class TestBundleStorefront:
    def test_a_live_bundle_is_read_by_slug(self, shop, admin_auth):
        bundle = make_bundle(shop, admin_auth)
        response = shop.get(f"/api/bundles/{bundle['slug']}")
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["price"] == 2999 and "status" not in data
        assert data["components"][0]["product"]["slug"] == "cotton-kurta"

    def test_a_bundle_with_a_withdrawn_component_is_not_listed(self, shop, db, admin_auth):
        make_bundle(shop, admin_auth)
        db.get(Product, "PRD002").status = "archived"
        db.flush()
        assert shop.get("/api/bundles").json()["data"] == []

    def test_a_bundle_that_has_not_started_is_hidden_and_unpurchasable(self, shop, admin_auth):
        bundle = make_bundle(shop, admin_auth, startsAt="2099-01-01T00:00:00Z")
        assert shop.get("/api/bundles").json()["data"] == []
        assert shop.get(f"/api/bundles/{bundle['slug']}").status_code == 404
        assert bundle["purchasable"] is False and "isn't available" in bundle["reason"]

    def test_a_sold_out_component_makes_it_unpurchasable(self, shop, db, admin_auth, auth):
        bundle = make_bundle(shop, admin_auth)
        db.get(Product, "PRD002").stock = 0
        db.flush()
        detail = shop.get(f"/api/admin/bundles/{bundle['id']}", headers=admin_auth).json()["data"]
        assert detail["available"] == 0 and detail["reason"] == "This bundle is sold out."
        body = add_bundle(shop, auth, bundle["id"], expect=409)
        assert body["error_code"] == "BUNDLE_UNAVAILABLE"


class TestBundlesInTheBag:
    def test_an_unknown_bundle_cannot_be_added(self, shop, auth):
        body = add_bundle(shop, auth, 99999, expect=404)
        assert body["error_code"] == "BUNDLE_NOT_FOUND"

    def test_a_choice_for_a_product_not_in_the_bundle_is_refused(self, shop, admin_auth, auth):
        bundle = make_bundle(shop, admin_auth)
        response = shop.post("/api/cart/bundles", headers=auth, json={
            "bundleId": bundle["id"], "selections": [{"productId": "PRD003", "size": "M"}]})
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_SELECTION"

    def test_a_colour_the_component_does_not_come_in_is_refused(self, shop, db, admin_auth, auth):
        db.add(ProductColor(product_id="PRD002", name="White", hex="#ffffff", position=0))
        db.flush()
        bundle = make_bundle(shop, admin_auth)
        response = shop.post("/api/cart/bundles", headers=auth, json={
            "bundleId": bundle["id"], "selections": [{"productId": "PRD002", "color": "Black"}]})
        assert response.status_code == 422 and response.json()["error_code"] == "COLOR_UNAVAILABLE"
        # No colour chosen: the first one.
        bag = add_bundle(shop, auth, bundle["id"])
        component = [c for c in bag["bundles"][0]["components"] if c["productId"] == "PRD002"][0]
        assert component["color"] == "White"

    def test_adding_the_same_bundle_again_raises_the_quantity(self, shop, db, admin_auth, auth):
        bundle = make_bundle(shop, admin_auth)
        add_bundle(shop, auth, bundle["id"])
        bag = add_bundle(shop, auth, bundle["id"])
        assert bag["bundles"][0]["quantity"] == 2
        assert db.query(CartBundle).count() == 1

    def test_the_quantity_can_be_changed_and_set_to_zero(self, shop, db, admin_auth, auth):
        bundle = make_bundle(shop, admin_auth)
        add_bundle(shop, auth, bundle["id"])
        entry = db.query(CartBundle).one()
        changed = shop.put(f"/api/cart/bundles/{entry.id}", headers=auth, json={"quantity": 9})
        assert changed.status_code == 200
        assert changed.json()["data"]["bundles"][0]["quantity"] == 3  # the order limit
        removed = shop.put(f"/api/cart/bundles/{entry.id}", headers=auth, json={"quantity": 0})
        assert removed.status_code == 200 and removed.json()["data"]["bundles"] == []
        assert shop.put(f"/api/cart/bundles/{entry.id}", headers=auth, json={"quantity": 1}).status_code == 404

    def test_removing_a_bundle_from_the_bag(self, shop, db, admin_auth, auth):
        bundle = make_bundle(shop, admin_auth)
        add_bundle(shop, auth, bundle["id"])
        entry = db.query(CartBundle).one()
        response = shop.delete(f"/api/cart/bundles/{entry.id}", headers=auth)
        assert response.status_code == 200 and response.json()["data"]["bundles"] == []

    def test_the_service_refuses_a_non_positive_quantity(self, shop, db, admin_auth, customer):
        from app.core.errors import ValidationError
        from app.services import bundles

        bundle = make_bundle(shop, admin_auth)
        with pytest.raises(ValidationError) as caught:
            bundles.add_to_cart(db, customer, bundle["id"], 0, [])
        assert caught.value.error_code == "INVALID_QUANTITY"

    def test_a_component_withdrawn_after_adding_is_flagged_and_refused_at_checkout(self, shop, db, admin_auth,
                                                                                   auth):
        bundle = make_bundle(shop, admin_auth)
        add_bundle(shop, auth, bundle["id"])
        db.get(Product, "PRD005").status = "draft"
        db.flush()
        bag = shop.get("/api/cart", headers=auth).json()["data"]
        assert bag["issues"][0]["code"] == "BUNDLE_UNAVAILABLE"
        assert bag["bundles"][0]["problem"] == "Something in this bundle is no longer sold."
        body = place(shop, auth, method="cod", expect=409)
        assert body["error_code"] == "BUNDLE_UNAVAILABLE"
        assert db.query(Order).count() == 0

    def test_more_than_the_order_limit_in_the_bag_is_flagged(self, shop, db, admin_auth, auth):
        bundle = make_bundle(shop, admin_auth, maxPerOrder=1)
        add_bundle(shop, auth, bundle["id"])
        db.query(CartBundle).one().quantity = 2
        db.flush()
        bag = shop.get("/api/cart", headers=auth).json()["data"]
        assert "up to 1" in bag["bundles"][0]["problem"]

    def test_a_bag_entry_whose_bundle_vanished_is_ignored_by_pricing(self, shop, db):
        from app.services import pricing

        bag = pricing.price_bag(db, "CUS001", [], [SimpleNamespace(bundle=None)])
        assert bag.lines == [] and bag.bundles == []


class TestBundleQuotes:
    def test_an_empty_bundle_cannot_be_bought(self):
        from app.services import pricing

        bundle = SimpleNamespace(items=[], pricing="fixed", price=100, discount_percent=None, status="active",
                                 starts_at=None, ends_at=None)
        quote = pricing.quote_bundle(bundle, {})
        assert quote.reason == "This bundle has nothing in it." and quote.price == 0

    def test_an_ended_bundle_window_is_closed(self):
        from app.services import pricing

        now = datetime.utcnow()
        assert pricing.bundle_window_open(SimpleNamespace(status="active", starts_at=None,
                                                          ends_at=now - timedelta(minutes=1))) is False
        assert pricing.bundle_window_open(SimpleNamespace(status="draft", starts_at=None, ends_at=None)) is False


# ================================================================ flash sales


def sale_body(**overrides):
    now = datetime.utcnow()
    body = {
        "name": "Weekend Flash", "startsAt": iso(now - timedelta(minutes=5)), "endsAt": iso(now + timedelta(hours=2)),
        "items": [{"productId": "PRD001", "salePrice": 799, "stockLimit": 5, "perCustomerLimit": 2}],
        "publish": True,
    }
    body.update(overrides)
    return body


class TestFlashSaleValidation:
    @pytest.mark.parametrize("overrides, code", [
        ({"name": "Hi"}, "INVALID_NAME"),
        ({"startsAt": None}, "INVALID_DATE"),
        ({"endsAt": "whenever"}, "INVALID_DATE"),
        ({"endsAt": iso(datetime.utcnow() + timedelta(days=40))}, "INVALID_WINDOW"),
        ({"items": []}, "ITEMS_REQUIRED"),
        ({"items": [{"productId": f"P{i}", "salePrice": 1} for i in range(101)]}, "TOO_MANY_ITEMS"),
        ({"items": [{"productId": "PRD001", "salePrice": 1}, {"productId": "PRD001", "salePrice": 2}]},
         "DUPLICATE_PRODUCT"),
        ({"items": [{"productId": "PRD999", "salePrice": 1}]}, "PRODUCT_NOT_FOUND"),
        ({"items": [{"productId": "PRD004", "salePrice": 1}]}, "PRODUCT_UNAVAILABLE"),
        ({"items": [{"productId": "PRD001", "salePrice": "cheap"}]}, "INVALID_PRICE"),
        ({"items": [{"productId": "PRD001", "salePrice": 500, "stockLimit": "lots"}]}, "INVALID_NUMBER"),
        ({"items": [{"productId": "PRD001", "salePrice": 500, "stockLimit": 0}]}, "INVALID_NUMBER"),
        ({"items": [{"productId": "PRD001", "salePrice": 500, "perCustomerLimit": 101}]}, "INVALID_NUMBER"),
        ({"startsAt": iso(datetime.utcnow() - timedelta(hours=3)),
          "endsAt": iso(datetime.utcnow() - timedelta(hours=1))}, "INVALID_WINDOW"),
    ])
    def test_the_portal_refuses_a_bad_sale(self, shop, db, admin_auth, overrides, code):
        response = shop.post("/api/admin/flash-sales", headers=admin_auth, json=sale_body(**overrides))
        assert response.status_code == 422, response.text
        assert response.json()["error_code"] == code
        assert db.query(FlashSale).count() == 0

    def test_a_sold_out_product_may_be_in_a_sale(self, shop, admin_auth):
        sale = make_sale(shop, admin_auth, items=[{"productId": "PRD003", "salePrice": 2500}])
        assert sale["items"][0]["productId"] == "PRD003" and sale["items"][0]["stockLimit"] is None


class TestFlashSaleLifecycle:
    def action(self, shop, admin_auth, sale_id, action):
        return shop.post(f"/api/admin/flash-sales/{sale_id}/{action}", headers=admin_auth)

    def test_a_scheduled_sale_can_go_back_to_draft_and_be_published_again(self, shop, admin_auth):
        now = datetime.utcnow()
        sale = make_sale(shop, admin_auth, starts=now + timedelta(hours=1), ends=now + timedelta(hours=3))
        assert sale["phase"] == "scheduled"
        back = self.action(shop, admin_auth, sale["id"], "unpublish")
        assert back.status_code == 200 and back.json()["data"]["phase"] == "draft"
        again = self.action(shop, admin_auth, sale["id"], "publish")
        assert again.status_code == 200 and again.json()["data"]["phase"] == "scheduled"

    def test_only_a_draft_can_be_published(self, shop, admin_auth):
        sale = make_sale(shop, admin_auth)
        response = self.action(shop, admin_auth, sale["id"], "publish")
        assert response.status_code == 409 and response.json()["error_code"] == "FLASH_SALE_STATE"

    def test_a_live_sale_cannot_go_back_to_draft(self, shop, admin_auth):
        sale = make_sale(shop, admin_auth)
        response = self.action(shop, admin_auth, sale["id"], "unpublish")
        assert response.status_code == 409 and response.json()["error_code"] == "FLASH_SALE_STATE"

    def test_a_draft_whose_end_has_passed_cannot_be_published(self, shop, db, admin_auth):
        sale = make_sale(shop, admin_auth, publish=False)
        row = db.get(FlashSale, sale["id"])
        row.starts_at, row.ends_at = datetime.utcnow() - timedelta(hours=3), datetime.utcnow() - timedelta(hours=1)
        db.flush()
        response = self.action(shop, admin_auth, sale["id"], "publish")
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_WINDOW"

    def test_a_draft_with_no_products_cannot_be_published(self, shop, db, admin_auth):
        sale = make_sale(shop, admin_auth, publish=False)
        db.query(FlashSaleItem).filter_by(sale_id=sale["id"]).delete()
        db.flush()
        db.expire_all()
        response = self.action(shop, admin_auth, sale["id"], "publish")
        assert response.status_code == 422 and response.json()["error_code"] == "ITEMS_REQUIRED"

    def test_cancelling_stops_the_price_and_cannot_be_repeated(self, shop, admin_auth):
        sale = make_sale(shop, admin_auth)
        assert shop.get("/api/products/PRD001").json()["data"]["price"] == 799
        cancelled = self.action(shop, admin_auth, sale["id"], "cancel")
        assert cancelled.status_code == 200 and cancelled.json()["data"]["phase"] == "cancelled"
        assert shop.get("/api/products/PRD001").json()["data"]["price"] == 1000
        again = self.action(shop, admin_auth, sale["id"], "cancel")
        assert again.status_code == 409 and again.json()["error_code"] == "FLASH_SALE_STATE"

    def test_only_a_live_sale_can_end_early(self, shop, admin_auth):
        sale = make_sale(shop, admin_auth, publish=False)
        response = self.action(shop, admin_auth, sale["id"], "end")
        assert response.status_code == 409 and response.json()["error_code"] == "FLASH_SALE_STATE"

    def test_an_unknown_action(self, shop, admin_auth):
        sale = make_sale(shop, admin_auth, publish=False)
        response = self.action(shop, admin_auth, sale["id"], "explode")
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_ACTION"

    def test_an_unknown_sale(self, shop, admin_auth):
        for response in (self.action(shop, admin_auth, 99999, "cancel"),
                         shop.get("/api/admin/flash-sales/99999", headers=admin_auth),
                         shop.delete("/api/admin/flash-sales/99999", headers=admin_auth),
                         shop.get("/api/flash-sales/99999")):
            assert response.status_code == 404
            assert response.json()["error_code"] == "FLASH_SALE_NOT_FOUND"

    def test_a_sale_nobody_bought_from_is_deleted(self, shop, db, admin_auth):
        sale = make_sale(shop, admin_auth)
        response = shop.delete(f"/api/admin/flash-sales/{sale['id']}", headers=admin_auth)
        assert response.status_code == 200
        assert db.query(FlashSale).count() == 0
        assert shop.get("/api/products/PRD001").json()["data"]["flashSale"] is None


class TestFlashSaleEditing:
    def update(self, shop, admin_auth, sale_id, **overrides):
        return shop.put(f"/api/admin/flash-sales/{sale_id}", headers=admin_auth, json=sale_body(**overrides))

    def test_a_scheduled_sale_can_be_rescheduled_and_restocked(self, shop, admin_auth):
        now = datetime.utcnow()
        sale = make_sale(shop, admin_auth, starts=now + timedelta(hours=1), ends=now + timedelta(hours=3))
        response = self.update(shop, admin_auth, sale["id"], startsAt=iso(now + timedelta(hours=2)),
                               endsAt=iso(now + timedelta(hours=4)),
                               items=[{"productId": "PRD001", "salePrice": 750, "stockLimit": 9},
                                      {"productId": "PRD002", "salePrice": 1500}])
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert [(i["productId"], i["salePrice"], i["stockLimit"]) for i in data["items"]] == [
            ("PRD001", 750, 9), ("PRD002", 1500, None)]

    def test_a_live_sale_keeps_its_start(self, shop, admin_auth):
        sale = make_sale(shop, admin_auth)
        response = self.update(shop, admin_auth, sale["id"], startsAt=iso(datetime.utcnow() - timedelta(minutes=1)))
        assert response.status_code == 409 and response.json()["error_code"] == "FLASH_SALE_STARTED"

    def test_a_cancelled_sale_cannot_be_changed(self, shop, admin_auth):
        sale = make_sale(shop, admin_auth)
        shop.post(f"/api/admin/flash-sales/{sale['id']}/cancel", headers=admin_auth)
        response = self.update(shop, admin_auth, sale["id"])
        assert response.status_code == 409 and response.json()["error_code"] == "FLASH_SALE_CLOSED"

    def test_units_cannot_go_below_what_already_sold(self, shop, db, admin_auth, auth):
        sale = make_sale(shop, admin_auth)
        fill_bag(shop, auth, "PRD001", 2)
        place(shop, auth, method="cod")
        row = db.get(FlashSale, sale["id"])
        response = self.update(shop, admin_auth, sale["id"], startsAt=iso(row.starts_at), endsAt=iso(row.ends_at),
                               items=[{"productId": "PRD001", "salePrice": 799, "stockLimit": 1}])
        assert response.status_code == 422 and response.json()["error_code"] == "STOCK_LIMIT_TOO_LOW"

    def test_an_edit_cannot_overlap_another_live_sale(self, shop, admin_auth):
        make_sale(shop, admin_auth, items=[{"productId": "PRD002", "salePrice": 1500}])
        now = datetime.utcnow()
        mine = make_sale(shop, admin_auth, starts=now + timedelta(hours=1), ends=now + timedelta(hours=3))
        response = self.update(shop, admin_auth, mine["id"], startsAt=iso(now + timedelta(hours=1)),
                               endsAt=iso(now + timedelta(hours=3)),
                               items=[{"productId": "PRD002", "salePrice": 1400}])
        assert response.status_code == 409 and response.json()["error_code"] == "FLASH_SALE_OVERLAP"

    def test_clearing_the_unit_limit_clears_a_sold_out_mark(self, shop, db, admin_auth, auth):
        sale = make_sale(shop, admin_auth, items=[{"productId": "PRD001", "salePrice": 799, "stockLimit": 1}])
        fill_bag(shop, auth, "PRD001", 1)
        place(shop, auth, method="cod")
        item = db.query(FlashSaleItem).one()
        assert item.sold_out_at is not None
        row = db.get(FlashSale, sale["id"])
        response = self.update(shop, admin_auth, sale["id"], startsAt=iso(row.starts_at), endsAt=iso(row.ends_at),
                               items=[{"productId": "PRD001", "salePrice": 799}])
        assert response.status_code == 200
        db.expire_all()
        assert db.query(FlashSaleItem).one().sold_out_at is None


class TestFlashSaleListings:
    def test_the_portal_list_by_phase_and_id(self, shop, admin_auth):
        now = datetime.utcnow()
        make_sale(shop, admin_auth)
        midnight = make_sale(shop, admin_auth, name="Midnight Madness", publish=False,
                  items=[{"productId": "PRD002", "salePrice": 1500}])
        make_sale(shop, admin_auth, name="Next Week", starts=now + timedelta(days=6), ends=now + timedelta(days=7),
                  items=[{"productId": "PRD002", "salePrice": 1500}])

        def listing(query):
            response = shop.get(f"/api/admin/flash-sales?{query}", headers=admin_auth)
            assert response.status_code == 200, response.text
            return response.json()["data"]

        everything = listing("")
        assert everything["counts"] == {"draft": 1, "cancelled": 0, "scheduled": 1, "live": 1, "ended": 0}
        assert everything["pagination"]["total"] == 3 and "itemCount" in everything["items"][0]
        assert [s["name"] for s in listing("phase=draft")["items"]] == ["Midnight Madness"]
        assert [s["name"] for s in listing("phase=scheduled")["items"]] == ["Next Week"]
        assert [s["name"] for s in listing(f"q={midnight['id']}")["items"]] == ["Midnight Madness"]
        assert listing("q=madness")["items"] == []  # a name is not a Flash sale ID (docs/id-lookup.md)
        assert listing("phase=ended")["items"] == []

    def test_a_draft_is_not_on_the_storefront(self, shop, admin_auth):
        sale = make_sale(shop, admin_auth, publish=False)
        assert shop.get(f"/api/flash-sales/{sale['id']}").status_code == 404
        assert shop.get("/api/flash-sales").json()["data"]["live"] == []

    def test_a_published_sale_is_read_with_the_server_time(self, shop, admin_auth):
        sale = make_sale(shop, admin_auth)
        data = shop.get(f"/api/flash-sales/{sale['id']}").json()["data"]
        assert data["phase"] == "live" and data["serverTime"]
        assert data["items"][0]["product"]["id"] == "PRD001" and "sold" not in data["items"][0]

    def test_a_sale_whose_products_were_withdrawn_is_not_shown(self, shop, db, admin_auth):
        make_sale(shop, admin_auth)
        db.get(Product, "PRD001").status = "archived"
        db.flush()
        assert shop.get("/api/flash-sales").json()["data"]["live"] == []


class TestFlashSalePricing:
    def test_over_the_customer_limit_in_the_bag_is_flagged_then_refused(self, shop, db, admin_auth, auth):
        fill_bag(shop, auth, "PRD001", 3)  # before the sale existed
        make_sale(shop, admin_auth)        # two per customer
        bag = shop.get("/api/cart", headers=auth).json()["data"]
        assert bag["issues"][0]["code"] == "FLASH_SALE_LIMIT"
        assert "2 of Cotton Kurta per customer" in bag["issues"][0]["message"]
        body = place(shop, auth, method="cod", expect=409)
        assert body["error_code"] == "FLASH_SALE_LIMIT"
        assert db.query(Order).count() == 0

    def test_a_sale_price_above_a_new_product_price_does_not_apply(self, shop, db, admin_auth):
        from app.services import pricing

        make_sale(shop, admin_auth)
        db.get(Product, "PRD001").price = 700
        db.flush()
        pricing.forget_offers(db)
        assert shop.get("/api/products/PRD001").json()["data"]["flashSale"] is None
        assert pricing.offer_for(db.get(Product, "PRD001"), db) is None

    def test_the_offers_at_a_given_moment(self, shop, db, admin_auth):
        from app.services import pricing

        make_sale(shop, admin_auth)
        assert "PRD001" in pricing.live_offers(db, now=datetime.utcnow())
        assert pricing.live_offers(db, now=datetime.utcnow() + timedelta(days=1)) == {}

    def test_a_detached_product_has_no_offer(self):
        from app.services import pricing

        assert pricing.offer_for(Product(id="PRDX", price=10)) is None

    def test_nothing_claimed_without_items_or_a_customer(self, db):
        from app.services import pricing

        assert pricing.claimed_by(db, "CUS001", []) == {}
        assert pricing.claimed_by(db, "", [1]) == {}
        assert pricing._lock_offers(db, [], "CUS001") == {}

    def test_a_sold_out_mark_is_lifted_when_the_order_is_cancelled(self, shop, db, admin_auth, auth):
        make_sale(shop, admin_auth, items=[{"productId": "PRD001", "salePrice": 799, "stockLimit": 1}])
        fill_bag(shop, auth, "PRD001", 1)
        order = place(shop, auth, method="cod")["order"]
        assert db.query(FlashSaleItem).one().sold_out_at is not None
        assert shop.post(f"/api/orders/{order['id']}/cancel", headers=auth, json={"reason": ""}).status_code == 200
        db.expire_all()
        assert db.query(FlashSaleItem).one().sold_out_at is None
        assert db.query(FlashSaleClaim).one().state == "released"


class TestFlashSaleAnnouncements:
    def test_a_customer_who_opted_out_is_not_emailed(self, shop, db, admin_auth, auth, mailbox):  # noqa: F811
        from app.services import flash_sales

        shop.post("/api/wishlist/PRD001", headers=auth)
        shop.put("/api/account/email-preferences", headers=auth, json={"flash_sales": False})
        make_sale(shop, admin_auth)
        assert flash_sales.announce_started(db) == 0
        assert not [m for m in mailbox if m["key"] == "flash_sales"]

    def test_many_wished_products_are_summarised(self, shop, db, admin_auth, auth, mailbox):  # noqa: F811
        from app.services import flash_sales

        for index in range(6, 8):
            db.add(Product(id=f"PRD00{index}", slug=f"extra-{index}", sku=f"DCZ-WO000{index}", name=f"Extra {index}",
                           brand="Anvi", category_id="CAT001", subcategory="", price=900, original_price=900,
                           discount=0, stock=4, status="active", rating=0, review_count=0))
        db.flush()
        ids = ["PRD001", "PRD002", "PRD006", "PRD007"]
        for product_id in ids:
            db.add(WishlistItem(customer_id="CUS001", product_id=product_id))
        db.flush()
        make_sale(shop, admin_auth, items=[{"productId": pid, "salePrice": 500} for pid in ids])
        flash_sales.sweep(db)
        mail = [m for m in mailbox if m["key"] == "flash_sales"]
        assert len(mail) == 1 and "and 1 more" in mail[0]["text"]
