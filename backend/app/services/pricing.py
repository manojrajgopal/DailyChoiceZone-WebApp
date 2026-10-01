"""
What each line in a bag costs, and why.

**One price per line, by a fixed order of precedence:**

1. A **bundle** component is priced as part of its bundle — the bundle price
   shared across its components in proportion to their regular prices. Flash
   sale prices don't apply inside a bundle.
2. Otherwise a product in a **live flash sale** costs the sale price — while
   the sale has units left at that price, and only if it is lower than the
   product's own price.
3. Otherwise the product's own **catalogue price**.

Coupons and the membership discount are order-level and come afterwards, in
`billing.calculate`, as they always did — except that a coupon can't be used
on an order with items from a flash sale that doesn't allow coupons.

Everything here is recalculated on the server from the catalogue, the sale
and the bundle as they are now. The product page, the bag and checkout all
call the same functions, so the price shown is the price charged; checkout
additionally locks the sale's rows (`enforce=True`) so two shoppers can't buy
the last sale unit twice, and refuses — rather than silently repricing — when
the sale price can no longer be honoured.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional, Sequence

from sqlalchemy import case, event, func, select
from sqlalchemy.orm import Session, object_session

from app.core.errors import ConflictError, ValidationError
from app.services import billing

LIVE_CLAIMS = ("reserved", "consumed")
_CACHE_KEY = "pricing.flash_offers"
_CACHE_SECONDS = 3


# ------------------------------------------------------------ flash offers


@dataclass
class FlashOffer:
    sale_id: int
    item_id: int
    sale_name: str
    product_id: str
    sale_price: int  # paise
    starts_at: datetime
    ends_at: datetime
    stock_limit: Optional[int]
    sold: int
    per_customer_limit: Optional[int]
    allow_coupons: bool

    @property
    def remaining(self) -> Optional[int]:
        return None if self.stock_limit is None else max(0, self.stock_limit - self.sold)

    def view(self, regular_price: int) -> dict:
        return {
            "saleId": self.sale_id,
            "itemId": self.item_id,
            "name": self.sale_name,
            "price": billing.to_major(self.sale_price),
            "regularPrice": billing.to_major(regular_price),
            "startsAt": self.starts_at,
            "endsAt": self.ends_at,
            "stockLimit": self.stock_limit,
            "remaining": self.remaining,
            "perCustomerLimit": self.per_customer_limit,
            "allowCoupons": self.allow_coupons,
        }


def _load_offers(db: Session, now: datetime) -> Dict[str, FlashOffer]:
    from app.models import FlashSale, FlashSaleClaim, FlashSaleItem

    rows = db.execute(
        select(FlashSaleItem, FlashSale)
        .join(FlashSale, FlashSale.id == FlashSaleItem.sale_id)
        .where(FlashSale.status == "published", FlashSale.starts_at <= now, FlashSale.ends_at > now)
    ).all()
    if not rows:
        return {}
    item_ids = [item.id for item, _ in rows]
    sold = dict(db.execute(
        select(FlashSaleClaim.item_id, func.coalesce(func.sum(FlashSaleClaim.quantity), 0))
        .where(FlashSaleClaim.item_id.in_(item_ids), FlashSaleClaim.state.in_(LIVE_CLAIMS))
        .group_by(FlashSaleClaim.item_id)
    ).all())
    offers: Dict[str, FlashOffer] = {}
    for item, sale in rows:
        offers[item.product_id] = FlashOffer(
            sale_id=sale.id, item_id=item.id, sale_name=sale.name, product_id=item.product_id,
            sale_price=billing.to_minor(float(item.sale_price)), starts_at=sale.starts_at, ends_at=sale.ends_at,
            stock_limit=item.stock_limit, sold=int(sold.get(item.id, 0)),
            per_customer_limit=item.per_customer_limit, allow_coupons=bool(sale.allow_coupons),
        )
    return offers


def live_offers(db: Session, now: Optional[datetime] = None) -> Dict[str, FlashOffer]:
    """
    Every product in a live flash sale, by product id. Read once and kept on
    the session for a few seconds — a page of forty product cards asks forty
    times — and dropped whenever the session commits or rolls back.
    """
    if now is not None:
        return _load_offers(db, now)
    cached = db.info.get(_CACHE_KEY)
    if cached and cached[0] > time.monotonic():
        return cached[1]
    offers = _load_offers(db, datetime.utcnow())
    db.info[_CACHE_KEY] = (time.monotonic() + _CACHE_SECONDS, offers)
    return offers


def forget_offers(db: Session) -> None:
    db.info.pop(_CACHE_KEY, None)


@event.listens_for(Session, "after_commit")
@event.listens_for(Session, "after_rollback")
def _drop_cache(session: Session) -> None:
    session.info.pop(_CACHE_KEY, None)


def offer_applies(offer: Optional[FlashOffer], product) -> bool:
    """A sale price that is lower than the product's own, with units left at it."""
    if offer is None:
        return False
    if offer.sale_price >= billing.to_minor(float(product.price)):
        return False
    return offer.remaining is None or offer.remaining > 0


def offer_for(product, db: Optional[Session] = None) -> Optional[FlashOffer]:
    """The flash sale price that applies to a product right now, if any."""
    db = db or object_session(product)
    if db is None:
        return None
    offer = live_offers(db).get(product.id)
    return offer if offer_applies(offer, product) else None


def claimed_by(db: Session, customer_id: str, item_ids: Sequence[int]) -> Dict[int, int]:
    """Units each sale item has already sold to this customer (held or paid)."""
    from app.models import FlashSaleClaim

    if not item_ids or not customer_id:
        return {}
    return {
        int(item_id): int(qty)
        for item_id, qty in db.execute(
            select(FlashSaleClaim.item_id, func.coalesce(func.sum(FlashSaleClaim.quantity), 0))
            .where(FlashSaleClaim.customer_id == customer_id, FlashSaleClaim.item_id.in_(list(item_ids)),
                   FlashSaleClaim.state.in_(LIVE_CLAIMS))
            .group_by(FlashSaleClaim.item_id)
        ).all()
    }


def _lock_offers(db: Session, offers: List[FlashOffer], customer_id: str) -> Dict[int, tuple]:
    """
    Lock the sale items, then count what they have sold — in total and to this
    customer — with a locking read, so the count is the committed truth and not
    this transaction's older snapshot. Returns {item_id: (sold, by_customer)}.
    """
    from app.models import FlashSale, FlashSaleClaim, FlashSaleItem

    ids = sorted({offer.item_id for offer in offers})
    if not ids:
        return {}
    now = datetime.utcnow()
    live = {
        row.id for row in db.execute(
            select(FlashSaleItem).join(FlashSale, FlashSale.id == FlashSaleItem.sale_id)
            .where(FlashSaleItem.id.in_(ids), FlashSale.status == "published", FlashSale.starts_at <= now,
                   FlashSale.ends_at > now)
            .order_by(FlashSaleItem.id).with_for_update(of=FlashSaleItem)
            .execution_options(populate_existing=True)
        ).scalars().all()
    }
    counts = {
        int(item_id): (int(total or 0), int(mine or 0))
        for item_id, total, mine in db.execute(
            select(
                FlashSaleClaim.item_id,
                func.sum(FlashSaleClaim.quantity),
                func.sum(case((FlashSaleClaim.customer_id == customer_id, FlashSaleClaim.quantity), else_=0)),
            )
            .where(FlashSaleClaim.item_id.in_(ids), FlashSaleClaim.state.in_(LIVE_CLAIMS))
            .group_by(FlashSaleClaim.item_id)
            .with_for_update(read=True)
        ).all()
    }
    return {item_id: counts.get(item_id, (0, 0)) for item_id in live}


# ----------------------------------------------------------------- bundles


@dataclass
class BundleQuote:
    regular_total: int  # paise, the components at their catalogue prices
    price: int  # paise, what the bundle costs (the sum of the component shares)
    unit_prices: Dict[str, int]  # product id -> paise per unit inside the bundle
    available: int  # how many bundles the components' stock allows
    reason: str = ""  # why it can't be bought, if it can't

    @property
    def saving(self) -> int:
        return max(0, self.regular_total - self.price)


def bundle_window_open(bundle, now: Optional[datetime] = None) -> bool:
    now = now or datetime.utcnow()
    if bundle.status != "active":
        return False
    if bundle.starts_at and bundle.starts_at > now:
        return False
    return not (bundle.ends_at and bundle.ends_at <= now)


def quote_bundle(bundle, products: Dict[str, object], now: Optional[datetime] = None) -> BundleQuote:
    """
    What a bundle costs and how many can be sold, from its components as they
    are now.

    The bundle price is shared across the components in proportion to their
    regular prices (`billing.allocate`, so the shares add up exactly), then
    each share is turned into a per-unit price. A share that doesn't divide by
    its quantity is rounded down to the paisa, so the bundle can come out a
    few paise under its configured price — never over — and the price shown is
    always exactly the sum of what the lines charge.
    """
    components = [(item, products.get(item.product_id)) for item in bundle.items]
    reason = ""
    if not components:
        reason = "This bundle has nothing in it."
    regular, weights = 0, []
    available = None
    for item, product in components:
        if product is None or product.status not in ("active", "out-of-stock"):
            reason = reason or "Something in this bundle is no longer sold."
            weights.append(0)
            available = 0
            continue
        unit = billing.to_minor(float(product.price))
        regular += unit * item.quantity
        weights.append(unit * item.quantity)
        can = max(0, product.available_stock) // max(1, item.quantity)
        available = can if available is None else min(available, can)
    available = available or 0

    if bundle.pricing == "percent":
        target = regular - billing.percent_of(regular, float(bundle.discount_percent or 0))
    else:
        target = billing.to_minor(float(bundle.price or 0))
    target = max(0, min(target, regular))

    shares = billing.allocate(target, weights) if weights else []
    unit_prices: Dict[str, int] = {}
    total = 0
    for (item, product), share in zip(components, shares):
        per_unit = share // max(1, item.quantity)
        unit_prices[item.product_id] = per_unit
        total += per_unit * item.quantity
    # The paise lost to rounding go to a component whose quantity divides
    # them (one bought singly always does), so the bundle costs exactly its
    # price. Only when no component can take them is it a few paise under.
    leftover = target - total
    for item, product in sorted(components, key=lambda c: c[0].quantity):
        if leftover <= 0:
            break
        if product is not None and item.product_id in unit_prices and leftover % max(1, item.quantity) == 0:
            unit_prices[item.product_id] += leftover // max(1, item.quantity)
            total += leftover
            leftover = 0

    if not reason and not bundle_window_open(bundle, now):
        reason = "This bundle isn't available right now."
    if not reason and available <= 0:
        reason = "This bundle is sold out."
    return BundleQuote(regular_total=regular, price=total, unit_prices=unit_prices, available=available,
                       reason=reason)


def selection_key(selections: List[dict]) -> str:
    canonical = sorted(
        ({"p": s.get("productId", ""), "s": s.get("size") or "", "c": s.get("color") or ""} for s in selections),
        key=lambda s: s["p"],
    )
    return hashlib.sha256(json.dumps(canonical, sort_keys=True).encode()).hexdigest()


# -------------------------------------------------------------- the bag


@dataclass
class PricedLine:
    line: billing.BillingLine
    product: object
    regular_unit: int  # paise
    cart_item: object = None
    cart_bundle: object = None
    offer: Optional[FlashOffer] = None
    bundle: object = None
    bundle_group: str = ""
    bundle_quantity: int = 0


@dataclass
class PricedBag:
    lines: List[PricedLine] = field(default_factory=list)
    bundles: List[dict] = field(default_factory=list)
    # Things that would stop checkout, said before the shopper gets there.
    issues: List[dict] = field(default_factory=list)
    # A flash sale in the bag that doesn't allow coupons, if any.
    coupon_blocked_by: Optional[str] = None


def _billing_line(product, *, quantity: int, unit_price: int, size, color) -> billing.BillingLine:
    return billing.BillingLine(
        product_id=product.id,
        name=product.name,
        sku=product.sku,
        category=product.category.slug if product.category else None,
        size=size or None,
        color=color or None,
        quantity=quantity,
        unit_price=unit_price,
        list_price=billing.to_minor(float(product.original_price)),
    )


def price_bag(
    db: Session,
    customer_id: str,
    items: Sequence,
    cart_bundles: Sequence,
    *,
    products: Optional[Dict[str, object]] = None,
    enforce: bool = False,
) -> PricedBag:
    """
    Price every line in a bag: its products (`CartItem`s) and its bundles
    (`CartBundle`s). `products` are the locked rows at checkout; otherwise each
    line's own product is used.

    With `enforce` (checkout), the flash sale items are locked and counted, and
    a sale price that can't be honoured — sold out, or over the customer's
    limit — is refused with a message rather than charged at a different price.
    """
    bag = PricedBag()
    offers = live_offers(db)
    now = datetime.utcnow()

    def product_of(product_id: str, fallback):
        return (products or {}).get(product_id) or fallback

    # --- products, with any flash sale price -----------------------------
    plain = []
    for item in items:
        product = product_of(item.product_id, item.product)
        if product is None:
            continue
        offer = offers.get(product.id)
        if not offer_applies(offer, product) and not (enforce and offer is not None and offer.sale_price
                                                      < billing.to_minor(float(product.price))):
            offer = None
        plain.append((item, product, offer))

    with_offers = [offer for _, _, offer in plain if offer is not None]
    counts: Dict[int, tuple] = {}
    if enforce and with_offers:
        counts = _lock_offers(db, with_offers, customer_id)
    elif with_offers:
        mine = claimed_by(db, customer_id, [o.item_id for o in with_offers])
        counts = {o.item_id: (o.sold, mine.get(o.item_id, 0)) for o in with_offers}

    wanted: Dict[int, int] = {}
    for item, _, offer in plain:
        if offer is not None:
            wanted[offer.item_id] = wanted.get(offer.item_id, 0) + item.quantity

    for item, product, offer in plain:
        regular = billing.to_minor(float(product.price))
        if offer is not None:
            if offer.item_id not in counts and enforce:
                offer = None  # the sale ended or was removed a moment ago
        if offer is not None:
            sold, mine = counts.get(offer.item_id, (offer.sold, 0))
            left = None if offer.stock_limit is None else max(0, offer.stock_limit - sold)
            want = wanted.get(offer.item_id, item.quantity)
            problem = None
            if left is not None and left <= 0:
                # Sold out at the sale price: the regular price from now on.
                # If the shopper was shown the sale price a moment ago, the
                # expected total checkout sends no longer matches and the order
                # is refused with the new figure (see `place_order`).
                offer = None
            elif left is not None and want > left:
                problem = ("FLASH_SALE_LIMITED",
                           f"Only {left} of {product.name} {'is' if left == 1 else 'are'} left at the flash sale "
                           "price. Reduce the quantity to continue.")
            elif offer.per_customer_limit is not None and mine + want > offer.per_customer_limit:
                allowed = max(0, offer.per_customer_limit - mine)
                problem = ("FLASH_SALE_LIMIT",
                           f"The flash sale allows {offer.per_customer_limit} of {product.name} per customer"
                           + (f" — you can add {allowed} more." if allowed else " and you've reached it."))
            if problem:
                if enforce:
                    raise ConflictError(problem[1], error_code=problem[0])
                if offer is not None:
                    bag.issues.append({"code": problem[0], "message": problem[1], "productId": product.id,
                                       "cartItemId": item.id})
        unit = offer.sale_price if offer is not None else regular
        if offer is not None and not offer.allow_coupons and bag.coupon_blocked_by is None:
            bag.coupon_blocked_by = offer.sale_name
        bag.lines.append(PricedLine(
            line=_billing_line(product, quantity=item.quantity, unit_price=unit, size=item.size, color=item.color),
            product=product, regular_unit=regular, cart_item=item, offer=offer,
        ))

    # --- bundles -----------------------------------------------------------
    for entry in cart_bundles:
        bundle = entry.bundle
        if bundle is None:
            continue
        components = {item.product_id: product_of(item.product_id, None) for item in bundle.items}
        if not products:
            from app.models import Product

            missing = [pid for pid, p in components.items() if p is None]
            if missing:
                for p in db.execute(select(Product).where(Product.id.in_(missing))).scalars().all():
                    components[p.id] = p
        quote = quote_bundle(bundle, components, now)
        problem = quote.reason or (
            f"Only {quote.available} of the {bundle.name} bundle {'is' if quote.available == 1 else 'are'} available."
            if entry.quantity > quote.available else ""
        )
        if entry.quantity > bundle.max_per_order:
            problem = problem or f"You can buy up to {bundle.max_per_order} of the {bundle.name} bundle in one order."
        if problem:
            if enforce:
                raise ConflictError(problem, error_code="BUNDLE_UNAVAILABLE")
            bag.issues.append({"code": "BUNDLE_UNAVAILABLE", "message": problem, "cartBundleId": entry.id})
        chosen = {s.get("productId"): s for s in (entry.selections or [])}
        group = f"B{entry.id}"
        view_components = []
        for item in bundle.items:
            product = components.get(item.product_id)
            if product is None:
                continue
            pick = chosen.get(item.product_id, {})
            unit = quote.unit_prices.get(item.product_id, 0)
            bag.lines.append(PricedLine(
                line=_billing_line(product, quantity=item.quantity * entry.quantity, unit_price=unit,
                                   size=pick.get("size"), color=pick.get("color")),
                product=product, regular_unit=billing.to_minor(float(product.price)), cart_bundle=entry,
                bundle=bundle, bundle_group=group, bundle_quantity=entry.quantity,
            ))
            view_components.append({
                "productId": product.id, "name": product.name, "slug": product.slug,
                "image": next(iter(_images(product, pick.get("color"))), ""),
                "size": pick.get("size") or None, "color": pick.get("color") or None,
                "quantity": item.quantity,
            })
        bag.bundles.append({
            "id": entry.id,
            "bundleId": bundle.id,
            "slug": bundle.slug,
            "name": bundle.name,
            "image": bundle.image or (view_components[0]["image"] if view_components else ""),
            "quantity": entry.quantity,
            "unitPrice": quote.price,
            "regularUnitPrice": quote.regular_total,
            "lineTotal": quote.price * entry.quantity,
            "available": quote.available,
            "maxPerOrder": bundle.max_per_order,
            "problem": problem or None,
            "components": view_components,
        })
    return bag


def _images(product, color):
    from app.models.catalogue import images_for

    return images_for(product, color)


def refuse_coupon_if_blocked(bag: PricedBag) -> None:
    if bag.coupon_blocked_by:
        raise ValidationError(
            f"Coupons can't be used with items from the {bag.coupon_blocked_by} flash sale.",
            error_code="COUPON_NOT_ALLOWED_WITH_FLASH_SALE",
        )
