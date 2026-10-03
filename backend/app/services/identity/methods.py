"""
Which sign-in methods the storefront offers.

Two things decide it, and both must say yes:

1. **The store's switch**, saved in the `auth_methods` settings document from
   Admin → Settings → Authentication (permission `auth-settings`).
2. **Whether it can work**: a social provider needs its credentials in the
   environment; mobile codes need an SMS provider (or the development console);
   email codes need an email account (or the development console).

The portal shows both — "on, not configured" is a state worth seeing — but
never a credential.
"""

from __future__ import annotations

from datetime import datetime
from typing import List

from sqlalchemy.orm import Session

from app.core.errors import ValidationError
from app.models import SettingDocument
from app.services.identity import registry

DOCUMENT = "auth_methods"

# key -> label. Order is the order the portal lists them.
METHODS = {
    "emailPassword": "Email and password",
    "emailOtp": "Email me a code",
    "mobileOtp": "Mobile number (one-time code)",
    "google": "Google",
    "apple": "Apple",
    "microsoft": "Microsoft",
}
SOCIAL = ("google", "apple", "microsoft")
# How a new email-and-password account confirms its address: the emailed link
# (as before), a one-time code typed on the sign-up page, or either.
SIGNUP_VERIFICATION = ("link", "code", "both")
# The store asks a new customer for the emailed code on the sign-up page (and still sends the link,
# for someone who closes the page) until the portal says otherwise.
DEFAULT_SIGNUP_VERIFICATION = "both"


def signup_verification(db: Session) -> str:
    stored = (db.get(SettingDocument, DOCUMENT) or SettingDocument(value={})).value or {}
    value = stored.get("signupVerification", DEFAULT_SIGNUP_VERIFICATION)
    return value if value in SIGNUP_VERIFICATION else DEFAULT_SIGNUP_VERIFICATION


def _switches(db: Session) -> dict:
    stored = (db.get(SettingDocument, DOCUMENT) or SettingDocument(value={})).value or {}
    return {key: bool(stored.get(key, True)) for key in METHODS}


def _configured(db: Session, key: str) -> tuple:
    if key == "emailPassword":
        return True, ""
    if key == "mobileOtp":
        from app.services import otp_providers

        return otp_providers.sms_provider().configured()
    if key == "emailOtp":
        from app.services import otp_providers

        return otp_providers.email_ready(db)
    provider = registry.get(key)
    return provider.configured() if provider else (False, "Unknown provider.")


def enabled(db: Session, key: str) -> bool:
    """On in the store's settings, and able to work."""
    return _switches(db).get(key, False) and _configured(db, key)[0]


def public(db: Session) -> dict:
    """What the sign-in page offers. Nothing about why something is missing."""
    switches = _switches(db)
    usable = {key: switches[key] and _configured(db, key)[0] for key in METHODS}
    return {
        "emailPassword": usable["emailPassword"],
        "emailOtp": usable["emailOtp"],
        "mobileOtp": usable["mobileOtp"],
        "providers": [{"code": key, "label": METHODS[key]} for key in SOCIAL if usable[key]],
        "signupVerification": signup_verification(db),
    }


def admin_view(db: Session, redirect_base: str = "") -> List[dict]:
    switches = _switches(db)
    rows = []
    for key, label in METHODS.items():
        ready, reason = _configured(db, key)
        row = {"key": key, "label": label, "enabled": switches[key], "configured": ready,
               "reason": "" if ready else reason, "social": key in SOCIAL}
        if key in SOCIAL and redirect_base:
            row["redirectUri"] = f"{redirect_base.rstrip('/')}/{key}/callback"
        rows.append(row)
    return rows


def save(db: Session, payload: dict) -> dict:
    """Merge the switches sent; refuse a set-up in which nobody could sign in."""
    if not isinstance(payload, dict):
        raise ValidationError("Send each method with true or false.", error_code="INVALID_SETTING")
    switches = _switches(db)
    verification = signup_verification(db)
    if "signupVerification" in payload:
        if payload["signupVerification"] not in SIGNUP_VERIFICATION:
            raise ValidationError("Choose link, code or both for confirming new accounts.",
                                  error_code="INVALID_SETTING")
        verification = payload["signupVerification"]
    for key, value in payload.items():
        if key not in METHODS:
            continue
        if not isinstance(value, bool):
            raise ValidationError("Send each method with true or false.", error_code="INVALID_SETTING")
        switches[key] = value
    if not any(switches[key] and _configured(db, key)[0] for key in METHODS):
        raise ValidationError("Keep at least one sign-in method on that works, or nobody can sign in.",
                              error_code="NO_SIGN_IN_METHOD")
    now = datetime.utcnow()
    value = {**switches, "signupVerification": verification}
    row = db.get(SettingDocument, DOCUMENT)
    if row is None:
        db.add(SettingDocument(key=DOCUMENT, value=value, created_at=now, updated_at=now))
    else:
        row.value = value
        row.updated_at = now
    return value
