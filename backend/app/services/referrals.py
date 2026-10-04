"""
The referral programme.

## How it works

Every customer has a code (made on first use). Someone new who signs up with
it is *referred*: a `Referral` row links the two, at most one per new
customer. Nothing is paid at sign-up. When the new customer's first
qualifying order — at least the programme's minimum, within its window — is
**paid** (or **delivered**, if the store prefers), both get their reward:
store credit or reward points, as the store sets.

## Why it can't pay twice

The referral row is locked while it is checked, and only a `pending` one can
pay out. Each reward is posted to the store-credit or points ledger with an
idempotency key per referral and side (`referral:<id>:referrer`), which the
database refuses to accept twice — so a payment webhook arriving twice, or
the delivered and paid events both firing, still pays once.

## Abuse

- Your own code can't be used on yourself: the same email address (ignoring
  the dots and `+tags` mail providers ignore) is refused at sign-up.
- A referral that looks like the same person — the same phone number, or an
  order delivered to the referrer's address, or several sign-ups from one
  network in a short time — is held for a person to review instead of paying
  automatically (unless the store turns holding off).
- A referrer is rewarded at most N times a calendar month; past that the new
  customer still gets their reward and the referrer's is recorded as capped.
- A rewarded order that is cancelled, returned or refunded in full takes both
  rewards back — as much as is still unspent.

Every amount comes from the programme settings on the server at the moment of
the reward. Nothing in a request says what anybody earns.
"""

from __future__ import annotations

import copy
import hashlib
import hmac
import html as html_lib
import logging
import re
import secrets
from datetime import datetime, timedelta
from typing import List, Optional

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings as app_settings
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import Address, AdminUser, Customer, Order, Referral, ReferralCode, SettingDocument
from app.services import audit, billing
from app.services.lookup.filters import any_id_condition

logger = logging.getLogger(__name__)

EMAIL_TYPE = "referrals"
INTERVAL_SECONDS = 3600
STATUSES = ("pending", "review", "rewarded", "rejected", "reversed", "expired")
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

DEFAULTS = {
    "enabled": True,
    # store_credit: amounts in rupees | points: amounts in points
    "rewardType": "store_credit",
    "referrerReward": 100,
    "refereeReward": 100,
    "minOrderAmount": 499,
    # paid | delivered
    "rewardOn": "delivered",
    "windowDays": 60,
    "maxRewardsPerMonth": 10,
    "holdSuspicious": True,
}


# ---------------------------------------------------------------- settings


def settings(db: Session) -> dict:
    stored = (db.get(SettingDocument, "referrals") or SettingDocument(value={})).value or {}
    merged = copy.deepcopy(DEFAULTS)
    merged.update({k: v for k, v in stored.items() if k in DEFAULTS})
    return merged


def _number(value, label: str, *, low: float, high: float, whole: bool = True):
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValidationError(f"{label} must be a number.", error_code="INVALID_SETTING") from None
    if not low <= number <= high:
        raise ValidationError(f"{label} must be between {low:g} and {high:g}.", error_code="INVALID_SETTING")
    if whole and not number.is_integer():
        raise ValidationError(f"{label} must be a whole number.", error_code="INVALID_SETTING")
    return int(number) if whole else round(number, 2)


def save_settings(db: Session, admin: AdminUser, payload: dict) -> dict:
    current = settings(db)
    reward_type = payload.get("rewardType", current["rewardType"])
    if reward_type not in ("store_credit", "points"):
        raise ValidationError("Rewards are store credit or reward points.", error_code="INVALID_SETTING")
    reward_on = payload.get("rewardOn", current["rewardOn"])
    if reward_on not in ("paid", "delivered"):
        raise ValidationError("Reward when the order is paid, or when it is delivered.", error_code="INVALID_SETTING")
    high = 100000 if reward_type == "points" else 10000
    unit = "points" if reward_type == "points" else "₹"
    value = {
        "enabled": bool(payload.get("enabled", current["enabled"])),
        "rewardType": reward_type,
        "referrerReward": _number(payload.get("referrerReward", current["referrerReward"]),
                                  f"The referrer's reward ({unit})", low=0, high=high),
        "refereeReward": _number(payload.get("refereeReward", current["refereeReward"]),
                                 f"The new customer's reward ({unit})", low=0, high=high),
        "minOrderAmount": _number(payload.get("minOrderAmount", current["minOrderAmount"]),
                                  "The minimum order", low=0, high=1000000),
        "rewardOn": reward_on,
        "windowDays": _number(payload.get("windowDays", current["windowDays"]), "The window", low=1, high=365),
        "maxRewardsPerMonth": _number(payload.get("maxRewardsPerMonth", current["maxRewardsPerMonth"]),
                                      "Rewards per referrer per month", low=1, high=1000),
        "holdSuspicious": bool(payload.get("holdSuspicious", current["holdSuspicious"])),
    }
    if value["referrerReward"] == 0 and value["refereeReward"] == 0 and value["enabled"]:
        raise ValidationError("Give at least one side a reward, or switch the programme off.",
                              error_code="INVALID_SETTING")
    row = db.get(SettingDocument, "referrals")
    if row is None:
        db.add(SettingDocument(key="referrals", value=value))
    else:
        row.value = value
    audit.record(db, "referrals.settings", resource_type="referrals", resource_id="settings", actor=admin,
                 summary="Changed the referral programme settings", changes=audit.diff(current, value))
    db.commit()
    return value


def rules(conf: dict) -> dict:
    """What a customer is told about the programme."""
    points = conf["rewardType"] == "points"
    return {
        "enabled": conf["enabled"],
        "rewardType": conf["rewardType"],
        "referrerReward": conf["referrerReward"],
        "refereeReward": conf["refereeReward"],
        "minOrderAmount": conf["minOrderAmount"],
        "rewardOn": conf["rewardOn"],
        "windowDays": conf["windowDays"],
        "unit": "points" if points else "store credit",
    }


# ------------------------------------------------------------------- codes


def _hash_ip(ip: str) -> str:
    if not ip:
        return ""
    key = f"referrals:{app_settings.JWT_SECRET_KEY}".encode()
    return hmac.new(key, ip.encode(), hashlib.sha256).hexdigest()[:40]


def code_for(db: Session, customer: Customer) -> ReferralCode:
    """The customer's code, made the first time it is asked for."""
    row = db.execute(select(ReferralCode).where(ReferralCode.customer_id == customer.id)).scalar_one_or_none()
    if row is not None:
        return row
    stem = re.sub(r"[^A-Z]", "", (customer.first_name or "").upper().replace("O", "").replace("I", ""))[:5] or "DCZ"
    for _ in range(12):
        code = stem + "".join(secrets.choice(_ALPHABET) for _ in range(4))
        try:
            with db.begin_nested():
                row = ReferralCode(customer_id=customer.id, code=code, disabled=False, created_at=datetime.utcnow())
                db.add(row)
            db.commit()
            return row
        except IntegrityError:
            existing = db.execute(select(ReferralCode).where(ReferralCode.customer_id == customer.id)).scalar_one_or_none()
            if existing is not None:
                return existing
    raise ConflictError("Couldn't make a referral code just now. Try again.", error_code="REFERRAL_CODE_FAILED")


def _find_code(db: Session, code: str) -> Optional[ReferralCode]:
    code = re.sub(r"[^A-Za-z0-9]", "", code or "").upper()[:16]
    if not code:
        return None
    return db.execute(select(ReferralCode).where(ReferralCode.code == code)).scalar_one_or_none()


def check_code(db: Session, code: str) -> dict:
    """Whether a code can be used to sign up. Says nothing about whose it is."""
    conf = settings(db)
    row = _find_code(db, code)
    referrer = db.get(Customer, row.customer_id) if row else None
    valid = bool(conf["enabled"] and row and not row.disabled and referrer and referrer.status == "active")
    return {"valid": valid, "code": row.code if valid else None, "rules": rules(conf) if valid else None}


def _mailbox(email: str) -> str:
    """An address as the mailbox it delivers to: case, dots and +tags ignored where providers ignore them."""
    local, _, domain = (email or "").lower().partition("@")
    local = local.split("+", 1)[0]
    if domain in ("gmail.com", "googlemail.com"):
        local, domain = local.replace(".", ""), "gmail.com"
    return f"{local}@{domain}"


def attach_at_signup(db: Session, customer: Customer, code: Optional[str], ip: str = "") -> Optional[Referral]:
    """
    Link a new account to the code it signed up with. Called inside the
    sign-up transaction; never commits. A code that doesn't exist (or is
    switched off) is refused, so the customer can fix it rather than lose it.
    """
    if not code or not code.strip():
        return None
    conf = settings(db)
    if not conf["enabled"]:
        return None
    row = _find_code(db, code)
    referrer = db.get(Customer, row.customer_id) if row else None
    if row is None or row.disabled or referrer is None or referrer.status != "active":
        raise ValidationError("That referral code isn't valid. Check it, or leave it empty.",
                              error_code="REFERRAL_CODE_INVALID")
    if referrer.id == customer.id or _mailbox(referrer.email) == _mailbox(customer.email):
        raise ValidationError("You can't use your own referral code.", error_code="SELF_REFERRAL")
    now = datetime.utcnow()
    flags = []
    if customer.phone and referrer.phone and _digits(customer.phone) == _digits(referrer.phone):
        flags.append("same_phone")
    ip_hash = _hash_ip(ip)
    if ip_hash:
        recent = db.execute(select(func.count()).select_from(Referral).where(
            Referral.referrer_id == referrer.id, Referral.signup_ip_hash == ip_hash,
            Referral.created_at >= now - timedelta(days=7))).scalar_one()
        if recent >= 2:
            flags.append("same_network")
    referral = Referral(
        referrer_id=referrer.id, referee_id=customer.id, code=row.code, status="pending", flags=flags,
        signup_ip_hash=ip_hash, reward_type=conf["rewardType"], referrer_reward=0, referee_reward=0,
        reversal_shortfall=0, note="", expires_at=now + timedelta(days=int(conf["windowDays"])),
        created_at=now, updated_at=now,
    )
    db.add(referral)
    db.flush()
    _tell(db, referrer, "A friend joined with your referral code",
          f"{customer.first_name or 'Your friend'} has signed up with your code. You'll get your reward when "
          f"their first order of {_money(conf['minOrderAmount'])} or more is "
          f"{'delivered' if conf['rewardOn'] == 'delivered' else 'paid'}.", reference=f"referral-{referral.id}-joined")
    return referral


def _digits(value: str) -> str:
    digits = re.sub(r"\D", "", value or "")
    return digits[-10:]


def _money(rupees) -> str:
    return f"₹{float(rupees):,.0f}"


# ------------------------------------------------------------ qualifying


def on_order_paid(db: Session, order: Order) -> None:
    """A paid order: due now when the programme rewards on payment."""
    if settings(db)["rewardOn"] == "paid":
        _qualify(db, order)


def on_order_delivered(db: Session, order: Order) -> None:
    """A delivered order, paid by now (cash on delivery is collected on delivery)."""
    if order.payment_status == "paid":
        _qualify(db, order)


def _flags_for_order(db: Session, referral: Referral, order: Order) -> List[str]:
    flags = list(referral.flags or [])
    referrer = db.get(Customer, referral.referrer_id)
    if referrer is None:
        return flags
    if order.shipping_phone and referrer.phone and _digits(order.shipping_phone) == _digits(referrer.phone):
        flags.append("same_phone")

    def key(line1: str, pincode: str) -> str:
        return re.sub(r"[^a-z0-9]", "", (line1 or "").lower()) + "|" + (pincode or "").strip()

    target = key(order.shipping_line1, order.shipping_pincode)
    if target != "|":
        theirs = {key(a.line1, a.pincode) for a in db.execute(
            select(Address).where(Address.customer_id == referrer.id)).scalars()}
        theirs |= {key(l1, pc) for l1, pc in db.execute(
            select(Order.shipping_line1, Order.shipping_pincode).where(Order.customer_id == referrer.id).limit(200)).all()}
        if target in theirs:
            flags.append("shared_address")
    return sorted(set(flags))


def _qualify(db: Session, order: Order) -> None:
    conf = settings(db)
    if not conf["enabled"] or not order.customer_id:
        return
    referral = db.execute(select(Referral).where(Referral.referee_id == order.customer_id).with_for_update()
                          ).scalar_one_or_none()
    if referral is None or referral.status != "pending":
        return
    if order.status == "cancelled" or order.payment_status not in ("paid",):
        return
    now = datetime.utcnow()
    if referral.expires_at and order.placed_at and order.placed_at > referral.expires_at:
        referral.status, referral.updated_at, referral.note = "expired", now, "No qualifying order in time."
        return
    if billing.to_minor(float(order.total)) < billing.to_minor(float(conf["minOrderAmount"])):
        return  # stays pending: a later order may qualify
    flags = _flags_for_order(db, referral, order)
    referral.flags = flags
    referral.qualifying_order_id = order.id
    referral.qualified_at = now
    referral.updated_at = now
    if flags and conf["holdSuspicious"]:
        referral.status = "review"
        from app.services import inbox

        inbox.staff(db, "referral", "Referral held for review",
                    f"Order {order.order_number} would pay a referral reward, but it looks like the same person "
                    f"({', '.join(_FLAG_LABELS.get(f, f) for f in flags)}).",
                    f"/admin/referrals?status=review", permission="referrals")
        return
    _reward(db, referral, conf)


_FLAG_LABELS = {
    "same_phone": "same phone number",
    "shared_address": "delivered to the referrer's address",
    "same_network": "several sign-ups from one network",
}


def _rewarded_this_month(db: Session, referrer_id: str, now: datetime) -> int:
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    return int(db.execute(select(func.count()).select_from(Referral).where(
        Referral.referrer_id == referrer_id, Referral.status.in_(("rewarded", "reversed")),
        Referral.rewarded_at >= start, Referral.referrer_reward > 0)).scalar_one())


def _reward(db: Session, referral: Referral, conf: dict, *, admin: Optional[AdminUser] = None) -> None:
    """Pay both sides. The referral row is locked by the caller."""
    now = datetime.utcnow()
    points = conf["rewardType"] == "points"
    referrer_amount = int(conf["referrerReward"]) if points else billing.to_minor(conf["referrerReward"])
    referee_amount = int(conf["refereeReward"]) if points else billing.to_minor(conf["refereeReward"])
    capped = _rewarded_this_month(db, referral.referrer_id, now) >= int(conf["maxRewardsPerMonth"])
    if capped:
        referrer_amount = 0
    referee = db.get(Customer, referral.referee_id)
    referrer = db.get(Customer, referral.referrer_id)
    name = (referee.first_name if referee else "") or "your friend"
    paid_referrer = _pay(db, referral, "referrer", referral.referrer_id, referrer_amount, points,
                         f"Referral reward: {name} joined and ordered")
    paid_referee = _pay(db, referral, "referee", referral.referee_id, referee_amount, points,
                        "Welcome reward for joining with a referral")
    referral.reward_type = conf["rewardType"]
    referral.referrer_reward = paid_referrer
    referral.referee_reward = paid_referee
    referral.status = "rewarded"
    referral.rewarded_at = now
    referral.updated_at = now
    if capped:
        referral.note = "Referrer's reward skipped: monthly limit reached."
    if admin is not None:
        referral.decided_by = admin.id
    if referrer is not None and paid_referrer:
        _tell(db, referrer, f"You earned {_reward_text(paid_referrer, points)}",
              f"{name} placed their first order, so your referral reward of {_reward_text(paid_referrer, points)} "
              "has been added to your account.", reference=f"referral-{referral.id}-referrer",
              href="/account/referrals")
    if referee is not None and paid_referee:
        _tell(db, referee, f"Your welcome reward: {_reward_text(paid_referee, points)}",
              f"Thanks for joining with a referral. {_reward_text(paid_referee, points)} has been added to your "
              "account for your next order.", reference=f"referral-{referral.id}-referee",
              href="/account/wallet" if not points else "/account/rewards")


def _reward_text(amount: int, points: bool) -> str:
    return f"{amount:,} reward points" if points else f"₹{billing.to_major(amount):,.2f} store credit"


def _pay(db: Session, referral: Referral, side: str, customer_id: str, amount: int, points: bool, reason: str) -> int:
    if amount <= 0:
        return 0
    key = f"referral:{referral.id}:{side}"
    if points:
        from app.services import loyalty

        entry = loyalty.grant(db, customer_id, amount, kind="referral", reason=reason, key=key)
        return amount if entry is not None else 0
    from app.services import store_credit

    try:
        store_credit.post(db, customer_id, kind="referral", amount=amount, reason=reason, idempotency_key=key)
    except store_credit.AlreadyPosted:
        return 0
    return amount


def on_order_reversed(db: Session, order: Order, *, reason: str) -> None:
    """
    The order a referral waited on, or was paid for, didn't stand.
    Held → back to pending (another order may qualify). Rewarded → taken back.
    """
    referral = db.execute(select(Referral).where(Referral.qualifying_order_id == order.id).with_for_update()
                          ).scalar_one_or_none()
    if referral is None:
        return
    now = datetime.utcnow()
    if referral.status == "review":
        referral.status, referral.qualifying_order_id, referral.qualified_at = "pending", None, None
        referral.updated_at = now
        return
    if referral.status != "rewarded":
        return
    points = referral.reward_type == "points"
    shortfall = 0
    for side, customer_id, amount in (("referrer", referral.referrer_id, referral.referrer_reward),
                                      ("referee", referral.referee_id, referral.referee_reward)):
        shortfall += _take_back(db, referral, side, customer_id, amount, points, reason)
    referral.status, referral.reversed_at, referral.updated_at = "reversed", now, now
    referral.reversal_shortfall = shortfall
    referral.note = (reason + (f" — {_reward_text(shortfall, points)} had already been spent." if shortfall else ""))[:300]


def _take_back(db: Session, referral: Referral, side: str, customer_id: str, amount: int, points: bool,
               reason: str) -> int:
    if amount <= 0:
        return 0
    key = f"referral:{referral.id}:{side}:reversed"
    if points:
        from app.services import loyalty

        return loyalty.revoke(db, customer_id, amount, kind="referral_reversed", reason=reason, key=key)
    from app.services import store_credit

    available = store_credit.balance(db, customer_id)
    take = min(available, amount)
    if take > 0:
        try:
            store_credit.post(db, customer_id, kind="referral-reversed", amount=-take, reason=reason,
                              idempotency_key=key)
        except store_credit.AlreadyPosted:
            return 0
    return amount - take


def expire_due(db: Session, now: Optional[datetime] = None) -> int:
    now = now or datetime.utcnow()
    rows = db.execute(select(Referral).where(Referral.status == "pending", Referral.expires_at.is_not(None),
                                             Referral.expires_at <= now).with_for_update(skip_locked=True)
                      .limit(500)).scalars().all()
    for row in rows:
        row.status, row.updated_at, row.note = "expired", now, "No qualifying order in time."
    db.commit()
    return len(rows)


# --------------------------------------------------------------- customer


def _display_name(customer: Optional[Customer]) -> str:
    if customer is None:
        return "A customer"
    initial = (customer.last_name or "")[:1]
    return f"{customer.first_name or 'Customer'}{f' {initial}.' if initial else ''}"


CUSTOMER_STATUS = {
    "pending": "Joined — waiting for their first order", "review": "Order being checked",
    "rewarded": "Rewarded", "rejected": "Not eligible", "reversed": "Order returned — reward taken back",
    "expired": "No order in time",
}


def mine(db: Session, customer: Customer) -> dict:
    conf = settings(db)
    code = code_for(db, customer) if conf["enabled"] else db.execute(
        select(ReferralCode).where(ReferralCode.customer_id == customer.id)).scalar_one_or_none()
    rows = db.execute(select(Referral).where(Referral.referrer_id == customer.id)
                      .order_by(Referral.created_at.desc()).limit(100)).scalars().all()
    referees = {c.id: c for c in db.execute(select(Customer).where(
        Customer.id.in_([r.referee_id for r in rows]))).scalars()} if rows else {}
    points = conf["rewardType"] == "points"
    earned_credit = sum(r.referrer_reward for r in rows if r.status == "rewarded" and r.reward_type == "store_credit")
    earned_points = sum(r.referrer_reward for r in rows if r.status == "rewarded" and r.reward_type == "points")
    joined_with = db.execute(select(Referral).where(Referral.referee_id == customer.id)).scalar_one_or_none()
    base = app_settings.STOREFRONT_URL.rstrip("/")
    return {
        "rules": rules(conf),
        "code": code.code if code and not code.disabled else None,
        "codeDisabled": bool(code and code.disabled),
        "shareUrl": f"{base}/account?ref={code.code}" if code and not code.disabled else None,
        "stats": {
            "invited": len(rows),
            "pending": sum(1 for r in rows if r.status in ("pending", "review")),
            "rewarded": sum(1 for r in rows if r.status == "rewarded"),
            "earnedCredit": billing.to_major(earned_credit),
            "earnedPoints": earned_points,
        },
        "referrals": [
            {
                "id": r.id,
                "name": _display_name(referees.get(r.referee_id)),
                "status": r.status,
                "statusLabel": CUSTOMER_STATUS.get(r.status, r.status),
                "joinedAt": r.created_at,
                "rewardedAt": r.rewarded_at,
                "reward": (_reward_text(r.referrer_reward, r.reward_type == "points") if r.referrer_reward else None),
                "expiresAt": r.expires_at if r.status == "pending" else None,
            }
            for r in rows
        ],
        "joinedWith": (
            {"status": joined_with.status, "statusLabel": CUSTOMER_STATUS.get(joined_with.status),
             "reward": _reward_text(joined_with.referee_reward, joined_with.reward_type == "points")
             if joined_with.referee_reward else None,
             "expiresAt": joined_with.expires_at if joined_with.status == "pending" else None}
            if joined_with else None
        ),
        "unit": "points" if points else "store credit",
    }


# ------------------------------------------------------------------- admin


def _admin_row(db: Session, r: Referral, people: dict, orders: dict) -> dict:
    def person(customer_id):
        c = people.get(customer_id)
        return {"id": c.id, "name": c.full_name, "email": c.email} if c else None

    order = orders.get(r.qualifying_order_id)
    points = r.reward_type == "points"
    return {
        "id": r.id, "code": r.code, "status": r.status, "flags": r.flags or [],
        "flagLabels": [_FLAG_LABELS.get(f, f) for f in (r.flags or [])],
        "referrer": person(r.referrer_id), "referee": person(r.referee_id),
        "order": {"id": order.id, "orderNumber": order.order_number, "total": float(order.total),
                  "status": order.status, "paymentStatus": order.payment_status} if order else None,
        "rewardType": r.reward_type,
        "referrerReward": r.referrer_reward if points else billing.to_major(r.referrer_reward),
        "refereeReward": r.referee_reward if points else billing.to_major(r.referee_reward),
        "reversalShortfall": r.reversal_shortfall if points else billing.to_major(r.reversal_shortfall),
        "note": r.note, "createdAt": r.created_at, "qualifiedAt": r.qualified_at, "rewardedAt": r.rewarded_at,
        "reversedAt": r.reversed_at, "expiresAt": r.expires_at,
    }


def admin_list(db: Session, *, status: str = "", q: str = "", page: int = 1, page_size: int = 25) -> tuple:
    conditions = []
    if status in STATUSES:
        conditions.append(Referral.status == status)
    if q and q.strip():
        # Identifiers only (docs/id-lookup.md): the referral code exactly, or a
        # Customer ID on either side. Names and emails match nothing.
        conditions.append(or_(Referral.code == q.strip().upper(),
                              any_id_condition(q, ("customer", Referral.referrer_id, None),
                                               ("customer", Referral.referee_id, None))))
    counts = dict(db.execute(select(Referral.status, func.count()).group_by(Referral.status)).all())
    total = db.execute(select(func.count()).select_from(Referral).where(*conditions)).scalar_one()
    rows = db.execute(select(Referral).where(*conditions).order_by(Referral.created_at.desc(), Referral.id.desc())
                      .offset((page - 1) * page_size).limit(page_size)).scalars().all()
    ids = {r.referrer_id for r in rows} | {r.referee_id for r in rows}
    people = {c.id: c for c in db.execute(select(Customer).where(Customer.id.in_(ids))).scalars()} if ids else {}
    order_ids = [r.qualifying_order_id for r in rows if r.qualifying_order_id]
    orders = {o.id: o for o in db.execute(select(Order).where(Order.id.in_(order_ids))).scalars()} if order_ids else {}
    return ([_admin_row(db, r, people, orders) for r in rows], int(total),
            {s: int(counts.get(s, 0)) for s in STATUSES})


def metrics(db: Session, *, days: int = 30) -> dict:
    since = datetime.utcnow() - timedelta(days=days)
    in_period = [Referral.created_at >= since]
    signups = db.execute(select(func.count()).select_from(Referral).where(*in_period)).scalar_one()
    rewarded = db.execute(select(func.count()).select_from(Referral).where(
        Referral.rewarded_at >= since, Referral.status.in_(("rewarded", "reversed")))).scalar_one()
    credit = db.execute(select(func.coalesce(func.sum(Referral.referrer_reward + Referral.referee_reward), 0)).where(
        Referral.rewarded_at >= since, Referral.status == "rewarded", Referral.reward_type == "store_credit")).scalar_one()
    points = db.execute(select(func.coalesce(func.sum(Referral.referrer_reward + Referral.referee_reward), 0)).where(
        Referral.rewarded_at >= since, Referral.status == "rewarded", Referral.reward_type == "points")).scalar_one()
    revenue = db.execute(select(func.coalesce(func.sum(Order.total), 0)).join(
        Referral, Referral.qualifying_order_id == Order.id).where(
        Referral.rewarded_at >= since, Referral.status == "rewarded")).scalar_one()
    top = db.execute(select(Referral.referrer_id, func.count()).where(
        Referral.status == "rewarded", Referral.rewarded_at >= since)
        .group_by(Referral.referrer_id).order_by(func.count().desc()).limit(5)).all()
    people = {c.id: c for c in db.execute(select(Customer).where(Customer.id.in_([t[0] for t in top]))).scalars()} if top else {}
    return {
        "days": days,
        "signups": int(signups),
        "rewarded": int(rewarded),
        "conversion": round(rewarded / signups * 100, 1) if signups else None,
        "creditPaid": billing.to_major(int(credit)),
        "pointsPaid": int(points),
        "qualifyingRevenue": float(revenue),
        "inReview": int(db.execute(select(func.count()).select_from(Referral).where(Referral.status == "review")).scalar_one()),
        "topReferrers": [{"id": cid, "name": people[cid].full_name if cid in people else cid, "rewarded": int(n)}
                         for cid, n in top],
    }


def decide(db: Session, admin: AdminUser, referral_id: int, action: str, note: str = "") -> dict:
    """approve (review → rewarded) | reject (pending or review → rejected)."""
    referral = db.execute(select(Referral).where(Referral.id == referral_id).with_for_update()).scalar_one_or_none()
    if referral is None:
        raise NotFoundError("No such referral.", error_code="REFERRAL_NOT_FOUND")
    before = audit.snapshot(referral, ("status", "referrer_reward", "referee_reward", "note"))
    note = (note or "").strip()
    if action == "approve":
        if referral.status != "review":
            raise ConflictError("Only a referral held for review can be approved.", error_code="REFERRAL_STATE")
        order = db.get(Order, referral.qualifying_order_id) if referral.qualifying_order_id else None
        if order is None or order.status in ("cancelled", "returned") or order.payment_status != "paid":
            raise ConflictError("Its order didn't go ahead, so there's nothing to reward.", error_code="REFERRAL_STATE")
        _reward(db, referral, settings(db), admin=admin)
        if note:
            referral.note = note[:300]
    elif action == "reject":
        if referral.status not in ("pending", "review"):
            raise ConflictError("Only a pending or held referral can be rejected.", error_code="REFERRAL_STATE")
        if len(note) < 5:
            raise ValidationError("Say why (at least 5 characters).", error_code="REASON_REQUIRED")
        referral.status, referral.note, referral.decided_by = "rejected", note[:300], admin.id
        referral.updated_at = datetime.utcnow()
    else:
        raise ValidationError("Unknown action.", error_code="INVALID_ACTION")
    audit.record(db, f"referral.{action}", resource_type="referrals", resource_id=referral.id, actor=admin,
                 summary=f"{action.capitalize()}d referral {referral.id} ({referral.code})",
                 changes=audit.diff(before, audit.snapshot(referral, ("status", "referrer_reward", "referee_reward", "note"))))
    db.commit()
    rows, _, _ = admin_list(db, q=referral.code)
    return next((r for r in rows if r["id"] == referral.id), {})


def set_code_disabled(db: Session, admin: AdminUser, customer_id: str, disabled: bool) -> dict:
    row = db.execute(select(ReferralCode).where(ReferralCode.customer_id == customer_id)).scalar_one_or_none()
    if row is None:
        raise NotFoundError("That customer has no referral code yet.", error_code="REFERRAL_CODE_NOT_FOUND")
    row.disabled = disabled
    audit.record(db, "referral.code_" + ("disable" if disabled else "enable"), resource_type="referrals",
                 resource_id=customer_id, actor=admin,
                 summary=f"{'Switched off' if disabled else 'Switched on'} referral code {row.code}",
                 changes={"disabled": {"from": not disabled, "to": disabled}})
    db.commit()
    return {"customerId": customer_id, "code": row.code, "disabled": row.disabled}


# ------------------------------------------------------------- messages


def _tell(db: Session, customer: Customer, title: str, message: str, *, reference: str,
          href: str = "/account/referrals") -> None:
    from app.services import email as email_service

    if customer.status != "active":
        return
    from app.services.email import templates

    esc = html_lib.escape
    base = app_settings.STOREFRONT_URL.rstrip('/')
    link = f"{base}{href}"
    # Their own code to pass on — only one that already exists (looking never makes one).
    try:
        own = db.execute(select(ReferralCode).where(ReferralCode.customer_id == customer.id)).scalar_one_or_none()
    except Exception:  # noqa: BLE001 — the code is a nicety; the message still goes
        own = None
    body = ""
    if own is not None and not own.disabled:
        body += templates.code_box(own.code, label="Your referral code",
                                   caption=f"Share it, or send friends to {base}/account?ref={own.code}", tone="celebrate")
        body += templates.steps(["Share your code with friends and family.",
                                 "They sign up with it and enjoy a welcome reward.",
                                 "You're rewarded when their first order qualifies."],
                                title="Invite more friends", tone="celebrate")
    joined = "joined" in title.lower()
    html = email_service.layout(title, f"Hello {esc(customer.first_name or 'there')}, {esc(email_service.after_greeting(message))}", body,
                                cta=("See your referrals" if href == "/account/referrals" else "Open your account", link),
                                tone="celebrate", icon="people" if joined else "gift",
                                eyebrow="Referrals" if href == "/account/referrals" else "Welcome reward",
                                secondary=[("Shop now", f"{base}/shop")])
    email_service.notify(db, EMAIL_TYPE, to=customer.email, customer_id=customer.id, subject=title, html=html,
                         text=f"{title}. {message} {link}", reference=reference[:40],
                         inbox={"title": title, "body": message, "href": href})


# ---------------------------------------------------------------- the loop


def _sweep_once() -> None:
    from app.core.database import SessionLocal

    with SessionLocal() as db:
        try:
            expire_due(db)
        except Exception:
            db.rollback()
            raise


async def run_forever() -> None:
    import asyncio

    from app.services import jobs

    logger.info("Referral expiry checked every %ss.", INTERVAL_SECONDS)
    while True:
        try:
            await asyncio.to_thread(jobs.tracked("referrals", INTERVAL_SECONDS, _sweep_once))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Referral sweep failed; retrying next interval.")
        await asyncio.sleep(INTERVAL_SECONDS)
