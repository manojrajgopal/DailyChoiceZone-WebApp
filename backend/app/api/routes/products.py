"""Product endpoints.

One resource, two doors. `/api/products` is the product itself — public to
read, administrator to write, so creating a product is `POST /api/products`
rather than a parallel admin verb. `/api/admin/products` is the portal's *read*
of the same records: a wider projection carrying management fields, and drafts
the public list must never show.
"""

from __future__ import annotations

import math
import re
from typing import Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, Query, Request
from pydantic import ValidationError as PydanticValidationError
from sqlalchemy.orm import Session

from app.core import rate_limit
from app.core.database import get_db
from app.core.errors import ValidationError
from app.dependencies.auth import client_ip, get_current_admin, get_optional_customer, require_permission
from app.models import AdminUser, Customer
from app.schemas.catalogue import (
    AdminProductOut,
    AttributeFilter,
    ProductFacets,
    ProductOut,
    ProductQuery,
    ProductWrite,
    SortOption,
)
from app.services import products as service
from app.utils.response import Pagination, ok, ok_list

router = APIRouter(prefix="/products", tags=["Products"])

# The portal reads a different *projection* of the same resource — management
# fields the customer payload must never carry, and drafts the public list must
# never show. Same module, different door.
admin_router = APIRouter(prefix="/admin/products", tags=["Admin"])


ATTRIBUTE_PARAM = "attr."
_VISITOR = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def _attribute_filters(request: Request) -> List[AttributeFilter]:
    """
    `attr.<code>=a,b`, `attr.<code>.min=` and `attr.<code>.max=`, read from the raw query string.

    They are dynamic (one per attribute the store defines), so they can't be
    declared one by one. Bounded and forgiving: at most 20 codes and 30
    values each, junk numbers ignored; unknown codes are dropped later, against
    the attributes that exist.
    """
    filters: Dict[str, AttributeFilter] = {}
    for key, raw in request.query_params.multi_items():
        if not key.startswith(ATTRIBUTE_PARAM) or len(key) > 60:
            continue
        code, _, bound = key[len(ATTRIBUTE_PARAM):].partition(".")
        code = code.strip().lower()
        if not code or len(code) > 40 or bound not in ("", "min", "max"):
            continue
        if code not in filters:
            if len(filters) >= 20:
                continue
            filters[code] = AttributeFilter(code=code)
        entry = filters[code]
        if bound:
            try:
                number = float(raw)
            except ValueError:
                continue
            if math.isfinite(number) and abs(number) <= 1_000_000_000:
                setattr(entry, bound, number)
        else:
            values = [v.strip().lower()[:120] for v in raw.split(",") if v.strip()]
            entry.values = list(dict.fromkeys(entry.values + values))[:30]
    return list(filters.values())


def _query(
    request: Request,
    page: int = Query(1, ge=1),
    page_size: int = Query(24, ge=1, le=100, alias="pageSize"),
    search: Optional[str] = Query(None, max_length=200),
    category: Optional[str] = Query(None, max_length=6000),
    subcategory: Optional[str] = Query(None, max_length=6000),
    collection: Optional[str] = Query(None, max_length=120),
    brands: Optional[str] = Query(None, max_length=6000),
    sizes: Optional[str] = Query(None, max_length=6000),
    colors: Optional[str] = Query(None, max_length=6000),
    min_price: Optional[float] = Query(None, alias="minPrice", ge=0, le=10_000_000),
    max_price: Optional[float] = Query(None, alias="maxPrice", ge=0, le=10_000_000),
    min_rating: Optional[float] = Query(None, alias="minRating", ge=0, le=5),
    rating: Optional[float] = Query(None, ge=0, le=5, description="Alias of minRating."),
    min_discount: Optional[int] = Query(None, alias="minDiscount", ge=0, le=100),
    in_stock_only: bool = Query(False, alias="inStockOnly"),
    availability: Optional[Literal["in-stock", "out-of-stock"]] = None,
    is_new: Optional[bool] = Query(None, alias="isNew"),
    is_trending: Optional[bool] = Query(None, alias="isTrending"),
    is_best_seller: Optional[bool] = Query(None, alias="isBestSeller"),
    is_featured: Optional[bool] = Query(None, alias="isFeatured"),
) -> ProductQuery:
    """
    Query parameters, in one dependency.

    Declared explicitly rather than accepted as a dict so they appear in the
    OpenAPI document — a filter nobody can discover is a filter nobody uses.
    The `attr.<code>` filters are the exception, being one per attribute the
    store defines (see `_attribute_filters`).
    """
    try:
        return ProductQuery(
            page=page,
            page_size=page_size,
            search=search,
            category=category,
            subcategory=subcategory,
            collection=collection,
            brands=brands,
            sizes=sizes,
            colors=colors,
            min_price=min_price,
            max_price=max_price,
            min_rating=min_rating if min_rating is not None else rating,
            min_discount=min_discount,
            in_stock_only=in_stock_only,
            availability=availability,
            is_new=is_new,
            is_trending=is_trending,
            is_best_seller=is_best_seller,
            is_featured=is_featured,
            attributes=_attribute_filters(request),
        )
    except PydanticValidationError as error:
        raise ValidationError(
            "Some filters aren't valid.", error_code="VALIDATION_ERROR",
            details=[{"field": ".".join(str(part) for part in e.get("loc", ())), "message": e.get("msg")}
                     for e in error.errors()],
        ) from None


def _visitor(visitor_id: Optional[str]) -> Optional[str]:
    return visitor_id if visitor_id and _VISITOR.match(visitor_id) else None


@router.get("", summary="List products")
def list_products(
    request: Request,
    query: ProductQuery = Depends(_query),
    sort: Optional[SortOption] = None,
    visitor_id: Optional[str] = Query(None, alias="visitorId", max_length=64),
    db: Session = Depends(get_db),
    customer: Optional[Customer] = Depends(get_optional_customer),
):
    """
    The catalogue, filtered, sorted and paged.

    Every filter the storefront offers is a parameter here rather than an
    endpoint of its own — `?isNew=true` and `?category=women&sort=price-asc`
    are the same operation with different arguments. With `search`, results
    are ranked by relevance unless another sort is asked for, a term that
    finds nothing falls back to its dictionary correction, and page 1 is
    logged for the search analytics (`search.searchId`).
    """
    from app.services.search import listing

    if query.search and query.search.strip():
        rate_limit.check(f"search:{client_ip(request)}", limit=120, window_seconds=60)
    if sort:
        query.sort = sort
    items, total, meta = listing.list_products(db, query, sort=sort, log=True, visitor_id=_visitor(visitor_id),
                                               customer_id=customer.id if customer else None)
    body = ok_list(
        [ProductOut.from_model(p).model_dump(by_alias=True) for p in items],
        Pagination.build(query.page, query.page_size, total),
    )
    if meta is not None:
        body["search"] = {"term": meta["term"], "correctedTerm": meta["corrected_term"],
                          "searchId": meta["search_id"]}
    return body


@router.get("/facets", summary="Filter options with counts")
def get_facets(request: Request, query: ProductQuery = Depends(_query), db: Session = Depends(get_db)):
    """Counts for every filter, each with all the *other* filters applied (docs/search-and-filters.md)."""
    from app.services.search import listing

    if query.search and query.search.strip():
        rate_limit.check(f"search-facets:{client_ip(request)}", limit=120, window_seconds=60)
    return ok(ProductFacets(**listing.facets(db, query)).model_dump(by_alias=True))


@router.get("/{identifier}", summary="Get a product by id or slug")
def get_product(identifier: str, db: Session = Depends(get_db)):
    """
    `GET /api/products/PRD001`, and `GET /api/products/wool-blend-overcoat`.

    One route for one resource. The storefront addresses products by id, which
    is the identifier that survives a rename; the slug still resolves so that a
    link shared before the change, or a hand-typed URL, reaches the product
    rather than a 404.
    """
    product = service.get_product_by_identifier(db, identifier)
    return ok(ProductOut.from_model(product).model_dump(by_alias=True))


@router.get("/{identifier}/related", summary="Products to look at next")
def get_related(
    identifier: str,
    limit: int = Query(6, ge=1, le=24),
    type: str = Query("related", max_length=30,
                      description="related | similar | frequently-bought-together | alternative | accessory"),
    db: Session = Depends(get_db),
):
    """
    The store's chosen relationships first, then a weighted score over shared
    category, collection, brand, tags, price and what's bought together, then
    best sellers — see `services.recommendations`. Never the product itself,
    nothing unpublished, and out-of-stock items only after everything in stock.
    """
    from app.services import recommendations

    product = service.get_product_by_identifier(db, identifier)
    if type not in recommendations.TYPES:
        from app.core.errors import ValidationError

        raise ValidationError(f"Unknown recommendation type '{type}'.", error_code="INVALID_TYPE")
    related = recommendations.for_product(db, product, type, limit)
    return ok_list([ProductOut.from_model(p).model_dump(by_alias=True) for p in related])


# ---------------------------------------------------------------- writing


@router.post("", status_code=201, summary="Create a product")
def create_product(
    payload: ProductWrite,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("products")),
):
    product = service.create_product(db, payload, actor=admin.id)
    return ok(
        AdminProductOut.from_model(product).model_dump(by_alias=True),
        message="Product created.",
    )


@router.put("/{product_id}", summary="Update a product")
def update_product(
    product_id: str,
    payload: ProductWrite,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("products")),
):
    """
    Apply whatever the payload contains.

    Price, category, images, stock, status — all through here. Separate
    endpoints per field would be a dozen routes doing one thing each.
    """
    from app.models import Product
    from app.services import audit

    fields = ("name", "price", "original_price", "stock", "status", "tax_rate_percent", "low_stock_threshold",
              "category_id", "sku")
    current = db.get(Product, product_id)
    before = audit.snapshot(current, fields) if current is not None else {}
    product = service.update_product(db, product_id, payload, actor=admin.id)
    changes = audit.diff(before, audit.snapshot(product, fields))
    audit.record(db, "products.update", resource_type="products", resource_id=product.id, actor=admin,
                 summary=f"Changed product {product.name}" + (f" ({', '.join(changes)})" if changes else ""),
                 changes=changes or None)
    db.commit()
    db.refresh(product)
    return ok(
        AdminProductOut.from_model(product).model_dump(by_alias=True),
        message="Product updated.",
    )


@router.delete("/{product_id}", summary="Delete a product")
def delete_product(
    product_id: str,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("products")),
):
    service.delete_product(db, product_id)
    return ok(message="Product deleted.")


@router.post("/{product_id}/duplicate", status_code=201, summary="Duplicate a product as a draft")
def duplicate_product(
    product_id: str,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("products")),
):
    copy = service.duplicate_product(db, product_id, actor=admin.id)
    return ok(
        AdminProductOut.from_model(copy).model_dump(by_alias=True),
        message="Duplicated as a draft.",
    )


# ------------------------------------------------------------------ admin


AdminSort = Literal[
    "relevance", "recommended", "newest", "oldest", "price-asc", "price-desc", "rating", "popular",
    "best-selling", "discount", "availability",
    "name-asc", "name-desc", "stock-asc", "stock-desc", "updated", "category", "status",
]


@admin_router.get("", summary="List every product, including drafts")
def list_all_products(
    query: ProductQuery = Depends(_query),
    status: Optional[Literal["all", "active", "draft", "out-of-stock", "archived"]] = None,
    stock: Optional[Literal["in-stock", "low-stock", "out-of-stock"]] = None,
    sort: Optional[AdminSort] = None,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    """
    The portal's product list: management fields, drafts included, and every
    filter, sort and page worked out here — the portal never downloads the
    catalogue to filter it. `counts` are per status with every other filter
    applied; `filters` are the categories and brands for the dropdowns.
    """
    from app.repositories import products as repo
    from app.services.search import listing

    query.include_unpublished = True
    query.status = status
    query.stock_level = stock
    query.page_size = min(query.page_size, 100)

    prepared, _corrected = listing.prepare(db, query)
    chosen = sort or ("relevance" if not prepared.terms.empty else "recommended")
    items, total = repo.query_products(db, query, prepared=prepared, sort=chosen)
    body = ok_list(
        [AdminProductOut.from_model(p).model_dump(by_alias=True) for p in items],
        Pagination.build(query.page, query.page_size, total),
    )
    body["counts"] = repo.status_counts(db, prepared)
    body["filters"] = repo.filter_options(db)
    return body


@admin_router.get("/{product_id}", summary="Get a product with its management fields")
def get_admin_product(
    product_id: str,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    product = service.get_product(db, product_id)
    return ok(AdminProductOut.from_model(product).model_dump(by_alias=True))
