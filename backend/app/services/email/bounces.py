"""
Bounces: finding out that an email the provider accepted was never delivered.

Gmail accepts a message for almost any address and reports a failure
afterwards, as a "Delivery Status Notification (Failure)" in the sending
mailbox. Until now the log said "Sent" for those forever. This reads the
notices back, matches each to the email it reports on, and marks that email
**failed** with the reason the receiving server gave — "Address not found",
"Mailbox full", and so on.

## Matching

Gmail replaces the Message-ID we set with its own, so the notice is matched on
Gmail's: each send records the id Gmail returned (`provider_id`), and the
notice names the original's Message-ID (`X-Original-Message-ID`), which is
read from that sent message. Rows logged before ids were kept fall back to the
failed recipient and the time.

## What it needs

Reading notices needs mailbox read access on the connected Google account
(`gmail.readonly`, or full `mail.google.com`). An account connected with
send-only access still sends; its bounce tracking reports that it's off and
why. SMTP accounts have no API to read bounces from and are not checked.

Runs every few minutes from the app's lifespan; every step is idempotent, so a
restart or an overlapping pass re-reads nothing twice.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import re
from datetime import datetime, timedelta, timezone
from email import message_from_bytes, policy
from typing import List, Optional

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import EmailLog, SettingDocument

logger = logging.getLogger(__name__)

MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages"
INTERVAL_SECONDS = 300
STATE_KEY = "email_bounces"
# A notice is matched to an email sent at most this long before it arrived.
MATCH_WINDOW = timedelta(days=4)


# ------------------------------------------------------------------ parsing


class Bounce:
    def __init__(self, recipient: str, reason: str, original_message_id: str, arrived_at: datetime):
        self.recipient = recipient
        self.reason = reason
        self.original_message_id = original_message_id
        self.arrived_at = arrived_at


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def parse(raw: bytes, arrived_at: datetime) -> List[Bounce]:
    """Every failed recipient in one delivery-status notice, with its reason."""
    message = message_from_bytes(raw, policy=policy.default)
    original_id = ""
    failures: List[dict] = []
    summary = ""

    for part in message.walk():
        kind = part.get_content_type()
        if kind == "message/delivery-status":
            for block in part.get_payload():
                fields = dict(block.items())
                original_id = original_id or fields.get("X-Original-Message-ID", "")
                if (fields.get("Action") or "").lower() == "failed" and fields.get("Final-Recipient"):
                    failures.append(fields)
        elif kind == "text/plain" and not summary:
            text = part.get_content() or ""
            if "wasn't delivered" in text or "could not be delivered" in text.lower():
                summary = text
        elif kind in ("text/rfc822-headers", "message/rfc822") and not original_id:
            match = re.search(r"^Message-ID:\s*(<[^>]+>)", str(part.get_payload(decode=False)), re.I | re.M)
            if match:
                original_id = match.group(1)

    heading = ""
    sentence = ""
    if summary:
        found = re.search(r"\*\*\s*(.+?)\s*\*\*", summary)
        heading = found.group(1).strip() if found else ""
        found = re.search(r"(Your message (?:wasn't|was not) delivered.+?\.)(?:\s|$)", summary, re.S)
        sentence = _clean(found.group(1)) if found else ""

    out = []
    for fields in failures:
        recipient = fields["Final-Recipient"].split(";", 1)[-1].strip().lower()
        status = fields.get("Status", "")
        diagnostic = _clean(fields.get("Diagnostic-Code", "").split(";", 1)[-1])
        if sentence:
            reason = f"{heading + ': ' if heading else ''}{sentence}"
        else:
            reason = diagnostic or "The receiving mail server rejected this email."
        if status:
            reason += f" (status {status})"
        out.append(Bounce(recipient, reason[:500], original_id.strip(), arrived_at))
    return out


# ------------------------------------------------------------------- Gmail


def _get(token: str, url: str, **params) -> httpx.Response:
    return httpx.get(url, headers={"Authorization": f"Bearer {token}"}, params=params, timeout=20)


def _message_id_of(token: str, gmail_id: str) -> str:
    """The Message-ID Gmail gave a message we sent."""
    response = _get(token, f"{MESSAGES_URL}/{gmail_id}", format="metadata", metadataHeaders="Message-ID")
    if response.status_code != 200:
        return ""
    headers = (response.json().get("payload") or {}).get("headers") or []
    return next((h["value"] for h in headers if h.get("name", "").lower() == "message-id"), "")


# -------------------------------------------------------------------- state


def _state(db: Session) -> dict:
    row = db.get(SettingDocument, STATE_KEY)
    return dict(row.value or {}) if row else {}


def _save_state(db: Session, **values) -> None:
    now = datetime.utcnow()
    row = db.get(SettingDocument, STATE_KEY)
    if row is None:
        db.add(SettingDocument(key=STATE_KEY, value=values, created_at=now, updated_at=now))
    else:
        row.value = {**(row.value or {}), **values}
        row.updated_at = now


def status(db: Session) -> dict:
    """What the portal shows about bounce tracking."""
    state = _state(db)
    return {
        "enabled": bool(state.get("enabled")),
        "reason": state.get("reason", ""),
        "lastCheckedAt": state.get("lastCheckedAt"),
        "bouncesFound": int(state.get("bouncesFound") or 0),
    }


# -------------------------------------------------------------------- sweep


def _match(db: Session, bounce: Bounce, token: str) -> Optional[EmailLog]:
    candidates = db.execute(
        select(EmailLog).where(
            EmailLog.recipient == bounce.recipient,
            EmailLog.status == "sent",
            EmailLog.created_at <= bounce.arrived_at + timedelta(minutes=5),
            EmailLog.created_at >= bounce.arrived_at - MATCH_WINDOW,
        ).order_by(EmailLog.created_at.desc())
    ).scalars().all()
    if not candidates:
        return None
    if bounce.original_message_id:
        for row in candidates:
            if row.provider_id and _message_id_of(token, row.provider_id) == bounce.original_message_id:
                return row
    # Rows sent before ids were kept: the latest email to that address before
    # the notice. Never a row that has an id — that one was checked above.
    return next((row for row in candidates if not row.provider_id), None)


def sweep(db: Session) -> int:
    """One pass over new bounce notices. Returns how many emails it marked failed."""
    from app.services import email as email_service
    from app.services.email import crypto, senders

    now = datetime.utcnow()
    account = email_service.active_account(db)
    if account is None or account.provider != "gmail-oauth":
        _save_state(db, enabled=False, lastCheckedAt=now.isoformat(),
                    reason="" if account is None else "Bounces can only be read from a Gmail account.")
        db.commit()
        return 0

    try:
        token = senders.gmail_access_token(crypto.unseal(account.credentials))
    except senders.SendError as error:
        _save_state(db, enabled=False, reason=str(error), lastCheckedAt=now.isoformat())
        db.commit()
        return 0

    state = _state(db)
    # First run: look back a week, so recent failures are caught too.
    since = int(state.get("sinceEpoch") or (datetime.now(timezone.utc) - timedelta(days=7)).timestamp())
    listing = _get(token, MESSAGES_URL, q=f"from:mailer-daemon after:{since}", maxResults=50)
    if listing.status_code == 403:
        _save_state(db, enabled=False, lastCheckedAt=now.isoformat(),
                    reason="The connected Google account can send but not read its mailbox, so bounced emails "
                           "can't be detected. Reconnect it to allow reading.")
        db.commit()
        return 0
    if listing.status_code != 200:
        logger.warning("Bounce check: Gmail answered %s", listing.status_code)
        return 0

    seen = set(state.get("seen") or [])
    marked = 0
    newest = since
    for item in listing.json().get("messages") or []:
        if item["id"] in seen:
            continue
        response = _get(token, f"{MESSAGES_URL}/{item['id']}", format="raw")
        if response.status_code != 200:
            continue
        body = response.json()
        epoch = int(body.get("internalDate", 0)) // 1000
        arrived = datetime.utcfromtimestamp(epoch)
        # From Gmail's own epoch: `arrived.timestamp()` would read the naive
        # UTC value as local time and land hours off.
        newest = max(newest, epoch)
        for bounce in parse(base64.urlsafe_b64decode(body["raw"]), arrived):
            row = _match(db, bounce, token)
            if row is not None:
                row.status = "failed"
                row.error = f"Bounced: {bounce.reason}"[:500]
                row.bounced_at = bounce.arrived_at
                marked += 1
        seen.add(item["id"])

    # Gmail's `after:` is to the second; keep the last few ids to skip repeats.
    _save_state(db, enabled=True, reason="", lastCheckedAt=now.isoformat(), sinceEpoch=newest,
                seen=sorted(seen)[-200:], bouncesFound=int(state.get("bouncesFound") or 0) + marked)
    db.commit()
    if marked:
        logger.info("Marked %s bounced email(s) as failed.", marked)
    return marked


def _sweep_once() -> None:
    from app.core.database import SessionLocal

    with SessionLocal() as db:
        try:
            sweep(db)
        except Exception:  # noqa: BLE001 — a bad notice must not stop the loop
            db.rollback()
            logger.exception("Bounce check failed; retrying next interval.")


async def run_forever() -> None:
    logger.info("Email bounce check running every %ss.", INTERVAL_SECONDS)
    while True:
        try:
            await asyncio.to_thread(_sweep_once)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Bounce check failed; retrying next interval.")
        await asyncio.sleep(INTERVAL_SECONDS)

