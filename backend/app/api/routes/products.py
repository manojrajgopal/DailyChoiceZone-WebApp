"""Product endpoints.

One resource, two doors. `/api/products` is the product itself — public to
read, administrator to write, so creating a product is `POST /api/products`
rather than a parallel admin verb. `/api/admin/products` is the portal's *read*
of the same records: a wider projection carrying management fields, and drafts
the public list must never show.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.dependencies.auth import get_current_admin, require_permission
from app.models import AdminUser
from app.schemas.catalogue import (
    AdminProductOut,
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


def _query(
    page: int = Query(1, ge=1),
    page_size: int = Query(24, ge=1, le=100, alias="pageSize"),
    search: Optional[str] = None,
    category: Optional[str] = None,
    subcategory: Optional[str] = None,
    collection: Optional[str] = None,
    brands: Optional[str] = None,
    sizes: Optional[str] = None,
    colors: Optional[str] = None,
    min_price: Optional[float] = Query(None, alias="minPrice"),
    max_price: Optional[float] = Query(None, alias="maxPrice"),
    min_rating: Optional[float] = Query(None, alias="minRating"),
    min_discount: Optional[int] = Query(None, alias="minDiscount"),
    in_stock_only: bool = Query(False, alias="inStockOnly"),
    is_new: Optional[bool] = Query(None, alias="isNew"),
    is_trending: Optional[bool] = Query(None, alias="isTrending"),
    is_best_seller: Optional[bool] = Query(None, alias="isBestSeller"),
    is_featured: Optional[bool] = Query(None, alias="isFeatured"),
    sort: SortOption = "recommended",
) -> ProductQuery:
    """
    Query parameters, in one dependency.

    Declared explicitly rather than accepted as a dict so they appear in the
    OpenAPI document — a filter nobody can discover is a filter nobody uses.
    """
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
        min_rating=min_rating,
        min_discount=min_discount,
        in_stock_only=in_stock_only,
        is_new=is_new,
        is_trending=is_trending,
        is_best_seller=is_best_seller,
        is_featured=is_featured,
        sort=sort,
    )


@router.get("", summary="List products")
def list_products(query: ProductQuery = Depends(_query), db: Session = Depends(get_db)):
    """
    The catalogue, filtered, sorted and paged.

    Every filter the storefront offers is a parameter here rather than an
    endpoint of its own — `?isNew=true` and `?category=women&sort=price-asc`
    are the same operation with different arguments.
    """
    items, total = service.list_products(db, query)
    return ok_list(
        [ProductOut.from_model(p).model_dump(by_alias=True) for p in items],
        Pagination.build(query.page, query.page_size, total),
    )


@router.get("/facets", summary="Filter options with counts")
def get_facets(query: ProductQuery = Depends(_query), db: Session = Depends(get_db)):
    from app.repositories import products as repo

    facets = repo.build_facets(db, query)
    return ok(ProductFacets(**facets).model_dump(by_alias=True))


@router.get("/slug/{slug}", summary="Get a product by its URL slug")
def get_by_slug(slug: str, db: Session = Depends(get_db)):
    """
    The storefront routes by slug (`/product/wool-blend-overcoat`), so it needs
    to resolve one. A separate path rather than a query parameter, because this
    is still a single-resource lookup — just by a different natural key.
    """
    product = service.get_product_by_slug(db, slug)
    return ok(ProductOut.from_model(product).model_dump(by_alias=True))


@router.get("/{product_id}", summary="Get a product by id")
def get_product(product_id: str, db: Session = Depends(get_db)):
    """`GET /api/products/PRD001`."""
    product = service.get_product(db, product_id, published_only=True)
    return ok(ProductOut.from_model(product).model_dump(by_alias=True))


@router.get("/{product_id}/related", summary="Products to look at next")
def get_related(product_id: str, limit: int = Query(6, ge=1, le=24), db: Session = Depends(get_db)):
    from app.repositories import products as repo

    product = service.get_product(db, product_id, published_only=True)
    related = repo.get_related(db, product, limit)
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
    product = service.update_product(db, product_id, payload, actor=admin.id)
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


@admin_router.get("", summary="List every product, including drafts")
def list_all_products(
    query: ProductQuery = Depends(_query),
    status: Optional[str] = None,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    """The portal's product list: management fields, and drafts included."""
    query.include_unpublished = True
    query.status = status
    query.page_size = min(query.page_size, 100)

    items, total = service.list_products(db, query)
    return ok_list(
        [AdminProductOut.from_model(p).model_dump(by_alias=True) for p in items],
        Pagination.build(query.page, query.page_size, total),
    )


@admin_router.get("/{product_id}", summary="Get a product with its management fields")
def get_admin_product(
    product_id: str,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    product = service.get_product(db, product_id)
    return ok(AdminProductOut.from_model(product).model_dump(by_alias=True))
