"""Categories, collections and inventory, for the portal."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.database import get_db
from app.dependencies.auth import get_current_admin, require_permission
from app.models import AdminUser, Product, StockAdjustment
from app.schemas.base import CamelModel
from app.schemas.catalogue import (
    CategoryOut,
    CategoryWrite,
    CollectionOut,
    CollectionWrite,
)
from app.services import catalogue as service, products as product_service
from app.utils.response import ok, ok_list

router = APIRouter(prefix="/admin", tags=["Admin"])
inventory_router = APIRouter(prefix="/admin/inventory", tags=["Inventory"])


# ------------------------------------------------------------ categories


@router.post("/categories", status_code=201, summary="Create a category")
def create_category(
    payload: CategoryWrite,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("products")),
):
    category = service.save_category(db, payload)
    return ok(CategoryOut.from_model(category).model_dump(by_alias=True), message="Category created.")


@router.put("/categories/{category_id}", summary="Update a category")
def update_category(
    category_id: str,
    payload: CategoryWrite,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("products")),
):
    category = service.save_category(db, payload, category_id)
    return ok(CategoryOut.from_model(category).model_dump(by_alias=True), message="Category updated.")


@router.delete("/categories/{category_id}", summary="Delete a category")
def delete_category(
    category_id: str,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("products")),
):
    service.delete_category(db, category_id)
    return ok(message="Category deleted.")


# ----------------------------------------------------------- collections


@router.post("/collections", status_code=201, summary="Create a collection")
def create_collection(
    payload: CollectionWrite,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("products")),
):
    collection = service.save_collection(db, payload)
    return ok(CollectionOut.from_model(collection).model_dump(by_alias=True), message="Collection created.")


@router.put("/collections/{collection_id}", summary="Update a collection")
def update_collection(
    collection_id: str,
    payload: CollectionWrite,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("products")),
):
    collection = service.save_collection(db, payload, collection_id)
    return ok(CollectionOut.from_model(collection).model_dump(by_alias=True), message="Collection updated.")


@router.delete("/collections/{collection_id}", summary="Delete a collection")
def delete_collection(
    collection_id: str,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("products")),
):
    service.delete_collection(db, collection_id)
    return ok(message="Collection deleted.")


# ------------------------------------------------------------- inventory


class StockUpdate(CamelModel):
    quantity: int = Field(ge=0)
    reason: str = "correction"
    note: str = ""


def _inventory_row(product: Product) -> dict:
    """
    An inventory row, derived from the product.

    There is no separate inventory table: a second copy of the quantity is two
    numbers that can disagree. The *ledger* of changes earns its own table; the
    level lives on the product.
    """
    available = max(0, product.stock - product.reserved_stock)
    status = (
        "out-of-stock"
        if available <= 0
        else "low-stock"
        if available <= product.low_stock_threshold
        else "in-stock"
    )

    return {
        "productId": product.id,
        "name": product.name,
        "sku": product.sku,
        "category": product.category.slug if product.category else "",
        "image": product.images[0].url if product.images else "",
        "stock": product.stock,
        "reserved": product.reserved_stock,
        "available": available,
        "lowStockThreshold": product.low_stock_threshold,
        "status": status,
    }


@inventory_router.get("", summary="Stock across the catalogue")
def list_inventory(
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    products = (
        db.execute(
            select(Product)
            .options(selectinload(Product.images), selectinload(Product.category))
            .order_by(Product.name)
        )
        .unique()
        .scalars()
        .all()
    )
    return ok_list([_inventory_row(product) for product in products])


@inventory_router.put("/{product_id}", summary="Set a product's stock")
def update_stock(
    product_id: str,
    payload: StockUpdate,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("products")),
):
    """
    Setting stock also sets availability.

    A product that runs out becomes out-of-stock and a restocked one becomes
    active again — leaving an administrator to remember both is how a restocked
    product stays invisible.
    """
    product = product_service.adjust_stock(
        db,
        product_id,
        quantity=payload.quantity,
        reason=payload.reason,
        note=payload.note,
        actor=admin.id,
    )
    return ok(_inventory_row(product), message=f"{product.name} stock set to {payload.quantity}.")


@inventory_router.get("/log", summary="Every stock movement")
def stock_log(
    limit: int = 200,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    rows = db.execute(
        select(StockAdjustment).order_by(StockAdjustment.created_at.desc()).limit(limit)
    ).scalars().all()

    return ok_list(
        [
            {
                "id": row.id,
                "productId": row.product_id,
                "reason": row.reason,
                "quantityBefore": row.quantity_before,
                "quantityAfter": row.quantity_after,
                "delta": row.delta,
                "note": row.note,
                "by": row.actor,
                "at": row.created_at,
            }
            for row in rows
        ]
    )
