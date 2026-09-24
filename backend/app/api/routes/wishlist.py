"""The wishlist."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.dependencies.auth import get_current_customer
from app.models import Customer
from app.schemas.catalogue import ProductOut
from app.services import cart as service
from app.utils.response import ok, ok_list

router = APIRouter(prefix="/wishlist", tags=["Wishlist"])


@router.get("", summary="Your saved products")
def get_wishlist(
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    products = service.list_wishlist(db, customer)
    return ok_list([ProductOut.from_model(p).model_dump(by_alias=True) for p in products])


@router.get("/ids", summary="Just the ids")
def get_wishlist_ids(
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    """
    For the heart on a product card.

    A card needs to know whether a product is saved, not what the saved
    products are — sending the whole list to render one icon is the kind of
    thing that makes a grid feel slow.
    """
    return ok(service.wishlist_ids(db, customer))


@router.post("/{product_id}", status_code=201, summary="Save a product")
def add(
    product_id: str,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    service.add_to_wishlist(db, customer, product_id)
    return ok(service.wishlist_ids(db, customer), message="Saved to wishlist.")


@router.delete("/{product_id}", summary="Remove a saved product")
def remove(
    product_id: str,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    service.remove_from_wishlist(db, customer, product_id)
    return ok(service.wishlist_ids(db, customer), message="Removed from wishlist.")
