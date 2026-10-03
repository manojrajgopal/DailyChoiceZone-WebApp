"""
Providers' signing keys, and verifying an id token with them.

Keys are cached per URL for an hour. A token signed with a key id the cache
doesn't know triggers one refetch (providers rotate keys), at most once every
five minutes per URL, so a stream of forged tokens with made-up key ids can't
turn this server into a load generator against the provider.

What is checked, in order: the header's algorithm is one this provider uses
(never `none`, never HS256 with a public key as the secret), the key id is
one of the provider's, the signature, `exp` (with a minute of clock skew),
`iat`, the audience (our client id), the issuer, and the nonce.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Callable, Dict, Iterable, Optional, Tuple

from jose import ExpiredSignatureError, JWTError, jwt

from app.services.identity import crypto
from app.services.identity.base import INVALID_TOKEN, OAuthError
from app.services.identity.http import get_json

logger = logging.getLogger(__name__)

CACHE_SECONDS = 3600
REFETCH_SECONDS = 300
LEEWAY_SECONDS = 60

_cache: Dict[str, Tuple[float, list]] = {}
_last_fetch: Dict[str, float] = {}
_lock = threading.Lock()


def reset() -> None:
    """Forget every cached key — for tests."""
    with _lock:
        _cache.clear()
        _last_fetch.clear()


def _fetch(url: str) -> list:
    body = get_json(url, "Signing keys")
    keys = [key for key in body.get("keys", []) if isinstance(key, dict) and key.get("kid")]
    with _lock:
        _cache[url] = (time.monotonic(), keys)
        _last_fetch[url] = time.monotonic()
    return keys


def _keys(url: str, kid: str) -> Optional[dict]:
    now = time.monotonic()
    with _lock:
        cached = _cache.get(url)
        last = _last_fetch.get(url, 0.0)
    if cached is None or now - cached[0] > CACHE_SECONDS:
        keys = _fetch(url)
    else:
        keys = cached[1]
    match = next((key for key in keys if key.get("kid") == kid), None)
    if match is None and cached is not None and now - last > REFETCH_SECONDS:
        keys = _fetch(url)  # perhaps rotated since we last looked
        match = next((key for key in keys if key.get("kid") == kid), None)
    return match


def verify_id_token(
    token: str,
    *,
    jwks_url: str,
    audience: str,
    issuers: Iterable[str] = (),
    issuer_check: Optional[Callable[[dict], bool]] = None,
    algorithms: Iterable[str] = ("RS256",),
    nonce_hash: str = "",
) -> dict:
    """The token's claims, or `OAuthError(invalid_token)`. Nothing in it is trusted before this returns."""
    if not token or not isinstance(token, str) or token.count(".") != 2:
        raise OAuthError(INVALID_TOKEN, "No id token in the provider's answer")
    try:
        header = jwt.get_unverified_header(token)
    except JWTError:
        raise OAuthError(INVALID_TOKEN, "The id token's header couldn't be read") from None
    allowed = tuple(algorithms)
    if header.get("alg") not in allowed:
        raise OAuthError(INVALID_TOKEN, f"Unexpected id token algorithm {header.get('alg')!r}")
    key = _keys(jwks_url, str(header.get("kid") or ""))
    if key is None:
        raise OAuthError(INVALID_TOKEN, "The id token was signed with an unknown key")
    try:
        claims = jwt.decode(
            token, key, algorithms=[header["alg"]], audience=audience,
            issuer=tuple(issuers) or None,
            options={"verify_at_hash": False, "leeway": LEEWAY_SECONDS, "require_exp": True, "require_iat": True,
                     "require_sub": True, "verify_iss": bool(tuple(issuers))},
        )
    except ExpiredSignatureError:
        raise OAuthError(INVALID_TOKEN, "The id token has expired") from None
    except JWTError as error:
        # The library's reason (signature, audience, issuer...) is safe to log: no secret is in it.
        raise OAuthError(INVALID_TOKEN, f"The id token didn't verify: {error}"[:200]) from None
    if issuer_check is not None and not issuer_check(claims):
        raise OAuthError(INVALID_TOKEN, "The id token's issuer isn't this provider")
    if nonce_hash:
        if not crypto.same(crypto.sha256(str(claims.get("nonce") or "")), nonce_hash):
            raise OAuthError(INVALID_TOKEN, "The id token's nonce doesn't match this sign-in")
    return claims
