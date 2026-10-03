"""
Product availability by location: "can I get *this*, *here*, and when?"

One answer built from the pieces the store already has — nothing here is a
second pincode system or a second stock figure:

    the product        published, and the variant (size, colour) it comes in
    its stock          `Product.available_stock` — on hand less what's held
    the pincode        `services.serviceability`: the store's pincode table
                       and its rule for unlisted pincodes
    the product's own  `ProductDeliveryProfile`: places it isn't delivered
    delivery rules     to, no cash on delivery, no express, handling days
    the clock          dispatch cutoff, working days, holidays
                       (`serviceability.delivery_window`)
    the fees           the pincode's fee or the store's, the free-delivery
                       threshold, the express fee, the COD fee and limit

## Stock is per product

This store holds stock per product, not per size or colour, and from one
pool rather than per warehouse (see `models.catalogue.Product`). So a variant
is "available" when it is one the product comes in and the product has stock;
the answer says `inventoryScope: "product"` so nobody reads more into it.

## Shown here, enforced at checkout

The product page and the bag ask `check_product` and `check_cart` for
information. `enforce_for_order` runs inside `orders.place_order` against the
locked rows, so an answer that went stale between the product page and the
payment button can't get an order through.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Dict, Iterable, List, Optional, Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import cache
from app.core.config import settings as app_settings
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import Product, ProductDeliveryExclusion, ProductDeliveryProfile
from app.models.discovery import EXCLUSION_KINDS
from app.repositories import products as product_repo
from app.services import billing, serviceability
from app.services.cart import MAX_QUANTITY_PER_LINE

logger = logging.getLogger(__name__)

MAX_EXCLUSIONS = 200


# ------------------------------------------------------------- the pincode


def location(db: Session, pincode: str) -> serviceability.Serviceability:
    """
    The pincode's answer, cached briefly. Changing a pincode or the delivery
    settings clears the cache (`serviceability.changed`).
    """
    code = serviceability.normalise(pincode)
    ttl = max(0, int(app_settings.AVAILABILITY_CACHE_SECONDS))
    return cache.get_or_set("delivery", ("pincode", code), ttl, lambda: serviceability.check(db, code))


def _rules(db: Session) -> dict:
    ttl = max(0, int(app_settings.AVAILABILITY_CACHE_SECONDS))
    return cache.get_or_set("delivery", ("rules",), ttl, lambda: serviceability.settings(db))


# ------------------------------------------------------------- a product's rules


def profiles_for(db: Session, product_ids: Sequence[str]) -> Dict[str, ProductDeliveryProfile]:
    """Every listed product's delivery rules, in one query (and one for their exclusions)."""
    ids = [pid for pid in dict.fromkeys(product_ids) if pid]
    if not ids:
        return {}
    return {p.product_id: p for p in db.execute(
        select(ProductDeliveryProfile).where(ProductDeliveryProfile.product_id.in_(ids))).scalars()}


def _excluded(profile: Optional[ProductDeliveryProfile], result: serviceability.Serviceability) -> Optional[str]:
    """Why this product can't go to this pincode, or None."""
    if profile is None:
        return None
    state = (result.state or "").strip().lower()
    for rule in profile.exclusions:
        if ((rule.kind == "pincode" and rule.value == result.pincode)
                or (rule.kind == "prefix" and result.pincode.startswith(rule.value))
                or (rule.kind == "state" and state and rule.value.strip().lower() == state)):
            return rule.reason or profile.note or "This item can't be delivered to this pincode."
    return None


# ------------------------------------------------------------- the variant


def _variant(product: Product, size: Optional[str], color: Optional[str]) -> dict:
    sizes = [s.label for s in product.sizes]
    colors = [c.name for c in product.colors]
    if size and size not in sizes:
        raise ValidationError(f"{product.name} does not come in {size}.", error_code="SIZE_UNAVAILABLE")
    if color and colors and color not in colors:
        raise ValidationError(f"{product.name} does not come in {color}.", error_code="COLOR_UNAVAILABLE")
    return {"size": size or None, "color": color or (colors[0] if colors else None),
            "needsSize": bool(sizes) and not size}


# ------------------------------------------------------------- the answer


def _fees(db: Session) -> dict:
    shipping = billing.store_settings(db).get("shipping") or {}
    payment = billing.billing_config(db).get("payment") or {}
    return {
        "standard": billing.to_minor(shipping.get("standardFee", 0) or 0),
        "express": billing.to_minor(shipping.get("expressFee", 0) or 0),
        "threshold": shipping.get("freeDeliveryThreshold"),
        "codFee": billing.to_minor(payment.get("codFee", 0) or 0),
        "codEnabled": "cod" in set(payment.get("enabledMethods") or []),
    }


def _answer(db: Session, product: Product, result: serviceability.Serviceability, *, quantity: int,
            variant: dict, profile: Optional[ProductDeliveryProfile], rules: dict, fees: dict,
            now: Optional[datetime] = None) -> dict:
    available_stock = product.available_stock if product.status == "active" else 0
    in_stock = available_stock >= quantity
    exclusion = _excluded(profile, result) if result.valid and result.serviceable else None
    deliverable = result.valid and result.serviceable and exclusion is None
    extra_days = profile.dispatch_days if profile is not None and profile.dispatch_days else 0

    standard = express = None
    express_ok = False
    if deliverable:
        low, high = serviceability.transit_days(result, rules, "standard")
        standard = serviceability.delivery_window(rules, min_days=low, max_days=high,
                                                  extra_dispatch_days=extra_days, now=now)
        express_ok = result.express_available and (profile is None or profile.express_allowed)
        if express_ok:
            low, high = serviceability.transit_days(result, rules, "express")
            express = serviceability.delivery_window(rules, min_days=low, max_days=high,
                                                     extra_dispatch_days=extra_days, now=now)

    goods = billing.to_minor(float(product.price)) * quantity
    threshold = fees["threshold"]
    standard_fee = result.delivery_fee if result.delivery_fee is not None else fees["standard"]
    free = threshold is not None and goods >= billing.to_minor(threshold)
    cod_limit = rules.get("codMaxOrderValue")
    cod_reason = ""
    if not deliverable:
        cod_reason = "Not deliverable here."
    elif not fees["codEnabled"]:
        cod_reason = "Cash on delivery isn't offered by the store."
    elif not result.cod_available:
        cod_reason = "Cash on delivery isn't available at this pincode."
    elif profile is not None and not profile.cod_allowed:
        cod_reason = profile.note or "Cash on delivery isn't available for this item."
    elif cod_limit is not None and goods > billing.to_minor(cod_limit):
        cod_reason = f"Cash on delivery is available on orders up to ₹{cod_limit:,.0f}."
    cod_ok = deliverable and not cod_reason

    if not result.valid:
        status, message = "invalid-pincode", result.reason or "Enter a valid 6-digit pincode."
    elif not result.serviceable:
        status, message = "not-serviceable", result.reason or "Sorry, we don't deliver to this pincode yet."
    elif exclusion:
        status, message = "restricted", exclusion
    elif variant["needsSize"]:
        status, message = "select-variant", "Choose a size to check its availability."
    elif available_stock <= 0:
        status, message = "out-of-stock", f"{product.name} is out of stock."
    elif not in_stock:
        status, message = "limited", f"Only {available_stock} left — choose fewer."
    else:
        status, message = "available", "Available for delivery"

    available = status == "available"
    return {
        "productId": product.id,
        "pincode": result.pincode,
        "valid": result.valid,
        "available": available,
        "status": status,
        "message": message,
        "deliverable": deliverable,
        "inventoryAvailable": in_stock and product.status == "active",
        # Stock is held per product (see the module docstring).
        "inventoryScope": "product",
        "maxQuantity": max(0, min(available_stock, MAX_QUANTITY_PER_LINE)),
        "variant": variant,
        "location": {"city": result.city, "district": result.district, "state": result.state,
                     "listed": result.listed},
        "estimatedDelivery": standard,
        "codAvailable": cod_ok,
        "cod": {"available": cod_ok, "fee": billing.to_major(fees["codFee"]) if cod_ok else None,
                "maxOrderValue": cod_limit, "reason": cod_reason},
        "expressAvailable": bool(express_ok and express),
        "express": {"available": bool(express_ok and express), "estimatedDelivery": express,
                    "fee": billing.to_major(fees["express"]) if express_ok else None},
        # Rupees, for this item alone: the bag prices delivery for everything in it.
        "deliveryFee": (0.0 if free else billing.to_major(standard_fee)) if deliverable else None,
        "standardDeliveryFee": billing.to_major(standard_fee) if deliverable else None,
        "freeDeliveryThreshold": threshold,
        "freeDelivery": bool(deliverable and free),
        "dispatch": {"cutoffHour": rules.get("dispatchCutoffHour"),
                     "handlingDays": int(rules.get("processingDays") or 0) + int(extra_days or 0)},
        "note": profile.note if profile is not None and profile.note else "",
        "checkedAt": datetime.utcnow(),
    }


def check_product(db: Session, identifier: str, *, pincode: str, size: Optional[str] = None,
                  color: Optional[str] = None, quantity: int = 1, now: Optional[datetime] = None) -> dict:
    """Can this product, in this variant and quantity, be delivered to this pincode — and when."""
    product = product_repo.get_by_identifier(db, identifier, published_only=True)
    if product is None:
        raise NotFoundError("That product is not available.", error_code="PRODUCT_NOT_FOUND")
    if quantity < 1 or quantity > MAX_QUANTITY_PER_LINE:
        raise ValidationError(f"Choose a quantity between 1 and {MAX_QUANTITY_PER_LINE}.",
                              error_code="INVALID_QUANTITY")
    variant = _variant(product, (size or "").strip()[:30] or None, (color or "").strip()[:60] or None)
    try:
        result = location(db, pincode)
        return _answer(db, product, result, quantity=quantity, variant=variant,
                       profile=profiles_for(db, [product.id]).get(product.id), rules=_rules(db), fees=_fees(db),
                       now=now)
    except (ValidationError, NotFoundError, ConflictError):
        raise
    except Exception:
        logger.exception("Availability check failed for %s at %s", product.id, serviceability.normalise(pincode))
        raise


def check_cart(db: Session, customer, pincode: str, *, now: Optional[datetime] = None) -> dict:
    """Every bag line against one pincode, so the bag can say which item is the problem."""
    from app.models import CartItem

    items = list(db.execute(select(CartItem).where(CartItem.customer_id == customer.id)
                            .order_by(CartItem.created_at, CartItem.id)).scalars())
    result = location(db, pincode)
    rules, fees = _rules(db), _fees(db)
    products = {p.id: p for p in product_repo.get_many(db, [i.product_id for i in items], published_only=False)}
    profiles = profiles_for(db, list(products))
    lines = []
    for item in items:
        product = products.get(item.product_id)
        if product is None or product.status not in product_repo.PUBLISHED_STATUSES:
            lines.append({"lineId": item.id, "productId": item.product_id, "name": product.name if product else "",
                          "available": False, "status": "unavailable", "message": "No longer available."})
            continue
        variant = {"size": item.size or None, "color": item.color or None, "needsSize": False}
        answer = _answer(db, product, result, quantity=item.quantity, variant=variant,
                         profile=profiles.get(product.id), rules=rules, fees=fees, now=now)
        lines.append({"lineId": item.id, "productId": product.id, "name": product.name,
                      "available": answer["available"], "status": answer["status"], "message": answer["message"],
                      "codAvailable": answer["codAvailable"], "expressAvailable": answer["expressAvailable"],
                      "estimatedDelivery": answer["estimatedDelivery"]})
    ok = [line for line in lines if line["available"]]
    latest = max((line["estimatedDelivery"]["to"] for line in ok if line.get("estimatedDelivery")), default=None)
    return {
        "pincode": result.pincode,
        "valid": result.valid,
        "serviceable": result.serviceable,
        "reason": result.reason,
        "location": {"city": result.city, "district": result.district, "state": result.state},
        "lines": lines,
        "allAvailable": bool(lines) and len(ok) == len(lines),
        "unavailableCount": len(lines) - len(ok),
        "codAvailable": bool(lines) and all(line.get("codAvailable") for line in lines),
        "expressAvailable": bool(lines) and all(line.get("expressAvailable") for line in lines),
        "estimatedDeliveryBy": latest,
    }


def enforce_for_order(db: Session, products: Iterable[Product], *, pincode: str, payment_method: str,
                      delivery_method: str) -> int:
    """
    At checkout, against the locked products: refuse an item the product's own
    rules keep from this pincode, from cash on delivery or from express.
    Returns the most handling days any item needs, for the delivery estimate.

    The pincode itself, the stock and the store-wide COD/express rules are
    checked by `orders.place_order` already; this adds only what is per
    product. Read uncached — this decision is made once, on fresh rows.
    """
    result = serviceability.check(db, pincode)
    listed = [p for p in products if p is not None]
    profiles = profiles_for(db, [p.id for p in listed])
    extra = 0
    for product in listed:
        profile = profiles.get(product.id)
        if profile is None:
            continue
        reason = _excluded(profile, result)
        if reason:
            raise ConflictError(f"{product.name} can't be delivered to {result.pincode}: {reason}",
                                error_code="PRODUCT_NOT_DELIVERABLE", details={"productId": product.id})
        if payment_method == "cod" and not profile.cod_allowed:
            raise ConflictError(f"Cash on delivery isn't available for {product.name}. Please choose another "
                                "payment method.", error_code="COD_UNAVAILABLE", details={"productId": product.id})
        if delivery_method == "express" and not profile.express_allowed:
            raise ConflictError(f"Express delivery isn't available for {product.name}. Please choose standard "
                                "delivery.", error_code="EXPRESS_UNAVAILABLE", details={"productId": product.id})
        extra = max(extra, int(profile.dispatch_days or 0))
    return extra


def enforce_cod_limit(db: Session, *, payment_method: str, goods_value: int) -> None:
    """The store's cash-on-delivery ceiling, on the order's goods value (paise)."""
    if payment_method != "cod":
        return
    limit = serviceability.settings(db).get("codMaxOrderValue")
    if limit is not None and goods_value > billing.to_minor(limit):
        raise ConflictError(f"Cash on delivery is available on orders up to ₹{limit:,.0f}. Please choose another "
                            "payment method.", error_code="COD_LIMIT_EXCEEDED")


def order_estimate(db: Session, result: serviceability.Serviceability, *, method: str, extra_days: int = 0,
                   now: Optional[datetime] = None) -> str:
    """The expected delivery written on an order: the latest day of the window."""
    rules = serviceability.settings(db)
    low, high = serviceability.transit_days(result, rules, method)
    return serviceability.delivery_window(rules, min_days=low, max_days=high, extra_dispatch_days=extra_days,
                                          now=now)["latestLabel"]


# ------------------------------------------------------------- the portal


def profile_view(db: Session, product_id: str) -> dict:
    if db.get(Product, product_id) is None:
        raise NotFoundError("No such product.", error_code="PRODUCT_NOT_FOUND")
    profile = db.get(ProductDeliveryProfile, product_id)
    if profile is None:
        return {"productId": product_id, "codAllowed": True, "expressAllowed": True, "dispatchDays": None,
                "note": "", "exclusions": [], "configured": False}
    return {"productId": product_id, "codAllowed": profile.cod_allowed, "expressAllowed": profile.express_allowed,
            "dispatchDays": profile.dispatch_days, "note": profile.note, "configured": True,
            "updatedAt": profile.updated_at, "updatedBy": profile.updated_by,
            "exclusions": [{"id": e.id, "kind": e.kind, "value": e.value, "reason": e.reason}
                           for e in profile.exclusions]}


def _clean_exclusions(raw) -> List[dict]:
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_EXCLUSIONS:
        raise ValidationError(f"Up to {MAX_EXCLUSIONS} places can be excluded.", error_code="INVALID_EXCLUSION")
    out, seen = [], set()
    for index, entry in enumerate(raw, start=1):
        if not isinstance(entry, dict):
            raise ValidationError(f"Exclusion {index} is not valid.", error_code="INVALID_EXCLUSION")
        kind = str(entry.get("kind") or "")
        value = str(entry.get("value") or "").strip()
        if kind not in EXCLUSION_KINDS:
            raise ValidationError(f"Exclusion {index}: choose pincode, prefix or state.",
                                  error_code="INVALID_EXCLUSION")
        if kind == "pincode":
            value = serviceability.normalise(value)
            if not serviceability.valid(value):
                raise ValidationError(f"Exclusion {index}: '{value}' is not a valid pincode.",
                                      error_code="INVALID_EXCLUSION")
        elif kind == "prefix":
            if not (value.isdigit() and 1 <= len(value) <= 5 and value[0] != "0"):
                raise ValidationError(f"Exclusion {index}: a prefix is 1–5 digits, not starting with 0.",
                                      error_code="INVALID_EXCLUSION")
        elif not value or len(value) > 120:
            raise ValidationError(f"Exclusion {index}: name the state.", error_code="INVALID_EXCLUSION")
        key = (kind, value.lower())
        if key in seen:
            continue
        seen.add(key)
        out.append({"kind": kind, "value": value, "reason": str(entry.get("reason") or "").strip()[:255]})
    return out


def save_profile(db: Session, product_id: str, payload: dict, *, actor: str = "") -> dict:
    """A product's delivery rules, whole. No restrictions at all removes the row."""
    if db.get(Product, product_id) is None:
        raise NotFoundError("No such product.", error_code="PRODUCT_NOT_FOUND")
    days = payload.get("dispatchDays")
    if days in (None, ""):
        days = None
    else:
        if isinstance(days, bool):
            raise ValidationError("Handling days must be a whole number.", error_code="INVALID_DAYS")
        try:
            days = int(days)
        except (TypeError, ValueError):
            raise ValidationError("Handling days must be a whole number.", error_code="INVALID_DAYS") from None
        if not 0 <= days <= 60:
            raise ValidationError("Handling days must be between 0 and 60.", error_code="INVALID_DAYS")
    exclusions = _clean_exclusions(payload.get("exclusions"))
    cod_allowed = bool(payload.get("codAllowed", True))
    express_allowed = bool(payload.get("expressAllowed", True))
    note = str(payload.get("note") or "").strip()[:255]

    profile = db.get(ProductDeliveryProfile, product_id)
    plain = cod_allowed and express_allowed and not days and not exclusions and not note
    if plain:
        if profile is not None:
            db.delete(profile)
    else:
        if profile is None:
            profile = ProductDeliveryProfile(product_id=product_id)
            db.add(profile)
        profile.cod_allowed, profile.express_allowed = cod_allowed, express_allowed
        profile.dispatch_days, profile.note, profile.updated_by = days, note, actor
        profile.updated_at = datetime.utcnow()
        db.flush()
        # Replaced whole: the editor sends the full list.
        profile.exclusions.clear()
        db.flush()
        for entry in exclusions:
            profile.exclusions.append(ProductDeliveryExclusion(product_id=product_id, **entry))
    db.commit()
    return profile_view(db, product_id)
