"""
Search-as-you-type suggestions: a few products, categories and brands, and the
popular searches. Small on purpose: ids, names, one image and a price, never
the full product payload. Recent searches are the browser's (localStorage).
"""

from __future__ import annotations

from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Category, Product
from app.models.catalogue import images_for
from app.services.search import analytics, dictionary, registry
from app.services.search.base import LIKE_ESCAPE, escape_like, normalise

PUBLISHED = ("active", "out-of-stock")
MIN_LENGTH = 2
GROUP_LIMIT = 4


def _price(product: Product) -> tuple:
    """The shop price, a live flash sale included, as the product card shows it."""
    price, original = float(product.price), float(product.original_price)
    try:
        from app.services import billing, pricing

        offer = pricing.offer_for(product)
        if offer is not None:
            return billing.to_major(offer.sale_price), max(original, price)
    except Exception:  # noqa: BLE001 - a suggestion never fails over a price
        pass
    return price, original


def _matching(db: Session, term: str, limit: int):
    terms = registry.parse(db, term)
    products = registry.backend().suggest_products(db, terms, limit)
    pattern_start = f"{escape_like(term)}%"
    pattern_word = f"% {escape_like(term)}%"
    categories = db.execute(
        select(Category.slug, Category.name)
        .where(Category.name.like(pattern_start, escape=LIKE_ESCAPE) | Category.name.like(pattern_word, escape=LIKE_ESCAPE)
               | Category.slug.like(pattern_start, escape=LIKE_ESCAPE))
        .order_by(Category.display_order, Category.name).limit(GROUP_LIMIT)
    ).all()
    brands = db.execute(
        select(Product.brand).where(Product.status.in_(PUBLISHED),
                                    Product.brand.like(pattern_start, escape=LIKE_ESCAPE)
                                    | Product.brand.like(pattern_word, escape=LIKE_ESCAPE))
        .group_by(Product.brand).order_by(func.count(Product.id).desc(), Product.brand).limit(GROUP_LIMIT)
    ).scalars().all()
    return products, categories, brands



def suggest(db: Session, q: Optional[str], limit: int = 5) -> dict:
    term = normalise(q)
    out = {"query": term, "corrected_term": None, "products": [], "categories": [], "brands": [],
           "popular": analytics.popular(db)}
    if len(term) < MIN_LENGTH:
        return out
    limit = max(1, min(int(limit), 10))
    products, categories, brands = _matching(db, term, limit)
    if not products and not categories and not brands:
        corrected = dictionary.correct(db, term)
        if corrected and corrected != term:
            products, categories, brands = _matching(db, corrected, limit)
            if products or categories or brands:
                out["corrected_term"] = corrected
    out["products"] = []
    for product in products:
        price, original = _price(product)
        images = images_for(product)
        out["products"].append({"id": product.id, "slug": product.slug, "name": product.name,
                                "brand": product.brand, "image": images[0] if images else "",
                                "price": price, "original_price": original})
    out["categories"] = [{"slug": slug, "name": name} for slug, name in categories]
    out["brands"] = [{"value": brand, "label": brand} for brand in brands if brand]
    return out
