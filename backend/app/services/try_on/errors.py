"""
Every way a try-on can fail, and what each audience is told about it.

A failure is recorded with its code, a badge for the portal, a sentence for
the customer, a sentence for the administrator, whether trying again could
help, and sanitised technical detail. Customers only ever see `customer`;
nothing technical reaches them.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

from app.core.errors import AppError


@dataclass(frozen=True)
class Failure:
    code: str
    badge: str
    customer: str
    admin: str
    retryable: bool
    # What the failure says about the thing that ran it:
    #   request    — this request's input; another credential won't help
    #   credential — this credential (bad, rate-limited); try another
    #   model      — this endpoint; try another model
    #   provider   — the whole platform; try another provider
    #   system     — ours (storage, configuration)
    scope: str = "request"


CATALOGUE = {
    f.code: f
    for f in (
        Failure("invalid_credentials", "Invalid Credentials", "The try-on service is unavailable right now. Please try again later.",
                "The AI service rejected the configured credentials.", True, "credential"),
        Failure("rate_limited", "Rate Limited", "The try-on service is busy right now. Please try again in a few minutes.",
                "This AI service is temporarily busy (rate limit or GPU quota reached for the credential).", True, "credential"),
        Failure("timeout", "Timed Out", "Creating your try-on took too long. Please try again.",
                "Image generation took too long.", True, "model"),
        Failure("unsupported_category", "Unsupported Category", "Try-on isn't available for this item yet.",
                "This AI model does not support the selected clothing type.", False, "request"),
        Failure("invalid_image", "Invalid Image", "We couldn't use that photo. Please upload a JPEG, PNG or WebP image.",
                "The uploaded image format is not supported or the file is damaged.", False, "request"),
        Failure("image_too_large", "Image Too Large", "That photo is too large. Please use a smaller one.",
                "The uploaded image exceeds the allowed size.", False, "request"),
        Failure("image_too_small", "Image Too Small", "That photo is too small. Please use a clearer, larger photo.",
                "The uploaded image is below the minimum dimensions for this try-on.", False, "request"),
        Failure("provider_unavailable", "Provider Unavailable", "The try-on service is temporarily unavailable. Please try again later.",
                "The AI service is temporarily unavailable (down, sleeping or building).", True, "provider"),
        Failure("no_capacity", "No Capacity", "The try-on service is unavailable right now. Please try again later.",
                "No enabled, healthy credential could run this request.", True, "system"),
        Failure("plan_ineligible", "Not Eligible", "Your plan doesn't include virtual try-on.",
                "This subscription does not include Virtual Try-On.", False, "request"),
        Failure("limit_reached", "Limit Reached", "You've reached your virtual try-on limit.",
                "The customer reached their Virtual Try-On limit.", False, "request"),
        Failure("concurrency_limit", "Limit Reached", "You already have try-ons in progress. Please wait for them to finish.",
                "The customer reached their limit of try-ons running at once.", False, "request"),
        Failure("storage_unavailable", "Storage Unavailable", "We couldn't save your try-on just now. Please try again.",
                "Image storage is unavailable or failed.", True, "system"),
        Failure("garment_unavailable", "Product Image Missing", "We couldn't load this item's photo for the try-on.",
                "The product's image could not be fetched or is not usable.", False, "request"),
        Failure("bad_provider_response", "Failed", "Something went wrong creating your try-on. Please try again.",
                "The AI service answered with something that wasn't an image.", True, "model"),
        Failure("cancelled", "Cancelled", "This try-on was cancelled.", "Cancelled by the customer.", False, "request"),
        Failure("expired", "Expired", "This try-on has expired and was removed.", "The result passed its retention period.",
                False, "request"),
        Failure("lease_lost", "Failed", "Something went wrong creating your try-on. Please try again.",
                "The worker running this request stopped before finishing.", True, "system"),
        Failure("unknown", "Failed", "Something went wrong creating your try-on. Please try again.",
                "The failure could not be classified.", True, "model"),
    )
}


def describe(code: str) -> Failure:
    return CATALOGUE.get(code) or CATALOGUE["unknown"]


class TryOnError(AppError):
    """A refusal to a customer, carrying a catalogue code."""

    status_code = 422
    error_code = "TRY_ON_REFUSED"

    def __init__(self, code: str, message: Optional[str] = None, *, status_code: Optional[int] = None,
                 details: Optional[dict] = None):
        failure = describe(code)
        super().__init__(message or failure.customer, error_code=f"TRY_ON_{code.upper()}",
                         details={"reason": code, **(details or {})})
        if status_code:
            self.status_code = status_code
        self.code = code


class ProviderFailure(Exception):
    """What an adapter raises: a catalogue code plus sanitised detail."""

    def __init__(self, code: str, detail: str = "", *, retry_after: Optional[int] = None):
        super().__init__(code)
        self.code = code
        self.detail = sanitize(detail)
        self.retry_after = retry_after

    @property
    def failure(self) -> Failure:
        return describe(self.code)


# ------------------------------------------------------------- sanitising

_PATTERNS = [
    (re.compile(r"hf_[A-Za-z0-9]{6,}"), "hf_•••"),
    (re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]+"), "Bearer •••"),
    (re.compile(r"(?i)(token|key|secret|signature|x-amz-[a-z-]+)=([^&\s\"']+)"), r"\1=•••"),
    (re.compile(r"https?://[^\s\"'<>]+"), lambda m: m.group(0).split("?")[0]),
    # Filesystem paths, Windows and POSIX.
    (re.compile(r"[A-Za-z]:\\[^\s\"'<>]+"), "<path>"),
    (re.compile(r"(?<![\w.])/(?:tmp|var|home|root|usr|opt|app|private|Users|mnt|srv)/[^\s\"'<>]*"), "<path>"),
]


def sanitize(text: object, limit: int = 500) -> str:
    """Technical detail safe to store and show administrators: no secrets, links or paths."""
    value = str(text or "")
    for pattern, replacement in _PATTERNS:
        value = pattern.sub(replacement, value)
    value = " ".join(value.split())
    return value[:limit]
