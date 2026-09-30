"""
Files on a support ticket.

## What is accepted

Decided by the file's **contents**, never by its name or the type the browser
claims: a PNG must start like a PNG. Images (PNG, JPEG, GIF, WebP), PDF, plain
text (txt, log, csv) and short videos (MP4, WebM, MOV). Nothing executable,
no SVG (it can carry script), no Office files (macros).

## Where it goes

Private storage under `support/<ticket>/<random>` — never a public address, and
never a name the uploader chose. It is read through a link signed for five
minutes, handed out only after the ticket's own access check, so a leaked link
stops working and a guessed key opens nothing.

Without storage configured, attachments are switched off and the contact page
says so; nothing is written to this server's disk.
"""

from __future__ import annotations

import secrets
from datetime import datetime
from typing import List, Optional, Tuple

from app.core.errors import ValidationError
from app.models import TicketAttachment
from app.services import storage

IMAGE_TYPES = ("image/png", "image/jpeg", "image/gif", "image/webp")
VIDEO_TYPES = ("video/mp4", "video/webm", "video/quicktime")
EXTENSIONS = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
    "application/pdf": ".pdf", "text/plain": ".txt", "text/csv": ".csv",
    "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
}


def enabled() -> bool:
    return storage.is_configured()


def sniff(data: bytes, name: str) -> Optional[str]:
    """The file's real type from its first bytes, or None if it isn't one we take."""
    head = data[:32]
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head.startswith(b"%PDF-"):
        return "application/pdf"
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "video/webm"
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        return "video/quicktime" if brand == b"qt  " else "video/mp4"
    lowered = name.lower()
    if lowered.endswith((".txt", ".log", ".csv")) and b"\x00" not in data[:4096]:
        try:
            data[:65536].decode("utf-8")
        except UnicodeDecodeError:
            return None
        return "text/csv" if lowered.endswith(".csv") else "text/plain"
    return None


def clean_name(name: str) -> str:
    base = (name or "file").replace("\\", "/").split("/")[-1]
    safe = "".join(c for c in base if c.isalnum() or c in " ._-()").strip()
    return (safe or "file")[:120]


def validate(files: List[Tuple[str, bytes]], limits: dict) -> List[Tuple[str, bytes, str]]:
    """Check every file before any is stored; return (name, data, real type)."""
    if not files:
        return []
    if not enabled():
        raise ValidationError(
            "Attachments aren't available right now — please describe the problem in words, "
            "or paste a link to a screenshot.",
            error_code="ATTACHMENTS_DISABLED",
        )
    max_files = int(limits.get("maxFiles") or 5)
    if len(files) > max_files:
        raise ValidationError(f"Attach up to {max_files} files at a time.", error_code="TOO_MANY_FILES")
    out = []
    for name, data in files:
        shown = clean_name(name)
        if not data:
            raise ValidationError(f"{shown} is empty.", error_code="EMPTY_FILE")
        kind = sniff(data, shown)
        if kind is None:
            raise ValidationError(
                f"{shown} isn't a type we accept. Use an image, PDF, text file or short video.",
                error_code="FILE_TYPE",
            )
        limit_mb = int(limits.get("maxVideoSizeMb" if kind in VIDEO_TYPES else "maxSizeMb") or 10)
        if len(data) > limit_mb * 1024 * 1024:
            raise ValidationError(f"{shown} is larger than {limit_mb} MB.", error_code="FILE_TOO_LARGE")
        if kind in ("image/png", "image/jpeg", "image/webp"):
            data = _clean_image(data, kind, shown)
        out.append((shown, data, kind))
    return out


def _clean_image(data: bytes, kind: str, shown: str) -> bytes:
    """
    Re-encode a photo so what is stored is only its pixels — no location or
    camera metadata from the customer's phone, nothing hidden after the image.
    A file that doesn't decode as the image it claims to be is refused.
    """
    import io

    from PIL import Image, ImageOps, UnidentifiedImageError

    Image.MAX_IMAGE_PIXELS = 40_000_000
    try:
        with Image.open(io.BytesIO(data)) as image:
            image = ImageOps.exif_transpose(image)
            fmt = {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP"}[kind]
            if fmt == "JPEG" and image.mode not in ("RGB", "L"):
                image = image.convert("RGB")
            buffer = io.BytesIO()
            image.save(buffer, format=fmt, **({"quality": 90} if fmt in ("JPEG", "WEBP") else {}))
            return buffer.getvalue()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise ValidationError(f"{shown} couldn't be read as an image.", error_code="FILE_TYPE") from None


def store(ticket_id: str, checked: List[Tuple[str, bytes, str]], *, message_id: Optional[int],
          uploaded_by: str, internal: bool) -> List[TicketAttachment]:
    """Upload validated files and return their (unsaved) rows."""
    rows = []
    now = datetime.utcnow()
    for name, data, kind in checked:
        key = f"support/{ticket_id}/{secrets.token_hex(16)}{EXTENSIONS.get(kind, '')}"
        storage.put_private(data, key, kind)
        rows.append(TicketAttachment(
            ticket_id=ticket_id, message_id=message_id, file_name=name, content_type=kind,
            size=len(data), storage_key=key, internal=internal, uploaded_by=uploaded_by, created_at=now,
        ))
    return rows


def link(attachment: TicketAttachment) -> str:
    inline = attachment.content_type in IMAGE_TYPES or attachment.content_type in VIDEO_TYPES \
        or attachment.content_type == "application/pdf"
    return storage.signed_url(attachment.storage_key, attachment.file_name, inline=inline)


def view(attachment: TicketAttachment) -> dict:
    return {
        "id": attachment.id,
        "messageId": attachment.message_id,
        "name": attachment.file_name,
        "contentType": attachment.content_type,
        "size": attachment.size,
        "isImage": attachment.content_type in IMAGE_TYPES,
        "internal": attachment.internal,
        "uploadedBy": attachment.uploaded_by,
        "createdAt": attachment.created_at,
    }
