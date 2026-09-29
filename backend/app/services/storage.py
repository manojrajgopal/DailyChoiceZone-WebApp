"""
File storage: Amazon S3.

Nothing is ever written to this server's disk. An uploaded file goes straight
to an S3 bucket and the database keeps only its public address.

Storage switches itself on when the credentials are present in the
environment — no code changes:

    AWS_ACCESS_KEY_ID       the IAM user's access key
    AWS_SECRET_ACCESS_KEY   and its secret
    AWS_S3_BUCKET           the bucket
    AWS_REGION              e.g. ap-south-1 (Mumbai); defaults to ap-south-1

Optional:

    AWS_S3_PUBLIC_URL       the address files are served from, if not the
                            bucket's own — a CloudFront distribution, say
    AWS_S3_ENDPOINT_URL     an S3-compatible service instead of AWS
    AWS_S3_PREFIX           folder inside the bucket; defaults to "products"

Without the first three, `is_configured()` is False: the upload endpoint
refuses, and the product form offers "paste an image address" only.

The bucket must let the public read these files — a bucket policy granting
`s3:GetObject` on the prefix (see backend/README.md). Objects are written
without ACLs, which new buckets reject by default.
"""

from __future__ import annotations

import logging
from functools import lru_cache
from typing import Optional

from app.core.config import settings
from app.core.errors import AppError

logger = logging.getLogger(__name__)


class StorageUnavailableError(AppError):
    status_code = 503
    error_code = "UPLOADS_DISABLED"


class StorageFailedError(AppError):
    status_code = 502
    error_code = "UPLOAD_FAILED"


def is_configured() -> bool:
    """True when the credentials and bucket are set."""
    return bool(
        settings.AWS_ACCESS_KEY_ID
        and settings.AWS_SECRET_ACCESS_KEY
        and settings.AWS_S3_BUCKET
    )


@lru_cache(maxsize=4)
def _client(key_id: str, secret: str, region: str, endpoint: Optional[str]):
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        aws_access_key_id=key_id,
        aws_secret_access_key=secret,
        region_name=region,
        endpoint_url=endpoint or None,
        # Never hang a request on a slow bucket.
        config=Config(connect_timeout=5, read_timeout=20, retries={"max_attempts": 2}),
    )


def public_url(key: str) -> str:
    """The address a stored file is served at."""
    if settings.AWS_S3_PUBLIC_URL:
        base = settings.AWS_S3_PUBLIC_URL.rstrip("/")
    elif settings.AWS_S3_ENDPOINT_URL:
        base = f"{settings.AWS_S3_ENDPOINT_URL.rstrip('/')}/{settings.AWS_S3_BUCKET}"
    else:
        base = f"https://{settings.AWS_S3_BUCKET}.s3.{settings.AWS_REGION}.amazonaws.com"
    return f"{base}/{key}"


def put_file(data: bytes, name: str, content_type: str) -> str:
    """
    Store `data` as `<prefix>/<name>` and return its public address.

    `name` must already be safe — the caller generates it; nothing an uploader
    chose is used as a key.
    """
    if not is_configured():
        raise StorageUnavailableError(
            "Photo upload isn't available yet. Please paste an image link instead."
        )

    prefix = (settings.AWS_S3_PREFIX or "").strip("/")
    key = f"{prefix}/{name}" if prefix else name

    try:
        _client(
            settings.AWS_ACCESS_KEY_ID,
            settings.AWS_SECRET_ACCESS_KEY,
            settings.AWS_REGION,
            settings.AWS_S3_ENDPOINT_URL,
        ).put_object(
            Bucket=settings.AWS_S3_BUCKET,
            Key=key,
            Body=data,
            ContentType=content_type,
            # Every upload gets a new random name, so a file never changes.
            CacheControl="public, max-age=31536000, immutable",
        )
    except Exception:  # botocore raises a wide family; the log keeps the detail
        logger.exception("Could not store %s in bucket %s", key, settings.AWS_S3_BUCKET)
        raise StorageFailedError(
            "We couldn't save that photo just now. Please try again."
        ) from None

    return public_url(key)
