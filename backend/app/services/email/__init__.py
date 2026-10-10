"""
Outgoing email.

## Who decides what is sent

1. **The store** switches each kind of email on or off (`types`), and decides
   for each whether customers may turn it off themselves.
2. **The customer** turns off, from their account, any kind the store allows
   them to. A kind the store has switched off is not offered to them at all;
   one they may not turn off is shown, switched on and locked.

## When mail is sent

`notify(db, ...)` renders the message and queues it on the database session.
It leaves only after that session **commits** — an order that rolls back sends
nothing — and on a background thread, so a slow mail server never slows down
or breaks the request that caused it. Every attempt is written to `email_log`.

## Credentials

Stored encrypted (`crypto.py`) and never returned. A new set is saved only
after a test message sends with it — a mistyped secret never replaces a
working one.
"""

from __future__ import annotations

import html as html_lib
import logging
import re
import secrets
import threading
from datetime import datetime
from typing import Dict, List, Optional

from sqlalchemy import event, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import ValidationError
from app.models import Customer, CustomerEmailPreference, EmailAccount, EmailLog, SettingDocument
from app.services.email import crypto
from app.services.email.senders import SendError, build_message, deliver

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------- catalogue

# key → label, description, defaults (on, customers may turn off)
TYPES: Dict[str, dict] = {
    "order_confirmation": {
        "label": "Order confirmation",
        "description": "When an order is placed and confirmed, with its items and total.",
        "enabled": True, "optOut": False,
    },
    "payment_received": {
        "label": "Payment received",
        "description": "When an online payment for an order succeeds.",
        "enabled": True, "optOut": False,
    },
    "payment_failed": {
        "label": "Payment didn't go through",
        "description": "When an online payment fails, with a link to try again before the order is released.",
        "enabled": True, "optOut": False,
    },
    "order_updates": {
        "label": "Shipping updates",
        "description": "Each step after confirmation: processing, packed, shipped, in transit, out for delivery, delivered and returned.",
        "enabled": True, "optOut": True,
    },
    "order_cancelled": {
        "label": "Order cancelled",
        "description": "When an order is cancelled.",
        "enabled": True, "optOut": False,
    },
    "refund_updates": {
        "label": "Refunds",
        "description": "When a refund is issued.",
        "enabled": True, "optOut": False,
    },
    "return_updates": {
        "label": "Returns & replacements",
        "description": "Each step of a return or replacement request.",
        "enabled": True, "optOut": True,
    },
    "membership": {
        "label": "Membership",
        "description": "When your membership starts, with its benefits and end date.",
        "enabled": True, "optOut": True,
    },
    "invoice": {
        "label": "Invoices",
        "description": "Invoices sent to you by our team.",
        "enabled": True, "optOut": True,
    },
    "support_updates": {
        "label": "Support requests",
        "description": "Replies and updates on requests you've raised with our support team.",
        "enabled": True, "optOut": False,
    },
    "support_team": {
        "label": "Support team alerts",
        "description": "New, assigned, escalated and overdue requests — sent to your support staff, not to customers.",
        "enabled": True, "optOut": False, "internal": True,
    },
    "store_team": {
        "label": "Store team alerts",
        "description": "New product questions, return requests, gift cards bought, failed payment webhooks, referrals held for review, flash sales selling out and system health problems — sent to your administrators, not to customers.",
        "enabled": True, "optOut": False, "internal": True,
    },
    "account_security": {
        "label": "Account security",
        "description": "Confirming your email address, resetting your password and password-change alerts.",
        "enabled": True, "optOut": False,
    },
    "cart_reminders": {
        "label": "Bag reminders",
        "description": "A reminder when you leave items in your bag.",
        "enabled": True, "optOut": True,
    },
    "product_alerts": {
        "label": "Stock & price alerts",
        "description": "When something you asked about is back in stock or cheaper. You choose these alerts product by product.",
        "enabled": True, "optOut": True,
    },
    "product_questions": {
        "label": "Product questions",
        "description": "When a question you asked about a product is published, declined or answered.",
        "enabled": True, "optOut": True,
    },
    "gift_cards": {
        "label": "Gift cards",
        "description": "Gift cards you buy or receive, with the card itself.",
        "enabled": True, "optOut": False,
    },
    "store_credit": {
        "label": "Store credit",
        "description": "When store credit is added to or taken from your account.",
        "enabled": True, "optOut": False,
    },
    "loyalty": {
        "label": "Reward points",
        "description": "Points earned, points ready to spend, and points about to expire.",
        "enabled": True, "optOut": True,
    },
    "referrals": {
        "label": "Referrals",
        "description": "A friend joining with your referral code, and referral rewards earned or taken back.",
        "enabled": True, "optOut": True,
    },
    "flash_sales": {
        "label": "Flash sales",
        "description": "When a flash sale starts on something in your wishlist.",
        "enabled": True, "optOut": True,
    },
    "offers": {
        "label": "Offers & new arrivals",
        "description": "Sales, new collections and member-only offers.",
        "enabled": False, "optOut": True,
    },
}


def types(db: Session) -> List[dict]:
    """Every kind of email with the store's current choices."""
    saved = (db.get(SettingDocument, "email_types") or SettingDocument(value={})).value or {}
    rows = []
    for key, meta in TYPES.items():
        own = saved.get(key) if isinstance(saved.get(key), dict) else {}
        rows.append(
            {
                "key": key,
                "label": meta["label"],
                "description": meta["description"],
                "enabled": bool(own.get("enabled", meta["enabled"])),
                "customerCanOptOut": bool(own.get("customerCanOptOut", meta["optOut"])),
                "internal": bool(meta.get("internal")),
            }
        )
    return rows


def save_types(db: Session, payload: List[dict]) -> List[dict]:
    value = {}
    for row in payload:
        key = row.get("key")
        if key in TYPES:
            value[key] = {
                "enabled": bool(row.get("enabled")),
                "customerCanOptOut": bool(row.get("customerCanOptOut")),
            }
    document = db.get(SettingDocument, "email_types")
    if document is None:
        db.add(SettingDocument(key="email_types", value=value))
    else:
        document.value = value
    db.commit()
    return types(db)


# ---------------------------------------------------------- customer choices


def preferences(db: Session, customer_id: str) -> List[dict]:
    """What a customer sees in their settings: only the kinds the store sends."""
    own = {
        row.email_type: row.enabled
        for row in db.execute(
            select(CustomerEmailPreference).where(CustomerEmailPreference.customer_id == customer_id)
        ).scalars()
    }
    rows = []
    for row in types(db):
        # Staff alerts are not the customer's to see or choose.
        if not row["enabled"] or TYPES.get(row["key"], {}).get("internal"):
            continue
        locked = not row["customerCanOptOut"]
        rows.append(
            {
                "key": row["key"],
                "label": row["label"],
                "description": row["description"],
                "enabled": True if locked else own.get(row["key"], True),
                "locked": locked,
            }
        )
    return rows


def save_preferences(db: Session, customer_id: str, choices: Dict[str, bool]) -> List[dict]:
    allowed = {row["key"] for row in types(db) if row["enabled"] and row["customerCanOptOut"]}
    now = datetime.utcnow()
    for key, enabled in choices.items():
        if key not in allowed:
            continue
        row = db.get(CustomerEmailPreference, (customer_id, key))
        if row is None:
            db.add(CustomerEmailPreference(customer_id=customer_id, email_type=key, enabled=bool(enabled), updated_at=now))
        else:
            row.enabled = bool(enabled)
            row.updated_at = now
    db.commit()
    return preferences(db, customer_id)


def wants(db: Session, key: str, customer_id: Optional[str]) -> bool:
    row = next((r for r in types(db) if r["key"] == key), None)
    if row is None or not row["enabled"]:
        return False
    if not row["customerCanOptOut"] or not customer_id:
        return True
    own = db.get(CustomerEmailPreference, (customer_id, key))
    return True if own is None else bool(own.enabled)


# ------------------------------------------------------------------ account


PROVIDERS = ("gmail-oauth", "smtp")
SECRET_FIELDS = {
    "gmail-oauth": ("clientId", "clientSecret", "refreshToken", "accessToken"),
    "smtp": ("host", "port", "security", "username", "password"),
}
SHOWN_FIELDS = {"clientId", "host", "port", "security", "username"}


def active_account(db: Session) -> Optional[EmailAccount]:
    return db.execute(
        select(EmailAccount).where(EmailAccount.active.is_(True)).order_by(EmailAccount.id.desc())
    ).scalars().first()


def _bounce_status(db: Session) -> dict:
    from app.services.email import bounces

    return bounces.status(db)


def account_view(db: Session, redirect_uri: str) -> dict:
    account = active_account(db)
    base = {
        "configured": account is not None,
        "redirectUri": redirect_uri,
        "providers": [
            {"key": "gmail-oauth", "label": "Gmail (Google Workspace or Gmail)"},
            {"key": "smtp", "label": "SMTP server (Outlook, Zoho, Amazon SES…)"},
        ],
    }
    if account is None:
        return base
    values = crypto.unseal(account.credentials)
    return {
        **base,
        "provider": account.provider,
        "senderEmail": account.sender_email,
        "senderName": account.sender_name,
        "replyTo": account.reply_to,
        "verifiedAt": account.verified_at,
        "updatedAt": account.updated_at,
        "readable": bool(values),
        "bounceTracking": _bounce_status(db),
        # Hints only: enough to recognise what is saved, never to use it.
        "fields": {
            key: (str(values.get(key, "")) if key in SHOWN_FIELDS else crypto.mask(str(values.get(key, ""))))
            for key in SECRET_FIELDS.get(account.provider, ())
            if values.get(key) not in (None, "")
        },
    }


def _merged(db: Session, payload: dict) -> tuple[str, dict, dict]:
    provider = payload.get("provider") or ""
    if provider not in PROVIDERS:
        raise ValidationError("Choose how emails are sent.", error_code="EMAIL_PROVIDER")
    sender = (payload.get("senderEmail") or "").strip()
    if "@" not in sender:
        raise ValidationError("Enter the address emails are sent from.", error_code="EMAIL_SENDER")

    current = active_account(db)
    kept = crypto.unseal(current.credentials) if current and current.provider == provider else {}
    credentials = {}
    for key in SECRET_FIELDS[provider]:
        value = payload.get(key)
        # Left blank means "keep what is saved" — secrets are never sent back
        # to the form, so re-typing them for every change would be required.
        credentials[key] = kept.get(key, "") if value in (None, "") else str(value).strip()
    meta = {
        "senderEmail": sender,
        "senderName": (payload.get("senderName") or "").strip()[:120],
        "replyTo": (payload.get("replyTo") or "").strip()[:255],
    }
    return provider, credentials, meta


def test_and_save(db: Session, payload: dict, *, actor: str, test_recipient: str) -> dict:
    """Send a test message with these credentials; save them only if it arrives."""
    provider, credentials, meta = _merged(db, payload)
    recipient = (test_recipient or meta["senderEmail"]).strip()
    if "@" not in recipient:
        raise ValidationError("Enter an address for the test email.", error_code="EMAIL_TEST_RECIPIENT")

    subject, html, text = render_test(meta["senderName"] or "Daily Choice Zone")
    message = build_message(to=recipient, subject=subject, html=html, text=text, **{
        "sender_email": meta["senderEmail"], "sender_name": meta["senderName"], "reply_to": meta["replyTo"],
    })
    try:
        deliver(provider, credentials, message)
    except SendError as error:
        raise ValidationError(
            f"The test email couldn't be sent, so nothing was saved. {error}", error_code="EMAIL_TEST_FAILED"
        ) from None

    now = datetime.utcnow()
    for row in db.execute(select(EmailAccount).where(EmailAccount.active.is_(True))).scalars():
        row.active = False
    db.add(
        EmailAccount(
            provider=provider,
            sender_email=meta["senderEmail"],
            sender_name=meta["senderName"],
            reply_to=meta["replyTo"],
            credentials=crypto.seal(credentials),
            active=True,
            verified_at=now,
            updated_by=actor,
            created_at=now,
            updated_at=now,
        )
    )
    db.add(EmailLog(email_type="test", recipient=recipient, subject=subject, status="sent", created_at=now))
    db.commit()
    return {"sentTo": recipient}


def send_test(db: Session, recipient: str) -> None:
    """A test with the saved account, e.g. to check it still works."""
    account = active_account(db)
    if account is None:
        raise ValidationError("No email account is set up yet.", error_code="EMAIL_NOT_CONFIGURED")
    subject, html, text = render_test(account.sender_name or "Daily Choice Zone")
    try:
        _send_now(account.provider, crypto.unseal(account.credentials), account, recipient, subject, html, text)
    except SendError as error:
        raise ValidationError(f"The test email couldn't be sent. {error}", error_code="EMAIL_TEST_FAILED") from None


def disconnect(db: Session) -> None:
    for row in db.execute(select(EmailAccount).where(EmailAccount.active.is_(True))).scalars():
        row.active = False
    db.commit()


def recent_log(db: Session, limit: int = 100) -> List[EmailLog]:
    return list(db.execute(select(EmailLog).order_by(EmailLog.id.desc()).limit(limit)).scalars())


def search_log(
    db: Session,
    *,
    status: str = "",
    email_type: str = "",
    query: str = "",
    subject: str = "",
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    page: int = 1,
    page_size: int = 25,
) -> tuple:
    """
    The whole email log, filtered and paged in the database. Returns (rows, total, counts).

    `query` is the record the email was about — its reference, an order number or
    a ticket number — matched exactly (docs/id-lookup.md); never the recipient's
    address, which would identify a customer by email. `subject` is content:
    words in the subject line.
    """
    from sqlalchemy import false, func

    from app.services.lookup.filters import normalised_id
    from app.services.search.base import LIKE_ESCAPE, escape_like

    conditions = []
    if email_type:
        conditions.append(EmailLog.email_type == email_type)
    raw = (query or "").strip()
    if raw:
        reference = normalised_id(raw)
        # References are stored as written (DCZ10241, DCZ-2026-000123): the ID as typed or normalised.
        conditions.append(EmailLog.reference.in_(sorted({raw, reference})) if reference else false())
    words = (subject or "").strip()
    if words:
        conditions.append(EmailLog.subject.ilike(f"%{escape_like(words)}%", escape=LIKE_ESCAPE))
    if date_from is not None:
        conditions.append(EmailLog.created_at >= date_from)
    if date_to is not None:
        conditions.append(EmailLog.created_at <= date_to)

    # Counts per status for the filter tabs, under every other filter.
    counts = dict(db.execute(
        select(EmailLog.status, func.count()).where(*conditions).group_by(EmailLog.status)
    ).all())
    if status:
        conditions.append(EmailLog.status == status)
    total = db.execute(select(func.count()).select_from(EmailLog).where(*conditions)).scalar_one()
    rows = db.execute(
        select(EmailLog).where(*conditions).order_by(EmailLog.id.desc())
        .offset((max(1, page) - 1) * page_size).limit(page_size)
    ).scalars().all()
    return list(rows), total, counts


# --------------------------------------------------------------- templates


def _brand() -> dict:
    return {"name": "Daily Choice Zone", "url": settings.STOREFRONT_URL.rstrip("/")}


def layout(title: str, intro: str, rows="", cta: Optional[tuple] = None, footnote: str = "", *,
           preheader: str = "", marketing: bool = False, unsubscribe_url: str = "", preferences_url: str = "",
           tracking_pixel: str = "", tone: str = "brand", icon: str = "", eyebrow: str = "", banner: str = "",
           secondary=()) -> str:
    """
    Every email's frame — the branded master layout in `templates.master`.

    `intro`, `rows` and `banner` are HTML the caller built (with customer
    values escaped); `title`, `cta`, `eyebrow` and `footnote` are plain text.
    `tone` colours the banner (brand, success, warning, danger, info,
    celebrate) and `icon` names its picture (`templates.ICONS`). `secondary`
    is a row of (label, url) links under the button. The unsubscribe link is
    shown only when `marketing` is set.
    """
    from app.services.email import templates

    return templates.master(
        title=title, intro_html=intro, body_html=rows or "", cta=cta, footnote=footnote,
        preheader=preheader or html_lib.unescape(re.sub(r"<[^>]+>", "", intro or ""))[:140],
        marketing=marketing, unsubscribe_url=unsubscribe_url, preferences_url=preferences_url,
        tracking_pixel=tracking_pixel, tone=tone, icon=icon, eyebrow=eyebrow, banner_html=banner,
        secondary=secondary,
    )


def _money(value) -> str:
    return f"₹{float(value or 0):,.2f}"


def link(path: str) -> str:
    """An absolute storefront link for a path such as `/account/orders`."""
    return f"{_brand()['url']}{path}"


def render_test(sender_name: str) -> tuple:
    subject = f"Test email from {sender_name}"
    html = layout(
        "Your email is set up",
        "This is a test message from your store. If you can read it, emails to customers will be delivered from this account.",
        footnote="Sent from your store's admin portal while setting up email.",
        tone="success", icon="mail", eyebrow="Email settings",
    )
    return subject, html, "Your email is set up. This is a test message from your store."


def security_body(email: str, *, link_url: str = "", detail: str = "", warn: bool = False) -> str:
    """
    What every account-security email carries: which account and when, the
    link written out (for when a button won't click) and what to do if it
    wasn't you.
    """
    from datetime import timedelta

    from app.services.email import templates

    now = datetime.utcnow() + timedelta(hours=5, minutes=30)
    body = templates.details([("Account", email), ("When", f"{now.day} {now:%b %Y, %I:%M %p} IST"),
                              ("How", detail)], title="Details")
    if link_url:
        esc = html_lib.escape
        body += templates.note(
            f'Button not working? Copy this link into your browser:<br>'
            f'<a href="{esc(link_url, quote=True)}" style="color:#9c5d3d;word-break:break-all">{esc(link_url)}</a>',
            raw=True, tone="info")
    body += templates.note(
        "Wasn't you? Reset your password straight away and contact us — we'll help secure your account. "
        "We'll never ask for your password or a one-time code." if warn else
        "We'll never ask for your password or a one-time code by email, phone or chat.",
        tone="danger" if warn else "info", title="Keep your account safe")
    return body


# ------------------------------------------------------------ order pieces


def _order_link(order) -> str:
    return f"{_brand()['url']}/account/order?number={order.order_number}"


def product_link(product_id) -> str:
    return f"{_brand()['url']}/product/{product_id}" if product_id else ""


def product_image(product, color: str = "") -> str:
    """A product's first photo (for a colour, when one is given), for an email."""
    images = sorted(getattr(product, "images", None) or [], key=lambda i: getattr(i, "position", 0) or 0)
    if color:
        for image in images:
            if (getattr(image, "color", "") or "").lower() == color.lower():
                return image.url
    return images[0].url if images else ""


def order_lines(order) -> List[dict]:
    """An order's items as `templates.items` lines: photo, link, size and colour, price."""
    lines = []
    for item in order.items:
        quantity = int(item.quantity or 1)
        regular = float(item.regular_unit_price or 0)
        unit = float(item.unit_price or 0)
        lines.append({
            "name": item.name,
            "detail": " · ".join(p for p in (
                f"Size {item.size}" if item.size else "", item.color or "",
                f"Part of {item.bundle_name}" if getattr(item, "bundle_name", "") else "") if p),
            "quantity": quantity,
            "unit": _money(unit) if quantity > 1 else "",
            "amount": _money(item.line_total),
            "was": _money(regular * quantity) if regular > unit else "",
            "image": item.image,
            "url": product_link(item.product_id),
        })
    return lines


def _order_summary(order) -> List[tuple]:
    """Subtotal, discounts, delivery and tax — the lines between the items and the total."""
    rows: List[tuple] = [("Subtotal", _money(order.subtotal))]
    if float(order.coupon_discount or 0):
        rows.append((f"Coupon{f' ({order.coupon_code})' if order.coupon_code else ''}",
                     f"−{_money(order.coupon_discount)}", "saving"))
    if float(order.member_discount or 0):
        rows.append(("Member discount", f"−{_money(order.member_discount)}", "saving"))
    fee = float(order.delivery_fee or 0)
    rows.append(("Delivery", _money(fee) if fee else "Free", "" if fee else "saving"))
    tax = float(order.tax_amount or 0)
    if tax:
        goods = float(order.subtotal or 0) - float(order.coupon_discount or 0) - float(order.member_discount or 0)
        included = abs(goods + fee - float(order.total or 0)) < 0.02
        rows.append(("GST (included)" if included else "GST", _money(tax)))
    return rows


def _order_rows(order, *, title: str = "Order summary") -> str:
    """The items, the money and what was saved — every email about an order carries this."""
    from app.services.email import templates

    saved = sum(float(getattr(order, f, 0) or 0) for f in ("catalogue_savings", "coupon_discount", "member_discount"))
    html = templates.items(order_lines(order), total=_money(order.total), summary=_order_summary(order),
                           title=title)
    if saved >= 1:
        html += (f'<p style="margin:12px 0 0;text-align:right">'
                 f'{templates.badge(f"You saved {_money(saved)}", tone="success")}</p>')
    return html


PAYMENT_LABELS = {"cod": "Cash on delivery", "card": "Card", "upi": "UPI", "wallet": "Wallet",
                  "netbanking": "Net banking", "tender": "Gift card / store credit"}


def payment_label(order) -> str:
    method = (order.payment_method or "").strip()
    return PAYMENT_LABELS.get(method.lower(), method) or "Online payment"


def _payment_card(order) -> str:
    from app.services.email import templates

    esc = html_lib.escape
    status = (order.payment_status or "").replace("-", " ").strip()
    tone = {"paid": "success", "failed": "danger", "refunded": "info", "partially refunded": "info"}.get(status.lower(), "warning")
    parts = [f'<strong style="color:#1e1b18">{esc(payment_label(order))}</strong>']
    if status:
        parts.append(templates.badge(status.title(), tone=tone))
    paid_with = [(label, getattr(order, field, 0)) for label, field in (
        ("Gift card", "gift_card_amount"), ("Store credit", "store_credit_amount"), ("Reward points", "points_amount"))]
    for label, amount in paid_with:
        if float(amount or 0):
            parts.append(f"{label}: {_money(amount)}")
    return "<br>".join(parts)


def _delivery_card(order, *, tracking: str = "", courier: str = "") -> str:
    esc = html_lib.escape
    parts = [f'<strong style="color:#1e1b18">{esc((order.delivery_method or "standard").replace("-", " ").title())} delivery</strong>']
    if order.expected_delivery and order.status not in ("delivered", "cancelled", "returned"):
        parts.append(f"Expected by <strong style=\"color:#4a7a52\">{esc(order.expected_delivery)}</strong>")
    if courier:
        parts.append(f"Courier: {esc(courier)}")
    number = tracking or getattr(order, "tracking_number", "") or ""
    if number:
        parts.append(f"Tracking no: <strong style=\"color:#1e1b18\">{esc(number)}</strong>")
    return "<br>".join(parts)


def order_cards(order, *, payment: bool = True, delivery: bool = True, tracking: str = "", courier: str = "") -> str:
    """Delivering to, delivery and payment — side by side, stacked on a phone."""
    from app.services.email import templates

    address = templates.address(
        order.shipping_name or order.customer_name,
        [order.shipping_line1, order.shipping_line2,
         ", ".join(p for p in (order.shipping_city, order.shipping_state) if p)
         + (f" {order.shipping_pincode}" if order.shipping_pincode else "")],
        order.shipping_phone,
    )
    entries = [("Delivering to", address)]
    if delivery:
        entries.append(("Delivery", _delivery_card(order, tracking=tracking, courier=courier)))
    if payment:
        entries.append(("Payment", _payment_card(order)))
    return templates.cards(entries)


_SENTENCE_STARTS = ("Your ", "The ", "We", "Thank ", "Thanks ", "There", "It ", "Our ", "Each ", "Any ")


def after_greeting(sentence: str) -> str:
    """A sentence carried on after "Hello Asha, " — lower-cased only where its first word is an ordinary one."""
    if sentence.startswith(_SENTENCE_STARTS):
        return sentence[0].lower() + sentence[1:]
    return sentence


def order_banner(order) -> str:
    """The line under an order email's title: the order number and when it was placed."""
    esc = html_lib.escape
    placed = f"{order.placed_at.day} {order.placed_at:%b %Y}" if getattr(order, "placed_at", None) else ""
    return (f'<p style="margin:16px 0 0;font-family:Helvetica, Arial, sans-serif;font-size:13px;color:#524b45">'
            f'<span style="display:inline-block;padding:6px 14px;border-radius:999px;background:#ffffff;'
            f'border:1px solid #ede7df;white-space:nowrap">Order <strong style="color:#1e1b18">{esc(order.order_number)}</strong>'
            + (f' &nbsp;&middot;&nbsp; {esc(placed)}' if placed else "") + "</span></p>")


ORDER_STEPS = ["Confirmed", "Packed", "Shipped", "Out for delivery", "Delivered"]
STAGE_STEP = {"confirmed": 0, "processing": 0, "packed": 1, "shipped": 2, "in-transit": 2,
              "out-for-delivery": 3, "delivered": 4}


def order_progress(stage: str) -> str:
    from app.services.email import templates

    if stage not in STAGE_STEP:
        return ""
    return templates.progress(ORDER_STEPS, STAGE_STEP[stage], tone="success" if stage == "delivered" else "brand")


def order_secondary(order) -> list:
    return [("All orders", link("/account/orders")), ("Invoices", link("/account/invoices")),
            ("Returns policy", link("/returns")), ("Help", link("/faq"))]


def order_text(order, title: str, intro: str) -> str:
    """The plain-text part: what happened, the items and the total, and the link."""
    lines = [title, "", intro, "", f"Order {order.order_number}"]
    for item in order.items:
        extra = ", ".join(p for p in (f"size {item.size}" if item.size else "", item.color or "") if p)
        lines.append(f"- {item.name}{f' ({extra})' if extra else ''} × {item.quantity}: {_money(item.line_total)}")
    lines += [f"Total: {_money(order.total)}", "", f"View your order: {_order_link(order)}"]
    return "\n".join(lines)


STAGE_COPY = {
    "confirmed": ("Your order is confirmed", "Thank you for shopping with us. We're getting your order ready."),
    "processing": ("We're preparing your order", "We've started getting your order ready."),
    "packed": ("Your order is packed", "Your order is packed and will be handed to the courier soon."),
    "shipped": ("Your order is on its way", "Your order has left our warehouse and is with the courier."),
    "in-transit": ("Your order is in transit", "Your order is moving through the courier's network towards you."),
    "out-for-delivery": ("Arriving today", "Your order is out for delivery and will reach you today."),
    "delivered": ("Your order has been delivered", "We hope you love it. If anything isn't right, you can request a return or replacement from your account."),
    "cancelled": ("Your order has been cancelled", "Your order has been cancelled. If you had paid online, your refund is on its way."),
    "returned": ("Your order has been returned", "Your order has been returned to us. Any refund due will follow shortly."),
}

# Each stage's look — (tone, icon, eyebrow, button, what happens next).
STAGE_STYLE = {
    "confirmed": ("success", "check", "Order confirmed", "View your order", [
        ("We pack your items", "Each piece is checked before it is packed."),
        ("We ship it", "You'll get the courier and tracking number by email."),
        ("It reaches you", "Pay on delivery if you chose cash on delivery.")]),
    "processing": ("brand", "bag", "Order update", "View your order", [
        "We'll email you as soon as your order is packed and handed to the courier."]),
    "packed": ("brand", "box", "Order update", "Track your order", [
        "The courier picks it up shortly — we'll email you the tracking number."]),
    "shipped": ("brand", "truck", "On its way", "Track your order", [
        "Keep your phone handy — the courier may call before delivering.",
        "For cash on delivery, please keep the exact amount ready."]),
    "in-transit": ("brand", "truck", "On its way", "Track your order", []),
    "out-for-delivery": ("success", "pin", "Arriving today", "Track your order", [
        "Keep your phone handy — the courier may call before delivering.",
        "For cash on delivery, please keep the exact amount ready."]),
    "delivered": ("success", "home", "Delivered", "View your order", [
        ("Love it?", "Leave a review on the product page — it helps other shoppers."),
        ("Not quite right?", "Request a return or replacement from your order page.")]),
    "cancelled": ("danger", "cross", "Order cancelled", "View your order", [
        "If you paid online, the refund goes back to your original payment method in 5–7 working days."]),
    "returned": ("info", "return", "Order returned", "View your order", [
        "Any refund due will be issued to you shortly — we'll email you when it is."]),
}

# An unpaid online order that ran out of time: nothing was charged, so the
# usual "your refund is on its way" would be wrong and worrying.
PAYMENT_EXPIRED_COPY = (
    "Your order has been cancelled",
    "We didn't receive the payment in time, so your order has been cancelled and "
    "the items released. You haven't been charged. You're welcome to order again.",
)


def render_order(order, stage: str, copy: Optional[tuple] = None) -> tuple:
    from app.services.email import templates

    title, intro = copy or STAGE_COPY.get(stage, ("Update on your order", "There's an update on your order."))
    tone, icon, eyebrow, button, upcoming = STAGE_STYLE.get(stage, ("brand", "bell", "Order update", "View your order", []))
    if copy is PAYMENT_EXPIRED_COPY:
        upcoming = []
    esc = html_lib.escape
    first = (order.customer_name or "").split(" ")[0]
    greeting = f"Hello {esc(first)}, " if first else ""
    intro_html = greeting + esc(after_greeting(intro) if greeting else intro)
    body = (order_progress(stage)
            + _order_rows(order)
            + order_cards(order, delivery=stage not in ("cancelled", "returned"))
            + templates.steps(upcoming))
    html = layout(title, intro_html, body, (button, _order_link(order)), tone=tone, icon=icon, eyebrow=eyebrow,
                  banner=order_banner(order), secondary=order_secondary(order),
                  preheader=f"{intro} Order {order.order_number} · {_money(order.total)}")
    return f"{title} — {order.order_number}", html, order_text(order, title, intro)


# ------------------------------------------------------------------ sending


def notify(
    db: Session,
    key: str,
    *,
    to: str,
    customer_id: Optional[str],
    subject: str,
    html: str,
    text: str,
    reference: str = "",
    inbox=None,
    event: Optional[str] = None,
    variables: Optional[dict] = None,
    extra_html: str = "",
    idempotency_key: Optional[str] = None,
) -> bool:
    """
    Queue an email to go out when this session commits. Returns whether it was
    queued — False when no account is set up, the store has this kind switched
    off, or the customer has turned it off.

    A customer's email also appears in the bell on the storefront (see
    `services.inbox`) — whether or not an email account is connected, but not
    if they've turned this kind of message off. `inbox` overrides its wording
    (`{"title", "body", "href"}`), or `False` keeps it out of the bell.

    `event` names the notification (`services.messaging.catalogue`): the store
    can switch it off or rewrite it in the portal, and it is sent by SMS and
    WhatsApp too where those are switched on. `variables` fill the store's own
    wording; `extra_html` (the order lines, say) is kept under it.
    `idempotency_key` makes the same message go once, however often this is
    called for it.
    """
    from app.services.messaging import catalogue as message_catalogue
    from app.services.messaging import service as messaging

    template = None
    values = dict(variables or {})
    if event in message_catalogue.EVENTS:
        try:
            template = messaging.effective(db, event)
        except Exception:  # noqa: BLE001 — a template problem must not stop the email
            logger.exception("Could not read the template for %s", event)
        if template is not None and not template["enabled"]:
            return False
        if template is not None and template["customised"]:
            customer = db.get(Customer, customer_id) if customer_id else None
            values = {**messaging.base_variables(customer), **values}
            try:
                subject, html, text = messaging.render_email(db, event, values, extra_html=extra_html,
                                                             template=template)
            except Exception:  # noqa: BLE001 — fall back to the built-in email, never to nothing
                logger.warning("Template for %s couldn't be rendered; sending the built-in email", event,
                               exc_info=True)
    base_key = (idempotency_key or f"{event or key}:{reference or secrets.token_hex(6)}:{customer_id or to}")[:140]
    if event in message_catalogue.EVENTS and customer_id:
        try:
            customer = db.get(Customer, customer_id)
            messaging.fan_out(db, event, customer_id=customer_id,
                              values={**messaging.base_variables(customer), **values}, reference=str(reference),
                              key_base=base_key)
        except Exception:  # other channels must never stop the email
            logger.exception("Could not queue other channels for %s", event)
    try:
        if customer_id and wants(db, key, customer_id):
            from app.services import inbox as inbox_service

            inbox_service.from_email(db, key, customer_id, subject, text, inbox)
    except Exception:  # the bell must never break the work that triggered it
        logger.exception("Could not add an in-app notification for %s", key)
    try:
        if not to or "@" not in to or not wants(db, key, customer_id):
            return False
        account = active_account(db)
        if account is None:
            return False
        delivery = messaging.queue(
            db, key=f"{base_key}:email", event=event or key, channel="email",
            category="marketing" if key == "offers" else "transactional", customer_id=customer_id, recipient=to,
            payload=None, provider=account.provider, reference=str(reference), status="sending",
            template_key=event or key,
        )
        if delivery is None and idempotency_key:
            return False  # this exact message has been queued before
        job = {
            "provider": account.provider,
            "credentials": crypto.unseal(account.credentials),
            "sender_email": account.sender_email,
            "sender_name": account.sender_name,
            "reply_to": account.reply_to,
            "to": to,
            "subject": subject,
            "html": html,
            "text": text,
            "key": key,
            "reference": str(reference),
            "template": event or key,
            "delivery_id": delivery.id if delivery is not None else None,
        }
    except Exception:  # email must never break the work that triggered it
        logger.exception("Could not prepare %s email", key)
        return False
    db.info.setdefault("outgoing_email", []).append(job)
    return True


def notify_order(db: Session, order, stage: str, *, copy: Optional[tuple] = None) -> None:
    key = {
        "confirmed": "order_confirmation",
        "cancelled": "order_cancelled",
        "processing": "order_updates",
        "packed": "order_updates",
        "shipped": "order_updates",
        "in-transit": "order_updates",
        "out-for-delivery": "order_updates",
        "delivered": "order_updates",
        "returned": "order_updates",
    }.get(stage)
    if not key:
        return
    _tell_staff_about_order(db, order, stage, copy)
    subject, html, text = render_order(order, stage, copy)
    from app.services.messaging.catalogue import ORDER_STAGE_EVENTS

    notify(db, key, to=order.customer_email, customer_id=order.customer_id,
           subject=subject, html=html, text=text, reference=order.order_number,
           event=ORDER_STAGE_EVENTS.get(stage), variables=order_variables(order, stage),
           extra_html=order_progress(stage) + _order_rows(order) + order_cards(order, delivery=stage not in ("cancelled", "returned")),
           idempotency_key=f"order:{order.order_number}:{stage}")


def _tell_staff_about_order(db: Session, order, stage: str, copy: Optional[tuple]) -> None:
    """A new order, or a cancelled one, is news for the store team too (the bell, email, SMS, WhatsApp)."""
    if stage not in ("confirmed", "cancelled"):
        return
    from app.services import inbox

    href = f"/admin/orders/detail?id={order.id}"
    who = order.customer_name or order.customer_email
    method = "cash on delivery" if order.payment_method == "cod" else (order.payment_method or "online")
    if stage == "confirmed":
        inbox.staff(db, "order", f"New order {order.order_number} — {_money(order.total)}",
                    f"{who} · {order.item_count} item(s) · {method}.", href, permission="orders",
                    key=f"order:{order.order_number}:confirmed")
    else:
        why = "payment wasn't completed in time" if copy is PAYMENT_EXPIRED_COPY else "cancelled"
        inbox.staff(db, "order-cancelled", f"Order {order.order_number} cancelled — {_money(order.total)}",
                    f"{who}: {why}.", href, permission="orders", key=f"order:{order.order_number}:cancelled")


def order_variables(order, stage: str = "") -> dict:
    """The variables an order's notifications can use."""
    address = ", ".join(p for p in (order.shipping_line1, order.shipping_line2, order.shipping_city,
                                    order.shipping_state, order.shipping_pincode) if p)
    first = order.items[0].name if order.items else ""
    link = _order_link(order)
    return {
        "customer_name": (order.customer_name or "").split(" ")[0] or "there",
        "order_number": order.order_number,
        "order_date": order.placed_at.strftime("%d %b %Y") if order.placed_at else "",
        "order_total": _money(order.total),
        "payment_status": (order.payment_status or "").replace("-", " ").title(),
        "shipping_address": address,
        "tracking_number": getattr(order, "tracking_number", "") or "",
        "tracking_url": link,
        "order_url": link,
        "item_count": str(order.item_count or len(order.items)),
        "first_item": first,
        "status_text": stage.replace("-", " ") if stage else (order.status or "").replace("-", " "),
    }


def _send_now(provider, credentials, account, to, subject, html, text) -> str:
    message = build_message(
        sender_email=account.sender_email if hasattr(account, "sender_email") else account["sender_email"],
        sender_name=account.sender_name if hasattr(account, "sender_name") else account["sender_name"],
        reply_to=account.reply_to if hasattr(account, "reply_to") else account["reply_to"],
        to=to, subject=subject, html=html, text=text,
    )
    return deliver(provider, credentials, message)


def _worker(jobs: List[dict]) -> None:
    from app.core.database import SessionLocal

    for job in jobs:
        status, error, provider_id = "sent", "", None
        try:
            provider_id = _send_now(job["provider"], job["credentials"], job, job["to"], job["subject"], job["html"],
                                    job["text"]) or None
        except SendError as failure:
            status, error = "failed", str(failure)[:500]
        except Exception as failure:  # pragma: no cover — logged, never raised
            status, error = "failed", f"Unexpected error: {failure.__class__.__name__}"
            logger.exception("Email %s to %s failed", job["key"], job["to"])
        try:
            with SessionLocal() as log_db:
                log_db.add(EmailLog(
                    email_type=job["key"], recipient=job["to"], subject=job["subject"][:255],
                    status=status, error=error, reference=job["reference"][:40], created_at=datetime.utcnow(),
                    provider_id=(provider_id or "")[:100] or None, template_key=job.get("template", "")[:60],
                    delivery_id=job.get("delivery_id"),
                ))
                _record_delivery(log_db, job, status, error, provider_id)
                log_db.commit()
        except Exception:
            logger.exception("Could not log email %s", job["key"])


def _record_delivery(db: Session, job: dict, status: str, error: str, provider_id: Optional[str]) -> None:
    """The email's delivery row: sent, or failed and due for a retry (with what is needed to send it again)."""
    if not job.get("delivery_id"):
        return
    from app.models import NotificationDelivery
    from app.services.messaging import service as messaging

    row = db.get(NotificationDelivery, job["delivery_id"])
    if row is None:
        return
    now = datetime.utcnow()
    row.attempts += 1
    row.updated_at = now
    if status == "sent":
        row.status, row.sent_at, row.provider_message_id, row.last_error = "sent", now, provider_id, ""
        row.payload = None
        return
    row.last_error, row.failed_at = error[:500], now
    # A sign-in or reset link is never stored, so that email can't be retried.
    retryable = job["key"] not in messaging.SECRET_EMAIL_TYPES and messaging.email_transient(error)
    if retryable and row.attempts < row.max_attempts:
        row.status, row.next_attempt_at = "failed", now + messaging._backoff(row.attempts)
        row.payload = {"subject": job["subject"], "html": job["html"], "text": job["text"], "type": job["key"]}
    else:
        row.status, row.next_attempt_at = "dead", None


@event.listens_for(Session, "after_commit")
def _flush_outgoing(session: Session) -> None:
    jobs = session.info.pop("outgoing_email", None)
    if jobs:
        # Not a daemon: a daemon thread is killed the instant the process
        # exits, so every restart (a deploy, `--reload`) silently dropped the
        # emails still being sent — with no log line to show they existed.
        # Each send is bounded by its own timeout, so shutdown waits seconds.
        threading.Thread(target=_worker, args=(jobs,), daemon=False, name="email-sender").start()


@event.listens_for(Session, "after_rollback")
def _drop_outgoing(session: Session) -> None:
    session.info.pop("outgoing_email", None)
