"""
Bounces: an email the provider accepted but couldn't deliver is marked failed,
with the receiving server's reason, instead of staying "Sent".
"""

from __future__ import annotations

import base64
import calendar
from datetime import datetime, timedelta

import pytest

from tests.integration.test_email import connect, outbox  # noqa: F401 — fixture

pytestmark = pytest.mark.integration

ORIGINAL_ID = "<CAF-original-123@mail.gmail.com>"


def notice(recipient: str, original_id: str = ORIGINAL_ID) -> bytes:
    """A delivery-status notice shaped like the ones Gmail sends."""
    return (
        "From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>\r\n"
        "Subject: Delivery Status Notification (Failure)\r\n"
        "MIME-Version: 1.0\r\n"
        'Content-Type: multipart/report; report-type=delivery-status; boundary="B"\r\n\r\n'
        "--B\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n"
        "** Address not found **\r\n\r\n"
        f"Your message wasn't delivered to {recipient} because the address couldn't be found, or is "
        "unable to receive mail.\r\n\r\nThe response was:\r\n\r\n550 5.1.1 The email account does not exist.\r\n"
        "--B\r\nContent-Type: message/delivery-status\r\n\r\n"
        f"Reporting-MTA: dns; googlemail.com\r\nX-Original-Message-ID: {original_id}\r\n\r\n"
        f"Final-Recipient: rfc822; {recipient}\r\nAction: failed\r\nStatus: 5.1.1\r\n"
        "Diagnostic-Code: smtp; 550 5.1.1 The email account does not exist.\r\n\r\n"
        "--B--\r\n"
    ).encode()


def test_a_notice_is_read_for_recipient_reason_and_original():
    from app.services.email import bounces

    found = bounces.parse(notice("gone@gmail.com"), datetime(2026, 9, 30, 9, 0))
    assert len(found) == 1
    assert found[0].recipient == "gone@gmail.com"
    assert found[0].original_message_id == ORIGINAL_ID
    assert found[0].reason.startswith("Address not found: Your message wasn't delivered to gone@gmail.com")
    assert found[0].reason.endswith("(status 5.1.1)")


@pytest.fixture()
def mailbox(monkeypatch, client, admin_auth, outbox):  # noqa: F811
    """A connected Gmail account whose mailbox holds whatever the test puts in it."""
    from app.services.email import bounces, senders

    connect(client, admin_auth)
    monkeypatch.setattr(senders, "gmail_access_token", lambda credentials, force=False: "token")
    box = {"notices": {}, "sent_ids": {}, "list_status": 200}

    class Response:
        def __init__(self, status_code, body):
            self.status_code, self._body = status_code, body

        def json(self):
            return self._body

    def fake_get(token, url, **params):
        if url == bounces.MESSAGES_URL:
            if box["list_status"] != 200:
                return Response(box["list_status"], {})
            return Response(200, {"messages": [{"id": key} for key in box["notices"]]})
        gmail_id = url.rsplit("/", 1)[-1]
        if params.get("format") == "raw":
            raw, arrived = box["notices"][gmail_id]
            return Response(200, {"raw": base64.urlsafe_b64encode(raw).decode(),
                                  # UTC epoch: `.timestamp()` would read the naive time as local.
                                  "internalDate": str(calendar.timegm(arrived.utctimetuple()) * 1000)})
        if gmail_id in box["sent_ids"]:
            return Response(200, {"payload": {"headers": [{"name": "Message-ID", "value": box["sent_ids"][gmail_id]}]}})
        return Response(404, {})

    monkeypatch.setattr(bounces, "_get", fake_get)
    return box


def log(db, recipient, *, provider_id=None, minutes_ago=30, status="sent"):
    from app.models import EmailLog

    row = EmailLog(email_type="order_confirmation", recipient=recipient, subject="Your order", status=status,
                   error="", reference="DCZ10001", created_at=datetime.utcnow() - timedelta(minutes=minutes_ago),
                   provider_id=provider_id)
    db.add(row)
    db.flush()
    return row


class TestTheSweep:
    def test_the_bounced_email_is_marked_failed_with_the_reason(self, db, mailbox):
        from app.services.email import bounces

        bounced = log(db, "gone@gmail.com", provider_id="g-1")
        # Another email to the same person that Gmail did deliver.
        delivered = log(db, "gone@gmail.com", provider_id="g-2", minutes_ago=10)
        mailbox["sent_ids"] = {"g-1": ORIGINAL_ID, "g-2": "<other@mail.gmail.com>"}
        mailbox["notices"] = {"n-1": (notice("gone@gmail.com"), datetime.utcnow())}

        assert bounces.sweep(db) == 1
        db.refresh(bounced)
        db.refresh(delivered)
        assert bounced.status == "failed" and bounced.error.startswith("Bounced: Address not found")
        assert bounced.bounced_at is not None
        assert delivered.status == "sent"
        # Nothing is counted twice on the next pass.
        assert bounces.sweep(db) == 0
        assert bounces.status(db)["enabled"] and bounces.status(db)["bouncesFound"] == 1

    def test_older_rows_without_an_id_match_on_recipient_and_time(self, db, mailbox):
        from app.services.email import bounces

        row = log(db, "gone@gmail.com")
        mailbox["notices"] = {"n-1": (notice("gone@gmail.com"), datetime.utcnow())}
        assert bounces.sweep(db) == 1
        db.refresh(row)
        assert row.status == "failed"

    def test_a_notice_for_someone_else_changes_nothing(self, db, mailbox):
        from app.services.email import bounces

        row = log(db, "fine@gmail.com", provider_id="g-1")
        mailbox["notices"] = {"n-1": (notice("gone@gmail.com"), datetime.utcnow())}
        assert bounces.sweep(db) == 0
        db.refresh(row)
        assert row.status == "sent"

    def test_send_only_access_is_reported_not_crashed(self, db, mailbox, client, admin_auth):
        from app.services.email import bounces

        mailbox["list_status"] = 403
        assert bounces.sweep(db) == 0
        state = bounces.status(db)
        assert not state["enabled"] and "can't be detected" in state["reason"]
        account = client.get("/api/admin/email", headers=admin_auth).json()["data"]["account"]
        assert account["bounceTracking"]["enabled"] is False

    def test_the_history_shows_the_failure(self, db, mailbox, client, admin_auth):
        from app.services.email import bounces

        log(db, "gone@gmail.com", provider_id="g-1")
        mailbox["sent_ids"] = {"g-1": ORIGINAL_ID}
        mailbox["notices"] = {"n-1": (notice("gone@gmail.com"), datetime.utcnow())}
        bounces.sweep(db)
        failed = client.get("/api/admin/email/log/search?status=failed", headers=admin_auth).json()["data"]
        assert [row["recipient"] for row in failed["items"]] == ["gone@gmail.com"]
        assert "Address not found" in failed["items"][0]["error"]
