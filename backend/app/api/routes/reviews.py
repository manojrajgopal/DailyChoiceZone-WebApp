"""Reviews."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.dependencies.auth import get_current_customer
from app.models import Customer
from app.schemas.base import CamelModel
from app.services import reviews as service
from app.utils.response import ok, ok_list

router = APIRouter(prefix="/reviews", tags=["Reviews"])


class ReviewCreate(CamelModel):
    product_id: str
    rating: int = Field(ge=1, le=5)
    title: str = Field(min_length=3, max_length=200)
    body: str = Field(min_length=10, max_length=4000)


@router.get("", summary="Reviews for a product")
def list_reviews(
    product_id: str = Query(alias="productId"),
    db: Session = Depends(get_db),
):
    """
    Only approved ones.

    Moderation decides what a product page shows; without this filter the
    queue would be a form that changes nothing.
    """
    reviews = service.list_for_product(db, product_id)
    return ok_list([service.to_public(review) for review in reviews])


@router.get("/summary", summary="Rating breakdown for a product")
def review_summary(
    product_id: str = Query(alias="productId"),
    db: Session = Depends(get_db),
):
    """
    Computed from the reviews actually shown, so the bars and the list can
    never disagree — which they would if this read the product's own rating.
    """
    return ok(service.summary_for_product(db, product_id))


@router.post("", status_code=201, summary="Write a review")
def create_review(
    payload: ReviewCreate,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    """Arrives pending. Nothing a customer writes appears until it is moderated."""
    review = service.create_review(
        db,
        customer,
        product_id=payload.product_id,
        rating=payload.rating,
        title=payload.title,
        body=payload.body,
    )
    return ok(
        service.to_public(review),
        message="Thank you — your review will appear once it has been checked.",
    )
