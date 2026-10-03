"""
One customer, many ways in.

A customer is one `Customer` row, whatever they signed in with. The ways in:

- a password (`customers.password_hash`, NULL until set);
- a verified mobile number (a `phone` identity, E.164, unique);
- a linked Google, Apple or Microsoft account (an identity per provider);
- an email code to the account's address (when the store offers it).

## Merging rules

- **Never on an unverified value.** A provider's email links to an existing
  account only when the provider says it is verified *and* the account's own
  address has been verified. Otherwise the person is asked to sign in to that
  account first and connect the provider from Settings → Security.
- **A verified phone that belongs to another account is refused**, never
  moved.
- An identity already linked to another account is refused.

## The last way in

Unlinking a provider or removing the phone is refused when it would leave no
way in: a password, a verified phone or another linked account. (An email
code isn't counted: the store can switch it off.)
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Optional

from jose import JWTError, jwt
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import AuthenticationError, AuthorizationError, ConflictError, NotFoundError
from app.models import Customer, CustomerIdentity
from app.schemas.auth import TokenOut
from app.services import sessions
from app.services.identity import crypto
from app.services.identity.registry import LABELS
from app.utils.ids import next_id

logger = logging.getLogger(__name__)

SIGNUP_MINUTES = 15
PHONE = "phone"


def _now() -> datetime:
    return datetime.utcnow().replace(microsecond=0)


# ---------------------------------------------------------------- lookups


def identity_for(db: Session, provider: str, subject: str) -> Optional[CustomerIdentity]:
    return db.execute(select(CustomerIdentity).where(CustomerIdentity.provider == provider,
                                                     CustomerIdentity.provider_user_id == subject)
                      ).scalar_one_or_none()


def identities(db: Session, customer: Customer) -> list:
    return list(db.execute(select(CustomerIdentity).where(CustomerIdentity.customer_id == customer.id)
                           .order_by(CustomerIdentity.created_at)).scalars())


def customer_by_email(db: Session, email: str) -> Optional[Customer]:
    return db.execute(select(Customer).where(func.lower(Customer.email) == (email or "").strip().lower())
                      ).scalar_one_or_none()


def phone_identity(db: Session, customer: Customer) -> Optional[CustomerIdentity]:
    return db.execute(select(CustomerIdentity).where(CustomerIdentity.customer_id == customer.id,
                                                     CustomerIdentity.provider == PHONE)).scalar_one_or_none()


def ways_in(db: Session, customer: Customer, *, without: Optional[int] = None) -> int:
    """How many ways into the account there would be, leaving out identity `without`."""
    count = 1 if customer.password_hash else 0
    for identity in identities(db, customer):
        if identity.id != without and (identity.provider != PHONE or identity.verified_at is not None):
            count += 1
    return count


# ---------------------------------------------------------------- creating


def create_customer(db: Session, *, email: str, first_name: str = "", last_name: str = "", phone: str = "",
                    email_verified: bool = False) -> Customer:
    """A new account with no password. The caller commits."""
    now = datetime.utcnow()
    customer = Customer(
        id=next_id(db, Customer, "customer"), email=email.strip().lower(), password_hash=None,
        first_name=(first_name or "").strip()[:80], last_name=(last_name or "").strip()[:80],
        phone=(phone or "")[:20], status="active", joined_at=now,
        email_verified_at=now if email_verified else None,
    )
    db.add(customer)
    db.flush()
    return customer


def add_identity(db: Session, customer: Customer, provider: str, subject: str, *, email: str = "",
                 email_verified: bool = False, name: str = "", verified: bool = True) -> CustomerIdentity:
    now = _now()
    identity = CustomerIdentity(customer_id=customer.id, provider=provider, provider_user_id=subject[:255],
                                provider_email=(email or "")[:255], email_verified=bool(email_verified),
                                display_name=(name or "")[:160], verified_at=now if verified else None,
                                created_at=now, last_login_at=None)
    db.add(identity)
    try:
        with db.begin_nested():
            db.flush()
    except IntegrityError:
        # Someone else claimed it between the check and the insert.
        raise ConflictError("That sign-in is already connected to another account.",
                            error_code="IDENTITY_IN_USE") from None
    return identity


# ----------------------------------------------------------- notifications


def notify(db: Session, customer: Customer, event: str, *, subject: str, title: str, body: str,
           provider: str = "") -> None:
    """An account-security email (cannot be opted out of). The caller commits."""
    import html as html_lib

    from app.services import email as email_service

    base = settings.STOREFRONT_URL.rstrip("/")
    name = html_lib.escape(customer.first_name or "there")
    email_service.notify(
        db, "account_security", to=customer.email, customer_id=customer.id, subject=subject,
        html=email_service.layout(title, f"Hello {name}, {html_lib.escape(body)}",
                                  cta=("Review your security settings", f"{base}/account/settings")),
        text=f"{title}. {body} Review: {base}/account/settings", reference=event, event=event,
        variables={"account_url": f"{base}/account/settings", "provider_name": provider},
    )


def audit(db: Session, customer: Customer, action: str, summary: str, **details) -> None:
    from app.services import audit as audit_service

    audit_service.record(db, f"customer_auth.{action}", resource_type="customer", resource_id=customer.id,
                         actor=customer, summary=summary[:300], details=details or None)


# ---------------------------------------------------------------- sign in


def sign_in(db: Session, customer: Customer, method: str, *, ip: str = "", user_agent: str = "",
            alert: bool = True) -> TokenOut:
    """A successful sign-in by any method: session, token, sign-in alert, audit. The caller commits."""
    if customer.status != "active":
        raise AuthorizationError("This account has been suspended. Contact support.", error_code="ACCOUNT_BLOCKED")
    customer.last_login_at = datetime.utcnow()
    token = sessions.issue(db, customer, method, ip=ip, user_agent=user_agent)
    if alert:
        from app.services import auth as auth_service

        auth_service._login_alert(db, customer, method)
    audit(db, customer, "login", f"{customer.full_name or customer.email} signed in "
                                 f"({sessions.METHOD_LABELS.get(method, method)})", method=method)
    return token


# ---------------------------------------------------- OTP sign-in and sign-up


def _signup_token(channel: str, destination: str, challenge_id: str) -> str:
    return jwt.encode({"purpose": "otp-signup", "ch": channel, "d": crypto.seal({"d": destination}),
                       "jti": challenge_id, "exp": datetime.utcnow() + timedelta(minutes=SIGNUP_MINUTES)},
                      settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def _read_signup_token(token: str) -> tuple:
    try:
        claims = jwt.decode(token or "", settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
    except JWTError:
        claims = {}
    destination = crypto.unseal(claims.get("d", "")).get("d", "") if claims.get("purpose") == "otp-signup" else ""
    if not destination or claims.get("ch") not in ("sms", "email"):
        raise AuthenticationError("This sign-up has expired. Ask for a new code.", error_code="SIGNUP_EXPIRED")
    return claims["ch"], destination


def otp_sign_in(db: Session, challenge_id: str, code: str, *, ip: str = "", user_agent: str = "") -> dict:
    """
    Verify a sign-in code. An existing account is signed in; a number or
    address without one gets a short-lived sign-up token instead (the code
    has just proved ownership, so no second code is needed).
    """
    from app.services import otp

    challenge, destination = otp.verify(db, challenge_id, code, purposes={"login", "login-email"})
    if challenge.channel == "sms":
        identity = identity_for(db, PHONE, destination)
        customer = db.get(Customer, identity.customer_id) if identity else None
        method = "otp-sms"
    else:
        customer = customer_by_email(db, destination)
        method = "otp-email"
    if customer is None:
        db.commit()
        return {"status": "signup-required", "signupToken": _signup_token(challenge.channel, destination, challenge.id),
                "channel": challenge.channel, "destination": challenge.destination_masked}
    if customer.status != "active":
        db.commit()  # the code is used either way
        raise AuthorizationError("This account has been suspended. Contact support.", error_code="ACCOUNT_BLOCKED")
    if challenge.channel == "sms":
        identity.last_login_at = _now()
    elif customer.email_verified_at is None:
        customer.email_verified_at = datetime.utcnow()  # the code just proved they receive mail there
    token = sign_in(db, customer, method, ip=ip, user_agent=user_agent)
    db.commit()
    db.refresh(customer)
    return {"status": "signed-in", "customer": customer, "token": token}


def otp_sign_up(db: Session, signup_token: str, *, first_name: str, last_name: str = "", email: str = "",
                referral_code: Optional[str] = None, marketing_opt_in: Optional[bool] = None, ip: str = "",
                user_agent: str = "") -> tuple:
    """
    Create the account a verified code was for.

    By phone: an email address is asked for too (receipts and invoices need
    one). It starts unverified and a confirmation link is sent; an address
    that already has an account is refused, never merged. By email: the code
    already proved the address.
    """
    from app.services import accounts as account_links

    channel, destination = _read_signup_token(signup_token)
    if channel == "sms":
        if identity_for(db, PHONE, destination) is not None:
            raise ConflictError("That mobile number already has an account. Sign in with a code instead.",
                                error_code="PHONE_IN_USE")
        address = (email or "").strip().lower()
        if not address:
            from app.core.errors import ValidationError

            raise ValidationError("Enter your email address for receipts and order updates.",
                                  error_code="EMAIL_REQUIRED")
        if customer_by_email(db, address) is not None:
            raise ConflictError("An account already uses that email. Sign in to it, then add your mobile number "
                                "in Settings → Security.", error_code="EMAIL_TAKEN")
        customer = create_customer(db, email=address, first_name=first_name, last_name=last_name,
                                   phone=destination, email_verified=False)
        customer.phone_verified_at = datetime.utcnow()
        add_identity(db, customer, PHONE, destination)
        account_links.send_verification(db, customer)
        method = "otp-sms"
    else:
        if customer_by_email(db, destination) is not None:
            raise ConflictError("That email already has an account. Sign in with a code instead.",
                                error_code="EMAIL_TAKEN")
        customer = create_customer(db, email=destination, first_name=first_name, last_name=last_name,
                                   email_verified=True)
        account_links.send_welcome(db, customer)
        method = "otp-email"
    if referral_code:
        from app.services import referrals

        referrals.attach_at_signup(db, customer, referral_code, ip)
    if marketing_opt_in is not None:
        from app.services.messaging import service as messaging

        messaging.set_consent(db, customer.id, "email", "marketing", bool(marketing_opt_in), source="signup")
    audit(db, customer, "signup", f"{customer.email} created an account with a one-time code", method=method)
    token = sign_in(db, customer, method, ip=ip, user_agent=user_agent, alert=False)
    db.commit()
    db.refresh(customer)
    return customer, token


# ------------------------------------------------------------- phone number


def request_phone_code(db: Session, customer: Customer, phone: str, *, ip: str = "") -> dict:
    from app.services import otp

    purpose = "change-phone" if phone_identity(db, customer) is not None else "verify-phone"
    return otp.request(db, channel="sms", destination=phone, purpose=purpose, ip=ip, customer=customer)


def verify_phone(db: Session, customer: Customer, challenge_id: str, code: str) -> Customer:
    """Make the verified number this account's sign-in phone (replacing the old one)."""
    from app.services import otp

    challenge, number = otp.verify(db, challenge_id, code, purposes={"verify-phone", "change-phone"},
                                   customer=customer)
    owner = identity_for(db, PHONE, number)
    if owner is not None and owner.customer_id != customer.id:
        db.commit()  # the code is spent either way
        raise ConflictError("That mobile number is already used by another account.", error_code="PHONE_IN_USE")
    current = phone_identity(db, customer)
    if owner is None:
        if current is not None:
            db.delete(current)
            db.flush()
        add_identity(db, customer, PHONE, number)
    customer.phone = number[:20]
    customer.phone_verified_at = datetime.utcnow()
    notify(db, customer, "phone_verified", subject="Your mobile number is confirmed",
           title="Your mobile number is confirmed",
           body=f"the number {challenge.destination_masked} is now confirmed on your account and can be used to "
                "sign in. If this wasn't you, contact us straight away.")
    audit(db, customer, "phone_verified", f"Confirmed mobile number {challenge.destination_masked}")
    db.commit()
    db.refresh(customer)
    return customer


def remove_phone(db: Session, customer: Customer) -> None:
    identity = phone_identity(db, customer)
    if identity is None:
        raise NotFoundError("There's no sign-in mobile number on your account.", error_code="PHONE_NOT_FOUND")
    if ways_in(db, customer, without=identity.id) == 0:
        raise ConflictError("This is your only way to sign in. Set a password or connect another account first.",
                            error_code="LAST_SIGN_IN_METHOD")
    db.delete(identity)
    customer.phone_verified_at = None
    audit(db, customer, "phone_removed", "Removed the sign-in mobile number")
    db.commit()


# --------------------------------------------------------- linked accounts


def view(identity: CustomerIdentity) -> dict:
    return {"id": identity.id, "provider": identity.provider, "label": LABELS.get(identity.provider, identity.provider),
            "email": identity.provider_email, "linkedAt": identity.created_at, "lastUsedAt": identity.last_login_at}


def link(db: Session, customer: Customer, provider: str, claims) -> CustomerIdentity:
    """Connect a verified provider account to this (signed-in) customer. The caller commits."""
    from app.services.identity.base import ALREADY_LINKED, IDENTITY_IN_USE, OAuthError

    existing = identity_for(db, provider, claims.subject)
    if existing is not None:
        if existing.customer_id != customer.id:
            raise OAuthError(IDENTITY_IN_USE, "That provider account belongs to another customer")
        return existing
    mine = db.execute(select(CustomerIdentity).where(CustomerIdentity.customer_id == customer.id,
                                                     CustomerIdentity.provider == provider)).scalar_one_or_none()
    if mine is not None:
        raise OAuthError(ALREADY_LINKED, "Another account of this provider is already connected")
    try:
        identity = add_identity(db, customer, provider, claims.subject, email=claims.email,
                                email_verified=claims.email_verified, name=claims.name)
    except ConflictError:
        raise OAuthError(IDENTITY_IN_USE, "That provider account belongs to another customer") from None
    label = LABELS.get(provider, provider)
    notify(db, customer, "identity_linked", subject=f"{label} is now connected to your account",
           title=f"{label} connected", provider=label,
           body=f"your {label} account was connected, so you can now sign in with it. If this wasn't you, "
                "disconnect it from your security settings and change your password.")
    audit(db, customer, "identity_linked", f"Connected {label}", provider=provider)
    return identity


def unlink(db: Session, customer: Customer, identity_id: int) -> None:
    identity = db.get(CustomerIdentity, identity_id)
    # Not yours looks exactly like not there.
    if identity is None or identity.customer_id != customer.id or identity.provider == PHONE:
        raise NotFoundError("That connected account wasn't found.", error_code="IDENTITY_NOT_FOUND")
    if ways_in(db, customer, without=identity.id) == 0:
        raise ConflictError("This is your only way to sign in. Set a password or add a mobile number first.",
                            error_code="LAST_SIGN_IN_METHOD")
    label = LABELS.get(identity.provider, identity.provider)
    db.delete(identity)
    notify(db, customer, "identity_unlinked", subject=f"{label} was disconnected from your account",
           title=f"{label} disconnected", provider=label,
           body=f"your {label} account can no longer be used to sign in. If this wasn't you, change your "
                "password straight away.")
    audit(db, customer, "identity_unlinked", f"Disconnected {label}", provider=identity.provider)
    db.commit()


def security(db: Session, customer: Customer) -> dict:
    """The Security section of the account settings, in one read."""
    from app.services.identity import methods

    rows = identities(db, customer)
    phone = next((row for row in rows if row.provider == PHONE), None)
    offered = methods.public(db)
    linked = {row.provider for row in rows}
    return {
        "email": customer.email,
        "emailVerified": customer.email_verified_at is not None,
        "phone": phone.provider_user_id if phone else "",
        "phoneVerified": phone is not None and phone.verified_at is not None,
        "contactPhone": customer.phone or "",
        "hasPassword": bool(customer.password_hash),
        "identities": [view(row) for row in rows if row.provider != PHONE],
        "providers": [{**p, "linked": p["code"] in linked} for p in offered["providers"]],
        "mobileOtp": offered["mobileOtp"],
        "waysIn": ways_in(db, customer),
    }


# --------------------------------------------------- confirming an email


def request_email_code(db: Session, customer: Customer, *, ip: str = "") -> Optional[dict]:
    """A code to confirm the account's email address; None when it's already confirmed."""
    from app.services import otp

    if customer.email_verified_at is not None:
        return None
    return otp.request(db, channel="email", destination=customer.email, purpose="verify-email", ip=ip,
                       customer=customer)


def verify_email_code(db: Session, customer: Customer, challenge_id: str, code: str) -> Customer:
    """Confirm the address with the code (the alternative to the emailed link)."""
    from app.services import accounts as account_links
    from app.services import otp

    _challenge, address = otp.verify(db, challenge_id, code, purposes={"verify-email"}, customer=customer)
    if address.lower() != (customer.email or "").lower():
        db.commit()
        raise ConflictError("That code was for a different email address.", error_code="OTP_INVALID")
    if customer.email_verified_at is None:
        customer.email_verified_at = datetime.utcnow()
        account_links.send_welcome(db, customer)
        audit(db, customer, "email_verified", "Confirmed the email address with a code")
    db.commit()
    db.refresh(customer)
    return customer


# -------------------------------------------------------------- passwords


def request_password_code(db: Session, customer: Customer, *, ip: str = "") -> dict:
    """An email code to the account's address, to set a first password."""
    from app.services import otp

    if customer.password_hash:
        raise ConflictError("You already have a password. Change it with your current one.",
                            error_code="PASSWORD_ALREADY_SET")
    return otp.request(db, channel="email", destination=customer.email, purpose="sensitive-action", ip=ip,
                       customer=customer)


def set_password(db: Session, customer: Customer, challenge_id: str, code: str, new_password: str,
                 claims: dict, *, ip: str = "", user_agent: str = "") -> TokenOut:
    """A first password for an account that had none, proved with an email code. Other devices are signed out."""
    from app.core.security import hash_password
    from app.services import otp

    if customer.password_hash:
        raise ConflictError("You already have a password. Change it with your current one.",
                            error_code="PASSWORD_ALREADY_SET")
    otp.verify(db, challenge_id, code, purposes={"sensitive-action"}, customer=customer)
    now = _now()
    customer.password_hash = hash_password(new_password)
    customer.password_changed_at = now
    if customer.email_verified_at is None:
        customer.email_verified_at = now
    token = _keep_this_device(db, customer, claims, "password-changed", ip=ip, user_agent=user_agent)
    from app.services import auth as auth_service

    auth_service.notify_password_changed(db, customer)
    audit(db, customer, "password_set", "Set a password")
    db.commit()
    return token


def _keep_this_device(db: Session, customer: Customer, claims: dict, reason: str, *, ip: str = "",
                      user_agent: str = "") -> TokenOut:
    """Revoke every other session; a fresh token for this one (a new session if it had none)."""
    mine = sessions.current(db, claims, customer)
    keep = mine.id if mine is not None and mine.revoked_at is None else None
    sessions.revoke_all(db, customer, reason, keep=keep)
    session = mine if keep else sessions.start(db, customer, "password", ip=ip, user_agent=user_agent)
    return sessions.token_for(customer, session)
