"""
Storefront events for the conversion funnel.

Only what no other table can tell us is recorded here: a visit, a product
viewed, checkout opened (sent by the browser), and an item added to the bag
(recorded by the server when it happens — the bag itself forgets removed
lines). Orders, payments, revenue and customers are always read from their own
tables; nothing the browser sends ever becomes a sales figure.

What the browser sends is checked and bounded: a known event name, a product
that exists, a random visitor id that is hashed before it is stored (so it
can't be matched to anything outside this table), and at most one visit per
visitor a day and one view per product per visitor every half hour — so
reloading a page, or a script posting the same event, doesn't inflate the
numbers. Requests from obvious bots are dropped.
"""

from __future__ import annotations

import hashlib
import hmac
import re
from datetime import datetime, timedelta
from typing import Optional
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import AnalyticsEvent, Product

CLIENT_EVENTS = {"visit", "product_view", "checkout_start"}
SERVER_EVENTS = {"add_to_cart"}
DEDUPE = {"visit": timedelta(hours=24), "product_view": timedelta(minutes=30), "checkout_start": timedelta(minutes=30)}
_BOT = re.compile(r"bot|crawl|spider|slurp|headless|lighthouse|preview|monitor|curl|wget|python-requests", re.I)
_VISITOR = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def _hash(value: str) -> str:
    key = f"analytics:{settings.JWT_SECRET_KEY}".encode()
    return hmac.new(key, value.encode(), hashlib.sha256).hexdigest()[:40]


def visitor_key(visitor_id: str = "", customer_id: Optional[str] = None) -> str:
    """The stored visitor id: the signed-in customer when known, otherwise the browser's id — hashed either way."""
    return _hash(f"c:{customer_id}" if customer_id else f"v:{visitor_id}")


def device_of(user_agent: str) -> str:
    agent = (user_agent or "").lower()
    if "ipad" in agent or "tablet" in agent:
        return "tablet"
    if "mobi" in agent or "android" in agent or "iphone" in agent:
        return "mobile"
    return "desktop" if agent else ""


def source_of(referrer: str = "", utm_source: str = "") -> str:
    if utm_source:
        return re.sub(r"[^a-z0-9._-]", "", utm_source.lower())[:60]
    host = (urlsplit(referrer).hostname or "").lower() if referrer else ""
    own = (urlsplit(settings.STOREFRONT_URL).hostname or "").lower()
    if not host or host == own:
        return "direct" if not host else ""
    return host.removeprefix("www.")[:60]


def _seen(db: Session, event: str, visitor: str, product_id: Optional[str], since: datetime) -> bool:
    conditions = [AnalyticsEvent.event == event, AnalyticsEvent.visitor_id == visitor,
                  AnalyticsEvent.occurred_at >= since]
    if product_id:
        conditions.append(AnalyticsEvent.product_id == product_id)
    return db.execute(select(AnalyticsEvent.id).where(*conditions).limit(1)).first() is not None


def client_event(db: Session, *, event: str, visitor_id: str, customer_id: Optional[str], product_id: Optional[str],
                 user_agent: str, referrer: str = "", utm_source: str = "") -> bool:
    """Record one event sent by the storefront. Returns whether it was kept."""
    if event not in CLIENT_EVENTS or not _VISITOR.match(visitor_id or ""):
        return False
    if _BOT.search(user_agent or ""):
        return False
    product = None
    if event == "product_view":
        product = db.get(Product, product_id) if product_id else None
        if product is None or product.status not in ("active", "out-of-stock"):
            return False
    # The visit is keyed by the browser even when signed in, so signing in
    # halfway through doesn't count the same person twice.
    visitor = visitor_key(visitor_id)
    now = datetime.utcnow()
    if _seen(db, event, visitor, product.id if product else None, now - DEDUPE[event]):
        return False
    db.add(AnalyticsEvent(
        occurred_at=now, event=event, visitor_id=visitor, customer_id=customer_id,
        product_id=product.id if product else None, quantity=0,
        source=source_of(referrer, utm_source) if event == "visit" else "",
        device=device_of(user_agent),
    ))
    db.commit()
    return True


def server_event(db: Session, event: str, *, customer_id: Optional[str], product_id: Optional[str] = None,
                 quantity: int = 0) -> None:
    """An event the server saw happen. Added to the caller's transaction."""
    if event not in SERVER_EVENTS:
        return
    db.add(AnalyticsEvent(occurred_at=datetime.utcnow(), event=event,
                          visitor_id=visitor_key(customer_id=customer_id) if customer_id else "",
                          customer_id=customer_id, product_id=product_id, quantity=max(0, int(quantity)),
                          source="", device=""))
