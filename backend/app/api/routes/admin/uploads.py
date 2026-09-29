"""
Uploading product photographs.

`POST /api/admin/uploads/images` takes one image file and returns the path it
is served at, `/uploads/products/<random>.webp`, for the product form to store
like any other image address.

An uploaded file is untrusted input, so it is never stored as sent:

- it must decode as a JPEG, PNG, WebP or GIF image — checked by opening it,
  not by trusting its name or its Content-Type;
- it is limited in bytes before decoding and in pixels while decoding, so a
  small file that inflates to gigabytes (a "decompression bomb") is refused;
- it is **re-encoded** to WebP. What is saved is pixels this process wrote —
  no metadata (camera GPS included), no trailing bytes, nothing a crafted
  "image that is also a script" could smuggle through;
- the file name is random. Nothing the uploader chose reaches the disk.
"""

from __future__ import annotations

import io
import secrets
from pathlib import Path

from fastapi import APIRouter, Depends, File, UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError

from app.core.config import settings
from app.core.errors import ValidationError
from app.dependencies.auth import require_permission
from app.models import AdminUser
from app.utils.response import ok

router = APIRouter(prefix="/admin/uploads", tags=["Admin · Uploads"])

ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP", "GIF", "MPO"}
MAX_BYTES = 8 * 1024 * 1024
MAX_PIXELS = 40_000_000
# Longest edge after resizing: plenty for a zoomed product photo.
MAX_EDGE = 2400


def upload_root() -> Path:
    """Where uploads live on disk. Created on first use."""
    root = Path(settings.UPLOAD_DIR)
    if not root.is_absolute():
        root = Path(__file__).resolve().parents[4] / root
    (root / "products").mkdir(parents=True, exist_ok=True)
    return root


@router.post("/images", status_code=201, summary="Upload a product photograph")
async def upload_image(
    file: UploadFile = File(...),
    admin: AdminUser = Depends(require_permission("products")),
):
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValidationError("Images must be 8 MB or smaller.", error_code="IMAGE_TOO_LARGE")
    if not data:
        raise ValidationError("That file is empty.", error_code="IMAGE_INVALID")

    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        with Image.open(io.BytesIO(data)) as probe:
            if probe.format not in ALLOWED_FORMATS:
                raise ValidationError(
                    "Upload a JPEG, PNG, WebP or GIF image.", error_code="IMAGE_TYPE"
                )
            probe.verify()
        # `verify` leaves the image unusable; open it again to read the pixels.
        with Image.open(io.BytesIO(data)) as source:
            image = ImageOps.exif_transpose(source)
            image.thumbnail((MAX_EDGE, MAX_EDGE))
            image = image.convert("RGBA" if image.mode in ("RGBA", "LA", "P") else "RGB")
            out = io.BytesIO()
            image.save(out, format="WEBP", quality=86, method=5)
    except ValidationError:
        raise
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError):
        raise ValidationError(
            "That file is not an image we can use.", error_code="IMAGE_INVALID"
        ) from None

    name = f"{secrets.token_hex(16)}.webp"
    (upload_root() / "products" / name).write_bytes(out.getvalue())

    return ok({"url": f"/uploads/products/{name}"}, message="Image uploaded.")
