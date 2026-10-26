"""
Photos in, photos out — never trusted as sent.

A customer's photo must decode as JPEG, PNG or WebP (checked by opening it,
not by its name or Content-Type), within a byte limit before decoding and a
pixel limit during it (so a small file that inflates to gigabytes is
refused). It is then rotated upright from its EXIF orientation, stripped of
every piece of metadata (camera GPS included), scaled down to at most
`MAX_EDGE` and re-encoded as JPEG. What is stored and sent to a provider is
pixels this process wrote.

Product photos are fetched by the server, from http(s) only, never from a
private or local address in production, with the same limits.
"""

from __future__ import annotations

import io
import ipaddress
import socket
import urllib.parse
from dataclasses import dataclass
from typing import Optional

from PIL import Image, ImageOps, UnidentifiedImageError

from app.core.config import settings
from app.services.try_on.errors import ProviderFailure, TryOnError

ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP", "MPO"}
MAX_PIXELS = 40_000_000
MAX_EDGE = 1536
GARMENT_MAX_BYTES = 12 * 1024 * 1024
HARD_MAX_BYTES = 25 * 1024 * 1024


@dataclass
class Normalised:
    data: bytes
    width: int
    height: int
    content_type: str = "image/jpeg"


def max_upload_bytes(plan_mb: Optional[float]) -> int:
    ceiling = max(1, int(settings.VTO_MAX_UPLOAD_MB or 10))
    wanted = float(plan_mb) if plan_mb else ceiling
    return int(min(max(wanted, 0.5), ceiling, HARD_MAX_BYTES / 1024 / 1024) * 1024 * 1024)


def normalise(data: bytes, *, max_bytes: int, rules: Optional[dict] = None) -> Normalised:
    """Check and re-encode a photo. Raises TryOnError with a catalogue code."""
    rules = rules or {}
    if not data:
        raise TryOnError("invalid_image", "That file is empty.")
    if len(data) > max_bytes:
        raise TryOnError("image_too_large", f"Photos must be {max_bytes // (1024 * 1024)} MB or smaller.")

    limit = int(min(float(rules.get("maxMegapixels") or 40), MAX_PIXELS / 1_000_000) * 1_000_000)
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        with Image.open(io.BytesIO(data)) as probe:
            if probe.format not in ALLOWED_FORMATS:
                raise TryOnError("invalid_image", "Upload a JPEG, PNG or WebP photo.")
            # The header's size, read before decoding a single pixel.
            width, height = probe.size
            if width * height > limit:
                raise TryOnError("image_too_large", "That photo has too many pixels. Please use a smaller one.")
            probe.verify()
        with Image.open(io.BytesIO(data)) as source:
            image = ImageOps.exif_transpose(source)
            if image.mode not in ("RGB",):
                background = Image.new("RGB", image.size, (255, 255, 255))
                rgba = image.convert("RGBA")
                background.paste(rgba, mask=rgba.split()[-1])
                image = background
            image.thumbnail((MAX_EDGE, MAX_EDGE))
            width, height = image.size
            out = io.BytesIO()
            # A new image from the pixels: no EXIF, no ICC, no comments, no trailing bytes.
            clean = Image.new("RGB", image.size)
            clean.paste(image)
            clean.save(out, format="JPEG", quality=90, optimize=True)
    except TryOnError:
        raise
    except Image.DecompressionBombError:
        raise TryOnError("image_too_large", "That photo has too many pixels. Please use a smaller one.") from None
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError):
        raise TryOnError("invalid_image", "That file is not a photo we can use.") from None

    min_w, min_h = int(rules.get("minWidth") or 0), int(rules.get("minHeight") or 0)
    if width < min_w or height < min_h:
        raise TryOnError("image_too_small", f"Please use a photo at least {min_w}×{min_h} pixels.")
    return Normalised(out.getvalue(), width, height)


# ------------------------------------------------------------- product photos


def _host_allowed(host: str) -> bool:
    """Public addresses only, in production. Development may use local images."""
    if not settings.is_production:
        return True
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if not address.is_global:
            return False
    return True


def absolute_url(url: str) -> str:
    """Product image addresses may be site-relative ("/images/…"): resolve against the storefront."""
    url = (url or "").strip()
    if url.startswith("//"):
        return "https:" + url
    if url.startswith("/"):
        return settings.STOREFRONT_URL.rstrip("/") + url
    return url


def fetch_garment(url: str, *, timeout: float = 20.0) -> bytes:
    """
    The product photo's bytes, normalised. Raises ProviderFailure
    ("garment_unavailable") — a product problem, not the customer's.
    """
    import httpx

    url = absolute_url(url)
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ProviderFailure("garment_unavailable", "product image address is not http(s)")
    if not _host_allowed(parts.hostname):
        raise ProviderFailure("garment_unavailable", "product image host is not a public address")
    try:
        with httpx.Client(timeout=timeout, follow_redirects=False) as client:
            for _ in range(4):
                with client.stream("GET", url, headers={"Accept": "image/*"}) as response:
                    if response.is_redirect:
                        target = urllib.parse.urljoin(url, response.headers.get("location", ""))
                        host = urllib.parse.urlsplit(target).hostname or ""
                        if urllib.parse.urlsplit(target).scheme not in ("http", "https") or not _host_allowed(host):
                            raise ProviderFailure("garment_unavailable", "product image redirected to a refused address")
                        url = target
                        continue
                    if response.status_code != 200:
                        raise ProviderFailure("garment_unavailable", f"product image answered HTTP {response.status_code}")
                    chunks, size = [], 0
                    for chunk in response.iter_bytes():
                        size += len(chunk)
                        if size > GARMENT_MAX_BYTES:
                            raise ProviderFailure("garment_unavailable", "product image is too large")
                        chunks.append(chunk)
                    data = b"".join(chunks)
                    break
            else:
                raise ProviderFailure("garment_unavailable", "product image redirected too many times")
    except ProviderFailure:
        raise
    except httpx.HTTPError as error:
        raise ProviderFailure("garment_unavailable", f"product image could not be fetched ({type(error).__name__})") from None

    try:
        return normalise(data, max_bytes=GARMENT_MAX_BYTES).data
    except TryOnError as error:
        raise ProviderFailure("garment_unavailable", f"product image is not usable ({error.code})") from None
