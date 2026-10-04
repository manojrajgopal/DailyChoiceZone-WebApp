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
import secrets
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
          permission: Optional[str] = None) -> None:
    """
    Tell the store team: an entry in the admin tray, and an email to each
    active administrator whose role covers `permission` (super admins always).
    The addresses are the administrators' own, from the database. If none of
    them can receive mail, the store's sending mailbox gets it instead, so the
    alert still reaches someone.
    """
    from app.models import Notification

    db.add(Notification(id=f"NTF-{secrets.token_hex(8)}", kind=kind[:30], title=title[:255], body=(body or "")[:500],
                        href=(href or "")[:255], read=False, created_at=datetime.utcnow(), admin_id=admin_id))
    try:
        _email_staff(db, title, body, href, permission)
    except Exception:  # an alert must never break the work that raised it
        import logging

        logging.getLogger(__name__).exception("Could not email the store team about %s", kind)


def _email_staff(db: Session, title: str, body: str, href: str, permission: Optional[str]) -> None:
    import html as html_lib

    from app.core.permissions import permissions_for
    from app.models import AdminUser
    from app.services import email as email_service
    from app.services.email import senders

    if not email_service.wants(db, "store_team", None):
        return
    admins = db.execute(select(AdminUser).where(AdminUser.status == "active")).scalars().all()
    addresses = {}
    for admin in admins:
        allowed = admin.role == "super-admin" or permission is None or permission in (admin.permissions or [])             or permission in permissions_for(admin.role)
        if allowed and admin.email:
            addresses[admin.email.lower()] = admin.email
    if not addresses or all(senders.undeliverable(a) for a in addresses.values()):
        account = email_service.active_account(db)
        if account is not None and account.sender_email:
            addresses.setdefault(account.sender_email.lower(), account.sender_email)
    link = f"{app_settings.STOREFRONT_URL.rstrip('/')}{href}" if href else ""
    html = email_service.layout(title, html_lib.escape(body or ""), cta=("Open in the portal", link) if link else None,
                                footnote="Sent to the Daily Choice Zone store team.", tone="info", icon="bell",
                                eyebrow="Store team alert")
    for address in addresses.values():
        email_service.notify(db, "store_team", to=address, customer_id=None, subject=title, html=html,
                             text=f"{title}. {body} {link}".strip(), reference="store-team")


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
