"""Sign in with Google: OpenID Connect, authorization code with PKCE and a nonce."""

from __future__ import annotations

from typing import Optional
from urllib.parse import urlencode

from app.core.config import settings
from app.services.identity import jwks
from app.services.identity.base import INVALID_TOKEN, IdentityProvider, OAuthError, VerifiedClaims
from app.services.identity.http import post_form

AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
ISSUERS = ("https://accounts.google.com", "accounts.google.com")


class Google(IdentityProvider):
    code = "google"
    label = "Google"

    def __init__(self, client_id: Optional[str] = None, client_secret: Optional[str] = None):
        self.client_id = settings.GOOGLE_CLIENT_ID if client_id is None else client_id
        self.client_secret = settings.GOOGLE_CLIENT_SECRET if client_secret is None else client_secret

    def configured(self) -> tuple:
        if not (self.client_id and self.client_secret):
            return False, "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set."
        return True, ""

    def authorization_url(self, *, state: str, nonce: str, code_challenge: str, redirect_uri: str) -> str:
        return AUTHORIZE_URL + "?" + urlencode({
            "client_id": self.client_id, "redirect_uri": redirect_uri, "response_type": "code",
            "scope": "openid email profile", "state": state, "nonce": nonce,
            "code_challenge": code_challenge, "code_challenge_method": "S256",
            "prompt": "select_account", "access_type": "online",
        })

    def exchange(self, *, code: str, verifier: str, redirect_uri: str, nonce_hash: str,
                 user_hint: Optional[dict] = None) -> VerifiedClaims:
        tokens = post_form(TOKEN_URL, {
            "grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri,
            "client_id": self.client_id, "client_secret": self.client_secret, "code_verifier": verifier,
        }, "Google token exchange")
        claims = jwks.verify_id_token(tokens.get("id_token", ""), jwks_url=JWKS_URL, audience=self.client_id,
                                      issuers=ISSUERS, algorithms=("RS256",), nonce_hash=nonce_hash)
        subject = str(claims.get("sub") or "")
        if not subject:
            raise OAuthError(INVALID_TOKEN, "Google's id token has no subject")
        verified = claims.get("email_verified")
        return VerifiedClaims(
            subject=subject,
            email=str(claims.get("email") or "").strip().lower(),
            email_verified=verified is True or str(verified).lower() == "true",
            name=str(claims.get("name") or ""),
            first_name=str(claims.get("given_name") or ""),
            last_name=str(claims.get("family_name") or ""),
        )
