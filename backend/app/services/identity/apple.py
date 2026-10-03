"""
Sign in with Apple.

Different from the others in four ways, all handled here:

- **The answer is posted back** (`response_mode=form_post`, required when the
  name or email is asked for). The callback is a cross-site POST, so Apple's
  browser-binding cookie is `SameSite=None; Secure` (see `oauth`).
- **The client secret is a JWT** signed with the team's Sign in with Apple key
  (ES256): issuer the team id, subject the Services ID, audience Apple, valid
  five minutes. It is made per request and never stored.
- **The email may be a private relay** (`...@privaterelay.appleid.com`). It
  is a real, verified address that forwards to the person, but they can turn
  it off, so an account is never found by it later: only by Apple's `sub`.
- **The name arrives once**, on the first sign-in, in the `user` form field.
  That field is unsigned, so it is used as a display name and nothing else.

Apple doesn't document PKCE for the web flow, so none is sent. The state
(single use, bound to the browser), the nonce inside the signed id token and
the signed client secret protect the exchange.
"""

from __future__ import annotations

import time
from typing import Optional
from urllib.parse import urlencode

from jose import JWTError, jwt

from app.core.config import settings
from app.services.identity import jwks
from app.services.identity.base import INVALID_TOKEN, NOT_CONFIGURED, IdentityProvider, OAuthError, VerifiedClaims
from app.services.identity.http import post_form

AUTHORIZE_URL = "https://appleid.apple.com/auth/authorize"
TOKEN_URL = "https://appleid.apple.com/auth/token"
JWKS_URL = "https://appleid.apple.com/auth/keys"
ISSUER = "https://appleid.apple.com"
RELAY_DOMAIN = "privaterelay.appleid.com"


class Apple(IdentityProvider):
    code = "apple"
    label = "Apple"
    form_post = True

    def __init__(self, client_id: Optional[str] = None, team_id: Optional[str] = None,
                 key_id: Optional[str] = None, private_key: Optional[str] = None):
        self.client_id = settings.APPLE_CLIENT_ID if client_id is None else client_id
        self.team_id = settings.APPLE_TEAM_ID if team_id is None else team_id
        self.key_id = settings.APPLE_KEY_ID if key_id is None else key_id
        raw = settings.APPLE_PRIVATE_KEY if private_key is None else private_key
        self.private_key = (raw or "").replace("\\n", "\n").strip()

    def configured(self) -> tuple:
        missing = [name for name, value in (("APPLE_CLIENT_ID", self.client_id), ("APPLE_TEAM_ID", self.team_id),
                                            ("APPLE_KEY_ID", self.key_id), ("APPLE_PRIVATE_KEY", self.private_key))
                   if not value]
        if missing:
            return False, f"{', '.join(missing)} {'is' if len(missing) == 1 else 'are'} not set."
        return True, ""

    def client_secret(self, now: Optional[int] = None) -> str:
        issued = int(now if now is not None else time.time())
        try:
            return jwt.encode({"iss": self.team_id, "iat": issued, "exp": issued + 300, "aud": ISSUER,
                               "sub": self.client_id}, self.private_key, algorithm="ES256",
                              headers={"kid": self.key_id})
        except (JWTError, ValueError, TypeError, Exception):  # noqa: BLE001 — the key is never put in the message
            raise OAuthError(NOT_CONFIGURED, "APPLE_PRIVATE_KEY isn't a valid ES256 (.p8) private key") from None

    def authorization_url(self, *, state: str, nonce: str, code_challenge: str, redirect_uri: str) -> str:
        return AUTHORIZE_URL + "?" + urlencode({
            "client_id": self.client_id, "redirect_uri": redirect_uri, "response_type": "code",
            "response_mode": "form_post", "scope": "name email", "state": state, "nonce": nonce,
        })

    def exchange(self, *, code: str, verifier: str, redirect_uri: str, nonce_hash: str,
                 user_hint: Optional[dict] = None) -> VerifiedClaims:
        tokens = post_form(TOKEN_URL, {
            "grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri,
            "client_id": self.client_id, "client_secret": self.client_secret(),
        }, "Apple token exchange")
        claims = jwks.verify_id_token(tokens.get("id_token", ""), jwks_url=JWKS_URL, audience=self.client_id,
                                      issuers=(ISSUER,), algorithms=("RS256", "ES256"), nonce_hash=nonce_hash)
        subject = str(claims.get("sub") or "")
        if not subject:
            raise OAuthError(INVALID_TOKEN, "Apple's id token has no subject")
        email = str(claims.get("email") or "").strip().lower()
        verified = claims.get("email_verified")
        private = claims.get("is_private_email") in (True, "true") or email.endswith("@" + RELAY_DOMAIN)
        first = last = ""
        name = user_hint.get("name") if isinstance(user_hint, dict) else None
        if isinstance(name, dict):
            first = str(name.get("firstName") or "").strip()[:80]
            last = str(name.get("lastName") or "").strip()[:80]
        return VerifiedClaims(subject=subject, email=email,
                              email_verified=verified is True or str(verified).lower() == "true",
                              name=f"{first} {last}".strip(), first_name=first, last_name=last,
                              private_email=private)
