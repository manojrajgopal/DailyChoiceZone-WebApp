"""
How a customer proves who they are, beyond a password: linked sign-in
providers, one-time codes, OAuth round trips and signed-in devices.

See docs/authentication.md.

- `CustomerIdentity`: one row per way in that isn't the password: a Google,
  Apple or Microsoft account (the provider's stable subject id), or a verified
  phone number (`provider="phone"`, E.164). Unique per provider and subject, so
  one Google account or one phone number can open exactly one customer.
- `OtpChallenge`: a code sent by SMS or email. Only an HMAC of the code is
  stored; the destination is kept as an HMAC (for counting and lookups), a
  masked form (for display) and sealed (to act on it once verified).
- `OAuthState`: one sign-in round trip to a provider: the hashed `state`,
  the hashed nonce, the sealed PKCE verifier, the browser it is bound to, and
  afterwards the one-time code the storefront exchanges for a token.
- `CustomerSession`: a signed-in device. Every new token carries its id
  (`sid`), so signing out, "sign out everywhere" and a password change end it.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import BusinessId


class CustomerIdentity(Base):
    __tablename__ = "customer_identities"
    __table_args__ = (
        UniqueConstraint("provider", "provider_user_id", name="uq_customer_identities_subject"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # google | apple | microsoft | phone
    provider: Mapped[str] = mapped_column(String(20), nullable=False)
    # The provider's stable subject (`sub`), or the E.164 phone number.
    provider_user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    # What the provider said the email was when last seen. Informational only:
    # never used to find or merge accounts (Apple's may be a private relay).
    provider_email: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    email_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    display_name: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    verified_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    last_login_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class OtpChallenge(Base):
    __tablename__ = "otp_challenges"
    __table_args__ = (
        Index("ix_otp_challenges_destination", "destination_hash", "created_at"),
        Index("ix_otp_challenges_ip", "ip_hash", "created_at"),
        Index("ix_otp_challenges_expires", "expires_at"),
    )

    # Random and public: the id the client sends back with the code.
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    # login | login-email | verify-phone | change-phone | verify-email | sensitive-action
    purpose: Mapped[str] = mapped_column(String(20), nullable=False)
    # sms | email
    channel: Mapped[str] = mapped_column(String(8), nullable=False)
    destination_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    destination_masked: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    destination_sealed: Mapped[str] = mapped_column(Text, nullable=False)
    # The signed-in account a code was asked for (phone change, set password).
    customer_id: Mapped[Optional[str]] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=True, index=True
    )
    # HMAC-SHA256 of the code, keyed by the server secret. Never the code.
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    # pending | verified | failed (not sent) | superseded | locked | expired
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="pending")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=5)
    provider: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    ip_hash: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    resend_available_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    consumed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class OAuthState(Base):
    __tablename__ = "oauth_states"
    __table_args__ = (Index("ix_oauth_states_expires", "expires_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    provider: Mapped[str] = mapped_column(String(20), nullable=False)
    # login | link
    mode: Mapped[str] = mapped_column(String(8), nullable=False, default="login")
    # SHA-256 of the `state` sent to the provider; NULL until the trip starts.
    state_hash: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, unique=True)
    # Linking: the one-time ticket the signed-in storefront opens /start with.
    ticket_hash: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, unique=True)
    # SHA-256 of the nonce; the id token must carry the nonce itself.
    nonce_hash: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    # The PKCE verifier, sealed (it is sent to the provider's token endpoint).
    verifier_sealed: Mapped[str] = mapped_column(Text, nullable=False)
    # SHA-256 of the random value in the browser's cookie: the callback must
    # come from the browser that started the trip (login CSRF).
    browser_hash: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    customer_id: Mapped[Optional[str]] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=True, index=True
    )
    next_path: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    ip_hash: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    consumed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # started | failed | signed-in | linked | (empty: not started)
    outcome: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    error_code: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    # The handoff: SHA-256 of the one-time code the storefront exchanges.
    handoff_hash: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, unique=True)
    handoff_customer_id: Mapped[Optional[str]] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=True
    )
    handoff_expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    handoff_used_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # Whether the trip created a new account (for the welcome on the storefront).
    created_account: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class CustomerSession(Base):
    __tablename__ = "customer_sessions"
    __table_args__ = (Index("ix_customer_sessions_expires", "expires_at"),)

    # The token's `sid` claim: random, never derived from anything.
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # password | google | apple | microsoft | otp-sms | otp-email | signup
    method: Mapped[str] = mapped_column(String(20), nullable=False, default="password")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    # Updated at most every few minutes, so a busy page doesn't write on every request.
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # signed-out | revoked | signed-out-everywhere | password-changed | password-reset
    revoked_reason: Mapped[str] = mapped_column(String(30), nullable=False, default="")
    ip_hash: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    # "203.0.113.x": enough for the customer to recognise, not to locate.
    ip_masked: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    # "Chrome on Windows": a summary, not the raw header.
    device: Mapped[str] = mapped_column(String(80), nullable=False, default="")
