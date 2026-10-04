"""
Abandoned carts: noticing a bag left behind, reminding its owner, and telling
the store what came back.

## The lifecycle

    active ──(no change for `abandonAfterMinutes`)──▶ abandoned ──▶ reminders
      ▲                                                    │
      └──────────────── the customer changes the bag ◀─────┘
    an order ──▶ recovered (if it had been abandoned or reminded) / converted
    the bag emptied ──▶ emptied          nothing for `expireAfterDays` ──▶ expired

One open row per customer (`CartRecovery`). "Activity" is a change to the bag —
adding, removing, changing a quantity — recorded by the cart service itself,
so the clock can't be fooled by a page merely being open.

## Reminders

Each stage in `reminders` goes out **once**: `reminders_sent` is the next
stage's index, bumped in the same transaction as the email is queued. A
customer who switched off "Bag reminders" gets none. A minimum gap keeps two
stages from landing together after downtime.

## The link

The email links to `/cart?recover=<token>`. The token is an HMAC of the row
(stable, so every reminder's link works) and only its SHA-256 is stored. It
signs nobody in — the bag belongs to an account, so the customer signs in as
usual and the token only lets us tell them what changed since (a price, an
item that sold out) and put items back if the bag has since been emptied.

## Guests

A guest's bag lives only in their browser: there is no server-side cart and no
email address to remind, so guest carts can't be tracked or recovered.
"""

from __future__ import annotations

import copy
import hashlib
import hmac
import html as html_lib
import logging
from datetime import datetime, timedelta
from typing import List, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings as app_settings
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import CartItem, CartRecovery, Customer, Order, SettingDocument

logger = logging.getLogger(__name__)

OPEN = ("active", "abandoned")
DEFAULTS = {
    "enabled": True,
    # A bag untouched this long counts as abandoned.
    "abandonAfterMinutes": 60,
    # Minutes after abandonment for each reminder; one email per stage.
    "reminders": [{"afterMinutes": 60}, {"afterMinutes": 1440}],
    # Stop tracking an abandoned bag after this.
    "expireAfterDays": 14,
}
MIN_GAP = timedelta(minutes=30)
BATCH = 200


# --------------------------------------------------------------- settings


def settings(db: Session) -> dict:
    stored = (db.get(SettingDocument, "abandoned_cart") or SettingDocument(value={})).value or {}
    merged = copy.deepcopy(DEFAULTS)
    merged.update({k: v for k, v in stored.items() if k in DEFAULTS})
    return merged


def _whole(value) -> int:
    if isinstance(value, bool):
        raise ValidationError("Enter a whole number.", error_code="INVALID_SETTING")
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ValidationError("Enter a whole number.", error_code="INVALID_SETTING") from None


def save_settings(db: Session, payload: dict) -> dict:
    out = settings(db)
    if "enabled" in payload:
        out["enabled"] = bool(payload["enabled"])
    if "abandonAfterMinutes" in payload:
        minutes = _whole(payload["abandonAfterMinutes"])
        if not 15 <= minutes <= 7 * 24 * 60:
            raise ValidationError("A bag counts as abandoned after 15 minutes to 7 days.", error_code="INVALID_SETTING")
        out["abandonAfterMinutes"] = minutes
    if "reminders" in payload:
        stages, previous = [], -1
        if not isinstance(payload["reminders"], list):
            raise ValidationError("Reminders must be a list.", error_code="INVALID_SETTING")
        for stage in payload["reminders"]:
            minutes = _whole((stage or {}).get("afterMinutes", 0) if isinstance(stage, dict) else stage)
            if not 30 <= minutes <= 14 * 24 * 60:
                raise ValidationError("Each reminder goes 30 minutes to 14 days after the bag is abandoned.",
                                      error_code="INVALID_SETTING")
            if minutes <= previous:
                raise ValidationError("Each reminder must come after the one before it.", error_code="INVALID_SETTING")
            stages.append({"afterMinutes": minutes})
            previous = minutes
        if len(stages) > 3:
            raise ValidationError("Send at most three reminders.", error_code="INVALID_SETTING")
        out["reminders"] = stages
    if "expireAfterDays" in payload:
        days = _whole(payload["expireAfterDays"])
        if not 1 <= days <= 90:
            raise ValidationError("Stop tracking after 1 to 90 days.", error_code="INVALID_SETTING")
        out["expireAfterDays"] = days
    now = datetime.utcnow()
    row = db.get(SettingDocument, "abandoned_cart")
    if row is None:
        db.add(SettingDocument(key="abandoned_cart", value=out, created_at=now, updated_at=now))
    else:
        row.value = out
        row.updated_at = now
    db.commit()
    return out


# ------------------------------------------------------------------ token


def _token(row: CartRecovery) -> str:
    """Stable per row, so every reminder carries a working link; never stored."""
    key = (app_settings.JWT_SECRET_KEY or "").encode()
    message = f"cart-recovery:{row.id}:{row.started_at.isoformat()}".encode()
    return hmac.new(key, message, hashlib.sha256).hexdigest()[:40]


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


# --------------------------------------------------------------- activity


def _open_row(db: Session, customer_id: str) -> Optional[CartRecovery]:
    return db.execute(
        select(CartRecovery).where(CartRecovery.customer_id == customer_id, CartRecovery.status.in_(OPEN))
        .order_by(CartRecovery.id.desc()).limit(1)
    ).scalar_one_or_none()


def touch(db: Session, customer_id: str) -> None:
    """
    The bag just changed. Called by the cart service before it commits, so the
    activity is recorded in the same transaction as the change.
    """
    db.flush()
    now = datetime.utcnow()
    count = db.execute(select(func.count()).select_from(CartItem).where(CartItem.customer_id == customer_id)).scalar_one()
    row = _open_row(db, customer_id)
    if count == 0:
        if row is not None:
            row.status, row.closed_at, row.updated_at = "emptied", now, now
        return
    if row is None:
        db.add(CartRecovery(customer_id=customer_id, status="active", started_at=now, last_activity_at=now,
                            created_at=now, updated_at=now))
        return
    # Back from being abandoned: the clock restarts, but the reminders already
    # sent stay counted, so coming and going can't earn unlimited emails.
    row.status = "active"
    row.last_activity_at = now
    row.updated_at = now


def on_order_placed(db: Session, customer_id: str, order: Order) -> None:
    """The bag became an order. Called before the order's own commit."""
    row = _open_row(db, customer_id)
    if row is None:
        return
    now = datetime.utcnow()
    from app.services import billing

    was_chased = row.abandoned_at is not None or row.reminders_sent > 0 or row.clicked_at is not None
    row.status = "recovered" if was_chased else "converted"
    row.closed_at = now
    row.updated_at = now
    if was_chased:
        row.recovered_at = now
        row.recovered_order_id = order.id
        row.recovered_value = billing.to_minor(float(order.total))


# ----------------------------------------------------------------- sweep


def _snapshot(db: Session, customer_id: str) -> tuple:
    """What is in the bag now, at today's prices — for the email and the dashboard."""
    from app.services import billing

    items = db.execute(select(CartItem).where(CartItem.customer_id == customer_id)).scalars().all()
    lines, value, count = [], 0, 0
    for item in items:
        product = item.product
        if product is None or product.status not in ("active", "out-of-stock"):
            continue
        price = billing.to_minor(float(product.price))
        image = product.images[0].url if getattr(product, "images", None) else ""
        lines.append({"productId": product.id, "name": product.name, "slug": product.slug, "size": item.size,
                      "color": item.color, "quantity": item.quantity, "unitPrice": price, "image": image})
        value += price * item.quantity
        count += item.quantity
    return lines, value, count


def _seed(db: Session, now: datetime) -> None:
    """Bags from before tracking began (or missed activity): open a row from their lines' own dates."""
    with_items = db.execute(
        select(CartItem.customer_id, func.max(CartItem.updated_at)).group_by(CartItem.customer_id)
    ).all()
    tracked = {c for (c,) in db.execute(
        select(CartRecovery.customer_id).where(CartRecovery.status.in_(OPEN))
    ).all()}
    for customer_id, last in with_items:
        if customer_id in tracked:
            continue
        stamp = last or now
        db.add(CartRecovery(customer_id=customer_id, status="active", started_at=stamp, last_activity_at=stamp,
                            created_at=now, updated_at=now))
    db.commit()


def _send_reminder(db: Session, row: CartRecovery, customer: Customer, stage: int) -> bool:
    from app.services import billing
    from app.services import email as email_service

    if not email_service.wants(db, "cart_reminders", customer.id):
        return False
    raw = _token(row)
    row.token_hash = _hash(raw)
    link = f"{app_settings.STOREFRONT_URL.rstrip('/')}/cart?recover={raw}"
    esc = html_lib.escape
    rows = "".join(
        f'<tr><td style="padding:8px 0;border-bottom:1px solid #ede7df;font-size:14px">{esc(line["name"])}'
        f'{(" · " + esc(line["size"])) if line.get("size") else ""}{(" · " + esc(line["color"])) if line.get("color") else ""}'
        f' <span style="color:#8a817a">× {int(line["quantity"])}</span></td>'
        f'<td align="right" style="padding:8px 0;border-bottom:1px solid #ede7df;font-size:14px">'
        f'₹{billing.to_major(line["unitPrice"] * line["quantity"]):,.2f}</td></tr>'
        for line in (row.items or [])[:8]
    )
    table = (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px">{rows}'
             f'<tr><td style="padding:12px 0 0;font-size:14px;font-weight:bold">Bag total</td>'
             f'<td align="right" style="padding:12px 0 0;font-size:14px;font-weight:bold">'
             f'₹{billing.to_major(row.cart_value):,.2f}</td></tr></table>'
             '<p style="margin:14px 0 0;font-size:12px;color:#8a817a">Prices and availability are confirmed in your '
             'bag and at checkout, and may have changed since.</p>')
    name = esc(customer.first_name or "there")
    title = "You left something in your bag" if stage == 0 else "Your bag is still waiting"
    footnote = ("You're receiving this because you left items in your Daily Choice Zone bag. "
                "You can turn off bag reminders in your account settings.")
    html = email_service.layout(title, f"Hello {name}, the items you picked are still in your bag.", table,
                                ("Return to your bag", link), footnote=footnote)
    text = f"{title}. Return to your bag: {link}\nTurn off bag reminders in your account settings."
    return email_service.notify(db, "cart_reminders", to=customer.email, customer_id=customer.id,
                                subject=f"{title} — Daily Choice Zone", html=html, text=text,
                                reference=f"cart-{row.id}", event="abandoned_cart",
                                variables={"cart_url": link, "item_count": str(row.item_count or "")},
                                extra_html=table)


def sweep(db: Session, now: Optional[datetime] = None) -> dict:
    """One pass: mark abandoned bags, send due reminders, expire old ones. Returns counts."""
    now = now or datetime.utcnow()
    conf = settings(db)
    counts = {"abandoned": 0, "reminded": 0, "expired": 0, "emptied": 0}
    if not conf["enabled"]:
        return counts
    _seed(db, now)
    threshold = timedelta(minutes=int(conf["abandonAfterMinutes"]))

    # --- active → abandoned
    stale = db.execute(
        select(CartRecovery.id).where(CartRecovery.status == "active", CartRecovery.last_activity_at <= now - threshold)
        .limit(BATCH)
    ).scalars().all()
    for row_id in stale:
        try:
            row = db.get(CartRecovery, row_id)
            lines, value, count = _snapshot(db, row.customer_id)
            if not lines:
                row.status, row.closed_at = "emptied", now
                counts["emptied"] += 1
            else:
                row.status = "abandoned"
                row.abandoned_at = row.abandoned_at or (row.last_activity_at + threshold)
                row.items, row.cart_value, row.item_count = lines, value, count
                counts["abandoned"] += 1
            row.updated_at = now
            db.commit()
        except Exception:  # noqa: BLE001 — one bad row must not stop the rest
            db.rollback()
            logger.exception("Abandoned-cart check failed for %s", row_id)

    # --- reminders and expiry
    stages = conf["reminders"] or []
    abandoned = db.execute(
        select(CartRecovery.id).where(CartRecovery.status == "abandoned").limit(BATCH * 5)
    ).scalars().all()
    for row_id in abandoned:
        try:
            row = db.get(CartRecovery, row_id)
            if row.abandoned_at and now >= row.abandoned_at + timedelta(days=int(conf["expireAfterDays"])):
                row.status, row.closed_at, row.updated_at = "expired", now, now
                db.commit()
                counts["expired"] += 1
                continue
            stage = row.reminders_sent
            if stage >= len(stages) or row.abandoned_at is None:
                continue
            if now < row.abandoned_at + timedelta(minutes=int(stages[stage]["afterMinutes"])):
                continue
            if row.last_reminder_at and now - row.last_reminder_at < MIN_GAP:
                continue
            customer = db.get(Customer, row.customer_id)
            if customer is None or customer.status != "active":
                continue
            # Refresh the lines, so the email shows today's prices and only what's still for sale.
            lines, value, count = _snapshot(db, row.customer_id)
            if not lines:
                row.status, row.closed_at, row.updated_at = "emptied", now, now
                db.commit()
                continue
            row.items, row.cart_value, row.item_count = lines, value, count
            if _send_reminder(db, row, customer, stage):
                row.reminders_sent = stage + 1
                row.last_reminder_at = now
                row.updated_at = now
                counts["reminded"] += 1
            db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
            logger.exception("Abandoned-cart reminder failed for %s", row_id)
    return counts


# ------------------------------------------------------------- the link


def open_link(db: Session, customer: Customer, raw: str) -> dict:
    """
    The customer followed a reminder. Only their own row answers; anyone else
    gets the same not-found. Says what changed, and puts items back if the bag
    has been emptied since.
    """
    raw = (raw or "").strip()
    row = db.execute(
        select(CartRecovery).where(CartRecovery.token_hash == _hash(raw))
    ).scalar_one_or_none() if raw and len(raw) <= 100 else None
    if row is None or row.customer_id != customer.id:
        raise NotFoundError("This link isn't valid for your account.", error_code="RECOVERY_NOT_FOUND")
    now = datetime.utcnow()
    if row.clicked_at is None:
        row.clicked_at = now

    from app.models import Product
    from app.services import billing, cart as cart_service

    in_bag = {(i.product_id, i.size, i.color): i for i in db.execute(
        select(CartItem).where(CartItem.customer_id == customer.id)).scalars()}
    changes: List[dict] = []
    restored = 0
    can_restore = not in_bag and row.status in ("abandoned", "expired", "emptied")
    for line in row.items or []:
        product = db.get(Product, line["productId"])
        if product is None or product.status != "active":
            changes.append({"name": line["name"], "kind": "unavailable",
                            "message": f"{line['name']} is no longer available."})
            continue
        price = billing.to_minor(float(product.price))
        if price != line["unitPrice"]:
            changes.append({"name": line["name"], "kind": "price",
                            "old": billing.to_major(line["unitPrice"]), "new": billing.to_major(price),
                            "message": f"{line['name']} is now ₹{billing.to_major(price):,.2f} "
                                       f"(was ₹{billing.to_major(line['unitPrice']):,.2f})."})
        stock = product.available_stock
        if stock <= 0:
            changes.append({"name": line["name"], "kind": "sold-out", "message": f"{line['name']} has sold out."})
            continue
        if can_restore:
            try:
                # The cart's own checks (size, colour, stock, the per-line cap)
                # apply, and it records the activity itself.
                cart_service.add_item(db, customer, product_id=product.id, size=line.get("size") or None,
                                      color=line.get("color") or None, quantity=min(int(line["quantity"]), stock))
                restored += 1
            except (NotFoundError, ValidationError, ConflictError) as problem:  # a variant gone is a change
                changes.append({"name": line["name"], "kind": "unavailable", "message": problem.message})
    db.commit()
    return {"changes": changes, "restored": restored}


# ------------------------------------------------------------------ admin


def view(row: CartRecovery, customer: Optional[Customer]) -> dict:
    from app.services import billing

    return {
        "id": row.id, "status": row.status,
        "customer": {"id": customer.id, "name": customer.full_name, "email": customer.email} if customer else None,
        "itemCount": row.item_count, "cartValue": billing.to_major(row.cart_value),
        "items": row.items or [],
        "startedAt": row.started_at, "lastActivityAt": row.last_activity_at, "abandonedAt": row.abandoned_at,
        "remindersSent": row.reminders_sent, "lastReminderAt": row.last_reminder_at, "clickedAt": row.clicked_at,
        "recoveredAt": row.recovered_at, "recoveredOrderId": row.recovered_order_id,
        "recoveredValue": billing.to_major(row.recovered_value) if row.recovered_value is not None else None,
    }


def search(db: Session, *, status: str = "", q: str = "", since: Optional[datetime] = None,
           page: int = 1, page_size: int = 25) -> tuple:
    from app.services.lookup.filters import id_condition

    conditions = [CartRecovery.abandoned_at.is_not(None)] if status != "active" else []
    if status:
        conditions.append(CartRecovery.status == status)
    if since:
        conditions.append(CartRecovery.abandoned_at >= since)
    # A Customer ID, exactly (docs/id-lookup.md): names and emails match nothing.
    condition = id_condition("customer", q, column=CartRecovery.customer_id)
    if condition is not None:
        conditions.append(condition)
    total = db.execute(select(func.count()).select_from(CartRecovery).where(*conditions)).scalar_one()
    rows = db.execute(
        select(CartRecovery).where(*conditions).order_by(CartRecovery.abandoned_at.desc(), CartRecovery.id.desc())
        .offset((max(1, page) - 1) * page_size).limit(page_size)
    ).scalars().all()
    people = {c.id: c for c in db.execute(
        select(Customer).where(Customer.id.in_({r.customer_id for r in rows}))).scalars()} if rows else {}
    return [view(r, people.get(r.customer_id)) for r in rows], total


def metrics(db: Session, *, since: Optional[datetime] = None) -> dict:
    """Abandoned, recovered, the rate, and the money on each side."""
    from app.services import billing

    conditions = [CartRecovery.abandoned_at.is_not(None)]
    if since:
        conditions.append(CartRecovery.abandoned_at >= since)
    by_status = dict(db.execute(
        select(CartRecovery.status, func.count()).where(*conditions).group_by(CartRecovery.status)).all())
    abandoned_total = sum(by_status.values())
    potential = db.execute(select(func.coalesce(func.sum(CartRecovery.cart_value), 0)).where(
        *conditions, CartRecovery.status.in_(("abandoned", "expired")))).scalar_one()
    # Recovered revenue counts orders that weren't later cancelled.
    recovered_value = db.execute(
        select(func.coalesce(func.sum(CartRecovery.recovered_value), 0))
        .join(Order, Order.id == CartRecovery.recovered_order_id)
        .where(*conditions, CartRecovery.status == "recovered", Order.status != "cancelled")
    ).scalar_one()
    recovered = by_status.get("recovered", 0)
    reminded = db.execute(select(func.count()).select_from(CartRecovery).where(
        *conditions, CartRecovery.reminders_sent > 0)).scalar_one()
    active_now = db.execute(select(func.count()).select_from(CartRecovery).where(
        CartRecovery.status == "abandoned")).scalar_one()
    return {
        "abandoned": abandoned_total,
        "openNow": active_now,
        "recovered": recovered,
        "reminded": reminded,
        "recoveryRate": round(100 * recovered / abandoned_total, 1) if abandoned_total else None,
        "potentialRevenue": billing.to_major(int(potential or 0)),
        "recoveredRevenue": billing.to_major(int(recovered_value or 0)),
        "byStatus": by_status,
    }


# ------------------------------------------------------------------ loop

INTERVAL_SECONDS = 300


def _sweep_once() -> None:
    from app.core.database import SessionLocal
    from app.services import accounts

    with SessionLocal() as db:
        try:
            sweep(db)
            # Spent and expired account links are cleared on the same beat.
            accounts.cleanup(db)
        except Exception:  # noqa: BLE001 — logged; the next pass tries again
            db.rollback()
            logger.exception("Abandoned-cart sweep failed; retrying next interval.")


async def run_forever() -> None:
    import asyncio

    logger.info("Abandoned-cart check running every %ss.", INTERVAL_SECONDS)
    while True:
        try:
            from app.services import jobs

            await asyncio.to_thread(jobs.tracked("cart_recovery", INTERVAL_SECONDS, _sweep_once))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Abandoned-cart sweep failed; retrying next interval.")
        await asyncio.sleep(INTERVAL_SECONDS)
