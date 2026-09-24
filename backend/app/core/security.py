"""Password hashing and JWT issue/verify."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Literal, Optional

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.core.config import settings

# bcrypt, with the cost left at passlib's default. It is deliberately slow:
# that is the entire point of a password hash, and tuning it down to make
# logins feel snappier is tuning down the only thing protecting the passwords.
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

Actor = Literal["customer", "admin"]


def hash_password(password: str) -> str:
    # bcrypt silently truncates past 72 bytes, so a longer password would have
    # its tail ignored. Rejecting is honest; silently shortening is not.
    if len(password.encode("utf-8")) > 72:
        raise ValueError("Password must be 72 bytes or fewer.")
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    """
    Check a password against its hash.

    Returns False rather than raising on a malformed hash — a corrupt row must
    fail the login, not the whole endpoint.
    """
    try:
        return pwd_context.verify(plain, hashed)
    except (ValueError, TypeError):
        return False


def create_access_token(
    subject: str,
    actor: Actor,
    role: Optional[str] = None,
    expires_minutes: Optional[int] = None,
) -> str:
    """
    Issue a signed token.

    `actor` separates customers from administrators inside the token itself, so
    a valid customer token can never satisfy an admin dependency — the check is
    on the claim, not on which endpoint happened to issue it.
    """
    now = datetime.now(timezone.utc)
    expires = now + timedelta(minutes=expires_minutes or settings.ACCESS_TOKEN_EXPIRE_MINUTES)

    payload: Dict[str, Any] = {
        "sub": subject,
        "actor": actor,
        "role": role,
        "iat": int(now.timestamp()),
        "exp": int(expires.timestamp()),
    }
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def decode_access_token(token: str) -> Optional[Dict[str, Any]]:
    """
    Verify and decode. Returns None for anything that does not check out.

    Signature and expiry are both verified by `jwt.decode`; the algorithm is
    pinned so a token claiming `alg: none` cannot be presented as valid.
    """
    try:
        return jwt.decode(
            token,
            settings.JWT_SECRET_KEY,
            algorithms=[settings.JWT_ALGORITHM],
        )
    except JWTError:
        return None
