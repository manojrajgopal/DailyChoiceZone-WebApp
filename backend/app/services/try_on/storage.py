"""
Where try-on photos and results live. Never the application's own disk for
anything kept: the server holds code and short-lived working files only.

Two backends behind one interface:

- **s3** — a private bucket (or a private prefix of the store's bucket),
  server-side encrypted. Objects are read through signed links that last
  `VTO_SIGNED_URL_SECONDS`; nothing is public. Used for "permanent" results
  (kept until the customer deletes them) and "temporary" ones (deleted after
  the plan's retention period).
- **ephemeral** — used until S3 is configured. Files are encrypted and kept in
  an isolated folder for at most `VTO_EPHEMERAL_TTL_MINUTES`, then deleted.
  Customers are told the result is *not saved*. Works for one server (or
  several sharing that folder); configure S3 before scaling out.

`VTO_STORAGE` chooses: `auto` (S3 when configured, otherwise ephemeral), `s3`,
`ephemeral` or `disabled`. Switching to S3 later is configuration only.

Every row that points at a stored object records which backend holds it, so a
change of backend never orphans what was stored before.
"""

from __future__ import annotations

import logging
import os
import re
import secrets
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from app.core.config import settings
from app.services import storage as store_files
from app.services.try_on import crypto
from app.services.try_on.errors import TryOnError

logger = logging.getLogger(__name__)

_KEY = re.compile(r"^[a-z0-9][a-z0-9/_-]{0,200}\.(jpg|jpeg|png|webp|bin)$")


class StorageFailed(Exception):
    """A storage operation that did not complete — the caller decides whether to retry."""


def _check_key(key: str) -> str:
    if not _KEY.match(key or "") or ".." in key:
        raise StorageFailed("refused an unsafe object key")
    return key


# ------------------------------------------------------------------ S3


def s3_bucket() -> str:
    return settings.VTO_S3_BUCKET or settings.AWS_S3_BUCKET


def s3_prefix() -> str:
    return (settings.VTO_S3_PREFIX or "try-on").strip("/") or "try-on"


def s3_problem() -> str:
    """Why S3 can't be used, or "" when it can."""
    if not store_files.credentials_available():
        return "AWS credentials are not configured."
    if not s3_bucket():
        return "No bucket is configured (VTO_S3_BUCKET or AWS_S3_BUCKET)."
    public = (settings.AWS_S3_PREFIX or "").strip("/")
    if s3_bucket() == settings.AWS_S3_BUCKET and public and (
        s3_prefix() == public or s3_prefix().startswith(public + "/")
    ):
        return "VTO_S3_PREFIX is inside the public product-photo prefix; choose a private prefix."
    return ""


class S3Backend:
    name = "s3"

    def _client(self):
        return store_files.client()

    def put(self, key: str, data: bytes, content_type: str) -> None:
        extra = {}
        if settings.VTO_S3_SSE:
            extra["ServerSideEncryption"] = settings.VTO_S3_SSE
            if settings.VTO_S3_SSE == "aws:kms" and settings.VTO_S3_KMS_KEY_ID:
                extra["SSEKMSKeyId"] = settings.VTO_S3_KMS_KEY_ID
        try:
            self._client().put_object(Bucket=s3_bucket(), Key=_check_key(key), Body=data, ContentType=content_type,
                                      CacheControl="private, no-store", **extra)
        except StorageFailed:
            raise
        except Exception as error:  # botocore raises a wide family
            logger.warning("Try-on: could not store an object (%s)", type(error).__name__)
            raise StorageFailed(type(error).__name__) from None

    def get(self, key: str) -> Optional[bytes]:
        try:
            response = self._client().get_object(Bucket=s3_bucket(), Key=_check_key(key))
            return response["Body"].read()
        except StorageFailed:
            raise
        except Exception as error:
            code = getattr(error, "response", {}).get("Error", {}).get("Code", "") if hasattr(error, "response") else ""
            if code in ("NoSuchKey", "404", "NotFound"):
                return None
            logger.warning("Try-on: could not read an object (%s)", type(error).__name__)
            raise StorageFailed(type(error).__name__) from None

    def delete(self, key: str) -> None:
        try:
            self._client().delete_object(Bucket=s3_bucket(), Key=_check_key(key))
        except StorageFailed:
            raise
        except Exception as error:
            raise StorageFailed(type(error).__name__) from None

    def link(self, key: str, file_name: str, *, inline: bool) -> Optional[str]:
        safe = "".join(c for c in file_name if c.isalnum() or c in "._-")[:80] or "try-on.jpg"
        disposition = f'{"inline" if inline else "attachment"}; filename="{safe}"'
        try:
            return self._client().generate_presigned_url(
                "get_object",
                Params={"Bucket": s3_bucket(), "Key": _check_key(key), "ResponseContentDisposition": disposition,
                        "ResponseCacheControl": "private, no-store"},
                ExpiresIn=max(30, min(int(settings.VTO_SIGNED_URL_SECONDS or 120), 900)),
            )
        except StorageFailed:
            raise
        except Exception as error:
            raise StorageFailed(type(error).__name__) from None


# ------------------------------------------------------------- ephemeral


def ephemeral_dir() -> Path:
    base = Path(settings.VTO_TEMP_DIR) if settings.VTO_TEMP_DIR else Path(tempfile.gettempdir()) / "dcz-try-on"
    base.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(base, 0o700)
    except OSError:  # Windows ignores most of this; the folder is under the user's own temp
        pass
    return base


def ephemeral_ttl_seconds() -> int:
    return max(1, min(int(settings.VTO_EPHEMERAL_TTL_MINUTES or 30), 24 * 60)) * 60


class EphemeralBackend:
    name = "ephemeral"

    def _path(self, key: str) -> Path:
        # One flat folder: the key's slashes become underscores, so nothing
        # can name a path outside it.
        return ephemeral_dir() / _check_key(key).replace("/", "_")

    def put(self, key: str, data: bytes, content_type: str) -> None:
        path = self._path(key)
        try:
            with open(path, "wb") as handle:
                handle.write(crypto.seal_bytes(data))
        except OSError as error:
            raise StorageFailed(type(error).__name__) from None

    def get(self, key: str) -> Optional[bytes]:
        path = self._path(key)
        try:
            if time.time() - path.stat().st_mtime > ephemeral_ttl_seconds():
                self.delete(key)
                return None
            return crypto.unseal_bytes(path.read_bytes())
        except FileNotFoundError:
            return None
        except OSError as error:
            raise StorageFailed(type(error).__name__) from None

    def delete(self, key: str) -> None:
        try:
            self._path(key).unlink(missing_ok=True)
        except OSError as error:
            raise StorageFailed(type(error).__name__) from None

    def link(self, key: str, file_name: str, *, inline: bool) -> Optional[str]:
        return None  # served through the API, which checks ownership on every read

    def sweep(self) -> int:
        """Delete every working file older than the TTL, whatever the database says."""
        removed = 0
        cutoff = time.time() - ephemeral_ttl_seconds()
        for path in ephemeral_dir().iterdir():
            try:
                if path.is_file() and path.stat().st_mtime < cutoff:
                    path.unlink(missing_ok=True)
                    removed += 1
            except OSError:
                continue
        return removed


_BACKENDS = {"s3": S3Backend(), "ephemeral": EphemeralBackend()}


def backend(name: str):
    try:
        return _BACKENDS[name]
    except KeyError:
        raise StorageFailed(f"unknown storage backend {name!r}") from None


def active_name() -> str:
    """The backend new objects go to: s3 | ephemeral | "" (disabled or misconfigured)."""
    choice = (settings.VTO_STORAGE or "auto").lower()
    if choice == "disabled":
        return ""
    if choice == "s3":
        return "s3" if not s3_problem() else ""
    if choice == "ephemeral":
        return "ephemeral"
    return "s3" if not s3_problem() else "ephemeral"


def require_active():
    name = active_name()
    if not name:
        raise TryOnError("storage_unavailable", "Virtual try-on is unavailable right now.", status_code=503)
    return backend(name)


def status() -> dict:
    """What the portal and the customer pages show about storage."""
    name = active_name()
    choice = (settings.VTO_STORAGE or "auto").lower()
    return {
        "configured": choice,
        "active": name or "none",
        "s3Ready": not s3_problem(),
        "s3Problem": s3_problem(),
        "bucket": s3_bucket() if not s3_problem() else "",
        "prefix": s3_prefix(),
        "encryption": settings.VTO_S3_SSE or "none",
        "ephemeralTtlMinutes": ephemeral_ttl_seconds() // 60,
        "permanentAvailable": name == "s3",
    }


def new_key(kind: str, customer_id: str, ext: str = "jpg") -> str:
    owner = re.sub(r"[^a-z0-9]", "", customer_id.lower())[:20] or "anon"
    key = f"{kind}/{owner}/{datetime.utcnow():%Y%m}/{secrets.token_hex(16)}.{ext}"
    return f"{s3_prefix()}/{key}" if active_name() == "s3" else key


def expires_for(storage_name: str, mode: str, retention_days: Optional[int], now: datetime) -> Optional[datetime]:
    """When an object must be gone: never for permanent S3, the plan's days for temporary, the TTL for ephemeral."""
    if storage_name == "ephemeral":
        return now + timedelta(seconds=ephemeral_ttl_seconds())
    if mode == "permanent":
        return None
    return now + timedelta(days=max(1, int(retention_days or 7)))
