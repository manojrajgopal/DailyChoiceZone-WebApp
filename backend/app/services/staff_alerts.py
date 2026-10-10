"""
Alerts for the store team: one place that decides who hears about what, and how.

Every staff alert (`inbox.staff`) goes out on each channel the store has
switched on, in Settings → Notifications:

- **In the portal**: the bell in the admin header, for administrators whose
  role covers the alert.
- **Email**: to those administrators (an address that can't receive mail is
  skipped) and to the store's *alert recipients*. When neither leaves anyone,
  the store's sending mailbox gets it, so an alert always reaches someone.
- **SMS and WhatsApp**: to the alert recipients' phone numbers, through the
  provider set in the environment (`NOTIFICATION_SMS_PROVIDER`,
  `NOTIFICATION_WHATSAPP_PROVIDER`). A WhatsApp message started by the store
  needs a template approved by Meta; its name is a setting. Each message is a
  `notification_deliveries` row, retried by the messaging worker, and one that
  can't go (no provider, no template) is recorded as skipped with the reason.

Alerts come in groups (orders, payments, stock…), each with its own switch.
Alerts about something broken — a failed refund, a stuck shipment, a backup —
have no switch: they always go.
"""

from __future__ import annotations

import html as html_lib
import logging
import re
import secrets
from typing import Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings as app_settings
from app.core.errors import ValidationError

logger = logging.getLogger(__name__)

EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$")
MAX_EMAILS = 10
MAX_PHONES = 5
SMS_LIMIT = 300

# Switch (in the store document's `notifications`) → the alert kinds it covers.
GROUPS: Dict[str, tuple] = {
    "orderAlerts": ("order", "order-cancelled"),
    "paymentAlerts": ("payment", "webhook"),
    "lowStockAlerts": ("stock",),
    "waitlistAlerts": ("waitlist",),
    "waitlistDigest": ("waitlist-digest",),
    "reviewAlerts": ("review",),
    "customerAlerts": ("customer",),
}
SWITCH_FOR = {kind: switch for switch, kinds in GROUPS.items() for kind in kinds}

DEFAULTS = {
    "orderAlerts": True,
    "paymentAlerts": True,
    "lowStockAlerts": True,
    "waitlistAlerts": True,
    "waitlistDigest": True,
    "reviewAlerts": True,
    "customerAlerts": True,
    "alertRecipients": {"emails": [], "phones": []},
    "alertChannels": {"email": True, "sms": False, "whatsapp": False, "inApp": True},
    "whatsappAlertTemplate": {"name": "", "language": "en"},
}


# ---------------------------------------------------------------- settings


def _store_notifications(db: Session) -> dict:
    from app.models import SettingDocument

    row = db.get(SettingDocument, "store")
    section = ((row.value if row else None) or {}).get("notifications")
    return section if isinstance(section, dict) else {}


def config(db: Session) -> dict:
    """The alert settings, with defaults for anything the store hasn't saved."""
    stored = _store_notifications(db)
    out = {key: stored.get(key, value) for key, value in DEFAULTS.items() if not isinstance(value, dict)}
    for key in ("alertRecipients", "alertChannels", "whatsappAlertTemplate"):
        saved = stored.get(key) if isinstance(stored.get(key), dict) else {}
        out[key] = {**DEFAULTS[key], **{k: v for k, v in saved.items() if k in DEFAULTS[key]}}
    return out


def clean(section: dict) -> dict:
    """
    Check and tidy the alert fields of a `notifications` section being saved.
    Other fields pass through untouched. Raises ValidationError.
    """
    from app.services.messaging.service import normalise_phone

    if not isinstance(section, dict):
        raise ValidationError("Notifications must be an object.", error_code="INVALID_SETTINGS")
    out = dict(section)
    for key in [k for k, v in DEFAULTS.items() if isinstance(v, bool)]:
        if key in out and not isinstance(out[key], bool):
            raise ValidationError(f"{key} must be true or false.", error_code="INVALID_SETTINGS",
                                  details={"field": f"notifications.{key}"})
    if "alertRecipients" in out:
        raw = out["alertRecipients"]
        if not isinstance(raw, dict):
            raise ValidationError("Alert recipients must be an object.", error_code="INVALID_SETTINGS")
        emails, phones = raw.get("emails") or [], raw.get("phones") or []
        if not isinstance(emails, list) or not isinstance(phones, list):
            raise ValidationError("Alert recipients are lists of emails and phone numbers.",
                                  error_code="INVALID_SETTINGS")
        clean_emails: List[str] = []
        for value in emails:
            address = str(value or "").strip().lower()
            if not address:
                continue
            if not EMAIL.match(address) or len(address) > 255:
                raise ValidationError(f"'{address}' isn't an email address.", error_code="INVALID_RECIPIENT",
                                      details={"field": "notifications.alertRecipients.emails"})
            if address not in clean_emails:
                clean_emails.append(address)
        clean_phones: List[str] = []
        for value in phones:
            if not str(value or "").strip():
                continue
            number = normalise_phone(str(value))
            if not number:
                raise ValidationError(f"'{value}' isn't a phone number. Use +91 98765 43210.",
                                      error_code="INVALID_RECIPIENT",
                                      details={"field": "notifications.alertRecipients.phones"})
            if number not in clean_phones:
                clean_phones.append(number)
        if len(clean_emails) > MAX_EMAILS or len(clean_phones) > MAX_PHONES:
            raise ValidationError(f"Up to {MAX_EMAILS} emails and {MAX_PHONES} phone numbers.",
                                  error_code="TOO_MANY_RECIPIENTS")
        out["alertRecipients"] = {"emails": clean_emails, "phones": clean_phones}
    if "alertChannels" in out:
        raw = out["alertChannels"]
        if not isinstance(raw, dict) or any(not isinstance(raw.get(k, True), bool) for k in DEFAULTS["alertChannels"]):
            raise ValidationError("Alert channels are switches.", error_code="INVALID_SETTINGS")
        out["alertChannels"] = {k: bool(raw.get(k, v)) for k, v in DEFAULTS["alertChannels"].items()}
    if "whatsappAlertTemplate" in out:
        raw = out["whatsappAlertTemplate"]
        if not isinstance(raw, dict):
            raise ValidationError("The WhatsApp template must be an object.", error_code="INVALID_SETTINGS")
        name = str(raw.get("name") or "").strip()
        language = str(raw.get("language") or "en").strip() or "en"
        if name and not re.match(r"^[a-z0-9_]{1,120}$", name):
            raise ValidationError("A WhatsApp template name is lower-case letters, digits and underscores.",
                                  error_code="INVALID_SETTINGS",
                                  details={"field": "notifications.whatsappAlertTemplate.name"})
        out["whatsappAlertTemplate"] = {"name": name, "language": language[:12]}
    return out


def switched_on(db: Session, kind: str) -> bool:
    switch = SWITCH_FOR.get(kind)
    return True if switch is None else bool(config(db).get(switch, True))


def channel_status(db: Session) -> dict:
    """Per channel: switched on, whether its provider is set up, and why not."""
    from app.services import email as email_service
    from app.services.messaging import providers

    cfg = config(db)
    account = email_service.active_account(db)
    out = {
        "inApp": {"enabled": cfg["alertChannels"]["inApp"], "configured": True, "reason": ""},
        "email": {"enabled": cfg["alertChannels"]["email"], "configured": account is not None,
                  "reason": "" if account is not None else "No email account is connected (Settings → Email)."},
    }
    for channel in ("sms", "whatsapp"):
        ready, reason = providers.for_channel(channel).configured()
        if channel == "whatsapp" and ready and not cfg["whatsappAlertTemplate"]["name"]:
            reason = "Set the approved WhatsApp template name for alerts."
            ready = False
        out[channel] = {"enabled": cfg["alertChannels"][channel], "configured": bool(ready),
                        "reason": "" if ready else reason}
    return out


# ------------------------------------------------------------------ sending


def _link(href: str) -> str:
    if not href:
        return ""
    if href.startswith("http"):
        return href
    return f"{app_settings.STOREFRONT_URL.rstrip('/')}{href}"


def _admin_addresses(db: Session, permission: Optional[str]) -> Dict[str, str]:
    from app.models import AdminUser
    from app.services.email import senders

    addresses: Dict[str, str] = {}
    for admin in db.execute(select(AdminUser).where(AdminUser.status == "active")).scalars():
        if not admin.email or not covers(admin, permission):
            continue
        if senders.undeliverable(admin.email):
            continue
        addresses[admin.email.lower()] = admin.email
    return addresses


def covers(admin, permission: Optional[str]) -> bool:
    from app.core.permissions import permissions_for

    return (admin.role == "super-admin" or permission is None or permission in (admin.permissions or [])
            or permission in permissions_for(admin.role))


def send(db: Session, kind: str, title: str, body: str = "", href: str = "", *, permission: Optional[str] = None,
         admin_id: Optional[str] = None, key: Optional[str] = None, channels: Optional[tuple] = None) -> dict:
    """
    One staff alert on every channel that is on. Returns what was done per
    channel (for the test button). Never raises: an alert must not break the
    work that raised it.
    """
    result = {"inApp": "off", "email": [], "sms": [], "whatsapp": []}
    try:
        if not switched_on(db, kind):
            return {**result, "inApp": "switched off"}
        cfg = config(db)
        wanted = {c for c, on in cfg["alertChannels"].items() if on}
        if channels is not None:
            wanted &= set(channels)
        title, body = (title or "").strip()[:255], (body or "").strip()[:500]
        token = (key or secrets.token_hex(8))[:60]
        if "inApp" in wanted:
            _in_app(db, kind, title, body, href, admin_id=admin_id, permission=permission)
            result["inApp"] = "added"
        if "email" in wanted:
            result["email"] = _email(db, kind, title, body, href, permission, cfg, token)
        for channel in ("sms", "whatsapp"):
            if channel in wanted:
                result[channel] = _short(db, channel, kind, title, body, href, cfg, token)
    except Exception:  # noqa: BLE001
        logger.exception("Could not send the staff alert %s", kind)
    return result


def _in_app(db: Session, kind: str, title: str, body: str, href: str, *, admin_id: Optional[str],
            permission: Optional[str]) -> None:
    from datetime import datetime

    from app.models import Notification

    db.add(Notification(id=f"NTF-{secrets.token_hex(8)}", kind=kind[:30], title=title, body=body,
                        href=(href or "")[:255], read=False, created_at=datetime.utcnow(), admin_id=admin_id,
                        permission=(permission or None)))


def email_recipients(db: Session, permission: Optional[str]) -> Dict[str, str]:
    """
    {lower-cased: address} for a staff email: administrators whose role covers
    `permission` (deliverable addresses only) and the alert recipients — or,
    when that leaves nobody, the store's own sending mailbox.
    """
    from app.services import email as email_service

    addresses = _admin_addresses(db, permission)
    for address in config(db)["alertRecipients"]["emails"]:
        addresses.setdefault(address.lower(), address)
    if not addresses:
        account = email_service.active_account(db)
        if account is not None and account.sender_email:
            addresses[account.sender_email.lower()] = account.sender_email
    return addresses


def _email(db: Session, kind: str, title: str, body: str, href: str, permission: Optional[str], cfg: dict,
           token: str) -> List[str]:
    from app.services import email as email_service

    if not email_service.wants(db, "store_team", None):
        return []
    addresses = email_recipients(db, permission)
    link = _link(href)
    html = email_service.layout(title, html_lib.escape(body or ""), cta=("Open in the portal", link) if link else None,
                                footnote="Sent to the Daily Choice Zone store team.", tone="info", icon="bell",
                                eyebrow="Store team alert")
    sent = []
    for lowered, address in addresses.items():
        if email_service.notify(db, "store_team", to=address, customer_id=None, subject=title, html=html,
                                text=f"{title}. {body} {link}".strip(), reference=kind[:40],
                                idempotency_key=f"staff:{kind}:{token}:{lowered}"[:140]):
            sent.append(address)
    return sent


def _short(db: Session, channel: str, kind: str, title: str, body: str, href: str, cfg: dict,
           token: str) -> List[str]:
    from app.services.messaging import providers
    from app.services.messaging import service as messaging

    phones = cfg["alertRecipients"]["phones"]
    if not phones:
        return []
    provider = providers.for_channel(channel)
    ready, reason = provider.configured()
    link = _link(href)
    text = " ".join(part for part in (f"{title}:" if body else title, body, link) if part)[:SMS_LIMIT]
    template = cfg["whatsappAlertTemplate"]
    if channel == "whatsapp":
        payload = {"template": template["name"], "language": template["language"],
                   "variables": [title[:200], (f"{body} {link}".strip() or "-")[:900]], "text": text}
        skip = "" if ready else reason
        skip = skip or ("" if template["name"] or provider.plain_text_whatsapp else
                        "No approved WhatsApp template is set for store alerts.")
    else:
        payload, skip = {"text": text}, ("" if ready else reason)
    queued = []
    for number in phones:
        row = messaging.queue(db, key=f"staff:{kind}:{token}:{channel}:{number}", event="store_alert",
                              channel=channel, category="transactional", customer_id=None, recipient=number,
                              # Kept even when skipped, so "Retry" works once the provider is set up.
                              payload=payload, provider=provider.name, reference=kind[:60],
                              status="skipped" if skip else "queued", error=skip)
        if row is not None:
            queued.append(f"{number}: {'skipped — ' + skip if skip else 'queued'}")
    return queued
