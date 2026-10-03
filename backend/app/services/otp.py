"""
One-time codes, by SMS or email.

## A code

Six digits (`OTP_LENGTH`) from `secrets`, valid `OTP_EXPIRY_SECONDS` (five
minutes), at most `OTP_MAX_ATTEMPTS` (five) guesses, used once. Only
`HMAC-SHA256(server key, challenge id + code)` is stored: a database dump
can't be turned into working codes, and a code for one challenge doesn't hash
the same for another. Checked in constant time.

The destination is stored three ways: an HMAC (to count requests per number
or address without keeping it readable), masked (`+91•••••43210`, to show)
and sealed (encrypted, to act on once the code proves ownership).

Asking for a new code supersedes the earlier ones for the same destination
and purpose, so only the newest works.

## Limits

Counted in the database (so they hold across server processes):

- per destination: `OTP_PER_DESTINATION_HOURLY` an hour, `OTP_PER_DESTINATION_DAILY` a day;
- per caller address: `OTP_PER_IP_HOURLY` an hour;
- per signed-in account: `OTP_PER_ACCOUNT_HOURLY` an hour;
- a resend waits `OTP_RESEND_SECONDS`.

## What the API gives away

Nothing about accounts. Asking for a sign-in code answers the same way and
sends the same code whether or not the number or address has an account —
the code is how a new customer signs up, too. Limits are the same for both.
"""

from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import AppError, RateLimitedError, ValidationError
from app.models import Customer, OtpChallenge
from app.services.identity import crypto
from app.services.messaging.providers import ProviderError

logger = logging.getLogger(__name__)

PURPOSES = {"login", "login-email", "verify-phone", "change-phone", "verify-email", "sensitive-action"}
CHANNELS = {"sms", "email"}

TOO_MANY = "Too many codes have been requested. Please wait a while and try again."


class OtpError(ValidationError):
    """A code that can't be used. `error_code` says why."""


class OtpSendFailed(AppError):
    status_code = 503
    error_code = "OTP_SEND_FAILED"


# ----------------------------------------------------------------- helpers


def _now() -> datetime:
    return datetime.utcnow().replace(microsecond=0)


def length() -> int:
    return min(8, max(4, int(settings.OTP_LENGTH or 6)))


def normalise(channel: str, raw: str) -> str:
    """The destination as stored: +91XXXXXXXXXX for a phone, lower-case for an email."""
    if channel == "sms":
        from app.services.messaging.service import normalise_phone

        number = normalise_phone(raw)
        if not number:
            raise ValidationError("Enter a valid mobile number, e.g. 98765 43210.", error_code="PHONE_INVALID")
        return number
    if channel == "email":
        from email_validator import EmailNotValidError, validate_email

        try:
            return validate_email((raw or "").strip(), check_deliverability=False).normalized.lower()
        except EmailNotValidError:
            raise ValidationError("Enter a valid email address.", error_code="EMAIL_INVALID") from None
    raise ValidationError("Choose SMS or email.", error_code="OTP_CHANNEL_INVALID")


def destination_hash(channel: str, destination: str) -> str:
    return crypto.keyed_hash("otp-destination", f"{channel}:{destination}")


def _code_hash(challenge_id: str, code: str) -> str:
    return crypto.keyed_hash("otp-code", f"{challenge_id}:{code}")


def mask(destination: str) -> str:
    from app.services.messaging.service import mask as mask_recipient

    return mask_recipient(destination)[:80]


def _count(db: Session, *conditions) -> int:
    return int(db.execute(select(func.count()).select_from(OtpChallenge).where(*conditions)).scalar_one())


def _check_limits(db: Session, dest_hash: str, purpose: str, ip_hash: str, customer: Optional[Customer],
                  now: datetime) -> None:
    hour, day = now - timedelta(hours=1), now - timedelta(days=1)
    if _count(db, OtpChallenge.destination_hash == dest_hash, OtpChallenge.created_at > hour) \
            >= settings.OTP_PER_DESTINATION_HOURLY:
        raise RateLimitedError(TOO_MANY, error_code="OTP_TOO_MANY")
    if _count(db, OtpChallenge.destination_hash == dest_hash, OtpChallenge.created_at > day) \
            >= settings.OTP_PER_DESTINATION_DAILY:
        raise RateLimitedError(TOO_MANY, error_code="OTP_TOO_MANY")
    if ip_hash and _count(db, OtpChallenge.ip_hash == ip_hash, OtpChallenge.created_at > hour) \
            >= settings.OTP_PER_IP_HOURLY:
        raise RateLimitedError(TOO_MANY, error_code="OTP_TOO_MANY")
    if customer is not None and _count(db, OtpChallenge.customer_id == customer.id, OtpChallenge.created_at > hour) \
            >= settings.OTP_PER_ACCOUNT_HOURLY:
        raise RateLimitedError(TOO_MANY, error_code="OTP_TOO_MANY")
    latest = db.execute(
        select(OtpChallenge).where(OtpChallenge.destination_hash == dest_hash, OtpChallenge.purpose == purpose,
                                   OtpChallenge.status != "failed")
        .order_by(OtpChallenge.created_at.desc()).limit(1)
    ).scalar_one_or_none()
    if latest is not None and latest.resend_available_at > now:
        wait = int((latest.resend_available_at - now).total_seconds())
        raise RateLimitedError(f"Please wait {wait} seconds before asking for another code.",
                               error_code="OTP_RESEND_WAIT", details={"retryAfter": wait})


# ----------------------------------------------------------------- request


def request(db: Session, *, channel: str, destination: str, purpose: str, ip: str = "",
            customer: Optional[Customer] = None) -> dict:
    """
    Create a challenge and send its code. Commits. Returns what the client
    may know: the challenge id, the masked destination and the timings.
    """
    if purpose not in PURPOSES:
        raise ValidationError("That isn't something a code can be used for.", error_code="OTP_PURPOSE_INVALID")
    if channel not in CHANNELS:
        raise ValidationError("Choose SMS or email.", error_code="OTP_CHANNEL_INVALID")
    address = normalise(channel, destination)
    dest_hash = destination_hash(channel, address)
    ip_key = crypto.ip_hash(ip)
    now = _now()
    _check_limits(db, dest_hash, purpose, ip_key, customer, now)

    # Only the newest code for this destination and purpose works.
    db.execute(update(OtpChallenge)
               .where(OtpChallenge.destination_hash == dest_hash, OtpChallenge.purpose == purpose,
                      OtpChallenge.status == "pending")
               .values(status="superseded"))
    digits = length()
    code = f"{secrets.randbelow(10 ** digits):0{digits}d}"
    challenge_id = secrets.token_urlsafe(18)[:24]
    expiry = max(60, int(settings.OTP_EXPIRY_SECONDS or 300))
    row = OtpChallenge(
        id=challenge_id, purpose=purpose, channel=channel, destination_hash=dest_hash,
        destination_masked=mask(address), destination_sealed=crypto.seal({"d": address}),
        customer_id=customer.id if customer is not None else None, code_hash=_code_hash(challenge_id, code),
        status="pending", attempts=0, max_attempts=max(1, int(settings.OTP_MAX_ATTEMPTS or 5)), ip_hash=ip_key,
        created_at=now, expires_at=now + timedelta(seconds=expiry),
        resend_available_at=now + timedelta(seconds=max(0, int(settings.OTP_RESEND_SECONDS or 0))),
    )
    db.add(row)
    db.flush()

    from app.services import otp_providers

    minutes = max(1, expiry // 60)
    try:
        if channel == "sms":
            row.provider = otp_providers.send_sms(address, code, purpose, minutes)
        else:
            row.provider = otp_providers.send_email(db, address, code, purpose, minutes)
    except ProviderError as error:
        # Never the code, never the full destination in the log.
        logger.warning("One-time code to %s couldn't be sent: %s", row.destination_masked, error)
        row.status = "failed"
        row.resend_available_at = now
        db.commit()
        raise OtpSendFailed("We couldn't send the code just now. Please try again in a moment.") from None
    db.commit()
    return {
        "challengeId": row.id,
        "channel": channel,
        "destination": row.destination_masked,
        "expiresIn": expiry,
        "resendIn": int((row.resend_available_at - now).total_seconds()),
        "length": digits,
    }


# ------------------------------------------------------------------ verify


def verify(db: Session, challenge_id: str, code: str, *, purposes: set,
           customer: Optional[Customer] = None) -> tuple:
    """
    Check a code. Returns (challenge, destination) and marks it used — the
    caller acts on it and commits. A wrong code counts an attempt (committed
    at once) and says how many are left.
    """
    invalid = OtpError("That code isn't valid. Request a new one.", error_code="OTP_INVALID")
    challenge_id = (challenge_id or "").strip()
    if not challenge_id or len(challenge_id) > 32:
        raise invalid
    row = db.execute(select(OtpChallenge).where(OtpChallenge.id == challenge_id).with_for_update()
                     ).scalar_one_or_none()
    if row is None or row.purpose not in purposes:
        raise invalid
    # A code asked for while signed in works only for that account; a sign-in code for nobody signed in.
    if (customer.id if customer is not None else None) != row.customer_id:
        raise invalid
    now = datetime.utcnow()
    if row.status == "verified" or row.consumed_at is not None:
        raise OtpError("This code has already been used. Request a new one.", error_code="OTP_USED")
    if row.status == "superseded":
        raise OtpError("A newer code has been sent. Use the latest one.", error_code="OTP_SUPERSEDED")
    if row.status in ("failed", "expired"):
        raise invalid
    if row.status == "locked" or row.attempts >= row.max_attempts:
        raise OtpError("Too many wrong attempts. Request a new code.", error_code="OTP_LOCKED")
    if row.expires_at <= now:
        row.status = "expired"
        db.commit()
        raise OtpError("This code has expired. Request a new one.", error_code="OTP_EXPIRED")
    entered = "".join(ch for ch in str(code or "") if ch.isdigit())
    if not crypto.same(_code_hash(row.id, entered), row.code_hash):
        row.attempts += 1
        left = max(0, row.max_attempts - row.attempts)
        if left == 0:
            row.status = "locked"
        db.commit()
        if left == 0:
            raise OtpError("Too many wrong attempts. Request a new code.", error_code="OTP_LOCKED",
                           details={"attemptsLeft": 0})
        raise OtpError(f"That code isn't right. {left} {'try' if left == 1 else 'tries'} left.",
                       error_code="OTP_INCORRECT", details={"attemptsLeft": left})
    row.status = "verified"
    row.consumed_at = _now()
    destination = crypto.unseal(row.destination_sealed).get("d", "")
    if not destination:
        raise invalid
    return row, destination


# ---------------------------------------------------------------- upkeep


def cleanup(db: Session, older_than_hours: int = 24) -> int:
    """Delete challenges that expired more than a day ago (the hourly and daily limits need no older rows)."""
    cutoff = datetime.utcnow() - timedelta(hours=max(older_than_hours, 24))
    rows = db.execute(select(OtpChallenge).where(OtpChallenge.expires_at < cutoff)).scalars().all()
    for row in rows:
        db.delete(row)
    return len(rows)


def counts_today(db: Session) -> dict:
    start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    sent = _count(db, OtpChallenge.created_at >= start, OtpChallenge.status != "failed")
    verified = _count(db, OtpChallenge.created_at >= start, OtpChallenge.status == "verified")
    failed = _count(db, OtpChallenge.created_at >= start, OtpChallenge.status == "failed")
    return {"sent": sent, "verified": verified, "sendFailures": failed}
