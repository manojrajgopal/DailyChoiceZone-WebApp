"""
Back-in-stock and price-drop alerts, past `test_alerts.py`: the service's own
input checks, alerts that are closed, waiting or whose customer has gone, the
price sweep, failures that must not break a stock or price change, and the
portal's resend in every state.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.core import rate_limit
from app.models import EmailLog, PriceAlert, PriceAlertNotification, PriceChange, Product, ProductColor, StockAlert
from app.services import alerts
from tests.integration.test_alerts import mailbox, reprice, stock, subscribe_price, subscribe_stock  # noqa: F401

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


def alert_mail(mailbox, prefix):  # noqa: F811
    return [m for m in mailbox if m["reference"].startswith(prefix)]


def resend(client, admin_auth, kind, alert_id):
    return client.post(f"/api/admin/alerts/{kind}/{alert_id}/resend", headers=admin_auth)


class TestSubscribingChecks:
    def test_a_colour_the_product_does_not_come_in(self, client, db, auth, catalogue):
        db.add(ProductColor(product_id="PRD003", name="Black", hex="#000000", position=0))
        db.flush()
        response = subscribe_stock(client, auth, color="Pink")
        assert response.status_code == 422 and response.json()["error_code"] == "COLOR_UNAVAILABLE"
        assert subscribe_stock(client, auth, color="Black").status_code == 201

    def test_a_target_alert_needs_a_target(self, client, auth, catalogue):
        response = subscribe_price(client, auth, mode="target")
        assert response.status_code == 422 and response.json()["error_code"] == "TARGET_REQUIRED"

    def test_an_unknown_mode_is_refused_by_the_api_and_the_service(self, client, db, auth, customer, catalogue):
        from app.core.errors import ValidationError

        assert subscribe_price(client, auth, mode="whenever").status_code == 422
        with pytest.raises(ValidationError) as caught:
            alerts.subscribe_price(db, customer, "PRD001", mode="whenever")
        assert caught.value.error_code == "INVALID_MODE"

    @pytest.mark.parametrize("target", ["cheap", -5])
    def test_the_service_refuses_a_bad_target(self, db, customer, catalogue, target):
        from app.core.errors import ValidationError

        with pytest.raises(ValidationError) as caught:
            alerts.subscribe_price(db, customer, "PRD001", mode="target", target_price=target)
        assert caught.value.error_code == "INVALID_TARGET"

    def test_only_open_alerts_can_be_listed(self, client, db, auth, customer, catalogue):
        alert_id = subscribe_stock(client, auth).json()["data"]["id"]
        client.delete(f"/api/alerts/stock/{alert_id}", headers=auth)
        assert len(alerts.mine(db, customer)["stock"]) == 1
        assert alerts.mine(db, customer, include_closed=False) == {"stock": [], "price": []}

    def test_unsubscribing_twice_is_harmless(self, client, auth, catalogue):
        alert_id = subscribe_price(client, auth).json()["data"]["id"]
        first = client.delete(f"/api/alerts/price/{alert_id}", headers=auth)
        second = client.delete(f"/api/alerts/price/{alert_id}", headers=auth)
        assert first.status_code == second.status_code == 200
        assert second.json()["data"]["status"] == "unsubscribed"

    def test_an_unknown_kind_is_a_422(self, client, auth, catalogue):
        assert client.delete("/api/alerts/wish/1", headers=auth).status_code == 422

    def test_a_brief_of_no_product_is_none(self):
        assert alerts._product_brief(None) is None


class TestFiring:
    def test_a_closed_or_missing_alert_is_not_fired(self, client, db, auth, catalogue, mailbox):  # noqa: F811
        now = datetime.utcnow()
        assert alerts._fire_stock(db, 999999, now) == "closed"
        assert alerts._fire_price(db, 999999, now) == "closed"

    def test_a_recently_tried_alert_waits(self, client, db, auth, catalogue, mailbox):  # noqa: F811
        alert_id = subscribe_stock(client, auth).json()["data"]["id"]
        product = db.get(Product, "PRD003")
        product.stock, product.status = 5, "active"
        alert = db.get(StockAlert, alert_id)
        alert.last_attempt_at = datetime.utcnow()
        db.flush()
        assert alerts._fire_stock(db, alert_id, datetime.utcnow()) == "waiting"
        assert alerts._fire_stock(db, alert_id, datetime.utcnow(), force=True) == "sent"

    def test_a_price_alert_on_a_withdrawn_product(self, client, db, auth, catalogue, mailbox):  # noqa: F811
        alert_id = subscribe_price(client, auth).json()["data"]["id"]
        db.get(Product, "PRD001").status = "archived"
        db.flush()
        assert alerts._fire_price(db, alert_id, datetime.utcnow()) == "unavailable"

    def test_a_price_alert_for_a_blocked_customer_or_a_recent_try(self, client, db, auth, customer, catalogue,
                                                                   mailbox):  # noqa: F811
        alert_id = subscribe_price(client, auth).json()["data"]["id"]
        db.get(Product, "PRD001").price = 900
        db.get(PriceAlert, alert_id).last_attempt_at = datetime.utcnow()
        db.flush()
        assert alerts._fire_price(db, alert_id, datetime.utcnow()) == "waiting"
        customer.status = "blocked"
        db.flush()
        assert alerts._fire_price(db, alert_id, datetime.utcnow()) == "inactive-customer"

    def test_the_latest_change_is_found_and_a_repeat_is_closed_as_a_duplicate(self, client, db, auth, admin_auth,
                                                                             catalogue, mailbox):  # noqa: F811
        alert_id = subscribe_price(client, auth).json()["data"]["id"]
        reprice(client, admin_auth, "PRD001", price=900)
        assert len(alert_mail(mailbox, "price-alert")) == 1
        alert = db.get(PriceAlert, alert_id)
        db.refresh(alert)
        # Reopened by hand: the same change must not be emailed again.
        alert.status, alert.active_key = "active", 1
        db.flush()
        assert alerts._fire_price(db, alert_id, datetime.utcnow(), force=True) == "duplicate"
        assert len(alert_mail(mailbox, "price-alert")) == 1

    def test_a_price_email_that_cannot_go_is_recorded_then_updated(self, client, db, auth, admin_auth, catalogue,
                                                                   mailbox, monkeypatch):  # noqa: F811
        from app.services import email as email_service

        alert_id = subscribe_price(client, auth).json()["data"]["id"]
        working = email_service.notify
        monkeypatch.setattr(email_service, "notify", lambda *a, **k: False)
        reprice(client, admin_auth, "PRD001", price=900)
        db.expire_all()
        alert = db.get(PriceAlert, alert_id)
        record = db.query(PriceAlertNotification).one()
        assert alert.status == "active" and alert.last_error
        assert record.outcome == "not-sent"
        monkeypatch.setattr(email_service, "notify", working)
        assert alerts._fire_price(db, alert_id, datetime.utcnow(), force=True) == "sent"
        db.flush()
        db.expire_all()
        assert db.query(PriceAlertNotification).one().outcome == "queued"

    def test_a_drop_without_a_recorded_change_is_still_logged(self, client, db, auth, catalogue, mailbox):  # noqa: F811
        alert_id = subscribe_price(client, auth).json()["data"]["id"]
        db.get(Product, "PRD001").price = 900
        db.flush()
        assert alerts._fire_price(db, alert_id, datetime.utcnow()) == "sent"
        db.flush()
        record = db.query(PriceAlertNotification).one()
        assert record.price_change_id is None and record.to_price == 90000

    def test_why_not_sent_without_an_email_account(self, db, customer, monkeypatch):
        from app.services import email as email_service

        monkeypatch.setattr(email_service, "active_account", lambda db: None)
        assert "no email account" in alerts._why_not_sent(db, customer)
        monkeypatch.setattr(email_service, "active_account", lambda db: object())
        assert "couldn't be queued" in alerts._why_not_sent(db, customer)

    def test_an_unchanged_price_is_not_a_change(self, db, catalogue):
        product = db.get(Product, "PRD001")
        assert alerts.record_price_change(db, product, old_price=1000, old_original=1250) is None

    def test_a_failing_check_never_breaks_the_caller(self, client, db, auth, catalogue, monkeypatch):
        subscribe_stock(client, auth)

        def boom(*args, **kwargs):
            raise RuntimeError("database hiccup")

        monkeypatch.setattr(alerts, "_fire_stock", boom)
        assert alerts.process_product(db, "PRD003") == {"stock": 0, "price": 0}


class TestTheSweep:
    def test_the_sweep_sends_price_drops_for_both_modes(self, client, db, auth, other_customer, catalogue,
                                                        mailbox):  # noqa: F811
        token = client.post("/api/auth/login", json={"email": other_customer.email, "password": "Customer@123"}
                            ).json()["data"]["token"]["accessToken"]
        subscribe_price(client, auth)
        subscribe_price(client, {"Authorization": f"Bearer {token}"}, mode="target", targetPrice=800)
        db.get(Product, "PRD001").price = 800
        db.flush()
        assert alerts.sweep(db) == {"stock": 0, "price": 2}
        assert alerts.sweep(db) == {"stock": 0, "price": 0}

    def test_a_failing_alert_does_not_stop_the_sweep(self, client, db, auth, catalogue, monkeypatch, mailbox):  # noqa: F811
        subscribe_stock(client, auth)
        subscribe_price(client, auth)
        product = db.get(Product, "PRD003")
        product.stock, product.status = 3, "active"
        db.get(Product, "PRD001").price = 900
        db.flush()

        def boom(*args, **kwargs):
            raise RuntimeError("smtp down")

        monkeypatch.setattr(alerts, "_fire_stock", boom)
        monkeypatch.setattr(alerts, "_fire_price", boom)
        assert alerts.sweep(db) == {"stock": 0, "price": 0}


class TestThePortal:
    def test_filter_by_product_and_see_the_delivery(self, client, db, auth, admin_auth, catalogue, mailbox):  # noqa: F811
        alert_id = subscribe_stock(client, auth).json()["data"]["id"]
        db.add(EmailLog(reference=f"stock-alert-{alert_id}", status="failed", error="Mailbox full",
                        email_type="product_alerts", recipient="shopper@example.com", subject="Back in stock", created_at=datetime.utcnow()))
        db.flush()
        data = client.get("/api/admin/alerts/stock?productId=PRD003", headers=admin_auth).json()["data"]
        assert data["pagination"]["total"] == 1
        assert data["items"][0]["delivery"]["status"] == "failed"
        assert data["items"][0]["delivery"]["error"] == "Mailbox full"
        assert client.get("/api/admin/alerts/stock?productId=PRD001", headers=admin_auth).json()["data"]["items"] == []

    def test_resend_an_unknown_or_unsubscribed_alert(self, client, auth, admin_auth, catalogue):
        assert resend(client, admin_auth, "stock", 999999).json()["error_code"] == "ALERT_NOT_FOUND"
        alert_id = subscribe_stock(client, auth).json()["data"]["id"]
        client.delete(f"/api/alerts/stock/{alert_id}", headers=auth)
        response = resend(client, admin_auth, "stock", alert_id)
        assert response.status_code == 409 and response.json()["error_code"] == "ALERT_UNSUBSCRIBED"

    def test_resend_for_a_blocked_customer(self, client, db, auth, admin_auth, customer, catalogue):
        alert_id = subscribe_stock(client, auth).json()["data"]["id"]
        customer.status = "blocked"
        db.flush()
        response = resend(client, admin_auth, "stock", alert_id)
        assert response.status_code == 409 and response.json()["error_code"] == "CUSTOMER_INACTIVE"

    def test_resend_an_active_price_alert_that_has_not_dropped(self, client, auth, admin_auth, catalogue):
        alert_id = subscribe_price(client, auth).json()["data"]["id"]
        response = resend(client, admin_auth, "price", alert_id)
        assert response.status_code == 409 and response.json()["error_code"] == "NOT_DUE"

    def test_resend_a_notified_stock_alert_that_is_still_true(self, client, db, auth, admin_auth, catalogue,
                                                              mailbox):  # noqa: F811
        alert_id = subscribe_stock(client, auth).json()["data"]["id"]
        stock(client, admin_auth, "PRD003", 5)
        response = resend(client, admin_auth, "stock", alert_id)
        assert response.status_code == 200 and response.json()["data"]["outcome"] == "sent"
        assert len(alert_mail(mailbox, "stock-alert")) == 2

    def test_resend_a_notified_price_alert(self, client, db, auth, admin_auth, catalogue, mailbox):  # noqa: F811
        alert_id = subscribe_price(client, auth).json()["data"]["id"]
        reprice(client, admin_auth, "PRD001", price=900)
        response = resend(client, admin_auth, "price", alert_id)
        assert response.status_code == 200 and response.json()["data"]["outcome"] == "sent"
        outcomes = [n.outcome for n in db.query(PriceAlertNotification).order_by(PriceAlertNotification.id)]
        assert outcomes == ["queued", "resent"]
        reprice(client, admin_auth, "PRD001", price=1000)
        again = resend(client, admin_auth, "price", alert_id)
        assert again.status_code == 409 and again.json()["error_code"] == "NOT_DUE"

    def test_a_resend_that_cannot_go_says_why(self, client, db, auth, admin_auth, catalogue, mailbox,
                                              monkeypatch):  # noqa: F811
        from app.services import email as email_service

        alert_id = subscribe_stock(client, auth).json()["data"]["id"]
        stock(client, admin_auth, "PRD003", 5)
        monkeypatch.setattr(email_service, "notify", lambda *a, **k: False)
        response = resend(client, admin_auth, "stock", alert_id)
        assert response.status_code == 409 and response.json()["error_code"] == "NOT_SENT"
        db.expire_all()
        assert db.get(StockAlert, alert_id).last_error
