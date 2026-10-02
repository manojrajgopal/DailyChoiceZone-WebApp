"""
Email beyond the happy path: the store's account endpoints (validation,
testing the saved account, disconnecting), the Google sign-in hop and every
way its callback can fail, sending invoices, the store's and customers'
choices saved twice, the log search, the safety nets inside `notify` (a broken
template, channel or bell never stops the email; the same message never goes
twice), the background sender's bookkeeping, the store's other notification
emails (payments, refunds, returns, membership), the bounce checker's
failure modes and loop, and who hears about a support ticket.
"""

from __future__ import annotations

import asyncio
import types
from datetime import datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import pytest
from jose import jwt

from app.core import rate_limit
from app.core.config import settings
from app.models import (
    AdminUser,
    CustomerEmailPreference,
    CustomerNotification,
    EmailAccount,
    EmailLog,
    Notification,
    NotificationDelivery,
    NotificationTemplate,
    Order,
    SettingDocument,
    SupportAgent,
    SupportEmailTemplate,
    SupportTeam,
    SupportTicket,
)
from app.services import email as email_service
from app.services.email import crypto
from app.services.email.senders import SendError
from tests.integration.messaging_helpers import email_account  # noqa: F401
from tests.integration.test_email import GMAIL, connect, outbox  # noqa: F401
from tests.integration.test_email_bounces import log, mailbox, notice  # noqa: F401
from tests.integration.wallet_helpers import fill_bag, place

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


class Shared:
    def __init__(self, session):
        self.session = session

    def __enter__(self):
        return self.session

    def __exit__(self, *exc):
        return False

    def __getattr__(self, name):
        return getattr(self.session, name)


def staff_headers(client, db, *, role, permissions, email):
    from app.core.security import hash_password

    db.add(AdminUser(id="ADM050", email=email, password_hash=hash_password("Admin@123"), name="Staff Member",
                     role=role, permissions=permissions, status="active", created_at=datetime(2026, 1, 1)))
    db.flush()
    response = client.post("/api/admin/auth/login", json={"email": email, "password": "Admin@123"})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}


def queued_jobs(db):
    return list(db.info.get("outgoing_email", []))


# ------------------------------------------------------------- the account


class TestTheAccountEndpoints:
    @pytest.mark.parametrize("override, code", [
        ({"provider": "pigeon-post"}, "EMAIL_PROVIDER"),
        ({"senderEmail": "not-an-address"}, "EMAIL_SENDER"),
        ({"testRecipient": "nobody"}, "EMAIL_TEST_RECIPIENT"),
    ])
    def test_bad_details_are_refused_before_any_test(self, client, db, admin_auth, outbox, override, code):  # noqa: F811
        response = connect(client, admin_auth, **override)
        assert response.status_code == 422 and response.json()["error_code"] == code
        assert outbox == [] and db.query(EmailAccount).count() == 0

    def test_the_saved_account_can_be_tested(self, client, db, admin_auth, outbox):  # noqa: F811
        missing = client.post("/api/admin/email/test", headers=admin_auth, json={"recipient": "owner@example.com"})
        assert missing.status_code == 422 and missing.json()["error_code"] == "EMAIL_NOT_CONFIGURED"
        connect(client, admin_auth)
        outbox.clear()
        response = client.post("/api/admin/email/test", headers=admin_auth, json={"recipient": "owner@example.com"})
        assert response.status_code == 200 and response.json()["message"] == "Test email sent to owner@example.com."
        assert outbox[0]["to"] == "owner@example.com" and outbox[0]["subject"] == "Test email from Daily Choice Zone"

    def test_a_saved_account_that_stopped_working_is_reported(self, client, admin_auth, outbox,
                                                              monkeypatch):  # noqa: F811
        connect(client, admin_auth)

        def refuse(*_):
            raise SendError("Token has been expired or revoked.")

        monkeypatch.setattr(email_service, "deliver", refuse)
        response = client.post("/api/admin/email/test", headers=admin_auth, json={"recipient": "owner@example.com"})
        assert response.status_code == 422 and response.json()["error_code"] == "EMAIL_TEST_FAILED"
        assert "expired or revoked" in response.json()["message"]

    def test_disconnecting_stops_sending(self, client, db, admin_auth, outbox):  # noqa: F811
        connect(client, admin_auth)
        response = client.delete("/api/admin/email/account", headers=admin_auth)
        assert response.status_code == 200 and response.json()["message"] == "Email sending is turned off."
        db.expire_all()
        assert db.query(EmailAccount).filter(EmailAccount.active.is_(True)).count() == 0
        assert db.query(EmailAccount).count() == 1  # kept, only switched off
        account = client.get("/api/admin/email", headers=admin_auth).json()["data"]["account"]
        assert account["configured"] is False and "senderEmail" not in account

    def test_a_new_account_replaces_the_old_one(self, client, db, admin_auth, outbox):  # noqa: F811
        connect(client, admin_auth)
        response = connect(client, admin_auth, provider="smtp", senderEmail="mail@example.com", host="smtp.example.com",
                           port="587", security="starttls", username="mail@example.com", password="pw-123456")
        assert response.status_code == 200, response.text
        db.expire_all()
        active = db.query(EmailAccount).filter(EmailAccount.active.is_(True)).all()
        assert [a.provider for a in active] == ["smtp"]
        fields = client.get("/api/admin/email", headers=admin_auth).json()["data"]["account"]["fields"]
        assert fields["host"] == "smtp.example.com" and fields["password"] != "pw-123456"
        # Switching provider does not carry the Gmail secrets over.
        assert "clientSecret" not in fields

    def test_staff_without_settings_access_are_refused(self, client, db):
        headers = staff_headers(client, db, role="manager", permissions=["orders"], email="mgr@example.com")
        for response in (client.get("/api/admin/email", headers=headers),
                         client.delete("/api/admin/email/account", headers=headers),
                         client.get("/api/admin/email/log", headers=headers)):
            assert response.status_code == 403 and response.json()["error_code"] == "PERMISSION_DENIED"


class TestConnectWithGoogle:
    def test_a_blank_secret_reuses_the_saved_one(self, client, admin_auth, outbox):  # noqa: F811
        connect(client, admin_auth)
        response = client.post("/api/admin/email/google/start", headers=admin_auth, json={
            "clientId": "client-123", "clientSecret": "", "senderEmail": "orders@example.com"})
        assert response.status_code == 200, response.text
        state = parse_qs(urlsplit(response.json()["data"]["authorizationUrl"]).query)["state"][0]
        claims = jwt.decode(state, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
        pending = crypto.unseal(claims["p"])
        assert pending["clientSecret"] == "GOCSPX-secretvalue" and pending["testRecipient"] == "orders@example.com"
        assert claims["purpose"] == "email-oauth"
        # The secret travels sealed: it isn't readable in the link.
        assert "GOCSPX" not in response.json()["data"]["authorizationUrl"]

    def test_without_any_secret_it_asks_for_one(self, client, admin_auth):
        response = client.post("/api/admin/email/google/start", headers=admin_auth, json={
            "clientId": "client-123", "senderEmail": "orders@example.com"})
        assert response.status_code == 422 and response.json()["error_code"] == "GOOGLE_INCOMPLETE"


def callback_state(*, purpose="email-oauth", pending=None, minutes=15):
    sealed = crypto.seal(pending if pending is not None else {
        "clientId": "client-123", "clientSecret": "secret", "senderEmail": "orders@example.com",
        "senderName": "DCZ", "replyTo": "", "testRecipient": "owner@example.com", "admin": "ADM001"})
    return jwt.encode({"p": sealed, "exp": datetime.utcnow() + timedelta(minutes=minutes), "purpose": purpose},
                      settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


class TestGoogleCallback:
    def back(self, client, **params):
        response = client.get("/auth/callback", params=params, follow_redirects=False)
        assert response.status_code == 303
        query = parse_qs(urlsplit(response.headers["location"]).query)
        assert response.headers["location"].startswith(f"{settings.STOREFRONT_URL.rstrip('/')}/admin/settings/email?")
        return query["google"][0], query.get("message", [""])[0]

    def test_a_cancelled_sign_in(self, client):
        assert self.back(client, error="access_denied") == ("cancelled", "Google sign-in was cancelled.")

    def test_an_expired_or_tampered_state(self, client):
        outcome, message = self.back(client, code="c", state=callback_state(minutes=-1))
        assert outcome == "failed" and "expired" in message
        assert self.back(client, code="c", state="garbage")[0] == "failed"

    def test_a_state_made_for_something_else(self, client):
        assert self.back(client, code="c", state=callback_state(purpose="login")) == \
            ("failed", "That connection request isn't valid.")

    def test_a_missing_code_or_empty_request(self, client):
        assert self.back(client, state=callback_state())[0] == "failed"
        assert self.back(client, code="c", state=callback_state(pending={}))[0] == "failed"

    def test_google_refusing_the_code_saves_nothing(self, client, db, monkeypatch):
        from app.api.routes import email as email_routes

        def refuse(**_):
            raise SendError("Google refused the code: invalid_grant")

        monkeypatch.setattr(email_routes, "exchange_code", refuse)
        assert self.back(client, code="c", state=callback_state()) == ("failed", "Google refused the code: invalid_grant")
        assert db.query(EmailAccount).count() == 0

    def test_a_successful_hop_tests_then_saves_the_account(self, client, db, outbox, monkeypatch):  # noqa: F811
        from app.api.routes import email as email_routes

        monkeypatch.setattr(email_routes, "exchange_code",
                            lambda **_: {"refreshToken": "1//new-refresh", "accessToken": "ya29.token"})
        outcome, message = self.back(client, code="good-code", state=callback_state())
        assert outcome == "connected" and "owner@example.com" in message
        assert outbox[0]["to"] == "owner@example.com" and outbox[0]["provider"] == "gmail-oauth"
        account = db.query(EmailAccount).filter(EmailAccount.active.is_(True)).one()
        assert account.updated_by == "ADM001" and crypto.unseal(account.credentials)["refreshToken"] == "1//new-refresh"


# ----------------------------------------------------------------- invoices


class TestSendingInvoices:
    @pytest.fixture()
    def invoice_id(self, client, auth, catalogue, settings_documents):
        fill_bag(client, auth, "PRD001")
        return place(client, auth, method="cod")["invoiceId"]

    def test_an_unknown_invoice_is_not_found(self, client, admin_auth):
        response = client.post("/api/admin/billing/invoices/INV404/send", headers=admin_auth)
        assert response.status_code == 404 and response.json()["error_code"] == "INVOICE_NOT_FOUND"

    def test_invoices_need_an_email_account(self, client, admin_auth, invoice_id):
        response = client.post(f"/api/admin/billing/invoices/{invoice_id}/send", headers=admin_auth)
        assert response.status_code == 422 and response.json()["error_code"] == "EMAIL_NOT_CONFIGURED"

    def test_switched_off_invoice_emails_are_reported(self, client, admin_auth, outbox, invoice_id):  # noqa: F811
        connect(client, admin_auth)
        types_ = client.get("/api/admin/email", headers=admin_auth).json()["data"]["types"]
        for row in types_:
            if row["key"] == "invoice":
                row["enabled"] = False
        client.put("/api/admin/email/types", headers=admin_auth, json=types_)
        outbox.clear()
        response = client.post(f"/api/admin/billing/invoices/{invoice_id}/send", headers=admin_auth)
        assert response.status_code == 422 and response.json()["error_code"] == "EMAIL_NOT_SENT"
        assert outbox == []

    def test_sending_invoices_needs_the_orders_permission(self, client, db, invoice_id):
        headers = staff_headers(client, db, role="editor", permissions=["products"], email="ed@example.com")
        response = client.post(f"/api/admin/billing/invoices/{invoice_id}/send", headers=headers)
        assert response.status_code == 403


# ---------------------------------------------------------------- choices


class TestChoices:
    def test_store_choices_saved_twice_replace_the_first_and_ignore_unknown_kinds(self, client, db, admin_auth):
        first = [{"key": "offers", "enabled": True, "customerCanOptOut": True},
                 {"key": "made_up", "enabled": True, "customerCanOptOut": True}]
        assert client.put("/api/admin/email/types", headers=admin_auth, json=first).status_code == 200
        second = [{"key": "offers", "enabled": False, "customerCanOptOut": False}]
        response = client.put("/api/admin/email/types", headers=admin_auth, json=second)
        assert response.status_code == 200
        db.expire_all()
        assert db.get(SettingDocument, "email_types").value == {"offers": {"enabled": False,
                                                                          "customerCanOptOut": False}}
        offers = next(t for t in response.json()["data"] if t["key"] == "offers")
        assert offers["enabled"] is False
        # Kinds left out go back to their defaults.
        order = next(t for t in response.json()["data"] if t["key"] == "order_updates")
        assert order["enabled"] is True

    def test_a_customer_changing_their_mind_updates_one_row(self, client, db, customer, auth):
        for enabled in (False, True, False):
            response = client.put("/api/account/email-preferences", headers=auth,
                                  json={"order_updates": enabled, "support_team": False, "nonsense": False})
            assert response.status_code == 200
        db.expire_all()
        rows = db.query(CustomerEmailPreference).filter_by(customer_id="CUS001").all()
        assert [(r.email_type, r.enabled) for r in rows] == [("order_updates", False)]
        keys = [p["key"] for p in response.json()["data"]]
        assert "support_team" not in keys and "store_team" not in keys  # staff alerts are never offered
        assert email_service.wants(db, "order_updates", "CUS001") is False
        assert email_service.wants(db, "made_up", "CUS001") is False
        assert email_service.wants(db, "order_updates", None) is True

    def test_choices_need_a_signed_in_customer(self, client):
        assert client.get("/api/account/email-preferences").status_code == 401
        assert client.put("/api/account/email-preferences", json={"order_updates": False}).status_code == 401


class TestTheLog:
    @pytest.fixture()
    def rows(self, db):
        now = datetime.utcnow()
        made = [
            EmailLog(email_type="invoice", recipient="a@example.com", subject="Invoice DCZ-INV-1", status="sent",
                     reference="DCZ1", created_at=now - timedelta(days=3)),
            EmailLog(email_type="order_updates", recipient="b@example.com", subject="Shipped", status="failed",
                     error="Timeout", reference="DCZ2", created_at=now - timedelta(hours=1)),
            EmailLog(email_type="order_updates", recipient="c@example.com", subject="Packed", status="sent",
                     reference="DCZ3", created_at=now - timedelta(days=40)),
        ]
        db.add_all(made)
        db.flush()
        return made

    def search(self, client, admin_auth, **params):
        response = client.get("/api/admin/email/log/search", headers=admin_auth, params=params)
        assert response.status_code == 200, response.text
        return response.json()["data"]

    def test_search_by_type_text_and_dates(self, client, admin_auth, rows):
        by_type = self.search(client, admin_auth, type="order_updates")
        assert [i["recipient"] for i in by_type["items"]] == ["c@example.com", "b@example.com"]  # newest row first
        assert by_type["counts"] == {"sent": 1, "failed": 1}
        assert [i["reference"] for i in self.search(client, admin_auth, q="INV")["items"]] == ["DCZ1"]
        since = (datetime.utcnow() - timedelta(days=7)).isoformat()
        until = (datetime.utcnow() - timedelta(days=2)).isoformat()
        assert [i["reference"] for i in self.search(client, admin_auth, **{"from": since, "to": until})["items"]] == \
            ["DCZ1"]
        failed = self.search(client, admin_auth, status="failed")
        assert [i["error"] for i in failed["items"]] == ["Timeout"] and failed["pagination"]["total"] == 1
        assert {t["key"] for t in failed["types"]} >= {"invoice", "order_updates"}

    def test_recent_sends_are_newest_first_and_limited(self, client, admin_auth, rows):
        response = client.get("/api/admin/email/log", headers=admin_auth, params={"limit": 2})
        assert [r["reference"] for r in response.json()["data"]] == ["DCZ3", "DCZ2"]
        assert client.get("/api/admin/email/log", headers=admin_auth, params={"limit": 101}).status_code == 422


# ----------------------------------------------------------------- notify


def call_notify(db, **overrides):
    kwargs = {"to": "shopper@example.com", "customer_id": "CUS001", "subject": "Built-in subject",
              "html": "<p>Built-in</p>", "text": "Built-in", "reference": "DCZ77", "event": "order_shipped",
              "variables": {"order_number": "DCZ77"}}
    kwargs.update(overrides)
    return email_service.notify(db, overrides.pop("key", "order_updates"), **kwargs)


class TestNotifySafetyNets:
    def test_an_unreadable_template_still_sends_the_built_in_email(self, db, customer, email_account,
                                                                   monkeypatch):  # noqa: F811
        from app.services.messaging import service as messaging

        def broken(session, key):
            raise RuntimeError("templates table missing")

        monkeypatch.setattr(messaging, "effective", broken)
        assert call_notify(db) is True
        [job] = queued_jobs(db)
        assert job["subject"] == "Built-in subject" and job["template"] == "order_shipped"

    def test_a_customised_template_that_fails_to_render_falls_back(self, db, customer, email_account,
                                                                   monkeypatch):  # noqa: F811
        from app.services.messaging import service as messaging

        db.add(NotificationTemplate(key="order_shipped", enabled=True, email_subject="Custom {{order_number}}",
                                    email_body="Custom body", whatsapp_variables=[], updated_at=datetime.utcnow()))
        db.flush()

        def broken(*args, **kwargs):
            raise ValueError("renderer crashed")

        monkeypatch.setattr(messaging, "render_email", broken)
        assert call_notify(db) is True
        assert queued_jobs(db)[0]["subject"] == "Built-in subject"

    def test_a_customised_template_is_used_when_it_renders(self, db, customer, email_account):  # noqa: F811
        db.add(NotificationTemplate(key="order_shipped", enabled=True, email_subject="Custom {{order_number}}",
                                    email_body="Hi {{customer_name}}", whatsapp_variables=[],
                                    updated_at=datetime.utcnow()))
        db.flush()
        assert call_notify(db) is True
        job = queued_jobs(db)[0]
        assert job["subject"] == "Custom DCZ77" and "Hi Asha" in job["html"]

    def test_other_channels_or_the_bell_failing_never_stop_the_email(self, db, customer, email_account,
                                                                      monkeypatch):  # noqa: F811
        from app.services import inbox
        from app.services.messaging import service as messaging

        def broken(*args, **kwargs):
            raise RuntimeError("down")

        monkeypatch.setattr(messaging, "fan_out", broken)
        monkeypatch.setattr(inbox, "from_email", broken)
        assert call_notify(db) is True
        assert len(queued_jobs(db)) == 1
        assert db.query(CustomerNotification).count() == 0

    def test_the_same_message_goes_once(self, db, customer, email_account):  # noqa: F811
        assert call_notify(db, idempotency_key="ship:DCZ77") is True
        assert call_notify(db, idempotency_key="ship:DCZ77") is False
        assert len(queued_jobs(db)) == 1
        assert db.query(NotificationDelivery).filter_by(channel="email").count() == 1

    def test_a_failure_while_preparing_the_email_is_contained(self, db, customer, email_account,
                                                              monkeypatch):  # noqa: F811
        def broken(session):
            raise RuntimeError("accounts table locked")

        monkeypatch.setattr(email_service, "active_account", broken)
        assert call_notify(db, event=None) is False
        assert queued_jobs(db) == []

    def test_no_address_means_no_email_but_the_bell_still_rings(self, db, customer, email_account):  # noqa: F811
        assert call_notify(db, to="", event=None) is False
        assert queued_jobs(db) == []
        assert db.query(CustomerNotification).filter_by(customer_id="CUS001").count() == 1

    def test_an_order_stage_with_no_email_sends_nothing(self, db, customer, email_account):  # noqa: F811
        email_service.notify_order(db, types.SimpleNamespace(order_number="DCZ1"), "pending-payment")
        assert queued_jobs(db) == []


class TestTheSender:
    def test_send_now_reads_the_sender_from_a_job_dict(self, monkeypatch):
        captured = []
        monkeypatch.setattr(email_service, "deliver",
                            lambda provider, credentials, message: captured.append((provider, message)) or "<id-1>")
        job = {"sender_email": "shop@example.com", "sender_name": "DCZ", "reply_to": "help@example.com"}
        assert email_service._send_now("smtp", {}, job, "a@example.com", "Hi", "<p>Hi</p>", "Hi") == "<id-1>"
        provider, message = captured[0]
        assert provider == "smtp" and "shop@example.com" in message["From"] and message["Reply-To"] == "help@example.com"

    def _job(self, **extra):
        return {"provider": "smtp", "credentials": {}, "sender_email": "shop@example.com", "sender_name": "DCZ",
                "reply_to": "", "to": "a@example.com", "subject": "Hello", "html": "<p>x</p>", "text": "x",
                "key": "order_updates", "reference": "DCZ1", "template": "order_shipped", **extra}

    def test_a_job_for_a_vanished_delivery_is_still_logged(self, db, monkeypatch):
        from app.core import database as db_module

        monkeypatch.setattr(db_module, "SessionLocal", lambda: Shared(db))
        monkeypatch.setattr(email_service, "deliver", lambda *a: "<id-2>")
        email_service._worker([self._job(delivery_id=987654)])
        row = db.query(EmailLog).filter_by(delivery_id=987654).one()
        assert row.status == "sent" and row.provider_id == "<id-2>" and row.template_key == "order_shipped"

    def test_a_log_that_cannot_be_written_is_reported_not_raised(self, monkeypatch, caplog):
        from app.core import database as db_module

        def no_database():
            raise RuntimeError("database unreachable")

        monkeypatch.setattr(db_module, "SessionLocal", no_database)
        monkeypatch.setattr(email_service, "deliver", lambda *a: "<id-3>")
        email_service._worker([self._job()])
        assert "Could not log email order_updates" in caplog.text

    def test_a_failed_send_is_logged_with_the_reason(self, db, monkeypatch):
        from app.core import database as db_module

        monkeypatch.setattr(db_module, "SessionLocal", lambda: Shared(db))

        def refuse(*_):
            raise SendError("Connection refused")

        monkeypatch.setattr(email_service, "deliver", refuse)
        email_service._worker([self._job()])
        row = db.query(EmailLog).one()
        assert row.status == "failed" and row.error == "Connection refused" and row.provider_id is None

    def test_a_rollback_drops_the_queued_emails(self):
        session = types.SimpleNamespace(info={"outgoing_email": [{"to": "x"}]})
        email_service._drop_outgoing(session)
        assert session.info == {}


# ------------------------------------------------- the store's other emails


class TestStoreNotifications:
    @pytest.fixture()
    def order(self, client, auth, db, catalogue, settings_documents, email_account):  # noqa: F811
        fill_bag(client, auth, "PRD001")
        placed = place(client, auth, method="cod")["order"]
        email_account.run()
        email_account.sent.clear()
        return db.get(Order, placed["id"])

    def sent_after(self, db, email_account):  # noqa: F811
        db.commit()
        email_account.run()
        return email_account.sent

    def test_a_payment_receipt_carries_the_amount_once(self, db, order, email_account):  # noqa: F811
        from app.services.email.notifications import notify_payment

        notify_payment(db, order, 123456)
        notify_payment(db, order, 123456)  # a redelivered webhook
        [mail] = self.sent_after(db, email_account)
        assert mail["subject"] == f"Payment received \u2014 {order.order_number}"
        assert "\u20b91,234.56" in mail["html"] and "Cotton Kurta" in mail["html"]

    def test_a_failed_payment_links_back_to_the_payment(self, db, order, email_account):  # noqa: F811
        from app.services.email.notifications import notify_payment_failed

        notify_payment_failed(db, order, types.SimpleNamespace(id="PAY123"))
        [mail] = self.sent_after(db, email_account)
        assert "didn't go through" in mail["subject"] and "/checkout/payment?payment=PAY123" in mail["html"]

    def test_refunds_started_and_completed_are_separate_emails(self, db, order, email_account):  # noqa: F811
        from app.services.email.notifications import notify_refund

        refund = types.SimpleNamespace(amount=50000, order_number=order.order_number, customer_id="CUS001",
                                       refund_number="RF-1", status="initiated", id=1)
        notify_refund(db, refund, "shopper@example.com")
        refund.status = "completed"
        notify_refund(db, refund, "shopper@example.com")
        mails = self.sent_after(db, email_account)
        assert len(mails) == 2 and all("\u20b9500.00" in m["subject"] for m in mails)
        events = sorted(d.event for d in db.query(NotificationDelivery).filter_by(channel="email")
                        .filter(NotificationDelivery.event.like("refund_%")))
        assert events == ["refund_completed", "refund_initiated"]

    def test_a_return_update_escapes_the_teams_note(self, db, order, email_account):  # noqa: F811
        from app.services.email.notifications import notify_return

        request = types.SimpleNamespace(kind="replacement", status="approved", order_number=order.order_number,
                                        resolution_note="<b>Size swap</b>", customer_id="CUS001", id="RET001")
        notify_return(db, request, "shopper@example.com")
        [mail] = self.sent_after(db, email_account)
        assert mail["subject"].startswith("Update on your replacement")
        assert "&lt;b&gt;Size swap&lt;/b&gt;" in mail["html"] and "<b>Size swap</b>" not in mail["html"]
        assert db.query(NotificationDelivery).filter_by(event="replacement_initiated", channel="email").count() == 1

    def test_a_new_membership_names_the_programme_and_end_date(self, db, order, email_account):  # noqa: F811
        from app.services.email.notifications import notify_membership

        membership = types.SimpleNamespace(ends_at=datetime(2027, 10, 5), plan_name="Yearly", customer_id="CUS001",
                                           id="MEM001")
        notify_membership(db, membership, "shopper@example.com", "Choice Circle")
        [mail] = self.sent_after(db, email_account)
        assert mail["subject"] == "Welcome to Choice Circle" and "until 05 Oct 2027" in mail["html"]
        bell = db.query(CustomerNotification).filter_by(customer_id="CUS001", kind="membership").one()
        assert bell.href == "/account/membership"


# ----------------------------------------------------------------- bounces


class TestBounceChecker:
    def test_without_an_account_bounce_tracking_is_off_without_a_reason(self, db):
        from app.services.email import bounces

        assert bounces.sweep(db) == 0
        state = bounces.status(db)
        assert state["enabled"] is False and state["reason"] == "" and state["lastCheckedAt"]

    def test_an_smtp_account_cannot_be_checked(self, db, email_account):  # noqa: F811
        from app.services.email import bounces

        assert bounces.sweep(db) == 0
        assert bounces.status(db)["reason"] == "Bounces can only be read from a Gmail account."

    def test_a_gmail_account_that_cannot_sign_in_is_reported(self, db, monkeypatch):
        from app.services.email import bounces, senders

        now = datetime.utcnow()
        db.add(EmailAccount(provider="gmail-oauth", sender_email="shop@example.com", sender_name="DCZ", reply_to="",
                            credentials=crypto.seal({"refreshToken": "r"}), active=True, verified_at=now,
                            created_at=now, updated_at=now))
        db.flush()

        def refuse(credentials, force=False):
            raise SendError("Google refused the refresh token.")

        monkeypatch.setattr(senders, "gmail_access_token", refuse)
        assert bounces.sweep(db) == 0
        state = bounces.status(db)
        assert state["enabled"] is False and state["reason"] == "Google refused the refresh token."

    def test_a_gmail_outage_changes_nothing(self, db, mailbox):  # noqa: F811
        from app.services.email import bounces

        bounces.sweep(db)
        before = bounces.status(db)
        mailbox["list_status"] = 503
        row = log(db, "gone@gmail.com")
        mailbox["notices"] = {"n-1": (notice("gone@gmail.com"), datetime.utcnow())}
        assert bounces.sweep(db) == 0
        assert bounces.status(db) == before
        db.refresh(row)
        assert row.status == "sent"

    def test_a_notice_that_cannot_be_fetched_is_tried_again_next_time(self, db, mailbox, monkeypatch):  # noqa: F811
        from app.services.email import bounces

        row = log(db, "gone@gmail.com")
        mailbox["notices"] = {"n-1": (notice("gone@gmail.com"), datetime.utcnow())}
        working = bounces._get

        class Failing:
            status_code = 500

        monkeypatch.setattr(bounces, "_get", lambda token, url, **p: Failing() if p.get("format") == "raw"
                            else working(token, url, **p))
        assert bounces.sweep(db) == 0
        assert "n-1" not in bounces._state(db).get("seen", [])
        monkeypatch.setattr(bounces, "_get", working)
        assert bounces.sweep(db) == 1
        db.refresh(row)
        assert row.status == "failed"

    def test_an_email_whose_id_gmail_no_longer_knows_is_not_matched(self, db, mailbox):  # noqa: F811
        from app.services.email import bounces

        row = log(db, "gone@gmail.com", provider_id="g-unknown")
        mailbox["notices"] = {"n-1": (notice("gone@gmail.com"), datetime.utcnow())}
        assert bounces.sweep(db) == 0
        db.refresh(row)
        assert row.status == "sent"

    def test_gmail_is_asked_with_the_token_and_parameters(self, monkeypatch):
        from app.services.email import bounces

        calls = []
        monkeypatch.setattr(bounces.httpx, "get", lambda url, **kwargs: calls.append((url, kwargs)) or "response")
        assert bounces._get("tok", bounces.MESSAGES_URL, q="from:mailer-daemon") == "response"
        url, kwargs = calls[0]
        assert url == bounces.MESSAGES_URL and kwargs["headers"] == {"Authorization": "Bearer tok"}
        assert kwargs["params"] == {"q": "from:mailer-daemon"} and kwargs["timeout"] == 20

    def test_one_pass_contains_its_own_errors(self, db, monkeypatch, caplog):
        from app.core import database as db_module
        from app.services.email import bounces

        monkeypatch.setattr(db_module, "SessionLocal", lambda: Shared(db))

        def broken(session):
            raise RuntimeError("malformed notice")

        monkeypatch.setattr(bounces, "sweep", broken)
        rolled = []
        monkeypatch.setattr(db, "rollback", lambda: rolled.append(True))
        bounces._sweep_once()
        assert rolled == [True] and "Bounce check failed" in caplog.text

    def test_the_forever_loop_survives_a_failed_pass_and_stops_when_cancelled(self, monkeypatch, caplog):
        from app.services import jobs
        from app.services.email import bounces

        passes = []

        def failing_pass():
            passes.append(1)
            raise RuntimeError("bad pass")

        async def cancel(_seconds):
            raise asyncio.CancelledError

        monkeypatch.setattr(jobs, "tracked", lambda name, interval, fn: fn)
        monkeypatch.setattr(bounces, "_sweep_once", failing_pass)
        monkeypatch.setattr(asyncio, "sleep", cancel)
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(bounces.run_forever())
        assert passes == [1] and "Bounce check failed" in caplog.text


# ---------------------------------------------------------- support notify


class TestSupportNotifications:
    @pytest.fixture()
    def desk(self, db, admin, customer, email_account):  # noqa: F811
        now = datetime.utcnow()
        db.add_all([
            AdminUser(id="ADM060", email="ops@example.com", password_hash="x", name="Ops Admin", role="admin",
                      permissions=[], status="active", created_at=now),
            AdminUser(id="ADM061", email="lead@example.com", password_hash="x", name="Lead", role="staff",
                      permissions=[], status="active", created_at=now),
        ])
        db.flush()
        team = SupportTeam(name="Payments", notify_email="payments-inbox@example.com", created_at=now)
        db.add(team)
        db.flush()
        agents = {
            "lead": SupportAgent(name="Lead", email="lead@example.com", team_id=team.id, is_lead=True,
                                 admin_user_id="ADM061", created_at=now, updated_at=now),
            "quiet": SupportAgent(name="Quiet", email="quiet@example.com", team_id=team.id, notify_email=False,
                                  created_at=now, updated_at=now),
            "away": SupportAgent(name="Away", email="away@example.com", team_id=team.id, active=False,
                                 created_at=now, updated_at=now),
        }
        db.add_all(agents.values())
        db.add_all([
            SupportEmailTemplate(key="staff_alert", audience="internal", label="Alert",
                                 subject="{{ticket_number}}: {{subject}}", body="{{message}}\n\nDue {{response_due}}",
                                 enabled=True, updated_at=now),
            SupportEmailTemplate(key="ticket_created", audience="customer", label="Created",
                                 subject="We have {{ticket_number}}", body="Hi {{customer_name}}", enabled=True,
                                 updated_at=now),
            SupportEmailTemplate(key="switched_off", audience="internal", label="Off", subject="x", body="y",
                                 enabled=False, updated_at=now),
        ])
        ticket = SupportTicket(id="TKT001", number="DCZ-2026-000001", customer_id="CUS001", name="Asha Rao",
                               email="shopper@example.com", subject="Refund missing", description="Where is it?",
                               team_id=team.id, created_at=now, updated_at=now)
        db.add(ticket)
        db.flush()
        self.outbox = email_account
        return types.SimpleNamespace(team=team, agents=agents, ticket=ticket)

    def jobs(self, db):
        # Emails queued on the session, plus any already handed over by a commit along the way.
        return [job for batch in self.outbox.jobs for job in batch] + queued_jobs(db)

    def recipients(self, db):
        return sorted(job["to"] for job in self.jobs(db))

    def forget(self, db):
        db.info.pop("outgoing_email", None)
        self.outbox.jobs.clear()

    def trays(self, db):
        db.flush()
        return sorted(n.admin_id for n in db.query(Notification).filter_by(kind="support"))

    def test_with_nobody_assigned_the_team_and_its_inbox_hear(self, db, desk):
        from app.services.support import notify

        notify.staff(db, desk.ticket, "staff_alert", title="New request", message="Please look")
        assert self.recipients(db) == ["lead@example.com", "payments-inbox@example.com"]
        assert self.trays(db) == ["ADM061"]
        job = self.jobs(db)[0]
        assert job["subject"] == "DCZ-2026-000001: Refund missing" and "Due \u2014" in job["text"]

    def test_an_inactive_assigned_agent_falls_back_to_the_super_admins(self, db, desk):
        from app.services.support import notify

        desk.ticket.agent_id = desk.agents["away"].id
        desk.ticket.team_id = None
        db.flush()
        notify.staff(db, desk.ticket, "staff_alert", title="Assigned")
        assert self.recipients(db) == ["admin@dailychoicezone.com"] and self.trays(db) == ["ADM001"]

    def test_team_leads_or_else_super_admins(self, db, desk):
        from app.services.support import notify

        notify.staff(db, desk.ticket, "staff_alert", title="Escalated", audience="team-lead")
        assert self.recipients(db) == ["lead@example.com"]
        self.forget(db)
        desk.agents["lead"].is_lead = False
        db.flush()
        notify.staff(db, desk.ticket, "staff_alert", title="Escalated", audience="team-lead")
        assert self.recipients(db) == ["admin@dailychoicezone.com"]

    def test_admins_and_super_admins_audiences(self, db, desk):
        from app.services.support import notify

        notify.staff(db, desk.ticket, "staff_alert", title="Overdue", audience="admins")
        assert self.recipients(db) == ["admin@dailychoicezone.com", "ops@example.com"]
        self.forget(db)
        notify.staff(db, desk.ticket, "staff_alert", title="Overdue", audience="super-admins")
        assert self.recipients(db) == ["admin@dailychoicezone.com"]

    def test_the_person_who_acted_is_not_told_about_it(self, db, desk):
        from app.services.support import notify

        notify.staff(db, desk.ticket, "staff_alert", title="Reply", audience="admins", exclude_admin_id="ADM060")
        assert self.recipients(db) == ["admin@dailychoicezone.com"] and self.trays(db) == ["ADM001"]

    def test_the_store_mailbox_hears_when_no_staff_address_can(self, db, desk, monkeypatch):
        from app.services.email import senders
        from app.services.support import notify

        monkeypatch.setattr(senders, "undeliverable",
                            lambda address: "" if address == "shop@example.com" else "no mail server")
        notify.staff(db, desk.ticket, "staff_alert", title="New", audience="super-admins")
        assert self.recipients(db) == ["admin@dailychoicezone.com", "shop@example.com"]

    def test_a_switched_off_template_sends_no_email_but_still_fills_the_tray(self, db, desk):
        from app.services.support import notify

        notify.staff(db, desk.ticket, "switched_off", title="Quiet", audience="super-admins")
        assert self.recipients(db) == [] and self.trays(db) == ["ADM001"]

    def test_a_guest_is_emailed_but_has_no_account_bell(self, db, desk):
        from app.services.support import notify

        desk.ticket.customer_id = None
        db.flush()
        notify.customer(db, desk.ticket, "ticket_created", title="We have your request")
        [job] = self.jobs(db)
        assert job["to"] == "shopper@example.com" and job["subject"] == "We have DCZ-2026-000001"
        assert "/support/ticket?number=DCZ-2026-000001&amp;key=" in job["html"] or \
            "/support/ticket?number=DCZ-2026-000001&key=" in job["html"]
        db.flush()
        assert db.query(CustomerNotification).filter_by(kind="ticket_created").count() == 0

    def test_the_template_editor_previews_with_sample_values(self, client, admin_auth, db):
        response = client.post("/api/admin/support/config/templates/preview", headers=admin_auth,
                               json={"subject": "Re: {{ticket_number}} <{{priority}}>",
                                     "body": "Hi {{customer_name}}\n\nLine one\nLine two\n\n{{unknown_name}}"})
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["subject"] == "Re: DCZ-2026-000123 <High>"
        assert "Hi Asha Rao" in data["html"] and "Line one<br>Line two" in data["html"]
        assert "{{unknown_name}}" not in data["html"]
