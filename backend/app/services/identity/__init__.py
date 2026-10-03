"""
Signing customers in with someone else's account: Google, Apple, Microsoft.

See docs/authentication.md. The pieces:

- `base.py`: the `IdentityProvider` interface, `VerifiedClaims`, `OAuthError`.
- `http.py`: the one HTTP client (a test swaps its transport; nothing else
  reaches the network).
- `jwks.py`: fetching and caching providers' signing keys, and verifying an
  id token (signature, algorithm, issuer, audience, expiry, nonce).
- `google.py`, `microsoft.py`, `apple.py`: the providers.
- `registry.py`: which providers exist and which are configured.
- `methods.py`: the store's "auth_methods" switches (which sign-in methods
  the storefront offers).
- `oauth.py`: the round trip (start, callback, handoff) and the rules for
  finding, linking or creating the account.
- `accounts.py`: the customer's linked accounts and the "last way in" rule.

Adding a provider (Facebook is the next one): one module implementing
`IdentityProvider`, one entry in `registry.PROVIDERS`, one switch in
`methods.METHODS`. Nothing else changes.
"""


def summary(db) -> dict:
    """Headline numbers for the admin dashboard: today's sign-ins by method, codes, provider failures."""
    from app.services import otp, sessions
    from app.services.identity import oauth

    by_method = sessions.count_today(db)
    codes = otp.counts_today(db)
    return {
        "signInsToday": sum(by_method.values()),
        "signInsByMethod": by_method,
        "otpSentToday": codes["sent"],
        "otpVerifiedToday": codes["verified"],
        "otpSendFailuresToday": codes["sendFailures"],
        "oauthFailuresToday": oauth.failures_today(db),
    }
