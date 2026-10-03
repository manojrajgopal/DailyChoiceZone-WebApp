"""
Hashing and masking for the sign-in tables.

Everything that identifies a person or proves something about them (a code, a
destination, an address) is stored as an HMAC keyed by the server's secret,
never in a form that can be read back — except where the value itself has to
be used later, which is sealed (encrypted) with the same key as other stored
credentials (`services.email.crypto`).
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import re

from app.core.config import settings
from app.services.email.crypto import seal, unseal  # noqa: F401 — re-exported for the sign-in services


def _key() -> bytes:
    secret = (settings.JWT_SECRET_KEY or "").encode()
    return hashlib.sha256(b"dcz-identity:" + secret).digest()


def keyed_hash(purpose: str, value: str) -> str:
    """HMAC-SHA256 of `value`, separated by `purpose` so one hash can't stand in for another."""
    message = f"{purpose}:{value}".encode("utf-8")
    return hmac.new(_key(), message, hashlib.sha256).hexdigest()


def sha256(value: str) -> str:
    return hashlib.sha256((value or "").encode("utf-8")).hexdigest()


def same(a: str, b: str) -> bool:
    """Constant-time comparison of two strings."""
    return hmac.compare_digest((a or "").encode("utf-8"), (b or "").encode("utf-8"))


def ip_hash(ip: str) -> str:
    return keyed_hash("ip", ip or "") if ip else ""


def mask_ip(ip: str) -> str:
    """203.0.113.7 -> 203.0.113.x; 2001:db8:85a3::1 -> 2001:db8:85a3::x."""
    try:
        address = ipaddress.ip_address((ip or "").strip())
    except ValueError:
        return ""
    if address.version == 4:
        return ".".join(str(address).split(".")[:3]) + ".x"
    groups = address.exploded.split(":")[:3]
    return ":".join(group.lstrip("0") or "0" for group in groups) + "::x"


_BROWSERS = (("Edg/", "Edge"), ("OPR/", "Opera"), ("SamsungBrowser", "Samsung Internet"), ("Firefox/", "Firefox"),
             ("CriOS", "Chrome"), ("Chrome/", "Chrome"), ("Safari/", "Safari"))
_SYSTEMS = (("Windows", "Windows"), ("Android", "Android"), ("iPhone", "iPhone"), ("iPad", "iPad"),
            ("Mac OS X", "macOS"), ("CrOS", "ChromeOS"), ("Linux", "Linux"))


def device_summary(user_agent: str) -> str:
    """"Chrome on Windows": a summary for the sessions list, never the raw header."""
    agent = user_agent or ""
    browser = next((name for marker, name in _BROWSERS if marker in agent), "")
    system = next((name for marker, name in _SYSTEMS if marker in agent), "")
    if browser and system:
        return f"{browser} on {system}"
    return browser or system or ("Unknown device" if not agent else re.sub(r"[^\w .-]", "", agent)[:40] or "Unknown device")
