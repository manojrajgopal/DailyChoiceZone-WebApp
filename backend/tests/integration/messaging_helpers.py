"""
Test doubles for the message channels: a provider that records what it is
asked to send (and can be told to fail), a connected email account whose
sends are recorded instead of going out, and email jobs run on demand rather
than on a background thread.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from app.services.messaging import providers


class RecordingProvider(providers.Provider):
    def __init__(self, channel: str, name: str = "test"):
        self.channel, self.name = channel, name
        self.sent = []
        self.fail_with = None  # a ProviderError to raise instead of sending
        self.counter = 0

    def configured(self) -> tuple:
        return True, ""

    def send(self, message):
        if self.fail_with is not None:
            raise self.fail_with
        self.counter += 1
        self.sent.append(message)
        return providers.SendResult(message_id=f"{self.channel}-msg-{self.counter}")


@pytest.fixture()
def sms_whatsapp(monkeypatch):
    """Both channels with a working (recording) provider."""
    sms, whatsapp = RecordingProvider("sms"), RecordingProvider("whatsapp")
    monkeypatch.setattr(providers, "sms", lambda: sms)
    monkeypatch.setattr(providers, "whatsapp", lambda: whatsapp)
    return sms, whatsapp


@pytest.fixture()
def email_account(db, monkeypatch):
    """A connected email account. Sends are recorded; the jobs run when `run()` is called."""
    from app.models import EmailAccount
    from app.services import email as email_service
    from app.services.email import crypto

    now = datetime.utcnow()
    db.add(EmailAccount(provider="smtp", sender_email="shop@example.com", sender_name="Daily Choice Zone",
                        reply_to="", credentials=crypto.seal({"host": "smtp.example.com", "port": 587}),
                        active=True, verified_at=now, created_at=now, updated_at=now))
    db.flush()

    class Outbox:
        def __init__(self):
            # `sent` is customer mail; the store team's alerts go to `staff`.
            self.sent, self.staff, self.jobs, self.fail_with = [], [], [], None

        def run(self):
            jobs, self.jobs = self.jobs, []
            for job_list in jobs:
                email_service._worker(job_list)

    outbox = Outbox()

    def fake_send(provider, credentials, account, to, subject, html, text):
        if outbox.fail_with is not None:
            raise outbox.fail_with
        box = outbox.staff if "Sent to the Daily Choice Zone store team" in (html or "") else outbox.sent
        box.append({"to": to, "subject": subject, "html": html, "text": text})
        return f"<msg-{len(outbox.sent) + len(outbox.staff)}@example.com>"

    class Deferred:
        def __init__(self, target, args=(), **_):
            self.args = args

        def start(self):
            outbox.jobs.append(self.args[0])

    class Shared:
        """The test session, for code that opens its own with a `with` block."""

        def __init__(self, session):
            self.session = session

        def __enter__(self):
            return self.session

        def __exit__(self, *exc):
            return False

        def __getattr__(self, name):
            return getattr(self.session, name)

    from app.core import database as db_module

    monkeypatch.setattr(email_service, "_send_now", fake_send)
    import types

    monkeypatch.setattr(email_service, "threading", types.SimpleNamespace(Thread=Deferred))
    monkeypatch.setattr(db_module, "SessionLocal", lambda: Shared(db))
    return outbox
