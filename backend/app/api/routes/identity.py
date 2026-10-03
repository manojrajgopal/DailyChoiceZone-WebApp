"""
Customer sign-in beyond the password: social login, one-time codes, linked
accounts and signed-in devices. See docs/authentication.md.

Public:
    GET  /api/auth/methods                         what the sign-in page offers
    GET  /api/auth/oauth/{provider}/start          302 to Google / Apple / Microsoft
    GET  /api/auth/oauth/{provider}/callback       the provider's answer (POST too: Apple's form_post)
    POST /api/auth/oauth/complete                  the one-time code -> token
    POST /api/auth/otp/request                     send a sign-in code (SMS or email)
    POST /api/auth/otp/verify                      sign in with it (or get a sign-up token)
    POST /api/auth/otp/signup                      create the account the code was for

Signed in:
    POST /api/auth/session/refresh                 a fresh token for the same session
    GET  /api/account/security                     the Security section in one read
    GET  /api/account/identities                   linked accounts
    POST /api/account/identities/{provider}/link   start connecting one
    DELETE /api/account/identities/{id}            disconnect (never the last way in)
    POST /api/account/phone/otp | /phone/verify    add or change the sign-in mobile number
    DELETE /api/account/phone
    POST /api/account/password/otp | /password/set a first password, proved by an email code
    GET  /api/account/sessions                     signed-in devices
    DELETE /api/account/sessions/{id}              sign one out
    POST /api/account/sessions/revoke-others       sign out everywhere else

Portal (permission "auth-settings", super admin unless granted):
    GET/PUT /api/admin/auth/methods                switch methods on and off
"""

from __future__ import annotations

import json
from typing import Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import RedirectResponse
from pydantic import EmailStr, Field, field_validator
from sqlalchemy.orm import Session

from app.core import rate_limit
from app.core.config import settings
from app.core.database import get_db
from app.core.errors import AuthenticationError, NotFoundError
from app.dependencies.auth import client_ip, get_current_customer, require_access, token_claims
from app.models import AdminUser, Customer, CustomerSession
from app.schemas.auth import CustomerOut, password_strength
from app.schemas.base import CamelModel
from app.services import otp, sessions
from app.services.identity import accounts, methods, oauth
from app.services.identity.base import OAuthError
from app.utils.response import ok

router = APIRouter(prefix="/auth", tags=["Authentication"])
account_router = APIRouter(prefix="/account", tags=["Customers"])
admin_router = APIRouter(prefix="/admin/auth", tags=["Authentication"])

auth_settings = require_access("auth-settings")

# The same answer whether or not the number or address has an account.
CODE_SENT = "If that's yours, a code is on its way."


def _agent(request: Request) -> str:
    return request.headers.get("user-agent", "")[:300]


def _api_base(request: Request) -> str:
    return (settings.PUBLIC_API_URL or str(request.base_url)).rstrip("/") + settings.API_PREFIX


def redirect_uri(request: Request, provider: str) -> str:
    """Where the provider sends the browser back. Register exactly this with the provider."""
    return f"{_api_base(request)}/auth/oauth/{provider}/callback"


def _session_payload(customer: Customer, token) -> dict:
    return {"token": token.model_dump(by_alias=True),
            "customer": CustomerOut.from_model(customer).model_dump(by_alias=True)}


# ----------------------------------------------------------------- schemas


class OtpRequestIn(CamelModel):
    channel: str = Field(max_length=8)
    destination: str = Field(min_length=3, max_length=255)
    purpose: str = Field(default="login", max_length=20)


class OtpVerifyIn(CamelModel):
    challenge_id: str = Field(min_length=1, max_length=32)
    code: str = Field(min_length=1, max_length=12)


class OtpSignupIn(CamelModel):
    signup_token: str = Field(min_length=10, max_length=2000)
    first_name: str = Field(min_length=1, max_length=80)
    last_name: str = Field(default="", max_length=80)
    email: Optional[EmailStr] = None
    referral_code: Optional[str] = Field(default=None, max_length=32)
    marketing_opt_in: Optional[bool] = None


class HandoffIn(CamelModel):
    code: str = Field(min_length=1, max_length=200)


class LinkIn(CamelModel):
    next: str = Field(default="", max_length=300)


class PhoneIn(CamelModel):
    phone: str = Field(min_length=6, max_length=20)


class SetPasswordIn(CamelModel):
    challenge_id: str = Field(min_length=1, max_length=32)
    code: str = Field(min_length=1, max_length=12)
    new_password: str = Field(min_length=8, max_length=72)

    @field_validator("new_password")
    @classmethod
    def _strength(cls, value: str) -> str:
        return password_strength(value)


# ------------------------------------------------------------------ methods


@router.get("/methods", summary="The sign-in methods on offer")
def sign_in_methods(db: Session = Depends(get_db)):
    return ok(methods.public(db))


@router.post("/session/refresh", summary="A fresh token for this signed-in session")
def refresh_session(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer),
                    claims: dict = Depends(token_claims)):
    token = sessions.refresh(db, customer, claims)
    if token is None:
        raise AuthenticationError("Sign in again to continue.", error_code="SESSION_REFRESH_UNAVAILABLE")
    db.commit()
    return ok({"token": token.model_dump(by_alias=True)})


# -------------------------------------------------------------------- OAuth


def _cookie_args(request: Request, provider: str) -> dict:
    secure = request.url.scheme == "https" or settings.is_production
    # Apple posts its answer from its own site: only a SameSite=None cookie
    # (which must be Secure) comes with it. Everyone else redirects: Lax.
    samesite = "none" if provider == "apple" and secure else "lax"
    return {"httponly": True, "secure": secure, "samesite": samesite, "path": oauth.COOKIE_PATH}


@router.get("/oauth/{provider}/start", summary="Begin signing in with Google, Apple or Microsoft")
def oauth_start(
    provider: str,
    request: Request,
    next: str = Query("", max_length=300),
    mode: str = Query("login", max_length=8),
    ticket: str = Query("", max_length=200),
    db: Session = Depends(get_db),
):
    provider = provider.lower()[:20]
    rate_limit.check(f"oauth-start:ip:{client_ip(request)}", limit=30, window_seconds=600,
                     message="Too many sign-in attempts. Please wait a few minutes.")
    try:
        url, cookie = oauth.begin(db, provider, mode="link" if mode == "link" else "login", next_path=next,
                                  ticket=ticket, redirect_uri=redirect_uri(request, provider), ip=client_ip(request))
    except OAuthError as error:
        return RedirectResponse(oauth.storefront_url(error=error.code, mode="link" if mode == "link" else ""),
                                status_code=303)
    response = RedirectResponse(url, status_code=302)
    response.set_cookie(oauth.cookie_name(provider), cookie, max_age=oauth.STATE_MINUTES * 60,
                        **_cookie_args(request, provider))
    return response


def _finish(request: Request, db: Session, provider: str, fields: dict) -> RedirectResponse:
    provider = provider.lower()[:20]
    hint = None
    raw_user = fields.get("user")
    if raw_user:
        try:
            hint = json.loads(raw_user) if isinstance(raw_user, str) and len(raw_user) < 4000 else None
        except ValueError:
            hint = None
    target = oauth.callback(
        db, provider, state=str(fields.get("state") or "")[:200], auth_code=str(fields.get("code") or "")[:2000],
        error=str(fields.get("error") or "")[:80], cookie=request.cookies.get(oauth.cookie_name(provider), ""),
        redirect_uri=redirect_uri(request, provider), user_hint=hint if isinstance(hint, dict) else None,
    )
    # 303: the storefront page is fetched with GET even after Apple's POST.
    response = RedirectResponse(target, status_code=303)
    response.delete_cookie(oauth.cookie_name(provider), path=oauth.COOKIE_PATH)
    return response


@router.get("/oauth/{provider}/callback", summary="Where the provider sends the browser back", include_in_schema=False)
def oauth_callback(provider: str, request: Request, db: Session = Depends(get_db)):
    return _finish(request, db, provider, dict(request.query_params))


@router.post("/oauth/{provider}/callback", summary="Apple's form_post answer", include_in_schema=False)
async def oauth_callback_post(provider: str, request: Request, db: Session = Depends(get_db)):
    from starlette.concurrency import run_in_threadpool

    try:
        form = await request.form()
        fields = {key: value for key, value in form.items() if isinstance(value, str)}
    except Exception:  # noqa: BLE001 — a body that isn't a form is treated as an empty one
        fields = {}
    return await run_in_threadpool(_finish, request, db, provider, fields)


@router.post("/oauth/complete", summary="Exchange the one-time sign-in code for a session")
def oauth_complete(payload: HandoffIn, request: Request, db: Session = Depends(get_db)):
    rate_limit.check(f"oauth-complete:ip:{client_ip(request)}", limit=30, window_seconds=600)
    customer, token, created = oauth.complete(db, payload.code, ip=client_ip(request), user_agent=_agent(request))
    return ok({**_session_payload(customer, token), "created": created},
              message="Welcome to Daily Choice Zone." if created else "Signed in.")


# ---------------------------------------------------------------- codes


@router.post("/otp/request", summary="Send a one-time sign-in code")
def otp_request(payload: OtpRequestIn, request: Request, db: Session = Depends(get_db)):
    from app.core.errors import AuthorizationError, ValidationError

    channel = payload.channel.lower()
    if payload.purpose not in ("login", "signup"):
        raise ValidationError("That isn't something a code can be used for.", error_code="OTP_PURPOSE_INVALID")
    method = {"sms": "mobileOtp", "email": "emailOtp"}.get(channel)
    if method is None:
        raise ValidationError("Choose SMS or email.", error_code="OTP_CHANNEL_INVALID")
    if not methods.enabled(db, method):
        raise AuthorizationError("Signing in with a code isn't available right now.", error_code="AUTH_METHOD_DISABLED")
    issued = otp.request(db, channel=channel, destination=payload.destination,
                         purpose="login" if channel == "sms" else "login-email", ip=client_ip(request))
    return ok(issued, message=CODE_SENT)


@router.post("/otp/verify", summary="Sign in with a one-time code")
def otp_verify(payload: OtpVerifyIn, request: Request, db: Session = Depends(get_db)):
    rate_limit.check(f"otp-verify:ip:{client_ip(request)}", limit=60, window_seconds=900,
                     message="Too many attempts. Please wait a few minutes and try again.")
    result = accounts.otp_sign_in(db, payload.challenge_id, payload.code, ip=client_ip(request),
                                  user_agent=_agent(request))
    if result["status"] == "signed-in":
        return ok({"status": "signed-in", **_session_payload(result["customer"], result["token"])}, message="Signed in.")
    return ok(result, message="That's confirmed. Tell us your name to finish creating your account.")


@router.post("/otp/signup", status_code=201, summary="Create the account a verified code was for")
def otp_signup(payload: OtpSignupIn, request: Request, db: Session = Depends(get_db)):
    rate_limit.check(f"otp-signup:ip:{client_ip(request)}", limit=10, window_seconds=900)
    customer, token = accounts.otp_sign_up(
        db, payload.signup_token, first_name=payload.first_name, last_name=payload.last_name,
        email=str(payload.email or ""), referral_code=payload.referral_code, marketing_opt_in=payload.marketing_opt_in,
        ip=client_ip(request), user_agent=_agent(request))
    return ok(_session_payload(customer, token), message="Welcome to Daily Choice Zone.")


# ------------------------------------------------------- linked accounts


@account_router.get("/security", summary="Your sign-in methods, linked accounts and phone")
def security(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    return ok(accounts.security(db, customer))


@account_router.get("/identities", summary="Your connected sign-in accounts")
def list_identities(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    return ok([accounts.view(row) for row in accounts.identities(db, customer) if row.provider != accounts.PHONE])


@account_router.post("/identities/{provider}/link", summary="Start connecting Google, Apple or Microsoft")
def link_identity(provider: str, request: Request, payload: Optional[LinkIn] = None,
                  db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    from app.core.errors import ValidationError

    rate_limit.check(f"oauth-link:{customer.id}", limit=10, window_seconds=600)
    code = provider.lower()[:20]
    try:
        ticket = oauth.link_ticket(db, customer, code, (payload.next if payload else "") or "/account/settings")
    except OAuthError:
        raise ValidationError("That sign-in provider isn't available.", error_code="PROVIDER_UNAVAILABLE") from None
    from urllib.parse import urlencode

    url = f"{_api_base(request)}/auth/oauth/{code}/start?" + urlencode({"mode": "link", "ticket": ticket})
    return ok({"url": url})


@account_router.delete("/identities/{identity_id}", summary="Disconnect a sign-in account")
def unlink_identity(identity_id: int, db: Session = Depends(get_db),
                    customer: Customer = Depends(get_current_customer)):
    accounts.unlink(db, customer, identity_id)
    return ok(accounts.security(db, customer), message="Disconnected.")


# ------------------------------------------------------------------- phone


@account_router.post("/phone/otp", summary="Send a code to add or change your sign-in mobile number")
def phone_code(payload: PhoneIn, request: Request, db: Session = Depends(get_db),
               customer: Customer = Depends(get_current_customer)):
    issued = accounts.request_phone_code(db, customer, payload.phone, ip=client_ip(request))
    return ok(issued, message=f"We've sent a code to {issued['destination']}.")


@account_router.post("/phone/verify", summary="Confirm your sign-in mobile number with the code")
def phone_verify(payload: OtpVerifyIn, db: Session = Depends(get_db),
                 customer: Customer = Depends(get_current_customer)):
    updated = accounts.verify_phone(db, customer, payload.challenge_id, payload.code)
    return ok(accounts.security(db, updated), message="Your mobile number is confirmed.")


@account_router.delete("/phone", summary="Remove your sign-in mobile number")
def phone_remove(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    accounts.remove_phone(db, customer)
    return ok(accounts.security(db, customer), message="Mobile number removed.")


# ------------------------------------------------------- confirming email


@account_router.post("/email/code", summary="Email a code to confirm your email address")
def email_code(request: Request, db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    issued = accounts.request_email_code(db, customer, ip=client_ip(request))
    if issued is None:
        return ok({"alreadyVerified": True}, message="Your email address is already confirmed.")
    return ok({**issued, "alreadyVerified": False}, message=f"We've emailed a code to {issued['destination']}.")


@account_router.post("/email/verify-code", summary="Confirm your email address with the emailed code")
def email_verify_code(payload: OtpVerifyIn, db: Session = Depends(get_db),
                      customer: Customer = Depends(get_current_customer)):
    updated = accounts.verify_email_code(db, customer, payload.challenge_id, payload.code)
    return ok(CustomerOut.from_model(updated).model_dump(by_alias=True), message="Your email address is confirmed.")


# --------------------------------------------------------------- passwords


@account_router.post("/password/otp", summary="Email a code to set a first password")
def password_code(request: Request, db: Session = Depends(get_db),
                  customer: Customer = Depends(get_current_customer)):
    issued = accounts.request_password_code(db, customer, ip=client_ip(request))
    return ok(issued, message=f"We've emailed a code to {issued['destination']}.")


@account_router.post("/password/set", summary="Set a first password with the emailed code")
def password_set(payload: SetPasswordIn, request: Request, db: Session = Depends(get_db),
                 customer: Customer = Depends(get_current_customer), claims: dict = Depends(token_claims)):
    token = accounts.set_password(db, customer, payload.challenge_id, payload.code, payload.new_password, claims,
                                  ip=client_ip(request), user_agent=_agent(request))
    return ok({"token": token.model_dump(by_alias=True)}, message="Your password is set.")


# ---------------------------------------------------------------- sessions


@account_router.get("/sessions", summary="Where you're signed in")
def list_sessions(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer),
                  claims: dict = Depends(token_claims)):
    return ok(sessions.active(db, customer, claims.get("sid")))


@account_router.delete("/sessions/{session_id}", summary="Sign out one device")
def revoke_session(session_id: str, db: Session = Depends(get_db),
                   customer: Customer = Depends(get_current_customer), claims: dict = Depends(token_claims)):
    row = db.get(CustomerSession, session_id[:32])
    if row is None or row.customer_id != customer.id or row.revoked_at is not None:
        raise NotFoundError("That session wasn't found.", error_code="SESSION_NOT_FOUND")
    sessions.revoke(db, row, "revoked")
    accounts.audit(db, customer, "session_revoked", f"Signed out a device ({row.device or 'unknown'})")
    db.commit()
    current = row.id == claims.get("sid")
    return ok({"signedOut": current}, message="You've been signed out." if current else "That device is signed out.")


@account_router.post("/sessions/revoke-others", summary="Sign out of every other device")
def revoke_other_sessions(request: Request, db: Session = Depends(get_db),
                          customer: Customer = Depends(get_current_customer), claims: dict = Depends(token_claims)):
    count, token = sessions.sign_out_everywhere_else(db, customer, claims, ip=client_ip(request),
                                                     user_agent=_agent(request))
    accounts.audit(db, customer, "sessions_revoked", "Signed out of every other device", count=count)
    db.commit()
    return ok({"revoked": count, "token": token.model_dump(by_alias=True)},
              message="You've been signed out everywhere else.")


# ------------------------------------------------------------------ portal


@admin_router.get("/methods", summary="Sign-in methods: which are on, which are configured")
def admin_methods(request: Request, db: Session = Depends(get_db), admin: AdminUser = Depends(auth_settings)):
    return ok({"methods": methods.admin_view(db, f"{_api_base(request)}/auth/oauth"),
               "signupVerification": methods.signup_verification(db), "summary": summary_view(db)})


@admin_router.put("/methods", summary="Switch sign-in methods on or off")
def save_admin_methods(payload: dict, request: Request, db: Session = Depends(get_db),
                       admin: AdminUser = Depends(auth_settings)):
    from app.services import audit

    before = {**methods._switches(db), "signupVerification": methods.signup_verification(db)}
    saved = methods.save(db, payload)
    audit.record(db, "auth_methods.update", resource_type="settings", resource_id="auth_methods", actor=admin,
                 summary=f"{admin.name} changed the sign-in methods", changes=audit.diff(before, saved))
    db.commit()
    return ok({"methods": methods.admin_view(db, f"{_api_base(request)}/auth/oauth"),
               "signupVerification": methods.signup_verification(db)}, message="Sign-in methods saved.")


def summary_view(db: Session) -> dict:
    from app.services.identity import summary

    return summary(db)
