"""
The notification service beyond the happy path: who may reach the portal's
messaging pages, how channel routing and templates are validated, how the
queue sends, retries and gives up on each channel (email, SMS, WhatsApp, the
bell), how provider webhooks are verified and applied, what the delivery
history and overview report, and the background loop that sends what is due,
tells customers their membership is ending and alerts staff about messages
that could not be delivered.

Also the backup endpoints that live in the same router module.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import types
from datetime import datetime, timedelta

import pytest

from app.core import rate_limit
from app.core.config import settings
from app.core.security import hash_password
from app.models import (
    AdminUser,
    CampaignRecipient,
    ChannelPreference,
    Customer,
    EmailLog,
    MarketingCampaign,
    Notification,
    NotificationDelivery,
    NotificationTemplate,
    SettingDocument,
)
from app.services.messaging import providers, service as messaging
from tests.integration.messaging_helpers import RecordingProvider, email_account, sms_whatsapp  # noqa: F401

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


# ------------------------------------------------------------------ helpers


def route(db, channel, events, enabled=True):
    row = db.get(SettingDocument, "notification_channels")
    value = dict(row.value) if row else {}
    value[channel] = {"enabled": enabled, "events": events}
    if row is None:
        db.add(SettingDocument(key="notification_channels", value=value))
    else:
        row.value = value
    db.flush()


def delivery(db, *, channel="sms", status="queued", event="order_shipped", payload=None, recipient="+919876500001",
             customer_id="CUS001", category="transactional", campaign_id=None, provider_message_id=None,
             attempts=0, max_attempts=messaging.MAX_ATTEMPTS, updated_at=None, created_at=None, reference="DCZ1",
             last_error=""):
    now = datetime.utcnow().replace(microsecond=0)
    row = NotificationDelivery(
        idempotency_key=f"test:{messaging.new_token()}", event=event, channel=channel, category=category,
        customer_id=customer_id, recipient=recipient, template_key=event, provider="", status=status,
        payload=payload, attempts=attempts, max_attempts=max_attempts,
        next_attempt_at=now - timedelta(seconds=5) if status in ("queued", "failed") else None,
        last_error=last_error, provider_message_id=provider_message_id, campaign_id=campaign_id, reference=reference,
        created_at=created_at or now, updated_at=updated_at or now,
    )
    db.add(row)
    db.flush()
    return row


def fresh(db, row):
    db.expire_all()
    return db.get(type(row), row.id)


def login_admin(client, db, *, role, permissions, email):
    db.add(AdminUser(id=f"ADM{abs(hash(email)) % 900 + 100}", email=email, password_hash=hash_password("Admin@123"),
                     name="Test Staff", role=role, permissions=permissions, status="active",
                     created_at=datetime(2026, 1, 1)))
    db.flush()
    response = client.post("/api/admin/auth/login", json={"email": email, "password": "Admin@123"})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}


def campaign_row(db, *, channels=("whatsapp",), status="sending"):
    now = datetime.utcnow()
    row = MarketingCampaign(name="Webhook campaign", kind="promotional", status=status, channels=list(channels),
                            audience={"segment": "all"}, content={}, created_at=now, updated_at=now,
                            recipients_total=0, last_error="", launched_at=now)
    db.add(row)
    db.flush()
    return row


class Shared:
    """The test session for code that opens its own with a `with` block (and would otherwise close it)."""

    def __init__(self, session):
        self.session = session

    def __enter__(self):
        return self.session

    def __exit__(self, *exc):
        return False

    def __getattr__(self, name):
        return getattr(self.session, name)


# ------------------------------------------------------------- permissions


class TestWhoReachesThePortalPages:
    def test_a_customer_token_is_refused_by_every_messaging_page(self, client, customer, auth):
        for path in ("/api/admin/messaging", "/api/admin/messaging/overview", "/api/admin/messaging/templates"):
            response = client.get(path, headers=auth)
            assert response.status_code in (401, 403), path
            assert response.json()["success"] is False

    def test_no_token_at_all_is_unauthenticated(self, client):
        response = client.get("/api/admin/messaging")
        assert response.status_code == 401
        assert response.json()["success"] is False

    def test_a_role_without_notifications_is_refused_even_with_campaigns(self, client, db):
        # A manager's role covers campaigns but not notifications: require_access reads the role's current list.
        headers = login_admin(client, db, role="manager", permissions=[], email="manager@example.com")
        refused = client.get("/api/admin/messaging/overview", headers=headers)
        assert refused.status_code == 403 and refused.json()["error_code"] == "PERMISSION_DENIED"
        assert client.get("/api/admin/campaigns", headers=headers).status_code == 200

    def test_a_stored_permission_is_enough_for_a_role_that_lacks_it(self, client, db):
        headers = login_admin(client, db, role="editor", permissions=["notifications"], email="editor2@example.com")
        response = client.get("/api/admin/messaging/templates", headers=headers)
        assert response.status_code == 200
        assert client.get("/api/admin/campaigns", headers=headers).status_code == 403


# ------------------------------------------------------------------ consent


class TestConsentAndPreferences:
    def test_a_guest_gets_transactional_messages_but_never_marketing(self, db):
        assert messaging.consent(db, None, "sms", "transactional") is True
        assert messaging.consent(db, None, "email", "marketing") is False

    def test_unknown_channels_and_locked_pairs_in_a_saved_form_are_ignored(self, client, db, customer, auth):
        response = client.put("/api/account/notification-preferences", headers=auth, json=[
            {"channel": "pigeon", "category": "marketing", "enabled": True},
            {"channel": "sms", "category": "gossip", "enabled": True},
            {"channel": "in_app", "category": "transactional", "enabled": False},
            {"channel": "whatsapp", "category": "marketing", "enabled": True},
        ])
        assert response.status_code == 200, response.text
        db.expire_all()
        rows = db.query(ChannelPreference).filter_by(customer_id="CUS001").all()
        assert [(r.channel, r.category, r.enabled) for r in rows] == [("whatsapp", "marketing", True)]
        choices = {(c["channel"], c["category"]): c for c in response.json()["data"]["choices"]}
        assert choices[("whatsapp", "marketing")]["enabled"] is True
        assert ("in_app", "transactional") not in choices
        assert response.json()["data"]["phoneUsable"] is True

    def test_the_preferences_page_needs_a_signed_in_customer(self, client):
        assert client.get("/api/account/notification-preferences").status_code == 401

    def test_an_unsubscribe_link_for_a_deleted_customer_is_refused(self, client, db):
        token = messaging.unsubscribe_token("CUS404", "email")
        response = client.post("/api/notifications/unsubscribe", json={"token": token})
        assert response.status_code == 422 and response.json()["error_code"] == "UNSUBSCRIBE_INVALID"
        assert db.query(ChannelPreference).count() == 0

    def test_an_unsubscribe_link_too_short_to_be_one_fails_validation(self, client):
        response = client.post("/api/notifications/unsubscribe", json={"token": "short"})
        assert response.status_code == 422 and response.json()["success"] is False


# ------------------------------------------------------------------ routing


class TestChannelRouting:
    def test_routing_is_saved_audited_and_updated_in_place(self, client, db, admin_auth, sms_whatsapp):  # noqa: F811
        first = client.put("/api/admin/messaging/channels", headers=admin_auth,
                           json={"sms": {"enabled": True, "events": ["order_shipped", "order_shipped", "order_packed"]}})
        assert first.status_code == 200, first.text
        assert first.json()["data"]["sms"] == {"enabled": True, "events": ["order_packed", "order_shipped"]}
        # WhatsApp untouched: still its defaults, switched off.
        assert first.json()["data"]["whatsapp"]["enabled"] is False
        second = client.put("/api/admin/messaging/channels", headers=admin_auth,
                            json={"whatsapp": {"events": ["order_delivered"]}, "sms": "not a dict"})
        assert second.status_code == 200, second.text
        db.expire_all()
        stored = db.get(SettingDocument, "notification_channels").value
        assert stored["sms"]["events"] == ["order_packed", "order_shipped"]
        assert stored["whatsapp"] == {"enabled": False, "events": ["order_delivered"]}
        from app.models import AuditLog

        assert db.query(AuditLog).filter_by(action="notifications.channels").count() == 2

    @pytest.mark.parametrize("events, code", [
        (["order_shipped", "made_up_event"], "UNKNOWN_EVENT"),
        (["campaign_message"], "MARKETING_EVENT"),
        (["email_verification"], "SECRET_EVENT"),
    ])
    def test_events_that_cannot_go_by_text_are_refused(self, client, db, admin_auth, events, code):
        response = client.put("/api/admin/messaging/channels", headers=admin_auth, json={"sms": {"events": events}})
        assert response.status_code == 422 and response.json()["error_code"] == code
        db.expire_all()
        assert db.get(SettingDocument, "notification_channels") is None

    def test_a_stored_routing_ignores_events_that_no_longer_exist(self, db):
        db.add(SettingDocument(key="notification_channels",
                               value={"sms": {"enabled": True, "events": ["order_shipped", "retired_event"]},
                                      "whatsapp": "garbage"}))
        db.flush()
        routing = messaging.channel_routing(db)
        assert routing["sms"] == {"enabled": True, "events": ["order_shipped"]}
        assert routing["whatsapp"]["enabled"] is False and "order_shipped" in routing["whatsapp"]["events"]


# ---------------------------------------------------------------- templates


class TestTemplates:
    def test_every_template_is_listed_in_group_order(self, client, admin_auth):
        response = client.get("/api/admin/messaging/templates", headers=admin_auth)
        assert response.status_code == 200
        rows = response.json()["data"]
        from app.services.messaging import catalogue

        assert len(rows) == len(catalogue.EVENTS)
        groups = [r["group"] for r in rows]
        assert groups == sorted(groups, key=catalogue.GROUPS.index)
        assert {"key", "label", "locked", "variables", "default", "customised"} <= set(rows[0])

    def test_an_unknown_template_is_not_found(self, client, admin_auth):
        for response in (client.get("/api/admin/messaging/templates/nope", headers=admin_auth),
                         client.post("/api/admin/messaging/templates/nope/reset", headers=admin_auth),
                         client.post("/api/admin/messaging/templates/nope/preview", headers=admin_auth, json={})):
            assert response.status_code == 404 and response.json()["error_code"] == "TEMPLATE_NOT_FOUND"

    def test_saved_whatsapp_variables_and_wording_are_read_back(self, client, db, admin_auth):
        db.add(NotificationTemplate(key="order_shipped", enabled=True, email_body="", email_subject="",
                                    whatsapp_template="ship_v2", whatsapp_variables=["order_number"],
                                    sms_text="Shipped {{order_number}}", updated_at=datetime.utcnow()))
        db.flush()
        data = client.get("/api/admin/messaging/templates/order_shipped", headers=admin_auth).json()["data"]
        assert data["whatsappTemplate"] == "ship_v2" and data["whatsappVariables"] == ["order_number"]
        assert data["sms"] == "Shipped {{order_number}}"
        # Only the email wording counts as customised.
        assert data["customised"] is False

    @pytest.mark.parametrize("payload, code", [
        ({"whatsappVariables": ["card_number"]}, "INVALID_TEMPLATE"),
        ({"whatsappVariables": "customer_name"}, "INVALID_TEMPLATE"),
        ({"subject": "   "}, "INVALID_TEMPLATE"),
        ({"subject": "x" * 201}, "INVALID_TEMPLATE"),
        ({"sms": "y" * (messaging.SMS_LIMIT + 1)}, "INVALID_TEMPLATE"),
        ({"inAppTitle": "Hi {{password}}"}, "INVALID_TEMPLATE_VARIABLE"),
    ])
    def test_invalid_wording_is_refused_and_nothing_is_saved(self, client, db, admin_auth, payload, code):
        response = client.put("/api/admin/messaging/templates/order_shipped", headers=admin_auth, json=payload)
        assert response.status_code == 422, response.text
        assert response.json()["error_code"] == code
        db.expire_all()
        assert db.get(NotificationTemplate, "order_shipped") is None

    def test_saving_twice_updates_the_same_row_and_reset_removes_it(self, client, db, admin_auth):
        for subject in ("First {{order_number}}", "Second {{order_number}}"):
            response = client.put("/api/admin/messaging/templates/order_shipped", headers=admin_auth,
                                  json={"subject": subject, "whatsappVariables": ["customer_name"]})
            assert response.status_code == 200, response.text
        db.expire_all()
        assert db.query(NotificationTemplate).filter_by(key="order_shipped").count() == 1
        assert db.get(NotificationTemplate, "order_shipped").email_subject == "Second {{order_number}}"
        reset = client.post("/api/admin/messaging/templates/order_shipped/reset", headers=admin_auth)
        assert reset.status_code == 200
        assert reset.json()["data"]["customised"] is False
        assert reset.json()["data"]["subject"] == reset.json()["data"]["default"]["subject"]
        db.expire_all()
        assert db.get(NotificationTemplate, "order_shipped") is None
        from app.models import AuditLog

        assert db.query(AuditLog).filter_by(action="notifications.template_reset").count() == 1

    def test_resetting_a_template_that_was_never_changed_changes_nothing(self, client, db, admin_auth):
        response = client.post("/api/admin/messaging/templates/order_packed/reset", headers=admin_auth)
        assert response.status_code == 200 and response.json()["data"]["key"] == "order_packed"
        from app.models import AuditLog

        assert db.query(AuditLog).filter_by(action="notifications.template_reset").count() == 0

    def test_preview_shows_unsaved_wording_and_reports_problems(self, client, admin_auth):
        draft = client.post("/api/admin/messaging/templates/order_shipped/preview", headers=admin_auth,
                            json={"subject": "Draft for {{order_number}}", "body": None})
        data = draft.json()["data"]
        assert data["subject"] == "Draft for DCZ10042" and data["problems"] == []
        assert data["smsSegments"] == 1 and data["inApp"]["title"]
        bad_email = client.post("/api/admin/messaging/templates/order_shipped/preview", headers=admin_auth,
                                json={"heading": "Hi {{nope}}"}).json()["data"]
        assert bad_email["html"] == "" and len(bad_email["problems"]) == 1 and bad_email["sms"]
        bad_sms = client.post("/api/admin/messaging/templates/order_shipped/preview", headers=admin_auth,
                              json={"sms": "Hi {{nope}}"}).json()["data"]
        assert bad_sms["subject"] and bad_sms["sms"] == "" and bad_sms["smsSegments"] == 0
        assert len(bad_sms["problems"]) == 1

    def test_a_marketing_preview_carries_an_unsubscribe_link(self, client, admin_auth):
        data = client.post("/api/admin/messaging/templates/campaign_message/preview", headers=admin_auth).json()["data"]
        assert "https://example.com/unsubscribe" in data["html"]


class TestTemplateTestSends:
    def _test(self, client, admin_auth, channel, recipient, key="order_shipped"):
        return client.post(f"/api/admin/messaging/templates/{key}/test", headers=admin_auth,
                           json={"channel": channel, "recipient": recipient})

    def test_an_email_test_needs_a_connected_account(self, client, admin_auth):
        response = self._test(client, admin_auth, "email", "owner@example.com")
        assert response.status_code == 422 and response.json()["error_code"] == "EMAIL_NOT_CONFIGURED"

    def test_an_email_the_server_refuses_is_reported(self, client, admin_auth, email_account):  # noqa: F811
        from app.services.email.senders import SendError

        email_account.fail_with = SendError("Mailbox unavailable")
        response = self._test(client, admin_auth, "email", "owner@example.com")
        assert response.status_code == 422 and response.json()["error_code"] == "TEST_SEND_FAILED"
        assert "Mailbox unavailable" in response.json()["message"]

    def test_an_sms_test_goes_to_the_given_number_only(self, client, db, admin_auth, sms_whatsapp):  # noqa: F811
        sms, _ = sms_whatsapp
        response = self._test(client, admin_auth, "sms", "98765 43210")
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["channel"] == "sms" and data["providerMessageId"] == "sms-msg-1"
        assert data["sentTo"] != "+919876543210"  # masked
        assert sms.sent[0].to == "+919876543210" and sms.sent[0].text.startswith("[Test] ")
        assert db.query(NotificationDelivery).count() == 0  # a test is never a customer delivery
        from app.models import AuditLog

        assert db.query(AuditLog).filter_by(action="notifications.test").count() == 1

    def test_a_whatsapp_test_uses_the_template(self, client, db, admin_auth, sms_whatsapp):  # noqa: F811
        _, whatsapp = sms_whatsapp
        db.add(NotificationTemplate(key="order_shipped", enabled=True, email_body="", whatsapp_template="ship_tpl",
                                    whatsapp_variables=["customer_name", "order_number"], updated_at=datetime.utcnow()))
        db.flush()
        response = self._test(client, admin_auth, "whatsapp", "+919876543210")
        assert response.status_code == 200, response.text
        assert whatsapp.sent[0].template == "ship_tpl" and whatsapp.sent[0].variables == ["Asha", "DCZ10042"]

    def test_a_provider_refusal_is_reported(self, client, admin_auth, sms_whatsapp):  # noqa: F811
        sms, _ = sms_whatsapp
        sms.fail_with = providers.ProviderError("Invalid 'To' number", transient=False)
        response = self._test(client, admin_auth, "sms", "+919876543210")
        assert response.status_code == 422 and response.json()["error_code"] == "TEST_SEND_FAILED"
        assert "Invalid 'To' number" in response.json()["message"]

    def test_an_unconfigured_provider_is_reported_not_faked(self, client, admin_auth):
        response = self._test(client, admin_auth, "whatsapp", "+919876543210")
        assert response.status_code == 422 and response.json()["error_code"] == "TEST_SEND_FAILED"

    def test_a_bad_number_or_channel_is_refused(self, client, admin_auth, sms_whatsapp):  # noqa: F811
        sms, _ = sms_whatsapp
        bad_number = self._test(client, admin_auth, "sms", "12345")
        assert bad_number.status_code == 422 and bad_number.json()["error_code"] == "INVALID_RECIPIENT"
        bad_channel = self._test(client, admin_auth, "fax", "+919876543210")
        assert bad_channel.status_code == 422 and bad_channel.json()["error_code"] == "INVALID_CHANNEL"
        assert sms.sent == []

    def test_test_sends_are_rate_limited(self, client, admin_auth, sms_whatsapp):  # noqa: F811
        codes = [self._test(client, admin_auth, "sms", "+919876543210").status_code for _ in range(11)]
        assert codes[:10] == [200] * 10 and codes[10] == 429


# ------------------------------------------------------------------ fan-out


class TestFanOut:
    VALUES = {"order_number": "DCZ1", "order_url": "https://shop.example.com/o", "tracking_url": "https://t.example.com"}

    def test_nothing_fans_out_for_unknown_marketing_or_guest_events(self, db, customer, sms_whatsapp):  # noqa: F811
        route(db, "sms", ["order_shipped"])
        assert messaging.fan_out(db, "made_up", customer_id="CUS001", values={}, reference="r", key_base="k1") == []
        assert messaging.fan_out(db, "campaign_message", customer_id="CUS001", values={}, reference="r",
                                 key_base="k2") == []
        assert messaging.fan_out(db, "order_shipped", customer_id=None, values={}, reference="r", key_base="k3") == []
        assert db.query(NotificationDelivery).count() == 0

    def test_a_switched_off_template_or_inactive_customer_gets_nothing(self, db, customer, sms_whatsapp):  # noqa: F811
        route(db, "sms", ["order_shipped", "order_packed"])
        db.add(NotificationTemplate(key="order_shipped", enabled=False, email_body="", whatsapp_variables=[],
                                    updated_at=datetime.utcnow()))
        db.flush()
        assert messaging.fan_out(db, "order_shipped", customer_id="CUS001", values=self.VALUES, reference="r",
                                 key_base="a") == []
        customer.status = "blocked"
        db.flush()
        assert messaging.fan_out(db, "order_packed", customer_id="CUS001", values=self.VALUES, reference="r",
                                 key_base="b") == []
        assert messaging.fan_out(db, "order_packed", customer_id="CUS999", values=self.VALUES, reference="r",
                                 key_base="c") == []
        assert db.query(NotificationDelivery).count() == 0

    def test_a_broken_sms_template_is_recorded_as_skipped(self, db, customer, sms_whatsapp):  # noqa: F811
        route(db, "sms", ["order_shipped"])
        db.add(NotificationTemplate(key="order_shipped", enabled=True, email_body="", whatsapp_variables=[],
                                    sms_text="Hi {{not_a_variable}}", updated_at=datetime.utcnow()))
        db.flush()
        [row] = messaging.fan_out(db, "order_shipped", customer_id="CUS001", values=self.VALUES, reference="DCZ1",
                                  key_base="broken")
        assert row.status == "skipped" and "template is invalid" in row.last_error and row.payload is None
        # Queued once: a second call with the same key adds nothing.
        assert messaging.fan_out(db, "order_shipped", customer_id="CUS001", values=self.VALUES, reference="DCZ1",
                                 key_base="broken") == []

    def test_each_reason_not_to_send_is_recorded(self, db, customer, sms_whatsapp):  # noqa: F811
        route(db, "whatsapp", ["order_shipped"])
        route(db, "sms", ["invoice_issued", "order_shipped"])
        messaging.set_consent(db, "CUS001", "whatsapp", "transactional", True, source="test")
        rows = messaging.fan_out(db, "order_shipped", customer_id="CUS001", values=self.VALUES, reference="r",
                                 key_base="ship")
        by_channel = {r.channel: r for r in rows}
        assert by_channel["sms"].status == "queued" and by_channel["sms"].payload["text"]
        assert by_channel["whatsapp"].status == "skipped"
        assert "No approved WhatsApp template" in by_channel["whatsapp"].last_error
        [invoice] = messaging.fan_out(db, "invoice_issued", customer_id="CUS001", values=self.VALUES, reference="r",
                                      key_base="inv")
        assert invoice.status == "skipped" and "no SMS wording" in invoice.last_error
        customer.phone = "12"
        db.flush()
        nophone = messaging.fan_out(db, "order_shipped", customer_id="CUS001", values=self.VALUES, reference="r",
                                    key_base="nophone")
        assert {r.channel for r in nophone} == {"sms", "whatsapp"}
        assert all(r.status == "skipped" and "no usable phone number" in r.last_error and r.recipient == ""
                   and r.payload is None for r in nophone)


# ------------------------------------------------------------------- sending


class TestSending:
    def test_a_bell_message_is_delivered_at_once(self, db, customer):
        row = messaging.queue(db, key="bell:1", event="order_shipped", channel="in_app", category="transactional",
                              customer_id="CUS001", recipient="", payload={"title": "T"})
        db.commit()
        assert messaging.process(db, [row.id]) == {"sent": 1, "failed": 0, "dead": 0}
        row = fresh(db, row)
        assert row.status == "delivered" and row.delivered_at is not None and row.attempts == 1

    def test_an_email_waits_for_an_account_to_be_connected(self, db, customer):
        row = delivery(db, channel="email", recipient="shopper@example.com",
                       payload={"subject": "S", "html": "<p>x</p>", "text": "x"})
        db.commit()
        assert messaging.process(db, [row.id])["failed"] == 1
        row = fresh(db, row)
        assert row.status == "failed" and "No email account" in row.last_error and row.next_attempt_at is not None
        log = db.query(EmailLog).filter_by(delivery_id=row.id).one()
        assert log.status == "failed"

    def test_an_email_without_its_content_is_given_up(self, db, customer, email_account):  # noqa: F811
        row = delivery(db, channel="email", recipient="shopper@example.com", payload={"subject": "S"})
        db.commit()
        assert messaging.process(db, [row.id])["dead"] == 1
        assert fresh(db, row).status == "dead"
        assert email_account.sent == []

    def test_an_email_to_a_rejected_address_is_given_up_and_logged(self, db, customer, email_account):  # noqa: F811
        from app.services.email.senders import SendError

        email_account.fail_with = SendError("550 user unknown")
        row = delivery(db, channel="email", recipient="gone@example.com",
                       payload={"subject": "S", "html": "<p>x</p>", "text": "x", "type": "order_updates"})
        db.commit()
        assert messaging.process(db, [row.id])["dead"] == 1
        row = fresh(db, row)
        assert row.status == "dead" and "user unknown" in row.last_error
        assert db.query(EmailLog).filter_by(delivery_id=row.id, status="failed").count() == 1

    def test_a_sent_sign_in_email_does_not_keep_its_content(self, db, customer, email_account):  # noqa: F811
        row = delivery(db, channel="email", recipient="shopper@example.com", event="password_reset",
                       payload={"subject": "Reset", "html": "<a>link</a>", "text": "link", "type": "account_security"})
        db.commit()
        assert messaging.process(db, [row.id])["sent"] == 1
        row = fresh(db, row)
        assert row.status == "sent" and row.payload is None and row.provider == "smtp"
        assert row.provider_message_id == "<msg-1@example.com>"
        log = db.query(EmailLog).filter_by(delivery_id=row.id).one()
        assert log.status == "sent" and log.provider_id == "<msg-1@example.com>"

    def test_an_unexpected_provider_error_is_retried_then_given_up(self, db, customer, monkeypatch):
        class Exploding(RecordingProvider):
            def send(self, message):
                raise RuntimeError("socket exploded with secrets")

        monkeypatch.setattr(providers, "sms", lambda: Exploding("sms"))
        row = delivery(db, payload={"text": "hi"}, attempts=0, max_attempts=2)
        db.commit()
        assert messaging.process(db, [row.id]) == {"sent": 0, "failed": 1, "dead": 0}
        row = fresh(db, row)
        assert row.status == "failed" and row.last_error == "Unexpected error: RuntimeError"
        assert "secrets" not in row.last_error and row.next_attempt_at > datetime.utcnow()
        row.next_attempt_at = datetime.utcnow() - timedelta(seconds=5)
        db.commit()
        assert messaging.process(db, [row.id])["dead"] == 1
        row = fresh(db, row)
        assert row.status == "dead" and row.next_attempt_at is None and row.attempts == 2

    def test_a_message_left_sending_by_a_dead_worker_is_picked_up_again(self, db, customer, sms_whatsapp):  # noqa: F811
        sms, _ = sms_whatsapp
        row = delivery(db, status="sending", payload={"text": "hello"},
                       updated_at=datetime.utcnow() - timedelta(minutes=30))
        recent = delivery(db, status="sending", payload={"text": "still going"})
        db.commit()
        # The first pass releases the abandoned row (sessions don't autoflush, so it's sent on the next pass).
        assert messaging.process(db)["sent"] == 0
        released = fresh(db, row)
        assert released.status == "failed" and released.last_error == "Interrupted while sending; retried."
        assert fresh(db, recent).status == "sending"  # a worker may still be on it
        assert messaging.process(db)["sent"] == 1
        assert fresh(db, row).status == "sent"
        assert fresh(db, recent).status == "sending"
        assert [m.text for m in sms.sent] == ["hello"]

    def test_a_failed_campaign_message_is_mirrored_on_its_recipient(self, db, customer, sms_whatsapp):  # noqa: F811
        sms, _ = sms_whatsapp
        campaign = campaign_row(db, channels=("sms",))
        row = delivery(db, payload={"text": "offer"}, campaign_id=campaign.id, category="marketing")
        recipient = CampaignRecipient(campaign_id=campaign.id, customer_id="CUS001", channel="sms", status="queued",
                                      token=messaging.new_token(), delivery_id=row.id, created_at=datetime.utcnow())
        db.add(recipient)
        db.commit()
        sms.fail_with = providers.ProviderError("Timeout", transient=True)
        messaging.process(db, [row.id])
        assert fresh(db, recipient).status == "failed"


class TestRetry:
    def _retry(self, client, admin_auth, row_id):
        return client.post(f"/api/admin/messaging/{row_id}/retry", headers=admin_auth)

    def test_an_unknown_message_is_not_found(self, client, admin_auth):
        response = self._retry(client, admin_auth, 987654)
        assert response.status_code == 404 and response.json()["error_code"] == "NOTIFICATION_NOT_FOUND"

    def test_a_sent_message_is_not_retried(self, client, db, customer, admin_auth):
        row = delivery(db, status="sent", payload={"text": "x"})
        response = self._retry(client, admin_auth, row.id)
        assert response.status_code == 422 and response.json()["error_code"] == "NOT_RETRYABLE"

    def test_an_email_without_its_content_cannot_be_resent(self, client, db, customer, admin_auth):
        row = delivery(db, channel="email", status="dead", payload=None, recipient="shopper@example.com")
        response = self._retry(client, admin_auth, row.id)
        assert response.status_code == 422 and response.json()["error_code"] == "NOT_RETRYABLE"
        assert "sign-in link" in response.json()["message"]

    def test_an_sms_cannot_be_retried_without_a_provider(self, client, db, customer, admin_auth):
        row = delivery(db, status="dead", payload={"text": "x"})
        response = self._retry(client, admin_auth, row.id)
        assert response.status_code == 422 and response.json()["error_code"] == "CHANNEL_NOT_CONFIGURED"
        assert fresh(db, row).status == "dead"

    def test_a_skipped_sms_with_no_content_cannot_be_retried(self, client, db, customer, admin_auth,
                                                             sms_whatsapp):  # noqa: F811
        row = delivery(db, status="skipped", payload=None)
        response = self._retry(client, admin_auth, row.id)
        assert response.status_code == 422 and response.json()["error_code"] == "NOT_RETRYABLE"

    def test_a_retry_that_fails_again_says_queued_and_raises_the_limit(self, client, db, customer, admin_auth,
                                                                       sms_whatsapp):  # noqa: F811
        sms, _ = sms_whatsapp
        sms.fail_with = providers.ProviderError("Rate limited", transient=True)
        row = delivery(db, status="dead", payload={"text": "x"}, attempts=5, max_attempts=5)
        response = self._retry(client, admin_auth, row.id)
        assert response.status_code == 200, response.text
        assert response.json()["message"] == "Queued again."
        row = fresh(db, row)
        # One more attempt was allowed, and used: the row gives up again rather than looping forever.
        assert row.attempts == 6 and row.max_attempts == 6 and row.status == "dead"


# --------------------------------------------------------------- webhooks


def twilio_signature(url, params, token="tw-token"):
    data = url + "".join(f"{k}{params[k]}" for k in sorted(params))
    return base64.b64encode(hmac.new(token.encode(), data.encode(), hashlib.sha1).digest()).decode()


class TestTwilioWebhook:
    URL = "http://testserver/api/notifications/webhooks/twilio"

    @pytest.fixture(autouse=True)
    def _token(self, monkeypatch):
        monkeypatch.setattr(settings, "TWILIO_AUTH_TOKEN", "tw-token")
        monkeypatch.setattr(settings, "PUBLIC_API_URL", "")

    def post(self, client, params):
        return client.post(self.URL, data=params, headers={"X-Twilio-Signature": twilio_signature(self.URL, params)})

    def test_a_failure_report_gives_the_message_up_with_the_error_code(self, client, db, customer):
        row = delivery(db, status="sent", provider_message_id="SM1")
        response = self.post(client, {"MessageSid": "SM1", "MessageStatus": "undelivered", "ErrorCode": "30003"})
        assert response.status_code == 200 and response.text == "ok"
        row = fresh(db, row)
        assert row.status == "dead" and row.last_error == "Twilio error 30003" and row.failed_at is not None

    def test_a_late_report_never_moves_a_message_backwards(self, client, db, customer):
        row = delivery(db, status="delivered", provider_message_id="SM2")
        self.post(client, {"MessageSid": "SM2", "MessageStatus": "sent"})
        assert fresh(db, row).status == "delivered"

    def test_reports_for_unknown_messages_or_statuses_change_nothing(self, client, db, customer):
        row = delivery(db, status="sent", provider_message_id="SM3")
        assert self.post(client, {"MessageSid": "SM-other", "MessageStatus": "delivered"}).status_code == 200
        assert self.post(client, {"MessageSid": "SM3", "MessageStatus": "teleported"}).status_code == 200
        assert self.post(client, {"MessageStatus": "delivered"}).status_code == 200
        assert fresh(db, row).status == "sent"

    def test_without_a_configured_token_every_report_is_refused(self, client, db, customer, monkeypatch):
        monkeypatch.setattr(settings, "TWILIO_AUTH_TOKEN", "")
        row = delivery(db, status="sent", provider_message_id="SM4")
        response = self.post(client, {"MessageSid": "SM4", "MessageStatus": "delivered"})
        assert response.status_code == 403
        assert fresh(db, row).status == "sent"


class TestWhatsAppWebhook:
    URL = "/api/notifications/webhooks/whatsapp"

    @pytest.fixture(autouse=True)
    def _secret(self, monkeypatch):
        monkeypatch.setattr(settings, "WHATSAPP_APP_SECRET", "wa-secret")
        monkeypatch.setattr(settings, "WHATSAPP_VERIFY_TOKEN", "verify-me")

    def post(self, client, payload=None, *, raw=None, signature=None):
        body = raw if raw is not None else json.dumps(payload).encode()
        sig = signature or "sha256=" + hmac.new(b"wa-secret", body, hashlib.sha256).hexdigest()
        return client.post(self.URL, content=body, headers={"X-Hub-Signature-256": sig,
                                                            "Content-Type": "application/json"})

    def test_the_subscription_handshake_needs_the_verify_token(self, client, monkeypatch):
        ok = client.get(self.URL, params={"hub.mode": "subscribe", "hub.verify_token": "verify-me",
                                          "hub.challenge": "12345"})
        assert ok.status_code == 200 and ok.text == "12345"
        wrong = client.get(self.URL, params={"hub.mode": "subscribe", "hub.verify_token": "guess",
                                             "hub.challenge": "12345"})
        assert wrong.status_code == 403
        monkeypatch.setattr(settings, "WHATSAPP_VERIFY_TOKEN", "")
        unset = client.get(self.URL, params={"hub.mode": "subscribe", "hub.verify_token": "",
                                             "hub.challenge": "12345"})
        assert unset.status_code == 403

    def test_a_forged_or_malformed_post_is_refused(self, client, db, customer):
        row = delivery(db, channel="whatsapp", status="sent", provider_message_id="wamid.1")
        payload = {"entry": [{"changes": [{"value": {"statuses": [{"id": "wamid.1", "status": "read"}]}}]}]}
        assert self.post(client, payload, signature="sha256=" + "0" * 64).status_code == 403
        assert self.post(client, payload, signature="nope").status_code == 403
        assert self.post(client, raw=b"{not json").status_code == 400
        assert fresh(db, row).status == "sent"

    def test_reads_and_replies_are_credited_to_the_campaign(self, client, db, customer):
        campaign = campaign_row(db)
        row = delivery(db, channel="whatsapp", status="sent", provider_message_id="wamid.2",
                       campaign_id=campaign.id, category="marketing", event="campaign_message")
        recipient = CampaignRecipient(campaign_id=campaign.id, customer_id="CUS001", channel="whatsapp",
                                      status="sent", token=messaging.new_token(), delivery_id=row.id,
                                      created_at=datetime.utcnow())
        db.add(recipient)
        db.commit()
        payload = {"entry": [{"changes": [{"value": {
            "statuses": [{"id": "wamid.2", "status": "read"}, {"id": "wamid.unknown", "status": "delivered"}],
            "messages": [{"from": "919876500001"}, {"from": "919999999999"}],
        }}]}]}
        assert self.post(client, payload).status_code == 200
        row, recipient = fresh(db, row), fresh(db, recipient)
        assert row.status == "read" and row.delivered_at is not None
        assert recipient.status == "read" and recipient.opened_at is not None and recipient.replied_at is not None
        first_reply = recipient.replied_at
        # A second reply is not counted again.
        assert messaging.whatsapp_event(db, {"entry": [{"changes": [{"value": {
            "messages": [{"from": "+919876500001"}]}}]}]}) == 0
        assert fresh(db, recipient).replied_at == first_reply

    def test_a_failure_status_carries_the_providers_reason(self, client, db, customer):
        row = delivery(db, channel="whatsapp", status="sent", provider_message_id="wamid.3")
        payload = {"entry": [{"changes": [{"value": {"statuses": [
            {"id": "wamid.3", "status": "failed", "errors": [{"title": "Re-engagement message"}]}]}}]}]}
        assert self.post(client, payload).status_code == 200
        row = fresh(db, row)
        assert row.status == "dead" and row.last_error == "Re-engagement message"

    def test_an_empty_event_is_accepted_and_ignored(self, client, db):
        assert self.post(client, raw=b"").status_code == 200
        assert messaging.whatsapp_event(db, {}) == 0


# ------------------------------------------------------- history & overview


class TestHistoryAndOverview:
    @pytest.fixture()
    def history(self, db, customer, other_customer):
        old = datetime.utcnow() - timedelta(days=20)
        rows = {
            "sms_sent": delivery(db, status="sent", reference="DCZ100", provider_message_id="SMabc"),
            "email_failed": delivery(db, channel="email", status="failed", recipient="shopper@example.com",
                                     event="order_packed", reference="DCZ200"),
            "other_dead": delivery(db, status="dead", customer_id="CUS002", recipient="+919876500002",
                                   reference="DCZ300", last_error="Invalid number"),
            "old": delivery(db, channel="in_app", status="delivered", created_at=old, reference="DCZ400"),
            "unknown_event": delivery(db, channel="in_app", status="delivered", event="legacy_thing",
                                      reference="DCZ500"),
        }
        db.commit()
        return rows

    def listing(self, client, admin_auth, **params):
        response = client.get("/api/admin/messaging", headers=admin_auth, params=params)
        assert response.status_code == 200, response.text
        return response.json()["data"]

    def test_filters_combine_and_counts_ignore_the_status_tab(self, client, admin_auth, history):
        data = self.listing(client, admin_auth, channel="sms")
        assert {i["id"] for i in data["items"]} == {history["sms_sent"].id, history["other_dead"].id}
        assert data["counts"] == {"sent": 1, "dead": 1}
        dead = self.listing(client, admin_auth, channel="sms", status="dead")
        assert [i["id"] for i in dead["items"]] == [history["other_dead"].id]
        assert dead["counts"] == {"sent": 1, "dead": 1} and dead["pagination"]["total"] == 1
        assert [i["id"] for i in self.listing(client, admin_auth, event="order_packed")["items"]] == \
            [history["email_failed"].id]
        assert {i["id"] for i in self.listing(client, admin_auth, customer="CUS002")["items"]} == \
            {history["other_dead"].id}

    def test_search_by_reference_or_provider_id_exactly(self, client, admin_auth, history):
        def ids(**params):
            return [i["id"] for i in self.listing(client, admin_auth, **params)["items"]]

        assert ids(q="DCZ200") == [history["email_failed"].id]
        assert ids(q="SMabc") == [history["sms_sent"].id]
        assert ids(customer="cus-002") == [history["other_dead"].id]
        # Identifiers only (docs/id-lookup.md): part of one, a name, a phone number or an email finds nothing.
        for q in ("DCZ2", "Ravi", "+919876500002", "shopper@example.com", "SMab"):
            assert ids(q=q) == [], q
        assert ids(customer="Ravi") == []

    def test_a_date_only_end_includes_that_whole_day(self, client, admin_auth, history):
        today = datetime.utcnow().strftime("%Y-%m-%d")
        week_ago = (datetime.utcnow() - timedelta(days=7)).strftime("%Y-%m-%d")
        data = self.listing(client, admin_auth, **{"from": week_ago, "to": today})
        ids = {i["id"] for i in data["items"]}
        assert history["old"].id not in ids and history["sms_sent"].id in ids
        assert data["pagination"]["total"] == 4

    def test_the_list_masks_recipients_and_names_unknown_events(self, client, admin_auth, history):
        items = {i["id"]: i for i in self.listing(client, admin_auth)["items"]}
        sms = items[history["sms_sent"].id]
        assert sms["recipient"] != "+919876500001" and sms["recipient"].endswith("00001")
        assert sms["customer"] == {"id": "CUS001", "name": "Asha Rao"}
        assert items[history["unknown_event"].id]["eventLabel"] == "legacy thing"
        assert items[history["other_dead"].id]["retryable"] is True and sms["retryable"] is False

    def test_one_message_shows_its_content(self, client, db, admin_auth, customer):
        row = delivery(db, status="sent", payload={"text": "Your order shipped", "secret": "never shown"})
        response = client.get(f"/api/admin/messaging/{row.id}", headers=admin_auth)
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["content"] == {"text": "Your order shipped"} and data["customer"]["id"] == "CUS001"
        guest = delivery(db, status="sent", customer_id=None, payload=None)
        guest_view = client.get(f"/api/admin/messaging/{guest.id}", headers=admin_auth).json()["data"]
        assert guest_view["customer"] is None and guest_view["content"] == {}
        missing = client.get("/api/admin/messaging/99999999", headers=admin_auth)
        assert missing.status_code == 404 and missing.json()["error_code"] == "NOTIFICATION_NOT_FOUND"

    def test_the_overview_counts_the_last_week_per_channel(self, client, admin_auth, history):
        response = client.get("/api/admin/messaging/overview", headers=admin_auth, params={"days": 7})
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["byChannel"]["sms"] == {"total": 2, "sent": 1, "dead": 1}
        assert data["byChannel"]["in_app"] == {"total": 1, "delivered": 1}  # the old one is outside the week
        assert data["byChannel"]["whatsapp"] == {"total": 0}
        assert data["retrying"] == 1 and data["gaveUp"] == 1
        assert data["channels"]["sms"]["configured"] is False and data["channels"]["in_app"]["configured"] is True
        assert data["channels"]["email"]["reason"]
        assert any(e["key"] == "order_shipped" for e in data["events"])
        assert set(data["routing"]) == {"sms", "whatsapp"}

    def test_the_overview_window_is_bounded(self, client, admin_auth):
        response = client.get("/api/admin/messaging/overview", headers=admin_auth, params={"days": 91})
        assert response.status_code == 422


# -------------------------------------------------------------- the loop


def membership(db, *, ends_in, status="active", customer_id="CUS001"):
    from app.models import CustomerMembership, MembershipPlan

    now = datetime.utcnow()
    if db.get(MembershipPlan, "MPL001") is None:
        db.add(MembershipPlan(id="MPL001", name="Choice Circle Yearly", duration_months=12, price=999,
                              created_at=now, updated_at=now))
        db.flush()
    row = CustomerMembership(id=f"MEM{abs(hash((customer_id, ends_in, status))) % 9000 + 1000}",
                             customer_id=customer_id, plan_id="MPL001", plan_name="Choice Circle Yearly",
                             duration_months=12, status=status, starts_at=now - timedelta(days=300),
                             ends_at=now + ends_in, amount=99900, benefits={}, created_at=now, updated_at=now)
    db.add(row)
    db.flush()
    return row


class TestTheLoop:
    def test_membership_endings_are_told_once_each(self, db, customer, other_customer, email_account):  # noqa: F811
        ending = membership(db, ends_in=timedelta(days=3))
        ended = membership(db, ends_in=timedelta(days=-1), customer_id="CUS002")
        db.commit()
        counts = messaging.sweep(db)
        assert counts["memberships"] == 2
        assert fresh(db, ended).status == "expired"
        markers = db.query(NotificationDelivery).filter(NotificationDelivery.idempotency_key.like("%:marker")).all()
        assert sorted(m.event for m in markers) == ["membership_expired", "membership_expiring"]
        email_account.run()
        subjects = sorted(m["subject"] for m in email_account.sent)
        assert any("ends on" in s for s in subjects) and any("has ended" in s for s in subjects)
        # The next pass finds the markers and tells nobody again.
        assert messaging.sweep(db)["memberships"] == 0
        email_account.run()
        assert len(email_account.sent) == 2
        _ = ending

    def test_a_marker_is_left_even_without_an_email_account(self, db, customer):
        membership(db, ends_in=timedelta(days=2))
        db.commit()
        assert messaging._membership_notices(db) == 1
        assert messaging._membership_notices(db) == 0
        assert db.query(NotificationDelivery).filter_by(channel="email").count() == 0

    def test_an_inactive_customer_is_not_told(self, db, customer):
        membership(db, ends_in=timedelta(days=2))
        customer.status = "blocked"
        db.commit()
        assert messaging._membership_notices(db) == 0

    def test_a_failing_membership_pass_does_not_stop_the_sweep(self, db, customer, sms_whatsapp,
                                                               monkeypatch):  # noqa: F811
        row = delivery(db, payload={"text": "hi"})
        db.commit()

        def broken(_db):
            raise RuntimeError("membership table locked")

        monkeypatch.setattr(messaging, "_membership_notices", broken)
        counts = messaging.sweep(db)
        assert counts["sent"] == 1 and "memberships" not in counts
        assert fresh(db, row).status == "sent"

    def test_staff_are_alerted_about_dead_messages_once_an_hour(self, db, customer, admin):
        delivery(db, status="dead", last_error="Invalid number")
        delivery(db, status="dead", channel="email", category="marketing")  # offers don't page anyone
        db.commit()
        messaging.sweep(db)
        alerts = db.query(Notification).filter_by(kind="notifications").all()
        assert len(alerts) == 1 and alerts[0].title == "1 customer message couldn't be delivered"
        assert alerts[0].href == "/admin/notifications?status=dead"
        delivery(db, status="dead")
        db.commit()
        messaging.sweep(db)
        assert db.query(Notification).filter_by(kind="notifications").count() == 1

    def test_no_alert_when_nothing_was_given_up(self, db, admin):
        messaging._alert_dead(db)
        assert db.query(Notification).count() == 0

    def test_one_pass_uses_its_own_session_and_rolls_back_on_error(self, db, customer, monkeypatch):
        from app.core import database as db_module

        monkeypatch.setattr(db_module, "SessionLocal", lambda: Shared(db))
        calls = []
        monkeypatch.setattr(messaging, "sweep", lambda session: calls.append(session) or {})
        messaging._sweep_once()
        assert calls == [db]

        def broken(session):
            raise RuntimeError("database went away")

        monkeypatch.setattr(messaging, "sweep", broken)
        rolled = []
        monkeypatch.setattr(db, "rollback", lambda: rolled.append(True))
        with pytest.raises(RuntimeError):
            messaging._sweep_once()
        assert rolled == [True]

    def test_a_commit_hands_queued_texts_to_a_sender_thread(self, db, customer, sms_whatsapp,
                                                            monkeypatch):  # noqa: F811
        from app.core import database as db_module

        sms, _ = sms_whatsapp
        row = delivery(db, payload={"text": "after commit"})
        db.commit()
        monkeypatch.setattr(db_module, "SessionLocal", lambda: Shared(db))
        started = []

        class Inline:
            def __init__(self, target, **kwargs):
                self.target, self.kwargs = target, kwargs

            def start(self):
                started.append(self.kwargs.get("name"))
                self.target()

        monkeypatch.setattr(messaging, "threading", types.SimpleNamespace(Thread=Inline))
        session = types.SimpleNamespace(info={"outgoing_messages": [row.id]})
        messaging._send_after_commit(session)
        assert started == ["notification-sender"] and session.info == {}
        assert fresh(db, row).status == "sent" and [m.text for m in sms.sent] == ["after commit"]
        # Nothing queued: no thread.
        messaging._send_after_commit(types.SimpleNamespace(info={}))
        assert started == ["notification-sender"]

    def test_a_sender_thread_that_fails_is_logged_not_raised(self, db, monkeypatch, caplog):
        from app.core import database as db_module

        monkeypatch.setattr(db_module, "SessionLocal", lambda: Shared(db))

        def broken(session, ids):
            raise RuntimeError("provider down")

        monkeypatch.setattr(messaging, "process", broken)

        class Inline:
            def __init__(self, target, **kwargs):
                self.target = target

            def start(self):
                self.target()

        monkeypatch.setattr(messaging, "threading", types.SimpleNamespace(Thread=Inline))
        messaging._send_after_commit(types.SimpleNamespace(info={"outgoing_messages": [1]}))
        assert "the loop will retry" in caplog.text

    def test_a_rollback_drops_texts_that_were_queued(self):
        session = types.SimpleNamespace(info={"outgoing_messages": [1, 2]})
        messaging._drop_after_rollback(session)
        assert session.info == {}

    def test_the_forever_loop_survives_a_failed_pass_and_stops_when_cancelled(self, monkeypatch, caplog):
        from app.services import jobs

        passes = []

        def failing_pass():
            passes.append(1)
            raise RuntimeError("one bad pass")

        async def cancel(_seconds):
            raise asyncio.CancelledError

        monkeypatch.setattr(jobs, "tracked", lambda name, interval, fn: fn)
        monkeypatch.setattr(messaging, "_sweep_once", failing_pass)
        monkeypatch.setattr(asyncio, "sleep", cancel)
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(messaging.run_forever())
        assert passes == [1] and "Notification sweep failed" in caplog.text


# ---------------------------------------------------------------- backups


class TestBackupRoutes:
    def test_backup_settings_are_saved_through_the_portal(self, client, db, admin_auth):
        response = client.put("/api/admin/backups/settings", headers=admin_auth,
                              json={"frequency": "weekly", "weekday": 2, "hour": 3})
        assert response.status_code == 200, response.text
        assert response.json()["data"]["frequency"] == "weekly"
        db.expire_all()
        assert db.get(SettingDocument, "backups").value["weekday"] == 2
        bad = client.put("/api/admin/backups/settings", headers=admin_auth, json={"frequency": "hourly"})
        assert bad.status_code == 422 and bad.json()["error_code"] == "INVALID_SETTING"

    # Regression: was a real bug, fixed alongside this test.
    def test_a_failed_manual_backup_is_a_500_with_the_record(self, client, db, admin_auth, monkeypatch, tmp_path):
        from app.services import backups

        monkeypatch.setattr(settings, "BACKUP_STORAGE", "local")
        monkeypatch.setattr(settings, "BACKUP_LOCAL_DIR", str(tmp_path / "backups"))
        monkeypatch.setattr(settings, "BACKUP_ENCRYPTION_KEY", "test-backup-key-0123456789")

        def broken(name=None):
            raise backups.BackupError("The disk is full.")

        monkeypatch.setattr(backups, "storage", broken)
        response = client.post("/api/admin/backups/run", headers=admin_auth)
        assert response.status_code == 500
        body = response.json()
        assert body["success"] is False and body["error_code"] == "BACKUP_FAILED"
        assert "disk is full" in body["message"] and body["data"]["status"] == "failed"

    def test_backup_settings_need_the_backups_permission(self, client, db):
        headers = login_admin(client, db, role="admin", permissions=[], email="plainadmin@example.com")
        response = client.put("/api/admin/backups/settings", headers=headers, json={"frequency": "daily"})
        assert response.status_code == 403 and response.json()["error_code"] == "PERMISSION_DENIED"
        _ = Customer
