"""
Search & filters. See docs/search-and-filters.md.

    GET  /api/search/suggest                  suggestions as you type (public, rate-limited)
    POST /api/search/click                    a product opened from search results (public, rate-limited)
    /api/admin/attributes...                  attribute definitions (permission: products)
    /api/admin/products/{id}/attributes       a product's attribute values (products)
    /api/admin/search/...                     search analytics, settings, rebuild (permission: search)

The listing and its facets stay `GET /api/products` and `/api/products/facets`.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, Union

from fastapi import APIRouter, Depends, Query, Request
from pydantic import Field
from sqlalchemy.orm import Session

from app.core import rate_limit
from app.core.database import get_db
from app.dependencies.auth import client_ip, get_optional_customer, require_access
from app.models import AdminUser, Customer
from app.schemas.base import CamelModel
from app.services import audit
from app.services.search import analytics, attributes as attribute_service, dictionary, jobs, suggest
from app.services.search import index as search_index
from app.services.search import settings as search_settings
from app.utils.response import ok

router = APIRouter(prefix="/search", tags=["Search"])
attributes_router = APIRouter(prefix="/admin/attributes", tags=["Admin · Attributes"])
product_attributes_router = APIRouter(prefix="/admin/products", tags=["Admin · Attributes"])
admin_router = APIRouter(prefix="/admin/search", tags=["Admin · Search"])

products_access = require_access("products")
search_access = require_access("search")


# ----------------------------------------------------------------- public


@router.get("/suggest", summary="Search suggestions as you type")
def suggestions(request: Request, q: str = Query("", max_length=100), limit: int = Query(5, ge=1, le=10),
                db: Session = Depends(get_db)):
    rate_limit.check(f"suggest:{client_ip(request)}", limit=240, window_seconds=60)
    data = suggest.suggest(db, q, limit)
    return ok({
        "query": data["query"], "correctedTerm": data["corrected_term"],
        "products": [{"id": p["id"], "slug": p["slug"], "name": p["name"], "brand": p["brand"], "image": p["image"],
                      "price": p["price"], "originalPrice": p["original_price"]} for p in data["products"]],
        "categories": data["categories"], "brands": data["brands"], "popular": data["popular"],
    })


class SearchClickIn(CamelModel):
    search_id: int = Field(ge=1)
    product_id: str = Field(min_length=1, max_length=20)
    position: int = Field(ge=1, le=100_000)
    visitor_id: Optional[str] = Field(default=None, max_length=64)


@router.post("/click", status_code=202, summary="A product opened from search results")
def search_click(payload: SearchClickIn, request: Request, db: Session = Depends(get_db),
                 customer: Optional[Customer] = Depends(get_optional_customer)):
    rate_limit.check(f"search-click:{client_ip(request)}", limit=120, window_seconds=60)
    recorded = analytics.record_click(db, search_id=payload.search_id, product_id=payload.product_id,
                                      position=payload.position, visitor_id=payload.visitor_id,
                                      customer_id=customer.id if customer else None)
    return ok({"recorded": recorded})


# ------------------------------------------------------------- attributes


class OptionIn(CamelModel):
    id: Optional[int] = None
    label: str = Field(min_length=1, max_length=120)
    value: Optional[str] = Field(default=None, max_length=120)


class AttributeIn(CamelModel):
    code: Optional[str] = Field(default=None, max_length=40)
    label: Optional[str] = Field(default=None, max_length=80)
    type: Optional[Literal["select", "multi", "number", "boolean"]] = None
    unit: Optional[str] = Field(default=None, max_length=20)
    filterable: Optional[bool] = None
    searchable: Optional[bool] = None
    position: Optional[int] = Field(default=None, ge=0, le=10_000)
    status: Optional[Literal["active", "archived"]] = None
    options: Optional[List[OptionIn]] = Field(default=None, max_length=200)

    def data(self) -> dict:
        values = self.model_dump(exclude_unset=True, by_alias=False)
        if self.options is not None:
            values["options"] = [option.model_dump(by_alias=False) for option in self.options]
        return values


def _refresh_attribute_products(db: Session, attribute_id: int) -> None:
    """An attribute's label or options changed: products using it get their search text refreshed."""
    from sqlalchemy import select

    from app.models import ProductAttributeValue

    ids = list(db.execute(select(ProductAttributeValue.product_id).where(
        ProductAttributeValue.attribute_id == attribute_id).distinct().limit(5000)).scalars())
    if ids:
        search_index.refresh_quietly(db, ids)


@attributes_router.get("", summary="Product attributes")
def list_attributes(status: str = Query("all", max_length=12), db: Session = Depends(get_db),
                    admin: AdminUser = Depends(products_access)):
    return ok(attribute_service.list_attributes(db, status))


@attributes_router.post("", status_code=201, summary="Create a product attribute")
def create_attribute(payload: AttributeIn, db: Session = Depends(get_db),
                     admin: AdminUser = Depends(products_access)):
    attribute = attribute_service.create(db, payload.data())
    audit.record(db, "attributes.create", resource_type="attributes", resource_id=attribute.id, actor=admin,
                 summary=f"Created attribute {attribute.label} ({attribute.code})")
    db.commit()
    dictionary.add_words(db, [o.label for o in attribute.options], kind="attribute")
    db.commit()
    return ok(attribute_service.get_view(db, attribute.id), message="Attribute created.")


@attributes_router.get("/{attribute_id}", summary="A product attribute")
def get_attribute(attribute_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(products_access)):
    return ok(attribute_service.get_view(db, attribute_id))


@attributes_router.put("/{attribute_id}", summary="Update a product attribute")
def update_attribute(attribute_id: int, payload: AttributeIn, db: Session = Depends(get_db),
                     admin: AdminUser = Depends(products_access)):
    attribute = attribute_service.update(db, attribute_id, payload.data())
    audit.record(db, "attributes.update", resource_type="attributes", resource_id=attribute.id, actor=admin,
                 summary=f"Changed attribute {attribute.label} ({attribute.code})",
                 changes={"fields": sorted(payload.model_dump(exclude_unset=True).keys())})
    db.commit()
    dictionary.add_words(db, [o.label for o in attribute.options], kind="attribute")
    db.commit()
    _refresh_attribute_products(db, attribute.id)
    return ok(attribute_service.get_view(db, attribute.id), message="Attribute saved.")


@attributes_router.delete("/{attribute_id}", summary="Delete an unused product attribute")
def delete_attribute(attribute_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(products_access)):
    attribute = attribute_service.get(db, attribute_id)
    label, code = attribute.label, attribute.code
    attribute_service.delete(db, attribute_id)
    audit.record(db, "attributes.delete", resource_type="attributes", resource_id=attribute_id, actor=admin,
                 summary=f"Deleted attribute {label} ({code})")
    db.commit()
    return ok(message="Attribute deleted.")


class ProductAttributesIn(CamelModel):
    values: Dict[str, Any] = Field(default_factory=dict)


@product_attributes_router.get("/{product_id}/attributes", summary="A product's attribute values")
def get_product_attributes(product_id: str, db: Session = Depends(get_db),
                           admin: AdminUser = Depends(products_access)):
    return ok(attribute_service.product_values(db, product_id))


@product_attributes_router.put("/{product_id}/attributes", summary="Set a product's attribute values")
def set_product_attributes(product_id: str, payload: ProductAttributesIn, db: Session = Depends(get_db),
                           admin: AdminUser = Depends(products_access)):
    changed = attribute_service.set_product_values(db, product_id, payload.values)
    if changed:
        audit.record(db, "products.attributes", resource_type="products", resource_id=product_id, actor=admin,
                     summary=f"Changed attributes of {product_id}: {', '.join(changed)}",
                     changes={"attributes": changed})
    db.commit()
    if changed:
        search_index.refresh_quietly(db, [product_id])
    return ok(attribute_service.product_values(db, product_id), message="Attributes saved.")


# ------------------------------------------------------------- analytics


@admin_router.get("/analytics", summary="Search analytics")
def search_analytics(range_key: Literal["7d", "30d", "90d"] = Query("30d", alias="range"),
                     db: Session = Depends(get_db), admin: AdminUser = Depends(search_access)):
    data = analytics.report(db, range_key)
    db.commit()  # today's aggregate, refreshed for the report
    return ok(data)


def _settings_view(db: Session) -> dict:
    document = search_settings.document(db)
    return {
        "popularMode": search_settings.popular_mode(db),
        "popularSearches": search_settings.curated_popular(db),
        "autoPopular": analytics.auto_popular(db),
        "synonyms": search_settings.synonym_groups(db),
        "lastRebuildAt": document.get("lastRebuildAt"),
        "dictionarySize": dictionary.size(db),
    }


class SearchSettingsIn(CamelModel):
    popular_mode: Optional[Literal["curated", "auto"]] = None
    popular_searches: Optional[List[str]] = Field(default=None, max_length=50)
    synonyms: Optional[List[Union[List[str], str]]] = Field(default=None, max_length=500)


@admin_router.get("/settings", summary="Search settings")
def get_search_settings(db: Session = Depends(get_db), admin: AdminUser = Depends(search_access)):
    return ok(_settings_view(db))


@admin_router.put("/settings", summary="Save search settings")
def save_search_settings(payload: SearchSettingsIn, db: Session = Depends(get_db),
                         admin: AdminUser = Depends(search_access)):
    search_settings.save(db, popular_mode=payload.popular_mode, popular_searches=payload.popular_searches,
                         synonyms=payload.synonyms)
    audit.record(db, "search.settings", resource_type="search", resource_id="settings", actor=admin,
                 summary="Changed the search settings",
                 changes={"fields": sorted(payload.model_dump(exclude_unset=True).keys())})
    db.commit()
    return ok(_settings_view(db), message="Search settings saved.")


@admin_router.post("/rebuild", summary="Rebuild the search index and dictionary now")
def rebuild_search(db: Session = Depends(get_db), admin: AdminUser = Depends(search_access)):
    counts = jobs.rebuild(db)
    audit.record(db, "search.rebuild", resource_type="search", resource_id="index", actor=admin,
                 summary=f"Rebuilt the search index ({counts['products']} products, {counts['terms']} terms)")
    db.commit()
    return ok({"terms": counts["terms"], "products": counts["products"], "unitsSold": counts["unitsSold"]},
              message="Search index rebuilt.")
