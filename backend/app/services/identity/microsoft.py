"""
Sign in with Microsoft (Entra ID and personal Microsoft accounts): OpenID
Connect, authorization code with PKCE and a nonce.

`MICROSOFT_TENANT` picks who may sign in: `common` (work, school and personal
accounts), `consumers` (personal only), `organizations` (work and school
only), or one directory's tenant id. For the multi-tenant authorities the id
token's issuer names the user's own tenant, so it is checked against the
token's `tid` (https://login.microsoftonline.com/{tid}/v2.0) rather than one
fixed string, and for a single-tenant set-up the tenant must be that one.

Microsoft's `email` claim is not always verified (a work account's address is
whatever an administrator typed). It counts as verified only for personal
accounts (the consumers tenant) or when the token says so (`xms_edov`), so an
unverified address can never be used to reach someone else's account.
"""

from __future__ import annotations

import re
from typing import Optional
from urllib.parse import urlencode

from app.core.config import settings
from app.services.identity import jwks
from app.services.identity.base import INVALID_TOKEN, IdentityProvider, OAuthError, VerifiedClaims
from app.services.identity.http import post_form

BASE = "https://login.microsoftonline.com"
CONSUMERS_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad"
MULTI = {"common", "organizations", "consumers"}
_TENANT = re.compile(r"^[0-9a-fA-F-]{36}$")


class Microsoft(IdentityProvider):
    code = "microsoft"
    label = "Microsoft"

    def __init__(self, client_id: Optional[str] = None, client_secret: Optional[str] = None,
                 tenant: Optional[str] = None):
        self.client_id = settings.MICROSOFT_CLIENT_ID if client_id is None else client_id
        self.client_secret = settings.MICROSOFT_CLIENT_SECRET if client_secret is None else client_secret
        self.tenant = ((settings.MICROSOFT_TENANT if tenant is None else tenant) or "common").strip()

    def configured(self) -> tuple:
        if not (self.client_id and self.client_secret):
            return False, "MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET are not set."
        if self.tenant not in MULTI and not _TENANT.match(self.tenant):
            return False, "MICROSOFT_TENANT must be common, consumers, organizations or a tenant id."
        return True, ""

    def authorization_url(self, *, state: str, nonce: str, code_challenge: str, redirect_uri: str) -> str:
        return f"{BASE}/{self.tenant}/oauth2/v2.0/authorize?" + urlencode({
            "client_id": self.client_id, "redirect_uri": redirect_uri, "response_type": "code",
            "response_mode": "query", "scope": "openid email profile", "state": state, "nonce": nonce,
            "code_challenge": code_challenge, "code_challenge_method": "S256", "prompt": "select_account",
        })

    def issuer_ok(self, claims: dict) -> bool:
        tid = str(claims.get("tid") or "")
        if not _TENANT.match(tid) or claims.get("iss") != f"{BASE}/{tid}/v2.0":
            return False
        if self.tenant == "consumers":
            return tid == CONSUMERS_TENANT
        if self.tenant == "organizations":
            return tid != CONSUMERS_TENANT
        if self.tenant == "common":
            return True
        return tid.lower() == self.tenant.lower()

    def exchange(self, *, code: str, verifier: str, redirect_uri: str, nonce_hash: str,
                 user_hint: Optional[dict] = None) -> VerifiedClaims:
        tokens = post_form(f"{BASE}/{self.tenant}/oauth2/v2.0/token", {
            "grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri,
            "client_id": self.client_id, "client_secret": self.client_secret, "code_verifier": verifier,
            "scope": "openid email profile",
        }, "Microsoft token exchange")
        claims = jwks.verify_id_token(
            tokens.get("id_token", ""), jwks_url=f"{BASE}/{self.tenant}/discovery/v2.0/keys",
            audience=self.client_id, issuer_check=self.issuer_ok, algorithms=("RS256",), nonce_hash=nonce_hash)
        subject = str(claims.get("sub") or "")
        if not subject:
            raise OAuthError(INVALID_TOKEN, "Microsoft's id token has no subject")
        verified = claims.get("tid") == CONSUMERS_TENANT or claims.get("xms_edov") in (True, "true", 1, "1")
        name = str(claims.get("name") or "")
        first, _, last = name.partition(" ")
        return VerifiedClaims(subject=subject, email=str(claims.get("email") or "").strip().lower(),
                              email_verified=bool(verified), name=name, first_name=first, last_name=last,
                              extra={"tid": claims.get("tid")})
