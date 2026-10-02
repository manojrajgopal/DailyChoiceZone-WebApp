"""
Suppliers, what they supply, purchase orders and goods receiving (admin only).
See docs/shipping-and-suppliers.md, section 6.

    /api/admin/suppliers...                    the directory (permission: suppliers)
    /api/admin/supplier-products/{id}          one supplier-product link (suppliers)
    /api/admin/products/{product_id}/suppliers a product's suppliers (suppliers)
    /api/admin/purchase-orders...              purchase orders and receipts (permission: purchasing)

Nothing here is reachable by a customer: every route needs an administrator
holding the permission, checked on the server.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Body, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.dependencies.auth import require_access
from app.models import AdminUser
from app.services import purchasing
from app.services import suppliers as service
from app.utils.response import Pagination, ok

suppliers_router = APIRouter(prefix="/admin/suppliers", tags=["Admin · Suppliers"])
supplier_products_router = APIRouter(prefix="/admin/supplier-products", tags=["Admin · Suppliers"])
product_suppliers_router = APIRouter(prefix="/admin/products", tags=["Admin · Suppliers"])
purchase_orders_router = APIRouter(prefix="/admin/purchase-orders", tags=["Admin · Purchase orders"])

suppliers_access = require_access("suppliers")
purchasing_access = require_access("purchasing")


def _page(page: int, size: int, total: int) -> dict:
    return Pagination.build(page, size, total).model_dump()


# ---------------------------------------------------------------- suppliers


@suppliers_router.get("", summary="Suppliers")
def list_suppliers(
    q: str = Query("", max_length=120),
    status: str = Query("", max_length=20),
    sort: str = Query("name", max_length=20),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(suppliers_access),
):
    items, total, counts = service.list_suppliers(db, q=q, status=status, sort=sort, page=page,
                                                  page_size=page_size)
    return ok({"items": items, "pagination": _page(page, page_size, total), "counts": counts})


@suppliers_router.post("", status_code=201, summary="Add a supplier")
def create_supplier(payload: dict = Body(...), db: Session = Depends(get_db),
                    admin: AdminUser = Depends(suppliers_access)):
    supplier = service.create_supplier(db, admin, payload)
    return ok(service.supplier_view(supplier), message="Supplier added.")


@suppliers_router.get("/{supplier_id}", summary="A supplier, with figures and history")
def get_supplier(supplier_id: str, db: Session = Depends(get_db), admin: AdminUser = Depends(suppliers_access)):
    return ok(service.detail(db, supplier_id))


@suppliers_router.put("/{supplier_id}", summary="Update a supplier")
def update_supplier(supplier_id: str, payload: dict = Body(...), db: Session = Depends(get_db),
                    admin: AdminUser = Depends(suppliers_access)):
    supplier = service.update_supplier(db, admin, supplier_id, payload)
    return ok(service.supplier_view(supplier), message="Supplier saved.")


@suppliers_router.post("/{supplier_id}/status", summary="Activate, deactivate or archive a supplier")
def set_supplier_status(supplier_id: str, payload: dict = Body(...), db: Session = Depends(get_db),
                        admin: AdminUser = Depends(suppliers_access)):
    supplier = service.set_status(db, admin, supplier_id, payload)
    return ok(service.supplier_view(supplier), message="Supplier status changed.")


@suppliers_router.get("/{supplier_id}/products", summary="What a supplier provides")
def list_supplier_products(supplier_id: str, db: Session = Depends(get_db),
                           admin: AdminUser = Depends(suppliers_access)):
    return ok(service.supplier_products(db, supplier_id))


@suppliers_router.post("/{supplier_id}/products", status_code=201, summary="Link a product to a supplier")
def create_supplier_product(supplier_id: str, payload: dict = Body(...), db: Session = Depends(get_db),
                            admin: AdminUser = Depends(suppliers_access)):
    return ok(service.create_link(db, admin, supplier_id, payload), message="Product linked.")


@supplier_products_router.put("/{link_id}", summary="Update a supplier product")
def update_supplier_product(link_id: int, payload: dict = Body(...), db: Session = Depends(get_db),
                            admin: AdminUser = Depends(suppliers_access)):
    return ok(service.update_link(db, admin, link_id, payload), message="Supplier product saved.")


@supplier_products_router.delete("/{link_id}", summary="Remove a supplier product")
def delete_supplier_product(link_id: int, db: Session = Depends(get_db),
                            admin: AdminUser = Depends(suppliers_access)):
    service.delete_link(db, admin, link_id)
    return ok(None, message="Supplier product removed.")


@product_suppliers_router.get("/{product_id}/suppliers", summary="A product's suppliers")
def list_product_suppliers(product_id: str, db: Session = Depends(get_db),
                           admin: AdminUser = Depends(suppliers_access)):
    return ok(service.product_suppliers(db, product_id))


# ----------------------------------------------------------- purchase orders


@purchase_orders_router.get("", summary="Purchase orders")
def list_purchase_orders(
    q: str = Query("", max_length=120),
    status: str = Query("", max_length=20),
    supplier: str = Query("", max_length=20),
    date_from: str = Query("", alias="from", max_length=20),
    date_to: str = Query("", alias="to", max_length=20),
    sort: str = Query("createdAt", max_length=20),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(purchasing_access),
):
    items, total, counts = purchasing.list_pos(db, q=q, status=status, supplier=supplier, date_from=date_from,
                                               date_to=date_to, sort=sort, page=page, page_size=page_size)
    return ok({"items": items, "pagination": _page(page, page_size, total), "counts": counts})


@purchase_orders_router.post("", status_code=201, summary="Create a draft purchase order")
def create_purchase_order(payload: dict = Body(...), db: Session = Depends(get_db),
                          admin: AdminUser = Depends(purchasing_access)):
    po = purchasing.create(db, admin, payload)
    return ok(purchasing.po_view(db, po), message="Purchase order created.")


@purchase_orders_router.get("/{po_id}", summary="A purchase order")
def get_purchase_order(po_id: str, db: Session = Depends(get_db), admin: AdminUser = Depends(purchasing_access)):
    return ok(purchasing.get(db, po_id))


@purchase_orders_router.put("/{po_id}", summary="Edit a draft purchase order")
def update_purchase_order(po_id: str, payload: dict = Body(...), db: Session = Depends(get_db),
                          admin: AdminUser = Depends(purchasing_access)):
    po = purchasing.update(db, admin, po_id, payload)
    return ok(purchasing.po_view(db, po), message="Purchase order saved.")


def _transition(action: str, message: str):
    def endpoint(po_id: str, payload: Optional[dict] = Body(None), db: Session = Depends(get_db),
                 admin: AdminUser = Depends(purchasing_access)):
        po = purchasing.transition(db, admin, po_id, action, payload or {})
        return ok(purchasing.po_view(db, po), message=message)

    endpoint.__name__ = f"{action}_purchase_order"
    return endpoint


purchase_orders_router.post("/{po_id}/submit", summary="Submit a draft purchase order")(
    _transition("submit", "Purchase order submitted."))
purchase_orders_router.post("/{po_id}/send", summary="Mark a purchase order as sent to the supplier")(
    _transition("send", "Purchase order marked as sent."))
purchase_orders_router.post("/{po_id}/acknowledge", summary="Record the supplier's acknowledgement")(
    _transition("acknowledge", "Purchase order acknowledged."))


@purchase_orders_router.post("/{po_id}/cancel", summary="Cancel a purchase order")
def cancel_purchase_order(po_id: str, payload: dict = Body(...), db: Session = Depends(get_db),
                          admin: AdminUser = Depends(purchasing_access)):
    po = purchasing.cancel(db, admin, po_id, payload)
    return ok(purchasing.po_view(db, po), message="Purchase order cancelled.")


@purchase_orders_router.get("/{po_id}/receipts", summary="Goods received against a purchase order")
def list_receipts(po_id: str, db: Session = Depends(get_db), admin: AdminUser = Depends(purchasing_access)):
    return ok(purchasing.receipts(db, po_id))


@purchase_orders_router.post("/{po_id}/receipts", status_code=201, summary="Receive goods against a purchase order")
def receive_goods(po_id: str, payload: dict = Body(...), db: Session = Depends(get_db),
                  admin: AdminUser = Depends(purchasing_access)):
    po = purchasing.receive(db, admin, po_id, payload)
    return ok(purchasing.po_view(db, po), message="Goods received.")
