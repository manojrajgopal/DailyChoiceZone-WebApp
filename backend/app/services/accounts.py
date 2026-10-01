"""
Account security: proving an email address, and getting back into an account.

## The links

Both flows send a link carrying a random secret (`secrets.token_urlsafe`, 256
bits). Only its SHA-256 is stored (`CustomerToken.token_hash`), so the table
can't be turned into working links. A token is:

- **one-time** — `used_at` is set in the same transaction that acts on it, and
  a used, expired or superseded token is refused;
- **short-lived** — lifetimes are store settings (`accounts` document);
- **the only one** — issuing a new link supersedes any earlier unused one of
  the same purpose, so an old email can't be replayed after a newer request;
- **bound to the address** it was sent to.

## What the API gives away

Requesting a reset answers the same way whether or not the address has an
account, and sends nothing for an unknown one. A bad, expired or used token
gets its own message ("this link has expired") only *after* it has been shown
to be a real token — a guessed token learns nothing but "invalid".

## After a reset

The new password is hashed with the same bcrypt context as everything else,
`password_changed_at` is stamped — which retires every token issued before it
(see `dependencies.auth`), signing out other devices — and a "your password was
changed" email goes to the owner. The address is also marked verified: the
reset link just proved they receive mail there.

Nothing here logs a password or a token.
"""

from __future__ import annotations

import copy
import hashlib
import html as html_lib
import logging
import secrets
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import settings as app_settings
from app.core.errors import ConflictError, ValidationError
from app.core.security import hash_password
from app.models import Customer, CustomerToken, SettingDocument

logger = logging.getLogger(__name__)

VERIFY = "email-verification"
RESET = "password-reset"

DEFAULTS = {
    # How long each link works.
    "verificationHours": 48,
    "resetMinutes": 60,
    # Placing an order needs a verified address. Off by default so existing
    # customers, who signed up before verification existed, aren't locked out
    # of checkout; the store turns it on when it's ready.
    "requireVerifiedEmailToOrder": False,
}


# --------------------------------------------------------------- settings


def settings(db: Session) -> dict:
    stored = (db.get(SettingDocument, "accounts") or SettingDocument(value={})).value or {}
    merged = copy.deepcopy(DEFAULTS)
    merged.update({k: v for k, v in stored.items() if k in DEFAULTS})
    return merged


def _whole(value) -> int:
    if isinstance(value, bool):
        raise ValidationError("Enter a whole number.", error_code="INVALID_SETTING")
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ValidationError("Enter a whole number.", error_code="INVALID_SETTING") from None


def save_settings(db: Session, payload: dict) -> dict:
    out = settings(db)
    if "verificationHours" in payload:
        hours = _whole(payload["verificationHours"])
        if not 1 <= hours <= 24 * 14:
            raise ValidationError("Verification links last between 1 hour and 14 days.", error_code="INVALID_SETTING")
        out["verificationHours"] = hours
    if "resetMinutes" in payload:
        minutes = _whole(payload["resetMinutes"])
        if not 10 <= minutes <= 24 * 60:
            raise ValidationError("Reset links last between 10 minutes and a day.", error_code="INVALID_SETTING")
        out["resetMinutes"] = minutes
    if "requireVerifiedEmailToOrder" in payload:
        out["requireVerifiedEmailToOrder"] = bool(payload["requireVerifiedEmailToOrder"])
    now = datetime.utcnow()
    row = db.get(SettingDocument, "accounts")
    if row is None:
        db.add(SettingDocument(key="accounts", value=out, created_at=now, updated_at=now))
    else:
        row.value = out
        row.updated_at = now
    db.commit()
    return out


# ------------------------------------------------------------------ tokens


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _issue(db: Session, customer: Customer, purpose: str, lifetime: timedelta) -> str:
    """A new link; earlier unused links of the same purpose stop working."""
    now = datetime.utcnow()
    db.execute(
        update(CustomerToken)
        .where(CustomerToken.customer_id == customer.id, CustomerToken.purpose == purpose,
               CustomerToken.used_at.is_(None), CustomerToken.revoked_reason == "")
        .values(revoked_reason="superseded")
    )
    raw = secrets.token_urlsafe(32)
    db.add(CustomerToken(
        customer_id=customer.id, purpose=purpose, token_hash=_hash(raw), email=customer.email,
        created_at=now, expires_at=now + lifetime,
    ))
    return raw


class TokenProblem(ValidationError):
    pass


def _consume(db: Session, raw: str, purpose: str, *, lock: bool = True) -> tuple:
    """
    The token's row and its customer, checked and locked — or the reason not.

    The row is locked (`FOR UPDATE`) so two requests racing with the same link
    can't both use it: the second waits, then sees `used_at` set.
    """
    raw = (raw or "").strip()
    invalid = TokenProblem("This link isn't valid. Request a new one.", error_code="TOKEN_INVALID")
    if not raw or len(raw) > 200:
        raise invalid
    query = select(CustomerToken).where(CustomerToken.token_hash == _hash(raw), CustomerToken.purpose == purpose)
    token = db.execute(query.with_for_update() if lock else query).scalar_one_or_none()
    if token is None:
        raise invalid
    customer = db.get(Customer, token.customer_id)
    if customer is None or customer.email.lower() != token.email.lower() or customer.status != "active":
        raise invalid
    if token.used_at is not None:
        raise TokenProblem("This link has already been used.", error_code="TOKEN_USED")
    if token.revoked_reason == "superseded":
        raise TokenProblem("A newer link has been sent — use the latest email.", error_code="TOKEN_SUPERSEDED")
    if token.expires_at <= datetime.utcnow():
        raise TokenProblem("This link has expired. Request a new one.", error_code="TOKEN_EXPIRED")
    return token, customer


def cleanup(db: Session, older_than_days: int = 30) -> int:
    """Remove tokens long past use; the audit value of a month-old dead link is nil."""
    cutoff = datetime.utcnow() - timedelta(days=older_than_days)
    rows = db.execute(select(CustomerToken).where(CustomerToken.expires_at < cutoff)).scalars().all()
    for row in rows:
        db.delete(row)
    db.commit()
    return len(rows)


# ----------------------------------------------------------------- emails


def _link(path: str, raw: str) -> str:
    return f"{app_settings.STOREFRONT_URL.rstrip('/')}{path}?token={raw}"


def _send(db: Session, customer: Customer, *, subject: str, title: str, intro: str,
          cta: Optional[tuple], text: str, reference: str) -> None:
    from app.services import email as email_service

    footnote = ("You're receiving this because of a request on your Daily Choice Zone account. "
                "If it wasn't you, you can ignore this email — nothing changes until the link is used.")
    html = email_service.layout(title, intro, cta=cta, footnote=footnote)
    email_service.notify(db, "account_security", to=customer.email, customer_id=customer.id,
                         subject=subject, html=html, text=text, reference=reference)


def send_verification(db: Session, customer: Customer) -> None:
    """Issue a verification link and email it. The caller commits."""
    hours = int(settings(db)["verificationHours"])
    raw = _issue(db, customer, VERIFY, timedelta(hours=hours))
    link = _link("/verify-email", raw)
    name = html_lib.escape(customer.first_name or "there")
    lifetime = f"{hours} hours" if hours < 48 else f"{hours // 24} days"
    _send(
        db, customer,
        subject="Confirm your email address",
        title="Confirm your email address",
        intro=(f"Hello {name}, please confirm that this is your email address so we can keep your account "
               f"secure and reach you about your orders. The link works for {lifetime}."),
        cta=("Confirm my email", link),
        text=(f"Hello {customer.first_name}, confirm your email address for Daily Choice Zone: {link}\n"
              f"The link works for {lifetime}."),
        reference="verify-email",
    )


def resend_verification(db: Session, customer: Customer) -> bool:
    """False when there's nothing to do — the address is already confirmed."""
    if customer.email_verified_at is not None:
        return False
    send_verification(db, customer)
    db.commit()
    return True


def verify_email(db: Session, raw: str) -> Customer:
    token, customer = _consume(db, raw, VERIFY)
    now = datetime.utcnow()
    token.used_at = now
    token.revoked_reason = "used"
    if customer.email_verified_at is None:
        customer.email_verified_at = now
    db.commit()
    return customer


# ----------------------------------------------------------------- resets


def request_password_reset(db: Session, email: str) -> None:
    """
    Send a reset link if — and only if — there is an active account for `email`.

    Returns nothing either way: the route answers the same words whatever
    happens here, so the response can't be used to test which addresses have
    accounts.
    """
    address = (email or "").strip().lower()
    customer = db.execute(select(Customer).where(Customer.email == address)).scalar_one_or_none()
    if customer is None or customer.status != "active":
        return
    minutes = int(settings(db)["resetMinutes"])
    raw = _issue(db, customer, RESET, timedelta(minutes=minutes))
    link = _link("/reset-password", raw)
    name = html_lib.escape(customer.first_name or "there")
    _send(
        db, customer,
        subject="Reset your Daily Choice Zone password",
        title="Reset your password",
        intro=(f"Hello {name}, we received a request to reset the password for your account. The link below "
               f"works once, for the next {minutes} minutes. If you didn't ask for this, ignore this email — "
               "your password stays as it is."),
        cta=("Choose a new password", link),
        text=(f"Reset your Daily Choice Zone password (works once, for {minutes} minutes): {link}\n"
              "If you didn't ask for this, ignore this email."),
        reference="password-reset",
    )
    db.commit()


def check_reset_token(db: Session, raw: str) -> None:
    """Whether a reset link still works — for the reset page, before the form is filled in."""
    _consume(db, raw, RESET, lock=False)  # a look, not a use: nothing to lock


def reset_password(db: Session, raw: str, new_password: str) -> Customer:
    token, customer = _consume(db, raw, RESET)
    now = datetime.utcnow()
    customer.password_hash = hash_password(new_password)
    # Whole seconds: a JWT's `iat` is whole seconds, and MySQL would round a
    # fraction *up* — invalidating the token issued the moment after.
    customer.password_changed_at = now.replace(microsecond=0)
    if customer.email_verified_at is None:
        # Following the emailed link proved they receive mail at this address.
        customer.email_verified_at = now
    token.used_at = now
    token.revoked_reason = "used"
    # Any other outstanding reset link for this account dies with this one.
    db.execute(
        update(CustomerToken)
        .where(CustomerToken.customer_id == customer.id, CustomerToken.purpose == RESET,
               CustomerToken.used_at.is_(None), CustomerToken.id != token.id)
        .values(revoked_reason="superseded")
    )
    name = html_lib.escape(customer.first_name or "there")
    _send(
        db, customer,
        subject="Your password was changed",
        title="Your password was changed",
        intro=(f"Hello {name}, the password for your Daily Choice Zone account was just changed, and every "
               "other device was signed out. If this wasn't you, reset your password again straight away "
               "and contact our support team."),
        cta=None,
        text="The password for your Daily Choice Zone account was just changed. If this wasn't you, reset it "
             "again and contact support.",
        reference="password-changed",
    )
    db.commit()
    logger.info("Password reset completed for customer %s", customer.id)
    return customer


def require_verified_to_order(db: Session, customer: Customer) -> None:
    """Refuse an order from an unverified address, when the store asks for that."""
    if settings(db)["requireVerifiedEmailToOrder"] and customer.email_verified_at is None:
        raise ConflictError(
            "Please confirm your email address before placing an order — we've sent you a link.",
            error_code="EMAIL_NOT_VERIFIED",
        )
