"""
Email: saving an account only after a test arrives, the store's and the
customer's choices, and mail leaving only after the work that caused it.
"""

from __future__ import annotations

import pytest

from tests.integration.test_orders import add, place
from tests.integration.test_payment_security import gateway  # noqa: F401 — fixture

pytestmark = pytest.mark.integration

GMAIL = {
    "provider": "gmail-oauth", "senderEmail": "orders@example.test", "senderName": "Daily Choice Zone",
    "clientId": "client-123.apps.googleusercontent.com", "clientSecret": "GOCSPX-secretvalue",
    "refreshToken": "1//refresh-token-value", "testRecipient": "owner@example.test",
}


@pytest.fixture()
def outbox(monkeypatch):
    """Every message that would have left, instead of leaving."""
    from app.services import email as email_service
    from app.services.email import senders

    sent = []

    def fake_deliver(provider, credentials, message):
        sent.append({"to": message["To"], "subject": message["Subject"], "provider": provider,
                     "credentials": credentials})
        return "id"

    monkeypatch.setattr(senders, "deliver", fake_deliver)
    monkeypatch.setattr(email_service, "deliver", fake_deliver)
    # Background jobs run inline and are recorded, not written to a database.
    monkeypatch.setattr(email_service, "_worker", lambda jobs: [
        fake_deliver(job["provider"], job["credentials"], email_service.build_message(
            sender_email=job["sender_email"], sender_name=job["sender_name"], reply_to=job["reply_to"],
            to=job["to"], subject=job["subject"], html=job["html"], text=job["text"])) for job in jobs
    ])

    class Thread:
        def __init__(self, target, args, **_):
            self.target, self.args = target, args

        def start(self):
            email_service._worker(*self.args)

    monkeypatch.setattr(email_service.threading, "Thread", Thread)
    return sent


def connect(client, admin_auth, **overrides):
    return client.post("/api/admin/email/account", headers=admin_auth, json={**GMAIL, **overrides})


class TestTheAccount:
    def test_it_is_saved_only_after_a_test_email_is_sent(self, client, admin_auth, outbox):
        response = connect(client, admin_auth)
        assert response.status_code == 200, response.text
        assert outbox[0]["to"] == "owner@example.test"
        account = client.get("/api/admin/email", headers=admin_auth).json()["data"]["account"]
        assert account["configured"] and account["senderEmail"] == "orders@example.test"

    def test_a_failed_test_saves_nothing(self, client, admin_auth, monkeypatch):
        from app.services import email as email_service
        from app.services.email.senders import SendError

        def refuse(*_):
            raise SendError("Google didn't accept the client ID or client secret.")

        monkeypatch.setattr(email_service, "deliver", refuse)
        response = connect(client, admin_auth)
        assert response.status_code == 422
        assert "nothing was saved" in response.json()["message"]
        assert client.get("/api/admin/email", headers=admin_auth).json()["data"]["account"]["configured"] is False

    def test_secrets_never_come_back(self, client, admin_auth, outbox):
        connect(client, admin_auth)
        body = client.get("/api/admin/email", headers=admin_auth).text
        assert "GOCSPX-secretvalue" not in body and "1//refresh-token-value" not in body
        fields = client.get("/api/admin/email", headers=admin_auth).json()["data"]["account"]["fields"]
        assert fields["clientSecret"].endswith("alue") and fields["clientSecret"].startswith("•")

    def test_secrets_are_encrypted_at_rest(self, client, admin_auth, outbox, db):
        from app.models import EmailAccount

        connect(client, admin_auth)
        stored = db.query(EmailAccount).filter(EmailAccount.active.is_(True)).one().credentials
        assert "GOCSPX" not in stored and "refresh-token" not in stored

    def test_blank_secrets_keep_the_saved_ones(self, client, admin_auth, outbox):
        connect(client, admin_auth)
        outbox.clear()
        response = connect(client, admin_auth, clientSecret="", refreshToken="", senderName="DCZ Orders")
        assert response.status_code == 200
        assert outbox[0]["credentials"]["clientSecret"] == "GOCSPX-secretvalue"

    def test_the_redirect_address_is_worked_out_not_typed(self, client, admin_auth):
        account = client.get("/api/admin/email", headers=admin_auth).json()["data"]["account"]
        assert account["redirectUri"].endswith("/auth/callback")

    def test_connect_with_google_builds_a_consent_link(self, client, admin_auth):
        response = client.post("/api/admin/email/google/start", headers=admin_auth, json={
            "clientId": "client-123", "clientSecret": "secret", "senderEmail": "orders@example.test",
        })
        url = response.json()["data"]["authorizationUrl"]
        assert url.startswith("https://accounts.google.com/") and "gmail.send" in url and "state=" in url

    def test_only_staff_with_settings_access(self, client, auth):
        assert client.get("/api/admin/email", headers=auth).status_code in (401, 403)


class TestWhoGetsWhat:
    def test_order_emails_leave_after_the_order_is_saved(
        self, client, auth, admin_auth, outbox, catalogue, settings_documents
    ):
        connect(client, admin_auth)
        outbox.clear()
        add(client, auth, "PRD001", 1)
        assert place(client, auth).status_code == 201  # cash on delivery: confirmed at once
        assert any("confirmed" in m["subject"].lower() for m in outbox)

    def test_a_type_the_store_switched_off_is_not_sent_or_offered(
        self, client, auth, admin_auth, outbox, catalogue, settings_documents
    ):
        connect(client, admin_auth)
        types = client.get("/api/admin/email", headers=admin_auth).json()["data"]["types"]
        for row in types:
            if row["key"] == "order_confirmation":
                row["enabled"] = False
        client.put("/api/admin/email/types", headers=admin_auth, json=types)
        outbox.clear()
        add(client, auth, "PRD001", 1)
        place(client, auth)
        assert not outbox
        offered = [p["key"] for p in client.get("/api/account/email-preferences", headers=auth).json()["data"]]
        assert "order_confirmation" not in offered

    def test_customers_turn_off_only_what_they_may(
        self, client, auth, admin_auth, outbox, catalogue, settings_documents
    ):
        connect(client, admin_auth)
        prefs = {p["key"]: p for p in client.get("/api/account/email-preferences", headers=auth).json()["data"]}
        assert prefs["order_cancelled"]["locked"] is True
        assert prefs["order_updates"]["locked"] is False

        client.put("/api/account/email-preferences", headers=auth,
                   json={"order_updates": False, "order_cancelled": False})
        prefs = {p["key"]: p for p in client.get("/api/account/email-preferences", headers=auth).json()["data"]}
        assert prefs["order_updates"]["enabled"] is False
        assert prefs["order_cancelled"]["enabled"] is True  # locked: still on

        add(client, auth, "PRD001", 1)
        order = place(client, auth).json()["data"]["order"]
        outbox.clear()
        client.put(f"/api/admin/orders/{order['id']}/status", headers=admin_auth,
                   json={"status": "processing"})
        client.put(f"/api/admin/orders/{order['id']}/status", headers=admin_auth,
                   json={"status": "packed"})
        client.put(f"/api/admin/orders/{order['id']}/status", headers=admin_auth,
                   json={"status": "shipped"})
        assert not outbox  # they turned shipping updates off

    def test_nothing_is_sent_without_an_account(self, client, auth, outbox, catalogue, settings_documents):
        add(client, auth, "PRD001", 1)
        place(client, auth)
        assert not outbox

    def test_sending_an_invoice(self, client, auth, admin_auth, outbox, catalogue, settings_documents):
        connect(client, admin_auth)
        add(client, auth, "PRD001", 1)
        invoice_id = place(client, auth).json()["data"]["invoiceId"]
        outbox.clear()
        response = client.post(f"/api/admin/billing/invoices/{invoice_id}/send", headers=admin_auth)
        assert response.status_code == 200, response.text
        assert outbox and "invoice" in outbox[0]["subject"].lower()


class TestEveryStepSendsSomething:
    """Each thing that happens to a shopper's order reaches their inbox."""

    def test_every_stage_after_confirmation(
        self, client, auth, admin_auth, outbox, catalogue, settings_documents
    ):
        connect(client, admin_auth)
        add(client, auth, "PRD001", 1)
        order = place(client, auth).json()["data"]["order"]
        stages = ["processing", "packed", "shipped", "in-transit", "out-for-delivery", "delivered"]
        for stage in stages:
            outbox.clear()
            response = client.put(f"/api/admin/orders/{order['id']}/status", headers=admin_auth,
                                  json={"status": stage})
            assert response.status_code == 200, response.text
            assert len(outbox) == 1, f"no email for {stage}"
            assert order["orderNumber"] in outbox[0]["subject"]

    def test_asking_for_a_return(self, client, auth, admin_auth, outbox, catalogue, settings_documents):
        from tests.integration.test_returns import ask

        connect(client, admin_auth)
        add(client, auth, "PRD001", 1)
        order = place(client, auth).json()["data"]["order"]
        client.put(f"/api/admin/orders/{order['id']}/status", headers=admin_auth,
                   json={"status": "delivered", "confirm": True})
        outbox.clear()
        assert ask(client, auth, order).status_code == 201
        assert len(outbox) == 1 and "return" in outbox[0]["subject"].lower()

    def test_a_payment_that_ran_out_of_time(
        self, client, auth, admin_auth, outbox, gateway, catalogue, settings_documents, db
    ):
        from app.services.payment_expiry import sweep
        from tests.integration.test_payment_security import lapse, place as place_prepaid

        connect(client, admin_auth)
        placed = place_prepaid(client, auth).json()["data"]
        assert not outbox[1:], "an unpaid order is not confirmed"
        outbox.clear()
        lapse(db, placed["order"]["id"])
        assert sweep(db) == 1
        assert len(outbox) == 1 and "cancelled" in outbox[0]["subject"].lower()

    def test_a_declined_payment_once_not_per_retry(
        self, client, auth, admin_auth, outbox, gateway, catalogue, settings_documents
    ):
        from tests.integration.test_payment_security import place as place_prepaid, webhook

        connect(client, admin_auth)
        placed = place_prepaid(client, auth).json()["data"]
        outbox.clear()
        for attempt in (1, 2):
            response = webhook(client, {"event": "payment.failed", "payload": {"payment": {"entity": {
                "id": f"pay_declined{attempt}", "order_id": placed["gateway"]["orderReference"],
                "status": "failed", "amount": placed["amount"], "method": "card",
                "error_description": "Insufficient funds.",
            }}}}, event_id=f"evt_declined{attempt}")
            assert response.status_code == 200, response.text
        assert len(outbox) == 1 and "didn't go through" in outbox[0]["subject"]
