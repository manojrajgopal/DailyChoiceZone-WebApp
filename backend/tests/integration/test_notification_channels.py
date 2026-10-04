"""
Notifications on every channel: an event's email, SMS and WhatsApp, each
queued once, sent through its provider, retried when it can be and given up
on when it can't — respecting consent, never faking a send, and never
sending a sign-in link anywhere but email.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.core import rate_limit
from app.models import (
    ChannelPreference,
    EmailLog,
    NotificationDelivery,
    NotificationTemplate,
    Order,
    SettingDocument,
)
from app.services import email as email_service
from app.services.messaging import providers, service as messaging
from tests.integration.messaging_helpers import email_account, sms_whatsapp  # noqa: F401
from tests.integration.wallet_helpers import fill_bag, place

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def shop(client, catalogue, customer, settings_documents, admin_auth, auth):
    return client


def route(db, channel, events, enabled=True):
    row = db.get(SettingDocument, "notification_channels")
    value = dict(row.value) if row else {}
    value[channel] = {"enabled": enabled, "events": events}
    if row is None:
        db.add(SettingDocument(key="notification_channels", value=value))
    else:
        row.value = value
    db.flush()


def deliveries(db, **filters):
    db.expire_all()
    return db.query(NotificationDelivery).filter_by(**filters).order_by(NotificationDelivery.id).all()


def ship(client, admin_auth, order_id):
    for status in ("processing", "packed", "shipped"):
        response = client.put(f"/api/admin/orders/{order_id}/status", headers=admin_auth, json={"status": status})
        assert response.status_code == 200, response.text


class TestChannels:
    def test_an_order_event_goes_by_sms_and_whatsapp_when_switched_on(self, shop, auth, admin_auth, db,
                                                                     sms_whatsapp):  # noqa: F811
        sms, whatsapp = sms_whatsapp
        route(db, "sms", ["order_shipped"])
        route(db, "whatsapp", ["order_shipped"])
        messaging.set_consent(db, "CUS001", "whatsapp", "transactional", True, source="test")
        db.add(NotificationTemplate(key="order_shipped", enabled=True, email_body="", whatsapp_template="order_update",
                                    whatsapp_variables=["customer_name", "order_number"], updated_at=datetime.utcnow()))
        db.flush()
        fill_bag(shop, auth, "PRD001")
        order = place(shop, auth, method="cod")["order"]
        ship(shop, admin_auth, order["id"])
        queued = deliveries(db, event="order_shipped")
        assert {d.channel for d in queued} == {"sms", "whatsapp"}
        assert all(d.status == "queued" and d.recipient == "+919876500001" for d in queued)
        assert messaging.process(db)["sent"] == 2
        assert order["orderNumber"] in sms.sent[0].text
        assert whatsapp.sent[0].template == "order_update"
        assert whatsapp.sent[0].variables == ["Asha", order["orderNumber"]]
        assert {d.status for d in deliveries(db, event="order_shipped")} == {"sent"}

    def test_the_same_event_is_queued_once(self, shop, auth, admin_auth, db, sms_whatsapp):  # noqa: F811
        route(db, "sms", ["order_shipped"])
        fill_bag(shop, auth, "PRD001")
        order = place(shop, auth, method="cod")["order"]
        ship(shop, admin_auth, order["id"])
        o = db.get(Order, order["id"])
        email_service.notify_order(db, o, "shipped")  # a retried job, a duplicate call
        db.commit()
        assert len(deliveries(db, event="order_shipped", channel="sms")) == 1

    def test_nothing_is_sent_or_faked_when_a_channel_is_not_configured(self, shop, auth, admin_auth, db):
        route(db, "sms", ["order_shipped"])
        fill_bag(shop, auth, "PRD001")
        order = place(shop, auth, method="cod")["order"]
        ship(shop, admin_auth, order["id"])
        [row] = deliveries(db, event="order_shipped", channel="sms")
        assert row.status == "skipped" and "No SMS provider" in row.last_error
        assert messaging.process(db)["sent"] == 0

    def test_transactional_sms_respects_the_customers_choice(self, shop, auth, admin_auth, db, sms_whatsapp):  # noqa: F811
        route(db, "sms", ["order_shipped"])
        route(db, "whatsapp", ["order_shipped"])
        response = shop.put("/api/account/notification-preferences", headers=auth,
                            json=[{"channel": "sms", "category": "transactional", "enabled": False}])
        assert response.status_code == 200
        fill_bag(shop, auth, "PRD001")
        order = place(shop, auth, method="cod")["order"]
        ship(shop, admin_auth, order["id"])
        # SMS turned off, WhatsApp never agreed to: nothing on either.
        assert deliveries(db, event="order_shipped", channel="sms") == []
        assert deliveries(db, event="order_shipped", channel="whatsapp") == []

    def test_switching_a_channel_on_needs_its_provider(self, shop, admin_auth, db):
        response = shop.put("/api/admin/messaging/channels", headers=admin_auth,
                            json={"sms": {"enabled": True}})
        assert response.status_code == 422 and response.json()["error_code"] == "CHANNEL_NOT_CONFIGURED"

    def test_sign_in_links_never_go_by_text(self, shop, admin_auth, db, sms_whatsapp):  # noqa: F811
        response = shop.put("/api/admin/messaging/channels", headers=admin_auth,
                            json={"sms": {"enabled": True, "events": ["password_reset"]}})
        assert response.status_code == 422 and response.json()["error_code"] == "SECRET_EVENT"

    def test_a_staff_member_without_the_permission_is_refused(self, shop, editor, client):
        token = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"}).json()
        headers = {"Authorization": f"Bearer {token['data']['token']['accessToken']}"}
        assert shop.get("/api/admin/messaging", headers=headers).status_code == 403
        assert shop.get("/api/admin/messaging/templates", headers=headers).status_code == 403


class TestRetries:
    def _queued_sms(self, shop, auth, admin_auth, db):
        route(db, "sms", ["order_shipped"])
        fill_bag(shop, auth, "PRD001")
        order = place(shop, auth, method="cod")["order"]
        ship(shop, admin_auth, order["id"])
        return deliveries(db, event="order_shipped", channel="sms")[0]

    def test_a_transient_failure_is_retried_with_backoff_then_succeeds(self, shop, auth, admin_auth, db,
                                                                       sms_whatsapp):  # noqa: F811
        sms, _ = sms_whatsapp
        row = self._queued_sms(shop, auth, admin_auth, db)
        sms.fail_with = providers.ProviderError("Rate limited (HTTP 429)", transient=True)
        messaging.process(db)
        db.expire_all()
        row = db.get(NotificationDelivery, row.id)
        assert row.status == "failed" and row.attempts == 1 and "429" in row.last_error
        assert row.next_attempt_at > datetime.utcnow() + timedelta(seconds=30)
        assert messaging.process(db)["sent"] == 0  # not due yet
        sms.fail_with = None
        row.next_attempt_at = datetime.utcnow() - timedelta(seconds=1)
        db.commit()
        assert messaging.process(db)["sent"] == 1
        db.expire_all()
        row = db.get(NotificationDelivery, row.id)
        assert row.status == "sent" and row.attempts == 2 and row.provider_message_id
        assert len(sms.sent) == 1  # sent once, by the same row

    def test_a_permanent_failure_is_not_retried(self, shop, auth, admin_auth, db, sms_whatsapp):  # noqa: F811
        sms, _ = sms_whatsapp
        row = self._queued_sms(shop, auth, admin_auth, db)
        sms.fail_with = providers.ProviderError("Invalid 'To' number (HTTP 400)", transient=False)
        messaging.process(db)
        db.expire_all()
        assert db.get(NotificationDelivery, row.id).status == "dead"

    def test_retries_stop_at_the_maximum(self, shop, auth, admin_auth, db, sms_whatsapp):  # noqa: F811
        sms, _ = sms_whatsapp
        row = self._queued_sms(shop, auth, admin_auth, db)
        sms.fail_with = providers.ProviderError("Timeout", transient=True)
        for _ in range(messaging.MAX_ATTEMPTS):
            db.expire_all()
            current = db.get(NotificationDelivery, row.id)
            current.next_attempt_at = datetime.utcnow() - timedelta(seconds=1)
            db.commit()
            messaging.process(db)
        db.expire_all()
        row = db.get(NotificationDelivery, row.id)
        assert row.status == "dead" and row.attempts == messaging.MAX_ATTEMPTS

    def test_the_portal_retries_a_failed_message_on_the_same_row(self, shop, auth, admin_auth, db,
                                                                 sms_whatsapp):  # noqa: F811
        sms, _ = sms_whatsapp
        row = self._queued_sms(shop, auth, admin_auth, db)
        sms.fail_with = providers.ProviderError("Invalid number", transient=False)
        messaging.process(db)
        sms.fail_with = None
        response = shop.post(f"/api/admin/messaging/{row.id}/retry", headers=admin_auth)
        assert response.status_code == 200, response.text
        assert response.json()["data"]["status"] == "sent"
        assert len(deliveries(db, event="order_shipped", channel="sms")) == 1
        listing = shop.get("/api/admin/messaging?channel=sms", headers=admin_auth).json()["data"]
        assert listing["items"][0]["recipient"] != "+919876500001"  # masked in lists

    def test_provider_status_callbacks_mark_delivery(self, shop, auth, admin_auth, db, sms_whatsapp, monkeypatch):  # noqa: F811
        from app.core.config import settings

        row = self._queued_sms(shop, auth, admin_auth, db)
        messaging.process(db)
        db.expire_all()
        sid = db.get(NotificationDelivery, row.id).provider_message_id
        monkeypatch.setattr(settings, "TWILIO_AUTH_TOKEN", "test-auth-token")
        params = {"MessageSid": sid, "MessageStatus": "delivered"}
        url = "http://testserver/api/notifications/webhooks/twilio"
        assert shop.post(url, data=params, headers={"X-Twilio-Signature": "forged"}).status_code == 403
        import base64
        import hashlib
        import hmac

        signature = base64.b64encode(hmac.new(b"test-auth-token", (url + "".join(f"{k}{params[k]}" for k in sorted(params))).encode(),
                                              hashlib.sha1).digest()).decode()
        assert shop.post(url, data=params, headers={"X-Twilio-Signature": signature}).status_code == 200
        db.expire_all()
        row = db.get(NotificationDelivery, row.id)
        assert row.status == "delivered" and row.delivered_at is not None


class TestEmail:
    def test_an_email_is_recorded_and_its_failure_scheduled_for_retry(self, shop, auth, admin_auth, db,
                                                                      email_account):  # noqa: F811
        from app.services.email.senders import SendError

        email_account.fail_with = SendError("Connection timed out")
        fill_bag(shop, auth, "PRD001")
        place(shop, auth, method="cod")
        email_account.run()
        [row] = deliveries(db, channel="email", event="order_confirmed")
        assert row.status == "failed" and row.payload["html"] and row.next_attempt_at
        log = db.query(EmailLog).filter_by(delivery_id=row.id).one()
        assert log.status == "failed" and log.template_key == "order_confirmed"
        email_account.fail_with = None
        row.next_attempt_at = datetime.utcnow() - timedelta(seconds=1)
        db.commit()
        assert messaging.process(db)["sent"] == 1
        db.expire_all()
        row = db.get(NotificationDelivery, row.id)
        assert row.status == "sent" and row.attempts == 2
        assert len(email_account.sent) == 1

    def test_a_rejected_address_is_not_retried(self, shop, auth, db, email_account):  # noqa: F811
        from app.services.email.senders import SendError

        email_account.fail_with = SendError("550 Recipient address rejected: no such user")
        fill_bag(shop, auth, "PRD001")
        place(shop, auth, method="cod")
        email_account.run()
        [row] = deliveries(db, channel="email", event="order_confirmed")
        assert row.status == "dead"

    def test_a_reset_email_is_never_stored_for_retry(self, shop, db, email_account):  # noqa: F811
        from app.services.email.senders import SendError

        email_account.fail_with = SendError("Connection timed out")
        assert shop.post("/api/auth/password/forgot", json={"email": "shopper@example.com"}).status_code == 200
        email_account.run()
        [row] = deliveries(db, channel="email", event="password_reset")
        assert row.status == "dead" and row.payload is None

    def test_a_disabled_template_stops_the_message(self, shop, auth, db, admin_auth, email_account):  # noqa: F811
        response = shop.put("/api/admin/messaging/templates/order_confirmed", headers=admin_auth,
                            json={"enabled": False})
        assert response.status_code == 200, response.text
        fill_bag(shop, auth, "PRD001")
        place(shop, auth, method="cod")
        email_account.run()
        assert email_account.sent == []
        locked = shop.put("/api/admin/messaging/templates/password_reset", headers=admin_auth, json={"enabled": False})
        assert locked.status_code == 422 and locked.json()["error_code"] == "TEMPLATE_LOCKED"

    def test_the_stores_own_wording_is_used_with_values_escaped(self, shop, auth, db, admin_auth, email_account):  # noqa: F811
        from app.models import Customer

        db.get(Customer, "CUS001").first_name = "<b>Asha</b>"
        db.flush()
        response = shop.put("/api/admin/messaging/templates/order_confirmed", headers=admin_auth, json={
            "subject": "Thanks {{customer_name}} — {{order_number}}", "heading": "We have it",
            "body": "Order **{{order_number}}** totals {{order_total}}.", "cta": "Track it"})
        assert response.status_code == 200, response.text
        fill_bag(shop, auth, "PRD001")
        order = place(shop, auth, method="cod")["order"]
        email_account.run()
        [mail] = email_account.sent
        assert mail["subject"] == f"Thanks <b>Asha</b> — {order['orderNumber']}"  # a subject is plain text
        assert "<strong>" + order["orderNumber"] + "</strong>" in mail["html"]
        assert "Cotton Kurta" in mail["html"]  # the order lines are kept under the store's wording
        assert "Track it" in mail["html"]

    def test_unknown_variables_are_refused(self, shop, admin_auth):
        response = shop.put("/api/admin/messaging/templates/order_shipped", headers=admin_auth,
                            json={"body": "Hi {{customer_name}}, your card {{card_number}}"})
        assert response.status_code == 422
        assert response.json()["error_code"] == "INVALID_TEMPLATE_VARIABLE"

    def test_preview_and_test_send(self, shop, admin_auth, db, email_account):  # noqa: F811
        preview = shop.post("/api/admin/messaging/templates/order_shipped/preview", headers=admin_auth, json={})
        data = preview.json()["data"]
        assert "DCZ10042" in data["subject"] and "<!DOCTYPE html>" in data["html"] and data["sms"]
        sent = shop.post("/api/admin/messaging/templates/order_shipped/test", headers=admin_auth,
                         json={"channel": "email", "recipient": "owner@example.com"})
        assert sent.status_code == 200 and email_account.sent[-1]["subject"].startswith("[Test]")
        bad = shop.post("/api/admin/messaging/templates/order_shipped/test", headers=admin_auth,
                        json={"channel": "email", "recipient": "not-an-address"})
        assert bad.status_code == 422 and bad.json()["error_code"] == "INVALID_RECIPIENT"


class TestPreferences:
    def test_offers_by_email_and_in_app_are_on_by_default_and_saved_per_channel(self, shop, auth, db):
        prefs = shop.get("/api/account/notification-preferences", headers=auth).json()["data"]
        marketing = {c["channel"]: c["enabled"] for c in prefs["choices"] if c["category"] == "marketing"}
        assert marketing == {"email": True, "sms": False, "whatsapp": False, "in_app": True}
        assert messaging.consent(db, "CUS001", "email", "marketing") is True
        shop.put("/api/account/notification-preferences", headers=auth,
                 json=[{"channel": "email", "category": "marketing", "enabled": False},
                       {"channel": "email", "category": "transactional", "enabled": False}])
        db.expire_all()
        assert db.get(ChannelPreference, ("CUS001", "email", "marketing")).enabled is False
        assert messaging.consent(db, "CUS001", "email", "marketing") is False
        # Transactional email is governed by the per-email choices, never by this form.
        assert db.get(ChannelPreference, ("CUS001", "email", "transactional")) is None

    def test_an_unsubscribe_link_works_once_signed_and_not_when_forged(self, shop, db):
        messaging.set_consent(db, "CUS001", "email", "marketing", True, source="test")
        db.commit()
        token = messaging.unsubscribe_token("CUS001", "email")
        assert shop.post("/api/notifications/unsubscribe", json={"token": token[:-3] + "AAA"}).status_code == 422
        assert shop.post("/api/notifications/unsubscribe", json={"token": token}).status_code == 200
        db.expire_all()
        assert db.get(ChannelPreference, ("CUS001", "email", "marketing")).enabled is False


class TestMasterLayout:
    def test_every_email_has_the_branded_responsive_frame(self):
        html = email_service.layout("Hello", "Body text", cta=("Open", "https://shop.test/x"))
        for piece in ("<!DOCTYPE html>", 'name="viewport"', "@media screen and (max-width: 620px)", "v:roundrect",
                      "/brand/logo.png", "Daily Choice Zone", 'role="presentation"', "Privacy"):
            assert piece in html, piece
        assert "Unsubscribe" not in html  # transactional

    def test_sent_mail_carries_the_websites_logo(self):
        from app.services.email import templates
        from app.services.email.senders import build_message

        html = email_service.layout("Hello", "Body text")
        message = build_message(sender_email="shop@example.com", sender_name="Shop", reply_to="", to="a@example.com",
                                subject="Hi", html=html, text="Hi")
        parts = {part.get_content_type(): part for part in message.walk()}
        assert 'src="cid:dcz-logo"' in parts["text/html"].get_content()
        logo = parts["image/png"]
        assert logo["Content-ID"] == "<dcz-logo>"
        assert logo.get_payload(decode=True) == templates.LOGO_FILE.read_bytes()

    def test_marketing_email_has_an_unsubscribe_link(self):
        html = email_service.layout("Sale", "Body", marketing=True, unsubscribe_url="https://shop.test/unsubscribe?t=1")
        assert "Unsubscribe" in html and "https://shop.test/unsubscribe?t=1" in html

    def test_template_rendering_escapes_and_refuses_unknown_names(self):
        from app.services.email import templates

        html = templates.render("Hi {{name}}, **welcome**", {"name": "<script>x</script>"}, allowed=["name"], html=True)
        assert "&lt;script&gt;" in html and "<strong>welcome</strong>" in html and "<script>" not in html
        with pytest.raises(templates.TemplateError):
            templates.render("{{secret}}", {}, allowed=["name"])
        assert templates.render("{{ name }}", {"name": "A&B"}, allowed=["name"]) == "A&B"

    def test_campaign_html_is_sanitised(self):
        from app.services.email import templates

        clean = templates.sanitise_html('<p onclick="x()">Hi<script>alert(1)</script></p><a href="javascript:x">y</a>'
                                        '<img src="https://img.test/a.png" onerror="x">')
        assert "script" not in clean and "onclick" not in clean and "javascript" not in clean and "onerror" not in clean
        assert "<p" in clean and 'src="https://img.test/a.png"' in clean


class TestDeliveryLog:
    """The portal's message log is found by ID: a Customer ID, or a delivery's own reference or provider id."""

    def test_the_log_is_filtered_by_ids_only(self, shop, db, admin_auth, other_customer):
        db.add_all([
            NotificationDelivery(idempotency_key="log-1", event="order_shipped", channel="email", customer_id="CUS001",
                                 recipient="shopper@example.com", reference="order-DCZ10241",
                                 provider_message_id="msg-abc-1", status="sent", created_at=datetime.utcnow(),
                                 updated_at=datetime.utcnow()),
            NotificationDelivery(idempotency_key="log-2", event="order_shipped", channel="sms", customer_id="CUS002",
                                 recipient="+919876500002", reference="order-DCZ10242",
                                 provider_message_id="SM-xyz-2", status="sent", created_at=datetime.utcnow(),
                                 updated_at=datetime.utcnow()),
        ])
        db.flush()

        def keys(**params):
            response = shop.get("/api/admin/messaging", headers=admin_auth, params=params)
            assert response.status_code == 200, response.text
            return {row["reference"] for row in response.json()["data"]["items"]}

        assert keys(customer="CUS001") == {"order-DCZ10241"}
        assert keys(customer="CUS002") == {"order-DCZ10242"}
        assert keys(q="order-DCZ10242") == {"order-DCZ10242"}
        assert keys(q="msg-abc-1") == {"order-DCZ10241"}
        # Names, emails, phone numbers and fragments are not identifiers.
        assert keys(q="Asha") == set()
        assert keys(q="shopper@example.com") == set()
        assert keys(q="+919876500002") == set()
        assert keys(q="DCZ1024") == set()
