"""
Flash sales: set up in the portal, priced by the server everywhere, limited
per customer and by units at the sale price, held and released with the
order's stock, and never two sale prices for one product at once.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.core import rate_limit
from app.models import FlashSale, FlashSaleClaim, Order, OrderItem, Product
from tests.integration.wallet_helpers import fill_bag, mailbox, place  # noqa: F401

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


def iso(when: datetime) -> str:
    return when.replace(microsecond=0).isoformat() + "Z"


def make_sale(client, admin_auth, *, items=None, starts=None, ends=None, publish=True, expect=201, **extra):
    now = datetime.utcnow()
    body = {
        "name": "Weekend Flash", "description": "Two days only",
        "startsAt": iso(starts or now - timedelta(minutes=5)), "endsAt": iso(ends or now + timedelta(hours=2)),
        "items": items if items is not None else [{"productId": "PRD001", "salePrice": 799, "stockLimit": 5,
                                                   "perCustomerLimit": 2}],
        "publish": publish, **extra,
    }
    response = client.post("/api/admin/flash-sales", headers=admin_auth, json=body)
    assert response.status_code == expect, response.text
    return response.json()["data"] if expect == 201 else response.json()


@pytest.fixture()
def shop(client, catalogue, customer, settings_documents, admin_auth, auth):
    return client


class TestSettingUp:
    def test_a_sale_price_must_be_below_the_regular_price(self, shop, admin_auth):
        body = make_sale(shop, admin_auth, items=[{"productId": "PRD001", "salePrice": 1000}], expect=422)
        assert body["error_code"] == "INVALID_PRICE"
        body = make_sale(shop, admin_auth, items=[{"productId": "PRD001", "salePrice": 0}], expect=422)
        assert body["error_code"] == "INVALID_PRICE"

    def test_the_window_must_make_sense(self, shop, admin_auth):
        now = datetime.utcnow()
        body = make_sale(shop, admin_auth, starts=now + timedelta(hours=2), ends=now + timedelta(hours=1), expect=422)
        assert body["error_code"] == "INVALID_WINDOW"

    def test_a_product_cannot_be_in_two_overlapping_sales(self, shop, admin_auth):
        make_sale(shop, admin_auth)
        body = make_sale(shop, admin_auth, expect=409)
        assert body["error_code"] == "FLASH_SALE_OVERLAP"
        # A draft is not live, so it may overlap until someone publishes it.
        draft = make_sale(shop, admin_auth, publish=False)
        response = shop.post(f"/api/admin/flash-sales/{draft['id']}/publish", headers=admin_auth)
        assert response.status_code == 409

    def test_only_staff_with_the_permission_can_manage_sales(self, shop, client, editor):
        token = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"}).json()
        headers = {"Authorization": f"Bearer {token['data']['token']['accessToken']}"}
        assert shop.get("/api/admin/flash-sales", headers=headers).status_code == 403
        assert shop.post("/api/admin/flash-sales", headers=headers, json={}).status_code == 403

    def test_a_customer_token_cannot_reach_the_portal(self, shop, auth):
        assert shop.get("/api/admin/flash-sales", headers=auth).status_code == 403


class TestPricing:
    def test_the_sale_price_shows_everywhere_and_is_charged(self, shop, admin_auth, auth, db):
        make_sale(shop, admin_auth)
        product = shop.get("/api/products/PRD001").json()["data"]
        assert product["price"] == 799
        assert product["flashSale"]["remaining"] == 5
        assert product["discount"] == 36  # 799 against 1,250

        fill_bag(shop, auth, "PRD001", 2)
        bag = shop.get("/api/cart", headers=auth).json()["data"]
        assert bag["items"][0]["unitPrice"] == 79900
        assert bag["breakdown"]["subtotal"] == 159800

        order = place(shop, auth)["order"]
        item = db.query(OrderItem).filter_by(order_id=order["id"]).one()
        assert float(item.unit_price) == 799 and float(item.regular_unit_price) == 1000
        assert item.flash_sale_id is not None
        claim = db.query(FlashSaleClaim).filter_by(order_id=order["id"]).one()
        assert claim.quantity == 2 and claim.state == "consumed"
        assert shop.get("/api/products/PRD001").json()["data"]["flashSale"]["remaining"] == 3

    def test_the_admin_edit_form_keeps_the_real_price(self, shop, admin_auth):
        make_sale(shop, admin_auth)
        product = shop.get("/api/admin/products/PRD001", headers=admin_auth).json()["data"]
        assert product["price"] == 1000
        assert product["flashSale"] is None

    def test_a_sale_that_has_not_started_or_has_ended_does_not_apply(self, shop, admin_auth):
        now = datetime.utcnow()
        make_sale(shop, admin_auth, starts=now + timedelta(hours=1), ends=now + timedelta(hours=3))
        assert shop.get("/api/products/PRD001").json()["data"]["price"] == 1000
        listing = shop.get("/api/flash-sales").json()["data"]
        assert listing["live"] == [] and len(listing["upcoming"]) == 1

    def test_the_browser_cannot_name_a_price(self, shop, admin_auth, auth, db):
        fill_bag(shop, auth, "PRD001", 1)
        response = shop.post("/api/orders", headers=auth, json={
            "shippingAddress": {"fullName": "A", "phone": "9876500001", "line1": "1 Road", "line2": "",
                                "city": "Bengaluru", "state": "Karnataka", "pincode": "560001", "country": "India"},
            "deliveryMethod": "standard", "paymentMethod": "upi", "unitPrice": 1, "total": 1,
        })
        assert response.status_code == 201
        order_id = response.json()["data"]["order"]["id"]
        assert float(db.get(Order, order_id).subtotal) == 1000


class TestLimits:
    def test_the_limit_per_customer_is_enforced_when_adding_and_at_checkout(self, shop, admin_auth, auth):
        make_sale(shop, admin_auth)
        response = shop.post("/api/cart/items", headers=auth, json={"productId": "PRD001", "quantity": 3})
        assert response.status_code == 422
        assert response.json()["error_code"] == "FLASH_SALE_LIMIT"
        fill_bag(shop, auth, "PRD001", 2)
        place(shop, auth)
        # Already bought two at the sale price: no more for this customer.
        response = shop.post("/api/cart/items", headers=auth, json={"productId": "PRD001", "quantity": 1})
        assert response.json()["error_code"] == "FLASH_SALE_LIMIT"

    def test_when_sale_units_run_out_the_regular_price_returns(self, shop, admin_auth, auth, db, mailbox):  # noqa: F811
        make_sale(shop, admin_auth, items=[{"productId": "PRD001", "salePrice": 799, "stockLimit": 2}])
        fill_bag(shop, auth, "PRD001", 2)
        place(shop, auth)
        product = shop.get("/api/products/PRD001").json()["data"]
        assert product["price"] == 1000 and product["flashSale"] is None
        fill_bag(shop, auth, "PRD001", 1)
        bag = shop.get("/api/cart", headers=auth).json()["data"]
        assert bag["items"][0]["unitPrice"] == 100000

    def test_asking_for_more_than_is_left_at_the_sale_price_is_refused(self, shop, admin_auth, auth, db):
        make_sale(shop, admin_auth, items=[{"productId": "PRD001", "salePrice": 799, "stockLimit": 1}])
        fill_bag(shop, auth, "PRD001", 2)
        bag = shop.get("/api/cart", headers=auth).json()["data"]
        assert bag["issues"][0]["code"] == "FLASH_SALE_LIMITED"
        body = place(shop, auth, expect=409)
        assert body["error_code"] == "FLASH_SALE_LIMITED"
        assert db.query(Order).count() == 0

    def test_a_changed_total_is_refused_rather_than_charged(self, shop, admin_auth, auth, db):
        fill_bag(shop, auth, "PRD001", 1)
        shown = shop.get("/api/cart", headers=auth).json()["data"]["breakdown"]["grandTotal"]
        make_sale(shop, admin_auth)  # the price drops after the shopper looked
        response = shop.post("/api/orders", headers=auth, json={
            "shippingAddress": {"fullName": "A", "phone": "9876500001", "line1": "1 Road", "line2": "",
                                "city": "Bengaluru", "state": "Karnataka", "pincode": "560001", "country": "India"},
            "deliveryMethod": "standard", "paymentMethod": "upi", "expectedTotal": shown,
        })
        assert response.status_code == 409 and response.json()["error_code"] == "PRICE_CHANGED"

    def test_coupons_are_refused_when_the_sale_does_not_allow_them(self, shop, admin_auth, auth, coupon):
        make_sale(shop, admin_auth, allowCoupons=False)
        fill_bag(shop, auth, "PRD001", 1)
        bag = shop.get(f"/api/cart?coupon={coupon.code}", headers=auth).json()["data"]
        assert bag["appliedCoupon"] is None and "flash sale" in bag["couponError"]
        body = place(shop, auth, coupon=coupon.code, expect=422)
        assert body["error_code"] == "COUPON_NOT_ALLOWED_WITH_FLASH_SALE"


class TestStockFollowsTheOrder:
    def test_cancelling_gives_the_sale_units_back(self, shop, admin_auth, auth, db):
        make_sale(shop, admin_auth, items=[{"productId": "PRD001", "salePrice": 799, "stockLimit": 2}])
        fill_bag(shop, auth, "PRD001", 2)
        order = place(shop, auth, method="cod")["order"]
        assert shop.get("/api/products/PRD001").json()["data"]["flashSale"] is None
        response = shop.post(f"/api/orders/{order['id']}/cancel", headers=auth, json={"reason": "Changed my mind"})
        assert response.status_code == 200, response.text
        assert db.query(FlashSaleClaim).filter_by(order_id=order["id"]).one().state == "released"
        assert shop.get("/api/products/PRD001").json()["data"]["flashSale"]["remaining"] == 2
        db.expire_all()
        assert db.get(Product, "PRD001").stock == 10

    def test_a_held_payment_holds_the_sale_units_and_releases_them_on_expiry(self, shop, admin_auth, auth, db):
        from app.models import Customer
        from app.services import orders as order_service, pricing, settlement
        from app.models import Payment

        make_sale(shop, admin_auth)
        fill_bag(shop, auth, "PRD001", 1)
        customer = db.get(Customer, "CUS001")
        order, _, payment = order_service.place_order(
            db, customer, shipping_address={"fullName": "A", "phone": "9876500001", "line1": "1 Road",
                                            "city": "Bengaluru", "state": "Karnataka", "pincode": "560001"},
            billing_address=None, delivery_method="standard", payment_method="upi")
        claim = db.query(FlashSaleClaim).filter_by(order_id=order.id).one()
        if order.stock_state == "reserved":
            assert claim.state == "reserved"
            settlement.expire_payment(db, db.get(Payment, payment.id))
            db.commit()
            db.expire_all()
            assert db.query(FlashSaleClaim).filter_by(order_id=order.id).one().state == "released"
        else:  # the mock settles at once: the claim is sold
            assert claim.state == "consumed"
        pricing.forget_offers(db)


class TestPortal:
    def test_the_sale_shows_what_sold(self, shop, admin_auth, auth):
        sale = make_sale(shop, admin_auth)
        fill_bag(shop, auth, "PRD001", 2)
        place(shop, auth)
        detail = shop.get(f"/api/admin/flash-sales/{sale['id']}", headers=admin_auth).json()["data"]
        assert detail["totals"]["sold"] == 2
        assert detail["totals"]["revenue"] == 1598
        assert detail["phase"] == "live"
        listing = shop.get("/api/admin/flash-sales?phase=live", headers=admin_auth).json()["data"]
        assert listing["counts"]["live"] == 1

    def test_a_sale_with_orders_cannot_be_deleted_but_can_end_early(self, shop, admin_auth, auth):
        sale = make_sale(shop, admin_auth)
        fill_bag(shop, auth, "PRD001", 1)
        place(shop, auth)
        assert shop.delete(f"/api/admin/flash-sales/{sale['id']}", headers=admin_auth).status_code == 409
        response = shop.post(f"/api/admin/flash-sales/{sale['id']}/end", headers=admin_auth)
        assert response.status_code == 200 and response.json()["data"]["phase"] == "ended"
        assert shop.get("/api/products/PRD001").json()["data"]["price"] == 1000

    def test_changes_are_in_the_audit_trail(self, shop, admin_auth, db):
        from app.models import AuditLog

        sale = make_sale(shop, admin_auth)
        entry = db.query(AuditLog).filter_by(action="flash_sale.create", resource_id=str(sale["id"])).one()
        assert entry.actor_id == "ADM001"
        assert "PRD001" in str(entry.changes)

    def test_wishlist_customers_hear_when_it_starts(self, shop, admin_auth, auth, db, mailbox):  # noqa: F811
        from app.services import flash_sales

        assert shop.post("/api/wishlist/PRD001", headers=auth).status_code == 201
        make_sale(shop, admin_auth)
        assert flash_sales.announce_started(db) == 1
        assert flash_sales.announce_started(db) == 0
        assert any(m["key"] == "flash_sales" and m["to"] == "shopper@example.com" for m in mailbox)


class TestPortalListFindsById:
    """docs/id-lookup.md: the list box takes a Flash sale ID, exactly; names, prefixes and junk find nothing."""

    def test_the_list_box_takes_a_flash_sale_id_exactly(self, shop, admin_auth, db):
        first = make_sale(shop, admin_auth, publish=False)
        longer_id = int(f"{first['id']}1")
        now = datetime.utcnow()
        db.add(FlashSale(id=longer_id, name="Weekend Flash Longer", status="draft", starts_at=now,
                         ends_at=now + timedelta(hours=1), created_at=now, updated_at=now))
        db.flush()

        def ids(q):
            response = shop.get("/api/admin/flash-sales", headers=admin_auth, params={"q": q})
            assert response.status_code == 200, response.text
            return [row["id"] for row in response.json()["data"]["items"]]

        assert sorted(ids("")) == sorted([first["id"], longer_id])
        assert ids(str(first["id"])) == [first["id"]]  # never the longer ID it is a prefix of
        assert ids(str(longer_id)) == [longer_id]
        for text in ("Weekend", "Weekend Flash", "'; DROP TABLE flash_sales; --", "a@b.com", "99999"):
            assert ids(text) == []
