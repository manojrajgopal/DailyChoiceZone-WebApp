"""The cart."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.dependencies.auth import get_current_customer
from app.models import Customer
from app.schemas.base import CamelModel
from app.schemas.catalogue import ProductOut
from app.services import cart as service
from app.utils.response import ok

router = APIRouter(prefix="/cart", tags=["Cart"])


class AddToCart(CamelModel):
    product_id: str
    size: Optional[str] = None
    color: Optional[str] = None
    quantity: int = 1


class UpdateQuantity(CamelModel):
    quantity: int


def _render(payload: dict) -> dict:
    """Serialise the products inside the cart with the shared product shape."""
    return {
        **payload,
        "items": [
            {**item, "product": ProductOut.from_model(item["product"]).model_dump(by_alias=True)}
            for item in payload["items"]
        ],
    }


@router.get("", summary="Your bag, priced")
def get_cart(
    coupon: Optional[str] = None,
    delivery_method: str = Query("standard", alias="deliveryMethod"),
    place_of_supply: Optional[str] = Query(None, alias="placeOfSupply"),
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    """
    The lines **and** the breakdown.

    Priced by the server so the figures a shopper sees are the figures the
    order will be created with. `placeOfSupply` is the billing address's state
    once checkout knows it, which is what decides CGST+SGST versus IGST.
    """
    payload = service.get_cart(
        db, customer, coupon_code=coupon, delivery_method=delivery_method,
        place_of_supply=place_of_supply,
    )
    return ok(_render(payload))


@router.post("/items", status_code=201, summary="Add to the bag")
def add_item(
    payload: AddToCart,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    service.add_item(
        db,
        customer,
        product_id=payload.product_id,
        size=payload.size,
        color=payload.color,
        quantity=payload.quantity,
    )
    return ok(_render(service.get_cart(db, customer)), message="Added to bag.")


@router.put("/items/{item_id}", summary="Change a line's quantity")
def update_item(
    item_id: int,
    payload: UpdateQuantity,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    """Zero removes the line, which is what the stepper does at one."""
    service.update_quantity(db, customer, item_id, payload.quantity)
    return ok(_render(service.get_cart(db, customer)))


@router.delete("/items/{item_id}", summary="Remove a line")
def remove_item(
    item_id: int,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    service.remove_item(db, customer, item_id)
    return ok(_render(service.get_cart(db, customer)), message="Item removed.")


@router.delete("", summary="Empty the bag")
def clear_cart(
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    service.clear(db, customer)
    return ok(_render(service.get_cart(db, customer)), message="Bag emptied.")
