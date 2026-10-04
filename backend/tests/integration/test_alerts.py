"""
Back-in-stock and price-drop alerts: subscribing, firing on real stock and
price changes made through the portal, firing once, and the admin view.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from sqlalchemy import select

from app.core import rate_limit
from app.models import PriceAlert, PriceAlertNotification, PriceChange, StockAlert

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def mailbox(monkeypatch):
    """Emails queued, respecting preferences the way the real `notify` does."""
    from app.services import email as email_service

    sent = []

    def record(db, key, *, to, customer_id, subject, html, text, reference="", **_):
        if not email_service.wants(db, key, customer_id):
            return False
        sent.append({"key": key, "to": to, "subject": subject, "html": html, "reference": reference})
        return True

    monkeypatch.setattr(email_service, "notify", record)
    return sent


def stock(client, admin_auth, product_id, quantity):
    response = client.put(f"/api/admin/inventory/{product_id}", headers=admin_auth,
                          json={"quantity": quantity, "reason": "restock"})
    assert response.status_code == 200, response.text
    return response


def reprice(client, admin_auth, product_id, **fields):
    response = client.put(f"/api/products/{product_id}", headers=admin_auth, json=fields)
    assert response.status_code == 200, response.text
    return response


def subscribe_stock(client, auth, product="PRD003", **extra):
    return client.post("/api/alerts/stock", headers=auth, json={"productId": product, **extra})


def subscribe_price(client, auth, product="PRD001", **extra):
    return client.post("/api/alerts/price", headers=auth, json={"productId": product, **extra})


class TestStockAlerts:
    def test_a_sold_out_product_can_be_watched(self, client, auth, catalogue):
        response = subscribe_stock(client, auth)
        assert response.status_code == 201, response.text
        assert response.json()["data"]["status"] == "active"
        assert response.json()["data"]["alreadySubscribed"] is False

    def test_an_in_stock_product_cannot(self, client, auth, catalogue):
        response = subscribe_stock(client, auth, "PRD001")
        assert response.status_code == 409
        assert response.json()["error_code"] == "IN_STOCK"

    def test_a_second_request_is_not_a_second_alert(self, client, db, auth, catalogue):
        subscribe_stock(client, auth)
        again = subscribe_stock(client, auth)
        assert again.json()["data"]["alreadySubscribed"] is True
        assert "already" in again.json()["message"]
        assert db.query(StockAlert).count() == 1

    def test_an_unknown_variant_is_refused(self, client, auth, catalogue):
        assert subscribe_stock(client, auth, size="XXXL").status_code == 422

    def test_drafts_and_strangers_are_refused(self, client, auth, catalogue):
        assert subscribe_stock(client, auth, "PRD004").status_code == 404
        assert client.post("/api/alerts/stock", json={"productId": "PRD003"}).status_code == 401

    def test_restocking_emails_once(self, client, db, auth, admin_auth, catalogue, mailbox):
        subscribe_stock(client, auth)
        stock(client, admin_auth, "PRD003", 5)
        alerts = [m for m in mailbox if m["reference"].startswith("stock-alert")]
        assert len(alerts) == 1 and "back" in alerts[0]["subject"].lower()
        db.expire_all()
        row = db.query(StockAlert).one()
        assert row.status == "notified" and row.notified_at is not None
        # Another stock change, and the sweep, don't email again.
        stock(client, admin_auth, "PRD003", 9)
        from app.services import alerts

        alerts.sweep(db)
        assert len([m for m in mailbox if m["reference"].startswith("stock-alert")]) == 1

    def test_after_selling_out_again_they_can_watch_again(self, client, db, auth, admin_auth, catalogue, mailbox):
        subscribe_stock(client, auth)
        stock(client, admin_auth, "PRD003", 2)
        stock(client, admin_auth, "PRD003", 0)
        response = subscribe_stock(client, auth)
        assert response.status_code == 201 and response.json()["data"]["alreadySubscribed"] is False
        assert db.query(StockAlert).count() == 2

    def test_stock_held_for_unpaid_orders_isnt_available(self, client, db, auth, admin_auth, catalogue, mailbox):
        from app.models import Product

        subscribe_stock(client, auth)
        product = db.get(Product, "PRD003")
        product.reserved_stock = 3
        db.flush()
        stock(client, admin_auth, "PRD003", 3)  # all of it held
        assert not [m for m in mailbox if m["reference"].startswith("stock-alert")]

    def test_the_sweep_catches_stock_changed_elsewhere(self, client, db, auth, catalogue, mailbox):
        from app.models import Product
        from app.services import alerts

        subscribe_stock(client, auth)
        product = db.get(Product, "PRD003")
        product.stock, product.status = 4, "active"
        db.flush()
        counts = alerts.sweep(db)
        assert counts["stock"] == 1

    def test_unsubscribing_stops_it(self, client, db, auth, admin_auth, catalogue, mailbox):
        alert_id = subscribe_stock(client, auth).json()["data"]["id"]
        removed = client.delete(f"/api/alerts/stock/{alert_id}", headers=auth)
        assert removed.status_code == 200 and removed.json()["data"]["status"] == "unsubscribed"
        stock(client, admin_auth, "PRD003", 5)
        assert not mailbox

    def test_another_customer_cannot_touch_it(self, client, auth, other_customer, catalogue):
        alert_id = subscribe_stock(client, auth).json()["data"]["id"]
        token = client.post("/api/auth/login", json={"email": other_customer.email, "password": "Customer@123"}
                            ).json()["data"]["token"]["accessToken"]
        response = client.delete(f"/api/alerts/stock/{alert_id}", headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 404

    def test_opted_out_customers_are_not_emailed_and_the_reason_is_kept(self, client, db, auth, admin_auth,
                                                                         catalogue, mailbox):
        client.put("/api/account/email-preferences", headers=auth, json={"product_alerts": False})
        subscribe_stock(client, auth)
        stock(client, admin_auth, "PRD003", 5)
        db.expire_all()
        row = db.query(StockAlert).one()
        assert not mailbox
        assert row.status == "active" and "preferences" in row.last_error and row.attempts == 1

    def test_a_blocked_customer_is_skipped(self, client, db, auth, admin_auth, customer, catalogue, mailbox):
        subscribe_stock(client, auth)
        customer.status = "blocked"
        db.flush()
        stock(client, admin_auth, "PRD003", 5)
        assert not mailbox

    def test_the_account_lists_alerts(self, client, auth, catalogue):
        subscribe_stock(client, auth)
        subscribe_price(client, auth)
        data = client.get("/api/alerts", headers=auth).json()["data"]
        assert len(data["stock"]) == 1 and len(data["price"]) == 1
        assert data["stock"][0]["product"]["name"] == "Wireless Earbuds"
        on_page = client.get("/api/alerts/products/wireless-earbuds", headers=auth).json()["data"]
        assert on_page["stock"][0]["id"] == data["stock"][0]["id"]


class TestPriceAlerts:
    def test_any_drop(self, client, db, auth, admin_auth, catalogue, mailbox):
        assert subscribe_price(client, auth).status_code == 201
        reprice(client, admin_auth, "PRD001", price=950)
        sent = [m for m in mailbox if m["reference"].startswith("price-alert")]
        assert len(sent) == 1 and "₹950.00" in sent[0]["subject"]
        db.expire_all()
        alert = db.query(PriceAlert).one()
        assert alert.status == "notified" and alert.notified_price == 95000
        record = db.query(PriceAlertNotification).one()
        assert (record.from_price, record.to_price) == (100000, 95000)

    def test_a_rise_is_not_a_drop(self, client, auth, admin_auth, catalogue, mailbox):
        subscribe_price(client, auth)
        reprice(client, admin_auth, "PRD001", price=1100)
        assert not mailbox

    def test_only_the_selling_price_counts(self, client, db, auth, admin_auth, catalogue, mailbox):
        subscribe_price(client, auth)
        reprice(client, admin_auth, "PRD001", originalPrice=2000, description="New words")
        assert not mailbox
        assert db.query(PriceChange).count() == 0

    def test_a_target_waits_for_the_target(self, client, db, auth, admin_auth, catalogue, mailbox):
        assert subscribe_price(client, auth, mode="target", targetPrice=800).status_code == 201
        reprice(client, admin_auth, "PRD001", price=900)
        assert not mailbox
        reprice(client, admin_auth, "PRD001", price=799)
        assert len(mailbox) == 1
        assert db.query(PriceChange).count() == 2

    @pytest.mark.parametrize("target", [1000, 1500, 0])
    def test_a_target_must_be_below_todays_price(self, client, auth, catalogue, target):
        response = subscribe_price(client, auth, mode="target", targetPrice=target)
        assert response.status_code == 422

    def test_asking_again_updates_the_alert(self, client, db, auth, catalogue):
        subscribe_price(client, auth)
        again = subscribe_price(client, auth, mode="target", targetPrice=700)
        assert again.json()["data"]["alreadySubscribed"] is True
        assert again.json()["data"]["targetPrice"] == 700
        assert db.query(PriceAlert).count() == 1

    def test_one_change_emails_once_even_if_processed_twice(self, client, db, auth, admin_auth, catalogue, mailbox):
        from app.services import alerts

        subscribe_price(client, auth)
        reprice(client, admin_auth, "PRD001", price=900)
        change = db.query(PriceChange).one()
        alerts.process_product(db, "PRD001", change_id=change.id)
        alerts.sweep(db)
        assert len(mailbox) == 1

    def test_later_drops_need_a_new_alert(self, client, db, auth, admin_auth, catalogue, mailbox):
        subscribe_price(client, auth)
        reprice(client, admin_auth, "PRD001", price=900)
        reprice(client, admin_auth, "PRD001", price=1000)
        reprice(client, admin_auth, "PRD001", price=850)
        assert len(mailbox) == 1
        assert subscribe_price(client, auth).json()["data"]["alreadySubscribed"] is False


class TestAdmin:
    def test_list_filter_and_search(self, client, auth, admin_auth, catalogue, mailbox):
        subscribe_stock(client, auth)
        stock(client, admin_auth, "PRD003", 5)
        data = client.get("/api/admin/alerts/stock?status=notified", headers=admin_auth).json()["data"]
        assert data["pagination"]["total"] == 1
        row = data["items"][0]
        assert row["customer"]["email"] == "shopper@example.com" and row["notifiedAt"]
        assert client.get("/api/admin/alerts/stock?status=active", headers=admin_auth).json()["data"]["items"] == []

    def test_found_by_product_and_customer_id_never_by_name(self, client, auth, admin_auth, catalogue, mailbox):
        subscribe_stock(client, auth)
        total = lambda query: client.get(f"/api/admin/alerts/stock?{query}",  # noqa: E731
                                         headers=admin_auth).json()["data"]["pagination"]["total"]
        customer_id = client.get("/api/admin/alerts/stock", headers=admin_auth).json()["data"]["items"][0]["customer"]["id"]
        assert total("productId=PRD003") == 1
        assert total("productId=DCZ-EL0003") == 1  # the SKU is an identifier too
        assert total("productId=PRD001") == 0
        assert total(f"customerId={customer_id}") == 1
        assert total(f"customerId={customer_id}&productId=PRD001") == 0
        assert total("q=PRD003") == 1 and total(f"q={customer_id}") == 1
        # Names, emails and fragments of an ID are not IDs.
        for text in ("Earbuds", "Wireless", "shopper@example.com", "shopper", "PRD00"):
            assert total(f"q={text}") == 0
        assert total("customerId=shopper") == 0 and total("productId=Earbuds") == 0

    def test_a_failed_send_is_visible_and_can_be_retried(self, client, db, auth, admin_auth, catalogue, mailbox,
                                                         monkeypatch):
        from app.services import email as email_service

        real = email_service.notify
        monkeypatch.setattr(email_service, "notify", lambda *a, **k: False)
        subscribe_stock(client, auth)
        stock(client, admin_auth, "PRD003", 5)
        listing = client.get("/api/admin/alerts/stock?status=failing", headers=admin_auth).json()["data"]
        assert listing["pagination"]["total"] == 1 and listing["items"][0]["lastError"]
        alert_id = listing["items"][0]["id"]
        monkeypatch.setattr(email_service, "notify", real)
        retried = client.post(f"/api/admin/alerts/stock/{alert_id}/resend", headers=admin_auth)
        assert retried.status_code == 200 and retried.json()["data"]["outcome"] == "sent"
        assert len(mailbox) == 1

    def test_resend_refused_when_no_longer_true(self, client, auth, admin_auth, catalogue, mailbox):
        subscribe_stock(client, auth)
        stock(client, admin_auth, "PRD003", 5)
        alert_id = client.get("/api/admin/alerts/stock", headers=admin_auth).json()["data"]["items"][0]["id"]
        stock(client, admin_auth, "PRD003", 0)
        response = client.post(f"/api/admin/alerts/stock/{alert_id}/resend", headers=admin_auth)
        assert response.status_code == 409 and response.json()["error_code"] == "NOT_DUE"

    def test_price_history_is_shown(self, client, auth, admin_auth, catalogue, mailbox):
        subscribe_price(client, auth)
        reprice(client, admin_auth, "PRD001", price=900)
        row = client.get("/api/admin/alerts/price", headers=admin_auth).json()["data"]["items"][0]
        assert row["history"][0]["fromPrice"] == 1000 and row["history"][0]["toPrice"] == 900

    def test_permissions(self, client, auth, editor):
        token = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"}
                            ).json()["data"]["token"]["accessToken"]
        assert client.get("/api/admin/alerts/stock", headers={"Authorization": f"Bearer {token}"}).status_code == 403
        assert client.get("/api/admin/alerts/stock", headers=auth).status_code in (401, 403)
