"""
The one HTTP client the sign-in providers use.

`TRANSPORT` is None in the application (httpx's real transport). The tests set
it to an `httpx.MockTransport`, so token endpoints and signing keys are
answered locally and nothing leaves the machine.
"""

from __future__ import annotations

import logging
from typing import Optional

import httpx

from app.core.config import settings
from app.services.identity.base import PROVIDER_UNAVAILABLE, OAuthError

logger = logging.getLogger(__name__)

TRANSPORT: Optional[httpx.BaseTransport] = None


def client() -> httpx.Client:
    timeout = float(getattr(settings, "OAUTH_HTTP_TIMEOUT_SECONDS", 10) or 10)
    return httpx.Client(timeout=timeout, transport=TRANSPORT) if TRANSPORT is not None else httpx.Client(timeout=timeout)


def _json(response: httpx.Response, what: str) -> dict:
    try:
        body = response.json()
    except ValueError:
        raise OAuthError(PROVIDER_UNAVAILABLE, f"{what}: the answer wasn't JSON (HTTP {response.status_code})",
                         transient=response.status_code >= 500) from None
    if not isinstance(body, dict):
        raise OAuthError(PROVIDER_UNAVAILABLE, f"{what}: unexpected answer")
    return body


def post_form(url: str, data: dict, what: str) -> dict:
    """POST a form, return the JSON. Error text never includes what was sent (it carries secrets)."""
    try:
        with client() as http:
            response = http.post(url, data=data, headers={"Accept": "application/json"})
    except httpx.HTTPError as error:
        raise OAuthError(PROVIDER_UNAVAILABLE, f"{what}: couldn't reach the provider ({type(error).__name__})",
                         transient=True) from None
    body = _json(response, what)
    if response.status_code >= 400:
        # `error` / `error_description` are the provider's words, never our secrets.
        reason = str(body.get("error") or f"HTTP {response.status_code}")[:80]
        transient = response.status_code >= 500 or response.status_code == 429
        raise OAuthError(PROVIDER_UNAVAILABLE if transient else "failed", f"{what}: {reason}", transient=transient)
    return body


def get_json(url: str, what: str) -> dict:
    try:
        with client() as http:
            response = http.get(url, headers={"Accept": "application/json"})
    except httpx.HTTPError as error:
        raise OAuthError(PROVIDER_UNAVAILABLE, f"{what}: couldn't reach the provider ({type(error).__name__})",
                         transient=True) from None
    if response.status_code >= 400:
        raise OAuthError(PROVIDER_UNAVAILABLE, f"{what}: HTTP {response.status_code}", transient=True)
    return _json(response, what)
