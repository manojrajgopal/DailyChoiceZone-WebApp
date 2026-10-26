"""
Encryption for try-on provider credentials and short-lived image files.

Fernet (AES-128-CBC with an HMAC), keyed from `VTO_ENCRYPTION_KEY`. The key
lives in the environment, never in the database or the code, so a database
dump reveals no token. Rotation: set the new key, move the old one to
`VTO_ENCRYPTION_KEY_PREVIOUS`, run "Re-encrypt" in the portal, then drop the
old key. Until then both decrypt (MultiFernet) and only the new one encrypts.

In development an empty key falls back to `JWT_SECRET_KEY`. In production
credentials cannot be saved or used without the key — the rest of the store
runs regardless.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
from typing import List, Optional

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

from app.core.config import settings
from app.core.errors import AppError


class EncryptionKeyMissing(AppError):
    status_code = 503
    error_code = "TRY_ON_KEY_MISSING"


def _material(purpose: bytes, secret: str) -> bytes:
    return base64.urlsafe_b64encode(hashlib.sha256(purpose + secret.encode()).digest())


def _current_secret() -> str:
    if settings.VTO_ENCRYPTION_KEY:
        return settings.VTO_ENCRYPTION_KEY
    if settings.is_production:
        raise EncryptionKeyMissing(
            "Credentials can't be stored until VTO_ENCRYPTION_KEY is set on the server."
        )
    return settings.JWT_SECRET_KEY or ""


def key_status() -> dict:
    """For the portal: is a key set, and is an old one still configured for rotation?"""
    return {
        "configured": bool(settings.VTO_ENCRYPTION_KEY),
        "usingFallback": not settings.VTO_ENCRYPTION_KEY and not settings.is_production,
        "available": bool(settings.VTO_ENCRYPTION_KEY) or not settings.is_production,
        "previousKeySet": bool(settings.VTO_ENCRYPTION_KEY_PREVIOUS),
    }


def _fernets(purpose: bytes) -> List[Fernet]:
    keys = [Fernet(_material(purpose, _current_secret()))]
    if settings.VTO_ENCRYPTION_KEY_PREVIOUS:
        keys.append(Fernet(_material(purpose, settings.VTO_ENCRYPTION_KEY_PREVIOUS)))
    return keys


_SECRETS = b"dcz-vto-credential:"
_FILES = b"dcz-vto-file:"


def seal(secret: str) -> str:
    return MultiFernet(_fernets(_SECRETS)).encrypt(secret.encode()).decode()


def unseal(token: Optional[str]) -> Optional[str]:
    """The secret, or None when it can't be read (deleted, or sealed with a key no longer configured)."""
    if not token:
        return None
    try:
        return MultiFernet(_fernets(_SECRETS)).decrypt(token.encode()).decode()
    except (InvalidToken, ValueError):
        return None


def sealed_with_current_key(token: str) -> bool:
    try:
        _fernets(_SECRETS)[0].decrypt(token.encode())
        return True
    except (InvalidToken, ValueError):
        return False


def reseal(token: str) -> Optional[str]:
    """Re-encrypt with the current key. None when no configured key can read it."""
    try:
        return MultiFernet(_fernets(_SECRETS)).rotate(token.encode()).decode()
    except (InvalidToken, ValueError):
        return None


def fingerprint(secret: str) -> str:
    """A keyed hash: recognises the same token added twice without storing it readable."""
    key = hashlib.sha256(_SECRETS + _current_secret().encode()).digest()
    return hmac.new(key, secret.strip().encode(), hashlib.sha256).hexdigest()


def mask(last4: str) -> str:
    return "•" * 8 + (last4 or "")


# ------------------------------------------------------------------ files


def _file_fernet() -> MultiFernet:
    # Short-lived files only: falling back to the JWT secret is acceptable even
    # in production, because nothing sealed this way outlives a few minutes.
    secret = settings.VTO_ENCRYPTION_KEY or settings.JWT_SECRET_KEY or ""
    keys = [Fernet(_material(_FILES, secret))]
    if settings.VTO_ENCRYPTION_KEY_PREVIOUS:
        keys.append(Fernet(_material(_FILES, settings.VTO_ENCRYPTION_KEY_PREVIOUS)))
    return MultiFernet(keys)


def seal_bytes(data: bytes) -> bytes:
    return _file_fernet().encrypt(data)


def unseal_bytes(data: bytes) -> Optional[bytes]:
    try:
        return _file_fernet().decrypt(data)
    except (InvalidToken, ValueError):
        return None
