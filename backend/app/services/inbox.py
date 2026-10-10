"""
In-app notifications: the bell in the storefront header, and the admin tray.

Every email sent to a customer about their account also appears in their bell
(`email.notify` calls `from_email` on its way out), so a customer who missed
or never got the email still sees the news when they next visit. Some events
add their own wording — a gift card for someone who has an account, say. Staff
see events that need them (a question to review, a gift card bought) in the
admin tray.

Nothing secret goes in: no gift card codes, no reset or verification links.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Optional
from urllib.parse import parse_qsl, urlencode, urlsplit

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings as app_settings

# Email types that don't belong in the bell: links that sign someone in or
# change a password, staff-only mail, and support updates (which add their
# own notification with the ticket's wording).
NOT_IN_BELL = {"account_security", "support_updates", "support_team", "test"}
# Query parameters that carry a secret and must never be stored.
SECRET_PARAMS = {"token", "recover", "code", "key"}
_URL = re.compile(r"https?://\S+")
_SUFFIX = re.compile(r"\s+[—-]\s+Daily Choice Zone$")


def customer(db: Session, customer_id: Optional[str], kind: str, title: str, body: str = "", href: str = "") -> None:
    """One bell entry. The same unread news twice in a day is shown once."""
    if not customer_id:
        return
    from app.models import CustomerNotification

    title, body, href = title.strip()[:200], (body or "").strip()[:500], (href or "")[:255]
    recent = datetime.utcnow() - timedelta(hours=24)
    seen = db.execute(select(CustomerNotification.id).where(
        CustomerNotification.customer_id == customer_id, CustomerNotification.kind == kind[:30],
        CustomerNotification.title == title, CustomerNotification.href == href,
        CustomerNotification.read.is_(False), CustomerNotification.created_at >= recent,
    ).limit(1)).first()
    if seen:
        return
    db.add(CustomerNotification(customer_id=customer_id, kind=kind[:30], title=title, body=body, href=href,
                                read=False, created_at=datetime.utcnow()))
    # Written now, so a second notice in the same transaction sees this one.
    db.flush()


def staff(db: Session, kind: str, title: str, body: str = "", href: str = "", admin_id: Optional[str] = None,
          permission: Optional[str] = None, key: Optional[str] = None) -> None:
    """
    Tell the store team, on every channel the store has switched on: the admin
    bell, email (administrators whose role covers `permission`, and the alert
    recipients), SMS and WhatsApp (the alert recipients' phones). See
    `app.services.staff_alerts`. `key` makes a repeat of the same alert (the
    same product running low twice in a day) send nothing new by email or
    message.
    """
    from app.services import staff_alerts

    staff_alerts.send(db, kind, title, body, href, permission=permission, admin_id=admin_id, key=key)


def new_customer(db: Session, customer, how: str = "email") -> None:
    """A new account, by any route (sign-up form, Google/Apple/Microsoft, a one-time code)."""
    name = f"{customer.first_name or ''} {customer.last_name or ''}".strip() or customer.email or customer.phone
    contact = " · ".join(part for part in (customer.email, customer.phone) if part)
    staff(db, "customer", f"New customer: {name}", f"{contact} — signed up with {how}.",
          f"/admin/customers/detail?id={customer.id}", permission="customers", key=f"customer:{customer.id}")


def _storefront_path(text: str) -> str:
    """The first link to this shop in an email, as a path, with any secret dropped."""
    base = app_settings.STOREFRONT_URL.rstrip("/")
    for url in _URL.findall(text or ""):
        url = url.rstrip(".,)")
        if not url.startswith(base):
            continue
        parts = urlsplit(url)
        query = [(k, v) for k, v in parse_qsl(parts.query) if k.lower() not in SECRET_PARAMS]
        if len(query) != len(parse_qsl(parts.query)):
            return parts.path or "/"
        return (parts.path or "/") + (f"?{urlencode(query)}" if query else "") + (f"#{parts.fragment}" if parts.fragment else "")
    return ""


def from_email(db: Session, key: str, customer_id: Optional[str], subject: str, text: str,
               inbox: Optional[dict] = None) -> None:
    """The bell entry for an email: its subject, its first lines, and where its button goes."""
    if not customer_id or key in NOT_IN_BELL or inbox is False:
        return
    inbox = inbox or {}
    title = inbox.get("title") or _SUFFIX.sub("", subject)
    body = inbox.get("body")
    if body is None:
        body = re.sub(r"\s+", " ", _URL.sub("", text or "")).strip(" :.-")
        body = body[:220] + ("…" if len(body) > 220 else "")
    href = inbox.get("href")
    if href is None:
        href = _storefront_path(text)
    customer(db, customer_id, key, title, body, href)
