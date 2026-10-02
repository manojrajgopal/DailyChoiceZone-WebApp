"""
Gift cards.

## Codes

A code is 16 characters from an alphabet without look-alikes (no 0/O, 1/I/L),
grouped as `DCZG-XXXX-XXXX-XXXX-XXXX` — about 80 bits from `secrets`. The code is
shown once, in the email that delivers the card, and never stored: the
database keeps a keyed hash (HMAC-SHA256 with a key derived from the app
secret) to look the card up, and the last four characters to show it. Nothing
logs a code. A lost email is answered by reissuing — a new code, the old one
dead — never by reading the old one back.

A card bought through the gateway has no code until its payment is confirmed:
the code is made, hashed and emailed in the same transaction that activates
the card.

## Balance

`balance` changes only together with a `GiftCardTransaction` (issue, redeem,
restore, expire, refund), under a row lock, so two checkouts using the same
card queue rather than both spending it.

## Tax

Buying a gift card isn't a sale of goods, so it has no invoice of its own; the
goods it later pays for are invoiced, with their tax, on their order. The card
appears on that invoice as a payment.
"""

from __future__ import annotations

import copy
import hashlib
import hmac
import html as html_lib
import logging
import re
import secrets
from datetime import datetime
from typing import Optional

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.config import settings as app_settings
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import AdminUser, Customer, GiftCard, GiftCardTransaction, SettingDocument
from app.services import billing

logger = logging.getLogger(__name__)

ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
CODE_LENGTH = 16
PREFIX = "DCZG"
EMAIL_TYPE = "gift_cards"
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

DEFAULTS = {
    "enabled": True,
    # Rupees.
    "minAmount": 100,
    "maxAmount": 10000,
    "denominations": [500, 1000, 2000, 5000],
    "allowCustomAmount": True,
    # 0: cards don't expire.
    "validityMonths": 12,
    # How many cards one order can use.
    "maxCardsPerOrder": 3,
    "allowWithCoupons": True,
    # Store credit.
    "storeCreditEnabled": True,
    "storeCreditWithGiftCards": True,
    "storeCreditWithCoupons": True,
}

LABELS = {
    "issue": "Issued", "redeem": "Used on an order", "restore": "Returned from an order",
    "refund-restore": "Refund returned to the card", "expire": "Expired", "disable": "Disabled",
    "enable": "Re-enabled", "refund": "Purchase refunded", "adjust": "Adjustment", "reissue": "New code issued",
}


# ---------------------------------------------------------------- settings


def settings(db: Session) -> dict:
    stored = (db.get(SettingDocument, "gift_cards") or SettingDocument(value={})).value or {}
    merged = copy.deepcopy(DEFAULTS)
    merged.update({k: v for k, v in stored.items() if k in DEFAULTS})
    return merged


def _whole(value, label: str) -> int:
    if isinstance(value, bool):
        raise ValidationError(f"{label} must be a whole number.", error_code="INVALID_SETTING")
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ValidationError(f"{label} must be a whole number.", error_code="INVALID_SETTING") from None


def save_settings(db: Session, payload: dict) -> dict:
    out = settings(db)
    for key in ("enabled", "allowCustomAmount", "allowWithCoupons", "storeCreditEnabled",
                "storeCreditWithGiftCards", "storeCreditWithCoupons"):
        if key in payload:
            out[key] = bool(payload[key])
    if "minAmount" in payload:
        out["minAmount"] = _whole(payload["minAmount"], "The minimum")
    if "maxAmount" in payload:
        out["maxAmount"] = _whole(payload["maxAmount"], "The maximum")
    if not 1 <= out["minAmount"] <= out["maxAmount"] <= 100000:
        raise ValidationError("Gift card values run from at least ₹1 up to ₹1,00,000, minimum below maximum.",
                              error_code="INVALID_SETTING")
    if "denominations" in payload:
        values = payload["denominations"]
        if not isinstance(values, list) or len(values) > 8:
            raise ValidationError("List up to eight amounts.", error_code="INVALID_SETTING")
        cleaned = sorted({_whole(v, "Each amount") for v in values})
        out["denominations"] = cleaned
    if any(not out["minAmount"] <= v <= out["maxAmount"] for v in out["denominations"]):
        raise ValidationError("Every listed amount must be between the minimum and maximum.", error_code="INVALID_SETTING")
    if not out["denominations"] and not out["allowCustomAmount"]:
        raise ValidationError("Offer some amounts, or allow a custom amount.", error_code="INVALID_SETTING")
    if "validityMonths" in payload:
        months = _whole(payload["validityMonths"], "Validity")
        if not 0 <= months <= 120:
            raise ValidationError("Validity is 0 (no expiry) to 120 months.", error_code="INVALID_SETTING")
        out["validityMonths"] = months
    if "maxCardsPerOrder" in payload:
        count = _whole(payload["maxCardsPerOrder"], "Cards per order")
        if not 1 <= count <= 5:
            raise ValidationError("Allow 1 to 5 cards per order.", error_code="INVALID_SETTING")
        out["maxCardsPerOrder"] = count
    now = datetime.utcnow()
    row = db.get(SettingDocument, "gift_cards")
    if row is None:
        db.add(SettingDocument(key="gift_cards", value=out, created_at=now, updated_at=now))
    else:
        row.value = out
        row.updated_at = now
    db.commit()
    return out


# ------------------------------------------------------------------- codes


def _key() -> bytes:
    return hmac.new((app_settings.JWT_SECRET_KEY or "").encode(), b"gift-card-codes", hashlib.sha256).digest()


def normalise(code: str) -> str:
    text = re.sub(r"[^A-Za-z0-9]", "", code or "").upper()
    if text.startswith(PREFIX) and len(text) == len(PREFIX) + CODE_LENGTH:
        text = text[len(PREFIX):]
    return text


def hash_code(code: str) -> str:
    return hmac.new(_key(), normalise(code).encode(), hashlib.sha256).hexdigest()


def _new_code() -> str:
    raw = "".join(secrets.choice(ALPHABET) for _ in range(CODE_LENGTH))
    return f"{PREFIX}-" + "-".join(raw[i:i + 4] for i in range(0, CODE_LENGTH, 4))


def _assign_code(db: Session, card: GiftCard) -> str:
    """A fresh code for `card`; returns it (to email) and stores only its hash."""
    for _ in range(5):
        code = _new_code()
        digest = hash_code(code)
        if db.execute(select(GiftCard.id).where(GiftCard.code_hash == digest)).first() is None:
            card.code_hash, card.code_last4 = digest, normalise(code)[-4:]
            return code
    raise ConflictError("Couldn't make a unique code. Please try again.", error_code="CODE_COLLISION")


def find(db: Session, code: str, *, lock: bool = False) -> Optional[GiftCard]:
    text = normalise(code)
    if len(text) != CODE_LENGTH:
        return None
    query = select(GiftCard).where(GiftCard.code_hash == hash_code(text))
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    return db.execute(query).scalar_one_or_none()


# ----------------------------------------------------------------- reading


def display_status(card: GiftCard, now: Optional[datetime] = None) -> str:
    now = now or datetime.utcnow()
    if card.status == "active" and card.expires_at and card.expires_at <= now:
        return "expired"
    if card.status == "active" and card.balance < card.initial_amount:
        return "partially-used"
    return card.status


def usable_reason(card: Optional[GiftCard], now: Optional[datetime] = None) -> str:
    """Why this card can't pay for anything now; "" when it can."""
    now = now or datetime.utcnow()
    if card is None:
        return "That gift card code isn't valid."
    if card.status == "pending":
        return "That gift card hasn't been paid for yet."
    if card.status in ("disabled", "cancelled", "refunded"):
        return "That gift card has been cancelled."
    if card.status == "expired" or (card.expires_at and card.expires_at <= now):
        return "That gift card has expired."
    if card.status == "used" or card.balance <= 0:
        return "That gift card has no balance left."
    return ""


def public_view(card: GiftCard) -> dict:
    """What anyone holding the code may know: no names, no purchaser."""
    return {
        "last4": card.code_last4, "status": display_status(card), "balance": billing.to_major(card.balance),
        "initialAmount": billing.to_major(card.initial_amount), "expiresAt": card.expires_at,
        "usable": usable_reason(card) == "",
    }


def owner_view(card: GiftCard) -> dict:
    out = public_view(card)
    out.update({
        "id": card.id, "recipientName": card.recipient_name, "recipientEmail": card.recipient_email,
        "message": card.message, "createdAt": card.created_at, "deliveredAt": card.delivered_at,
        "paidAt": card.paid_at,
    })
    return out


def admin_view(db: Session, card: GiftCard, *, detail: bool = False) -> dict:
    purchaser = db.get(Customer, card.purchaser_id) if card.purchaser_id else None
    out = owner_view(card)
    out.update({
        "reference": f"GC-{card.id:06d}", "rawStatus": card.status, "source": card.source,
        "senderName": card.sender_name, "statusReason": card.status_reason, "activatedAt": card.activated_at,
        "purchaser": {"id": purchaser.id, "name": purchaser.full_name, "email": purchaser.email} if purchaser else None,
        "gatewayPaymentId": card.gateway_payment_id,
    })
    if detail:
        # Every email about this card, from the email log: sent, or failed and why.
        from app.models import EmailLog

        out["emails"] = [
            {"to": e.recipient, "subject": e.subject, "status": e.status, "error": e.error, "at": e.created_at,
             "bouncedAt": e.bounced_at}
            for e in db.execute(select(EmailLog).where(EmailLog.reference == f"gift-card-{card.id}")
                                .order_by(EmailLog.id.desc())).scalars()
        ]
        out["transactions"] = [
            {"kind": t.kind, "label": LABELS.get(t.kind, t.kind), "amount": billing.to_major(t.amount),
             "balanceAfter": billing.to_major(t.balance_after), "orderId": t.order_id, "note": t.note, "at": t.created_at}
            for t in card.transactions
        ]
    return out


# -------------------------------------------------------------- movements


def _post(db: Session, card: GiftCard, kind: str, amount: int, *, order_id: Optional[str] = None,
          refund_id: Optional[str] = None, note: str = "", admin: Optional[AdminUser] = None,
          key: Optional[str] = None) -> Optional[GiftCardTransaction]:
    """Change the balance and write the ledger entry together. `card` must be locked."""
    if key and db.execute(select(GiftCardTransaction.id).where(GiftCardTransaction.idempotency_key == key)).first():
        return None
    if card.balance + amount < 0:
        raise ConflictError("The gift card doesn't have enough balance.", error_code="GIFT_CARD_INSUFFICIENT")
    now = datetime.utcnow()
    card.balance += amount
    card.updated_at = now
    entry = GiftCardTransaction(gift_card_id=card.id, kind=kind, amount=amount, balance_after=card.balance,
                                order_id=order_id, refund_id=refund_id, note=(note or "")[:300],
                                admin_id=admin.id if admin else None, idempotency_key=key, created_at=now)
    db.add(entry)
    db.flush()
    return entry


def lock(db: Session, card_id: int) -> GiftCard:
    card = db.execute(select(GiftCard).where(GiftCard.id == card_id).with_for_update()
                      .execution_options(populate_existing=True)).scalar_one_or_none()
    if card is None:
        raise NotFoundError("No such gift card.", error_code="GIFT_CARD_NOT_FOUND")
    return card


def redeem(db: Session, card: GiftCard, amount: int, *, order_id: str) -> None:
    """Spend from a locked, usable card for an order. Once per card per order."""
    reason = usable_reason(card)
    if reason:
        raise ConflictError(reason, error_code="GIFT_CARD_UNUSABLE")
    if amount <= 0 or amount > card.balance:
        raise ConflictError("The gift card doesn't have enough balance.", error_code="GIFT_CARD_INSUFFICIENT")
    _post(db, card, "redeem", -amount, order_id=order_id, key=f"redeem:{order_id}:{card.id}")
    if card.balance == 0:
        card.status = "used"


def restore(db: Session, card_id: int, amount: int, *, order_id: str, key: str, refund_id: Optional[str] = None,
            customer_id: Optional[str] = None) -> str:
    """
    Put money back on a card — an order cancelled, or a refund's gift-card
    share. A card that can no longer be used (expired, disabled) can't take it,
    so the money becomes store credit for the customer instead. Returns where
    it went: "card", "store-credit" or "duplicate".
    """
    if amount <= 0:
        return "card"
    card = lock(db, card_id)
    if card.status in ("active", "used") and not (card.expires_at and card.expires_at <= datetime.utcnow()):
        entry = _post(db, card, "restore" if refund_id is None else "refund-restore", amount, order_id=order_id,
                      refund_id=refund_id, note="Returned from an order", key=key)
        if entry is None:
            return "duplicate"
        if card.status == "used" and card.balance > 0:
            card.status = "active"
        return "card"
    if customer_id is None:
        logger.error("Gift card %s can't take back %s for order %s and has no customer to credit", card.id, amount, order_id)
        return "lost"
    from app.services import store_credit

    entry = store_credit.credit_customer(
        db, customer_id, kind="gift-card-refund", amount=amount, key=f"sc:{key}", order_id=order_id,
        refund_id=refund_id, reason=f"Gift card ending {card.code_last4} can no longer be used, so it was returned as store credit.",
    )
    return "store-credit" if entry is not None else "duplicate"


# --------------------------------------------------------------- purchase


def _amount(db: Session, amount) -> int:
    conf = settings(db)
    try:
        rupees = float(amount)
    except (TypeError, ValueError):
        raise ValidationError("Choose an amount.", error_code="INVALID_AMOUNT") from None
    if rupees != int(rupees):
        raise ValidationError("Gift cards are in whole rupees.", error_code="INVALID_AMOUNT")
    rupees = int(rupees)
    if rupees not in conf["denominations"] and not conf["allowCustomAmount"]:
        raise ValidationError("Choose one of the amounts offered.", error_code="INVALID_AMOUNT")
    if not conf["minAmount"] <= rupees <= conf["maxAmount"]:
        raise ValidationError(f"Gift cards are ₹{conf['minAmount']:,} to ₹{conf['maxAmount']:,}.", error_code="INVALID_AMOUNT")
    return billing.to_minor(rupees)


def _recipient(name: str, email: str, sender: str, message: str) -> tuple:
    name = re.sub(r"<[^>]*>", "", (name or "").strip())[:120]
    email = (email or "").strip().lower()[:255]
    sender = re.sub(r"<[^>]*>", "", (sender or "").strip())[:120]
    from app.services.questions import clean_text

    message = clean_text(message)[:300]
    if not name:
        raise ValidationError("Enter the recipient's name.", error_code="RECIPIENT_NAME_REQUIRED")
    if not _EMAIL.match(email):
        raise ValidationError("Enter a valid email address for the recipient.", error_code="RECIPIENT_EMAIL_INVALID")
    return name, email, sender, message


def start_purchase(db: Session, customer: Customer, *, amount, recipient_name: str, recipient_email: str,
                   sender_name: str = "", message: str = "") -> tuple:
    """A pending card and what the browser needs to pay for it."""
    from app.services.payments import PaymentRequest, get_provider

    conf = settings(db)
    if not conf["enabled"]:
        raise ConflictError("Gift cards aren't available right now.", error_code="GIFT_CARDS_OFF")
    minor = _amount(db, amount)
    name, email, sender, message = _recipient(recipient_name, recipient_email, sender_name or customer.full_name, message)
    now = datetime.utcnow()
    card = GiftCard(code_hash=secrets.token_hex(32), code_last4="----", status="pending", initial_amount=minor,
                    balance=0, currency="INR", source="purchase", purchaser_id=customer.id, sender_name=sender,
                    recipient_name=name, recipient_email=email, message=message, status_reason="",
                    created_at=now, updated_at=now)
    db.add(card)
    db.flush()
    result = get_provider().create(PaymentRequest(
        order_id=f"GC{card.id}", invoice_id="", customer_id=customer.id, customer_name=customer.full_name,
        customer_email=customer.email, amount=minor, currency="INR", method="upi",
        notes={"giftCardId": str(card.id), "orderNumber": f"Gift card GC-{card.id:06d}"},
    ))
    if not result.ok:
        db.rollback()
        raise ConflictError("We couldn't start the payment. Please try again.", error_code="PAYMENT_FAILED")
    card.gateway_order_id = result.provider_reference or result.transaction_id
    db.commit()

    if result.status == "paid":
        activate(db, card.id, payment_id=result.transaction_id)
        db.refresh(card)
        return card, {}

    business = (billing.billing_config(db) or {}).get("business") or {}
    handoff = {
        "provider": "razorpay", "keyId": app_settings.RAZOR_KEY_ID,
        "merchantName": business.get("storeName") or "Daily Choice Zone",
        "orderReference": card.gateway_order_id, "paymentId": str(card.id), "amount": minor, "currency": "INR",
        "name": customer.full_name, "email": customer.email, "phone": customer.phone or "",
        "description": f"Gift card for {name}",
    }
    return card, handoff


def _own(db: Session, customer: Customer, card_id: int) -> GiftCard:
    card = db.get(GiftCard, card_id)
    if card is None or card.purchaser_id != customer.id:
        raise NotFoundError("We couldn't find that gift card.", error_code="GIFT_CARD_NOT_FOUND")
    return card


def confirm_purchase(db: Session, customer: Customer, card_id: int, response: dict) -> GiftCard:
    from app.services.payments import get_provider

    card = _own(db, customer, card_id)
    if card.status != "pending":
        if card.status in ("active", "used"):
            return card
        raise ConflictError("This gift card purchase has closed.", error_code="PURCHASE_CLOSED")
    result = get_provider().verify(card.gateway_order_id or "", response)
    if not result.ok or result.status not in ("paid", "captured"):
        raise ConflictError(result.failure_reason or "We couldn't confirm the payment. If money left your account, "
                            "it will be refunded.", error_code="PAYMENT_UNVERIFIED")
    if result.amount is not None and result.amount != card.initial_amount:
        raise ConflictError("The payment amount didn't match the gift card.", error_code="AMOUNT_MISMATCH")
    return activate(db, card.id, payment_id=result.transaction_id)


def settle_from_gateway(db: Session, card_id: str, entity: dict) -> str:
    """The webhook's path: a captured payment whose notes name a gift card."""
    try:
        card = db.get(GiftCard, int(card_id))
    except (TypeError, ValueError):
        return "ignored: bad gift card id"
    if card is None:
        return "ignored: unknown gift card"
    # Abandoned by the buyer before a payment that then completed anyway (a
    # UPI app confirming late). Never paid here, so the money is not ours.
    abandoned = card.status == "cancelled" and card.paid_at is None and not card.gateway_payment_id
    if card.status != "pending" and not abandoned:
        return "duplicate: gift card already settled"
    if entity.get("status") != "captured":
        return f"ignored: payment {entity.get('status')}"
    if int(entity.get("amount") or 0) != card.initial_amount or entity.get("order_id") != card.gateway_order_id:
        logger.warning("Gift card %s: webhook payment does not match", card.id)
        return "ignored: mismatch"
    if abandoned:
        return _refund_abandoned(db, card, entity.get("id") or "")
    activate(db, card.id, payment_id=entity.get("id") or "")
    return "activated gift card"


def _refund_abandoned(db: Session, card: GiftCard, payment_id: str) -> str:
    """
    Send back a payment for a purchase the buyer abandoned, as orders do for a
    payment after cancellation. The card stays undelivered; recording the
    payment on it makes a redelivered webhook a duplicate, not a second refund.
    """
    from app.services.payments import get_provider

    result = get_provider().refund(payment_id, card.initial_amount, "Automatic refund: gift card purchase abandoned")
    if not result.ok:
        # Raised, so the webhook is recorded as failed and retried.
        raise ConflictError("The payment provider declined the refund.", error_code="PROVIDER_REFUSED")
    card.status, card.gateway_payment_id = "refunded", payment_id
    card.status_reason = "Paid after the purchase was abandoned; refunded automatically."
    card.updated_at = datetime.utcnow()
    logger.warning("Gift card %s: payment %s arrived after it was abandoned and was refunded", card.id, payment_id)
    db.commit()
    return "refunded: gift card purchase was abandoned"


def cancel_pending(db: Session, customer: Customer, card_id: int) -> None:
    card = _own(db, customer, card_id)
    if card.status == "pending":
        card.status, card.updated_at = "cancelled", datetime.utcnow()
        db.commit()


def _expiry(db: Session, start: datetime) -> Optional[datetime]:
    from app.services.membership import add_months

    months = int(settings(db)["validityMonths"])
    return add_months(start, months) if months else None


def activate(db: Session, card_id: int, *, payment_id: str = "", admin: Optional[AdminUser] = None) -> GiftCard:
    """Paid (or issued): give it a code, its balance and an expiry, and send it. Once."""
    card = lock(db, card_id)
    if card.status != "pending":
        return card
    now = datetime.utcnow().replace(microsecond=0)
    code = _assign_code(db, card)
    card.status, card.activated_at = "active", now
    card.expires_at = _expiry(db, now)
    if card.source == "purchase":
        card.gateway_payment_id, card.paid_at = payment_id or card.gateway_payment_id, now
    _post(db, card, "issue", card.initial_amount, admin=admin, key=f"issue:{card.id}",
          note="Purchased" if card.source == "purchase" else "Issued by the store")
    _deliver(db, card, code)
    db.commit()
    db.refresh(card)
    return card


def _deliver(db: Session, card: GiftCard, code: str, *, reissued: bool = False) -> None:
    """Email the card — with its code — to the recipient; tell the purchaser it went (without the code)."""
    from app.services import email as email_service

    esc = html_lib.escape
    amount = f"₹{billing.to_major(card.initial_amount):,.0f}"
    balance = f"₹{billing.to_major(card.balance):,.2f}"
    expiry = f" It can be used until {card.expires_at:%d %b %Y}." if card.expires_at else ""
    shop = app_settings.STOREFRONT_URL.rstrip("/")
    sender = esc(card.sender_name or "Someone")
    note = (f'<p style="margin:18px 0 0;padding:12px 14px;background:#faf7f2;border-left:3px solid #c08457;'
            f'font-size:14px;line-height:1.6;font-style:italic">{esc(card.message)}</p>') if card.message else ""
    code_box = (f'<p style="margin:22px 0 0;padding:16px;border:1px dashed #c08457;border-radius:6px;text-align:center;'
                f'font-family:Menlo,Consolas,monospace;font-size:20px;letter-spacing:.08em">{esc(code)}</p>'
                f'<p style="margin:8px 0 0;font-size:12px;color:#8a817a;text-align:center">Balance {balance}.'
                f' Enter this code at checkout.{esc(expiry)}</p>')
    if reissued:
        title, intro = "Your gift card's new code", (
            f"Hello {esc(card.recipient_name)}, here is a new code for your Daily Choice Zone gift card. "
            "The previous code no longer works.")
    else:
        title, intro = f"{amount} gift card for you", (
            f"Hello {esc(card.recipient_name)}, {sender} sent you a Daily Choice Zone gift card worth "
            f"<strong>{amount}</strong>.")
    html = email_service.layout(title, intro, note + code_box, cta=("Start shopping", shop),
                                footnote="Keep this code safe — anyone with it can spend the card. We'll never ask you for it.")
    sent = email_service.notify(db, EMAIL_TYPE, to=card.recipient_email, customer_id=None,
                                subject=f"{title} — Daily Choice Zone", html=html,
                                text=f"{title}. Code: {code}. Balance {balance}.{expiry} Shop: {shop}",
                                reference=f"gift-card-{card.id}")
    if sent:
        card.delivered_at = datetime.utcnow()

    # A recipient who shops with us sees it in their account too — never the code.
    from app.services import inbox

    recipient = db.execute(select(Customer).where(func.lower(Customer.email) == card.recipient_email.lower())).scalar_one_or_none()
    if recipient is not None:
        inbox.customer(db, recipient.id, EMAIL_TYPE,
                       "Your gift card has a new code" if reissued else f"You've received a {amount} gift card",
                       f"Sent by {card.sender_name or 'Daily Choice Zone'}. The code is in the email we sent to "
                       f"{card.recipient_email}; it ends in {card.code_last4}.", "/account/wallet")
    if not reissued and card.source == "purchase":
        inbox.staff(db, "gift-card", f"Gift card bought: {amount}",
                    f"GC-{card.id:06d} for {card.recipient_name}.", f"/admin/gift-cards?q=GC-{card.id:06d}", permission="gift-cards")
    if reissued or card.purchaser_id is None:
        return
    purchaser = db.get(Customer, card.purchaser_id)
    if purchaser is None or purchaser.email.lower() == card.recipient_email.lower():
        return
    confirm = email_service.layout(
        "Your gift card is on its way",
        f"Hello {esc(purchaser.first_name or 'there')}, your {amount} gift card for {esc(card.recipient_name)} "
        f"({esc(card.recipient_email)}) has been sent. Its code ends in {esc(card.code_last4)}.",
        cta=("Your gift cards", f"{shop}/account/wallet"),
    )
    email_service.notify(db, EMAIL_TYPE, to=purchaser.email, customer_id=purchaser.id,
                         subject=f"Your {amount} gift card was sent", html=confirm,
                         text=f"Your {amount} gift card for {card.recipient_name} was sent.",
                         reference=f"gift-card-{card.id}")


# ------------------------------------------------------------------- admin


def admin_issue(db: Session, admin: AdminUser, *, amount, recipient_name: str, recipient_email: str,
                message: str = "", reason: str = "") -> GiftCard:
    """A card from the store — a prize, a goodwill gesture. Emailed at once."""
    try:
        minor = billing.to_minor(float(amount))
    except (TypeError, ValueError):
        raise ValidationError("Enter an amount in rupees.", error_code="INVALID_AMOUNT") from None
    if not billing.to_minor(1) <= minor <= billing.to_minor(100000):
        raise ValidationError("Issue between ₹1 and ₹1,00,000.", error_code="INVALID_AMOUNT")
    reason = (reason or "").strip()
    if len(reason) < 5:
        raise ValidationError("Say why the card is being issued (at least 5 characters).", error_code="REASON_REQUIRED")
    name, email, _, message = _recipient(recipient_name, recipient_email, "", message)
    now = datetime.utcnow()
    card = GiftCard(code_hash=secrets.token_hex(32), code_last4="----", status="pending", initial_amount=minor,
                    balance=0, currency="INR", source="admin", sender_name="Daily Choice Zone", recipient_name=name,
                    recipient_email=email, message=message, issued_by=admin.id, status_reason=reason[:300],
                    created_at=now, updated_at=now)
    db.add(card)
    db.flush()
    return activate(db, card.id, admin=admin)


def admin_set_status(db: Session, admin: AdminUser, card_id: int, *, action: str, reason: str) -> GiftCard:
    reason = (reason or "").strip()
    if len(reason) < 5:
        raise ValidationError("Give a reason (at least 5 characters).", error_code="REASON_REQUIRED")
    card = lock(db, card_id)
    now = datetime.utcnow()
    if action == "disable":
        if card.status not in ("active", "used"):
            raise ConflictError("Only an active card can be disabled.", error_code="INVALID_STATUS")
        card.status = "disabled"
        db.add(GiftCardTransaction(gift_card_id=card.id, kind="disable", amount=0, balance_after=card.balance,
                                   note=reason[:300], admin_id=admin.id, created_at=now))
    elif action == "enable":
        if card.status != "disabled":
            raise ConflictError("Only a disabled card can be re-enabled.", error_code="INVALID_STATUS")
        card.status = "active" if card.balance > 0 else "used"
        db.add(GiftCardTransaction(gift_card_id=card.id, kind="enable", amount=0, balance_after=card.balance,
                                   note=reason[:300], admin_id=admin.id, created_at=now))
    else:
        raise ValidationError("Disable or enable.", error_code="INVALID_ACTION")
    card.status_reason, card.updated_at = reason[:300], now
    db.commit()
    db.refresh(card)
    return card


def admin_reissue(db: Session, admin: AdminUser, card_id: int, *, reason: str) -> GiftCard:
    """A new code, emailed to the recipient; the old code stops working at once."""
    reason = (reason or "").strip()
    if len(reason) < 5:
        raise ValidationError("Give a reason (at least 5 characters).", error_code="REASON_REQUIRED")
    card = lock(db, card_id)
    if usable_reason(card):
        raise ConflictError("Only a card that can still be spent gets a new code.", error_code="INVALID_STATUS")
    code = _assign_code(db, card)
    db.add(GiftCardTransaction(gift_card_id=card.id, kind="reissue", amount=0, balance_after=card.balance,
                               note=reason[:300], admin_id=admin.id, created_at=datetime.utcnow()))
    _deliver(db, card, code, reissued=True)
    card.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(card)
    return card


def admin_refund_unused(db: Session, admin: AdminUser, card_id: int, *, reason: str) -> GiftCard:
    """
    Refund a purchased card that hasn't been spent at all, through the gateway
    it was paid with. A card that has been used is not refunded here.
    """
    from app.services.payments import get_provider

    reason = (reason or "").strip()
    if len(reason) < 5:
        raise ValidationError("Give a reason (at least 5 characters).", error_code="REASON_REQUIRED")
    card = lock(db, card_id)
    if card.source != "purchase" or not card.gateway_payment_id:
        raise ConflictError("Only a card bought through the website can be refunded.", error_code="NOT_REFUNDABLE")
    if card.status not in ("active", "disabled") or card.balance != card.initial_amount:
        raise ConflictError("Only an unused card can be refunded.", error_code="NOT_REFUNDABLE")
    result = get_provider().refund(card.gateway_payment_id, card.initial_amount, reason[:200])
    if not result.ok:
        raise ConflictError("The payment provider declined the refund.", error_code="PROVIDER_REFUSED")
    _post(db, card, "refund", -card.balance, admin=admin, note=reason, key=f"refund:{card.id}")
    card.status, card.status_reason, card.updated_at = "refunded", reason[:300], datetime.utcnow()
    purchaser = db.get(Customer, card.purchaser_id) if card.purchaser_id else None
    if purchaser is not None:
        from app.services import email as email_service

        amount = f"₹{billing.to_major(card.initial_amount):,.2f}"
        title = f"Your {amount} gift card was refunded"
        message = (f"The gift card for {card.recipient_name} has been cancelled and {amount} refunded to the way you "
                   "paid. Refunds usually reach your account within 5–7 working days.")
        link = f"{app_settings.STOREFRONT_URL.rstrip('/')}/account/wallet"
        email_service.notify(db, EMAIL_TYPE, to=purchaser.email, customer_id=purchaser.id, subject=title,
                             html=email_service.layout(title, html_lib.escape(message), cta=("Your gift cards", link)),
                             text=f"{message} {link}", reference=f"gift-card-{card.id}")
    db.commit()
    db.refresh(card)
    return card


def admin_search(db: Session, *, status: str = "", q: str = "", page: int = 1, page_size: int = 25) -> tuple:
    now = datetime.utcnow()
    conditions = []
    if status == "partially-used":
        conditions += [GiftCard.status == "active", GiftCard.balance < GiftCard.initial_amount]
    elif status == "expired":
        conditions.append(or_(GiftCard.status == "expired",
                              (GiftCard.status == "active") & (GiftCard.expires_at <= now)))
    elif status:
        conditions.append(GiftCard.status == status)
    text = (q or "").strip()
    if text:
        like = f"%{text}%"
        people = select(Customer.id).where(or_(Customer.email.ilike(like), Customer.first_name.ilike(like),
                                               Customer.last_name.ilike(like)))
        options = [GiftCard.recipient_email.ilike(like), GiftCard.recipient_name.ilike(like),
                   GiftCard.purchaser_id.in_(people)]
        digits = re.sub(r"\D", "", text.upper().replace("GC", ""))
        if digits and text.upper().startswith("GC"):
            options.append(GiftCard.id == int(digits))
        if len(normalise(text)) == 4:
            options.append(GiftCard.code_last4 == normalise(text))
        if len(normalise(text)) == CODE_LENGTH:
            options.append(GiftCard.code_hash == hash_code(text))
        conditions.append(or_(*options))
    total = db.execute(select(func.count()).select_from(GiftCard).where(*conditions)).scalar_one()
    rows = db.execute(select(GiftCard).where(*conditions).order_by(GiftCard.id.desc())
                      .offset((max(1, page) - 1) * page_size).limit(page_size)).scalars().all()
    counts = dict(db.execute(select(GiftCard.status, func.count()).group_by(GiftCard.status)).all())
    outstanding = db.execute(select(func.coalesce(func.sum(GiftCard.balance), 0)).where(
        GiftCard.status == "active")).scalar_one()
    return [admin_view(db, r) for r in rows], total, counts, billing.to_major(int(outstanding or 0))


def mine(db: Session, customer: Customer) -> list:
    rows = db.execute(select(GiftCard).where(GiftCard.purchaser_id == customer.id, GiftCard.status != "cancelled")
                      .order_by(GiftCard.id.desc()).limit(100)).scalars().all()
    return [owner_view(r) for r in rows]


def expire_due(db: Session, now: Optional[datetime] = None) -> int:
    """Cards past their date: the remaining balance is written off with a ledger entry."""
    now = now or datetime.utcnow()
    ids = db.execute(select(GiftCard.id).where(GiftCard.status.in_(("active", "used")), GiftCard.expires_at.is_not(None),
                                               GiftCard.expires_at <= now).limit(500)).scalars().all()
    for card_id in ids:
        card = lock(db, card_id)
        if card.status not in ("active", "used"):
            continue
        if card.balance > 0:
            _post(db, card, "expire", -card.balance, note="Expired", key=f"expire:{card.id}")
        card.status, card.updated_at = "expired", now
        db.commit()
    return len(ids)
