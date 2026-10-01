"""
Reward points.

See `models.loyalty` for the ledger-with-lots design. In short:

- **Earning** happens when an order is delivered, never when it's placed: a
  placed order can still be cancelled. The points are *pending* until the
  return window has passed (`pendingDays`, by default the store's return
  window), then become spendable, and expire `expiryMonths` after that.
- **What earns** is the price of the goods — never shipping; tax and the part
  paid with gift cards, store credit or points are left out unless the store
  says otherwise; products and categories can be excluded; members can earn
  at a multiple.
- **Spending** happens at checkout as a payment towards the order, at the
  configured value, up to a share of the order. Points come from the lots
  that expire first, under a lock on the customer's account.
- **Taking back**: a cancelled order returns the points it spent (to the lots
  they came from). A refunded or returned order takes back the points it
  earned in proportion — from that order's own lot first, then from other
  spendable points, and as debt if they've been spent, which is repaid from
  the next points to become spendable. A customer never keeps rewards for a
  purchase they returned.

Every change is a `LoyaltyTransaction`; anything that must happen once
(earning per order, redeeming per order, a refund's reversal) carries an
idempotency key the database won't accept twice.
"""

from __future__ import annotations

import copy
import html as html_lib
import logging
import math
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings as app_settings
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import (
    AdminUser,
    Customer,
    Invoice,
    LoyaltyAccount,
    LoyaltyLot,
    LoyaltyRedemption,
    LoyaltyTransaction,
    Order,
    Product,
    SettingDocument,
)

logger = logging.getLogger(__name__)
EMAIL_TYPE = "loyalty"

DEFAULTS = {
    "enabled": True,
    # Points earned per ₹100 of eligible spend.
    "pointsPer100": 5,
    # Spending: `redeemPoints` points are worth ₹`redeemValue`.
    "redeemPoints": 100,
    "redeemValue": 50,
    "minRedeemPoints": 100,
    # 0: no cap.
    "maxPointsPerOrder": 0,
    # The most of an order's total that points can pay.
    "maxOrderPercent": 50,
    # 0: points don't expire.
    "expiryMonths": 12,
    # Days after delivery before earned points can be spent. None: the store's
    # return window (plus a member's extra days).
    "pendingDays": None,
    "expiryWarningDays": 30,
    "excludeTax": True,
    "excludeTenderPaid": True,
    "excludeDiscountedItems": False,
    # Category ids/slugs that earn (empty: all), and ones that never do.
    "eligibleCategories": [],
    "excludedCategories": [],
    "excludedProducts": [],
    # Members earn at this multiple; `planMultipliers` overrides it per plan id.
    "memberMultiplier": 1.0,
    "planMultipliers": {},
    "allowWithCoupons": True,
    "allowWithGiftCards": True,
    "allowWithStoreCredit": True,
}

KIND_LABELS = {
    "earned": "Earned", "redeemed": "Spent on an order", "restored": "Returned from a cancelled order",
    "reversed": "Taken back (refund or return)", "expired": "Expired", "manual_credit": "Added by our team",
    "manual_debit": "Removed by our team", "adjustment": "Adjustment",
}


# ---------------------------------------------------------------- settings


def settings(db: Session) -> dict:
    stored = (db.get(SettingDocument, "loyalty") or SettingDocument(value={})).value or {}
    merged = copy.deepcopy(DEFAULTS)
    merged.update({k: v for k, v in stored.items() if k in DEFAULTS})
    return merged


def _num(value, label: str, *, low: float, high: float, whole: bool = True):
    if isinstance(value, bool):
        raise ValidationError(f"{label} must be a number.", error_code="INVALID_SETTING")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValidationError(f"{label} must be a number.", error_code="INVALID_SETTING") from None
    if whole and number != int(number):
        raise ValidationError(f"{label} must be a whole number.", error_code="INVALID_SETTING")
    if not low <= number <= high:
        raise ValidationError(f"{label} must be between {low:g} and {high:g}.", error_code="INVALID_SETTING")
    return int(number) if whole else round(number, 2)


def save_settings(db: Session, payload: dict) -> dict:
    out = settings(db)
    for key in ("enabled", "excludeTax", "excludeTenderPaid", "excludeDiscountedItems", "allowWithCoupons",
                "allowWithGiftCards", "allowWithStoreCredit"):
        if key in payload:
            out[key] = bool(payload[key])
    ranges = {
        "pointsPer100": ("Points per ₹100", 0, 1000), "redeemPoints": ("Points per unit of value", 1, 100000),
        "redeemValue": ("Value in rupees", 1, 100000), "minRedeemPoints": ("Minimum points to spend", 0, 1000000),
        "maxPointsPerOrder": ("Most points per order", 0, 10000000), "maxOrderPercent": ("Share of an order", 1, 100),
        "expiryMonths": ("Expiry", 0, 120), "expiryWarningDays": ("Expiry warning", 0, 90),
    }
    for key, (label, low, high) in ranges.items():
        if key in payload:
            out[key] = _num(payload[key], label, low=low, high=high)
    if "pendingDays" in payload:
        out["pendingDays"] = None if payload["pendingDays"] in (None, "") else _num(payload["pendingDays"], "Pending days", low=0, high=365)
    if "memberMultiplier" in payload:
        out["memberMultiplier"] = _num(payload["memberMultiplier"], "Member multiplier", low=1, high=10, whole=False)
    if "planMultipliers" in payload:
        plans = payload["planMultipliers"] or {}
        if not isinstance(plans, dict) or len(plans) > 50:
            raise ValidationError("Plan multipliers must be a list of plans.", error_code="INVALID_SETTING")
        out["planMultipliers"] = {str(k)[:20]: _num(v, "A plan multiplier", low=1, high=10, whole=False) for k, v in plans.items()}
    for key in ("eligibleCategories", "excludedCategories", "excludedProducts"):
        if key in payload:
            values = payload[key] or []
            if not isinstance(values, list) or len(values) > 500:
                raise ValidationError("Lists can hold up to 500 entries.", error_code="INVALID_SETTING")
            out[key] = sorted({str(v).strip()[:80] for v in values if str(v).strip()})
    now = datetime.utcnow()
    row = db.get(SettingDocument, "loyalty")
    if row is None:
        db.add(SettingDocument(key="loyalty", value=out, created_at=now, updated_at=now))
    else:
        row.value = out
        row.updated_at = now
    db.commit()
    return out


def value_of(conf: dict, points: int) -> int:
    """Paise `points` are worth, rounded down."""
    return (max(0, points) * int(conf["redeemValue"]) * 100) // max(1, int(conf["redeemPoints"]))


def points_for(conf: dict, paise: int) -> int:
    """The most points whose value doesn't exceed `paise`."""
    return (max(0, paise) * int(conf["redeemPoints"])) // (int(conf["redeemValue"]) * 100)


# ----------------------------------------------------------------- account


def account(db: Session, customer_id: str, *, lock: bool = False) -> LoyaltyAccount:
    query = select(LoyaltyAccount).where(LoyaltyAccount.customer_id == customer_id)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    row = db.execute(query).scalar_one_or_none()
    if row is not None:
        return row
    now = datetime.utcnow()
    try:
        with db.begin_nested():
            db.add(LoyaltyAccount(customer_id=customer_id, debt=0, lifetime_earned=0, lifetime_redeemed=0,
                                  lifetime_expired=0, lifetime_reversed=0, created_at=now, updated_at=now))
    except IntegrityError:
        pass
    return db.execute(query).scalar_one()


def _live_lots(customer_id: str, now: datetime):
    return and_(LoyaltyLot.customer_id == customer_id, LoyaltyLot.released.is_(True), LoyaltyLot.remaining > 0,
                or_(LoyaltyLot.expires_at.is_(None), LoyaltyLot.expires_at > now))


def spendable(db: Session, customer_id: str, now: Optional[datetime] = None) -> int:
    now = now or datetime.utcnow()
    lots = db.execute(select(func.coalesce(func.sum(LoyaltyLot.remaining), 0)).where(_live_lots(customer_id, now))).scalar_one()
    debt = db.execute(select(LoyaltyAccount.debt).where(LoyaltyAccount.customer_id == customer_id)).scalar_one_or_none() or 0
    return int(lots) - int(debt)


def pending(db: Session, customer_id: str) -> int:
    return int(db.execute(select(func.coalesce(func.sum(LoyaltyLot.remaining), 0)).where(
        LoyaltyLot.customer_id == customer_id, LoyaltyLot.released.is_(False))).scalar_one())


def _txn(db: Session, customer_id: str, kind: str, points: int, *, order_id: Optional[str] = None,
         refund_id: Optional[str] = None, reason: str = "", admin: Optional[AdminUser] = None,
         key: Optional[str] = None, available_at: Optional[datetime] = None,
         expires_at: Optional[datetime] = None) -> LoyaltyTransaction:
    db.flush()
    entry = LoyaltyTransaction(
        customer_id=customer_id, kind=kind, points=points, balance_after=spendable(db, customer_id),
        order_id=order_id, refund_id=refund_id, reason=(reason or "")[:300], available_at=available_at,
        expires_at=expires_at, admin_id=admin.id if admin else None, admin_name=(admin.name if admin else "")[:120],
        idempotency_key=key, created_at=datetime.utcnow(),
    )
    db.add(entry)
    db.flush()
    return entry


def _seen(db: Session, key: str) -> bool:
    return db.execute(select(LoyaltyTransaction.id).where(LoyaltyTransaction.idempotency_key == key)).first() is not None


def _take(db: Session, customer_id: str, points: int, now: datetime, *, order_id: Optional[str] = None,
          record_for: Optional[str] = None, prefer_order: Optional[str] = None, include_pending: bool = False) -> int:
    """
    Take up to `points` from lots, soonest-expiring first (an order's own lot
    first when `prefer_order` is given). Returns how many were taken. When
    `record_for` names an order, which lots were used is recorded for an exact
    return later.
    """
    remaining = points
    conditions = [LoyaltyLot.customer_id == customer_id, LoyaltyLot.remaining > 0,
                  or_(LoyaltyLot.expires_at.is_(None), LoyaltyLot.expires_at > now)]
    if not include_pending:
        conditions.append(LoyaltyLot.released.is_(True))
    order_first = (LoyaltyLot.order_id == prefer_order).desc() if prefer_order else LoyaltyLot.id.is_(None)
    lots = db.execute(select(LoyaltyLot).where(*conditions)
                      .order_by(order_first, LoyaltyLot.expires_at.is_(None), LoyaltyLot.expires_at, LoyaltyLot.id)
                      .with_for_update()).scalars().all()
    for lot in lots:
        if remaining <= 0:
            break
        used = min(lot.remaining, remaining)
        lot.remaining -= used
        remaining -= used
        if record_for:
            db.add(LoyaltyRedemption(order_id=record_for, lot_id=lot.id, points=used, restored=0))
    return points - remaining


# ---------------------------------------------------------------- reading


def summary(db: Session, customer_id: str) -> dict:
    conf = settings(db)
    now = datetime.utcnow()
    row = db.execute(select(LoyaltyAccount).where(LoyaltyAccount.customer_id == customer_id)).scalar_one_or_none()
    available = spendable(db, customer_id, now)
    soon = db.execute(select(LoyaltyLot.expires_at, func.sum(LoyaltyLot.remaining)).where(
        _live_lots(customer_id, now), LoyaltyLot.expires_at.is_not(None))
        .group_by(LoyaltyLot.expires_at).order_by(LoyaltyLot.expires_at).limit(1)).first()
    next_release = db.execute(select(func.min(LoyaltyLot.available_at)).where(
        LoyaltyLot.customer_id == customer_id, LoyaltyLot.released.is_(False), LoyaltyLot.remaining > 0)).scalar_one()
    return {
        "enabled": bool(conf["enabled"]),
        "available": max(0, available),
        "debt": int(row.debt) if row else 0,
        "availableValue": value_of(conf, max(0, available)) / 100,
        "pending": pending(db, customer_id),
        "nextReleaseAt": next_release,
        "lifetimeEarned": row.lifetime_earned if row else 0,
        "lifetimeRedeemed": row.lifetime_redeemed if row else 0,
        "lifetimeExpired": row.lifetime_expired if row else 0,
        "lifetimeReversed": row.lifetime_reversed if row else 0,
        "nextExpiry": {"at": soon[0], "points": int(soon[1])} if soon else None,
        "rules": rules(conf),
    }


def rules(conf: dict) -> dict:
    return {
        "pointsPer100": conf["pointsPer100"], "redeemPoints": conf["redeemPoints"], "redeemValue": conf["redeemValue"],
        "minRedeemPoints": conf["minRedeemPoints"], "maxPointsPerOrder": conf["maxPointsPerOrder"],
        "maxOrderPercent": conf["maxOrderPercent"], "expiryMonths": conf["expiryMonths"],
        "pendingDays": conf["pendingDays"], "excludeTax": conf["excludeTax"],
        "excludeTenderPaid": conf["excludeTenderPaid"], "excludeDiscountedItems": conf["excludeDiscountedItems"],
        "memberMultiplier": conf["memberMultiplier"], "allowWithCoupons": conf["allowWithCoupons"],
        "allowWithGiftCards": conf["allowWithGiftCards"], "allowWithStoreCredit": conf["allowWithStoreCredit"],
    }


def txn_view(entry: LoyaltyTransaction) -> dict:
    return {
        "id": entry.id, "kind": entry.kind, "label": KIND_LABELS.get(entry.kind, entry.kind), "points": entry.points,
        "balanceAfter": entry.balance_after, "orderId": entry.order_id, "reason": entry.reason,
        "availableAt": entry.available_at, "expiresAt": entry.expires_at, "createdAt": entry.created_at,
        "by": entry.admin_name or None,
    }


def history(db: Session, customer_id: str, *, page: int = 1, page_size: int = 25) -> tuple:
    total = db.execute(select(func.count()).select_from(LoyaltyTransaction).where(
        LoyaltyTransaction.customer_id == customer_id)).scalar_one()
    rows = db.execute(select(LoyaltyTransaction).where(LoyaltyTransaction.customer_id == customer_id)
                      .order_by(LoyaltyTransaction.id.desc()).offset((max(1, page) - 1) * page_size)
                      .limit(page_size)).scalars().all()
    return [txn_view(r) for r in rows], total


# --------------------------------------------------------------- checkout


def redemption_limits(db: Session, customer_id: str, grand_total: int, *, coupon: bool, gift_cards: bool,
                      store_credit: bool) -> dict:
    """What this order can take in points, and why not when it can't."""
    conf = settings(db)
    available = spendable(db, customer_id)
    out = {"enabled": bool(conf["enabled"]), "available": max(0, available), "maxPoints": 0, "reason": "",
           "pointValuePaise": value_of(conf, int(conf["redeemPoints"])) / int(conf["redeemPoints"]),
           "minRedeemPoints": conf["minRedeemPoints"], "redeemPoints": conf["redeemPoints"],
           "redeemValue": conf["redeemValue"]}
    if not conf["enabled"]:
        out["reason"] = "Reward points aren't available right now."
    elif available <= 0:
        out["reason"] = "You don't have points to spend yet." if available == 0 else \
            "Points from a returned order are being taken back first."
    elif available < conf["minRedeemPoints"]:
        out["reason"] = f"You can spend points once you have {conf['minRedeemPoints']:,}."
    elif coupon and not conf["allowWithCoupons"]:
        out["reason"] = "Points can't be used together with a coupon."
    elif gift_cards and not conf["allowWithGiftCards"]:
        out["reason"] = "Points can't be used together with a gift card."
    elif store_credit and not conf["allowWithStoreCredit"]:
        out["reason"] = "Points can't be used together with store credit."
    if out["reason"]:
        return out
    cap_value = grand_total * int(conf["maxOrderPercent"]) // 100
    most = min(available, points_for(conf, cap_value))
    if conf["maxPointsPerOrder"]:
        most = min(most, int(conf["maxPointsPerOrder"]))
    out["maxPoints"] = most if most >= conf["minRedeemPoints"] else 0
    if not out["maxPoints"]:
        out["reason"] = "This order is too small to spend points on."
    return out


def redeem(db: Session, customer_id: str, points: int, *, order_id: str) -> int:
    """Spend points on an order, under the account lock. Returns their value in paise."""
    conf = settings(db)
    key = f"redeem:{order_id}"
    if _seen(db, key):
        raise ConflictError("Points were already used on this order.", error_code="POINTS_ALREADY_USED")
    row = account(db, customer_id, lock=True)
    now = datetime.utcnow()
    if points <= 0:
        raise ValidationError("Choose how many points to use.", error_code="INVALID_POINTS")
    if spendable(db, customer_id, now) < points:
        raise ConflictError("You don't have that many points to spend.", error_code="INSUFFICIENT_POINTS")
    taken = _take(db, customer_id, points, now, record_for=order_id)
    if taken != points:
        raise ConflictError("You don't have that many points to spend.", error_code="INSUFFICIENT_POINTS")
    row.lifetime_redeemed += points
    row.updated_at = now
    _txn(db, customer_id, "redeemed", -points, order_id=order_id, key=key, reason="Spent at checkout")
    return value_of(conf, points)


def restore(db: Session, order_id: str, points: int, *, key: str, refund_id: Optional[str] = None,
            reason: str = "") -> int:
    """
    Give back up to `points` of what an order spent, into the lots they came
    from (with their original expiry). Once per key. Returns how many went back.
    """
    if points <= 0 or _seen(db, key):
        return 0
    allocations = db.execute(select(LoyaltyRedemption).where(LoyaltyRedemption.order_id == order_id)
                             .order_by(LoyaltyRedemption.id.desc()).with_for_update()).scalars().all()
    if not allocations:
        return 0
    customer_id = db.get(LoyaltyLot, allocations[0].lot_id).customer_id
    row = account(db, customer_id, lock=True)
    left = points
    for allocation in allocations:
        room = allocation.points - allocation.restored
        if left <= 0 or room <= 0:
            continue
        back = min(room, left)
        lot = db.execute(select(LoyaltyLot).where(LoyaltyLot.id == allocation.lot_id).with_for_update()).scalar_one()
        lot.remaining += back
        allocation.restored += back
        left -= back
    returned = points - left
    if returned:
        row.lifetime_redeemed = max(0, row.lifetime_redeemed - returned)
        row.updated_at = datetime.utcnow()
        _txn(db, customer_id, "restored", returned, order_id=order_id, refund_id=refund_id, key=key,
             reason=reason or "Returned from an order")
    return returned


# ----------------------------------------------------------------- earning


def _pending_days(db: Session, conf: dict, order: Order) -> int:
    if conf["pendingDays"] is not None:
        return int(conf["pendingDays"])
    from app.services import returns

    try:
        return returns.window_days(db) + returns._member_extra_days(db, order)
    except Exception:  # noqa: BLE001 — the return window is a default, not a dependency
        return 15


def earnable(db: Session, order: Order, invoice: Optional[Invoice] = None, conf: Optional[dict] = None) -> int:
    """Points this order earns under today's rules."""
    conf = conf or settings(db)
    if not conf["enabled"] or not conf["pointsPer100"]:
        return 0
    invoice = invoice or db.execute(select(Invoice).where(Invoice.order_id == order.id)).scalar_one_or_none()
    if invoice is None or invoice.grand_total <= 0:
        return 0
    eligible = set(conf["eligibleCategories"])
    excluded_categories = set(conf["excludedCategories"])
    excluded_products = set(conf["excludedProducts"])
    base = 0
    for line in invoice.items:
        product = db.get(Product, line.product_id)
        category = {product.category_id, product.category.slug if product and product.category else None} if product else set()
        if line.product_id in excluded_products or category & excluded_categories:
            continue
        if eligible and not category & eligible:
            continue
        if conf["excludeDiscountedItems"] and (line.discount > 0 or (product is not None and product.discount > 0)):
            continue
        base += line.taxable_amount if conf["excludeTax"] else line.line_total
    if conf["excludeTenderPaid"]:
        tenders = invoice.gift_card_amount + invoice.store_credit_amount + invoice.points_amount
        base = base * max(0, invoice.grand_total - tenders) // invoice.grand_total
    points = base * int(conf["pointsPer100"]) // 10000
    multiplier = 1.0
    if order.membership_id:
        from app.models import CustomerMembership

        membership = db.get(CustomerMembership, order.membership_id)
        plan = membership.plan_id if membership else None
        multiplier = float(conf["planMultipliers"].get(plan, conf["memberMultiplier"])) if plan else float(conf["memberMultiplier"])
    return int(math.floor(points * multiplier))


def award_for_order(db: Session, order: Order) -> int:
    """Delivered: the order earns its points, pending until it can't be returned. Once."""
    key = f"earn:{order.id}"
    if _seen(db, key):
        return 0
    conf = settings(db)
    points = earnable(db, order, conf=conf)
    if points <= 0:
        return 0
    now = datetime.utcnow().replace(microsecond=0)
    row = account(db, order.customer_id, lock=True)
    available_at = now + timedelta(days=_pending_days(db, conf, order))
    expires_at = None
    if conf["expiryMonths"]:
        from app.services.membership import add_months

        expires_at = add_months(available_at, int(conf["expiryMonths"]))
    entry = _txn(db, order.customer_id, "earned", points, order_id=order.id, key=key,
                 reason=f"Order {order.order_number}", available_at=available_at, expires_at=expires_at)
    db.add(LoyaltyLot(customer_id=order.customer_id, transaction_id=entry.id, order_id=order.id, points=points,
                      remaining=points, available_at=available_at, released=available_at <= now,
                      expires_at=expires_at, created_at=now))
    row.lifetime_earned += points
    row.updated_at = now
    _email_earned(db, order, points, available_at)
    return points


def reverse_for_order(db: Session, order: Order, *, fraction: float, refund_id: Optional[str] = None,
                      reason: str = "") -> int:
    """
    Take back the share of the points this order earned that `fraction` of it
    being refunded or returned stands for (1.0: all of it). Cumulative, so
    several partial refunds take back exactly the whole at the end.
    """
    earned = db.execute(select(LoyaltyTransaction.points).where(
        LoyaltyTransaction.idempotency_key == f"earn:{order.id}")).scalar_one_or_none()
    if not earned:
        return 0
    key = f"reverse:{order.id}:{refund_id or 'all'}"
    if _seen(db, key):
        return 0
    fraction = max(0.0, min(1.0, fraction))
    already = -int(db.execute(select(func.coalesce(func.sum(LoyaltyTransaction.points), 0)).where(
        LoyaltyTransaction.order_id == order.id, LoyaltyTransaction.kind == "reversed")).scalar_one())
    target = min(earned, int(round(earned * fraction)))
    owed = target - already
    if owed <= 0:
        return 0
    now = datetime.utcnow()
    row = account(db, order.customer_id, lock=True)
    # The order's own points first, spendable yet or not; then other spendable
    # points; whatever has already been spent becomes debt.
    left = owed
    own = db.execute(select(LoyaltyLot).where(LoyaltyLot.order_id == order.id, LoyaltyLot.remaining > 0)
                     .order_by(LoyaltyLot.id).with_for_update()).scalars().all()
    for lot in own:
        if left <= 0:
            break
        used = min(lot.remaining, left)
        lot.remaining -= used
        left -= used
    if left > 0:
        left -= _take(db, order.customer_id, left, now)
    if left > 0:
        row.debt += left
    row.lifetime_reversed += owed
    row.updated_at = now
    _txn(db, order.customer_id, "reversed", -owed, order_id=order.id, refund_id=refund_id, key=key,
         reason=reason or f"Order {order.order_number} refunded or returned")
    _notify(db, order.customer_id, f"{owed:,} reward points taken back",
            f"Order {order.order_number} was refunded or returned, so the {owed:,} points it earned have been taken "
            "back" + (", partly from points already spent — they'll come out of your next points." if left > 0 else "."),
            reference=f"loyalty-rev-{order.order_number}")
    return owed


# ------------------------------------------------------------------ sweeps


def release_due(db: Session, now: Optional[datetime] = None) -> int:
    """Pending lots whose time has come become spendable; any debt is paid from them first."""
    now = now or datetime.utcnow()
    lots = db.execute(select(LoyaltyLot.id).where(LoyaltyLot.released.is_(False), LoyaltyLot.available_at <= now)
                      .limit(1000)).scalars().all()
    for lot_id in lots:
        lot = db.execute(select(LoyaltyLot).where(LoyaltyLot.id == lot_id).with_for_update()).scalar_one()
        if lot.released:
            continue
        row = account(db, lot.customer_id, lock=True)
        if row.debt > 0 and lot.remaining > 0:
            paid = min(row.debt, lot.remaining)
            lot.remaining -= paid
            row.debt -= paid
        lot.released = True
        if lot.remaining > 0 and lot.order_id:
            _notify(db, lot.customer_id, f"{lot.remaining:,} reward points are ready to spend",
                    "Points from your delivered order can now be used at checkout.",
                    reference=f"loyalty-ready-{lot.id}")
        db.commit()
    return len(lots)


def expire_due(db: Session, now: Optional[datetime] = None) -> int:
    now = now or datetime.utcnow()
    lots = db.execute(select(LoyaltyLot.id).where(LoyaltyLot.remaining > 0, LoyaltyLot.expires_at.is_not(None),
                                                  LoyaltyLot.expires_at <= now).limit(1000)).scalars().all()
    expired = 0
    for lot_id in lots:
        lot = db.execute(select(LoyaltyLot).where(LoyaltyLot.id == lot_id).with_for_update()).scalar_one()
        if lot.remaining <= 0:
            continue
        row = account(db, lot.customer_id, lock=True)
        points = lot.remaining
        lot.remaining = 0
        row.lifetime_expired += points
        row.updated_at = now
        _txn(db, lot.customer_id, "expired", -points, order_id=lot.order_id, reason="Points reached their expiry date",
             key=f"expire:{lot.id}:{points}:{lot.expires_at:%Y%m%d%H%M%S}")
        db.commit()
        expired += points
    return expired


def warn_expiring(db: Session, now: Optional[datetime] = None) -> int:
    """One email per customer about points expiring within the warning period."""
    now = now or datetime.utcnow()
    conf = settings(db)
    days = int(conf["expiryWarningDays"])
    if not days or not conf["enabled"]:
        return 0
    horizon = now + timedelta(days=days)
    lots = db.execute(select(LoyaltyLot).where(
        LoyaltyLot.released.is_(True), LoyaltyLot.remaining > 0, LoyaltyLot.expires_at.is_not(None),
        LoyaltyLot.expires_at > now, LoyaltyLot.expires_at <= horizon, LoyaltyLot.expiry_warned_at.is_(None),
    ).limit(2000)).scalars().all()
    by_customer: dict = {}
    for lot in lots:
        by_customer.setdefault(lot.customer_id, []).append(lot)
    for customer_id, group in by_customer.items():
        customer = db.get(Customer, customer_id)
        points = sum(l.remaining for l in group)
        first = min(l.expires_at for l in group)
        if customer is not None and customer.status == "active" and spendable(db, customer_id, now) > 0:
            _email_expiring(db, customer, points, first)
        for lot in group:
            lot.expiry_warned_at = now
        db.commit()
    return len(by_customer)


# ------------------------------------------------------------------- emails


def _notify(db: Session, customer_id: str, title: str, message: str, *, reference: str) -> None:
    """A short points update, by email and in the customer's account."""
    from app.services import email as email_service

    customer = db.get(Customer, customer_id)
    if customer is None or customer.status != "active":
        return
    esc = html_lib.escape
    link = f"{app_settings.STOREFRONT_URL.rstrip('/')}/account/rewards"
    html = email_service.layout(title, f"Hello {esc(customer.first_name or 'there')}, {esc(message)}",
                                cta=("See your points", link))
    email_service.notify(db, EMAIL_TYPE, to=customer.email, customer_id=customer.id, subject=title, html=html,
                         text=f"{title}. {message} {link}", reference=reference[:40])


def _email_earned(db: Session, order: Order, points: int, available_at: datetime) -> None:
    from app.services import email as email_service

    customer = db.get(Customer, order.customer_id)
    if customer is None:
        return
    esc = html_lib.escape
    link = f"{app_settings.STOREFRONT_URL.rstrip('/')}/account/rewards"
    intro = (f"Hello {esc(customer.first_name or 'there')}, your order {esc(order.order_number)} earned "
             f"<strong>{points:,} reward points</strong>. They'll be ready to spend from "
             f"{available_at:%d %b %Y}, once the return window has closed.")
    html = email_service.layout("You've earned reward points", intro, cta=("See your points", link))
    email_service.notify(db, EMAIL_TYPE, to=customer.email, customer_id=customer.id,
                         subject=f"You earned {points:,} points on order {order.order_number}", html=html,
                         text=f"You earned {points:,} points on order {order.order_number}. {link}",
                         reference=f"loyalty-{order.order_number}"[:40])


def _email_expiring(db: Session, customer: Customer, points: int, at: datetime) -> None:
    from app.services import email as email_service

    esc = html_lib.escape
    conf = settings(db)
    link = f"{app_settings.STOREFRONT_URL.rstrip('/')}/account/rewards"
    worth = value_of(conf, points) / 100
    intro = (f"Hello {esc(customer.first_name or 'there')}, <strong>{points:,} of your reward points</strong> "
             f"(worth ₹{worth:,.2f}) expire on {at:%d %b %Y}. Use them at checkout before then.")
    html = email_service.layout("Your points are about to expire", intro, cta=("Shop now", link))
    email_service.notify(db, EMAIL_TYPE, to=customer.email, customer_id=customer.id,
                         subject=f"{points:,} reward points expire on {at:%d %b}", html=html,
                         text=f"{points:,} points expire on {at:%d %b %Y}. {link}", reference=f"loyalty-expiry-{customer.id}")


# ------------------------------------------------------------------- admin


def admin_adjust(db: Session, admin: AdminUser, customer_id: str, *, kind: str, points, reason: str,
                 request_key: str = "") -> LoyaltyTransaction:
    customer = db.get(Customer, customer_id)
    if customer is None:
        raise NotFoundError("No such customer.", error_code="CUSTOMER_NOT_FOUND")
    if kind not in ("manual_credit", "manual_debit"):
        raise ValidationError("Add or remove points.", error_code="INVALID_KIND")
    amount = _num(points, "Points", low=1, high=1000000)
    reason = (reason or "").strip()
    if len(reason) < 5:
        raise ValidationError("Give a reason (at least 5 characters).", error_code="REASON_REQUIRED")
    key = f"admin:{admin.id}:{request_key[:40]}" if request_key else None
    if key and _seen(db, key):
        return db.execute(select(LoyaltyTransaction).where(LoyaltyTransaction.idempotency_key == key)).scalar_one()
    conf = settings(db)
    now = datetime.utcnow().replace(microsecond=0)
    row = account(db, customer.id, lock=True)
    if kind == "manual_credit":
        expires_at = None
        if conf["expiryMonths"]:
            from app.services.membership import add_months

            expires_at = add_months(now, int(conf["expiryMonths"]))
        entry = _txn(db, customer.id, kind, amount, reason=reason, admin=admin, key=key, available_at=now,
                     expires_at=expires_at)
        lot = LoyaltyLot(customer_id=customer.id, transaction_id=entry.id, order_id=None, points=amount,
                         remaining=amount, available_at=now, released=True, expires_at=expires_at, created_at=now)
        db.add(lot)
        # Debt is paid first, as with any points that become spendable.
        if row.debt > 0:
            paid = min(row.debt, amount)
            lot.remaining -= paid
            row.debt -= paid
        db.flush()
        entry.balance_after = spendable(db, customer.id, now)
        row.lifetime_earned += amount
    else:
        if spendable(db, customer.id, now) < amount:
            raise ConflictError("The customer doesn't have that many spendable points.", error_code="INSUFFICIENT_POINTS")
        _take(db, customer.id, amount, now)
        entry = _txn(db, customer.id, kind, -amount, reason=reason, admin=admin, key=key)
    row.updated_at = now
    _notify(db, customer.id,
            f"{amount:,} reward points {'added to' if kind == 'manual_credit' else 'removed from'} your account",
            f"Note from our team: {reason}", reference=f"loyalty-adj-{customer.id}")
    db.commit()
    db.refresh(entry)
    return entry


def admin_metrics(db: Session, *, days: int = 30) -> dict:
    now = datetime.utcnow()
    since = now - timedelta(days=days)
    conf = settings(db)
    live = db.execute(select(func.coalesce(func.sum(LoyaltyLot.remaining), 0)).where(
        LoyaltyLot.released.is_(True), LoyaltyLot.remaining > 0,
        or_(LoyaltyLot.expires_at.is_(None), LoyaltyLot.expires_at > now))).scalar_one()
    debt = db.execute(select(func.coalesce(func.sum(LoyaltyAccount.debt), 0))).scalar_one()
    waiting = db.execute(select(func.coalesce(func.sum(LoyaltyLot.remaining), 0)).where(LoyaltyLot.released.is_(False))).scalar_one()
    by_kind = dict(db.execute(select(LoyaltyTransaction.kind, func.coalesce(func.sum(LoyaltyTransaction.points), 0))
                              .where(LoyaltyTransaction.created_at >= since).group_by(LoyaltyTransaction.kind)).all())
    members = db.execute(select(func.count(func.distinct(LoyaltyLot.customer_id))).where(LoyaltyLot.remaining > 0)).scalar_one()
    soon = db.execute(select(func.coalesce(func.sum(LoyaltyLot.remaining), 0)).where(
        LoyaltyLot.released.is_(True), LoyaltyLot.remaining > 0, LoyaltyLot.expires_at.is_not(None),
        LoyaltyLot.expires_at > now, LoyaltyLot.expires_at <= now + timedelta(days=30))).scalar_one()
    outstanding = int(live) - int(debt)
    return {
        "outstanding": outstanding, "outstandingValue": value_of(conf, max(0, outstanding)) / 100,
        "pending": int(waiting), "debt": int(debt), "customersWithPoints": int(members),
        "expiringIn30Days": int(soon),
        "period": {k: int(v) for k, v in by_kind.items()}, "days": days,
    }


def admin_balances(db: Session, *, q: str = "", page: int = 1, page_size: int = 25) -> tuple:
    now = datetime.utcnow()
    live = (select(LoyaltyLot.customer_id, func.sum(LoyaltyLot.remaining).label("live"))
            .where(LoyaltyLot.released.is_(True), LoyaltyLot.remaining > 0,
                   or_(LoyaltyLot.expires_at.is_(None), LoyaltyLot.expires_at > now))
            .group_by(LoyaltyLot.customer_id).subquery())
    held = (select(LoyaltyLot.customer_id, func.sum(LoyaltyLot.remaining).label("held"))
            .where(LoyaltyLot.released.is_(False)).group_by(LoyaltyLot.customer_id).subquery())
    query = (select(Customer, LoyaltyAccount, live.c.live, held.c.held)
             .join(LoyaltyAccount, LoyaltyAccount.customer_id == Customer.id)
             .outerjoin(live, live.c.customer_id == Customer.id).outerjoin(held, held.c.customer_id == Customer.id))
    text = (q or "").strip()
    if text:
        like = f"%{text}%"
        query = query.where(or_(Customer.email.ilike(like), Customer.first_name.ilike(like),
                                Customer.last_name.ilike(like), Customer.id == text))
    total = db.execute(select(func.count()).select_from(query.subquery())).scalar_one()
    rows = db.execute(query.order_by(func.coalesce(live.c.live, 0).desc(), Customer.id)
                      .offset((max(1, page) - 1) * page_size).limit(page_size)).all()
    return [{
        "customer": {"id": c.id, "name": c.full_name, "email": c.email},
        "available": int(lv or 0) - int(a.debt), "pending": int(hd or 0), "debt": int(a.debt),
        "lifetimeEarned": a.lifetime_earned, "lifetimeRedeemed": a.lifetime_redeemed,
        "lifetimeExpired": a.lifetime_expired, "lifetimeReversed": a.lifetime_reversed,
    } for c, a, lv, hd in rows], total


def admin_ledger(db: Session, *, kind: str = "", q: str = "", customer_id: str = "", page: int = 1,
                 page_size: int = 25) -> tuple:
    conditions = []
    if kind:
        conditions.append(LoyaltyTransaction.kind == kind)
    if customer_id:
        conditions.append(LoyaltyTransaction.customer_id == customer_id)
    text = (q or "").strip()
    if text:
        like = f"%{text}%"
        people = select(Customer.id).where(or_(Customer.email.ilike(like), Customer.first_name.ilike(like),
                                               Customer.last_name.ilike(like)))
        orders = select(Order.id).where(Order.order_number == text)
        conditions.append(or_(LoyaltyTransaction.customer_id.in_(people), LoyaltyTransaction.order_id.in_(orders),
                              LoyaltyTransaction.reason.ilike(like)))
    total = db.execute(select(func.count()).select_from(LoyaltyTransaction).where(*conditions)).scalar_one()
    rows = db.execute(select(LoyaltyTransaction, Customer).join(Customer, Customer.id == LoyaltyTransaction.customer_id)
                      .where(*conditions).order_by(LoyaltyTransaction.id.desc())
                      .offset((max(1, page) - 1) * page_size).limit(page_size)).all()
    items = []
    for entry, customer in rows:
        view = txn_view(entry)
        view["customer"] = {"id": customer.id, "name": customer.full_name, "email": customer.email}
        items.append(view)
    return items, total


# ------------------------------------------------------------------ loop

INTERVAL_SECONDS = 900


def _sweep_once() -> None:
    from app.core.database import SessionLocal
    from app.services import gift_cards

    with SessionLocal() as db:
        for job in (release_due, expire_due, warn_expiring, gift_cards.expire_due):
            try:
                job(db)
            except Exception:  # noqa: BLE001 — one job failing must not stop the others
                db.rollback()
                logger.exception("Rewards housekeeping step %s failed", job.__name__)


async def run_forever() -> None:
    import asyncio

    logger.info("Reward points and gift card housekeeping every %ss.", INTERVAL_SECONDS)
    while True:
        try:
            await asyncio.to_thread(_sweep_once)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Rewards housekeeping failed; retrying next interval.")
        await asyncio.sleep(INTERVAL_SECONDS)
