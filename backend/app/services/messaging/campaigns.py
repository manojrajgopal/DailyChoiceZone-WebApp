"""
Marketing campaigns.

    campaign → audience (filters over customers and their orders)
             → consent (each channel's marketing opt-in) and reachability
             → content per channel → test send → confirmed launch
             → recipients (unique per campaign, customer and channel)
             → deliveries through the notification queue → analytics

## Safety

Nothing goes to customers until someone:

1. previews the audience and sees how many messages it means, per channel;
2. sends a test of the current content (any edit after the test needs a new
   one);
3. launches, confirming that same number — if the audience has changed since
   they looked, the launch is refused and they're shown the new figure.

A campaign can be launched once: `launch_key` is unique, and launching moves
it out of draft under a row lock. Sending is done by the background job,
which creates one `CampaignRecipient` per customer and channel (unique in the
database) and one delivery each (with its own idempotency key) — so a restart
or a retry carries on where it stopped and never sends anybody the same
message twice.

## Consent

Every channel is opt-in for marketing (`ChannelPreference`, category
`marketing`), whatever the audience filters say, and every marketing email
carries a one-click unsubscribe link.

## What is measured

Only what the channel can tell us: email opens (when `PUBLIC_API_URL` is set,
so a tracking image can reach this API), clicks (through the storefront's
`/r/<token>` link), bounces (from the bounce checker), SMS and WhatsApp
delivery (from provider webhooks), WhatsApp reads and replies. Anything a
channel can't report is shown as not available, never estimated. Revenue is
the orders a recipient placed within 7 days of clicking, or with the
campaign's coupon after it went out.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import re
import secrets
from datetime import date, datetime, timedelta
from typing import Dict, Iterable, List, Optional, Set
from urllib.parse import quote

from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import (
    AdminUser,
    CampaignRecipient,
    CartRecovery,
    ChannelPreference,
    Customer,
    CustomerMembership,
    EmailLog,
    MarketingCampaign,
    NotificationDelivery,
    Order,
    OrderItem,
    Product,
)
from app.services import audit
from app.services.email import templates as email_templates
from app.services.messaging import providers, service as messaging

logger = logging.getLogger(__name__)

KINDS = {
    "promotional": "Promotional",
    "product_announcement": "Product announcement",
    "new_arrival": "New arrivals",
    "discount": "Discount",
    "flash_promotion": "Flash promotion",
    "membership": "Membership",
    "abandoned_cart": "Abandoned bag",
    "announcement": "General announcement",
}
SEGMENTS = ("all", "members", "non_members", "new", "repeat", "lapsed")
CHANNELS = ("email", "sms", "whatsapp", "in_app")
VARIABLES = ["customer_name", "store_name", "store_url", "action_url", "campaign_title", "coupon_code"]
ATTRIBUTION_DAYS = 7
BATCH = 200
INTERVAL_SECONDS = 60
MAX_AUDIENCE = 100_000

# Starting content for each kind, so a new campaign isn't a blank page.
STARTERS = {
    "promotional": ("Something for you this week", "Hand-picked pieces and a little something off — while it lasts."),
    "product_announcement": ("Introducing something new", "We've been working on this one for a while. Take a look."),
    "new_arrival": ("Just landed", "Fresh arrivals are in. Be the first to see them."),
    "discount": ("A discount, just for you", "Use code {{coupon_code}} at checkout."),
    "flash_promotion": ("Flash sale — hours only", "Prices drop for a few hours. Don't miss it."),
    "membership": ("Join the club", "Members get free delivery and member-only prices."),
    "abandoned_cart": ("Still thinking it over?", "The pieces you picked are waiting in your bag."),
    "announcement": ("News from us", "Here's what's new."),
}


# ----------------------------------------------------------------- audience


def _date(value, label: str) -> Optional[datetime]:
    if value in (None, ""):
        return None
    try:
        return datetime.combine(date.fromisoformat(str(value)[:10]), datetime.min.time()) - timedelta(hours=5, minutes=30)
    except ValueError:
        raise ValidationError(f"{label} isn't a date.", error_code="INVALID_AUDIENCE") from None


def _number(value, label: str, *, whole: bool = True) -> Optional[float]:
    if value in (None, ""):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValidationError(f"{label} must be a number.", error_code="INVALID_AUDIENCE") from None
    if number < 0:
        raise ValidationError(f"{label} can't be negative.", error_code="INVALID_AUDIENCE")
    return int(number) if whole else number


def _segment_id(value) -> Optional[int]:
    if value in (None, "", 0):
        return None
    if isinstance(value, bool):
        raise ValidationError("Choose a segment from the list.", error_code="INVALID_AUDIENCE")
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ValidationError("Choose a segment from the list.", error_code="INVALID_AUDIENCE") from None
    if number < 1 or str(number) != str(value).strip():
        raise ValidationError("Choose a segment from the list.", error_code="INVALID_AUDIENCE")
    return number


def clean_audience(raw: Optional[dict]) -> dict:
    raw = raw or {}
    segment = raw.get("segment") or "all"
    if segment not in SEGMENTS:
        raise ValidationError("Choose who the campaign is for.", error_code="INVALID_AUDIENCE")
    audience = {
        "segment": segment,
        "joinedWithinDays": _number(raw.get("joinedWithinDays"), "Joined within (days)"),
        "orderedFrom": str(raw.get("orderedFrom") or "")[:10] or None,
        "orderedTo": str(raw.get("orderedTo") or "")[:10] or None,
        "notOrderedDays": _number(raw.get("notOrderedDays"), "Not ordered for (days)"),
        "minSpent": _number(raw.get("minSpent"), "Spent at least", whole=False),
        "maxSpent": _number(raw.get("maxSpent"), "Spent at most", whole=False),
        "minOrders": _number(raw.get("minOrders"), "At least this many orders"),
        "maxOrders": _number(raw.get("maxOrders"), "At most this many orders"),
        "productIds": [str(p)[:20] for p in (raw.get("productIds") or [])][:50],
        "categoryIds": [str(c)[:20] for c in (raw.get("categoryIds") or [])][:50],
        "membershipPlanIds": [str(m)[:20] for m in (raw.get("membershipPlanIds") or [])][:20],
        "abandonedCart": bool(raw.get("abandonedCart")),
        # A saved customer segment (docs/customer-segmentation.md): its members, intersected with the rest.
        "segmentId": _segment_id(raw.get("segmentId")),
    }
    _date(audience["orderedFrom"], "Ordered from")
    _date(audience["orderedTo"], "Ordered to")
    if audience["minSpent"] is not None and audience["maxSpent"] is not None and audience["minSpent"] > audience["maxSpent"]:
        raise ValidationError("The lowest spend is above the highest.", error_code="INVALID_AUDIENCE")
    if audience["minOrders"] is not None and audience["maxOrders"] is not None and audience["minOrders"] > audience["maxOrders"]:
        raise ValidationError("The fewest orders is above the most.", error_code="INVALID_AUDIENCE")
    return audience


def audience_ids(db: Session, audience: dict) -> List[str]:
    """The customers the filters describe (before consent). Active accounts only."""
    now = datetime.utcnow()
    live = Order.status != "cancelled"
    totals = (select(Order.customer_id.label("cid"), func.count(Order.id).label("orders"),
                     func.coalesce(func.sum(Order.total), 0).label("spent"), func.max(Order.placed_at).label("last"))
              .where(live).group_by(Order.customer_id).subquery())
    query = select(Customer.id).outerjoin(totals, totals.c.cid == Customer.id).where(Customer.status == "active")
    member = exists().where(CustomerMembership.customer_id == Customer.id, CustomerMembership.status == "active",
                            or_(CustomerMembership.ends_at.is_(None), CustomerMembership.ends_at > now))
    orders = func.coalesce(totals.c.orders, 0)
    segment = audience["segment"]
    if segment == "members":
        query = query.where(member)
    elif segment == "non_members":
        query = query.where(~member)
    elif segment == "new":
        query = query.where(Customer.joined_at >= now - timedelta(days=audience.get("joinedWithinDays") or 30))
    elif segment == "repeat":
        query = query.where(orders >= 2)
    elif segment == "lapsed":
        query = query.where(orders >= 1, totals.c.last < now - timedelta(days=audience.get("notOrderedDays") or 90))
    if audience.get("joinedWithinDays") and segment != "new":
        query = query.where(Customer.joined_at >= now - timedelta(days=audience["joinedWithinDays"]))
    if audience.get("notOrderedDays") and segment != "lapsed":
        query = query.where(or_(totals.c.last.is_(None), totals.c.last < now - timedelta(days=audience["notOrderedDays"])))
    start, end = _date(audience.get("orderedFrom"), ""), _date(audience.get("orderedTo"), "")
    if start or end:
        window = [Order.customer_id == Customer.id, live]
        if start:
            window.append(Order.placed_at >= start)
        if end:
            window.append(Order.placed_at < end + timedelta(days=1))
        query = query.where(exists().where(*window))
    if audience.get("minSpent") is not None:
        query = query.where(func.coalesce(totals.c.spent, 0) >= audience["minSpent"])
    if audience.get("maxSpent") is not None:
        query = query.where(func.coalesce(totals.c.spent, 0) <= audience["maxSpent"])
    if audience.get("minOrders") is not None:
        query = query.where(orders >= audience["minOrders"])
    if audience.get("maxOrders") is not None:
        query = query.where(orders <= audience["maxOrders"])
    if audience.get("productIds"):
        query = query.where(exists().where(OrderItem.order_id == Order.id, Order.customer_id == Customer.id, live,
                                           OrderItem.product_id.in_(audience["productIds"])))
    if audience.get("categoryIds"):
        query = query.where(exists().where(OrderItem.order_id == Order.id, Order.customer_id == Customer.id, live,
                                           OrderItem.product_id == Product.id,
                                           Product.category_id.in_(audience["categoryIds"])))
    if audience.get("membershipPlanIds"):
        query = query.where(exists().where(CustomerMembership.customer_id == Customer.id,
                                           CustomerMembership.status == "active",
                                           CustomerMembership.plan_id.in_(audience["membershipPlanIds"])))
    if audience.get("abandonedCart"):
        query = query.where(exists().where(CartRecovery.customer_id == Customer.id,
                                           CartRecovery.status == "abandoned"))
    if audience.get("segmentId"):
        from app.services.segments import service as segments

        query = query.where(Customer.id.in_(segments.member_ids_query(db, audience["segmentId"])))
    return list(db.execute(query.order_by(Customer.id).limit(MAX_AUDIENCE)).scalars())


def reachable(db: Session, ids: List[str], channels: Iterable[str]) -> Dict[str, List[str]]:
    """Per channel: who agrees to marketing on it (by choice or by default) and can be reached there."""
    out: Dict[str, List[str]] = {}
    if not ids:
        return {c: [] for c in channels}
    consented: Dict[str, Set[str]] = {}
    for channel in channels:
        # On by default: everyone except those who turned it off. Off by default: only those who said yes.
        default_on = messaging.DEFAULT_CONSENT.get((channel, "marketing"), False)
        chosen: Set[str] = set()
        for chunk in range(0, len(ids), 1000):
            part = ids[chunk:chunk + 1000]
            chosen |= set(db.execute(select(ChannelPreference.customer_id).where(
                ChannelPreference.customer_id.in_(part), ChannelPreference.channel == channel,
                ChannelPreference.category == "marketing", ChannelPreference.enabled.is_(not default_on))).scalars())
        consented[channel] = set(ids) - chosen if default_on else chosen
    contacts = {}
    for chunk in range(0, len(ids), 1000):
        for cid, email, phone in db.execute(select(Customer.id, Customer.email, Customer.phone)
                                            .where(Customer.id.in_(ids[chunk:chunk + 1000]))).all():
            contacts[cid] = (email, phone)
    for channel in channels:
        rows = []
        for cid in ids:
            if cid not in consented[channel]:
                continue
            email, phone = contacts.get(cid, ("", ""))
            if channel == "email" and (not email or "@" not in email):
                continue
            if channel in ("sms", "whatsapp") and not messaging.normalise_phone(phone):
                continue
            rows.append(cid)
        out[channel] = rows
    return out


def estimate(db: Session, audience: dict, channels: Iterable[str]) -> dict:
    audience = clean_audience(audience)
    channels = [c for c in channels if c in CHANNELS]
    ids = audience_ids(db, audience)
    per = reachable(db, ids, channels)
    return {"matching": len(ids), "channels": {c: len(per[c]) for c in channels},
            "messages": sum(len(v) for v in per.values()),
            "excluded": {c: len(ids) - len(per[c]) for c in channels},
            "capped": len(ids) >= MAX_AUDIENCE}


# ----------------------------------------------------------------- content


def _clean_url(value: str, label: str) -> str:
    value = (value or "").strip()
    if not value:
        return ""
    if not (value.startswith("https://") or value.startswith("http://") or value.startswith("/")):
        raise ValidationError(f"{label} must be a web address or a path on the shop.", error_code="INVALID_CONTENT")
    return value[:500]


def clean_content(raw: Optional[dict], channels: Iterable[str], *, strict: bool) -> dict:
    """Each channel's content, checked. `strict` (on launch) requires every chosen channel to have some."""
    raw = raw or {}
    content: dict = {}

    def check_vars(text: str, label: str) -> None:
        unknown = email_templates.unknown_variables(text, VARIABLES)
        if unknown:
            raise ValidationError(f"The {label} uses {', '.join('{{' + u + '}}' for u in unknown)}. Available: "
                                  f"{', '.join('{{' + v + '}}' for v in VARIABLES)}.",
                                  error_code="INVALID_TEMPLATE_VARIABLE", details={"unknown": unknown})

    email = raw.get("email") or {}
    content["email"] = {
        "subject": str(email.get("subject") or "").strip()[:200],
        "preview": str(email.get("preview") or "").strip()[:200],
        "heading": str(email.get("heading") or "").strip()[:200],
        "html": email_templates.sanitise_html(str(email.get("html") or ""))[:50_000],
        "ctaLabel": str(email.get("ctaLabel") or "").strip()[:60],
        "ctaUrl": _clean_url(str(email.get("ctaUrl") or ""), "The button link"),
    }
    sms = raw.get("sms") or {}
    content["sms"] = {"text": str(sms.get("text") or "").strip()}
    whatsapp = raw.get("whatsapp") or {}
    content["whatsapp"] = {
        "template": str(whatsapp.get("template") or "").strip()[:120],
        "language": str(whatsapp.get("language") or "en").strip()[:12],
        "variables": [str(v) for v in (whatsapp.get("variables") or [])][:10],
    }
    in_app = raw.get("in_app") or {}
    content["in_app"] = {"title": str(in_app.get("title") or "").strip()[:200],
                         "body": str(in_app.get("body") or "").strip()[:500],
                         "url": _clean_url(str(in_app.get("url") or ""), "The in-app link")}
    for label, text in (("email subject", content["email"]["subject"]), ("email heading", content["email"]["heading"]),
                        ("email message", content["email"]["html"]), ("preview text", content["email"]["preview"]),
                        ("SMS", content["sms"]["text"]), ("in-app title", content["in_app"]["title"]),
                        ("in-app message", content["in_app"]["body"])):
        check_vars(text, label)
    bad = [v for v in content["whatsapp"]["variables"] if v not in VARIABLES]
    if bad:
        raise ValidationError(f"WhatsApp variables must be from: {', '.join(VARIABLES)}.", error_code="INVALID_CONTENT")
    if len(content["sms"]["text"]) > messaging.SMS_LIMIT:
        raise ValidationError(f"Keep the SMS under {messaging.SMS_LIMIT} characters.", error_code="INVALID_CONTENT")
    if strict:
        for channel in channels:
            if channel == "email" and not (content["email"]["subject"] and content["email"]["html"]):
                raise ValidationError("The email needs a subject and a message.", error_code="CONTENT_REQUIRED")
            if channel == "sms" and not content["sms"]["text"]:
                raise ValidationError("The SMS needs a message.", error_code="CONTENT_REQUIRED")
            if channel == "whatsapp" and not content["whatsapp"]["template"]:
                raise ValidationError("WhatsApp needs an approved template name.", error_code="CONTENT_REQUIRED")
            if channel == "in_app" and not (content["in_app"]["title"] and content["in_app"]["body"]):
                raise ValidationError("The in-app message needs a title and a message.", error_code="CONTENT_REQUIRED")
    return content


def _parse_when(value, label: str) -> Optional[datetime]:
    if value in (None, ""):
        return None
    from app.utils.dates import parse_dt

    parsed = parse_dt(str(value))
    if parsed is None:
        raise ValidationError(f"{label} isn't a valid date and time.", error_code="INVALID_DATE")
    return parsed.replace(microsecond=0)


# ------------------------------------------------------------------ CRUD


def _load(db: Session, campaign_id: int, *, lock: bool = False) -> MarketingCampaign:
    query = select(MarketingCampaign).where(MarketingCampaign.id == campaign_id)
    row = db.execute(query.with_for_update() if lock else query).scalar_one_or_none()
    if row is None:
        raise NotFoundError("No such campaign.", error_code="CAMPAIGN_NOT_FOUND")
    return row


AUDITED = ("name", "kind", "status", "channels", "scheduled_at", "coupon_code", "starts_at", "ends_at")


def save(db: Session, admin: AdminUser, payload: dict, campaign_id: Optional[int] = None) -> MarketingCampaign:
    name = str(payload.get("name") or "").strip()
    if not 3 <= len(name) <= 160:
        raise ValidationError("Give the campaign a name (3 to 160 characters).", error_code="INVALID_CAMPAIGN")
    kind = payload.get("kind") or "promotional"
    if kind not in KINDS:
        raise ValidationError("Choose a campaign type.", error_code="INVALID_CAMPAIGN")
    channels = [c for c in (payload.get("channels") or []) if c in CHANNELS]
    if not channels:
        raise ValidationError("Choose at least one channel.", error_code="INVALID_CAMPAIGN")
    audience = clean_audience(payload.get("audience"))
    content = clean_content(payload.get("content"), channels, strict=False)
    starts_at, ends_at = _parse_when(payload.get("startsAt"), "The start"), _parse_when(payload.get("endsAt"), "The end")
    if starts_at and ends_at and ends_at <= starts_at:
        raise ValidationError("The campaign must end after it starts.", error_code="INVALID_CAMPAIGN")
    coupon = str(payload.get("couponCode") or "").strip().upper()[:40]
    now = datetime.utcnow()
    if campaign_id is None:
        row = MarketingCampaign(created_by=admin.id, created_at=now, status="draft", recipients_total=0, last_error="")
        db.add(row)
        before = {}
    else:
        row = _load(db, campaign_id, lock=True)
        if row.status != "draft":
            raise ConflictError("Only a draft can be changed. Cancel it first to make changes.",
                                error_code="CAMPAIGN_NOT_DRAFT")
        before = audit.snapshot(row, AUDITED)
    if row.content != content or row.channels != channels:
        row.content_updated_at = now
    row.name, row.description, row.kind = name, str(payload.get("description") or "")[:500], kind
    row.channels, row.audience, row.content, row.coupon_code = channels, audience, content, coupon
    row.starts_at, row.ends_at = starts_at, ends_at
    row.updated_at = now
    db.flush()
    audit.record(db, "campaign.create" if campaign_id is None else "campaign.update", resource_type="campaigns",
                 resource_id=row.id, actor=admin, summary=f"{'Created' if campaign_id is None else 'Changed'} "
                 f"campaign {row.name}", changes=audit.diff(before, audit.snapshot(row, AUDITED)))
    db.commit()
    return row


def duplicate(db: Session, admin: AdminUser, campaign_id: int) -> MarketingCampaign:
    source = _load(db, campaign_id)
    payload = {"name": f"{source.name} (copy)"[:160], "description": source.description, "kind": source.kind,
               "channels": source.channels, "audience": source.audience, "content": source.content,
               "couponCode": source.coupon_code}
    return save(db, admin, payload)


def delete(db: Session, admin: AdminUser, campaign_id: int) -> None:
    row = _load(db, campaign_id, lock=True)
    if row.status != "draft":
        raise ConflictError("Only a draft can be deleted; a sent campaign is kept for its results.",
                            error_code="CAMPAIGN_NOT_DRAFT")
    audit.record(db, "campaign.delete", resource_type="campaigns", resource_id=row.id, actor=admin,
                 summary=f"Deleted campaign {row.name}")
    db.delete(row)
    db.commit()


# ---------------------------------------------------------------- rendering


def tracking_base() -> str:
    return (settings.PUBLIC_API_URL or "").rstrip("/")


def _click_signature(token: str, url: str) -> str:
    return hmac.new(f"click:{settings.JWT_SECRET_KEY}".encode(), f"{token}|{url}".encode(), hashlib.sha256).hexdigest()[:24]


def click_url(token: str, target: str) -> str:
    """A link through the storefront's /r/<token>, which records the click and moves on to `target`."""
    store = settings.STOREFRONT_URL.rstrip("/")
    target = target if target.startswith("http") else f"{store}{target if target.startswith('/') else '/' + target}"
    return f"{store}/r/{token}?to={quote(target, safe='')}&s={_click_signature(token, target)}"


def safe_target(token: str, target: str, signature: str) -> Optional[str]:
    """The destination of a tracked link, if the signature matches — so it can't redirect anywhere else."""
    if not target or not hmac.compare_digest(_click_signature(token, target), signature or ""):
        return None
    return target


def values_for(campaign: MarketingCampaign, customer: Optional[Customer]) -> dict:
    content = campaign.content or {}
    brand = email_templates.brand()
    return {
        "customer_name": (customer.first_name if customer and customer.first_name else "there"),
        "store_name": brand["name"], "store_url": brand["url"],
        "action_url": (content.get("email") or {}).get("ctaUrl") or brand["url"],
        "campaign_title": (content.get("email") or {}).get("heading") or campaign.name,
        "coupon_code": campaign.coupon_code or "",
    }


def _rewrite_links(markup: str, token: str) -> str:
    return re.sub(r'href="(https?://[^"]+|/[^"]*)"', lambda m: f'href="{email_templates.esc(click_url(token, m.group(1)), quote=True)}"',
                  markup)


def render(campaign: MarketingCampaign, channel: str, customer: Optional[Customer], token: str) -> dict:
    content = campaign.content or {}
    values = values_for(campaign, customer)
    store = settings.STOREFRONT_URL.rstrip("/")
    if channel == "email":
        email = content.get("email") or {}
        # The admin's HTML is already sanitised; customer values go into it escaped, and the result
        # is sanitised again so nothing a value contains can become markup.
        escaped = {k: email_templates.esc(str(v)) for k, v in values.items()}
        body = email_templates.sanitise_html(email_templates.render(email.get("html", ""), escaped, allowed=VARIABLES))
        body = _rewrite_links(body, token)
        cta = (email["ctaLabel"], click_url(token, email["ctaUrl"])) if email.get("ctaLabel") and email.get("ctaUrl") else None
        unsubscribe = f"{store}/unsubscribe?token={messaging.unsubscribe_token(customer.id, 'email', campaign.id)}" if customer else f"{store}/unsubscribe"
        pixel = f"{tracking_base()}{settings.API_PREFIX}/c/o/{token}.gif" if tracking_base() else ""
        heading = email_templates.render(email.get("heading") or campaign.name, values, allowed=VARIABLES)
        html = email_templates.master(
            title=heading, body_html=body, cta=cta,
            preheader=email_templates.render(email.get("preview", ""), values, allowed=VARIABLES),
            marketing=True, unsubscribe_url=unsubscribe, preferences_url=f"{store}/account/settings", tracking_pixel=pixel,
        )
        subject = email_templates.render(email.get("subject", ""), values, allowed=VARIABLES)
        text = (f"{heading}\n\n{email_templates.text_from_html(body)}"
                + (f"\n\n{cta[0]}: {cta[1]}" if cta else "") + f"\n\nUnsubscribe: {unsubscribe}")
        return {"subject": subject[:255], "html": html, "text": text, "type": "offers"}
    if channel == "sms":
        text = email_templates.render((content.get("sms") or {}).get("text", ""), values, allowed=VARIABLES)
        target = (content.get("email") or {}).get("ctaUrl") or ""
        text = text.replace(values["action_url"], click_url(token, target)) if target and values["action_url"] in text else text
        return {"text": f"{text} Reply STOP to opt out."[:messaging.SMS_LIMIT]}
    if channel == "whatsapp":
        whatsapp = content.get("whatsapp") or {}
        return {"template": whatsapp.get("template", ""), "language": whatsapp.get("language", "en"),
                "variables": [str(values.get(v, "")) for v in whatsapp.get("variables", [])]}
    in_app = content.get("in_app") or {}
    return {"title": email_templates.render(in_app.get("title", ""), values, allowed=VARIABLES)[:200],
            "body": email_templates.render(in_app.get("body", ""), values, allowed=VARIABLES)[:500],
            "href": in_app.get("url") or ""}


def preview(db: Session, campaign_id: int) -> dict:
    campaign = _load(db, campaign_id)
    sample = Customer(id="CUS-PREVIEW", first_name="Asha", last_name="", email="asha@example.com", phone="")
    out = {}
    for channel in campaign.channels:
        try:
            out[channel] = render(campaign, channel, sample, "preview")
        except email_templates.TemplateError as error:
            out[channel] = {"problem": str(error)}
    return out


# ------------------------------------------------------------- test & launch


def send_test(db: Session, admin: AdminUser, campaign_id: int, *, email: str = "", phone: str = "") -> dict:
    """The current content to the admin's own address or number — never to customers."""
    campaign = _load(db, campaign_id, lock=True)
    clean_content(campaign.content, campaign.channels, strict=True)
    sample = Customer(id=admin.id, first_name=(admin.name or "").split(" ")[0], last_name="", email=email, phone=phone)
    sent = []
    from app.services import email as email_service
    from app.services.email import crypto
    from app.services.email.senders import SendError

    for channel in campaign.channels:
        if channel == "email":
            if "@" not in (email or ""):
                raise ValidationError("Enter your email address for the test.", error_code="INVALID_RECIPIENT")
            account = email_service.active_account(db)
            if account is None:
                raise ValidationError("No email account is connected (Settings → Email).",
                                      error_code="EMAIL_NOT_CONFIGURED")
            message = render(campaign, "email", sample, "test")
            try:
                email_service._send_now(account.provider, crypto.unseal(account.credentials), account, email.strip(),
                                        f"[Test] {message['subject']}", message["html"], message["text"])
            except SendError as error:
                raise ValidationError(f"The test email couldn't be sent: {error}", error_code="TEST_SEND_FAILED") from None
            sent.append({"channel": "email", "to": email.strip()})
        elif channel in ("sms", "whatsapp"):
            number = messaging.normalise_phone(phone)
            if not number:
                raise ValidationError("Enter your phone number (with country code) for the test.",
                                      error_code="INVALID_RECIPIENT")
            message = render(campaign, channel, sample, "test")
            try:
                providers.for_channel(channel).send(providers.Message(
                    to=number, text=f"[Test] {message.get('text', '')}", template=message.get("template", ""),
                    language=message.get("language", "en"), variables=message.get("variables")))
            except providers.ProviderError as error:
                raise ValidationError(f"The test {channel} couldn't be sent: {error}", error_code="TEST_SEND_FAILED") from None
            sent.append({"channel": channel, "to": messaging.mask(number)})
        else:
            sent.append({"channel": "in_app", "to": "preview only"})
    campaign.tested_at = datetime.utcnow()
    audit.record(db, "campaign.test", resource_type="campaigns", resource_id=campaign.id, actor=admin,
                 summary=f"Sent a test of campaign {campaign.name}")
    db.commit()
    return {"sent": sent, "testedAt": campaign.tested_at}


def readiness(db: Session, campaign: MarketingCampaign) -> List[str]:
    """What stands between this draft and a launch."""
    problems = []
    status = messaging.channel_status(db)
    for channel in campaign.channels:
        if not status[channel]["configured"]:
            problems.append(f"{channel}: {status[channel]['reason']}")
    try:
        clean_content(campaign.content, campaign.channels, strict=True)
    except ValidationError as error:
        problems.append(str(error))
    external = [c for c in campaign.channels if c != "in_app"]
    if external and (campaign.tested_at is None or (campaign.content_updated_at and campaign.tested_at < campaign.content_updated_at)):
        problems.append("Send a test of the current content first.")
    return problems


def launch(db: Session, admin: AdminUser, campaign_id: int, *, confirm_messages: int,
           send_at: Optional[str] = None) -> MarketingCampaign:
    campaign = _load(db, campaign_id, lock=True)
    if campaign.status != "draft" or campaign.launch_key:
        raise ConflictError("This campaign has already been launched.", error_code="CAMPAIGN_ALREADY_LAUNCHED")
    problems = readiness(db, campaign)
    if problems:
        raise ValidationError("The campaign isn't ready: " + " ".join(problems), error_code="CAMPAIGN_NOT_READY",
                              details={"problems": problems})
    figures = estimate(db, campaign.audience, campaign.channels)
    if figures["messages"] == 0:
        raise ValidationError("Nobody in this audience has agreed to marketing on these channels.",
                              error_code="CAMPAIGN_NO_AUDIENCE")
    if int(confirm_messages) != figures["messages"]:
        raise ConflictError(f"The audience has changed: it's now {figures['messages']} messages. Review and confirm "
                            "again.", error_code="AUDIENCE_CHANGED", details=figures)
    when = _parse_when(send_at, "The send time")
    now = datetime.utcnow()
    if when is not None and when < now - timedelta(minutes=1):
        raise ValidationError("The send time has passed.", error_code="INVALID_DATE")
    campaign.launch_key = secrets.token_hex(16)
    campaign.status = "scheduled" if when and when > now else "sending"
    campaign.scheduled_at = when or now
    campaign.launched_at, campaign.launched_by, campaign.updated_at = now, admin.id, now
    audit.record(db, "campaign.launch", resource_type="campaigns", resource_id=campaign.id, actor=admin,
                 summary=f"Launched campaign {campaign.name} ({figures['messages']} messages"
                         f"{', scheduled' if campaign.status == 'scheduled' else ''})",
                 details={"messages": figures["messages"], "channels": figures["channels"],
                          "scheduledAt": campaign.scheduled_at})
    db.commit()
    return campaign


def cancel(db: Session, admin: AdminUser, campaign_id: int) -> MarketingCampaign:
    campaign = _load(db, campaign_id, lock=True)
    if campaign.status not in ("scheduled", "sending", "draft"):
        raise ConflictError("This campaign is already finished.", error_code="CAMPAIGN_FINISHED")
    now = datetime.utcnow()
    campaign.status, campaign.updated_at, campaign.completed_at = "cancelled", now, now
    for row in db.execute(select(NotificationDelivery).where(
            NotificationDelivery.campaign_id == campaign.id,
            NotificationDelivery.status.in_(("queued", "failed")))).scalars():
        row.status, row.last_error, row.next_attempt_at, row.updated_at = "skipped", "Campaign cancelled.", None, now
    audit.record(db, "campaign.cancel", resource_type="campaigns", resource_id=campaign.id, actor=admin,
                 summary=f"Cancelled campaign {campaign.name}")
    db.commit()
    return campaign


# -------------------------------------------------------------- sending job


def run_due(db: Session, now: Optional[datetime] = None) -> int:
    """
    Turn due campaigns into recipients and queued deliveries, in batches,
    resuming where a previous run stopped. Returns how many messages it queued.
    """
    now = now or datetime.utcnow()
    queued = 0
    due = db.execute(select(MarketingCampaign.id).where(
        or_(and_(MarketingCampaign.status == "scheduled", MarketingCampaign.scheduled_at <= now),
            MarketingCampaign.status == "sending"))).scalars().all()
    for campaign_id in due:
        campaign = db.execute(select(MarketingCampaign).where(MarketingCampaign.id == campaign_id)
                              .with_for_update(skip_locked=True)).scalar_one_or_none()
        if campaign is None or campaign.status not in ("scheduled", "sending"):
            db.rollback()
            continue
        campaign.status = "sending"
        try:
            queued += _materialise(db, campaign)
        except Exception as error:  # noqa: BLE001
            db.rollback()
            logger.exception("Campaign %s could not be sent", campaign_id)
            row = db.get(MarketingCampaign, campaign_id)
            row.status, row.last_error, row.updated_at = "failed", f"{type(error).__name__}: {error}"[:500], now
            db.commit()
            from app.services import inbox

            inbox.staff(db, "campaign", f"Campaign failed: {row.name}", row.last_error,
                        f"/admin/marketing/campaigns/detail?id={row.id}", permission="campaigns")
            db.commit()
            continue
        _maybe_finish(db, campaign_id)
    return queued


def _materialise(db: Session, campaign: MarketingCampaign) -> int:
    ids = audience_ids(db, campaign.audience)
    per = reachable(db, ids, campaign.channels)
    existing = {(cid, ch) for cid, ch in db.execute(select(CampaignRecipient.customer_id, CampaignRecipient.channel)
                                                    .where(CampaignRecipient.campaign_id == campaign.id)).all()}
    customers = {}
    queued = 0
    now = datetime.utcnow()
    pending = [(cid, ch) for ch in campaign.channels for cid in per[ch] if (cid, ch) not in existing]
    for start in range(0, len(pending), BATCH):
        batch = pending[start:start + BATCH]
        missing = [cid for cid, _ in batch if cid not in customers]
        for c in db.execute(select(Customer).where(Customer.id.in_(missing))).scalars():
            customers[c.id] = c
        for cid, channel in batch:
            customer = customers.get(cid)
            if customer is None:
                continue
            token = secrets.token_hex(16)
            recipient = CampaignRecipient(campaign_id=campaign.id, customer_id=cid, channel=channel, status="queued",
                                          token=token, created_at=now)
            db.add(recipient)
            db.flush()
            message = render(campaign, channel, customer, token)
            address = customer.email if channel == "email" else (messaging.normalise_phone(customer.phone) or "")
            if channel == "in_app":
                from app.services import inbox

                inbox.customer(db, cid, "campaign", message["title"], message["body"], message.get("href", ""))
            delivery = messaging.queue(
                db, key=f"campaign:{campaign.id}:{cid}:{channel}", event="campaign_message", channel=channel,
                category="marketing", customer_id=cid, recipient=address, payload=message,
                provider="bell" if channel == "in_app" else "", campaign_id=campaign.id,
                reference=f"cmp-{campaign.id}", template_key=f"campaign:{campaign.kind}",
                status="delivered" if channel == "in_app" else "queued",
            )
            if delivery is not None:
                recipient.delivery_id = delivery.id
                recipient.status = delivery.status
                queued += 1
        campaign.recipients_total = (campaign.recipients_total or 0) + len(batch)
        campaign.updated_at = datetime.utcnow()
        db.commit()
        # Each batch goes out straight away, rather than waiting for the next pass.
        messaging.process(db, [d for d in db.execute(select(NotificationDelivery.id).where(
            NotificationDelivery.campaign_id == campaign.id, NotificationDelivery.status == "queued")).scalars()],
            limit=BATCH)
    return queued


def _maybe_finish(db: Session, campaign_id: int) -> None:
    campaign = db.get(MarketingCampaign, campaign_id)
    if campaign is None or campaign.status != "sending":
        return
    open_count = db.execute(select(func.count()).select_from(NotificationDelivery).where(
        NotificationDelivery.campaign_id == campaign_id,
        NotificationDelivery.status.in_(("queued", "sending", "failed")))).scalar_one()
    if open_count == 0:
        campaign.status, campaign.completed_at = "sent", datetime.utcnow()
        campaign.updated_at = campaign.completed_at
    db.commit()


def send_now() -> None:
    """A campaign just launched: start sending it now. Anything left is picked up by the job."""
    from app.core.database import SessionLocal

    db = SessionLocal()
    if db.info.get("test_session"):
        return  # the tests run the job themselves
    try:
        run_due(db)
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.exception("Starting a launched campaign failed; the job will retry it.")
    finally:
        db.close()


def _sweep_once() -> None:
    from app.core.database import SessionLocal

    with SessionLocal() as db:
        try:
            run_due(db)
        except Exception:
            db.rollback()
            raise


async def run_forever() -> None:
    import asyncio

    from app.services import jobs

    logger.info("Campaigns checked every %ss.", INTERVAL_SECONDS)
    while True:
        try:
            await asyncio.to_thread(jobs.tracked("campaigns", INTERVAL_SECONDS, _sweep_once))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Campaign sweep failed; retrying next interval.")
        await asyncio.sleep(INTERVAL_SECONDS)


# ------------------------------------------------------------- tracking


def record_open(db: Session, token: str) -> bool:
    row = db.execute(select(CampaignRecipient).where(CampaignRecipient.token == token)).scalar_one_or_none()
    if row is None or row.opened_at is not None:
        return False
    row.opened_at = datetime.utcnow()
    if row.status in ("sent", "delivered"):
        row.status = "opened"
    db.commit()
    return True


def record_click(db: Session, token: str, target: str, signature: str) -> Optional[str]:
    destination = safe_target(token, target, signature)
    if destination is None:
        return None
    row = db.execute(select(CampaignRecipient).where(CampaignRecipient.token == token)).scalar_one_or_none()
    if row is not None:
        now = datetime.utcnow()
        if row.clicked_at is None:
            row.clicked_at = now
        if row.opened_at is None and row.channel == "email":
            row.opened_at = now  # a click means it was opened, even with images off
        row.status = "clicked"
        db.commit()
    return destination


# ------------------------------------------------------------- analytics


NOT_AVAILABLE = None


def analytics(db: Session, campaign: MarketingCampaign) -> dict:
    """What actually happened, per channel. None means the channel can't report it."""
    channels = {}
    pixel = bool(tracking_base())
    for channel in campaign.channels:
        statuses = dict(db.execute(select(NotificationDelivery.status, func.count()).where(
            NotificationDelivery.campaign_id == campaign.id, NotificationDelivery.channel == channel)
            .group_by(NotificationDelivery.status)).all())
        recipients = db.execute(select(
            func.count(CampaignRecipient.id), func.count(CampaignRecipient.opened_at),
            func.count(CampaignRecipient.clicked_at), func.count(CampaignRecipient.unsubscribed_at),
            func.count(CampaignRecipient.replied_at)).where(
            CampaignRecipient.campaign_id == campaign.id, CampaignRecipient.channel == channel)).one()
        targeted = int(recipients[0])
        sent = sum(int(statuses.get(s, 0)) for s in ("sent", "delivered", "read"))
        failed = int(statuses.get("dead", 0)) + int(statuses.get("failed", 0))
        delivered = sum(int(statuses.get(s, 0)) for s in ("delivered", "read")) if channel in ("sms", "whatsapp") else (
            int(statuses.get("delivered", 0)) if channel == "in_app" else NOT_AVAILABLE)
        bounced = NOT_AVAILABLE
        if channel == "email":
            bounced = int(db.execute(select(func.count()).select_from(EmailLog).join(
                NotificationDelivery, NotificationDelivery.id == EmailLog.delivery_id).where(
                NotificationDelivery.campaign_id == campaign.id, EmailLog.bounced_at.is_not(None))).scalar_one())
        opened = int(recipients[1]) if (channel == "email" and pixel) or channel == "whatsapp" else NOT_AVAILABLE
        clicked = int(recipients[2]) if channel in ("email", "sms") else NOT_AVAILABLE
        channels[channel] = {
            "targeted": targeted, "queued": int(statuses.get("queued", 0)) + int(statuses.get("sending", 0)),
            "sent": sent,
            "delivered": delivered, "failed": failed, "skipped": int(statuses.get("skipped", 0)),
            "retrying": int(statuses.get("failed", 0)), "opened": opened, "clicked": clicked,
            "unsubscribed": int(recipients[3]) if channel == "email" else NOT_AVAILABLE,
            "bounced": bounced, "replied": int(recipients[4]) if channel == "whatsapp" else NOT_AVAILABLE,
        }
        base = channels[channel]["sent"] or 0
        channels[channel]["rates"] = {
            "delivery": _rate(delivered, base) if delivered is not None else None,
            "failure": _rate(failed, targeted),
            "open": _rate(opened, base) if opened is not None else None,
            "click": _rate(clicked, base) if clicked is not None else None,
            "unsubscribe": _rate(channels[channel]["unsubscribed"], base) if channel == "email" else None,
        }
    return {"channels": channels, "revenue": attributed_revenue(db, campaign), "openTracking": pixel,
            "notes": [] if pixel else ["Email opens aren't tracked: set PUBLIC_API_URL so the tracking image can "
                                       "reach the API."]}


def _rate(part, whole) -> Optional[float]:
    if part is None or not whole:
        return None
    return round(part / whole * 100, 1)


def attributed_revenue(db: Session, campaign: MarketingCampaign) -> dict:
    """Orders by recipients within 7 days of clicking, or with the campaign's coupon after launch."""
    if not campaign.launched_at:
        return {"orders": 0, "revenue": 0.0}
    clicks = db.execute(select(CampaignRecipient.customer_id, func.min(CampaignRecipient.clicked_at)).where(
        CampaignRecipient.campaign_id == campaign.id, CampaignRecipient.clicked_at.is_not(None))
        .group_by(CampaignRecipient.customer_id)).all()
    order_ids: Set[str] = set()
    for customer_id, clicked in clicks:
        order_ids |= set(db.execute(select(Order.id).where(
            Order.customer_id == customer_id, Order.status != "cancelled", Order.placed_at >= clicked,
            Order.placed_at <= clicked + timedelta(days=ATTRIBUTION_DAYS))).scalars())
    if campaign.coupon_code:
        recipients = select(CampaignRecipient.customer_id).where(CampaignRecipient.campaign_id == campaign.id)
        order_ids |= set(db.execute(select(Order.id).where(
            Order.coupon_code == campaign.coupon_code, Order.status != "cancelled",
            Order.placed_at >= campaign.launched_at, Order.customer_id.in_(recipients))).scalars())
    if not order_ids:
        return {"orders": 0, "revenue": 0.0}
    total = db.execute(select(func.coalesce(func.sum(Order.total), 0)).where(Order.id.in_(order_ids))).scalar_one()
    return {"orders": len(order_ids), "revenue": round(float(total), 2)}


def view(db: Session, campaign: MarketingCampaign, *, full: bool = False) -> dict:
    out = {
        "id": campaign.id, "name": campaign.name, "description": campaign.description, "kind": campaign.kind,
        "kindLabel": KINDS.get(campaign.kind, campaign.kind), "status": campaign.status, "channels": campaign.channels,
        "couponCode": campaign.coupon_code, "startsAt": campaign.starts_at, "endsAt": campaign.ends_at,
        "scheduledAt": campaign.scheduled_at, "launchedAt": campaign.launched_at,
        "completedAt": campaign.completed_at, "recipientsTotal": campaign.recipients_total,
        "testedAt": campaign.tested_at, "contentUpdatedAt": campaign.content_updated_at,
        "lastError": campaign.last_error, "createdAt": campaign.created_at, "updatedAt": campaign.updated_at,
    }
    if full:
        out.update({"audience": campaign.audience, "content": campaign.content,
                    "readiness": readiness(db, campaign) if campaign.status == "draft" else [],
                    "analytics": analytics(db, campaign) if campaign.launched_at else None})
    return out


def admin_list(db: Session, *, status: str = "", q: str = "", page: int = 1, page_size: int = 25) -> tuple:
    conditions = []
    if status:
        conditions.append(MarketingCampaign.status == status)
    if q:
        conditions.append(MarketingCampaign.name.ilike(f"%{q.strip()}%"))
    counts = dict(db.execute(select(MarketingCampaign.status, func.count()).group_by(MarketingCampaign.status)).all())
    total = db.execute(select(func.count()).select_from(MarketingCampaign).where(*conditions)).scalar_one()
    rows = db.execute(select(MarketingCampaign).where(*conditions).order_by(MarketingCampaign.updated_at.desc(),
                      MarketingCampaign.id.desc()).offset((page - 1) * page_size).limit(page_size)).scalars().all()
    items = []
    for row in rows:
        data = view(db, row)
        if row.launched_at:
            sent = db.execute(select(func.count()).select_from(NotificationDelivery).where(
                NotificationDelivery.campaign_id == row.id,
                NotificationDelivery.status.in_(("sent", "delivered", "read")))).scalar_one()
            data["sent"] = int(sent)
        items.append(data)
    return items, int(total), {k: int(v) for k, v in counts.items()}
