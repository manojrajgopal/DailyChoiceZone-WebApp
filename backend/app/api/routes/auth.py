"""Authentication and the customer's own account."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.dependencies.auth import get_current_admin, get_current_customer
from app.models import AdminUser, Customer
from app.schemas.auth import (
    AddressOut,
    AddressWrite,
    AdminUserOut,
    CustomerOut,
    CustomerUpdate,
    LoginRequest,
    PasswordChange,
    RegisterRequest,
)
from app.services import auth as service
from app.utils.response import ok, ok_list

router = APIRouter(prefix="/auth", tags=["Authentication"])
account_router = APIRouter(prefix="/account", tags=["Customers"])
admin_auth_router = APIRouter(prefix="/admin/auth", tags=["Authentication"])


# ------------------------------------------------------------- customers


@router.post("/register", status_code=201, summary="Create a customer account")
def register(payload: RegisterRequest, db: Session = Depends(get_db)):
    customer, token = service.register(db, payload)
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


# --------------------------------------------------------------- account


@account_router.put("/profile", summary="Update your profile")
def update_profile(
    payload: CustomerUpdate,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    updated = service.update_customer(db, customer, payload)
    return ok(CustomerOut.from_model(updated).model_dump(by_alias=True), message="Profile updated.")


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
    admin, token = service.login_admin(db, payload)
    return ok(
        {
            "token": token.model_dump(by_alias=True),
            "admin": AdminUserOut.from_model(admin).model_dump(by_alias=True),
        },
        message="Signed in.",
    )


@admin_auth_router.get("/me", summary="The signed-in administrator")
def admin_me(admin: AdminUser = Depends(get_current_admin)):
    return ok(AdminUserOut.from_model(admin).model_dump(by_alias=True))


@admin_auth_router.post("/logout", summary="Sign out of the admin portal")
def admin_logout():
    return ok(message="Signed out.")
