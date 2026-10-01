"""
The notification service: one place that turns a business event into messages
on every channel.

    business event (an order shipped)
      → `email.notify(..., event="order_shipped", variables={...})`
        → the event's template (the store's wording, or the built-in default)
        → each channel the store has switched on for that event
        → the customer's consent for that channel (marketing is opt-in;
          transactional messages never depend on marketing consent)
        → a `NotificationDelivery` row, queued in the event's own transaction
      → after commit, a background worker sends each one through its provider
      → retried with backoff when the failure was transient; given up ("dead")
        after the last attempt, or at once when it can't succeed

## Never twice

Every delivery has an idempotency key — the event, its reference, the channel
and the customer — unique in the database. Queuing the same thing again
(a webhook redelivered, a job retried after a restart) finds the row and adds
nothing; a retry updates the row it has.

## Never faked

A channel with no provider configured sends nothing and says so: its
deliveries are recorded as `skipped` with the reason. Only what a provider
reports moves a message past `sent` (`delivered`, `read`).
"""

from __future__ import annotations

import base64
import copy
import hashlib
import hmac
import logging
import re
import secrets
import threading
from datetime import datetime, timedelta
from typing import Dict, Iterable, List, Optional

from sqlalchemy import event as sa_event
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import NotFoundError, ValidationError
from app.models import (
    AdminUser,
    ChannelPreference,
    Customer,
    NotificationDelivery,
    NotificationTemplate,
    SettingDocument,
)
from app.services.email import templates as email_templates
from app.services.messaging import catalogue, providers

logger = logging.getLogger(__name__)

CHANNELS = catalogue.CHANNELS
CATEGORIES = ("transactional", "marketing")
# No preference row: what each channel and category defaults to. Offers by
# email and in the bell are on until the customer turns them off (in their
# settings, at sign-up, or with an unsubscribe link); SMS and WhatsApp offers
# stay opt-in. WhatsApp transactional is opt-in too (WhatsApp's own policy);
# SMS transactional is on for anyone with a number.
DEFAULT_CONSENT = {
    ("email", "transactional"): True, ("sms", "transactional"): True, ("whatsapp", "transactional"): False,
    ("in_app", "transactional"): True,
    ("email", "marketing"): True, ("sms", "marketing"): False, ("whatsapp", "marketing"): False,
    ("in_app", "marketing"): True,
}
MAX_ATTEMPTS = 5
BACKOFF_BASE_SECONDS = 60
BACKOFF_CAP_SECONDS = 6 * 3600
STALE_SENDING = timedelta(minutes=10)
INTERVAL_SECONDS = 30
SECRET_EMAIL_TYPES = {"account_security"}
SMS_LIMIT = 480


# ------------------------------------------------------------------ phones


def normalise_phone(raw: Optional[str]) -> Optional[str]:
    """A phone number as +<country><number>, assuming India for ten digits. None if it isn't one."""
    digits = re.sub(r"[^\d+]", "", raw or "")
    if not digits:
        return None
    if digits.startswith("+"):
        number = "+" + re.sub(r"\D", "", digits[1:])
    else:
        plain = re.sub(r"\D", "", digits)
        if len(plain) == 10:
            number = "+91" + plain
        elif len(plain) == 12 and plain.startswith("91"):
            number = "+" + plain
        elif plain.startswith("0") and len(plain) == 11:
            number = "+91" + plain[1:]
        else:
            return None
    return number if 11 <= len(number) <= 16 else None


def mask(recipient: str) -> str:
    """For lists: enough to recognise, not to copy. a••••@example.com, +91•••••43210."""
    if not recipient:
        return ""
    if "@" in recipient:
        local, _, domain = recipient.partition("@")
        return f"{local[:1]}{'•' * max(2, min(6, len(local) - 1))}@{domain}"
    return recipient[:3] + "•" * max(0, len(recipient) - 8) + recipient[-5:]


# ----------------------------------------------------------------- consent


def consent(db: Session, customer_id: Optional[str], channel: str, category: str) -> bool:
    if not customer_id:
        return category == "transactional"
    row = db.get(ChannelPreference, (customer_id, channel, category))
    if row is not None:
        return bool(row.enabled)
    return DEFAULT_CONSENT.get((channel, category), False)


def preferences(db: Session, customer: Customer) -> dict:
    """The customer's choices, for their account settings."""
    rows = {(r.channel, r.category): r for r in db.execute(
        select(ChannelPreference).where(ChannelPreference.customer_id == customer.id)).scalars()}
    status = channel_status(db)
    out = []
    for channel in CHANNELS:
        for category in CATEGORIES:
            if channel == "email" and category == "transactional":
                continue  # the per-email choices already cover these
            if channel == "in_app" and category == "transactional":
                continue  # the bell: always on
            row = rows.get((channel, category))
            out.append({
                "channel": channel, "category": category,
                "enabled": bool(row.enabled) if row else DEFAULT_CONSENT[(channel, category)],
                "available": channel in ("email", "in_app") or status[channel]["configured"],
                "updatedAt": row.updated_at if row else None,
            })
    return {"phone": customer.phone or "", "phoneUsable": normalise_phone(customer.phone) is not None,
            "choices": out}


def save_preferences(db: Session, customer: Customer, choices: List[dict], *, source: str = "account") -> dict:
    now = datetime.utcnow()
    for choice in choices or []:
        channel, category = choice.get("channel"), choice.get("category")
        if channel not in CHANNELS or category not in CATEGORIES:
            continue
        if (channel, category) in (("email", "transactional"), ("in_app", "transactional")):
            continue
        set_consent(db, customer.id, channel, category, bool(choice.get("enabled")), source=source, now=now)
    db.commit()
    return preferences(db, customer)


def set_consent(db: Session, customer_id: str, channel: str, category: str, enabled: bool, *, source: str,
                now: Optional[datetime] = None) -> None:
    now = now or datetime.utcnow()
    row = db.get(ChannelPreference, (customer_id, channel, category))
    if row is None:
        db.add(ChannelPreference(customer_id=customer_id, channel=channel, category=category, enabled=enabled,
                                 source=source[:20], updated_at=now))
    else:
        row.enabled, row.source, row.updated_at = enabled, source[:20], now
    db.flush()


# ------------------------------------------------------- unsubscribe links


def _signing_key() -> bytes:
    return f"unsubscribe:{settings.JWT_SECRET_KEY}".encode()


def unsubscribe_token(customer_id: str, channel: str = "email", campaign_id: Optional[int] = None) -> str:
    body = f"{customer_id}:{channel}:{campaign_id or ''}"
    signature = hmac.new(_signing_key(), body.encode(), hashlib.sha256).hexdigest()[:32]
    return base64.urlsafe_b64encode(f"{body}:{signature}".encode()).decode().rstrip("=")


def read_unsubscribe_token(token: str) -> Optional[tuple]:
    try:
        raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)).decode()
        customer_id, channel, campaign, signature = raw.split(":")
    except Exception:  # noqa: BLE001
        return None
    expected = hmac.new(_signing_key(), f"{customer_id}:{channel}:{campaign}".encode(), hashlib.sha256).hexdigest()[:32]
    if not hmac.compare_digest(expected, signature) or channel not in CHANNELS:
        return None
    return customer_id, channel, int(campaign) if campaign else None


def unsubscribe(db: Session, token: str) -> dict:
    """One click from a marketing message: that channel's marketing stops. No sign-in needed."""
    parsed = read_unsubscribe_token(token)
    if parsed is None:
        raise ValidationError("This unsubscribe link isn't valid.", error_code="UNSUBSCRIBE_INVALID")
    customer_id, channel, campaign_id = parsed
    if db.get(Customer, customer_id) is None:
        raise ValidationError("This unsubscribe link isn't valid.", error_code="UNSUBSCRIBE_INVALID")
    set_consent(db, customer_id, channel, "marketing", False, source="unsubscribe-link")
    if campaign_id:
        from app.models import CampaignRecipient

        for row in db.execute(select(CampaignRecipient).where(
                CampaignRecipient.campaign_id == campaign_id, CampaignRecipient.customer_id == customer_id,
                CampaignRecipient.unsubscribed_at.is_(None))).scalars():
            row.unsubscribed_at = datetime.utcnow()
    db.commit()
    return {"channel": channel, "unsubscribed": True}


# ------------------------------------------------------------ channel setup


def channel_status(db: Session) -> Dict[str, dict]:
    """Which channels can send, and why not — never the credentials."""
    routing = channel_routing(db)
    from app.services import email as email_service

    account = email_service.active_account(db)
    status = {
        "email": {"provider": account.provider if account else "", "configured": account is not None,
                  "reason": "" if account else "No sending account is connected (Settings → Email).",
                  "enabled": True},
        "in_app": {"provider": "bell", "configured": True, "reason": "", "enabled": True},
    }
    for channel in ("sms", "whatsapp"):
        described = providers.for_channel(channel).describe()
        status[channel] = {**described, "enabled": bool(routing[channel]["enabled"])}
    return status


def _default_routing() -> dict:
    return {channel: {"enabled": False, "events": sorted(k for k, e in catalogue.EVENTS.items()
                                                        if e["channels"].get(channel))}
            for channel in ("sms", "whatsapp")}


def channel_routing(db: Session) -> dict:
    stored = (db.get(SettingDocument, "notification_channels") or SettingDocument(value={})).value or {}
    routing = _default_routing()
    for channel in ("sms", "whatsapp"):
        own = stored.get(channel) if isinstance(stored.get(channel), dict) else {}
        if "enabled" in own:
            routing[channel]["enabled"] = bool(own["enabled"])
        if isinstance(own.get("events"), list):
            routing[channel]["events"] = sorted(e for e in own["events"] if e in catalogue.EVENTS)
    return routing


def save_routing(db: Session, admin: AdminUser, payload: dict) -> dict:
    from app.services import audit

    before = channel_routing(db)
    value = copy.deepcopy(before)
    status = {c: providers.for_channel(c).describe() for c in ("sms", "whatsapp")}
    for channel in ("sms", "whatsapp"):
        own = payload.get(channel) if isinstance(payload.get(channel), dict) else {}
        if "enabled" in own:
            enabled = bool(own["enabled"])
            if enabled and not status[channel]["configured"]:
                raise ValidationError(f"{channel.upper() if channel == 'sms' else 'WhatsApp'} can't be switched on: "
                                      f"{status[channel]['reason']}", error_code="CHANNEL_NOT_CONFIGURED")
            value[channel]["enabled"] = enabled
        if isinstance(own.get("events"), list):
            unknown = [e for e in own["events"] if e not in catalogue.EVENTS]
            if unknown:
                raise ValidationError(f"Unknown event: {', '.join(unknown)}", error_code="UNKNOWN_EVENT")
            # Sign-in and reset links stay in email: a text message is easier to intercept.
            secret = [e for e in own["events"] if e in ("email_verification", "password_reset")]
            if secret:
                raise ValidationError("Verification and password-reset links are sent by email only.",
                                      error_code="SECRET_EVENT")
            marketing = [e for e in own["events"] if catalogue.is_marketing(e)]
            if marketing:
                raise ValidationError("Marketing messages are sent by campaigns, not by event.",
                                      error_code="MARKETING_EVENT")
            value[channel]["events"] = sorted(set(own["events"]))
    row = db.get(SettingDocument, "notification_channels")
    if row is None:
        db.add(SettingDocument(key="notification_channels", value=value))
    else:
        row.value = value
    audit.record(db, "notifications.channels", resource_type="notifications", resource_id="channels", actor=admin,
                 summary="Changed which events send SMS and WhatsApp", changes=audit.diff(before, value))
    db.commit()
    return value


# --------------------------------------------------------------- templates


def effective(db: Session, key: str) -> dict:
    """The event's wording: the store's own where saved, the built-in default otherwise."""
    if key not in catalogue.EVENTS:
        raise NotFoundError("No such notification.", error_code="TEMPLATE_NOT_FOUND")
    spec = catalogue.EVENTS[key]
    default = spec["default"]
    row = db.get(NotificationTemplate, key)
    values = {
        "subject": default["subject"], "heading": default["heading"], "body": default["body"],
        "cta": default["cta"], "sms": default["sms"], "whatsappTemplate": "", "whatsappLanguage": "en",
        "whatsappVariables": list(default["whatsappVariables"]), "inAppTitle": default["inAppTitle"],
        "inAppBody": default["inAppBody"],
    }
    customised = False
    if row is not None:
        for field, column in (("subject", "email_subject"), ("heading", "email_heading"), ("body", "email_body"),
                              ("cta", "email_cta_label"), ("sms", "sms_text"),
                              ("whatsappTemplate", "whatsapp_template"), ("whatsappLanguage", "whatsapp_language"),
                              ("inAppTitle", "in_app_title"), ("inAppBody", "in_app_body")):
            value = getattr(row, column)
            if value:
                values[field] = value
        if row.whatsapp_variables:
            values["whatsappVariables"] = list(row.whatsapp_variables)
        customised = any(getattr(row, c) for c in ("email_subject", "email_heading", "email_body", "email_cta_label"))
    enabled = True if spec["locked"] else (row.enabled if row is not None else spec["defaultOn"])
    return {**values, "key": key, "enabled": bool(enabled), "customised": customised, "spec": spec,
            "updatedAt": row.updated_at if row else None, "updatedBy": row.updated_by if row else ""}


def template_view(db: Session, key: str) -> dict:
    data = effective(db, key)
    spec = data.pop("spec")
    return {**data, "label": spec["label"], "group": spec["group"], "category": spec["category"],
            "emailType": spec["emailType"], "variables": spec["variables"], "locked": spec["locked"],
            "ctaVariable": spec["default"]["ctaVariable"], "default": spec["default"]}


def list_templates(db: Session) -> List[dict]:
    rows = [template_view(db, key) for key in catalogue.EVENTS]
    order = {g: i for i, g in enumerate(catalogue.GROUPS)}
    return sorted(rows, key=lambda r: (order.get(r["group"], 99), r["label"]))


def save_template(db: Session, admin: AdminUser, key: str, payload: dict) -> dict:
    from app.services import audit

    current = effective(db, key)
    spec = current["spec"]
    allowed = set(spec["variables"]) | {spec["default"]["ctaVariable"]} - {""}
    fields = {
        "subject": (payload.get("subject", current["subject"]) or "").strip(),
        "heading": (payload.get("heading", current["heading"]) or "").strip(),
        "body": (payload.get("body", current["body"]) or "").strip(),
        "cta": (payload.get("cta", current["cta"]) or "").strip(),
        "sms": (payload.get("sms", current["sms"]) or "").strip(),
        "whatsappTemplate": (payload.get("whatsappTemplate", current["whatsappTemplate"]) or "").strip(),
        "whatsappLanguage": (payload.get("whatsappLanguage", current["whatsappLanguage"]) or "en").strip(),
        "inAppTitle": (payload.get("inAppTitle", current["inAppTitle"]) or "").strip(),
        "inAppBody": (payload.get("inAppBody", current["inAppBody"]) or "").strip(),
    }
    variables = payload.get("whatsappVariables", current["whatsappVariables"]) or []
    if not isinstance(variables, list) or any(v not in allowed for v in variables):
        raise ValidationError("WhatsApp variables must be names from this notification's list.",
                              error_code="INVALID_TEMPLATE")
    if not fields["subject"] or not fields["heading"] or not fields["body"]:
        raise ValidationError("A subject, heading and message are needed.", error_code="INVALID_TEMPLATE")
    for label, text in (("subject", fields["subject"]), ("heading", fields["heading"]), ("message", fields["body"]),
                        ("SMS", fields["sms"]), ("in-app title", fields["inAppTitle"]),
                        ("in-app message", fields["inAppBody"])):
        unknown = email_templates.unknown_variables(text, allowed)
        if unknown:
            raise ValidationError(f"The {label} uses {', '.join('{{' + u + '}}' for u in unknown)}, which this "
                                  "notification doesn't have.", error_code="INVALID_TEMPLATE_VARIABLE",
                                  details={"unknown": unknown})
    if len(fields["subject"]) > 200 or len(fields["heading"]) > 200:
        raise ValidationError("Keep the subject and heading under 200 characters.", error_code="INVALID_TEMPLATE")
    if len(fields["sms"]) > SMS_LIMIT:
        raise ValidationError(f"Keep the SMS under {SMS_LIMIT} characters (it's charged per 160).",
                              error_code="INVALID_TEMPLATE")
    enabled = bool(payload.get("enabled", current["enabled"]))
    if spec["locked"] and not enabled:
        raise ValidationError("This message keeps accounts secure and can't be switched off.",
                              error_code="TEMPLATE_LOCKED")
    row = db.get(NotificationTemplate, key)
    before = {k: current[k] for k in fields} | {"enabled": current["enabled"]}
    if row is None:
        row = NotificationTemplate(key=key, email_body="", whatsapp_variables=[])
        db.add(row)
    row.enabled = enabled
    row.email_subject, row.email_heading, row.email_body = fields["subject"], fields["heading"], fields["body"]
    row.email_cta_label, row.sms_text = fields["cta"], fields["sms"]
    row.whatsapp_template, row.whatsapp_language = fields["whatsappTemplate"][:120], fields["whatsappLanguage"][:12]
    row.whatsapp_variables = variables
    row.in_app_title, row.in_app_body = fields["inAppTitle"][:200], fields["inAppBody"][:500]
    row.updated_by, row.updated_at = admin.name[:120], datetime.utcnow()
    audit.record(db, "notifications.template", resource_type="notifications", resource_id=key, actor=admin,
                 summary=f"Changed the {spec['label']} notification",
                 changes=audit.diff(before, {**fields, "enabled": enabled}))
    db.commit()
    return template_view(db, key)


def reset_template(db: Session, admin: AdminUser, key: str) -> dict:
    from app.services import audit

    effective(db, key)
    row = db.get(NotificationTemplate, key)
    if row is not None:
        db.delete(row)
        audit.record(db, "notifications.template_reset", resource_type="notifications", resource_id=key, actor=admin,
                     summary=f"Put the {catalogue.EVENTS[key]['label']} notification back to the built-in wording")
        db.commit()
    return template_view(db, key)


def base_variables(customer: Optional[Customer] = None) -> dict:
    brand = email_templates.brand()
    return {"store_name": brand["name"], "store_url": brand["url"],
            "customer_name": (customer.first_name if customer and customer.first_name else "there")}


def render_email(db: Session, key: str, values: dict, *, extra_html: str = "", template: Optional[dict] = None,
                 marketing_unsubscribe: str = "", preferences_url: str = "", pixel: str = "") -> tuple:
    """(subject, html, text) for an event, from its template."""
    template = template or effective(db, key)
    spec = catalogue.EVENTS[key]
    allowed = set(spec["variables"]) | {spec["default"]["ctaVariable"]} - {""}
    subject = email_templates.render(template["subject"], values, allowed=allowed)
    heading = email_templates.render(template["heading"], values, allowed=allowed)
    body = email_templates.render(template["body"], values, allowed=allowed, html=True)
    cta_url = values.get(spec["default"]["ctaVariable"]) if spec["default"]["ctaVariable"] else None
    cta = (template["cta"], str(cta_url)) if template["cta"] and cta_url else None
    html = email_templates.master(title=heading, body_html=body + (extra_html or ""), cta=cta,
                                  preheader=email_templates.text_from_html(body)[:140],
                                  marketing=spec["category"] == "marketing",
                                  unsubscribe_url=marketing_unsubscribe, preferences_url=preferences_url,
                                  tracking_pixel=pixel)
    text = f"{heading}\n\n{email_templates.text_from_html(body)}" + (f"\n\n{cta[0]}: {cta[1]}" if cta else "")
    return subject[:255], html, text


def render_short(db: Session, key: str, channel: str, values: dict, template: Optional[dict] = None) -> dict:
    """The SMS text, WhatsApp template and variables, or in-app title and body."""
    template = template or effective(db, key)
    spec = catalogue.EVENTS[key]
    allowed = set(spec["variables"]) | {spec["default"]["ctaVariable"]} - {""}
    if channel == "sms":
        return {"text": email_templates.render(template["sms"], values, allowed=allowed)[:SMS_LIMIT]}
    if channel == "whatsapp":
        return {"template": template["whatsappTemplate"], "language": template["whatsappLanguage"],
                "variables": [str(values.get(v, "")) for v in template["whatsappVariables"]],
                "text": email_templates.render(template["sms"], values, allowed=allowed)}
    return {"title": email_templates.render(template["inAppTitle"], values, allowed=allowed)[:200],
            "body": email_templates.render(template["inAppBody"], values, allowed=allowed)[:500]}


def preview(db: Session, key: str, draft: Optional[dict] = None) -> dict:
    """Every channel's version, with sample values. `draft` previews unsaved wording."""
    template = effective(db, key)
    if draft:
        template = {**template, **{k: v for k, v in draft.items() if k in template and v is not None}}
    spec = catalogue.EVENTS[key]
    values = {**catalogue.SAMPLE, **{v: catalogue.SAMPLE.get(v, f"[{v}]") for v in spec["variables"]}}
    try:
        subject, html, text = render_email(db, key, values, template=template,
                                           marketing_unsubscribe="https://example.com/unsubscribe"
                                           if spec["category"] == "marketing" else "")
        problems = []
    except email_templates.TemplateError as error:
        subject, html, text, problems = "", "", "", [str(error)]
    try:
        sms = render_short(db, key, "sms", values, template)["text"]
        in_app = render_short(db, key, "in_app", values, template)
        whatsapp = render_short(db, key, "whatsapp", values, template)
    except email_templates.TemplateError as error:
        sms, in_app, whatsapp = "", {}, {}
        problems.append(str(error))
    return {"subject": subject, "html": html, "text": text, "sms": sms, "smsSegments": (len(sms) - 1) // 160 + 1
            if sms else 0, "inApp": in_app, "whatsapp": whatsapp, "problems": problems}


def send_test(db: Session, admin: AdminUser, key: str, channel: str, recipient: str) -> dict:
    """A test of one event's message to an address or number the admin gives — never to a customer."""
    from app.services import audit
    from app.services import email as email_service

    values = {**catalogue.SAMPLE}
    if channel == "email":
        if "@" not in (recipient or ""):
            raise ValidationError("Enter an email address for the test.", error_code="INVALID_RECIPIENT")
        account = email_service.active_account(db)
        if account is None:
            raise ValidationError("No email account is connected (Settings → Email).", error_code="EMAIL_NOT_CONFIGURED")
        subject, html, text = render_email(db, key, values)
        from app.services.email import crypto
        from app.services.email.senders import SendError

        try:
            email_service._send_now(account.provider, crypto.unseal(account.credentials), account, recipient.strip(),
                                    f"[Test] {subject}", html, text)
        except SendError as error:
            raise ValidationError(f"The test couldn't be sent: {error}", error_code="TEST_SEND_FAILED") from None
        result = {"channel": "email", "sentTo": recipient.strip()}
    elif channel in ("sms", "whatsapp"):
        number = normalise_phone(recipient)
        if not number:
            raise ValidationError("Enter a phone number for the test, with its country code.",
                                  error_code="INVALID_RECIPIENT")
        provider = providers.for_channel(channel)
        short = render_short(db, key, channel, values)
        try:
            outcome = provider.send(providers.Message(to=number, text=f"[Test] {short.get('text', '')}",
                                                      template=short.get("template", ""),
                                                      language=short.get("language", "en"),
                                                      variables=short.get("variables")))
        except providers.ProviderError as error:
            raise ValidationError(f"The test couldn't be sent: {error}", error_code="TEST_SEND_FAILED") from None
        result = {"channel": channel, "sentTo": mask(number), "providerMessageId": outcome.message_id}
    else:
        raise ValidationError("Choose email, SMS or WhatsApp.", error_code="INVALID_CHANNEL")
    audit.record(db, "notifications.test", resource_type="notifications", resource_id=key, actor=admin,
                 summary=f"Sent a test {channel} for {catalogue.EVENTS[key]['label']}")
    db.commit()
    return result


# ------------------------------------------------------------------ queue


def queue(db: Session, *, key: str, event: str, channel: str, category: str, customer_id: Optional[str],
          recipient: str, payload: Optional[dict], provider: str = "", campaign_id: Optional[int] = None,
          reference: str = "", status: str = "queued", error: str = "", template_key: str = "",
          max_attempts: int = MAX_ATTEMPTS) -> Optional[NotificationDelivery]:
    """
    Add one delivery to the caller's transaction, once per idempotency key.
    Returns the new row, or None when one with this key already exists.
    """
    key = key[:160]
    if db.execute(select(NotificationDelivery.id).where(NotificationDelivery.idempotency_key == key)).first():
        return None
    # Whole seconds: MySQL rounds a stored fraction, which could put "due now" a moment in the future.
    now = datetime.utcnow().replace(microsecond=0)
    row = NotificationDelivery(
        idempotency_key=key, event=event[:60], channel=channel, category=category, customer_id=customer_id,
        recipient=(recipient or "")[:255], template_key=(template_key or event)[:60], provider=provider[:30],
        status=status, payload=payload, attempts=0, max_attempts=max_attempts,
        next_attempt_at=now if status == "queued" else None, last_error=error[:500], campaign_id=campaign_id,
        reference=(reference or "")[:60], created_at=now, updated_at=now,
        failed_at=now if status in ("skipped", "dead") else None,
    )
    try:
        with db.begin_nested():
            db.add(row)
    except IntegrityError:
        return None  # a concurrent request queued it first
    if status == "queued" and channel in ("sms", "whatsapp"):
        db.info.setdefault("outgoing_messages", []).append(row.id)
    return row


def fan_out(db: Session, event: str, *, customer_id: Optional[str], values: dict, reference: str,
            key_base: str) -> List[NotificationDelivery]:
    """
    The SMS and WhatsApp versions of a transactional event, for each channel the
    store has switched on for it and the customer accepts. Called by
    `email.notify` (whether or not the email itself goes).
    """
    if event not in catalogue.EVENTS or catalogue.is_marketing(event) or not customer_id:
        return []
    routing = channel_routing(db)
    wanted = [c for c in ("sms", "whatsapp") if routing[c]["enabled"] and event in routing[c]["events"]]
    if not wanted:
        return []
    template = effective(db, event)
    if not template["enabled"]:
        return []
    customer = db.get(Customer, customer_id)
    if customer is None or customer.status != "active":
        return []
    number = normalise_phone(customer.phone)
    queued = []
    for channel in wanted:
        if not consent(db, customer_id, channel, "transactional"):
            continue
        provider = providers.for_channel(channel)
        ready, reason = provider.configured()
        dedupe = f"{key_base}:{channel}"
        values = {**base_variables(customer), **values}
        try:
            short = render_short(db, event, channel, values, template)
        except email_templates.TemplateError as error:
            logger.warning("Notification %s: invalid %s template: %s", event, channel, error)
            row = queue(db, key=dedupe, event=event, channel=channel, category="transactional", customer_id=customer_id,
                        recipient=number or "", payload=None, provider=provider.name, reference=reference,
                        status="skipped", error=f"The {channel} template is invalid: {error}")
            queued.append(row) if row else None
            continue
        skip = ("" if number else "The customer has no usable phone number.") or \
               ("" if ready else reason) or \
               ("" if channel != "whatsapp" or short.get("template") else
                "No approved WhatsApp template is set for this notification.") or \
               ("" if channel != "sms" or short.get("text") else "This notification has no SMS wording.")
        row = queue(db, key=dedupe, event=event, channel=channel, category="transactional", customer_id=customer_id,
                    recipient=number or "", payload=None if skip else short, provider=provider.name,
                    reference=reference, status="skipped" if skip else "queued", error=skip)
        if row is not None:
            queued.append(row)
    return queued


# ------------------------------------------------------------------ sending


def _backoff(attempts: int) -> timedelta:
    return timedelta(seconds=min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * (2 ** max(0, attempts - 1))))


def _claim(db: Session, ids: Optional[Iterable[int]], limit: int) -> List[int]:
    """Mark due deliveries as sending, so no other worker takes them. Returns their ids."""
    now = datetime.utcnow().replace(microsecond=0) + timedelta(seconds=1)
    # A worker that died mid-send left its rows "sending": they're retried.
    for row in db.execute(select(NotificationDelivery).where(
            NotificationDelivery.status == "sending", NotificationDelivery.updated_at < now - STALE_SENDING)
            .with_for_update(skip_locked=True).limit(100)).scalars():
        row.status, row.next_attempt_at, row.updated_at = "failed", now, now
        row.last_error = (row.last_error or "Interrupted while sending; retried.")[:500]
    conditions = [NotificationDelivery.status.in_(("queued", "failed")),
                  NotificationDelivery.next_attempt_at <= now]
    if ids is not None:
        conditions.append(NotificationDelivery.id.in_(list(ids)))
    rows = db.execute(select(NotificationDelivery).where(*conditions).order_by(NotificationDelivery.id)
                      .with_for_update(skip_locked=True).limit(limit)).scalars().all()
    for row in rows:
        row.status, row.updated_at = "sending", now
    db.commit()
    return [row.id for row in rows]


def _send_one(db: Session, row: NotificationDelivery) -> None:
    payload = row.payload or {}
    if row.channel == "email":
        from app.services import email as email_service
        from app.services.email import crypto
        from app.services.email.senders import SendError

        account = email_service.active_account(db)
        if account is None:
            raise providers.ProviderError("No email account is connected.", transient=True)
        if not payload.get("html"):
            raise providers.ProviderError("The email's content wasn't kept, so it can't be sent again.",
                                          transient=False)
        try:
            message_id = email_service._send_now(account.provider, crypto.unseal(account.credentials), account,
                                                 row.recipient, payload.get("subject", ""), payload["html"],
                                                 payload.get("text", "")) or ""
        except SendError as error:
            raise providers.ProviderError(str(error), transient=email_transient(str(error))) from None
        row.provider = account.provider
        row.provider_message_id = (message_id or None)
        _log_email(db, row, "sent", "", message_id)
        return
    if row.channel == "in_app":
        return
    provider = providers.for_channel(row.channel)
    result = provider.send(providers.Message(to=row.recipient, text=payload.get("text", ""),
                                             template=payload.get("template", ""),
                                             language=payload.get("language", "en"),
                                             variables=payload.get("variables")))
    row.provider = provider.name
    row.provider_message_id = result.message_id[:120]


def email_transient(message: str) -> bool:
    """A rejected address won't be accepted on a retry; a timeout might."""
    lowered = (message or "").lower()
    permanent = ("recipient", "address rejected", "no such user", "does not exist", "invalid address",
                 "mailbox unavailable", "user unknown")
    return not any(word in lowered for word in permanent)


def _log_email(db: Session, row: NotificationDelivery, status: str, error: str, provider_id: str = "") -> None:
    from app.models import EmailLog

    payload = row.payload or {}
    db.add(EmailLog(email_type=payload.get("type", row.event)[:40], recipient=row.recipient,
                    subject=(payload.get("subject") or "")[:255], status=status, error=error[:500],
                    reference=row.reference[:40], created_at=datetime.utcnow(),
                    provider_id=(provider_id or "")[:100] or None, template_key=row.template_key[:60],
                    delivery_id=row.id))


def process(db: Session, ids: Optional[Iterable[int]] = None, *, limit: int = 50) -> dict:
    """Send what's due (or these ids). Returns counts by outcome."""
    counts = {"sent": 0, "failed": 0, "dead": 0}
    for delivery_id in _claim(db, ids, limit):
        row = db.get(NotificationDelivery, delivery_id)
        if row is None:
            continue
        now = datetime.utcnow()
        row.attempts += 1
        try:
            _send_one(db, row)
        except providers.ProviderError as error:
            row.last_error = str(error)[:500]
            row.failed_at = now
            if error.transient and row.attempts < row.max_attempts:
                row.status, row.next_attempt_at = "failed", now + _backoff(row.attempts)
                counts["failed"] += 1
                logger.warning("Notification %s (%s) failed, retrying: %s", row.id, row.channel, row.last_error)
            else:
                row.status, row.next_attempt_at = "dead", None
                counts["dead"] += 1
                logger.error("Notification %s (%s) gave up after %s attempts: %s", row.id, row.channel,
                             row.attempts, row.last_error)
            if row.channel == "email":
                _log_email(db, row, "failed", row.last_error)
        except Exception as error:  # noqa: BLE001 — recorded, retried, never raised to the caller
            row.last_error = f"Unexpected error: {type(error).__name__}"[:500]
            row.status = "failed" if row.attempts < row.max_attempts else "dead"
            row.next_attempt_at = now + _backoff(row.attempts) if row.status == "failed" else None
            row.failed_at = now
            counts["failed" if row.status == "failed" else "dead"] += 1
            logger.exception("Notification %s (%s) failed unexpectedly", row.id, row.channel)
        else:
            row.status, row.sent_at, row.last_error, row.next_attempt_at = "sent", now, "", None
            if row.channel == "in_app":
                row.status, row.delivered_at = "delivered", now
            # A message with a sign-in link isn't kept once it's gone.
            if (row.payload or {}).get("type") in SECRET_EMAIL_TYPES:
                row.payload = None
            counts["sent"] += 1
            _mirror_campaign(db, row)
        row.updated_at = now
        if row.status in ("failed", "dead"):
            _mirror_campaign(db, row)
        db.commit()
    return counts


def _mirror_campaign(db: Session, row: NotificationDelivery) -> None:
    if row.campaign_id is None:
        return
    from app.models import CampaignRecipient

    recipient = db.execute(select(CampaignRecipient).where(CampaignRecipient.delivery_id == row.id)).scalar_one_or_none()
    if recipient is not None and recipient.status not in ("opened", "clicked"):
        recipient.status = row.status


def retry(db: Session, admin: AdminUser, delivery_id: int) -> NotificationDelivery:
    """Send a failed or given-up message again, from the portal. Same row, same idempotency key."""
    from app.services import audit

    row = db.execute(select(NotificationDelivery).where(NotificationDelivery.id == delivery_id)
                     .with_for_update()).scalar_one_or_none()
    if row is None:
        raise NotFoundError("No such notification.", error_code="NOTIFICATION_NOT_FOUND")
    if row.status not in ("failed", "dead", "skipped"):
        raise ValidationError("Only a failed or skipped message can be retried.", error_code="NOT_RETRYABLE")
    if row.channel == "email" and not (row.payload or {}).get("html"):
        raise ValidationError("This email's content wasn't kept (it carried a sign-in link), so it can't be "
                              "re-sent. Ask the customer to request a new one.", error_code="NOT_RETRYABLE")
    if row.channel in ("sms", "whatsapp"):
        ready, reason = providers.for_channel(row.channel).configured()
        if not ready:
            raise ValidationError(reason, error_code="CHANNEL_NOT_CONFIGURED")
        if not row.payload:
            raise ValidationError("This message has no content to send.", error_code="NOT_RETRYABLE")
    now = datetime.utcnow()
    row.status, row.next_attempt_at, row.updated_at = "queued", now, now
    row.max_attempts = max(row.max_attempts, row.attempts + 1)
    audit.record(db, "notifications.retry", resource_type="notifications", resource_id=row.id, actor=admin,
                 summary=f"Retried a {row.channel} message ({row.event})")
    db.commit()
    process(db, [row.id])
    db.refresh(row)
    return row


@sa_event.listens_for(Session, "after_commit")
def _send_after_commit(session: Session) -> None:
    ids = session.info.pop("outgoing_messages", None)
    if not ids or session.info.get("test_session"):
        return  # the tests send explicitly with `process`; the loop catches anything left

    def run() -> None:
        from app.core.database import SessionLocal

        with SessionLocal() as db:
            try:
                process(db, ids)
            except Exception:  # noqa: BLE001
                logger.exception("Sending queued notifications failed; the loop will retry.")

    threading.Thread(target=run, daemon=False, name="notification-sender").start()


@sa_event.listens_for(Session, "after_rollback")
def _drop_after_rollback(session: Session) -> None:
    session.info.pop("outgoing_messages", None)


# --------------------------------------------------------- provider status


def _set_status(db: Session, message_id: str, status: str, error: str = "") -> bool:
    row = db.execute(select(NotificationDelivery).where(NotificationDelivery.provider_message_id == message_id)
                     ).scalars().first()
    if row is None:
        return False
    rank = {"queued": 0, "sending": 1, "sent": 2, "delivered": 3, "read": 4}
    now = datetime.utcnow()
    if status in ("failed", "undelivered"):
        row.status, row.last_error, row.failed_at = "dead", (error or "The provider couldn't deliver it.")[:500], now
    elif rank.get(status, -1) > rank.get(row.status, -1):
        row.status = status
        if status in ("delivered", "read") and row.delivered_at is None:
            row.delivered_at = now
    row.updated_at = now
    _mirror_campaign(db, row)
    if status == "read" and row.campaign_id:
        from app.models import CampaignRecipient

        recipient = db.execute(select(CampaignRecipient).where(CampaignRecipient.delivery_id == row.id)).scalar_one_or_none()
        if recipient is not None and recipient.opened_at is None:
            recipient.opened_at = now
    db.commit()
    return True


def twilio_signature_valid(url: str, params: Dict[str, str], signature: str) -> bool:
    token = settings.TWILIO_AUTH_TOKEN
    if not token or not signature:
        return False
    data = url + "".join(f"{k}{params[k]}" for k in sorted(params))
    expected = base64.b64encode(hmac.new(token.encode(), data.encode(), hashlib.sha1).digest()).decode()
    return hmac.compare_digest(expected, signature)


TWILIO_STATUS = {"queued": "sent", "accepted": "sent", "sending": "sent", "sent": "sent", "delivered": "delivered",
                 "read": "read", "failed": "failed", "undelivered": "undelivered"}


def twilio_status(db: Session, params: Dict[str, str]) -> bool:
    status = TWILIO_STATUS.get((params.get("MessageStatus") or "").lower())
    sid = params.get("MessageSid") or ""
    if not status or not sid:
        return False
    error = f"Twilio error {params.get('ErrorCode')}" if params.get("ErrorCode") else ""
    return _set_status(db, sid, status, error)


def whatsapp_signature_valid(body: bytes, signature: str) -> bool:
    secret = settings.WHATSAPP_APP_SECRET
    if not secret or not signature.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature[7:])


def whatsapp_event(db: Session, payload: dict) -> int:
    """Meta's webhook: delivery statuses, and replies (credited to the campaign that reached that number)."""
    handled = 0
    for entry in payload.get("entry") or []:
        for change in entry.get("changes") or []:
            value = change.get("value") or {}
            for status in value.get("statuses") or []:
                errors = status.get("errors") or [{}]
                if _set_status(db, status.get("id", ""), status.get("status", ""), errors[0].get("title", "")):
                    handled += 1
            for message in value.get("messages") or []:
                if _credit_reply(db, "+" + str(message.get("from", "")).lstrip("+")):
                    handled += 1
    return handled


def _credit_reply(db: Session, number: str) -> bool:
    from app.models import CampaignRecipient

    since = datetime.utcnow() - timedelta(days=7)
    row = db.execute(select(NotificationDelivery).where(
        NotificationDelivery.recipient == number, NotificationDelivery.channel == "whatsapp",
        NotificationDelivery.campaign_id.is_not(None), NotificationDelivery.created_at >= since)
        .order_by(NotificationDelivery.id.desc())).scalars().first()
    if row is None:
        return False
    recipient = db.execute(select(CampaignRecipient).where(CampaignRecipient.delivery_id == row.id)).scalar_one_or_none()
    if recipient is None or recipient.replied_at is not None:
        return False
    recipient.replied_at = datetime.utcnow()
    db.commit()
    return True


# ------------------------------------------------------------------- admin


def view(row: NotificationDelivery, *, customer: Optional[Customer] = None, full: bool = False) -> dict:
    spec = catalogue.EVENTS.get(row.event)
    out = {
        "id": row.id, "event": row.event, "eventLabel": spec["label"] if spec else row.event.replace("_", " "),
        "channel": row.channel, "category": row.category, "recipient": mask(row.recipient),
        "customer": {"id": customer.id, "name": customer.full_name} if customer else None,
        "template": row.template_key, "provider": row.provider, "status": row.status, "attempts": row.attempts,
        "maxAttempts": row.max_attempts, "lastError": row.last_error, "providerMessageId": row.provider_message_id,
        "reference": row.reference, "campaignId": row.campaign_id, "createdAt": row.created_at, "sentAt": row.sent_at,
        "deliveredAt": row.delivered_at, "failedAt": row.failed_at, "nextAttemptAt": row.next_attempt_at,
        "retryable": row.status in ("failed", "dead", "skipped"),
    }
    if full:
        payload = row.payload or {}
        out["content"] = {k: payload.get(k) for k in ("subject", "text", "template", "variables", "title", "body")
                          if payload.get(k)}
    return out


def search(db: Session, *, channel: str = "", status: str = "", event: str = "", customer: str = "", q: str = "",
           date_from: Optional[datetime] = None, date_to: Optional[datetime] = None, page: int = 1,
           page_size: int = 25) -> tuple:
    conditions = []
    if channel in CHANNELS:
        conditions.append(NotificationDelivery.channel == channel)
    if event:
        conditions.append(NotificationDelivery.event == event)
    if customer:
        conditions.append(NotificationDelivery.customer_id == customer)
    if q:
        like = f"%{q.strip()}%"
        matching = select(Customer.id).where(or_(Customer.email.ilike(like), Customer.first_name.ilike(like),
                                                 Customer.last_name.ilike(like)))
        conditions.append(or_(NotificationDelivery.reference.ilike(like), NotificationDelivery.recipient == q.strip(),
                              NotificationDelivery.customer_id.in_(matching),
                              NotificationDelivery.provider_message_id == q.strip()))
    if date_from:
        conditions.append(NotificationDelivery.created_at >= date_from)
    if date_to:
        conditions.append(NotificationDelivery.created_at < date_to)
    counts = dict(db.execute(select(NotificationDelivery.status, func.count()).where(*conditions)
                             .group_by(NotificationDelivery.status)).all())
    if status:
        conditions.append(NotificationDelivery.status == status)
    total = db.execute(select(func.count()).select_from(NotificationDelivery).where(*conditions)).scalar_one()
    rows = db.execute(select(NotificationDelivery).where(*conditions)
                      .order_by(NotificationDelivery.id.desc()).offset((page - 1) * page_size).limit(page_size)
                      ).scalars().all()
    people = {c.id: c for c in db.execute(select(Customer).where(
        Customer.id.in_({r.customer_id for r in rows if r.customer_id}))).scalars()} if rows else {}
    return [view(r, customer=people.get(r.customer_id)) for r in rows], int(total), {k: int(v) for k, v in counts.items()}


def overview(db: Session, *, days: int = 7) -> dict:
    since = datetime.utcnow() - timedelta(days=days)
    rows = db.execute(select(NotificationDelivery.channel, NotificationDelivery.status, func.count())
                      .where(NotificationDelivery.created_at >= since)
                      .group_by(NotificationDelivery.channel, NotificationDelivery.status)).all()
    by_channel: Dict[str, dict] = {c: {"total": 0} for c in CHANNELS}
    for channel, status, count in rows:
        bucket = by_channel.setdefault(channel, {"total": 0})
        bucket[status] = int(count)
        bucket["total"] += int(count)
    waiting = db.execute(select(func.count()).select_from(NotificationDelivery).where(
        NotificationDelivery.status == "failed")).scalar_one()
    dead = db.execute(select(func.count()).select_from(NotificationDelivery).where(
        NotificationDelivery.status == "dead", NotificationDelivery.created_at >= since)).scalar_one()
    return {"days": days, "channels": channel_status(db), "byChannel": by_channel, "retrying": int(waiting),
            "gaveUp": int(dead), "routing": channel_routing(db)}


# ---------------------------------------------------------------- the loop


def _membership_notices(db: Session) -> int:
    """Membership ending in a week, and ended — once each, through the usual pipeline."""
    from app.models import CustomerMembership
    from app.services import email as email_service, membership

    membership.expire_lapsed(db)
    now = datetime.utcnow()
    sent = 0
    for kind, conditions in (
        ("membership_expiring", [CustomerMembership.status == "active", CustomerMembership.ends_at > now,
                                 CustomerMembership.ends_at <= now + timedelta(days=7)]),
        ("membership_expired", [CustomerMembership.status == "expired",
                                CustomerMembership.ends_at >= now - timedelta(days=3)]),
    ):
        for row in db.execute(select(CustomerMembership).where(*conditions).limit(200)).scalars():
            key = f"{kind}:{row.id}"
            if db.execute(select(NotificationDelivery.id).where(
                    NotificationDelivery.idempotency_key.like(f"{key}:%"))).first():
                continue
            customer = db.get(Customer, row.customer_id)
            if customer is None or customer.status != "active":
                continue
            values = {**base_variables(customer), "membership_plan": row.plan_name,
                      "membership_expiry": row.ends_at.strftime("%d %b %Y") if row.ends_at else "",
                      "membership_url": f"{email_templates.brand()['url']}/membership"}
            subject, html, text = render_email(db, kind, values)
            email_service.notify(db, "membership", to=customer.email, customer_id=customer.id, subject=subject,
                                 html=html, text=text, reference=row.id, event=kind, variables=values,
                                 idempotency_key=key)
            # A marker so the next pass knows, even when no email account is connected.
            queue(db, key=f"{key}:marker", event=kind, channel="in_app", category="transactional",
                  customer_id=customer.id, recipient="", payload=None, status="delivered", reference=row.id)
            sent += 1
        db.commit()
    return sent


def sweep(db: Session) -> dict:
    counts = process(db, limit=200)
    try:
        counts["memberships"] = _membership_notices(db)
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.exception("Membership notices failed; retrying next pass.")
    _alert_dead(db)
    return counts


def _alert_dead(db: Session) -> None:
    """One staff alert per hour at most, when messages have been given up on."""
    from app.services import inbox

    since = datetime.utcnow() - timedelta(hours=1)
    dead = db.execute(select(func.count()).select_from(NotificationDelivery).where(
        NotificationDelivery.status == "dead", NotificationDelivery.updated_at >= since,
        NotificationDelivery.category == "transactional")).scalar_one()
    if not dead:
        return
    marker = f"alert:dead:{datetime.utcnow():%Y%m%d%H}"
    if queue(db, key=marker, event="system_alert", channel="in_app", category="transactional", customer_id=None,
             recipient="", payload=None, status="delivered") is None:
        return
    inbox.staff(db, "notifications", f"{dead} customer message{'s' if dead != 1 else ''} couldn't be delivered",
                "They failed after every retry. See the reasons in Notifications.",
                "/admin/notifications?status=dead", permission="notifications")
    db.commit()


def _sweep_once() -> None:
    from app.core.database import SessionLocal

    with SessionLocal() as db:
        try:
            sweep(db)
        except Exception:
            db.rollback()
            raise


async def run_forever() -> None:
    import asyncio

    from app.services import jobs

    logger.info("Notifications sent and retried every %ss.", INTERVAL_SECONDS)
    while True:
        try:
            await asyncio.to_thread(jobs.tracked("notifications", INTERVAL_SECONDS, _sweep_once))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Notification sweep failed; retrying next interval.")
        await asyncio.sleep(INTERVAL_SECONDS)


def new_token() -> str:
    return secrets.token_hex(16)
