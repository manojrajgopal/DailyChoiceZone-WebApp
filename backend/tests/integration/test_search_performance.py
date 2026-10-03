"""
Search at catalogue scale: 5,000 products, a search listing and the full facet
set each finish within a bound. The bound is generous on purpose (a shared CI
machine, the transactional test database) — it exists to catch a query that
turns quadratic or loses its index, not to benchmark the server.
See docs/search-and-filters.md §3 ("Why not a FULLTEXT index").
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta

import pytest
from sqlalchemy import insert

from app.models import Category, Product, ProductAttribute, ProductAttributeOption, ProductAttributeValue
from app.services.search import index

pytestmark = pytest.mark.integration

PRODUCTS = 5000
BOUND_SECONDS = 3.0
WORDS = ["steel", "bottle", "cotton", "kurta", "ceramic", "vase", "linen", "shirt", "brass", "lamp",
         "silk", "saree", "glass", "jar", "wooden", "tray", "leather", "wallet", "copper", "mug"]
BRANDS = ["Anvi", "Meridian", "Terra", "Botanica", "Hydra", "Steelco", "Clearware", "Greenly"]


@pytest.fixture()
def catalogue(db):
    db.add_all([Category(id=f"CAT9{n}", slug=f"perf-{n}", name=f"Perf {n}", display_order=n) for n in range(5)])
    db.flush()
    start = datetime(2026, 1, 1)
    rows = []
    for n in range(PRODUCTS):
        name = f"{WORDS[n % 20].title()} {WORDS[(n * 7 + 3) % 20].title()} {n}"
        price = 99 + (n * 37) % 4900
        rows.append({
            "id": f"PRF{n:05d}", "slug": f"perf-product-{n}", "sku": f"PRF-{n:05d}", "name": name,
            "brand": BRANDS[n % len(BRANDS)], "category_id": f"CAT9{n % 5}", "subcategory": WORDS[n % 20],
            "price": price, "original_price": price + (n % 4) * 100, "discount": (n % 4) * 10,
            "stock": n % 9, "reserved_stock": 0, "status": "active", "rating": 3 + (n % 20) / 10,
            "review_count": n % 50, "description": f"A {WORDS[(n * 3) % 20]} piece for every day.",
            "created_at": start + timedelta(minutes=n), "updated_at": start + timedelta(minutes=n),
        })
    db.execute(insert(Product), rows)
    material = ProductAttribute(code="perf_material", label="Material", type="multi", position=1)
    material.options = [ProductAttributeOption(value=w, label=w.title(), position=i) for i, w in
                        enumerate(["steel", "cotton", "glass", "brass"])]
    db.add(material)
    db.flush()
    db.execute(insert(ProductAttributeValue), [
        {"product_id": f"PRF{n:05d}", "attribute_id": material.id, "value": ["Steel", "Cotton", "Glass", "Brass"][n % 4],
         "value_normalized": ["steel", "cotton", "glass", "brass"][n % 4]}
        for n in range(0, PRODUCTS, 2)
    ])
    db.flush()
    index.rebuild(db)


def timed(client, url):
    began = time.perf_counter()
    response = client.get(url)
    elapsed = time.perf_counter() - began
    assert response.status_code == 200, response.text
    return response, elapsed


def test_a_search_listing_stays_within_the_bound(client, catalogue):
    response, elapsed = timed(client, "/api/products?search=steel bottle&sort=relevance&pageSize=24")
    assert response.json()["data"], "the search should find products"
    assert elapsed < BOUND_SECONDS, f"search listing took {elapsed:.2f}s"


def test_filtered_browsing_stays_within_the_bound(client, catalogue):
    url = "/api/products?category=perf-1,perf-2&minPrice=500&maxPrice=3000&attr.perf_material=steel,glass&sort=price-asc"
    _, elapsed = timed(client, url)
    assert elapsed < BOUND_SECONDS, f"filtered listing took {elapsed:.2f}s"


def test_the_full_facet_set_stays_within_the_bound(client, catalogue):
    response, elapsed = timed(client, "/api/products/facets?search=steel&attr.perf_material=steel,glass")
    data = response.json()["data"]
    assert data["attributes"] and data["brands"] and data["priceBuckets"]
    assert elapsed < BOUND_SECONDS, f"facets took {elapsed:.2f}s"


def test_suggestions_stay_within_the_bound(client, catalogue):
    response, elapsed = timed(client, "/api/search/suggest?q=cer")
    assert response.json()["data"]["products"]
    assert elapsed < 1.5, f"suggest took {elapsed:.2f}s"
