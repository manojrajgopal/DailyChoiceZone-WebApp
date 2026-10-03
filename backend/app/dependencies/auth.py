"""Who is calling, and what they are allowed to do."""

from __future__ import annotations

from typing import Optional

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import AuthenticationError, AuthorizationError
from app.core.security import decode_access_token
from app.models import AdminUser, Customer

# `auto_error=False` so a missing header reaches our own handler and returns
# the project's error envelope rather than FastAPI's bare `{"detail": ...}`.
bearer = HTTPBearer(auto_error=False)


def _claims(credentials: Optional[HTTPAuthorizationCredentials]) -> dict:
    if credentials is None or not credentials.credentials:
        raise AuthenticationError("Sign in to continue.")

    payload = decode_access_token(credentials.credentials)
    if payload is None:
        raise AuthenticationError("Your session has expired. Sign in again.", error_code="TOKEN_INVALID")

    return payload


def get_current_customer(
    credentials: HTTPAuthorizationCredentials = Depends(bearer),
    db: Session = Depends(get_db),
) -> Customer:
    """
    The signed-in customer.

    The `actor` claim is checked, not just the signature: an administrator's
    token is a valid token, and without this check it would satisfy a customer
    endpoint and read somebody else's cart.
    """
    payload = _claims(credentials)

    if payload.get("actor") != "customer":
        raise AuthorizationError("This endpoint is for customer accounts.")

    customer = db.get(Customer, payload.get("sub"))
    if customer is None:
        raise AuthenticationError("That account no longer exists.")

    # Checked on every request, not only at login: blocking someone has to take
    # effect immediately, not whenever their token happens to expire.
    if customer.status != "active":
        raise AuthorizationError("This account has been suspended.", error_code="ACCOUNT_BLOCKED")

    if _issued_before_password_change(payload, customer):
        raise AuthenticationError("Your password was changed. Sign in again.", error_code="TOKEN_INVALID")

    # The signed-in session the token belongs to: signed out, signed out
    # everywhere, or expired ends it now (see `services.sessions`).
    from app.services import sessions

    refused = sessions.problem(db, payload, customer)
    if refused is not None:
        raise AuthenticationError(refused[1], error_code=refused[0])

    return customer


def get_optional_customer(
    credentials: HTTPAuthorizationCredentials = Depends(bearer),
    db: Session = Depends(get_db),
) -> Optional[Customer]:
    """
    The customer if there is one, None otherwise.

    For endpoints that work signed out but do more when signed in. Never raises
    — an invalid token is treated as no token, because the alternative is a
    browsing session that breaks when something expires.
    """
    if credentials is None or not credentials.credentials:
        return None

    payload = decode_access_token(credentials.credentials)
    if payload is None or payload.get("actor") != "customer":
        return None

    customer = db.get(Customer, payload.get("sub"))
    if customer is None or customer.status != "active" or _issued_before_password_change(payload, customer):
        return None
    from app.services import sessions

    if sessions.problem(db, payload, customer) is not None:
        return None
    return customer


def token_claims(credentials: HTTPAuthorizationCredentials = Depends(bearer)) -> dict:
    """The verified token's claims ({} without a valid one) — for routes that need its session id."""
    if credentials is None or not credentials.credentials:
        return {}
    return decode_access_token(credentials.credentials) or {}


def _issued_before_password_change(payload: dict, customer: Customer) -> bool:
    """
    A token issued before the password was last reset.

    Tokens are stateless, so "sign out everywhere" is a timestamp: resetting a
    password stamps `password_changed_at`, and anything issued before that
    second stops working — the device that was used by whoever the reset was
    meant to lock out included.
    """
    changed = getattr(customer, "password_changed_at", None)
    if changed is None:
        return False
    import calendar

    return int(payload.get("iat") or 0) < calendar.timegm(changed.utctimetuple())


def get_current_admin(
    credentials: HTTPAuthorizationCredentials = Depends(bearer),
    db: Session = Depends(get_db),
) -> AdminUser:
    """The signed-in administrator."""
    payload = _claims(credentials)

    if payload.get("actor") != "admin":
        raise AuthorizationError("Administrator access is required.")

    admin = db.get(AdminUser, payload.get("sub"))
    if admin is None:
        raise AuthenticationError("That account no longer exists.")

    if admin.status != "active":
        raise AuthorizationError("This account has been suspended.", error_code="ACCOUNT_BLOCKED")

    return admin


def require_permission(permission: str):
    """
    A dependency that also checks one permission.

    Used on the endpoints where the role genuinely matters — managing other
    administrators, changing settings. **Authorisation is enforced here, in the
    backend.** The portal hides buttons a role cannot use, which is a courtesy
    to the person using it and not a security boundary; this is the boundary.
    """

    def dependency(admin: AdminUser = Depends(get_current_admin)) -> AdminUser:
        # A super admin is not enumerated in every permission list; the role
        # carries it, which keeps the lists short and the intent obvious.
        if admin.role == "super-admin":
            return admin

        if permission not in (admin.permissions or []):
            raise AuthorizationError(
                f"Your role does not include '{permission}'.",
                error_code="PERMISSION_DENIED",
            )

        return admin

    return dependency


def require_access(permission: str):
    """
    Like `require_permission`, for areas added after administrators were set up.

    An administrator's stored `permissions` is a copy of their role's list,
    taken when the role was assigned — so a permission added to a role later
    (payments, shipping, carts…) would reach nobody until each account was
    re-saved. This accepts the stored list **or** the role's current one; the
    role table in `core.permissions` stays the single source of what a role
    may do. Checked on the server, like every permission.
    """

    def dependency(admin: AdminUser = Depends(get_current_admin)) -> AdminUser:
        from app.core.permissions import permissions_for

        if admin.role == "super-admin":
            return admin
        if permission in (admin.permissions or []) or permission in permissions_for(admin.role):
            return admin
        raise AuthorizationError(f"Your role does not include '{permission}'.", error_code="PERMISSION_DENIED")

    return dependency


def client_ip(request: Request) -> str:
    """
    The caller's address, for rate limits and audit notes.

    `X-Forwarded-For` is only believed when the connection comes from a
    trusted proxy (`TRUSTED_PROXIES`): anyone else could set it to dodge a
    per-address limit. Read right to left, skipping trusted proxies, the
    first other address is the client — the left-most entries are whatever
    the caller chose to send.
    """
    from app.core.config import settings

    peer = request.client.host if request.client else ""
    trusted = set(settings.TRUSTED_PROXIES)
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded and peer in trusted:
        hops = [hop.strip() for hop in forwarded.split(",") if hop.strip()]
        for hop in reversed(hops):
            if hop not in trusted:
                return hop
        if hops:
            return hops[0]
    return peer or "unknown"
