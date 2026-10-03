"""The interface every sign-in provider implements."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


class OAuthError(Exception):
    """
    A sign-in round trip that can't continue.

    `code` is what the storefront's /auth/complete page is told (it shows its
    own friendly wording for each); `message` is for the log and never
    contains a secret, a code or a token.
    """

    def __init__(self, code: str, message: str = "", *, transient: bool = False):
        super().__init__(message or code)
        self.code = code
        self.transient = transient


# The codes the storefront understands. Anything else is shown as "failed".
CANCELLED = "cancelled"
PROVIDER_UNAVAILABLE = "provider_unavailable"
INVALID_STATE = "invalid_state"
INVALID_TOKEN = "invalid_token"
IDENTITY_IN_USE = "identity_in_use"
ACCOUNT_EXISTS = "account_exists"
EMAIL_MISSING = "email_missing"
EMAIL_UNVERIFIED = "email_unverified"
NOT_CONFIGURED = "not_configured"
ACCOUNT_BLOCKED = "account_blocked"
ALREADY_LINKED = "already_linked"
FAILED = "failed"


@dataclass
class VerifiedClaims:
    """What a provider proved about the person — from a verified id token only."""

    subject: str
    email: str = ""
    email_verified: bool = False
    name: str = ""
    first_name: str = ""
    last_name: str = ""
    # Apple: the address is a private relay (…@privaterelay.appleid.com).
    private_email: bool = False
    extra: dict = field(default_factory=dict)


class IdentityProvider:
    """
    One OpenID Connect provider.

    `authorization_url` builds where the browser is sent; `exchange` swaps the
    code for tokens and returns the claims of the **verified** id token. No
    other route into an account exists: nothing the browser says about who it
    is (a name, an email in a form field) is used to find or merge an account.
    """

    code = ""
    label = ""
    # The provider posts its answer back (Apple's form_post) rather than redirecting with a query.
    form_post = False

    def configured(self) -> tuple:
        """(ready, what's missing)."""
        return False, "Not configured."

    def authorization_url(self, *, state: str, nonce: str, code_challenge: str, redirect_uri: str) -> str:
        raise NotImplementedError

    def exchange(self, *, code: str, verifier: str, redirect_uri: str, nonce_hash: str,
                 user_hint: Optional[dict] = None) -> VerifiedClaims:
        """
        The verified claims. `nonce_hash` is the SHA-256 of the nonce sent with
        the authorization request; the id token's `nonce` must hash to it.
        `user_hint` is Apple's first-time `user` form field: a name only, and
        only ever used as a name.
        """
        raise NotImplementedError
