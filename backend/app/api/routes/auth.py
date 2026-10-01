"""Authentication and the customer's own account."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.core import rate_limit
from app.core.database import get_db
from app.core.errors import ValidationError
from app.dependencies.auth import client_ip, get_current_admin, get_current_customer, require_permission
from app.models import AdminUser, Customer
from app.schemas.auth import (
    AddressOut,
    AddressWrite,
    AdminUserOut,
    CustomerOut,
    CustomerUpdate,
    ForgotPasswordRequest,
    LoginRequest,
    PasswordChange,
    RegisterRequest,
    ResetPasswordRequest,
    TokenRequest,
)
from app.services import accounts as account_security
from app.services import auth as service
from app.utils.response import ok, ok_list

router = APIRouter(prefix="/auth", tags=["Authentication"])
account_router = APIRouter(prefix="/account", tags=["Customers"])
admin_auth_router = APIRouter(prefix="/admin/auth", tags=["Authentication"])


# ------------------------------------------------------------- customers


@router.post("/register", status_code=201, summary="Create a customer account")
def register(payload: RegisterRequest, request: Request, db: Session = Depends(get_db)):
    customer, token = service.register(db, payload, ip=client_ip(request))
    return ok(
        {
            "token": token.model_dump(by_alias=True),
            "customer": CustomerOut.from_model(customer).model_dump(by_alias=True),
        },
        message="Welcome to Daily Choice Zone.",
    )


@router.post("/login", summary="Sign in as a customer")
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    customer, token = service.login_customer(db, payload)
    return ok(
        {
            "token": token.model_dump(by_alias=True),
            "customer": CustomerOut.from_model(customer).model_dump(by_alias=True),
        },
        message="Signed in.",
    )


@router.post("/logout", summary="Sign out")
def logout():
    """
    Sign out.

    There is nothing to invalidate: a JWT is valid until it expires, by design.
    The client discards the token. This endpoint exists so the frontend has one
    call to make, and so the day a token denylist is added there is already a
    place to put it.
    """
    return ok(message="Signed out.")


@router.get("/me", summary="The signed-in customer")
def me(customer: Customer = Depends(get_current_customer)):
    return ok(CustomerOut.from_model(customer).model_dump(by_alias=True))


# ------------------------------------------------------ account recovery

#: The one answer to a reset request, whatever the address.
RESET_REQUESTED = "If an account exists for that email, we've sent a link to reset the password."


@router.post("/password/forgot", summary="Email a password-reset link")
def forgot_password(payload: ForgotPasswordRequest, request: Request, db: Session = Depends(get_db)):
    """
    The same answer whether or not the address has an account — and the same
    limits, so the rate limit can't be used to probe either.
    """
    ip = client_ip(request)
    too_many = "Too many reset requests. Please wait a few minutes and try again."
    rate_limit.check(f"reset:ip:{ip}", limit=10, window_seconds=900, message=too_many)
    rate_limit.check(f"reset:email:{payload.email.lower()}", limit=3, window_seconds=900, message=too_many)
    account_security.request_password_reset(db, payload.email)
    return ok(message=RESET_REQUESTED)


@router.post("/password/reset/check", summary="Is a reset link still usable?")
def check_reset(payload: TokenRequest, request: Request, db: Session = Depends(get_db)):
    rate_limit.check(f"reset-check:ip:{client_ip(request)}", limit=30, window_seconds=900)
    account_security.check_reset_token(db, payload.token)
    return ok({"valid": True})


@router.post("/password/reset", summary="Choose a new password with a reset link")
def reset_password(payload: ResetPasswordRequest, request: Request, db: Session = Depends(get_db)):
    rate_limit.check(f"reset-use:ip:{client_ip(request)}", limit=10, window_seconds=900,
                     message="Too many attempts. Please wait a few minutes and try again.")
    if payload.password != payload.confirm_password:
        raise ValidationError("The two passwords don't match.", error_code="PASSWORD_MISMATCH")
    account_security.reset_password(db, payload.token, payload.password)
    return ok(message="Your password has been changed. Sign in with your new password.")


@router.post("/email/verify", summary="Confirm an email address with the emailed link")
def verify_email(payload: TokenRequest, request: Request, db: Session = Depends(get_db)):
    rate_limit.check(f"verify:ip:{client_ip(request)}", limit=30, window_seconds=900)
    customer = account_security.verify_email(db, payload.token)
    return ok({"verified": True, "email": customer.email}, message="Your email address is confirmed.")


# --------------------------------------------------------------- account


@account_router.put("/profile", summary="Update your profile")
def update_profile(
    payload: CustomerUpdate,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    updated = service.update_customer(db, customer, payload)
    return ok(CustomerOut.from_model(updated).model_dump(by_alias=True), message="Profile updated.")


@account_router.post("/email/verification", summary="Send the email-verification link again")
def resend_verification(
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    too_many = "We've sent a few links already. Please check your inbox (and spam), or try again later."
    # One a minute, a handful an hour: enough for a lost email, not for a flood.
    rate_limit.check(f"verify-resend:burst:{customer.id}", limit=1, window_seconds=60,
                     message="We've just sent a link — please wait a minute before asking again.")
    rate_limit.check(f"verify-resend:hour:{customer.id}", limit=5, window_seconds=3600, message=too_many)
    sent = account_security.resend_verification(db, customer)
    if not sent:
        return ok({"alreadyVerified": True}, message="Your email address is already confirmed.")
    return ok({"alreadyVerified": False}, message=f"We've sent a new link to {customer.email}.")


@account_router.put("/password", summary="Change your password")
def change_password(
    payload: PasswordChange,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    service.change_password(db, customer, payload)
    return ok(message="Password changed.")


@account_router.get("/addresses", summary="Your saved addresses")
def list_addresses(
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    addresses = service.list_addresses(db, customer)
    return ok_list([AddressOut.model_validate(a).model_dump(by_alias=True) for a in addresses])


@account_router.post("/addresses", status_code=201, summary="Save an address")
def create_address(
    payload: AddressWrite,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    address = service.create_address(db, customer, payload)
    return ok(AddressOut.model_validate(address).model_dump(by_alias=True), message="Address saved.")


@account_router.put("/addresses/{address_id}", summary="Update an address")
def update_address(
    address_id: str,
    payload: AddressWrite,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    address = service.update_address(db, customer, address_id, payload)
    return ok(AddressOut.model_validate(address).model_dump(by_alias=True), message="Address updated.")


@account_router.delete("/addresses/{address_id}", summary="Remove an address")
def delete_address(
    address_id: str,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    service.delete_address(db, customer, address_id)
    return ok(message="Address removed.")


# ----------------------------------------------------------------- admin


@admin_auth_router.post("/login", summary="Sign in to the admin portal")
def admin_login(payload: LoginRequest, db: Session = Depends(get_db)):
    # Every attempt is in the audit trail — the address tried, never the password.
    from app.core.errors import AppError
    from app.services import audit

    try:
        admin, token = service.login_admin(db, payload)
    except AppError as error:
        audit.record_now(db, "auth.login_failed", resource_type="auth", resource_id=payload.email.lower()[:80],
                         summary=f"Failed sign-in to the portal as {payload.email.lower()}", outcome="denied",
                         status_code=error.status_code, error_code=error.error_code,
                         details={"email": payload.email.lower()})
        raise
    audit.record(db, "auth.login", resource_type="auth", resource_id=admin.id, actor=admin,
                 summary=f"{admin.name} signed in to the portal")
    db.commit()
    return ok(
        {
            "token": token.model_dump(by_alias=True),
            "admin": AdminUserOut.from_model(admin).model_dump(by_alias=True),
        },
        message="Signed in.",
    )


@admin_auth_router.get("/accounts/settings", summary="Account security settings")
def get_account_settings(db: Session = Depends(get_db), admin: AdminUser = Depends(require_permission("settings"))):
    return ok(account_security.settings(db))


@admin_auth_router.put("/accounts/settings", summary="Save account security settings")
def save_account_settings(payload: dict, db: Session = Depends(get_db),
                          admin: AdminUser = Depends(require_permission("settings"))):
    return ok(account_security.save_settings(db, payload), message="Account settings saved.")


@admin_auth_router.get("/me", summary="The signed-in administrator")
def admin_me(admin: AdminUser = Depends(get_current_admin)):
    return ok(AdminUserOut.from_model(admin).model_dump(by_alias=True))


@admin_auth_router.post("/logout", summary="Sign out of the admin portal")
def admin_logout(db: Session = Depends(get_db), admin: AdminUser = Depends(get_current_admin)):
    from app.services import audit

    audit.record(db, "auth.logout", resource_type="auth", resource_id=admin.id, actor=admin,
                 summary=f"{admin.name} signed out of the portal")
    db.commit()
    return ok(message="Signed out.")
