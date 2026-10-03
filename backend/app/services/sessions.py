"""
Signed-in devices.

Every sign-in (password, Google, Apple, Microsoft, a one-time code) starts a
`CustomerSession` and gets a token carrying its id as `sid`. The token is
still a short-lived JWT (`ACCESS_TOKEN_EXPIRE_MINUTES`); the session is what
lasts (`SESSION_LIFETIME_DAYS`) and what can be ended:

- **Sign out** revokes the current session, so its token stops working at
  once instead of whenever it would have expired.
- **Sign out of other devices** revokes every other session, and stamps
  `customers.sessions_revoked_at` so tokens issued before sessions existed
  (no `sid`) stop working too.
- **A password change** revokes every other session; a password reset revokes
  all of them (and `password_changed_at` retires every older token anyway).

`dependencies.auth` checks a token's session on every request: one primary-key
read. `last_seen_at` is written at most every `TOUCH_SECONDS`.

Tokens without a `sid` (issued before this existed) keep working until they
expire, unless the customer signed out everywhere.
"""

from __future__ import annotations

import calendar
import secrets
from datetime import datetime, timedelta
from typing import List, Optional

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import create_access_token
from app.models import Customer, CustomerSession
from app.schemas.auth import TokenOut
from app.services.identity import crypto

TOUCH_SECONDS = 300

METHOD_LABELS = {
    "password": "Email and password",
    "google": "Google",
    "apple": "Apple",
    "microsoft": "Microsoft",
    "otp-sms": "Mobile number code",
    "otp-email": "Email code",
    "signup": "New account",
}

# Why a token is refused: (error_code, message).
REVOKED = ("SESSION_REVOKED", "You've been signed out on this device. Sign in again.")
EXPIRED = ("SESSION_EXPIRED", "Your session has ended. Sign in again.")


def _now() -> datetime:
    # Whole seconds: a JWT's `iat` is whole seconds, and MySQL rounds a stored fraction up.
    return datetime.utcnow().replace(microsecond=0)


def lifetime() -> timedelta:
    return timedelta(days=max(1, int(getattr(settings, "SESSION_LIFETIME_DAYS", 30) or 30)))


def start(db: Session, customer: Customer, method: str, *, ip: str = "", user_agent: str = "") -> CustomerSession:
    """A new session on the caller's transaction (flushed, not committed)."""
    now = _now()
    session = CustomerSession(
        id=secrets.token_hex(16), customer_id=customer.id, method=(method or "password")[:20],
        created_at=now, last_seen_at=now, expires_at=now + lifetime(),
        ip_hash=crypto.ip_hash(ip), ip_masked=crypto.mask_ip(ip), device=crypto.device_summary(user_agent)[:80],
    )
    db.add(session)
    db.flush()
    return session


def token_for(customer: Customer, session: CustomerSession) -> TokenOut:
    """A token for this session, never outliving it."""
    minutes = settings.ACCESS_TOKEN_EXPIRE_MINUTES
    remaining = int((session.expires_at - datetime.utcnow()).total_seconds() // 60)
    minutes = max(1, min(minutes, remaining))
    return TokenOut(access_token=create_access_token(customer.id, "customer", None, expires_minutes=minutes,
                                                     sid=session.id),
                    expires_in=minutes * 60)


def issue(db: Session, customer: Customer, method: str, *, ip: str = "", user_agent: str = "") -> TokenOut:
    return token_for(customer, start(db, customer, method, ip=ip, user_agent=user_agent))


def problem(db: Session, payload: dict, customer: Customer) -> Optional[tuple]:
    """Why this token's session no longer counts, or None. Touches `last_seen_at` now and then."""
    sid = payload.get("sid")
    now = datetime.utcnow()
    if not sid:
        revoked = customer.sessions_revoked_at
        if revoked is not None and int(payload.get("iat") or 0) < calendar.timegm(revoked.utctimetuple()):
            return REVOKED
        return None
    session = db.get(CustomerSession, str(sid)[:32])
    if session is None or session.customer_id != customer.id or session.revoked_at is not None:
        return REVOKED
    if session.expires_at <= now:
        return EXPIRED
    if (now - session.last_seen_at).total_seconds() > TOUCH_SECONDS:
        db.execute(update(CustomerSession).where(CustomerSession.id == session.id)
                   .values(last_seen_at=now.replace(microsecond=0)))
        db.commit()
    return None


def revoke(db: Session, session: CustomerSession, reason: str) -> None:
    if session.revoked_at is None:
        session.revoked_at = _now()
        session.revoked_reason = reason[:30]


def revoke_all(db: Session, customer: Customer, reason: str, *, keep: Optional[str] = None) -> int:
    """End every live session of this customer except `keep`. Returns how many."""
    conditions = [CustomerSession.customer_id == customer.id, CustomerSession.revoked_at.is_(None)]
    if keep:
        conditions.append(CustomerSession.id != keep)
    result = db.execute(update(CustomerSession).where(*conditions)
                        .values(revoked_at=_now(), revoked_reason=reason[:30]))
    return int(result.rowcount or 0)


def current(db: Session, payload: dict, customer: Customer) -> Optional[CustomerSession]:
    sid = (payload or {}).get("sid")
    if not sid:
        return None
    session = db.get(CustomerSession, str(sid)[:32])
    return session if session is not None and session.customer_id == customer.id else None


def view(session: CustomerSession, current_sid: Optional[str]) -> dict:
    return {
        "id": session.id,
        "current": session.id == current_sid,
        "method": session.method,
        "methodLabel": METHOD_LABELS.get(session.method, session.method.replace("-", " ").title()),
        "device": session.device or "Unknown device",
        "location": session.ip_masked,
        "createdAt": session.created_at,
        "lastSeenAt": session.last_seen_at,
        "expiresAt": session.expires_at,
    }


def active(db: Session, customer: Customer, current_sid: Optional[str]) -> List[dict]:
    rows = db.execute(
        select(CustomerSession).where(CustomerSession.customer_id == customer.id,
                                      CustomerSession.revoked_at.is_(None),
                                      CustomerSession.expires_at > datetime.utcnow())
        .order_by(CustomerSession.last_seen_at.desc()).limit(50)
    ).scalars().all()
    out = [view(row, current_sid) for row in rows]
    out.sort(key=lambda item: not item["current"])  # this device first
    return out


def sign_out_everywhere_else(db: Session, customer: Customer, payload: dict, *, ip: str = "",
                             user_agent: str = "") -> tuple:
    """
    Revoke every other session and every sid-less token. Returns (count, token
    for this device): this device keeps working, with a fresh token when its
    old one was sid-less (and so was just retired).
    """
    mine = current(db, payload, customer)
    keep = mine.id if mine is not None and mine.revoked_at is None else None
    count = revoke_all(db, customer, "signed-out-everywhere", keep=keep)
    customer.sessions_revoked_at = _now()
    session = mine if keep else start(db, customer, "password", ip=ip, user_agent=user_agent)
    return count, token_for(customer, session)


def refresh(db: Session, customer: Customer, payload: dict) -> Optional[TokenOut]:
    """A new token for the same live session (sliding renewal). None for a sid-less token."""
    session = current(db, payload, customer)
    if session is None or session.revoked_at is not None or session.expires_at <= datetime.utcnow():
        return None
    session.last_seen_at = _now()
    return token_for(customer, session)


def cleanup(db: Session, older_than_days: int = 30) -> int:
    """Delete sessions that ended more than a month ago."""
    cutoff = datetime.utcnow() - timedelta(days=older_than_days)
    rows = db.execute(select(CustomerSession).where(
        (CustomerSession.expires_at < cutoff) | (CustomerSession.revoked_at < cutoff))).scalars().all()
    for row in rows:
        db.delete(row)
    return len(rows)


def count_today(db: Session) -> dict:
    """Sign-ins since midnight (UTC), by method."""
    start_of_day = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    rows = db.execute(select(CustomerSession.method, func.count()).where(CustomerSession.created_at >= start_of_day)
                      .group_by(CustomerSession.method)).all()
    return {method: int(count) for method, count in rows}
