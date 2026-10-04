"""
Back-in-stock and price-drop alerts.

## When they fire

Both are checked against the product as it is now, not against a stream of
events — so nothing depends on every code path that changes stock or price
remembering to say so:

- **Stock**: an active alert fires when its product is listed (active) and
  has units available to sell (on hand minus held for unpaid orders).
- **Price**: an active alert fires when the selling price is below the price
  when the customer asked (`any`), or at or below their target (`target`).
  Only `price` counts: a new compare-at price, a description or stock level
  is not a price change.

The places that change stock and price call `process_product` right after
they commit, so customers hear quickly; `run_forever` re-checks every few
minutes, which catches anything else (a payment window expiring, a return
being restocked) and retries sends that couldn't go.

## Once per alert

An alert is one-shot. Firing queues one email, marks it `notified` and frees
the customer to subscribe again — so a product that sells out again, or gets
cheaper again, starts a fresh alert. The row is locked while it is checked,
so the immediate check and the sweep can't both send it. A price alert's
email is also recorded per price change, uniquely, as a second guard.

## Emails that can't go

If the store has no email account connected, or the customer has turned
these emails off, the alert stays active with the reason recorded, and is
tried again later (at most every `RETRY_AFTER`). Emails accepted for sending
are logged under `stock-alert-<id>` / `price-alert-<id>`; a delivery failure
or bounce shows there.
"""

from __future__ import annotations

import html as html_lib
import logging
from datetime import datetime, timedelta
from typing import List, Optional

from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings as app_settings
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import (
    Customer,
    EmailLog,
    PriceAlert,
    PriceAlertNotification,
    PriceChange,
    Product,
    StockAlert,
)
from app.services import billing

logger = logging.getLogger(__name__)

LISTED = ("active", "out-of-stock")
RETRY_AFTER = timedelta(minutes=30)
BATCH = 200
EMAIL_TYPE = "product_alerts"


# ----------------------------------------------------------------- helpers


def _product(db: Session, identifier: str) -> Product:
    from app.repositories import products as repo

    product = repo.get_by_identifier(db, identifier, published_only=True)
    if product is None:
        raise NotFoundError("That product is not available.", error_code="PRODUCT_NOT_FOUND")
    return product


def _variant(product: Product, size: Optional[str], color: Optional[str]) -> tuple:
    size = (size or "").strip()
    color = (color or "").strip()
    if size and size not in [s.label for s in product.sizes]:
        raise ValidationError(f"{product.name} doesn't come in {size}.", error_code="SIZE_UNAVAILABLE")
    if color and color not in [c.name for c in product.colors]:
        raise ValidationError(f"{product.name} doesn't come in {color}.", error_code="COLOR_UNAVAILABLE")
    return size, color


def is_available(product: Product) -> bool:
    return product.status == "active" and product.available_stock > 0


def _price(product: Product) -> int:
    return billing.to_minor(float(product.price))


def _link(product: Product, size: str = "", color: str = "") -> str:
    from urllib.parse import urlencode

    query = {k: v for k, v in (("size", size), ("color", color)) if v}
    suffix = f"?{urlencode(query)}" if query else ""
    return f"{app_settings.STOREFRONT_URL.rstrip('/')}/product/{product.slug}{suffix}"


def _money(minor: int) -> str:
    return f"₹{billing.to_major(minor):,.2f}"


# ------------------------------------------------------------ subscribing


def stock_view(alert: StockAlert, product: Optional[Product] = None) -> dict:
    product = product or alert_product(alert)
    return {
        "id": alert.id, "kind": "stock", "status": alert.status, "size": alert.size, "color": alert.color,
        "createdAt": alert.created_at, "notifiedAt": alert.notified_at, "unsubscribedAt": alert.unsubscribed_at,
        "product": _product_brief(product),
    }


def price_view(alert: PriceAlert, product: Optional[Product] = None) -> dict:
    product = product or alert_product(alert)
    return {
        "id": alert.id, "kind": "price", "status": alert.status, "mode": alert.mode,
        "baselinePrice": billing.to_major(alert.baseline_price),
        "targetPrice": billing.to_major(alert.target_price) if alert.target_price is not None else None,
        "notifiedPrice": billing.to_major(alert.notified_price) if alert.notified_price is not None else None,
        "createdAt": alert.created_at, "notifiedAt": alert.notified_at, "unsubscribedAt": alert.unsubscribed_at,
        "product": _product_brief(product),
    }


def alert_product(alert) -> Optional[Product]:
    from sqlalchemy.orm import object_session

    session = object_session(alert)
    return session.get(Product, alert.product_id) if session else None


def _product_brief(product: Optional[Product]) -> Optional[dict]:
    if product is None:
        return None
    from app.models.catalogue import images_for

    return {
        "id": product.id, "slug": product.slug, "name": product.name, "brand": product.brand,
        "image": next(iter(images_for(product)), ""), "price": float(product.price),
        "originalPrice": float(product.original_price), "available": is_available(product),
        "listed": product.status in LISTED,
    }


def subscribe_stock(db: Session, customer: Customer, product_id: str, *, size: str = "", color: str = "") -> tuple:
    """Returns (alert, created). An existing active alert for the same variant is returned, not duplicated."""
    product = _product(db, product_id)
    size, color = _variant(product, size, color)
    if is_available(product):
        raise ConflictError(f"{product.name} is in stock — you can buy it now.", error_code="IN_STOCK")

    existing = db.execute(select(StockAlert).where(
        StockAlert.customer_id == customer.id, StockAlert.product_id == product.id, StockAlert.size == size,
        StockAlert.color == color, StockAlert.status == "active",
    )).scalar_one_or_none()
    if existing is not None:
        return existing, False

    now = datetime.utcnow()
    alert = StockAlert(customer_id=customer.id, product_id=product.id, size=size, color=color, status="active",
                       active_key=1, created_at=now, updated_at=now)
    db.add(alert)
    try:
        db.commit()
    except IntegrityError:
        # The same request twice at once: the other one made it.
        db.rollback()
        existing = db.execute(select(StockAlert).where(
            StockAlert.customer_id == customer.id, StockAlert.product_id == product.id, StockAlert.size == size,
            StockAlert.color == color, StockAlert.status == "active",
        )).scalar_one()
        return existing, False
    db.refresh(alert)
    return alert, True


def subscribe_price(db: Session, customer: Customer, product_id: str, *, mode: str = "any",
                    target_price: Optional[float] = None) -> tuple:
    """
    Returns (alert, created). Asking again while one is active updates its
    trigger rather than adding a second alert.
    """
    product = _product(db, product_id)
    if mode not in ("any", "target"):
        raise ValidationError("Choose any price drop, or a target price.", error_code="INVALID_MODE")
    current = _price(product)
    target = None
    if mode == "target":
        if target_price is None:
            raise ValidationError("Enter the price you'd like to pay.", error_code="TARGET_REQUIRED")
        try:
            target = billing.to_minor(float(target_price))
        except (TypeError, ValueError):
            raise ValidationError("Enter a price in rupees.", error_code="INVALID_TARGET") from None
        if target <= 0:
            raise ValidationError("Enter a price above zero.", error_code="INVALID_TARGET")
        if target >= current:
            raise ValidationError(
                f"Your target needs to be below today's price of {_money(current)}.", error_code="TARGET_NOT_BELOW"
            )

    now = datetime.utcnow()
    existing = db.execute(select(PriceAlert).where(
        PriceAlert.customer_id == customer.id, PriceAlert.product_id == product.id, PriceAlert.status == "active",
    ).with_for_update()).scalar_one_or_none()
    if existing is not None:
        existing.mode, existing.target_price = mode, target
        existing.baseline_price = current
        existing.updated_at = now
        db.commit()
        return existing, False

    alert = PriceAlert(customer_id=customer.id, product_id=product.id, mode=mode, baseline_price=current,
                       target_price=target, status="active", active_key=1, created_at=now, updated_at=now)
    db.add(alert)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return db.execute(select(PriceAlert).where(
            PriceAlert.customer_id == customer.id, PriceAlert.product_id == product.id, PriceAlert.status == "active",
        )).scalar_one(), False
    db.refresh(alert)
    return alert, True


def _own(db: Session, model, customer: Customer, alert_id: int):
    alert = db.get(model, alert_id)
    if alert is None or alert.customer_id != customer.id:
        raise NotFoundError("We couldn't find that alert.", error_code="ALERT_NOT_FOUND")
    return alert


def unsubscribe(db: Session, customer: Customer, kind: str, alert_id: int):
    model = StockAlert if kind == "stock" else PriceAlert
    alert = _own(db, model, customer, alert_id)
    if alert.status == "active":
        now = datetime.utcnow()
        alert.status, alert.active_key, alert.unsubscribed_at, alert.updated_at = "unsubscribed", None, now, now
        db.commit()
    return alert


def for_product(db: Session, customer: Customer, product_id: str) -> dict:
    """This customer's active alerts on one product — for the product page's buttons."""
    product = _product(db, product_id)
    stock = db.execute(select(StockAlert).where(
        StockAlert.customer_id == customer.id, StockAlert.product_id == product.id, StockAlert.status == "active",
    )).scalars().all()
    price = db.execute(select(PriceAlert).where(
        PriceAlert.customer_id == customer.id, PriceAlert.product_id == product.id, PriceAlert.status == "active",
    )).scalar_one_or_none()
    return {
        "stock": [stock_view(a, product) for a in stock],
        "price": price_view(price, product) if price else None,
    }


def mine(db: Session, customer: Customer, *, include_closed: bool = True) -> dict:
    conditions_stock = [StockAlert.customer_id == customer.id]
    conditions_price = [PriceAlert.customer_id == customer.id]
    if not include_closed:
        conditions_stock.append(StockAlert.status == "active")
        conditions_price.append(PriceAlert.status == "active")
    stock = db.execute(select(StockAlert).where(*conditions_stock).order_by(StockAlert.id.desc()).limit(200)).scalars().all()
    price = db.execute(select(PriceAlert).where(*conditions_price).order_by(PriceAlert.id.desc()).limit(200)).scalars().all()
    ids = {a.product_id for a in stock} | {a.product_id for a in price}
    products = {p.id: p for p in db.execute(select(Product).where(Product.id.in_(ids))).scalars()} if ids else {}
    return {
        "stock": [stock_view(a, products.get(a.product_id)) for a in stock],
        "price": [price_view(a, products.get(a.product_id)) for a in price],
    }


# ------------------------------------------------------------- notifying


def _send_stock(db: Session, alert: StockAlert, product: Product, customer: Customer) -> bool:
    from app.services import email as email_service

    esc = html_lib.escape
    variant = " · ".join(v for v in (alert.size, alert.color) if v)
    name = esc(product.name) + (f" ({esc(variant)})" if variant else "")
    intro = (f"Hello {esc(customer.first_name or 'there')}, good news — <strong>{name}</strong> is back in stock "
             f"at {_money(_price(product))}. Popular pieces go quickly, so don't wait too long.")
    footnote = ("You asked us to tell you when this was back. This alert has now been used — you can set "
                "another on the product page, and turn these emails off in your account settings.")
    from app.services.email import templates

    card = templates.products([{"name": product.name, "url": _link(product, alert.size, alert.color),
                                "image": email_service.product_image(product, alert.color or ""),
                                "price": _money(_price(product)), "detail": variant, "badge": "Back in stock",
                                "tone": "success", "cta": "Shop it now"}])
    html = email_service.layout(f"{product.name} is back", intro, card,
                                cta=("Shop it now", _link(product, alert.size, alert.color)), footnote=footnote,
                                tone="success", icon="bell", eyebrow="Back in stock",
                                secondary=[("Your alerts", email_service.link("/account/alerts")),
                                           ("Your wishlist", email_service.link("/account/wishlist"))])
    text = f"{product.name}{f' ({variant})' if variant else ''} is back in stock: {_link(product, alert.size, alert.color)}"
    return email_service.notify(db, EMAIL_TYPE, to=customer.email, customer_id=customer.id,
                                subject=f"Back in stock: {product.name}", html=html, text=text,
                                reference=f"stock-alert-{alert.id}")


def _send_price(db: Session, alert: PriceAlert, product: Product, customer: Customer, was: int, now_price: int) -> bool:
    from app.services import email as email_service

    esc = html_lib.escape
    saving = was - now_price
    intro = (f"Hello {esc(customer.first_name or 'there')}, <strong>{esc(product.name)}</strong> is now "
             f"<strong>{_money(now_price)}</strong> — down from {_money(was)}, a saving of {_money(saving)}.")
    if alert.mode == "target" and alert.target_price is not None:
        intro += f" That's at or below the {_money(alert.target_price)} you were waiting for."
    footnote = ("You asked us to tell you when this got cheaper. Prices can change again, and this alert has now "
                "been used — set another on the product page any time.")
    from app.services.email import templates

    percent = round(saving / was * 100) if was else 0
    body = (templates.stats([("Now", _money(now_price)), ("Was", _money(was)),
                             ("You save", _money(saving), f"{percent}% off" if percent else "")], tone="success")
            + templates.products([{"name": product.name, "url": _link(product),
                                   "image": email_service.product_image(product), "price": _money(now_price),
                                   "was": _money(was), "badge": f"{percent}% off" if percent else "Price drop",
                                   "tone": "success", "cta": "See it now"}]))
    html = email_service.layout("A price you've been waiting for", intro, body, cta=("See it now", _link(product)),
                                footnote=footnote, tone="success", icon="tag", eyebrow="Price drop",
                                secondary=[("Your alerts", email_service.link("/account/alerts"))])
    text = f"{product.name} is now {_money(now_price)} (was {_money(was)}): {_link(product)}"
    return email_service.notify(db, EMAIL_TYPE, to=customer.email, customer_id=customer.id,
                                subject=f"Price drop: {product.name} is now {_money(now_price)}", html=html, text=text,
                                reference=f"price-alert-{alert.id}")


def _why_not_sent(db: Session, customer: Customer) -> str:
    from app.services import email as email_service

    if not email_service.wants(db, EMAIL_TYPE, customer.id):
        return "Not emailed: stock and price alerts are turned off in the customer's email preferences."
    if email_service.active_account(db) is None:
        return "Not emailed: no email account is connected for the store."
    return "Not emailed: the email couldn't be queued."


def _due(alert, now: datetime) -> bool:
    return alert.last_attempt_at is None or now - alert.last_attempt_at >= RETRY_AFTER


def _fire_stock(db: Session, alert_id: int, now: datetime, *, force: bool = False) -> str:
    """Check and send one stock alert, under a lock. Returns what happened."""
    alert = db.execute(select(StockAlert).where(StockAlert.id == alert_id).with_for_update()).scalar_one_or_none()
    if alert is None or alert.status != "active":
        return "closed"
    product = db.get(Product, alert.product_id)
    customer = db.get(Customer, alert.customer_id)
    if product is None or not is_available(product):
        return "unavailable"
    if customer is None or customer.status != "active":
        return "inactive-customer"
    if not force and not _due(alert, now):
        return "waiting"
    alert.attempts += 1
    alert.last_attempt_at = now
    alert.updated_at = now
    if _send_stock(db, alert, product, customer):
        alert.status, alert.active_key, alert.notified_at, alert.last_error = "notified", None, now, ""
        return "sent"
    alert.last_error = _why_not_sent(db, customer)[:300]
    return "not-sent"


def _price_hit(alert: PriceAlert, price: int) -> bool:
    if alert.mode == "target":
        return alert.target_price is not None and price <= alert.target_price
    return price < alert.baseline_price


def _fire_price(db: Session, alert_id: int, now: datetime, *, change: Optional[PriceChange] = None,
                force: bool = False) -> str:
    alert = db.execute(select(PriceAlert).where(PriceAlert.id == alert_id).with_for_update()).scalar_one_or_none()
    if alert is None or alert.status != "active":
        return "closed"
    product = db.get(Product, alert.product_id)
    customer = db.get(Customer, alert.customer_id)
    if product is None or product.status not in LISTED:
        return "unavailable"
    price = _price(product)
    if not _price_hit(alert, price):
        return "no-drop"
    if customer is None or customer.status != "active":
        return "inactive-customer"
    if not force and not _due(alert, now):
        return "waiting"
    if change is None:
        change = db.execute(select(PriceChange).where(PriceChange.product_id == product.id)
                            .order_by(PriceChange.id.desc()).limit(1)).scalar_one_or_none()
    if change is not None:
        seen = db.execute(select(PriceAlertNotification.id).where(
            PriceAlertNotification.alert_id == alert.id, PriceAlertNotification.price_change_id == change.id,
            PriceAlertNotification.outcome == "queued",
        )).first()
        if seen:
            # Already emailed about this very change; just close the alert.
            alert.status, alert.active_key = "notified", None
            return "duplicate"
    alert.attempts += 1
    alert.last_attempt_at = now
    alert.updated_at = now
    was = alert.baseline_price
    sent = _send_price(db, alert, product, customer, was, price)
    note = "" if sent else _why_not_sent(db, customer)[:300]
    if change is not None:
        record = db.execute(select(PriceAlertNotification).where(
            PriceAlertNotification.alert_id == alert.id, PriceAlertNotification.price_change_id == change.id,
        )).scalar_one_or_none()
        if record is None:
            db.add(PriceAlertNotification(alert_id=alert.id, price_change_id=change.id, from_price=was, to_price=price,
                                          outcome="queued" if sent else "not-sent", note=note, created_at=now))
        else:
            record.outcome, record.note, record.to_price = ("queued" if sent else "not-sent"), note, price
    elif sent:
        db.add(PriceAlertNotification(alert_id=alert.id, price_change_id=None, from_price=was, to_price=price,
                                      outcome="queued", note="", created_at=now))
    if sent:
        alert.status, alert.active_key, alert.notified_at = "notified", None, now
        alert.notified_price, alert.last_error = price, ""
        if change is not None:
            change.alerts_notified = (change.alerts_notified or 0) + 1
        return "sent"
    alert.last_error = note
    return "not-sent"


def record_price_change(db: Session, product: Product, *, old_price: float, old_original: float,
                        actor: str = "system") -> Optional[PriceChange]:
    """Called by the product service before it commits. Only a moved selling price is recorded."""
    old, new = billing.to_minor(float(old_price)), _price(product)
    if old == new:
        return None
    change = PriceChange(product_id=product.id, old_price=old, new_price=new,
                         old_original_price=billing.to_minor(float(old_original)),
                         new_original_price=billing.to_minor(float(product.original_price)),
                         changed_by=(actor or "system")[:40], created_at=datetime.utcnow())
    db.add(change)
    return change


def process_product(db: Session, product_id: str, *, change_id: Optional[int] = None) -> dict:
    """
    Check one product's alerts now. Called right after a stock or price change
    commits; never raises — the sweep will try again.
    """
    counts = {"stock": 0, "price": 0}
    try:
        now = datetime.utcnow()
        change = db.get(PriceChange, change_id) if change_id else None
        stock_ids = db.execute(select(StockAlert.id).where(
            StockAlert.product_id == product_id, StockAlert.status == "active").limit(BATCH * 5)).scalars().all()
        for alert_id in stock_ids:
            if _fire_stock(db, alert_id, now) == "sent":
                counts["stock"] += 1
        price_ids = db.execute(select(PriceAlert.id).where(
            PriceAlert.product_id == product_id, PriceAlert.status == "active").limit(BATCH * 5)).scalars().all()
        for alert_id in price_ids:
            if _fire_price(db, alert_id, now, change=change) == "sent":
                counts["price"] += 1
        db.commit()
    except Exception:  # noqa: BLE001 — logged; the sweep retries
        db.rollback()
        logger.exception("Alert check failed for product %s", product_id)
    return counts


def sweep(db: Session, now: Optional[datetime] = None) -> dict:
    """Every active alert whose product now qualifies, a batch at a time."""
    now = now or datetime.utcnow()
    counts = {"stock": 0, "price": 0}
    available = select(Product.id).where(Product.status == "active", Product.stock - Product.reserved_stock > 0)
    stock_ids = db.execute(select(StockAlert.id).where(
        StockAlert.status == "active", StockAlert.product_id.in_(available),
        or_(StockAlert.last_attempt_at.is_(None), StockAlert.last_attempt_at <= now - RETRY_AFTER),
    ).order_by(StockAlert.id).limit(BATCH)).scalars().all()
    for alert_id in stock_ids:
        try:
            if _fire_stock(db, alert_id, now) == "sent":
                counts["stock"] += 1
            db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
            logger.exception("Stock alert %s failed", alert_id)

    price_minor = func.round(Product.price * 100)
    qualifying = select(Product.id).where(Product.status.in_(LISTED))
    price_ids = db.execute(
        select(PriceAlert.id).join(Product, Product.id == PriceAlert.product_id).where(
            PriceAlert.status == "active", PriceAlert.product_id.in_(qualifying),
            or_(PriceAlert.last_attempt_at.is_(None), PriceAlert.last_attempt_at <= now - RETRY_AFTER),
            or_(and_(PriceAlert.mode == "any", price_minor < PriceAlert.baseline_price),
                and_(PriceAlert.mode == "target", price_minor <= PriceAlert.target_price)),
        ).order_by(PriceAlert.id).limit(BATCH)
    ).scalars().all()
    for alert_id in price_ids:
        try:
            if _fire_price(db, alert_id, now) == "sent":
                counts["price"] += 1
            db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
            logger.exception("Price alert %s failed", alert_id)
    return counts


# ------------------------------------------------------------------ admin


def _deliveries(db: Session, references: List[str]) -> dict:
    """The latest email-log entry for each alert reference: sent, failed (and why), or none."""
    if not references:
        return {}
    rows = db.execute(select(EmailLog).where(EmailLog.reference.in_(references)).order_by(EmailLog.id)).scalars().all()
    out: dict = {}
    for row in rows:
        entry = out.setdefault(row.reference, {"count": 0})
        entry.update({"status": row.status, "error": row.error, "at": row.created_at, "count": entry["count"] + 1})
    return out


def admin_search(db: Session, kind: str, *, status: str = "", q: str = "", product_id: str = "",
                 customer_id: str = "", page: int = 1, page_size: int = 25) -> tuple:
    """
    The portal's alert list. Alerts are found by ID only (docs/id-lookup.md):
    `product_id` is a Product ID or SKU, `customer_id` a Customer ID, and `q` either
    of those — each matched exactly, never a name, an email or part of one.
    """
    from app.services.lookup.filters import any_id_condition, id_condition

    model = StockAlert if kind == "stock" else PriceAlert
    conditions = []
    if status in ("active", "notified", "unsubscribed"):
        conditions.append(model.status == status)
    elif status == "failing":
        conditions.append(and_(model.status == "active", model.last_error != ""))
    for condition in (
        id_condition("product", product_id, column=model.product_id, via=Product.id),
        id_condition("customer", customer_id, column=model.customer_id, via=Customer.id),
        any_id_condition(q, ("customer", model.customer_id, Customer.id), ("product", model.product_id, Product.id)),
    ):
        if condition is not None:
            conditions.append(condition)
    total = db.execute(select(func.count()).select_from(model).where(*conditions)).scalar_one()
    rows = db.execute(select(model).where(*conditions).order_by(model.id.desc())
                      .offset((max(1, page) - 1) * page_size).limit(page_size)).scalars().all()
    counts = dict(db.execute(select(model.status, func.count()).group_by(model.status)).all())
    customers = {c.id: c for c in db.execute(select(Customer).where(
        Customer.id.in_({r.customer_id for r in rows}))).scalars()} if rows else {}
    products = {p.id: p for p in db.execute(select(Product).where(
        Product.id.in_({r.product_id for r in rows}))).scalars()} if rows else {}
    prefix = "stock-alert" if kind == "stock" else "price-alert"
    deliveries = _deliveries(db, [f"{prefix}-{r.id}" for r in rows])
    items = []
    for row in rows:
        view = stock_view(row, products.get(row.product_id)) if kind == "stock" else price_view(row, products.get(row.product_id))
        customer = customers.get(row.customer_id)
        view.update({
            "customer": {"id": customer.id, "name": customer.full_name, "email": customer.email} if customer else None,
            "attempts": row.attempts, "lastAttemptAt": row.last_attempt_at, "lastError": row.last_error,
            "delivery": deliveries.get(f"{prefix}-{row.id}"),
        })
        if kind == "price":
            view["history"] = [{"fromPrice": billing.to_major(n.from_price), "toPrice": billing.to_major(n.to_price),
                                "outcome": n.outcome, "note": n.note, "at": n.created_at} for n in row.notifications]
        items.append(view)
    return items, total, counts


def admin_resend(db: Session, kind: str, alert_id: int) -> str:
    """
    Send an alert's email again — one that couldn't go, or one that went but
    bounced. Only while the reason still holds: an item that is out of stock
    again, or a price that went back up, isn't announced.
    """
    now = datetime.utcnow()
    model = StockAlert if kind == "stock" else PriceAlert
    alert = db.execute(select(model).where(model.id == alert_id).with_for_update()).scalar_one_or_none()
    if alert is None:
        raise NotFoundError("No such alert.", error_code="ALERT_NOT_FOUND")
    if alert.status == "unsubscribed":
        raise ConflictError("The customer unsubscribed from this alert.", error_code="ALERT_UNSUBSCRIBED")
    product = db.get(Product, alert.product_id)
    customer = db.get(Customer, alert.customer_id)
    if customer is None or customer.status != "active":
        raise ConflictError("The customer's account isn't active.", error_code="CUSTOMER_INACTIVE")

    if alert.status == "active":
        outcome = (_fire_stock(db, alert.id, now, force=True) if kind == "stock"
                   else _fire_price(db, alert.id, now, force=True))
        db.commit()
        if outcome in ("unavailable", "no-drop"):
            raise ConflictError("It isn't due yet: " + ("the product isn't back in stock." if kind == "stock"
                                else "the price hasn't dropped to the customer's trigger."), error_code="NOT_DUE")
        return outcome

    # Already notified: send the same news again, if it's still true.
    if kind == "stock":
        if product is None or not is_available(product):
            raise ConflictError("The product is out of stock again, so the alert isn't resent.", error_code="NOT_DUE")
        sent = _send_stock(db, alert, product, customer)
    else:
        if product is None or product.status not in LISTED or not _price_hit(alert, _price(product)):
            raise ConflictError("The price has gone back up, so the alert isn't resent.", error_code="NOT_DUE")
        sent = _send_price(db, alert, product, customer, alert.baseline_price, _price(product))
        if sent:
            db.add(PriceAlertNotification(alert_id=alert.id, price_change_id=None, from_price=alert.baseline_price,
                                          to_price=_price(product), outcome="resent", note="Resent from the portal.",
                                          created_at=now))
    alert.attempts += 1
    alert.last_attempt_at = now
    alert.last_error = "" if sent else _why_not_sent(db, customer)[:300]
    db.commit()
    if not sent:
        raise ConflictError(alert.last_error, error_code="NOT_SENT")
    return "sent"


# ------------------------------------------------------------------ loop

INTERVAL_SECONDS = 120


def _sweep_once() -> None:
    from app.core.database import SessionLocal

    with SessionLocal() as db:
        try:
            sweep(db)
        except Exception:  # noqa: BLE001 — logged; the next pass tries again
            db.rollback()
            logger.exception("Alert sweep failed; retrying next interval.")


async def run_forever() -> None:
    import asyncio

    logger.info("Stock and price alerts checked every %ss.", INTERVAL_SECONDS)
    while True:
        try:
            from app.services import jobs

            await asyncio.to_thread(jobs.tracked("alerts", INTERVAL_SECONDS, _sweep_once))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Alert sweep failed; retrying next interval.")
        await asyncio.sleep(INTERVAL_SECONDS)
