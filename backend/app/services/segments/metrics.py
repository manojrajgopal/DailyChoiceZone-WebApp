"""
The per-customer metrics behind segmentation, and RFM.

## Refreshing

`refresh(db, ids)` recomputes the given customers' rows: one grouped query per
source, restricted to the batch's ids, then one multi-row upsert. Callers pass
batches (`BATCH`), so nothing ever loads every customer into Python.

- `refresh_dirty` — rows marked dirty by the change hook, plus customers who
  have no row yet. Run by every pass of the `segments` job.
- `refresh_all` — everyone, oldest first; when the oldest row is older than
  `refreshHours`, and on demand.

## The change hook

A session `after_flush` listener notices new or changed orders, refunds,
return requests, memberships, wishlist lines and new customers, and marks the
customer's row dirty with a single upsert. It never aggregates anything, and
it never fails the work that triggered it.

A row marked while its batch was being computed stays dirty (`marked_at` is
not older than the batch's start), so a concurrent change is never lost.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Dict, Iterable, List, Optional, Sequence

from sqlalchemy import bindparam, case, event, func, or_, select, update
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.orm import Session

from app.core.errors import ValidationError
from app.models import (
    Address,
    AnalyticsEvent,
    CampaignRecipient,
    CartItem,
    CartRecovery,
    ChannelPreference,
    CouponUsage,
    Customer,
    CustomerMembership,
    LoyaltyAccount,
    LoyaltyLot,
    Order,
    OrderItem,
    OrderTender,
    Product,
    Referral,
    Refund,
    ReturnRequest,
    SettingDocument,
    StoreCreditAccount,
    WishlistItem,
)
from app.models.segments import CustomerMetrics

logger = logging.getLogger(__name__)

BATCH = 500
DIRTY_PER_PASS = 5000
VIEW_DAYS = 90
SETTINGS_KEY = "segmentation"
LABEL_KEYS = ("champions", "loyal", "potential", "new", "at-risk", "hibernating", "lost")

DEFAULT_SETTINGS = {
    "recencyDays": [30, 60, 90, 180],
    "frequencyOrders": [2, 3, 5, 8],
    "monetaryRupees": [1000, 3000, 7500, 15000],
    "refreshHours": 6,
    "labels": [
        {"key": "champions", "label": "Champions", "r": [4, 5], "f": [4, 5], "m": [4, 5]},
        {"key": "loyal", "label": "Loyal", "r": [3, 5], "f": [3, 5], "m": [1, 5]},
        {"key": "new", "label": "New", "r": [4, 5], "f": [1, 1], "m": [1, 5]},
        {"key": "potential", "label": "Potential", "r": [3, 5], "f": [1, 2], "m": [1, 5]},
        {"key": "at-risk", "label": "At risk", "r": [1, 2], "f": [3, 5], "m": [1, 5]},
        {"key": "hibernating", "label": "Hibernating", "r": [2, 2], "f": [1, 2], "m": [1, 5]},
        {"key": "lost", "label": "Lost", "r": [1, 1], "f": [1, 2], "m": [1, 5]},
    ],
}


# ------------------------------------------------------------------ settings


def settings(db: Session) -> dict:
    """The saved RFM settings over the defaults (a section that was never saved is the default)."""
    row = db.get(SettingDocument, SETTINGS_KEY)
    saved = (row.value if row else None) or {}
    out = {key: saved.get(key, value) for key, value in DEFAULT_SETTINGS.items()}
    try:
        return clean_settings(out)
    except ValidationError:  # a hand-edited document that no longer validates
        logger.warning("The saved segmentation settings are invalid; using the defaults.")
        return clean_settings(dict(DEFAULT_SETTINGS))


def _bad(message: str):
    raise ValidationError(message, error_code="INVALID_SEGMENT_SETTINGS")


def _bands(value, label: str, *, whole: bool) -> list:
    if not isinstance(value, list) or len(value) != 4:
        _bad(f"{label} needs exactly four thresholds.")
    out = []
    for item in value:
        if isinstance(item, bool):
            _bad(f"{label} must be numbers.")
        try:
            number = Decimal(str(item))
        except Exception:  # noqa: BLE001
            _bad(f"{label} must be numbers.")
        if not number.is_finite() or number <= 0 or number > 100_000_000:
            _bad(f"{label} must be positive numbers.")
        if whole and number != number.to_integral_value():
            _bad(f"{label} must be whole numbers.")
        out.append(int(number) if number == number.to_integral_value() else float(number))
    if any(b <= a for a, b in zip(out, out[1:])):
        _bad(f"{label} must go up, each higher than the one before.")
    return out


def _range(value, label: str) -> list:
    if (not isinstance(value, list) or len(value) != 2 or any(isinstance(v, bool) or not isinstance(v, int) for v in value)
            or not 1 <= value[0] <= value[1] <= 5):
        _bad(f"{label} needs a range from 1 to 5, the lower first.")
    return [int(value[0]), int(value[1])]


def clean_settings(raw) -> dict:
    if not isinstance(raw, dict):
        _bad("The settings must be an object.")
    out = {
        "recencyDays": _bands(raw.get("recencyDays"), "Recency (days)", whole=True),
        "frequencyOrders": _bands(raw.get("frequencyOrders"), "Frequency (orders)", whole=True),
        "monetaryRupees": _bands(raw.get("monetaryRupees"), "Monetary (₹)", whole=False),
    }
    hours = raw.get("refreshHours", 6)
    if isinstance(hours, bool) or not isinstance(hours, int) or not 1 <= hours <= 48:
        _bad("Refresh every 1 to 48 hours.")
    out["refreshHours"] = hours
    labels = raw.get("labels")
    if not isinstance(labels, list) or not labels or len(labels) > len(LABEL_KEYS):
        _bad("List the RFM groups.")
    seen, cleaned = set(), []
    for entry in labels:
        if not isinstance(entry, dict) or entry.get("key") not in LABEL_KEYS:
            _bad(f"Each RFM group must be one of: {', '.join(LABEL_KEYS)}.")
        if entry["key"] in seen:
            _bad(f"The group “{entry['key']}” is listed twice.")
        seen.add(entry["key"])
        name = str(entry.get("label") or "").strip() if isinstance(entry.get("label"), (str, type(None))) else ""
        if not 1 <= len(name) <= 40:
            _bad("Give each RFM group a name (1 to 40 characters).")
        cleaned.append({"key": entry["key"], "label": name, "r": _range(entry.get("r"), f"{name}: R"),
                        "f": _range(entry.get("f"), f"{name}: F"), "m": _range(entry.get("m"), f"{name}: M")})
    out["labels"] = cleaned
    return out


def save_settings(db: Session, admin, payload) -> dict:
    from app.services import audit

    clean = clean_settings(payload)
    row = db.get(SettingDocument, SETTINGS_KEY)
    before = dict(row.value) if row and row.value else {}
    if row is None:
        row = SettingDocument(key=SETTINGS_KEY, value=clean)
        db.add(row)
    else:
        row.value = clean
    audit.record(db, "segments.settings", resource_type="segments", resource_id="settings", actor=admin,
                 summary="Changed the RFM settings", changes=audit.diff(before, clean))
    db.commit()
    rescore(db)
    return clean


# ----------------------------------------------------------------------- RFM


def score_recency(conf: dict, days: Optional[int]) -> int:
    if days is None:
        return 0
    bands = conf["recencyDays"]
    for score, limit in zip((5, 4, 3, 2), bands):
        if days <= limit:
            return score
    return 1


def _score_up(bands: Sequence, value) -> int:
    score = 1
    for i, limit in enumerate(bands):
        if value >= limit:
            score = i + 2
    return score


def score_frequency(conf: dict, orders: int) -> int:
    return 0 if orders <= 0 else _score_up(conf["frequencyOrders"], orders)


def score_monetary(conf: dict, spend_paise: int, orders: int) -> int:
    if orders <= 0:
        return 0
    return _score_up([Decimal(str(b)) * 100 for b in conf["monetaryRupees"]], spend_paise)


def label_for(conf: dict, r: int, f: int, m: int) -> str:
    if not (r and f and m):
        return "no-orders"
    for entry in conf["labels"]:
        if (entry["r"][0] <= r <= entry["r"][1] and entry["f"][0] <= f <= entry["f"][1]
                and entry["m"][0] <= m <= entry["m"][1]):
            return entry["key"]
    return "lost" if r == 1 else "potential"


def rfm(conf: dict, last_order_at: Optional[datetime], kept_orders: int, spend_paise: int,
        now: Optional[datetime] = None) -> dict:
    now = now or datetime.utcnow()
    if kept_orders <= 0 or last_order_at is None:
        return {"recency_score": 0, "frequency_score": 0, "monetary_score": 0, "rfm_label": "no-orders"}
    days = max(0, (now - last_order_at).days)
    r, f, m = score_recency(conf, days), score_frequency(conf, kept_orders), score_monetary(conf, spend_paise, kept_orders)
    return {"recency_score": r, "frequency_score": f, "monetary_score": m, "rfm_label": label_for(conf, r, f, m)}


def label_names(conf: dict) -> Dict[str, str]:
    names = {entry["key"]: entry["label"] for entry in conf["labels"]}
    for key, label in (("champions", "Champions"), ("loyal", "Loyal"), ("potential", "Potential"), ("new", "New"),
                       ("at-risk", "At risk"), ("hibernating", "Hibernating"), ("lost", "Lost")):
        names.setdefault(key, label)
    names["no-orders"] = "No orders yet"
    return names


def rescore(db: Session, now: Optional[datetime] = None) -> int:
    """Recompute every row's RFM from its stored figures (after a settings change), in batches."""
    conf = settings(db)
    now = now or datetime.utcnow()
    done, last = 0, ""
    table = CustomerMetrics.__table__
    statement = (update(table).where(table.c.customer_id == bindparam("cid"))
                 .values(recency_score=bindparam("r"), frequency_score=bindparam("f"),
                         monetary_score=bindparam("m"), rfm_label=bindparam("label")))
    while True:
        rows = db.execute(select(CustomerMetrics.customer_id, CustomerMetrics.last_order_at,
                                 CustomerMetrics.kept_orders, CustomerMetrics.total_spend)
                          .where(CustomerMetrics.customer_id > last).order_by(CustomerMetrics.customer_id)
                          .limit(BATCH)).all()
        if not rows:
            break
        params = []
        for cid, last_order, kept, spend in rows:
            scores = rfm(conf, last_order, int(kept or 0), int(spend or 0), now)
            params.append({"cid": cid, "r": scores["recency_score"], "f": scores["frequency_score"],
                           "m": scores["monetary_score"], "label": scores["rfm_label"]})
        db.execute(statement, params)
        db.commit()
        done += len(rows)
        last = rows[-1][0]
    return done


# ------------------------------------------------------------------- refresh


def _paise(rupees) -> int:
    return int((Decimal(str(rupees or 0)) * 100).quantize(Decimal("1")))


def _compute(db: Session, ids: List[str], now: datetime, conf: dict) -> List[dict]:
    """Every figure for these customers: one grouped query per source."""
    from app.services.messaging import service as messaging

    rows = {cid: {"customer_id": cid} for cid in ids}

    def put(cid, **values):
        if cid in rows:
            rows[cid].update(values)

    cancelled = Order.status == "cancelled"
    kept = Order.status.not_in(("cancelled", "returned"))
    for cid, total, kept_n, kept_value, first, last, n_cancel, n_return in db.execute(
            select(Order.customer_id, func.sum(case((cancelled, 0), else_=1)), func.sum(case((kept, 1), else_=0)),
                   func.coalesce(func.sum(case((kept, Order.total), else_=0)), 0),
                   func.min(case((cancelled, None), else_=Order.placed_at)),
                   func.max(case((cancelled, None), else_=Order.placed_at)),
                   func.sum(case((cancelled, 1), else_=0)), func.sum(case((Order.status == "returned", 1), else_=0)))
            .where(Order.customer_id.in_(ids)).group_by(Order.customer_id)):
        put(cid, total_orders=int(total or 0), kept_orders=int(kept_n or 0), _kept_value=_paise(kept_value),
            first_order_at=first, last_order_at=last, cancelled_orders=int(n_cancel or 0),
            returned_orders=int(n_return or 0))
    # The last *kept* order drives recency.
    for cid, last_kept in db.execute(select(Order.customer_id, func.max(Order.placed_at))
                                     .where(Order.customer_id.in_(ids), kept).group_by(Order.customer_id)):
        put(cid, _last_kept=last_kept)

    # Refunds (read only): what completed refunds took off kept orders, and how many orders had one.
    for cid, refunded in db.execute(
            select(Refund.customer_id, func.coalesce(func.sum(Refund.amount), 0))
            .join(Order, Order.id == Refund.order_id)
            .where(Refund.customer_id.in_(ids), Refund.status == "completed", kept).group_by(Refund.customer_id)):
        put(cid, _refunded=int(refunded or 0))
    for cid, n in db.execute(select(Refund.customer_id, func.count(func.distinct(Refund.order_id)))
                             .where(Refund.customer_id.in_(ids), Refund.status == "completed")
                             .group_by(Refund.customer_id)):
        put(cid, refunded_orders=int(n))

    simple = [
        ("return_requests", select(ReturnRequest.customer_id, func.count()).where(
            ReturnRequest.customer_id.in_(ids), ReturnRequest.status.not_in(("rejected", "cancelled")))
         .group_by(ReturnRequest.customer_id)),
        ("coupon_uses", select(CouponUsage.customer_id, func.count()).where(CouponUsage.customer_id.in_(ids))
         .group_by(CouponUsage.customer_id)),
        ("wishlist_items", select(WishlistItem.customer_id, func.count()).where(WishlistItem.customer_id.in_(ids))
         .group_by(WishlistItem.customer_id)),
        ("_cart_lines", select(CartItem.customer_id, func.count()).where(CartItem.customer_id.in_(ids))
         .group_by(CartItem.customer_id)),
        ("abandoned_carts", select(CartRecovery.customer_id, func.count()).where(
            CartRecovery.customer_id.in_(ids), CartRecovery.abandoned_at.is_not(None)).group_by(CartRecovery.customer_id)),
        ("_abandoned_now", select(CartRecovery.customer_id, func.count()).where(
            CartRecovery.customer_id.in_(ids), CartRecovery.status == "abandoned").group_by(CartRecovery.customer_id)),
        ("store_credit_balance", select(StoreCreditAccount.customer_id, StoreCreditAccount.balance)
         .where(StoreCreditAccount.customer_id.in_(ids))),
        ("referral_count", select(Referral.referrer_id, func.count()).where(
            Referral.referrer_id.in_(ids), Referral.status == "rewarded").group_by(Referral.referrer_id)),
        ("_referred", select(Referral.referee_id, func.count()).where(Referral.referee_id.in_(ids))
         .group_by(Referral.referee_id)),
        ("_debt", select(LoyaltyAccount.customer_id, LoyaltyAccount.debt).where(LoyaltyAccount.customer_id.in_(ids))),
        ("_lots", select(LoyaltyLot.customer_id, func.coalesce(func.sum(LoyaltyLot.remaining), 0)).where(
            LoyaltyLot.customer_id.in_(ids), LoyaltyLot.released.is_(True), LoyaltyLot.remaining > 0,
            or_(LoyaltyLot.expires_at.is_(None), LoyaltyLot.expires_at > now)).group_by(LoyaltyLot.customer_id)),
    ]
    for key, statement in simple:
        for cid, value in db.execute(statement):
            put(cid, **{key: int(value or 0)})

    since = now - timedelta(days=VIEW_DAYS)
    for cid, products, categories in db.execute(
            select(AnalyticsEvent.customer_id, func.count(func.distinct(AnalyticsEvent.product_id)),
                   func.count(func.distinct(Product.category_id)))
            .outerjoin(Product, Product.id == AnalyticsEvent.product_id)
            .where(AnalyticsEvent.customer_id.in_(ids), AnalyticsEvent.event == "product_view",
                   AnalyticsEvent.occurred_at >= since).group_by(AnalyticsEvent.customer_id)):
        put(cid, products_viewed_90d=int(products or 0), categories_viewed_90d=int(categories or 0))

    categories: Dict[str, set] = defaultdict(set)
    for cid, category in db.execute(
            select(Order.customer_id, Product.category_id).distinct()
            .join(OrderItem, OrderItem.order_id == Order.id).join(Product, Product.id == OrderItem.product_id)
            .where(Order.customer_id.in_(ids), Order.status != "cancelled")):
        if category:
            categories[cid].add(category)

    for cid, orders, paid in db.execute(
            select(Order.customer_id, func.count(func.distinct(Order.id)),
                   func.coalesce(func.sum(OrderTender.amount - OrderTender.reversed_amount), 0))
            .join(OrderTender, OrderTender.order_id == Order.id)
            .where(Order.customer_id.in_(ids), Order.status != "cancelled", OrderTender.kind == "gift_card")
            .group_by(Order.customer_id)):
        put(cid, gift_card_orders=int(orders or 0), gift_card_spend=max(0, int(paid or 0)))

    memberships: Dict[str, list] = defaultdict(list)
    for cid, status, plan, starts, ends, created in db.execute(
            select(CustomerMembership.customer_id, CustomerMembership.status, CustomerMembership.plan_id,
                   CustomerMembership.starts_at, CustomerMembership.ends_at, CustomerMembership.created_at)
            .where(CustomerMembership.customer_id.in_(ids), CustomerMembership.status != "pending")):
        memberships[cid].append((status, plan, starts, ends, created))

    for cid, sent, opened, clicked, last_open, last_click in db.execute(
            select(CampaignRecipient.customer_id, func.count(), func.count(CampaignRecipient.opened_at),
                   func.count(CampaignRecipient.clicked_at), func.max(CampaignRecipient.opened_at),
                   func.max(CampaignRecipient.clicked_at))
            .where(CampaignRecipient.customer_id.in_(ids)).group_by(CampaignRecipient.customer_id)):
        put(cid, campaigns_received=int(sent), campaign_opens=int(opened), campaign_clicks=int(clicked),
            last_engaged_at=max([d for d in (last_open, last_click) if d] or [None]) if (last_open or last_click) else None)

    choices: Dict[str, dict] = defaultdict(dict)
    for cid, channel, enabled in db.execute(
            select(ChannelPreference.customer_id, ChannelPreference.channel, ChannelPreference.enabled)
            .where(ChannelPreference.customer_id.in_(ids), ChannelPreference.category == "marketing")):
        choices[cid][channel] = bool(enabled)

    addresses: Dict[str, tuple] = {}
    for cid, city, state, pincode, default in db.execute(
            select(Address.customer_id, Address.city, Address.state, Address.pincode, Address.is_default)
            .where(Address.customer_id.in_(ids)).order_by(Address.is_default.desc(), Address.created_at.desc())):
        addresses.setdefault(cid, (city, state, pincode))
    missing = [cid for cid in ids if cid not in addresses]
    if missing:
        latest = (select(Order.customer_id, func.max(Order.placed_at).label("at"))
                  .where(Order.customer_id.in_(missing)).group_by(Order.customer_id).subquery())
        for cid, city, state, pincode in db.execute(
                select(Order.customer_id, Order.shipping_city, Order.shipping_state, Order.shipping_pincode)
                .join(latest, (latest.c.customer_id == Order.customer_id) & (latest.c.at == Order.placed_at))):
            addresses.setdefault(cid, (city, state, pincode))

    out = []
    for cid in ids:
        row = rows[cid]
        kept_n = row.get("kept_orders", 0)
        spend = max(0, row.pop("_kept_value", 0) - row.pop("_refunded", 0))
        last_kept = row.pop("_last_kept", None)
        lots, debt = row.pop("_lots", 0), row.pop("_debt", 0)
        status, plan, ends = "none", None, None
        mine = memberships.get(cid) or []
        live = [m for m in mine if m[0] == "active" and (m[3] is None or m[3] > now)]
        if live:
            chosen = max(live, key=lambda m: m[3] or datetime.max)
            status, plan, ends = "active", chosen[1], chosen[3]
        elif mine:
            chosen = max(mine, key=lambda m: m[4] or datetime.min)
            status = "expired" if chosen[0] == "active" else chosen[0]
            status = status if status in ("expired", "cancelled") else "expired"
            plan, ends = chosen[1], chosen[3]
        consent = {}
        for channel in ("email", "sms", "whatsapp"):
            consent[channel] = choices[cid].get(channel, messaging.DEFAULT_CONSENT.get((channel, "marketing"), False))
        city, state, pincode = addresses.get(cid, ("", "", ""))
        row.update({
            "total_orders": row.get("total_orders", 0), "kept_orders": kept_n,
            "total_spend": spend, "average_order_value": spend // kept_n if kept_n else 0,
            "first_order_at": row.get("first_order_at"), "last_order_at": row.get("last_order_at"),
            "cancelled_orders": row.get("cancelled_orders", 0), "returned_orders": row.get("returned_orders", 0),
            "refunded_orders": row.get("refunded_orders", 0), "return_requests": row.get("return_requests", 0),
            "coupon_uses": row.get("coupon_uses", 0), "wishlist_items": row.get("wishlist_items", 0),
            "has_active_cart": bool(row.pop("_cart_lines", 0)), "has_abandoned_cart": bool(row.pop("_abandoned_now", 0)),
            "abandoned_carts": row.get("abandoned_carts", 0),
            "products_viewed_90d": row.get("products_viewed_90d", 0),
            "categories_viewed_90d": row.get("categories_viewed_90d", 0),
            "purchased_category_ids": sorted(categories.get(cid, ())),
            "membership_status": status, "membership_plan_id": plan, "membership_ends_at": ends,
            "points_balance": int(lots) - int(debt), "store_credit_balance": row.get("store_credit_balance", 0),
            "gift_card_orders": row.get("gift_card_orders", 0), "gift_card_spend": row.get("gift_card_spend", 0),
            "was_referred": bool(row.pop("_referred", 0)), "referral_count": row.get("referral_count", 0),
            "email_opt_in": consent["email"], "sms_opt_in": consent["sms"], "whatsapp_opt_in": consent["whatsapp"],
            "campaigns_received": row.get("campaigns_received", 0), "campaign_opens": row.get("campaign_opens", 0),
            "campaign_clicks": row.get("campaign_clicks", 0), "last_engaged_at": row.get("last_engaged_at"),
            "city": (city or "")[:120], "state": (state or "")[:120], "pincode": (pincode or "")[:12],
            **rfm(conf, last_kept, kept_n, spend, now),
        })
        out.append(row)
    return out


def refresh(db: Session, ids: Iterable[str], now: Optional[datetime] = None) -> int:
    """Recompute these customers' rows (callers pass a batch). Commits. Returns how many."""
    now = (now or datetime.utcnow()).replace(microsecond=0)
    ids = [cid for cid in dict.fromkeys(ids) if cid]
    if not ids:
        return 0
    # Customers that no longer exist are skipped (the FK would refuse them).
    ids = list(db.execute(select(Customer.id).where(Customer.id.in_(ids))).scalars())
    if not ids:
        return 0
    conf = settings(db)
    rows = _compute(db, ids, now, conf)
    table = CustomerMetrics.__table__
    for row in rows:
        row["refreshed_at"] = now
        row["dirty"] = False
    statement = mysql_insert(table).values(rows)
    columns = {c: statement.inserted[c] for c in rows[0] if c not in ("customer_id", "dirty")}
    # Still dirty if it was marked after this batch started.
    columns["dirty"] = case((table.c.marked_at >= now, True), else_=False)
    db.execute(statement.on_duplicate_key_update(**columns))
    db.commit()
    return len(rows)


def ensure_rows(db: Session, limit: int = DIRTY_PER_PASS) -> int:
    """Create (dirty) rows for customers who have none yet."""
    ids = list(db.execute(select(Customer.id).outerjoin(CustomerMetrics, CustomerMetrics.customer_id == Customer.id)
                          .where(CustomerMetrics.customer_id.is_(None)).order_by(Customer.id).limit(limit)).scalars())
    if ids:
        mark_dirty(db.connection(), ids)
        db.commit()
    return len(ids)


def refresh_dirty(db: Session, limit: int = DIRTY_PER_PASS) -> List[str]:
    """Refresh rows marked dirty (and new customers'). Returns the ids refreshed."""
    ensure_rows(db, limit)
    ids = list(db.execute(select(CustomerMetrics.customer_id).where(CustomerMetrics.dirty.is_(True))
                          .order_by(CustomerMetrics.customer_id).limit(limit)).scalars())
    for start in range(0, len(ids), BATCH):
        refresh(db, ids[start:start + BATCH])
    return ids


def refresh_all(db: Session) -> int:
    """Everyone, in batches by id."""
    ensure_rows(db, limit=10_000_000)
    done, last = 0, ""
    while True:
        ids = list(db.execute(select(Customer.id).where(Customer.id > last).order_by(Customer.id).limit(BATCH)).scalars())
        if not ids:
            break
        done += refresh(db, ids)
        last = ids[-1]
    return done


def full_refresh_due(db: Session, now: Optional[datetime] = None) -> bool:
    now = now or datetime.utcnow()
    oldest = db.execute(select(func.min(CustomerMetrics.refreshed_at))).scalar_one_or_none()
    has_rows = db.execute(select(func.count()).select_from(CustomerMetrics)).scalar_one()
    if not has_rows:
        return bool(db.execute(select(func.count()).select_from(Customer)).scalar_one())
    if oldest is None:  # rows nobody has refreshed yet: the dirty pass takes them
        return False
    return oldest < now - timedelta(hours=settings(db)["refreshHours"])


def status(db: Session) -> dict:
    customers = db.execute(select(func.count()).select_from(Customer)).scalar_one()
    count, dirty, oldest, newest = db.execute(select(
        func.count(), func.coalesce(func.sum(case((CustomerMetrics.dirty.is_(True), 1), else_=0)), 0),
        func.min(CustomerMetrics.refreshed_at), func.max(CustomerMetrics.refreshed_at))).one()
    return {"customers": int(customers), "metrics": int(count), "dirty": int(dirty or 0),
            "oldestRefreshAt": oldest, "newestRefreshAt": newest}


# ---------------------------------------------------------------- the hook


def mark_dirty(connection, ids: Iterable[str]) -> None:
    ids = sorted({cid for cid in ids if cid})
    if not ids:
        return
    now = datetime.utcnow().replace(microsecond=0)
    table = CustomerMetrics.__table__
    statement = mysql_insert(table).values([{"customer_id": cid, "dirty": True, "marked_at": now} for cid in ids])
    connection.execute(statement.on_duplicate_key_update(dirty=True, marked_at=now))


def _changed(obj, attribute: str) -> bool:
    from sqlalchemy import inspect

    return inspect(obj).attrs[attribute].history.has_changes()


@event.listens_for(Session, "after_flush")
def _mark_changed_customers(session: Session, flush_context) -> None:
    """Orders, refunds, returns, memberships, wishlists and new customers mark their customer dirty."""
    ids = set()
    for obj in session.new:
        if isinstance(obj, (Order, Refund, ReturnRequest, CustomerMembership, WishlistItem, CouponUsage)):
            ids.add(obj.customer_id)
        elif isinstance(obj, Customer):
            ids.add(obj.id)
    for obj in session.dirty:
        if isinstance(obj, (Order, Refund, ReturnRequest, CustomerMembership)) and _changed(obj, "status"):
            ids.add(obj.customer_id)
    for obj in session.deleted:
        if isinstance(obj, (WishlistItem, CouponUsage)):
            ids.add(obj.customer_id)
    ids.discard(None)
    if not ids:
        return
    try:
        with session.connection().begin_nested():
            mark_dirty(session.connection(), ids)
    except Exception:  # noqa: BLE001 - marking is advisory; the job's full refresh catches up
        logger.warning("Could not mark customer metrics dirty for %s", sorted(ids)[:5], exc_info=True)
