"""
Encryption for stored email credentials.

Fernet (AES-128-CBC with an HMAC) with a key derived from `EMAIL_ENCRYPTION_KEY`
when set, otherwise from `JWT_SECRET_KEY`. A database dump alone therefore
reveals no client secret, refresh token or password. Changing the key makes the
stored credentials unreadable; the portal then asks for them again.
"""

from __future__ import annotations

import base64
import hashlib
import json

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import settings


def _fernet() -> Fernet:
    secret = (getattr(settings, "EMAIL_ENCRYPTION_KEY", "") or settings.JWT_SECRET_KEY or "").encode()
    key = base64.urlsafe_b64encode(hashlib.sha256(b"dcz-email:" + secret).digest())
    return Fernet(key)


def seal(values: dict) -> str:
    return _fernet().encrypt(json.dumps(values).encode()).decode()


def unseal(token: str) -> dict:
    try:
        return json.loads(_fernet().decrypt(token.encode()).decode())
    except (InvalidToken, ValueError):
        return {}


def mask(value: str, keep: int = 4) -> str:
    """`GOCSPX-abcd…` → `••••••••abcd`: enough to recognise, not to use."""
    value = value or ""
    if not value:
        return ""
    return "•" * 8 + value[-keep:]
