"""Registration, sign-in and account maintenance."""

from __future__ import annotations

import re

from datetime import datetime
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import AuthenticationError, AuthorizationError, ConflictError, NotFoundError
from app.core.permissions import permissions_for
from app.core.security import create_access_token, hash_password, verify_password
from app.models import Address, AdminUser, Customer
from app.schemas.auth import (
    AddressWrite,
    CustomerUpdate,
    LoginRequest,
    PasswordChange,
    RegisterRequest,
    TokenOut,
)
from app.utils.ids import next_id

# The same message for an unknown email and a wrong password. Telling them
# apart hands an attacker a way to discover which addresses have accounts,
# which is the first step of every credential-stuffing run.
INVALID_CREDENTIALS = "That email and password do not match."


def _token_for(subject: str, actor: str, role: Optional[str] = None) -> TokenOut:
    return TokenOut(
        access_token=create_access_token(subject, actor, role),  # type: ignore[arg-type]
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )


# ------------------------------------------------------------- customers


def _claim_first_administrator(db: Session, customer: Customer, password_hash: str) -> bool:
    """
    Make the very first registered person an administrator.

    A fresh installation has nobody who can reach the portal, so the first
    account to register claims it. Everybody after them is an ordinary
    customer, and **nothing in the request influences that** — the decision is
    made here, from the state of the table, and `RegisterRequest` has no role
    field to send.

    `WITH FOR UPDATE` is what makes it safe under concurrent signups. On an
    empty table InnoDB takes a gap lock over the whole index range, so a second
    registration arriving at the same moment blocks here until the first
    commits and then sees the administrator it created. Without it, two
    simultaneous signups would both read zero and both claim the role.

    Returns whether this registration became an administrator.
    """
    taken = db.execute(
        select(AdminUser.id).limit(1).with_for_update()
    ).scalar_one_or_none()

    if taken is not None:
        return False

    initials = "".join(
        part[0] for part in f"{customer.first_name} {customer.last_name}".split()[:2]
    ).upper()

    db.add(
        AdminUser(
            id=next_id(db, AdminUser, "admin_user"),
            email=customer.email,
            # The same hash, not a second password: one set of credentials
            # opens both surfaces, because it is one person.
            password_hash=password_hash,
            name=f"{customer.first_name} {customer.last_name}".strip() or customer.email,
            role="super-admin",
            permissions=permissions_for("super-admin"),
            status="active",
            created_at=datetime.utcnow(),
        )
    )
    return True


def register(db: Session, payload: RegisterRequest, *, ip: str = "") -> tuple[Customer, TokenOut]:
    """
    Create a customer account.

    The first one to arrive on an installation with no administrator also
    becomes one — see `_claim_first_administrator`. Both rows are written in
    the same transaction, so there is no moment where the account exists
    without the role it was promised, or the other way round.
    """
    existing = db.execute(
        select(Customer.id).where(Customer.email == payload.email.lower())
    ).scalar_one_or_none()

    if existing:
        raise ConflictError(
            "An account already exists for that email.",
            error_code="EMAIL_TAKEN",
        )

    password_hash = hash_password(payload.password)

    customer = Customer(
        id=next_id(db, Customer, "customer"),
        email=payload.email.lower(),
        password_hash=password_hash,
        first_name=payload.first_name.strip(),
        last_name=payload.last_name.strip(),
        phone=payload.phone.strip(),
        status="active",
        joined_at=datetime.utcnow(),
    )

    db.add(customer)

    try:
        _claim_first_administrator(db, customer, password_hash)
        db.flush()
        # A referral code is checked here, inside the same transaction: a
        # code that isn't valid refuses the sign-up so it can be corrected,
        # rather than the account being made without the referral.
        if payload.referral_code:
            from app.services import referrals

            referrals.attach_at_signup(db, customer, payload.referral_code, ip)
        # Queued on this transaction, so the email goes out only if the
        # account is actually created.
        from app.services import accounts

        accounts.send_verification(db, customer)
        db.commit()
    except Exception:
        db.rollback()
        raise

    db.refresh(customer)

    return customer, _token_for(customer.id, "customer")


def login_customer(db: Session, payload: LoginRequest) -> tuple[Customer, TokenOut]:
    customer = db.execute(
        select(Customer).where(Customer.email == payload.email.lower())
    ).scalar_one_or_none()

    # `verify_password` runs even when there is no such account, so the request
    # takes the same time either way. Returning early on a missing email makes
    # the difference measurable, and measurable is enumerable.
    placeholder = "$2b$12$" + "." * 53
    matches = verify_password(payload.password, customer.password_hash if customer else placeholder)

    if customer is None or not matches:
        raise AuthenticationError(INVALID_CREDENTIALS, error_code="INVALID_CREDENTIALS")

    if customer.status != "active":
        raise AuthorizationError(
            "This account has been suspended. Contact support.",
            error_code="ACCOUNT_BLOCKED",
        )

    customer.last_login_at = datetime.utcnow()
    db.commit()

    return customer, _token_for(customer.id, "customer")


def update_customer(db: Session, customer: Customer, payload: CustomerUpdate) -> Customer:
    provided = payload.model_dump(exclude_unset=True, by_alias=False)

    for field in ("first_name", "last_name", "phone"):
        if field in provided and provided[field] is not None:
            setattr(customer, field, provided[field].strip())

    db.commit()
    db.refresh(customer)
    return customer


def change_password(db: Session, customer: Customer, payload: PasswordChange) -> None:
    """The current password is required — a stolen session must not be able to
    lock the owner out of their own account."""
    if not verify_password(payload.current_password, customer.password_hash):
        raise AuthenticationError("Your current password is not correct.", error_code="INVALID_CREDENTIALS")

    customer.password_hash = hash_password(payload.new_password)
    db.commit()


# ------------------------------------------------------------- addresses


def list_addresses(db: Session, customer: Customer) -> list[Address]:
    return list(customer.addresses)


def _clear_other_defaults(db: Session, customer_id: str, keep_id: Optional[str] = None) -> None:
    for address in db.execute(
        select(Address).where(Address.customer_id == customer_id)
    ).scalars():
        if address.id != keep_id:
            address.is_default = False


_ADDRESS_FIELDS = ("full_name", "line1", "line2", "city", "state", "pincode", "country")


def _address_key(values: dict) -> tuple:
    """
    What makes two addresses the same place: the fields compared without case,
    spacing or punctuation, and the phone number by its digits (its last ten,
    so "+91 98765 43210" and "9876543210" agree).
    """
    def clean(value) -> str:
        return re.sub(r"[^0-9a-z]+", "", str(value or "").lower())

    phone = re.sub(r"\D", "", str(values.get("phone") or ""))[-10:]
    return tuple(clean(values.get(field)) for field in _ADDRESS_FIELDS) + (phone,)


def find_matching_address(
    db: Session, customer: Customer, payload: AddressWrite
) -> Optional[Address]:
    """The customer's saved address that is this one, if there is one."""
    wanted = _address_key(payload.model_dump(by_alias=False))
    for address in db.execute(
        select(Address).where(Address.customer_id == customer.id)
    ).scalars():
        existing = {field: getattr(address, field) for field in _ADDRESS_FIELDS}
        existing["phone"] = address.phone
        if _address_key(existing) == wanted:
            return address
    return None


def create_address(db: Session, customer: Customer, payload: AddressWrite) -> Address:
    """
    Save an address — once.

    Checkout saves the address it shipped to after every order, and it used to
    add a fresh copy each time: ten orders to one home, ten identical cards. An
    address the customer already has is reused instead (made default if this
    request asks for that); only a genuinely new one creates a record.
    """
    existing = find_matching_address(db, customer, payload)
    if existing is not None:
        if payload.is_default and not existing.is_default:
            _clear_other_defaults(db, customer.id, keep_id=existing.id)
            existing.is_default = True
            db.commit()
            db.refresh(existing)
        return existing

    address = Address(
        id=next_id(db, Address, "address"),
        customer_id=customer.id,
        **payload.model_dump(by_alias=False),
    )

    # The first address is the default whether or not the form said so —
    # a customer with addresses and no default has nowhere to ship to.
    if payload.is_default or not customer.addresses:
        _clear_other_defaults(db, customer.id)
        address.is_default = True

    db.add(address)
    db.commit()
    db.refresh(address)
    return address


def update_address(
    db: Session, customer: Customer, address_id: str, payload: AddressWrite
) -> Address:
    address = db.get(Address, address_id)
    # Ownership checked before anything else: an id in a URL is a guess anyone
    # can make, and "not yours" must look exactly like "does not exist".
    if address is None or address.customer_id != customer.id:
        raise NotFoundError("No such address.", error_code="ADDRESS_NOT_FOUND")

    for field, value in payload.model_dump(by_alias=False).items():
        setattr(address, field, value)

    if payload.is_default:
        _clear_other_defaults(db, customer.id, keep_id=address.id)
        address.is_default = True

    db.commit()
    db.refresh(address)
    return address


def delete_address(db: Session, customer: Customer, address_id: str) -> None:
    address = db.get(Address, address_id)
    if address is None or address.customer_id != customer.id:
        raise NotFoundError("No such address.", error_code="ADDRESS_NOT_FOUND")

    was_default = address.is_default
    db.delete(address)
    db.flush()

    # Promote another one, so deleting the default does not leave the account
    # without one.
    if was_default:
        remaining = db.execute(
            select(Address).where(Address.customer_id == customer.id).limit(1)
        ).scalar_one_or_none()
        if remaining:
            remaining.is_default = True

    db.commit()


# ----------------------------------------------------------------- admin


def login_admin(db: Session, payload: LoginRequest) -> tuple[AdminUser, TokenOut]:
    """
    Sign an administrator in.

    **This is the real check**, unlike the browser-side one the portal used to
    do: the password is verified against a bcrypt hash on the server, and the
    token it returns is what every admin endpoint validates. Hiding a button in
    the interface is a courtesy; this is the boundary.
    """
    admin = db.execute(
        select(AdminUser).where(AdminUser.email == payload.email.lower())
    ).scalar_one_or_none()

    placeholder = "$2b$12$" + "." * 53
    matches = verify_password(payload.password, admin.password_hash if admin else placeholder)

    if admin is None or not matches:
        raise AuthenticationError(INVALID_CREDENTIALS, error_code="INVALID_CREDENTIALS")

    if admin.status != "active":
        raise AuthorizationError("This account has been suspended.", error_code="ACCOUNT_BLOCKED")

    admin.last_login_at = datetime.utcnow()
    db.commit()

    return admin, _token_for(admin.id, "admin", admin.role)
