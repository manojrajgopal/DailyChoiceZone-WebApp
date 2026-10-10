"""
Alerts for the store team (docs/notifications.md): who hears, on which
channel, for which events — and the "Notify me" waitlist the team can see.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from sqlalchemy import select

from app.core import rate_limit
from app.models import Notification, NotificationDelivery, SettingDocument, StockAlert
from tests.integration.messaging_helpers import sms_whatsapp  # noqa: F401
from tests.integration.test_shipping_helpers import place_order
from tests.integration.test_suppliers_helpers import role_headers

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def mail(monkeypatch):
    """Every email `notify` is asked to send, staff and customer alike."""
    from app.services import email as email_service

    sent = []

    def record(db, key, *, to, customer_id, subject, html, text, reference="", **kw):
        sent.append({"key": key, "to": to, "subject": subject, "text": text, "key_id": kw.get("idempotency_key")})
        return True

    monkeypatch.setattr(email_service, "notify", record)
    return sent


def staff_mail(mail):
    return [m for m in mail if m["key"] == "store_team"]


def configure(db, **notifications):
    """Save the store's notification settings the way the settings screen does."""
    from app.services import staff_alerts

    row = db.get(SettingDocument, "store")
    section = staff_alerts.clean(notifications)
    if row is None:
        db.add(SettingDocument(key="store", value={"notifications": section}))
    else:
        row.value = {**(row.value or {}), "notifications": {**(row.value or {}).get("notifications", {}), **section}}
    db.flush()


def tray(db, kind=None):
    db.flush()
    db.expire_all()
    statement = select(Notification).order_by(Notification.created_at)
    if kind:
        statement = statement.where(Notification.kind == kind)
    return db.execute(statement).scalars().all()


def deliveries(db, channel):
    db.expire_all()
    return db.execute(select(NotificationDelivery).where(NotificationDelivery.channel == channel,
                                                         NotificationDelivery.event == "store_alert")).scalars().all()


# ------------------------------------------------------------ the pipeline


class TestWhoHears:
    def test_alert_recipients_get_every_alert_with_the_administrators(self, db, admin, mail):
        from app.services import inbox

        configure(db, alertRecipients={"emails": ["Owner@Gmail.com", "owner@gmail.com"], "phones": []})
        inbox.staff(db, "webhook", "Payment webhook failed", "boom", "/admin/payments", permission="payments")
        assert {m["to"] for m in staff_mail(mail)} == {admin.email, "owner@gmail.com"}
        assert len(tray(db, "webhook")) == 1

    def test_each_alert_is_its_own_delivery(self, db, admin, mail):
        from app.services import inbox

        inbox.staff(db, "webhook", "One", permission="payments")
        inbox.staff(db, "webhook", "Two", permission="payments")
        keys = [m["key_id"] for m in staff_mail(mail)]
        assert len(keys) == 2 and len(set(keys)) == 2

    def test_an_address_that_cannot_receive_mail_is_skipped(self, db, admin, mail, monkeypatch):
        from app.services import inbox
        from app.services.email import senders

        monkeypatch.setattr(senders, "undeliverable",
                            lambda address: "no such domain" if address.endswith("dailychoicezone.com") else "")
        configure(db, alertRecipients={"emails": ["owner@gmail.com"], "phones": []})
        inbox.staff(db, "webhook", "Payment webhook failed", permission="payments")
        assert [m["to"] for m in staff_mail(mail)] == ["owner@gmail.com"]

    def test_sms_and_whatsapp_go_to_the_recipients_phones(self, db, admin, mail, sms_whatsapp):  # noqa: F811
        from app.services import inbox
        from app.services.messaging import service as messaging

        configure(db, alertRecipients={"emails": [], "phones": ["98765 43210"]},
                  alertChannels={"email": True, "sms": True, "whatsapp": True, "inApp": True},
                  whatsappAlertTemplate={"name": "store_alert", "language": "en"})
        inbox.staff(db, "order", "New order DCZ1 — ₹500.00", "Asha · 1 item(s)", "/admin/orders/detail?id=O1",
                    permission="orders", key="order:DCZ1")
        db.commit()
        [sms_row], [wa_row] = deliveries(db, "sms"), deliveries(db, "whatsapp")
        assert sms_row.recipient == "+919876543210" and sms_row.status == "queued"
        assert "New order DCZ1" in sms_row.payload["text"] and "/admin/orders/detail?id=O1" in sms_row.payload["text"]
        assert wa_row.payload["template"] == "store_alert"
        assert wa_row.payload["variables"][0] == "New order DCZ1 — ₹500.00"
        messaging.process(db)
        sms, whatsapp = sms_whatsapp
        assert [m.to for m in sms.sent] == ["+919876543210"] and whatsapp.sent[0].template == "store_alert"

    def test_without_a_provider_the_message_is_recorded_as_skipped_with_the_reason(self, db, admin, mail):
        from app.services import inbox

        configure(db, alertRecipients={"emails": [], "phones": ["+919876543210"]},
                  alertChannels={"email": True, "sms": True, "whatsapp": True, "inApp": True})
        inbox.staff(db, "order", "New order", permission="orders")
        db.commit()
        [sms_row], [wa_row] = deliveries(db, "sms"), deliveries(db, "whatsapp")
        assert sms_row.status == "skipped" and sms_row.last_error
        assert wa_row.status == "skipped" and wa_row.last_error
        # Kept, so "Retry" can send it once the provider is set up.
        assert sms_row.payload["text"] == "New order"

    def test_whatsapp_needs_an_approved_template(self, db, admin, mail, sms_whatsapp):  # noqa: F811
        from app.services import inbox

        configure(db, alertRecipients={"emails": [], "phones": ["+919876543210"]},
                  alertChannels={"email": False, "sms": False, "whatsapp": True, "inApp": False})
        inbox.staff(db, "order", "New order", permission="orders")
        db.commit()
        [row] = deliveries(db, "whatsapp")
        assert row.status == "skipped" and "template" in row.last_error

    def test_a_group_switched_off_sends_nothing_anywhere(self, db, admin, mail):
        from app.services import inbox

        configure(db, orderAlerts=False)
        inbox.staff(db, "order", "New order", permission="orders")
        assert staff_mail(mail) == [] and tray(db, "order") == []

    def test_alerts_about_something_broken_cannot_be_switched_off(self, db, admin, mail):
        from app.services import inbox

        configure(db, orderAlerts=False, paymentAlerts=False, lowStockAlerts=False)
        inbox.staff(db, "refund", "Refund failed", permission="orders")
        assert len(staff_mail(mail)) == 1

    def test_channels_switched_off(self, db, admin, mail):
        from app.services import inbox

        configure(db, alertChannels={"email": False, "sms": False, "whatsapp": False, "inApp": True})
        inbox.staff(db, "order", "New order", permission="orders")
        assert staff_mail(mail) == [] and len(tray(db, "order")) == 1


class TestSettings:
    def test_recipients_are_checked_and_tidied(self, client, admin_auth):
        response = client.put("/api/admin/settings/store", headers=admin_auth, json={"notifications": {
            "alertRecipients": {"emails": [" Owner@Gmail.com "], "phones": ["98765 43210"]}}})
        assert response.status_code == 200, response.text
        saved = client.get("/api/admin/settings/store", headers=admin_auth).json()["data"]["notifications"]
        assert saved["alertRecipients"] == {"emails": ["owner@gmail.com"], "phones": ["+919876543210"]}

    @pytest.mark.parametrize("recipients", [{"emails": ["not-an-email"]}, {"phones": ["12"]},
                                            {"emails": [f"a{i}@x.com" for i in range(11)]}])
    def test_bad_recipients_are_refused(self, client, admin_auth, recipients):
        response = client.put("/api/admin/settings/store", headers=admin_auth,
                              json={"notifications": {"alertRecipients": recipients}})
        assert response.status_code == 422, response.text

    def test_channel_status_and_a_test_alert(self, client, db, admin_auth, admin, mail):
        status = client.get("/api/admin/alert-channels", headers=admin_auth).json()["data"]
        assert status["inApp"]["configured"] is True
        assert status["sms"]["configured"] is False and status["sms"]["reason"]
        response = client.post("/api/admin/alert-channels/test", headers=admin_auth)
        assert response.status_code == 200, response.text
        assert response.json()["data"]["sent"]["email"] == [admin.email]
        assert len(tray(db, "test")) == 1

    def test_only_settings_managers_may_send_a_test(self, client, db):
        headers = role_headers(db, "ADM910", "staff")
        assert client.post("/api/admin/alert-channels/test", headers=headers).status_code == 403


# ------------------------------------------------------------ the events


class TestEvents:
    def test_a_new_order_and_its_cancellation(self, client, db, auth, admin, mail, catalogue, settings_documents):
        order = place_order(client, auth)
        [alert] = tray(db, "order")
        assert order["orderNumber"] in alert.title and alert.permission == "orders"
        assert alert.href == f"/admin/orders/detail?id={order['id']}"
        assert any(order["orderNumber"] in m["subject"] for m in staff_mail(mail))
        client.post(f"/api/orders/{order['id']}/cancel", headers=auth, json={"reason": "Ordered by mistake"})
        [cancelled] = tray(db, "order-cancelled")
        assert order["orderNumber"] in cancelled.title

    def test_a_failed_payment(self, db, admin, mail, catalogue, settings_documents, client, auth):
        from types import SimpleNamespace

        from app.models import Order
        from app.services.email.notifications import notify_payment_failed

        order_id = place_order(client, auth)["id"]
        notify_payment_failed(db, db.get(Order, order_id), SimpleNamespace(id="PAY9"))
        [alert] = tray(db, "payment")
        assert alert.title.startswith("Payment failed on") and alert.permission == "payments"

    def test_running_low_and_running_out_are_told_once_each(self, client, db, admin, admin_auth, mail, catalogue):
        def stock(quantity):
            response = client.put("/api/admin/inventory/PRD001", headers=admin_auth,
                                  json={"quantity": quantity, "reason": "count"})
            assert response.status_code == 200, response.text

        stock(5)   # 10 → 5: below the threshold of 8
        stock(4)   # still low: nothing new
        stock(0)   # out
        stock(0)   # still out
        titles = sorted(n.title for n in tray(db, "stock"))  # the same second: compared without order
        assert titles == ["Out of stock: Cotton Kurta", "Running low: Cotton Kurta"]

    def test_low_stock_alerts_can_be_switched_off(self, client, db, admin, admin_auth, mail, catalogue):
        configure(db, lowStockAlerts=False)
        client.put("/api/admin/inventory/PRD001", headers=admin_auth, json={"quantity": 0, "reason": "count"})
        assert tray(db, "stock") == []

    def test_a_draft_running_out_is_nobody_s_news(self, client, db, admin, admin_auth, mail, catalogue):
        client.put("/api/admin/inventory/PRD004", headers=admin_auth, json={"quantity": 0, "reason": "count"})
        assert tray(db, "stock") == []

    def test_a_new_review(self, client, db, auth, admin, mail, catalogue):
        response = client.post("/api/reviews", headers=auth, json={
            "productId": "PRD001", "rating": 4, "title": "Soft", "body": "Lovely fabric, true to size."})
        assert response.status_code == 201, response.text
        [alert] = tray(db, "review")
        assert "Cotton Kurta" in alert.title and alert.href == "/admin/reviews?status=pending"

    def test_review_alerts_can_be_switched_off(self, client, db, auth, admin, mail, catalogue):
        configure(db, reviewAlerts=False)
        client.post("/api/reviews", headers=auth, json={
            "productId": "PRD001", "rating": 4, "title": "Soft", "body": "Lovely fabric, true to size."})
        assert tray(db, "review") == []

    def test_a_new_customer(self, client, db, admin, mail):
        response = client.post("/api/auth/register", json={
            "email": "new.shopper@example.com", "password": "Shopper@123",
            "firstName": "Nisha", "lastName": "Kumar", "phone": "9876500099"})
        assert response.status_code == 201, response.text
        [alert] = tray(db, "customer")
        assert alert.title == "New customer: Nisha Kumar" and "new.shopper@example.com" in alert.body


# --------------------------------------------------------- the waitlist


class TestWaitlist:
    def test_notify_me_tells_the_team_who_and_how_many(self, client, db, auth, admin, mail, catalogue):
        response = client.post("/api/alerts/stock", headers=auth, json={"productId": "PRD003"})
        assert response.status_code in (200, 201), response.text
        [alert] = tray(db, "waitlist")
        assert "Wireless Earbuds" in alert.title and "1 waiting now" in alert.title
        assert alert.href == "/admin/alerts?view=waiting&productId=PRD003"
        assert any("Wireless Earbuds" in m["subject"] for m in staff_mail(mail))
        # Asking again isn't a new request.
        client.post("/api/alerts/stock", headers=auth, json={"productId": "PRD003"})
        assert len(tray(db, "waitlist")) == 1

    def test_who_is_waiting_by_product(self, client, db, auth, admin_auth, customer, catalogue, mail):
        client.post("/api/alerts/stock", headers=auth, json={"productId": "PRD003"})
        data = client.get("/api/admin/alerts/stock/waiting", headers=admin_auth).json()["data"]
        assert data["summary"] == {"requests": 1, "products": 1, "customers": 1}
        [row] = data["items"]
        assert row["productId"] == "PRD003" and row["waiting"] == 1 and row["product"]["stock"] == 0
        assert row["product"]["sku"] == "DCZ-EL0003"
        # The customers behind it, with how to reach them.
        listed = client.get("/api/admin/alerts/stock?productId=PRD003", headers=admin_auth).json()["data"]
        assert listed["items"][0]["customer"]["phone"] == (customer.phone or "")
        # And the count beside the product, in the catalogue and the inventory.
        product = client.get("/api/admin/products/PRD003", headers=admin_auth).json()["data"]
        assert product["waitingCount"] == 1
        inventory = client.get("/api/admin/inventory?q=PRD003", headers=admin_auth).json()["data"]
        assert inventory[0]["waitingCount"] == 1

    def test_the_daily_summary_goes_once_after_nine(self, client, db, auth, admin, catalogue, mail):
        from app.services import alerts

        client.post("/api/alerts/stock", headers=auth, json={"productId": "PRD003"})
        mail.clear()
        morning = datetime.utcnow().replace(hour=2, minute=0)  # 07:30 IST
        assert alerts.digest_once(db, now=morning) is None
        after_nine = morning.replace(hour=4)  # 09:30 IST
        result = alerts.digest_once(db, now=after_nine)
        assert result["sent"] is True and result["emails"] == [admin.email]
        [email] = staff_mail(mail)
        assert email["subject"] == "Waitlist today: 1 waiting for 1 product(s)"
        assert alerts.digest_once(db, now=after_nine + timedelta(hours=3)) is None  # once a day
        assert len(staff_mail(mail)) == 1

    def test_no_summary_on_a_day_with_nothing_to_report(self, db, admin, mail):
        from app.services import alerts

        result = alerts.digest_once(db, now=datetime.utcnow().replace(hour=6))
        assert result == {"sent": False, "reason": "nothing to report"} and staff_mail(mail) == []

    def test_the_summary_can_be_switched_off(self, client, db, auth, admin, catalogue, mail):
        from app.services import alerts

        configure(db, waitlistDigest=False)
        client.post("/api/alerts/stock", headers=auth, json={"productId": "PRD003"})
        mail.clear()
        assert alerts.digest_once(db, now=datetime.utcnow().replace(hour=6))["sent"] is False
        assert staff_mail(mail) == []


# ------------------------------------------------------------- the bell


class TestTheBell:
    def test_reading_is_per_administrator(self, client, db, admin, admin_auth, mail):
        from app.services import inbox

        manager = role_headers(db, "ADM920", "manager")
        inbox.staff(db, "order", "New order", permission="orders")
        db.commit()
        [item] = client.get("/api/admin/notifications", headers=admin_auth).json()["data"]
        assert item["read"] is False
        assert client.put(f"/api/admin/notifications/{item['id']}/read", headers=admin_auth).status_code == 200
        assert client.get("/api/admin/notifications", headers=admin_auth).json()["data"][0]["read"] is True
        # The manager hasn't read it.
        assert client.get("/api/admin/notifications", headers=manager).json()["data"][0]["read"] is False
        client.put("/api/admin/notifications/read-all", headers=manager)
        assert client.get("/api/admin/notifications", headers=manager).json()["data"][0]["read"] is True

    def test_an_administrator_sees_only_what_their_role_covers(self, client, db, admin_auth, mail):
        from app.services import inbox

        editor = role_headers(db, "ADM921", "editor", permissions=["content"])
        inbox.staff(db, "payment", "Payment failed", permission="payments")
        inbox.staff(db, "health", "System health", permission=None)
        db.commit()
        assert [i["title"] for i in client.get("/api/admin/notifications", headers=editor).json()["data"]] == \
            ["System health"]
        assert len(client.get("/api/admin/notifications", headers=admin_auth).json()["data"]) == 2
        hidden = tray(db, "payment")[0].id
        assert client.put(f"/api/admin/notifications/{hidden}/read", headers=editor).status_code == 404
