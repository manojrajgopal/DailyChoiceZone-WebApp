"""
Abandoned carts: detection, reminders, the recovery link, and the numbers.

The sweep takes `now`, so time is moved by passing a later one rather than by
waiting.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta

import pytest
from sqlalchemy import select

from app.core import rate_limit
from app.models import CartRecovery
from app.services import cart_recovery

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
def mailbox(monkeypatch):
    from app.services import email as email_service

    sent = []

    def record(db, key, *, to, customer_id, subject, html, text, reference=""):
        if not email_service.wants(db, key, customer_id):
            return False
        found = re.search(r"recover=([A-Za-z0-9]+)", text)
        sent.append({"key": key, "to": to, "subject": subject, "html": html,
                     "token": found.group(1) if found else None})
        return True

    monkeypatch.setattr(email_service, "notify", record)
    return sent


def add(client, auth, product="PRD001", quantity=1):
    response = client.post("/api/cart/items", headers=auth, json={"productId": product, "quantity": quantity})
    assert response.status_code in (200, 201), response.text
    return response


def row(db) -> CartRecovery:
    db.expire_all()
    return db.execute(select(CartRecovery).order_by(CartRecovery.id.desc())).scalars().first()


def later(minutes):
    return datetime.utcnow() + timedelta(minutes=minutes)


def order(client, auth):
    response = client.post("/api/orders", headers=auth, json={
        "shippingAddress": ADDRESS, "billingAddress": None, "deliveryMethod": "standard",
        "paymentMethod": "cod", "couponCode": None, "email": "shopper@example.com", "saveAddress": False,
    })
    assert response.status_code == 201, response.text
    return response.json()["data"]


class TestDetection:
    def test_adding_to_the_bag_starts_tracking(self, client, db, auth, catalogue):
        add(client, auth)
        assert row(db).status == "active"

    def test_a_recent_bag_is_not_abandoned(self, client, db, auth, catalogue, mailbox):
        add(client, auth)
        cart_recovery.sweep(db, now=later(30))
        assert row(db).status == "active"

    def test_an_idle_bag_is_abandoned_with_a_snapshot(self, client, db, auth, catalogue, mailbox):
        add(client, auth, quantity=2)
        counts = cart_recovery.sweep(db, now=later(61))
        tracked = row(db)
        assert counts["abandoned"] == 1
        assert tracked.status == "abandoned"
        assert tracked.item_count == 2
        assert tracked.cart_value == 200000  # 2 × ₹1000, in paise
        assert tracked.items[0]["productId"] == "PRD001"

    def test_activity_brings_it_back(self, client, db, auth, catalogue, mailbox):
        add(client, auth)
        cart_recovery.sweep(db, now=later(61))
        add(client, auth, "PRD002")
        assert row(db).status == "active"

    def test_emptying_the_bag_stops_tracking(self, client, db, auth, catalogue):
        add(client, auth)
        client.delete("/api/cart", headers=auth)
        assert row(db).status == "emptied"

    def test_bags_from_before_tracking_are_picked_up(self, client, db, customer, catalogue, mailbox):
        from app.models import CartItem

        db.add(CartItem(customer_id=customer.id, product_id="PRD001", size="", color="", quantity=1))
        db.flush()
        cart_recovery.sweep(db, now=later(1))
        assert row(db) is not None

    def test_nothing_happens_when_switched_off(self, client, db, auth, admin_auth, catalogue, mailbox):
        client.put("/api/admin/carts/settings", headers=admin_auth, json={"enabled": False})
        add(client, auth)
        cart_recovery.sweep(db, now=later(10_000))
        assert row(db).status == "active"
        assert mailbox == []


class TestReminders:
    def test_each_stage_is_sent_once(self, client, db, auth, catalogue, mailbox):
        add(client, auth)
        cart_recovery.sweep(db, now=later(61))          # abandoned
        cart_recovery.sweep(db, now=later(61 + 61))     # first reminder
        cart_recovery.sweep(db, now=later(61 + 70))     # nothing new
        assert len(mailbox) == 1
        assert mailbox[0]["key"] == "cart_reminders"
        assert "Cotton Kurta" in mailbox[0]["html"]
        cart_recovery.sweep(db, now=later(61 + 1500))   # second reminder
        cart_recovery.sweep(db, now=later(61 + 1600))
        assert len(mailbox) == 2
        assert row(db).reminders_sent == 2

    def test_no_reminders_for_someone_who_opted_out(self, client, db, auth, catalogue, mailbox):
        response = client.put("/api/account/email-preferences", headers=auth, json={"cart_reminders": False})
        assert response.status_code == 200, response.text
        add(client, auth)
        cart_recovery.sweep(db, now=later(61))
        cart_recovery.sweep(db, now=later(200))
        assert mailbox == []
        assert row(db).reminders_sent == 0

    def test_an_emptied_bag_gets_no_reminder(self, client, db, auth, catalogue, mailbox):
        add(client, auth)
        cart_recovery.sweep(db, now=later(61))
        client.delete("/api/cart", headers=auth)
        cart_recovery.sweep(db, now=later(200))
        assert mailbox == []

    def test_an_old_bag_expires(self, client, db, auth, catalogue, mailbox):
        add(client, auth)
        cart_recovery.sweep(db, now=later(61))
        cart_recovery.sweep(db, now=later(61 + 15 * 24 * 60))
        assert row(db).status == "expired"

    def test_the_link_is_stored_only_as_a_hash(self, client, db, auth, catalogue, mailbox):
        add(client, auth)
        cart_recovery.sweep(db, now=later(61))
        cart_recovery.sweep(db, now=later(125))
        token = mailbox[0]["token"]
        assert token and row(db).token_hash != token and len(row(db).token_hash) == 64


class TestRecovery:
    @pytest.fixture()
    def reminded(self, client, db, auth, catalogue, mailbox):
        add(client, auth)
        cart_recovery.sweep(db, now=later(61))
        cart_recovery.sweep(db, now=later(125))
        return mailbox[0]["token"]

    def test_the_owner_can_follow_the_link(self, client, db, auth, reminded):
        response = client.post("/api/cart/recover", headers=auth, json={"token": reminded})
        assert response.status_code == 200, response.text
        assert response.json()["data"]["changes"] == []
        assert row(db).clicked_at is not None

    def test_someone_else_cannot_use_the_link(self, client, other_customer, reminded):
        token = client.post("/api/auth/login", json={"email": other_customer.email, "password": "Customer@123"}
                            ).json()["data"]["token"]["accessToken"]
        response = client.post("/api/cart/recover", headers={"Authorization": f"Bearer {token}"},
                               json={"token": reminded})
        assert response.status_code == 404

    def test_the_link_needs_a_sign_in(self, client, reminded):
        assert client.post("/api/cart/recover", json={"token": reminded}).status_code == 401

    def test_a_price_change_is_reported(self, client, db, auth, reminded):
        from app.models import Product

        db.get(Product, "PRD001").price = 900.0
        db.flush()
        changes = client.post("/api/cart/recover", headers=auth, json={"token": reminded}).json()["data"]["changes"]
        assert changes[0]["kind"] == "price" and changes[0]["new"] == 900

    def test_an_unavailable_item_is_reported(self, client, db, auth, reminded):
        from app.models import Product

        db.get(Product, "PRD001").status = "draft"
        db.flush()
        changes = client.post("/api/cart/recover", headers=auth, json={"token": reminded}).json()["data"]["changes"]
        assert changes[0]["kind"] == "unavailable"

    def test_an_emptied_bag_is_refilled(self, client, db, auth, reminded):
        from app.models import CartItem

        for item in db.execute(select(CartItem)).scalars():
            db.delete(item)
        db.flush()
        data = client.post("/api/cart/recover", headers=auth, json={"token": reminded}).json()["data"]
        assert data["restored"] == 1
        assert len(client.get("/api/cart", headers=auth).json()["data"]["items"]) == 1

    def test_an_order_after_a_reminder_is_recovered(self, client, db, auth, settings_documents, reminded):
        client.post("/api/cart/recover", headers=auth, json={"token": reminded})
        placed = order(client, auth)
        tracked = row(db)
        assert tracked.status == "recovered"
        assert tracked.recovered_order_id == placed["order"]["id"]
        assert tracked.recovered_value == 100000

    def test_an_order_without_abandoning_is_just_converted(self, client, db, auth, catalogue, settings_documents):
        add(client, auth)
        order(client, auth)
        assert row(db).status == "converted"


class TestAdmin:
    def test_metrics_count_recoveries_and_revenue(self, client, db, auth, admin_auth, catalogue,
                                                  settings_documents, mailbox):
        add(client, auth)
        cart_recovery.sweep(db, now=later(61))
        cart_recovery.sweep(db, now=later(125))
        order(client, auth)
        data = client.get("/api/admin/carts/abandoned/metrics", headers=admin_auth).json()["data"]
        assert data["abandoned"] == 1 and data["recovered"] == 1
        assert data["recoveryRate"] == 100.0
        assert data["recoveredRevenue"] == 1000.0

    def test_a_cancelled_order_is_not_recovered_revenue(self, client, db, auth, admin_auth, catalogue,
                                                        settings_documents, mailbox):
        from app.models import Order

        add(client, auth)
        cart_recovery.sweep(db, now=later(61))
        placed = order(client, auth)
        db.get(Order, placed["order"]["id"]).status = "cancelled"
        db.flush()
        data = client.get("/api/admin/carts/abandoned/metrics", headers=admin_auth).json()["data"]
        assert data["recovered"] == 1
        assert data["recoveredRevenue"] == 0

    def test_the_list_shows_abandoned_bags(self, client, db, auth, admin_auth, catalogue, mailbox):
        add(client, auth)
        cart_recovery.sweep(db, now=later(61))
        data = client.get("/api/admin/carts/abandoned?status=abandoned", headers=admin_auth).json()["data"]
        assert data["pagination"]["total"] == 1
        assert data["items"][0]["customer"]["email"] == "shopper@example.com"

    @pytest.mark.parametrize("bad", [
        {"abandonAfterMinutes": 5},
        {"abandonAfterMinutes": "soon"},
        {"reminders": [{"afterMinutes": 120}, {"afterMinutes": 60}]},
        {"reminders": "often"},
        {"expireAfterDays": 0},
    ])
    def test_bad_settings_are_refused(self, client, admin_auth, bad):
        assert client.put("/api/admin/carts/settings", headers=admin_auth, json=bad).status_code == 422

    def test_a_role_without_carts_cannot_see_them(self, client, editor):
        token = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"}
                            ).json()["data"]["token"]["accessToken"]
        headers = {"Authorization": f"Bearer {token}"}
        assert client.get("/api/admin/carts/abandoned", headers=headers).status_code == 403
        assert client.put("/api/admin/carts/settings", headers=headers, json={"enabled": False}).status_code == 403
