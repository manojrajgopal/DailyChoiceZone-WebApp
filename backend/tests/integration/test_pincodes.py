"""
Pincode serviceability: the public check, the admin list, and the rule at checkout.

No real-world coverage is assumed: every pincode here is one a test listed.
"""

from __future__ import annotations

import pytest

from app.core import rate_limit

pytestmark = pytest.mark.integration

ADDRESS = {
    "fullName": "Asha Rao", "phone": "9876500001", "line1": "4 Brigade Road", "line2": "",
    "city": "Bengaluru", "state": "Karnataka", "pincode": "560001", "country": "India",
    "email": "shopper@example.com",
}


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def listed(client, admin_auth):
    """Three listed pincodes: full service, prepaid only, and not delivered."""
    rows = [
        {"pincode": "560001", "city": "Bengaluru", "state": "Karnataka", "minDays": 1, "maxDays": 3,
         "deliveryFee": 49, "courier": "Test courier"},
        {"pincode": "110001", "city": "New Delhi", "state": "Delhi", "codAvailable": False,
         "expressAvailable": False, "minDays": 3, "maxDays": 6},
        {"pincode": "799001", "city": "Agartala", "state": "Tripura", "serviceable": False},
    ]
    out = []
    for row in rows:
        response = client.post("/api/admin/delivery/pincodes", headers=admin_auth, json=row)
        assert response.status_code == 201, response.text
        out.append(response.json()["data"])
    return out


def check(client, code):
    return client.get(f"/api/delivery/pincodes/{code}")


def place(client, auth, *, pincode="560001", payment="cod", delivery="standard"):
    client.post("/api/cart/items", headers=auth, json={"productId": "PRD001", "quantity": 1})
    return client.post("/api/orders", headers=auth, json={
        "shippingAddress": {**ADDRESS, "pincode": pincode}, "billingAddress": None,
        "deliveryMethod": delivery, "paymentMethod": payment, "couponCode": None,
        "email": "shopper@example.com", "saveAddress": False,
    })


class TestTheCheck:
    @pytest.mark.parametrize("code", ["12345", "1234567", "012345", "abcdef", "56 00 1x"])
    def test_a_malformed_pincode_is_invalid(self, client, settings_documents, code):
        data = check(client, code).json()["data"]
        assert data["valid"] is False
        assert data["serviceable"] is False

    def test_a_listed_pincode_reports_its_terms(self, client, settings_documents, listed):
        data = check(client, "560001").json()["data"]
        assert data["serviceable"] is True and data["listed"] is True
        assert data["codAvailable"] is True and data["expressAvailable"] is True
        assert data["deliveryFee"] == 49
        assert data["minDays"] == 1 and data["maxDays"] == 3
        assert data["estimate"]
        assert data["city"] == "Bengaluru"

    def test_cod_can_be_unavailable(self, client, settings_documents, listed):
        data = check(client, "110001").json()["data"]
        assert data["serviceable"] is True
        assert data["codAvailable"] is False and data["expressAvailable"] is False

    def test_a_pincode_marked_unserviceable_is_refused(self, client, settings_documents, listed):
        data = check(client, "799001").json()["data"]
        assert data["serviceable"] is False
        assert data["reason"]

    def test_an_unlisted_pincode_follows_the_store_setting(self, client, admin_auth, settings_documents):
        assert check(client, "400001").json()["data"]["serviceable"] is True
        saved = client.put("/api/admin/delivery/settings", headers=admin_auth, json={"restrictToListed": True})
        assert saved.status_code == 200
        assert check(client, "400001").json()["data"]["serviceable"] is False

    def test_a_disabled_entry_is_ignored(self, client, admin_auth, settings_documents, listed):
        blocked = listed[2]
        client.put(f"/api/admin/delivery/pincodes/{blocked['id']}", headers=admin_auth,
                   json={**blocked, "active": False})
        # Back to the default for unlisted pincodes, which is to deliver.
        data = check(client, "799001").json()["data"]
        assert data["serviceable"] is True and data["listed"] is False

    def test_the_check_is_rate_limited(self, client, settings_documents):
        codes = [check(client, "560001").status_code for _ in range(61)]
        assert codes[-1] == 429


class TestCheckout:
    def test_an_unserviceable_pincode_cannot_be_ordered_to(self, client, auth, catalogue, settings_documents,
                                                           listed):
        response = place(client, auth, pincode="799001")
        assert response.status_code == 409
        assert response.json()["error_code"] == "PINCODE_NOT_SERVICEABLE"

    def test_an_invalid_pincode_is_refused(self, client, auth, catalogue, settings_documents):
        response = place(client, auth, pincode="000000")
        assert response.status_code in (409, 422)

    def test_cod_is_refused_where_it_is_not_offered(self, client, auth, catalogue, settings_documents, listed):
        response = place(client, auth, pincode="110001", payment="cod")
        assert response.status_code == 409
        assert response.json()["error_code"] == "COD_UNAVAILABLE"

    def test_express_is_refused_where_it_is_not_offered(self, client, auth, catalogue, settings_documents, listed):
        response = place(client, auth, pincode="110001", payment="card", delivery="express")
        assert response.status_code == 409
        assert response.json()["error_code"] == "EXPRESS_UNAVAILABLE"

    def test_the_pincode_fee_is_what_is_charged(self, client, db, auth, catalogue, settings_documents, listed):
        from app.models import SettingDocument

        store = db.get(SettingDocument, "store")
        store.value = {"shipping": {"freeDeliveryThreshold": 100000, "standardFee": 79, "expressFee": 149}}
        db.flush()

        quoted = client.post("/api/cart/items", headers=auth, json={"productId": "PRD001", "quantity": 1})
        assert quoted.status_code in (200, 201)
        cart = client.get("/api/cart?pincode=560001", headers=auth).json()["data"]
        assert cart["breakdown"]["shipping"] == 4900  # paise
        assert cart["delivery"]["serviceable"] is True
        assert client.get("/api/cart", headers=auth).json()["data"]["breakdown"]["shipping"] == 7900

        order = client.post("/api/orders", headers=auth, json={
            "shippingAddress": ADDRESS, "billingAddress": None, "deliveryMethod": "standard",
            "paymentMethod": "cod", "couponCode": None, "email": "shopper@example.com", "saveAddress": False,
        })
        assert order.status_code == 201, order.text
        from app.models import Order

        placed = db.get(Order, order.json()["data"]["order"]["id"])
        assert float(placed.delivery_fee) == 49

    def test_a_listed_pincode_sets_the_delivery_estimate(self, client, db, auth, catalogue, settings_documents,
                                                         listed):
        response = place(client, auth, pincode="560001")
        assert response.status_code == 201, response.text
        assert response.json()["data"]["order"]["expectedDelivery"]


class TestAdmin:
    def test_the_list_filters_and_counts(self, client, admin_auth, listed):
        data = client.get("/api/admin/delivery/pincodes?cod=no", headers=admin_auth).json()["data"]
        assert [r["pincode"] for r in data["items"]] == ["110001"]
        assert set(data["states"]) >= {"Delhi", "Karnataka", "Tripura"}
        assert client.get("/api/admin/delivery/pincodes?q=Agartala",
                          headers=admin_auth).json()["data"]["items"][0]["pincode"] == "799001"

    def test_a_pincode_is_listed_once(self, client, admin_auth, listed):
        again = client.post("/api/admin/delivery/pincodes", headers=admin_auth, json={"pincode": "560001"})
        assert again.status_code == 409

    @pytest.mark.parametrize("bad", [
        {"pincode": "12345"},
        {"pincode": "400001", "minDays": 5, "maxDays": 2},
        {"pincode": "400001", "deliveryFee": -1},
        {"pincode": "400001", "minDays": "soon"},
    ])
    def test_bad_entries_are_refused(self, client, admin_auth, bad):
        assert client.post("/api/admin/delivery/pincodes", headers=admin_auth, json=bad).status_code == 422

    def test_a_csv_import_adds_and_updates(self, client, admin_auth, listed):
        content = ("pincode,city,state,serviceable,codAvailable,minDays,maxDays,deliveryFee\n"
                   "560001,Bengaluru,Karnataka,yes,no,2,4,59\n"
                   "600001,Chennai,Tamil Nadu,yes,yes,2,5,\n")
        response = client.post("/api/admin/delivery/pincodes/import", headers=admin_auth, json={"content": content})
        assert response.status_code == 200, response.text
        assert response.json()["data"]["created"] == 1 and response.json()["data"]["updated"] == 1
        assert check(client, "560001").json()["data"]["codAvailable"] is False
        assert check(client, "600001").json()["data"]["listed"] is True

    def test_a_csv_with_any_bad_row_imports_nothing(self, client, admin_auth):
        content = "pincode,city\n600001,Chennai\n12,Nowhere\n600001,Twice\n"
        data = client.post("/api/admin/delivery/pincodes/import", headers=admin_auth,
                           json={"content": content}).json()["data"]
        assert data["created"] == 0 and data["errorCount"] == 2
        assert {e["line"] for e in data["errors"]} == {3, 4}
        assert client.get("/api/admin/delivery/pincodes", headers=admin_auth).json()["data"]["items"] == []

    def test_export_returns_every_entry(self, client, admin_auth, listed):
        data = client.get("/api/admin/delivery/pincodes/export", headers=admin_auth).json()["data"]
        assert len(data["items"]) == 3 and "pincode" in data["columns"]

    def test_a_role_without_shipping_cannot_manage_pincodes(self, client, editor):
        token = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"}
                            ).json()["data"]["token"]["accessToken"]
        headers = {"Authorization": f"Bearer {token}"}
        assert client.get("/api/admin/delivery/pincodes", headers=headers).status_code == 403
        assert client.post("/api/admin/delivery/pincodes", headers=headers,
                           json={"pincode": "560001"}).status_code == 403

    def test_customers_cannot_reach_the_admin_endpoints(self, client, auth):
        assert client.get("/api/admin/delivery/pincodes", headers=auth).status_code in (401, 403)
