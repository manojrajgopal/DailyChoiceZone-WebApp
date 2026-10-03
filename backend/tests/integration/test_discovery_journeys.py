"""
Product discovery, end to end through the API — the five journeys in
docs/product-discovery.md, each the way a shopper would walk it.
"""

from __future__ import annotations

import calendar
from datetime import datetime, timedelta

import pytest

pytestmark = pytest.mark.integration

ADDRESS = {
    "fullName": "Asha Rao", "phone": "9876500001", "line1": "4 Brigade Road", "line2": "",
    "city": "Bengaluru", "state": "Karnataka", "pincode": "560001", "country": "India",
}


def order(client, auth, **overrides):
    body = {"shippingAddress": ADDRESS, "billingAddress": None, "deliveryMethod": "standard", "paymentMethod": "cod",
            "couponCode": None, "email": "shopper@example.com", "saveAddress": False}
    body.update(overrides)
    return client.post("/api/orders", headers=auth, json=body)


def test_guest_views_then_signs_in_and_finds_their_history(client, catalogue, customer):
    """Guest → views A, B, C → signs in → recently viewed shows C, B, A."""
    now = datetime.utcnow()
    browser = [  # what the guest's browser kept, newest first, in ms since the epoch
        {"productId": pid, "viewedAt": calendar.timegm((now - timedelta(minutes=n)).utctimetuple()) * 1000}
        for n, pid in enumerate(["PRD003", "PRD002", "PRD001"])
    ]
    login = client.post("/api/auth/login", json={"email": customer.email, "password": "Customer@123"})
    auth = {"Authorization": f"Bearer {login.json()['data']['token']['accessToken']}"}

    assert client.post("/api/recently-viewed/merge", headers=auth, json={"items": browser}).status_code == 200
    history = client.get("/api/recently-viewed", headers=auth).json()["data"]
    assert [entry["productId"] for entry in history] == ["PRD003", "PRD002", "PRD001"]
    # PRD003 is sold out: listed, but not as something to buy.
    assert history[0]["available"] is False


def test_save_for_later_and_back(client, auth, catalogue, settings_documents):
    """Signed in → add → bag → save for later → bag and saved list → move back."""
    added = client.post("/api/cart/items", headers=auth, json={"productId": "PRD001", "quantity": 2}).json()["data"]
    line = added["items"][0]["id"]

    saved = client.post(f"/api/cart/items/{line}/save-for-later", headers=auth).json()["data"]
    assert saved["cart"]["items"] == []
    assert [(i["productId"], i["quantity"]) for i in saved["saved"]["items"]] == [("PRD001", 2)]
    assert client.get("/api/cart/count", headers=auth).json()["data"]["itemCount"] == 0

    moved = client.post(f"/api/cart/saved/{saved['saved']['items'][0]['id']}/move-to-cart", headers=auth).json()["data"]
    assert [(i["productId"], i["quantity"]) for i in moved["cart"]["items"]] == [("PRD001", 2)]
    assert moved["saved"]["items"] == []
    assert order(client, auth).status_code == 201


def test_related_product_to_bag_to_order(client, db, auth, catalogue, settings_documents):
    """Product → related → click → add to bag from the rail → order, credited to the rail."""
    from app.models import AnalyticsEvent

    related = client.get("/api/products/PRD002/related").json()["data"]
    assert related and related[0]["id"] == "PRD001" and all(p["id"] != "PRD002" for p in related)
    assert client.post("/api/analytics/events", json={"event": "recommendation_click", "visitorId": "visitor-abcdefgh",
                                                      "productId": "PRD001", "placement": "rec:pdp-related"}).status_code == 202
    client.post("/api/cart/items", headers=auth, json={"productId": "PRD001", "source": "rec:pdp-related"})
    assert order(client, auth).status_code == 201
    assert db.query(AnalyticsEvent).filter_by(event="recommendation_purchase", product_id="PRD001").count() == 1


def test_size_guide_units_and_variant(client, admin_auth, db, catalogue):
    """Product → size guide → cm/inches → choose a size the product comes in."""
    from app.models import ProductSize

    for n, label in enumerate(["S", "M"]):
        db.add(ProductSize(product_id="PRD001", label=label, position=n))
    db.flush()
    guide = client.post("/api/admin/size-guides", headers=admin_auth, json={
        "name": "Kurta", "kind": "clothing", "unit": "cm", "isDefault": True,
        "columns": [{"key": "chest", "label": "Chest", "type": "measurement"}],
        "rows": [{"size": "S", "values": {"chest": "86-91"}}, {"size": "M", "values": {"chest": "92-97"}}],
    }).json()["data"]
    cm = client.get("/api/products/PRD001/size-guide").json()["data"]
    inches = client.get("/api/products/PRD001/size-guide?unit=in").json()["data"]
    assert cm["id"] == guide["id"] and cm["source"] == "default"
    assert inches["rows"][1]["values"]["chest"] == {"min": 36.2, "max": 38.2}
    assert cm["sizeMatch"]["consistent"] is True
    availability = client.get("/api/products/PRD001/availability?pincode=560001&size=M").json()["data"]
    assert availability["available"] is True and availability["variant"]["size"] == "M"


def test_availability_then_checkout_checks_again(client, admin_auth, db, auth, catalogue, settings_documents):
    """Product → pincode → available → (stock and rules change) → checkout refuses, with the reason."""
    from app.models import Product

    client.post("/api/admin/delivery/pincodes", headers=admin_auth,
                json={"pincode": "560001", "city": "Bengaluru", "state": "Karnataka", "minDays": 1, "maxDays": 3})
    seen = client.get("/api/products/PRD002/availability?pincode=560001").json()["data"]
    assert seen["available"] is True and seen["codAvailable"] is True and seen["estimatedDelivery"]

    client.post("/api/cart/items", headers=auth, json={"productId": "PRD002"})
    # Between the product page and the payment button, the store stops cash
    # on delivery for this product…
    client.put("/api/admin/products/PRD002/delivery", headers=admin_auth, json={"codAllowed": False})
    refused = order(client, auth)
    assert refused.status_code == 409 and refused.json()["error_code"] == "COD_UNAVAILABLE"
    # …and then it sells out.
    db.get(Product, "PRD002").stock = 0
    db.flush()
    refused = order(client, auth, paymentMethod="card")
    assert refused.status_code == 409 and refused.json()["error_code"] == "INSUFFICIENT_STOCK"
