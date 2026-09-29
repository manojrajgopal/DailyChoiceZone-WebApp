"""The cart."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.dependencies.auth import get_current_customer
from app.models import CartItem, Customer
from app.schemas.base import CamelModel
from app.schemas.catalogue import ProductOut
from app.services import cart as service
from app.services.cart import MAX_QUANTITY_PER_LINE
from app.utils.response import ok

router = APIRouter(prefix="/cart", tags=["Cart"])


class AddToCart(CamelModel):
    """
    Bounded at the edge as well as in the service.

    The service clamps a quantity it cannot honour, which is correct but
    forgiving: a quantity of `-5` would quietly become `1`. Rejecting it here
    means a malformed request is answered as one, and the lengths stop a
    client posting a megabyte of "size".
    """

    product_id: str = Field(min_length=1, max_length=40)
    size: Optional[str] = Field(default=None, max_length=30)
    color: Optional[str] = Field(default=None, max_length=60)
    quantity: int = Field(default=1, ge=1, le=MAX_QUANTITY_PER_LINE)


class UpdateQuantity(CamelModel):
    # Zero is allowed: it is how the stepper removes a line.
    quantity: int = Field(ge=0, le=MAX_QUANTITY_PER_LINE)


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


@router.get("/count", summary="How many items are in the bag")
def get_cart_count(
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    """
    Just the number on the header badge.

    The badge used to read the whole bag for this: every product in it
    serialised in full, and the delivery, coupon and tax arithmetic run, to
    render one integer. Pages that display the bag still take the count from
    the cart they already loaded; this is for the rest of them.
    """
    total = db.execute(
        select(func.coalesce(func.sum(CartItem.quantity), 0)).where(
            CartItem.customer_id == customer.id
        )
    ).scalar_one()

    return ok({"itemCount": int(total)})


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
