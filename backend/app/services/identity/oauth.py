"""
The sign-in round trip to Google, Apple or Microsoft.

```
storefront ──► GET /api/auth/oauth/{p}/start?next=      (sets a browser cookie, 302 to the provider)
provider   ──► GET|POST /api/auth/oauth/{p}/callback     (state + code; Apple POSTs)
           ──► 302 STOREFRONT/auth/complete?code=<one-time>   (never a token in a URL)
storefront ──► POST /api/auth/oauth/complete {code}      (→ token + customer)
```

## The state

Every trip is one `OAuthState` row: the SHA-256 of the `state` sent to the
provider, the SHA-256 of the nonce (which the signed id token must carry),
the PKCE verifier sealed, and the SHA-256 of a random value set in an
HttpOnly cookie on the browser that started it. The callback is refused when
the state is missing, unknown, expired (10 minutes), already used, or arrives
in a browser without that cookie — the last is what stops someone tricking a
victim into finishing a sign-in the attacker started (login CSRF). A state is
marked used the moment it is presented, whether or not what follows works.

## Linking

A signed-in customer can't send their bearer token on a top-level navigation,
so linking takes one more step: `POST /api/account/identities/{p}/link`
(authenticated) creates the trip with a one-time ticket, and the storefront
navigates to `/start?mode=link&ticket=` within two minutes. The ticket is
single use and only starts a trip; the callback still needs the cookie.

## Which account

See `accounts` for the rules; in short: the provider's subject finds a linked
account; otherwise a verified provider email links to an account whose own
email is verified; an unverified match is refused (sign in first, then
connect); a new verified email creates an account.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import secrets
from datetime import datetime, timedelta
from typing import Optional
from urllib.parse import urlencode

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import AuthenticationError
from app.models import Customer, OAuthState
from app.services.identity import accounts, crypto, methods, registry
from app.services.identity.base import (
    ACCOUNT_BLOCKED,
    ACCOUNT_EXISTS,
    CANCELLED,
    EMAIL_MISSING,
    EMAIL_UNVERIFIED,
    FAILED,
    INVALID_STATE,
    NOT_CONFIGURED,
    IdentityProvider,
    OAuthError,
    VerifiedClaims,
)

logger = logging.getLogger(__name__)

STATE_MINUTES = 10
TICKET_SECONDS = 120
HANDOFF_SECONDS = 120
COOKIE_PREFIX = "dcz_oauth_"
COOKIE_PATH = "/api/auth/oauth"


def _now() -> datetime:
    return datetime.utcnow().replace(microsecond=0)


def cookie_name(code: str) -> str:
    return f"{COOKIE_PREFIX}{code}"


def safe_next(path: Optional[str]) -> str:
    """A path on the storefront, or nothing: never another site."""
    path = (path or "").strip()
    if not path.startswith("/") or path.startswith("//") or "\\" in path or len(path) > 300:
        return ""
    return path


def storefront_url(**params) -> str:
    query = urlencode({k: v for k, v in params.items() if v})
    return f"{settings.STOREFRONT_URL.rstrip('/')}/auth/complete" + (f"?{query}" if query else "")


def provider_for(db: Session, code: str) -> IdentityProvider:
    provider = registry.get(code)
    if provider is None or not provider.configured()[0] or not methods.enabled(db, provider.code):
        raise OAuthError(NOT_CONFIGURED, f"{code} sign-in isn't available")
    return provider


def _challenge(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


# ------------------------------------------------------------------ start


def link_ticket(db: Session, customer: Customer, code: str, next_path: str = "") -> str:
    """A one-time ticket that starts a linking trip for this signed-in customer. Commits."""
    provider = provider_for(db, code)
    ticket = secrets.token_urlsafe(32)
    now = _now()
    db.add(OAuthState(provider=provider.code, mode="link", ticket_hash=crypto.sha256(ticket),
                      verifier_sealed=crypto.seal({}), customer_id=customer.id,
                      next_path=safe_next(next_path) or "/account/settings", created_at=now,
                      expires_at=now + timedelta(seconds=TICKET_SECONDS)))
    db.commit()
    return ticket


def begin(db: Session, code: str, *, mode: str = "login", next_path: str = "", ticket: str = "",
          redirect_uri: str, ip: str = "") -> tuple:
    """Start a trip. Returns (provider authorization URL, cookie value). Commits."""
    provider = provider_for(db, code)
    now = _now()
    if mode == "link":
        row = db.execute(select(OAuthState).where(OAuthState.ticket_hash == crypto.sha256(ticket or ""))
                         .with_for_update()).scalar_one_or_none() if ticket else None
        if row is None or row.mode != "link" or row.provider != provider.code or row.started_at is not None \
                or row.expires_at <= now:
            raise OAuthError(INVALID_STATE, "The link ticket is missing, used or expired")
    else:
        row = OAuthState(provider=provider.code, mode="login", verifier_sealed="", created_at=now,
                         next_path=safe_next(next_path), expires_at=now)
        db.add(row)
    state, nonce, verifier, cookie = (secrets.token_urlsafe(32), secrets.token_urlsafe(32),
                                      secrets.token_urlsafe(48), secrets.token_urlsafe(32))
    row.state_hash = crypto.sha256(state)
    row.nonce_hash = crypto.sha256(nonce)
    row.verifier_sealed = crypto.seal({"v": verifier})
    row.browser_hash = crypto.sha256(cookie)
    row.ip_hash = crypto.ip_hash(ip)
    row.started_at = now
    row.outcome = "started"
    row.expires_at = now + timedelta(minutes=STATE_MINUTES)
    db.commit()
    url = provider.authorization_url(state=state, nonce=nonce, code_challenge=_challenge(verifier),
                                     redirect_uri=redirect_uri)
    return url, cookie


# --------------------------------------------------------------- callback


def _resolve(db: Session, provider: str, claims: VerifiedClaims) -> tuple:
    """(customer, created) for a sign-in, by the rules in `accounts`."""
    identity = accounts.identity_for(db, provider, claims.subject)
    if identity is not None:
        customer = db.get(Customer, identity.customer_id)
        if customer is None or customer.status != "active":
            raise OAuthError(ACCOUNT_BLOCKED, "The linked account is suspended")
        identity.last_login_at = _now()
        if claims.email:
            identity.provider_email = claims.email[:255]
            identity.email_verified = claims.email_verified
        return customer, False
    if not claims.email:
        raise OAuthError(EMAIL_MISSING, "The provider shared no email address")
    existing = accounts.customer_by_email(db, claims.email)
    if existing is not None:
        # An Apple private relay address is never a way into an account: only Apple's `sub` is
        # (see `apple`). The person signs in to that account first and connects Apple from there.
        if claims.private_email:
            raise OAuthError(ACCOUNT_EXISTS, "An account with this email exists; sign in to it first to connect")
        if existing.status != "active":
            raise OAuthError(ACCOUNT_BLOCKED, "The account with this email is suspended")
        if claims.email_verified and existing.email_verified_at is not None:
            # Both sides have proved the address: the same person.
            accounts.link(db, existing, provider, claims)
            return existing, False
        raise OAuthError(ACCOUNT_EXISTS, "An account with this email exists; sign in to it first to connect")
    if not claims.email_verified:
        raise OAuthError(EMAIL_UNVERIFIED, "The provider hasn't verified this email address")
    customer = accounts.create_customer(db, email=claims.email, first_name=claims.first_name or claims.name,
                                        last_name=claims.last_name, email_verified=True,
                                        how=provider.capitalize())
    accounts.add_identity(db, customer, provider, claims.subject, email=claims.email, email_verified=True,
                          name=claims.name)
    from app.services import accounts as account_links

    account_links.send_welcome(db, customer)
    accounts.audit(db, customer, "signup", f"{customer.email} created an account with "
                                           f"{registry.LABELS.get(provider, provider)}", method=provider)
    return customer, True


def _fail(db: Session, state_hash: Optional[str], error: OAuthError, mode: str = "") -> str:
    db.rollback()
    if state_hash:
        row = db.execute(select(OAuthState).where(OAuthState.state_hash == state_hash)).scalar_one_or_none()
        if row is not None:
            row.consumed_at = row.consumed_at or _now()
            row.outcome = "failed"
            row.error_code = error.code[:40]
            mode = mode or row.mode
            db.commit()
    logger.info("Sign-in with a provider didn't complete: %s (%s)", error.code, error)
    return storefront_url(error=error.code, mode=mode if mode == "link" else "")


def callback(db: Session, code: str, *, state: str, auth_code: str, error: str, cookie: str,
             redirect_uri: str, user_hint: Optional[dict] = None) -> str:
    """Finish a trip. Returns where to send the browser on the storefront. Commits."""
    state_hash = crypto.sha256(state) if state else None
    mode = ""
    try:
        if not state_hash:
            raise OAuthError(INVALID_STATE, "No state in the callback")
        row = db.execute(select(OAuthState).where(OAuthState.state_hash == state_hash).with_for_update()
                         ).scalar_one_or_none()
        if row is None or row.provider != code:
            raise OAuthError(INVALID_STATE, "Unknown state")
        mode = row.mode
        if row.consumed_at is not None:
            raise OAuthError(INVALID_STATE, "This state has already been used")
        row.consumed_at = _now()
        db.commit()  # single use, whatever happens next
        if row.expires_at <= datetime.utcnow():
            raise OAuthError(INVALID_STATE, "The state has expired")
        if not cookie or not crypto.same(crypto.sha256(cookie), row.browser_hash):
            raise OAuthError(INVALID_STATE, "The callback came from a different browser")
        if error:
            raise OAuthError(CANCELLED if error in ("access_denied", "user_cancelled_authorize", "consent_required")
                             else FAILED, f"The provider answered {error[:40]}")
        if not auth_code:
            raise OAuthError(INVALID_STATE, "No code in the callback")
        provider = provider_for(db, code)
        verifier = crypto.unseal(row.verifier_sealed).get("v", "")
        claims = provider.exchange(code=auth_code, verifier=verifier, redirect_uri=redirect_uri,
                                   nonce_hash=row.nonce_hash, user_hint=user_hint)
        if row.mode == "link":
            customer = db.get(Customer, row.customer_id) if row.customer_id else None
            if customer is None or customer.status != "active":
                raise OAuthError(ACCOUNT_BLOCKED, "The account being linked is gone or suspended")
            accounts.link(db, customer, code, claims)
            row.outcome = "linked"
            db.commit()
            return storefront_url(linked=code, next=row.next_path or "/account/settings")
        customer, created = _resolve(db, code, claims)
        handoff = secrets.token_urlsafe(32)
        row.handoff_hash = crypto.sha256(handoff)
        row.handoff_customer_id = customer.id
        row.handoff_expires_at = _now() + timedelta(seconds=HANDOFF_SECONDS)
        row.created_account = created
        row.outcome = "signed-in"
        db.commit()
        return storefront_url(code=handoff, next=row.next_path)
    except OAuthError as failure:
        return _fail(db, state_hash, failure, mode)


# ---------------------------------------------------------------- handoff


def complete(db: Session, handoff: str, *, ip: str = "", user_agent: str = "") -> tuple:
    """Exchange the one-time code for a session: (customer, token, created). Commits."""
    invalid = AuthenticationError("This sign-in link has expired. Please sign in again.",
                                  error_code="OAUTH_CODE_INVALID")
    if not handoff or len(handoff) > 200:
        raise invalid
    row = db.execute(select(OAuthState).where(OAuthState.handoff_hash == crypto.sha256(handoff))
                     .with_for_update()).scalar_one_or_none()
    if row is None or row.handoff_used_at is not None or row.handoff_expires_at is None \
            or row.handoff_expires_at <= datetime.utcnow():
        raise invalid
    row.handoff_used_at = _now()
    customer = db.get(Customer, row.handoff_customer_id) if row.handoff_customer_id else None
    if customer is None:
        db.commit()
        raise invalid
    token = accounts.sign_in(db, customer, row.provider, ip=ip, user_agent=user_agent, alert=not row.created_account)
    db.commit()
    db.refresh(customer)
    return customer, token, row.created_account


# ----------------------------------------------------------------- upkeep


def cleanup(db: Session, older_than_hours: int = 24) -> int:
    cutoff = datetime.utcnow() - timedelta(hours=older_than_hours)
    rows = db.execute(select(OAuthState).where(OAuthState.expires_at < cutoff)).scalars().all()
    for row in rows:
        db.delete(row)
    return len(rows)


def failures_today(db: Session) -> int:
    start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    return int(db.execute(select(func.count()).select_from(OAuthState)
                          .where(OAuthState.created_at >= start, OAuthState.outcome == "failed")).scalar_one())
