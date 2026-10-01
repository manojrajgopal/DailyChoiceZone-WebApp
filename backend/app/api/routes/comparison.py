"""
The product comparison list, for signed-in customers. Guests keep theirs in
the browser and send it to `/merge` when they sign in.

    GET    /api/compare                 the products, in full
    GET    /api/compare/ids             just their ids
    POST   /api/compare/{productId}     add (`?replace=` to swap one out when full)
    DELETE /api/compare/{productId}     remove
    DELETE /api/compare                 clear
    POST   /api/compare/merge           bring a guest list in
"""

from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, Query
from pydantic import Field
from sqlalchemy.orm import Session

from app.core import rate_limit
from app.core.database import get_db
from app.dependencies.auth import get_current_customer
from app.models import Customer
from app.schemas.base import CamelModel
from app.schemas.catalogue import ProductOut
from app.services import comparison as service
from app.utils.response import ok

router = APIRouter(prefix="/compare", tags=["Comparison"])


def _out(ids: List[str]) -> dict:
    return {"productIds": ids, "limit": service.LIMIT}


@router.get("", summary="Products you're comparing")
def products(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    items = service.products(db, customer)
    return ok({"items": [ProductOut.from_model(p).model_dump(by_alias=True) for p in items], "limit": service.LIMIT})


@router.get("/ids", summary="Ids of the products you're comparing")
def ids(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    return ok(_out(service.ids(db, customer)))


class MergeRequest(CamelModel):
    product_ids: List[str] = Field(default_factory=list, max_length=8)


@router.post("/merge", summary="Bring in the list from before signing in")
def merge(payload: MergeRequest, db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    return ok(_out(service.merge(db, customer, payload.product_ids)))


@router.post("/{product_id}", summary="Add a product")
def add(product_id: str, replace: str = Query("", max_length=20), db: Session = Depends(get_db),
        customer: Customer = Depends(get_current_customer)):
    rate_limit.check(f"compare:{customer.id}", limit=120, window_seconds=600)
    return ok(_out(service.add(db, customer, product_id[:160], replace=replace)), message="Added to comparison.")


@router.delete("/{product_id}", summary="Remove a product")
def remove(product_id: str, db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    return ok(_out(service.remove(db, customer, product_id[:20])), message="Removed from comparison.")


@router.delete("", summary="Clear the comparison")
def clear(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    return ok(_out(service.clear(db, customer)), message="Comparison cleared.")
