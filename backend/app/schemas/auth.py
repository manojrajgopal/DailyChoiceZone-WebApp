"""Authentication and account shapes."""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from pydantic import EmailStr, Field, field_validator

from app.schemas.base import CamelModel


class RegisterRequest(CamelModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)
    first_name: str = Field(min_length=1, max_length=80)
    last_name: str = Field(default="", max_length=80)
    phone: str = Field(default="", max_length=20)

    @field_validator("password")
    @classmethod
    def _strength(cls, value: str) -> str:
        """
        A floor, not a policy.

        Length does more for a password than a character-class rule, which
        mostly teaches people to end everything with "1!". Eight characters
        with at least one letter and one digit is the minimum worth enforcing.
        """
        if not any(c.isalpha() for c in value):
            raise ValueError("Password must contain at least one letter.")
        if not any(c.isdigit() for c in value):
            raise ValueError("Password must contain at least one number.")
        return value


class LoginRequest(CamelModel):
    email: EmailStr
    password: str


class TokenOut(CamelModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class AddressOut(CamelModel):
    id: str
    full_name: str
    phone: str
    line1: str
    line2: str
    city: str
    state: str
    pincode: str
    country: str
    type: str
    is_default: bool


class AddressWrite(CamelModel):
    full_name: str = Field(min_length=2, max_length=120)
    phone: str = Field(default="", max_length=20)
    line1: str = Field(min_length=3, max_length=255)
    line2: str = Field(default="", max_length=255)
    city: str = Field(min_length=2, max_length=120)
    state: str = Field(min_length=2, max_length=120)
    pincode: str = Field(min_length=4, max_length=12)
    country: str = "India"
    type: str = "home"
    is_default: bool = False


class CustomerOut(CamelModel):
    """
    The signed-in customer.

    No password hash, and nothing derived from one. A response model is the
    last place a hash can leak from, so it is not a field here at all rather
    than a field that happens to be excluded.
    """

    id: str
    email: str
    first_name: str
    last_name: str
    name: str
    phone: str
    status: str
    joined_at: datetime
    addresses: List[AddressOut] = []

    @classmethod
    def from_model(cls, customer) -> "CustomerOut":
        return cls(
            id=customer.id,
            email=customer.email,
            first_name=customer.first_name,
            last_name=customer.last_name,
            name=customer.full_name,
            phone=customer.phone,
            status=customer.status,
            joined_at=customer.joined_at,
            addresses=[AddressOut.model_validate(a) for a in customer.addresses],
        )


class CustomerUpdate(CamelModel):
    first_name: Optional[str] = Field(default=None, max_length=80)
    last_name: Optional[str] = Field(default=None, max_length=80)
    phone: Optional[str] = Field(default=None, max_length=20)


class PasswordChange(CamelModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=72)


class AdminUserOut(CamelModel):
    id: str
    name: str
    email: str
    role: str
    status: str
    permissions: List[str] = []
    last_login_at: Optional[datetime] = None
    created_at: datetime
    avatar_initials: str = ""

    @classmethod
    def from_model(cls, admin) -> "AdminUserOut":
        # Derived rather than stored: two initials that can disagree with the
        # name they came from is one field too many.
        initials = "".join(part[0] for part in admin.name.split()[:2]).upper()
        return cls(
            id=admin.id,
            name=admin.name,
            email=admin.email,
            role=admin.role,
            status=admin.status,
            permissions=admin.permissions or [],
            last_login_at=admin.last_login_at,
            created_at=admin.created_at,
            avatar_initials=initials,
        )


class AdminUserWrite(CamelModel):
    name: Optional[str] = Field(default=None, max_length=160)
    email: Optional[EmailStr] = None
    role: Optional[str] = None
    status: Optional[str] = None
    password: Optional[str] = Field(default=None, min_length=8, max_length=72)


class AuthSession(CamelModel):
    """What a successful sign-in returns: the token and who it belongs to."""

    token: TokenOut
    customer: Optional[CustomerOut] = None
    admin: Optional[AdminUserOut] = None
