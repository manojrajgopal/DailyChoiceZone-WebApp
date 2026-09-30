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
import threading
from datetime import datetime
from typing import Dict, List, Optional

from sqlalchemy import event, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import ValidationError
from app.models import CustomerEmailPreference, EmailAccount, EmailLog, SettingDocument
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
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    page: int = 1,
    page_size: int = 25,
) -> tuple:
    """The whole email log, filtered and paged in the database. Returns (rows, total, counts)."""
    from sqlalchemy import func, or_

    conditions = []
    if email_type:
        conditions.append(EmailLog.email_type == email_type)
    text = (query or "").strip()
    if text:
        like = f"%{text}%"
        conditions.append(or_(EmailLog.recipient.ilike(like), EmailLog.subject.ilike(like),
                              EmailLog.reference.ilike(like)))
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


def layout(title: str, intro: str, rows: str = "", cta: Optional[tuple] = None, footnote: str = "") -> str:
    brand = _brand()
    esc = html_lib.escape
    button = (
        f'<p style="margin:28px 0 8px"><a href="{esc(cta[1])}" style="background:#1e1b18;color:#faf7f2;'
        f'padding:12px 22px;border-radius:4px;text-decoration:none;font-size:14px;letter-spacing:.04em">'
        f"{esc(cta[0])}</a></p>"
        if cta
        else ""
    )
    return f"""<!doctype html><html><body style="margin:0;background:#f5f1eb;font-family:Helvetica,Arial,sans-serif;color:#1e1b18">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f1eb;padding:28px 12px">
<tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:6px;overflow:hidden">
<tr><td style="padding:22px 28px;border-bottom:1px solid #ede7df;font-family:Georgia,serif;font-size:20px">{esc(brand["name"])}</td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 12px;font-family:Georgia,serif;font-weight:normal;font-size:24px">{esc(title)}</h1>
<p style="margin:0;font-size:14px;line-height:1.6;color:#524b45">{intro}</p>
{rows}{button}
</td></tr>
<tr><td style="padding:18px 28px;background:#faf7f2;font-size:12px;line-height:1.6;color:#8a817a">
{footnote or "You're receiving this because of activity on your Daily Choice Zone account. You can choose which emails you get in your account settings."}
</td></tr></table></td></tr></table></body></html>"""


def _money(value) -> str:
    return f"₹{float(value):,.2f}"


def render_test(sender_name: str) -> tuple:
    subject = f"Test email from {sender_name}"
    html = layout(
        "Your email is set up",
        "This is a test message from your store. If you can read it, emails to customers will be delivered from this account.",
        footnote="Sent from your store's admin portal while setting up email.",
    )
    return subject, html, "Your email is set up. This is a test message from your store."


def _order_rows(order) -> str:
    esc = html_lib.escape
    items = "".join(
        f'<tr><td style="padding:8px 0;border-bottom:1px solid #ede7df;font-size:14px">{esc(item.name)}'
        f'<span style="color:#8a817a"> × {item.quantity}</span></td>'
        f'<td align="right" style="padding:8px 0;border-bottom:1px solid #ede7df;font-size:14px">{_money(item.line_total)}</td></tr>'
        for item in order.items
    )
    return (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px">{items}'
        f'<tr><td style="padding:12px 0 0;font-size:14px;font-weight:bold">Total</td>'
        f'<td align="right" style="padding:12px 0 0;font-size:14px;font-weight:bold">{_money(order.total)}</td></tr></table>'
    )


def _order_link(order) -> str:
    return f"{_brand()['url']}/account/order?number={order.order_number}"


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

# An unpaid online order that ran out of time: nothing was charged, so the
# usual "your refund is on its way" would be wrong and worrying.
PAYMENT_EXPIRED_COPY = (
    "Your order has been cancelled",
    "We didn't receive the payment in time, so your order has been cancelled and "
    "the items released. You haven't been charged. You're welcome to order again.",
)


def render_order(order, stage: str, copy: Optional[tuple] = None) -> tuple:
    title, intro = copy or STAGE_COPY.get(stage, ("Update on your order", "There's an update on your order."))
    esc = html_lib.escape
    intro_full = f"{esc(intro)} Order <strong>{esc(order.order_number)}</strong>."
    html = layout(title, intro_full, _order_rows(order), ("View your order", _order_link(order)))
    return f"{title} — {order.order_number}", html, f"{title}. Order {order.order_number}. {_order_link(order)}"


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
) -> bool:
    """
    Queue an email to go out when this session commits. Returns whether it was
    queued — False when no account is set up, the store has this kind switched
    off, or the customer has turned it off.
    """
    try:
        if not to or "@" not in to or not wants(db, key, customer_id):
            return False
        account = active_account(db)
        if account is None:
            return False
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
            "reference": reference,
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
    subject, html, text = render_order(order, stage, copy)
    notify(db, key, to=order.customer_email, customer_id=order.customer_id,
           subject=subject, html=html, text=text, reference=order.order_number)


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
        status, error = "sent", ""
        try:
            _send_now(job["provider"], job["credentials"], job, job["to"], job["subject"], job["html"], job["text"])
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
                ))
                log_db.commit()
        except Exception:
            logger.exception("Could not log email %s", job["key"])


@event.listens_for(Session, "after_commit")
def _flush_outgoing(session: Session) -> None:
    jobs = session.info.pop("outgoing_email", None)
    if jobs:
        threading.Thread(target=_worker, args=(jobs,), daemon=True, name="email-sender").start()


@event.listens_for(Session, "after_rollback")
def _drop_outgoing(session: Session) -> None:
    session.info.pop("outgoing_email", None)
