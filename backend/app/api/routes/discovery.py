"""
Product discovery: recently viewed, saved for later, recommendations, size
guides and availability by location. See docs/product-discovery.md.

Storefront

    GET    /api/recently-viewed                       your history, newest first (paged)
    POST   /api/recently-viewed                       record a product view
    POST   /api/recently-viewed/merge                 a guest's history, at sign-in
    DELETE /api/recently-viewed/{productId}           forget one product
    DELETE /api/recently-viewed                       forget them all

    GET    /api/cart/saved                            saved for later
    POST   /api/cart/items/{itemId}/save-for-later    move a bag line to saved
    POST   /api/cart/saved/{id}/move-to-cart          back to the bag (re-checked)
    PUT    /api/cart/saved/{id}                       change the quantity
    DELETE /api/cart/saved/{id}                       remove one
    DELETE /api/cart/saved                            remove them all
    POST   /api/cart/saved/merge                      a guest's saved lines, at sign-in
    GET    /api/cart/availability?pincode=            every bag line against a pincode

    GET    /api/products/{id}/availability            this product, variant and quantity at a pincode
    GET    /api/products/{id}/size-guide              the size guide it shows, in cm or inches
    GET    /api/recommendations/for-you               recommended for you (signed in, or ?seed= ids)

Portal

    GET/POST       /api/admin/products/{id}/relationships
    PUT/DELETE     /api/admin/products/{id}/relationships/{relationshipId}
    PUT            /api/admin/products/{id}/relationships/order
    GET            /api/admin/products/{id}/recommendations     preview, with where each entry came from
    GET/PUT        /api/admin/products/{id}/size-guide
    GET/PUT        /api/admin/products/{id}/delivery            the product's own delivery rules
    GET/POST       /api/admin/size-guides
    GET/PUT/DELETE /api/admin/size-guides/{id}
    PUT            /api/admin/size-guides/{id}/categories
    PUT            /api/admin/size-guides/{id}/products
    GET            /api/admin/discovery/summary                 recently-viewed figures
    GET            /api/admin/customers/{id}/discovery          one customer's history and saved lines
"""

from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, Query, Request
from pydantic import Field
from sqlalchemy.orm import Session

from app.core import rate_limit
from app.core.database import get_db
from app.core.errors import NotFoundError
from app.dependencies.auth import client_ip, get_current_customer, get_optional_customer, require_access
from app.models import AdminUser, Customer
from app.schemas.base import CamelModel
from app.schemas.catalogue import ProductOut
from app.services import (
    availability,
    product_relationships,
    recently_viewed,
    recommendations,
    saved_for_later,
    size_guides,
)
from app.services.cart import MAX_QUANTITY_PER_LINE
from app.utils.response import Pagination, ok, ok_list

recently_viewed_router = APIRouter(prefix="/recently-viewed", tags=["Recently viewed"])
saved_router = APIRouter(prefix="/cart", tags=["Saved for later"])
product_router = APIRouter(prefix="/products", tags=["Products"])
recommendations_router = APIRouter(prefix="/recommendations", tags=["Recommendations"])
admin_product_router = APIRouter(prefix="/admin/products", tags=["Admin · Product discovery"])
admin_size_guide_router = APIRouter(prefix="/admin/size-guides", tags=["Admin · Size guides"])
admin_discovery_router = APIRouter(prefix="/admin", tags=["Admin · Product discovery"])


def _products(items) -> list:
    return [ProductOut.from_model(p).model_dump(by_alias=True) for p in items]


# ---------------------------------------------------------- recently viewed


class ViewIn(CamelModel):
    product_id: str = Field(min_length=1, max_length=20)
    color: Optional[str] = Field(default=None, max_length=60)
    size: Optional[str] = Field(default=None, max_length=30)
    source: Optional[str] = Field(default=None, max_length=40)


class GuestView(CamelModel):
    product_id: str = Field(min_length=1, max_length=20)
    # ISO-8601 or milliseconds since the epoch, as the browser kept it.
    viewed_at: Optional[str | int | float] = None
    color: Optional[str] = Field(default=None, max_length=60)
    size: Optional[str] = Field(default=None, max_length=30)


class GuestViews(CamelModel):
    items: List[GuestView] = Field(default_factory=list, max_length=recently_viewed.MAX_MERGE_ITEMS)


@recently_viewed_router.get("", summary="Your recently viewed products")
def list_recently_viewed(
    page: int = Query(1, ge=1),
    page_size: int = Query(12, ge=1, le=50, alias="pageSize"),
    exclude: Optional[str] = Query(None, max_length=20),
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    items, total = recently_viewed.listing(db, customer, page=page, page_size=page_size, exclude=exclude)
    return ok_list([recently_viewed.view(e) for e in items], Pagination.build(page, page_size, total))


@recently_viewed_router.post("", status_code=202, summary="Record a product view")
def record_view(payload: ViewIn, request: Request, db: Session = Depends(get_db),
                customer: Customer = Depends(get_current_customer)):
    # Far above a person browsing; well below a script filling the table.
    rate_limit.check(f"recently-viewed:{customer.id}", limit=120, window_seconds=60,
                     message="Too many product views recorded. Please slow down.")
    written = recently_viewed.record(db, customer, payload.product_id, color=payload.color, size=payload.size,
                                     source=payload.source)
    return ok({"recorded": written})


@recently_viewed_router.post("/merge", summary="Bring a guest's history into the account")
def merge_recently_viewed(payload: GuestViews, db: Session = Depends(get_db),
                          customer: Customer = Depends(get_current_customer)):
    rate_limit.check(f"recently-viewed-merge:{customer.id}", limit=10, window_seconds=60)
    result = recently_viewed.merge(db, customer, [item.model_dump(by_alias=True) for item in payload.items])
    return ok(result)


@recently_viewed_router.delete("/{product_id}", summary="Forget one product")
def forget_one(product_id: str, db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    if not recently_viewed.remove(db, customer, product_id[:20]):
        raise NotFoundError("That product isn't in your recently viewed.", error_code="NOT_IN_HISTORY")
    return ok(message="Removed from recently viewed.")


@recently_viewed_router.delete("", summary="Forget every product")
def forget_all(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    removed = recently_viewed.clear(db, customer)
    return ok({"removed": removed}, message="Recently viewed cleared.")


# ---------------------------------------------------------- saved for later


class SavedQuantity(CamelModel):
    quantity: int = Field(ge=1, le=MAX_QUANTITY_PER_LINE)


class MoveToCart(CamelModel):
    quantity: Optional[int] = Field(default=None, ge=1, le=MAX_QUANTITY_PER_LINE)


class GuestSavedLine(CamelModel):
    product_id: str = Field(min_length=1, max_length=20)
    size: Optional[str] = Field(default=None, max_length=30)
    color: Optional[str] = Field(default=None, max_length=60)
    quantity: int = Field(default=1, ge=1, le=MAX_QUANTITY_PER_LINE)


class GuestSavedLines(CamelModel):
    items: List[GuestSavedLine] = Field(default_factory=list, max_length=saved_for_later.MAX_MERGE_ITEMS)


def _saved(db: Session, customer: Customer, **extra) -> dict:
    return {"items": saved_for_later.listing(db, customer), "limit": saved_for_later.limit(), **extra}


def _with_cart(db: Session, customer: Customer, **extra) -> dict:
    """The saved lines and the bag together, so the page redraws both from one response."""
    from app.api.routes.cart import _render
    from app.services import cart as cart_service

    return {"saved": _saved(db, customer), "cart": _render(cart_service.get_cart(db, customer)), **extra}


@saved_router.get("/saved", summary="Saved for later")
def list_saved(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    return ok(_saved(db, customer))


@saved_router.post("/items/{item_id}/save-for-later", summary="Move a bag line to saved for later")
def save_for_later(item_id: int, db: Session = Depends(get_db),
                   customer: Customer = Depends(get_current_customer)):
    saved_for_later.save_from_cart(db, customer, item_id)
    return ok(_with_cart(db, customer), message="Saved for later.")


@saved_router.post("/saved/merge", summary="Bring a guest's saved lines into the account")
def merge_saved(payload: GuestSavedLines, db: Session = Depends(get_db),
                customer: Customer = Depends(get_current_customer)):
    rate_limit.check(f"saved-merge:{customer.id}", limit=10, window_seconds=60)
    result = saved_for_later.merge(db, customer, [i.model_dump(by_alias=True) for i in payload.items])
    return ok(_saved(db, customer, **result))


@saved_router.post("/saved/{saved_id}/move-to-cart", summary="Move a saved line back to the bag")
def move_to_cart(saved_id: int, payload: Optional[MoveToCart] = None, db: Session = Depends(get_db),
                 customer: Customer = Depends(get_current_customer)):
    result = saved_for_later.move_to_cart(db, customer, saved_id,
                                          quantity=payload.quantity if payload is not None else None)
    return ok(_with_cart(db, customer, moved=result["moved"]), message=result["message"] or "Moved to your bag.")


@saved_router.put("/saved/{saved_id}", summary="Change a saved line's quantity")
def update_saved(saved_id: int, payload: SavedQuantity, db: Session = Depends(get_db),
                 customer: Customer = Depends(get_current_customer)):
    saved_for_later.update_quantity(db, customer, saved_id, payload.quantity)
    return ok(_saved(db, customer))


@saved_router.delete("/saved/{saved_id}", summary="Remove a saved line")
def remove_saved(saved_id: int, db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    saved_for_later.remove(db, customer, saved_id)
    return ok(_saved(db, customer), message="Removed.")


@saved_router.delete("/saved", summary="Remove every saved line")
def clear_saved(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    saved_for_later.clear(db, customer)
    return ok(_saved(db, customer), message="Saved for later cleared.")


@saved_router.get("/availability", summary="Every bag line against one pincode")
def cart_availability(request: Request, pincode: str = Query(..., min_length=1, max_length=10),
                      db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    rate_limit.check(f"pincode:{client_ip(request)}", limit=60, window_seconds=300,
                     message="Too many pincode checks. Please wait a moment.")
    return ok(availability.check_cart(db, customer, pincode))


# ---------------------------------------------------------- product pages


@product_router.get("/{identifier}/availability", summary="Can this be delivered here, and when")
def product_availability(
    identifier: str,
    request: Request,
    pincode: str = Query(..., min_length=1, max_length=10),
    size: Optional[str] = Query(None, max_length=30),
    color: Optional[str] = Query(None, max_length=60),
    quantity: int = Query(1, ge=1, le=MAX_QUANTITY_PER_LINE),
    db: Session = Depends(get_db),
):
    # The same budget as the plain pincode check: generous for a person, tight
    # for a script mapping the store's coverage.
    rate_limit.check(f"pincode:{client_ip(request)}", limit=60, window_seconds=300,
                     message="Too many pincode checks. Please wait a moment.")
    return ok(availability.check_product(db, identifier, pincode=pincode, size=size, color=color,
                                         quantity=quantity))


@product_router.get("/{identifier}/size-guide", summary="The size guide this product shows")
def product_size_guide(identifier: str, unit: Optional[str] = Query(None, pattern="^(cm|in|mm)$"),
                       db: Session = Depends(get_db)):
    from app.services import products as product_service

    product = product_service.get_product_by_identifier(db, identifier)
    return ok(size_guides.for_product(db, product, unit=unit))


@recommendations_router.get("/for-you", summary="Recommended for you")
def for_you(
    limit: int = Query(8, ge=1, le=24),
    seed: Optional[str] = Query(None, max_length=250, description="A guest's recently viewed ids, comma-separated"),
    db: Session = Depends(get_db),
    customer: Optional[Customer] = Depends(get_optional_customer),
):
    seeds = [s.strip()[:20] for s in (seed or "").split(",") if s.strip()][:6]
    items = recommendations.for_shopper(db, customer_id=customer.id if customer else None, seed_ids=seeds,
                                        limit=limit)
    return ok_list(_products(items))


# ---------------------------------------------------------- portal: relationships


class RelationshipIn(CamelModel):
    related_product_id: Optional[str] = Field(default=None, max_length=20)
    related_product_ids: Optional[List[str]] = Field(default=None, max_length=product_relationships.MAX_PER_TYPE)
    type: str = Field(default="related", max_length=30)
    active: bool = True
    reciprocal: bool = False


class RelationshipUpdate(CamelModel):
    active: Optional[bool] = None
    type: Optional[str] = Field(default=None, max_length=30)


class RelationshipOrder(CamelModel):
    type: str = Field(max_length=30)
    ids: List[int] = Field(max_length=product_relationships.MAX_PER_TYPE)


@admin_product_router.get("/{product_id}/relationships", summary="A product's chosen relationships")
def list_relationships(product_id: str, type: Optional[str] = Query(None, max_length=30),
                       db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("products"))):
    return ok(product_relationships.listing(db, product_id, kind=type))


@admin_product_router.post("/{product_id}/relationships", status_code=201, summary="Relate products")
def add_relationships(product_id: str, payload: RelationshipIn, db: Session = Depends(get_db),
                      admin: AdminUser = Depends(require_access("products"))):
    from app.services import audit

    body = payload.model_dump(by_alias=True, exclude_none=True)
    created = product_relationships.create(db, product_id, body, actor=admin.id)
    audit.record(db, "products.relationships.create", resource_type="products", resource_id=product_id,
                 actor=admin, summary=f"Related {len(created)} product(s) to {product_id} as {payload.type}",
                 details={"relatedProductIds": [r.related_product_id for r in created],
                          "reciprocal": payload.reciprocal})
    db.commit()
    return ok(product_relationships.listing(db, product_id), message="Relationship added.")


@admin_product_router.put("/{product_id}/relationships/order", summary="Reorder one type's relationships")
def order_relationships(product_id: str, payload: RelationshipOrder, db: Session = Depends(get_db),
                        admin: AdminUser = Depends(require_access("products"))):
    listing = product_relationships.reorder(db, product_id, payload.type, payload.ids)
    db.commit()
    return ok(listing, message="Order saved.")


@admin_product_router.put("/{product_id}/relationships/{relationship_id}", summary="Edit a relationship")
def edit_relationship(product_id: str, relationship_id: int, payload: RelationshipUpdate,
                      db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("products"))):
    product_relationships.update(db, product_id, relationship_id, payload.model_dump(exclude_none=True))
    db.commit()
    return ok(product_relationships.listing(db, product_id), message="Relationship saved.")


@admin_product_router.delete("/{product_id}/relationships/{relationship_id}", summary="Remove a relationship")
def remove_relationship(product_id: str, relationship_id: int, db: Session = Depends(get_db),
                        admin: AdminUser = Depends(require_access("products"))):
    from app.services import audit

    product_relationships.delete(db, product_id, relationship_id)
    audit.record(db, "products.relationships.delete", resource_type="products", resource_id=product_id,
                 actor=admin, summary=f"Removed relationship {relationship_id} from {product_id}")
    db.commit()
    return ok(product_relationships.listing(db, product_id), message="Relationship removed.")


@admin_product_router.get("/{product_id}/recommendations", summary="Preview a product's recommendations")
def preview_recommendations(product_id: str, type: str = Query("related", max_length=30),
                            limit: int = Query(8, ge=1, le=24), db: Session = Depends(get_db),
                            admin: AdminUser = Depends(require_access("products"))):
    from app.services import products as product_service

    product = product_service.get_product(db, product_id)
    if type not in recommendations.TYPES:
        from app.core.errors import ValidationError

        raise ValidationError(f"Unknown recommendation type '{type}'.", error_code="INVALID_TYPE")
    return ok({"type": type, "items": recommendations.explain(db, product, type, limit)})


# ---------------------------------------------------------- portal: size guides


class SizeGuideAssignment(CamelModel):
    size_guide_id: Optional[str] = Field(default=None, max_length=20)


class CategoryAssignment(CamelModel):
    category_ids: List[str] = Field(default_factory=list, max_length=200)


class ProductAssignment(CamelModel):
    product_ids: List[str] = Field(default_factory=list, max_length=500)
    mode: str = Field(default="add", pattern="^(add|remove|replace)$")


@admin_product_router.get("/{product_id}/size-guide", summary="The guide a product shows, and its own")
def get_product_size_guide(product_id: str, db: Session = Depends(get_db),
                           admin: AdminUser = Depends(require_access("products"))):
    from app.models import ProductSizeGuide
    from app.services import products as product_service

    product = product_service.get_product(db, product_id)
    own = db.get(ProductSizeGuide, product.id)
    guide, source = size_guides.resolve(db, product)
    return ok({
        "assignedGuideId": own.size_guide_id if own else None,
        "source": source,
        "guide": size_guides.view(guide, product_sizes=[s.label for s in product.sizes], source=source)
        if guide else None,
    })


@admin_product_router.put("/{product_id}/size-guide", summary="Give a product its own guide, or none")
def set_product_size_guide(product_id: str, payload: SizeGuideAssignment, db: Session = Depends(get_db),
                           admin: AdminUser = Depends(require_access("products"))):
    from app.services import audit

    size_guides.set_for_product(db, product_id, payload.size_guide_id)
    audit.record(db, "size-guides.assign", resource_type="products", resource_id=product_id, actor=admin,
                 summary=f"Size guide for {product_id}: {payload.size_guide_id or 'category default'}")
    db.commit()
    return get_product_size_guide(product_id, db, admin)


@admin_size_guide_router.get("", summary="Size guides")
def list_size_guides(
    q: str = Query("", max_length=80),
    status: str = Query("", max_length=10),
    kind: str = Query("", max_length=20),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_access("products")),
):
    rows, total = size_guides.search(db, q=q, status=status, kind=kind, page=page, page_size=page_size)
    return ok({"items": [size_guides.admin_view(db, g) for g in rows],
               "pagination": Pagination.build(page, page_size, total).model_dump(),
               "templates": size_guides.TEMPLATES})


@admin_size_guide_router.post("", status_code=201, summary="Create a size guide")
def create_size_guide(payload: dict, db: Session = Depends(get_db),
                      admin: AdminUser = Depends(require_access("products"))):
    from app.services import audit

    guide = size_guides.create(db, payload, actor=admin.id)
    audit.record(db, "size-guides.create", resource_type="size-guides", resource_id=guide.id, actor=admin,
                 summary=f"Created size guide {guide.name}")
    db.commit()
    return ok(size_guides.admin_view(db, guide, with_products=True), message="Size guide created.")


@admin_size_guide_router.get("/{guide_id}", summary="A size guide")
def get_size_guide(guide_id: str, db: Session = Depends(get_db),
                   admin: AdminUser = Depends(require_access("products"))):
    return ok(size_guides.admin_view(db, size_guides.get(db, guide_id), with_products=True))


@admin_size_guide_router.put("/{guide_id}", summary="Edit a size guide")
def update_size_guide(guide_id: str, payload: dict, db: Session = Depends(get_db),
                      admin: AdminUser = Depends(require_access("products"))):
    from app.services import audit

    guide = size_guides.update(db, guide_id, payload, actor=admin.id)
    audit.record(db, "size-guides.update", resource_type="size-guides", resource_id=guide.id, actor=admin,
                 summary=f"Changed size guide {guide.name}" + (f" ({guide.status})" if "status" in payload else ""))
    db.commit()
    db.refresh(guide)
    return ok(size_guides.admin_view(db, guide, with_products=True), message="Size guide saved.")


@admin_size_guide_router.delete("/{guide_id}", summary="Delete a size guide")
def delete_size_guide(guide_id: str, db: Session = Depends(get_db),
                      admin: AdminUser = Depends(require_access("products"))):
    from app.services import audit

    usage = size_guides.delete(db, guide_id)
    audit.record(db, "size-guides.delete", resource_type="size-guides", resource_id=guide_id, actor=admin,
                 summary=f"Deleted size guide {guide_id}", details=usage)
    db.commit()
    return ok(usage, message="Size guide deleted.")


@admin_size_guide_router.put("/{guide_id}/categories", summary="The categories a guide is the default for")
def set_size_guide_categories(guide_id: str, payload: CategoryAssignment, db: Session = Depends(get_db),
                              admin: AdminUser = Depends(require_access("products"))):
    result = size_guides.set_categories(db, guide_id, payload.category_ids)
    db.commit()
    return ok(result, message="Categories saved.")


@admin_size_guide_router.put("/{guide_id}/products", summary="Give products this guide, or take it away")
def set_size_guide_products(guide_id: str, payload: ProductAssignment, db: Session = Depends(get_db),
                            admin: AdminUser = Depends(require_access("products"))):
    result = size_guides.assign_products(db, guide_id, payload.product_ids, mode=payload.mode)
    db.commit()
    return ok(result, message="Products saved.")


# ---------------------------------------------------------- portal: delivery rules


@admin_product_router.get("/{product_id}/delivery", summary="A product's own delivery rules")
def get_product_delivery(product_id: str, db: Session = Depends(get_db),
                         admin: AdminUser = Depends(require_access("shipping"))):
    return ok(availability.profile_view(db, product_id))


@admin_product_router.put("/{product_id}/delivery", summary="Save a product's own delivery rules")
def save_product_delivery(product_id: str, payload: dict, db: Session = Depends(get_db),
                          admin: AdminUser = Depends(require_access("shipping"))):
    from app.services import audit

    view = availability.save_profile(db, product_id, payload, actor=admin.id)
    audit.record(db, "products.delivery.update", resource_type="products", resource_id=product_id, actor=admin,
                 summary=f"Delivery rules for {product_id}: COD {'on' if view['codAllowed'] else 'off'}, "
                         f"express {'on' if view['expressAllowed'] else 'off'}, "
                         f"{len(view['exclusions'])} exclusion(s)")
    db.commit()
    return ok(view, message="Delivery rules saved.")


# ---------------------------------------------------------- portal: insight


@admin_discovery_router.get("/discovery/summary", summary="Recently viewed, across the store")
def discovery_summary(days: int = Query(30, ge=1, le=365), db: Session = Depends(get_db),
                      admin: AdminUser = Depends(require_access("analytics"))):
    return ok(recently_viewed.admin_summary(db, days=days))


@admin_discovery_router.get("/customers/{customer_id}/discovery", summary="A customer's history and saved lines")
def customer_discovery(customer_id: str, db: Session = Depends(get_db),
                       admin: AdminUser = Depends(require_access("customers"))):
    if db.get(Customer, customer_id) is None:
        raise NotFoundError("No such customer.", error_code="CUSTOMER_NOT_FOUND")
    return ok({"recentlyViewed": recently_viewed.for_customer(db, customer_id),
               "savedForLater": saved_for_later.admin_view(db, customer_id)})
