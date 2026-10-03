"""
Availability by location: one product, variant and quantity at one pincode —
deliverable, in stock, when, COD, express, the fee — the bag line by line, the
product's own delivery rules, and checkout checking it all again.
"""

from __future__ import annotations

from datetime import date, datetime

import pytest

from app.core import rate_limit

pytestmark = pytest.mark.integration

ADDRESS = {
    "fullName": "Asha Rao", "phone": "9876500001", "line1": "4 Brigade Road", "line2": "",
    "city": "Bengaluru", "state": "Karnataka", "pincode": "560001", "country": "India",
}


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def listed(client, admin_auth, settings_documents):
    rows = [
        {"pincode": "560001", "city": "Bengaluru", "state": "Karnataka", "minDays": 1, "maxDays": 3,
         "deliveryFee": 49},
        {"pincode": "110001", "city": "New Delhi", "state": "Delhi", "codAvailable": False,
         "expressAvailable": False, "minDays": 3, "maxDays": 6},
        {"pincode": "799001", "city": "Agartala", "state": "Tripura", "serviceable": False},
        {"pincode": "781001", "city": "Guwahati", "state": "Assam", "minDays": 4, "maxDays": 7},
    ]
    for row in rows:
        assert client.post("/api/admin/delivery/pincodes", headers=admin_auth, json=row).status_code == 201


def check(client, pid="PRD001", pincode="560001", **params):
    return client.get(f"/api/products/{pid}/availability", params={"pincode": pincode, **params})


def ok(client, *args, **kwargs):
    response = check(client, *args, **kwargs)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def place(client, auth, *, pincode="560001", payment="cod", delivery="standard", product="PRD001", quantity=1):
    client.post("/api/cart/items", headers=auth, json={"productId": product, "quantity": quantity})
    return client.post("/api/orders", headers=auth, json={
        "shippingAddress": {**ADDRESS, "pincode": pincode}, "billingAddress": None,
        "deliveryMethod": delivery, "paymentMethod": payment, "couponCode": None,
        "email": "shopper@example.com", "saveAddress": False,
    })


class TestTheAnswer:
    def test_available_with_terms(self, client, catalogue, listed):
        data = ok(client)
        assert data["available"] is True and data["status"] == "available"
        assert data["deliverable"] is True and data["inventoryAvailable"] is True
        assert data["codAvailable"] is True and data["expressAvailable"] is True
        assert data["deliveryFee"] == 0.0  # ₹1,000 clears the ₹999 threshold
        assert data["standardDeliveryFee"] == 49.0
        assert data["estimatedDelivery"]["label"]
        assert data["location"]["city"] == "Bengaluru"
        assert data["inventoryScope"] == "product"

    def test_below_the_threshold_the_fee_applies(self, client, db, catalogue, listed):
        from app.models import Product

        db.get(Product, "PRD001").price = 500
        db.flush()
        data = ok(client)
        assert data["deliveryFee"] == 49.0 and data["freeDelivery"] is False

    def test_an_invalid_pincode(self, client, catalogue, listed):
        data = ok(client, pincode="012345")
        assert data["available"] is False and data["status"] == "invalid-pincode" and data["valid"] is False

    def test_a_pincode_not_served(self, client, catalogue, listed):
        data = ok(client, pincode="799001")
        assert data["status"] == "not-serviceable" and data["deliveryFee"] is None
        assert data["codAvailable"] is False and data["expressAvailable"] is False

    def test_cod_and_express_where_the_pincode_says_no(self, client, catalogue, listed):
        data = ok(client, pincode="110001")
        assert data["available"] is True
        assert data["codAvailable"] is False and "pincode" in data["cod"]["reason"]
        assert data["expressAvailable"] is False and data["express"]["estimatedDelivery"] is None

    def test_cod_off_for_the_whole_store(self, client, db, catalogue, listed):
        from app.models import SettingDocument

        billing = db.get(SettingDocument, "billing")
        billing.value = {**billing.value, "payment": {"enabledMethods": ["upi", "card"], "codFee": 0}}
        db.flush()
        assert ok(client)["codAvailable"] is False

    def test_out_of_stock(self, client, catalogue, listed):
        data = ok(client, "PRD003")
        assert data["status"] == "out-of-stock" and data["available"] is False
        assert data["deliverable"] is True and data["inventoryAvailable"] is False

    def test_more_than_there_is(self, client, catalogue, listed):
        data = ok(client, "PRD002", quantity=5)  # three in stock
        assert data["status"] == "limited" and data["maxQuantity"] == 3

    def test_stock_held_for_a_payment_is_not_available(self, client, db, catalogue, listed):
        from app.models import Product

        product = db.get(Product, "PRD002")
        product.reserved_stock = 3
        db.flush()
        assert ok(client, "PRD002")["status"] == "out-of-stock"

    def test_a_draft_is_not_found(self, client, catalogue, listed):
        assert check(client, "PRD004").status_code == 404

    def test_the_quantity_is_bounded(self, client, catalogue, listed):
        assert check(client, quantity=0).status_code == 422
        assert check(client, quantity=11).status_code == 422

    def test_the_pincode_is_required(self, client, catalogue):
        assert client.get("/api/products/PRD001/availability").status_code == 422

    def test_rate_limited_with_the_pincode_check(self, client, catalogue, listed):
        codes = [check(client).status_code for _ in range(61)]
        assert codes[-1] == 429


class TestVariants:
    @pytest.fixture()
    def variants(self, db, catalogue):
        from app.models import ProductColor, ProductSize

        db.add_all([ProductColor(product_id="PRD001", name="Black", hex="#000", position=0),
                    ProductColor(product_id="PRD001", name="White", hex="#fff", position=1),
                    ProductSize(product_id="PRD001", label="M", position=0),
                    ProductSize(product_id="PRD001", label="L", position=1)])
        db.flush()

    def test_a_size_is_asked_for(self, client, variants, listed):
        data = ok(client)
        assert data["status"] == "select-variant" and data["variant"]["needsSize"] is True

    def test_a_real_variant(self, client, variants, listed):
        data = ok(client, size="M", color="White")
        assert data["available"] is True and data["variant"] == {"size": "M", "color": "White", "needsSize": False}

    @pytest.mark.parametrize("params, code", [({"size": "XL"}, "SIZE_UNAVAILABLE"),
                                              ({"size": "M", "color": "Red"}, "COLOR_UNAVAILABLE")])
    def test_a_variant_it_doesnt_come_in(self, client, variants, listed, params, code):
        response = check(client, **params)
        assert response.status_code == 422 and response.json()["error_code"] == code


class TestTheEstimate:
    def test_a_slower_pincode_arrives_later(self, client, catalogue, listed):
        fast = ok(client, pincode="560001")["estimatedDelivery"]["to"]
        slow = ok(client, pincode="781001")["estimatedDelivery"]["to"]
        assert slow > fast

    def test_handling_days_push_it_back(self, client, admin_auth, catalogue, listed):
        before = ok(client)["estimatedDelivery"]
        client.put("/api/admin/products/PRD001/delivery", headers=admin_auth, json={"dispatchDays": 3})
        after = ok(client)["estimatedDelivery"]
        assert after["dispatchBy"] > before["dispatchBy"] and after["to"] > before["to"]

    def test_holidays_and_cutoff_settings_apply(self, client, admin_auth, catalogue, listed):
        before = ok(client)["estimatedDelivery"]["to"]
        today = datetime.utcnow().date()
        holidays = [date.fromordinal(today.toordinal() + n).isoformat() for n in range(1, 8)]
        response = client.put("/api/admin/delivery/settings", headers=admin_auth,
                              json={"holidays": holidays, "dispatchCutoffHour": 0, "processingDays": 1})
        assert response.status_code == 200, response.text
        assert ok(client)["estimatedDelivery"]["to"] > before

    @pytest.mark.parametrize("bad", [{"dispatchCutoffHour": 25}, {"processingDays": -1}, {"workingDays": []},
                                     {"workingDays": [7]}, {"holidays": ["31-12-2026"]},
                                     {"standardMinDays": 9, "standardMaxDays": 2}, {"codMaxOrderValue": -5}])
    def test_bad_settings_are_refused(self, client, admin_auth, bad):
        response = client.put("/api/admin/delivery/settings", headers=admin_auth, json=bad)
        assert response.status_code == 422, response.text

    def test_a_pincode_change_is_seen_at_once(self, client, admin_auth, catalogue, listed):
        assert ok(client, pincode="400001")["available"] is True  # unlisted: delivered by default
        client.put("/api/admin/delivery/settings", headers=admin_auth, json={"restrictToListed": True})
        assert ok(client, pincode="400001")["status"] == "not-serviceable"


class TestProductRules:
    def test_excluded_places(self, client, admin_auth, catalogue, listed):
        response = client.put("/api/admin/products/PRD001/delivery", headers=admin_auth, json={
            "exclusions": [{"kind": "state", "value": "Assam", "reason": "Fragile: not sent to the North-East"},
                           {"kind": "prefix", "value": "11"}],
            "note": "Glass"})
        assert response.status_code == 200, response.text
        assert ok(client, pincode="781001")["status"] == "restricted"
        assert "Fragile" in ok(client, pincode="781001")["message"]
        assert ok(client, pincode="110001")["status"] == "restricted"
        assert ok(client, pincode="560001")["available"] is True

    def test_no_cod_and_no_express_for_one_product(self, client, admin_auth, catalogue, listed):
        client.put("/api/admin/products/PRD001/delivery", headers=admin_auth,
                   json={"codAllowed": False, "expressAllowed": False})
        data = ok(client)
        assert data["available"] is True
        assert data["codAvailable"] is False and data["expressAvailable"] is False
        assert ok(client, "PRD002")["codAvailable"] is True

    @pytest.mark.parametrize("exclusion", [{"kind": "pincode", "value": "12"}, {"kind": "prefix", "value": "0"},
                                           {"kind": "prefix", "value": "123456"}, {"kind": "state", "value": ""},
                                           {"kind": "city", "value": "Pune"}])
    def test_bad_exclusions_are_refused(self, client, admin_auth, catalogue, exclusion):
        response = client.put("/api/admin/products/PRD001/delivery", headers=admin_auth,
                              json={"exclusions": [exclusion]})
        assert response.status_code == 422

    def test_no_restrictions_leaves_no_row(self, client, db, admin_auth, catalogue):
        from app.models import ProductDeliveryProfile

        client.put("/api/admin/products/PRD001/delivery", headers=admin_auth, json={"codAllowed": False})
        assert db.get(ProductDeliveryProfile, "PRD001") is not None
        data = client.put("/api/admin/products/PRD001/delivery", headers=admin_auth, json={}).json()["data"]
        assert data["configured"] is False
        db.expire_all()
        assert db.get(ProductDeliveryProfile, "PRD001") is None

    def test_needs_the_shipping_permission(self, client, db, catalogue):
        from app.core.security import hash_password
        from app.models import AdminUser

        db.add(AdminUser(id="ADM007", email="writer@dailychoicezone.com", password_hash=hash_password("Admin@123"),
                         name="Writer", role="editor", permissions=["products", "content"], status="active",
                         created_at=datetime(2026, 1, 1)))
        db.flush()
        token = client.post("/api/admin/auth/login", json={"email": "writer@dailychoicezone.com",
                                                           "password": "Admin@123"}).json()["data"]["token"]
        auth = {"Authorization": f"Bearer {token['accessToken']}"}
        assert client.put("/api/admin/products/PRD001/delivery", headers=auth, json={}).status_code == 403


class TestTheBag:
    def test_line_by_line(self, client, admin_auth, auth, catalogue, listed):
        client.put("/api/admin/products/PRD002/delivery", headers=admin_auth,
                   json={"exclusions": [{"kind": "pincode", "value": "560001"}]})
        client.post("/api/cart/items", headers=auth, json={"productId": "PRD001"})
        client.post("/api/cart/items", headers=auth, json={"productId": "PRD002"})
        data = client.get("/api/cart/availability?pincode=560001", headers=auth).json()["data"]
        statuses = {line["productId"]: line["status"] for line in data["lines"]}
        assert statuses == {"PRD001": "available", "PRD002": "restricted"}
        assert data["allAvailable"] is False and data["unavailableCount"] == 1

    def test_a_line_that_sold_out(self, client, db, auth, catalogue, listed):
        from app.models import Product

        client.post("/api/cart/items", headers=auth, json={"productId": "PRD002", "quantity": 2})
        db.get(Product, "PRD002").stock = 1
        db.flush()
        line = client.get("/api/cart/availability?pincode=560001", headers=auth).json()["data"]["lines"][0]
        assert line["status"] == "limited"

    def test_only_your_own_bag(self, client, auth):
        assert client.get("/api/cart/availability?pincode=560001").status_code == 401


class TestCheckoutChecksAgain:
    def test_an_excluded_item_cannot_be_ordered(self, client, admin_auth, auth, catalogue, listed):
        client.put("/api/admin/products/PRD001/delivery", headers=admin_auth,
                   json={"exclusions": [{"kind": "pincode", "value": "560001"}]})
        response = place(client, auth)
        assert response.status_code == 409
        assert response.json()["error_code"] == "PRODUCT_NOT_DELIVERABLE"

    def test_cod_refused_for_an_item_that_doesnt_allow_it(self, client, admin_auth, auth, catalogue, listed):
        client.put("/api/admin/products/PRD001/delivery", headers=admin_auth, json={"codAllowed": False})
        response = place(client, auth, payment="cod")
        assert response.status_code == 409 and response.json()["error_code"] == "COD_UNAVAILABLE"
        assert place(client, auth, payment="card").status_code == 201

    def test_express_refused_for_an_item_that_doesnt_allow_it(self, client, admin_auth, auth, catalogue, listed):
        client.put("/api/admin/products/PRD001/delivery", headers=admin_auth, json={"expressAllowed": False})
        response = place(client, auth, payment="card", delivery="express")
        assert response.status_code == 409 and response.json()["error_code"] == "EXPRESS_UNAVAILABLE"

    def test_the_cod_limit(self, client, admin_auth, auth, catalogue, listed):
        client.put("/api/admin/delivery/settings", headers=admin_auth, json={"codMaxOrderValue": 1500})
        assert ok(client, quantity=2)["codAvailable"] is False
        response = place(client, auth, payment="cod", quantity=2)
        assert response.status_code == 409 and response.json()["error_code"] == "COD_LIMIT_EXCEEDED"

    def test_a_stale_product_page_answer_cant_get_through(self, client, db, auth, catalogue, listed):
        """In stock when checked, sold out by the time of the order."""
        from app.models import Product

        assert ok(client, "PRD002")["available"] is True
        client.post("/api/cart/items", headers=auth, json={"productId": "PRD002"})
        db.get(Product, "PRD002").stock = 0
        db.flush()
        response = client.post("/api/orders", headers=auth, json={
            "shippingAddress": ADDRESS, "billingAddress": None, "deliveryMethod": "standard",
            "paymentMethod": "cod", "couponCode": None, "email": "shopper@example.com", "saveAddress": False,
        })
        assert response.status_code == 409 and response.json()["error_code"] == "INSUFFICIENT_STOCK"

    def test_a_pincode_switched_off_after_the_check(self, client, admin_auth, auth, catalogue, listed):
        assert ok(client, pincode="781001")["available"] is True
        client.put("/api/admin/delivery/settings", headers=admin_auth, json={"restrictToListed": True})
        rows = client.get("/api/admin/delivery/pincodes?q=781001", headers=admin_auth).json()["data"]["items"]
        client.put(f"/api/admin/delivery/pincodes/{rows[0]['id']}", headers=admin_auth,
                   json={**rows[0], "serviceable": False})
        response = place(client, auth, pincode="781001")
        assert response.status_code == 409 and response.json()["error_code"] == "PINCODE_NOT_SERVICEABLE"

    def test_the_order_carries_the_estimate_with_handling_days(self, client, db, admin_auth, auth, catalogue,
                                                               listed):
        from app.models import Order

        plain = place(client, auth)
        assert plain.status_code == 201, plain.text
        client.put("/api/admin/products/PRD001/delivery", headers=admin_auth, json={"dispatchDays": 5})
        slow = place(client, auth)
        assert slow.status_code == 201, slow.text
        first = db.get(Order, plain.json()["data"]["order"]["id"]).expected_delivery
        second = db.get(Order, slow.json()["data"]["order"]["id"]).expected_delivery
        assert first and second and first != second
