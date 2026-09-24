"""Reviews: writing, showing and moderating."""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError
from app.models import Customer, Order, OrderItem, Product, Review
from app.utils.ids import next_id

APPROVED = "approved"


def list_for_product(db: Session, product_id: str) -> List[Review]:
    """Approved reviews, newest first."""
    return list(
        db.execute(
            select(Review)
            .where(Review.product_id == product_id, Review.status == APPROVED)
            .order_by(Review.submitted_at.desc())
        ).scalars().all()
    )


def summary_for_product(db: Session, product_id: str) -> dict:
    """
    The aggregate, over the same reviews the page lists.

    Computed rather than read from `Product.rating`: the two would drift the
    moment a review was moderated, and a distribution that disagrees with the
    reviews printed under it is the kind of detail people notice.
    """
    rows = db.execute(
        select(Review.rating, func.count(Review.id))
        .where(Review.product_id == product_id, Review.status == APPROVED)
        .group_by(Review.rating)
    ).all()

    counts = {rating: count for rating, count in rows}
    total = sum(counts.values())
    average = (
        round(sum(rating * count for rating, count in counts.items()) / total, 1) if total else 0.0
    )

    return {
        "average": average,
        "total": total,
        "distribution": [{"stars": stars, "count": counts.get(stars, 0)} for stars in (5, 4, 3, 2, 1)],
    }


def to_public(review: Review) -> dict:
    """The customer-facing projection — no moderation state, no customer id."""
    return {
        "id": review.id,
        "productId": review.product_id,
        "author": review.author,
        "rating": review.rating,
        "title": review.title,
        "body": review.body,
        "date": review.submitted_at.date().isoformat(),
        "verified": review.verified_purchase,
    }


def create_review(
    db: Session,
    customer: Customer,
    *,
    product_id: str,
    rating: int,
    title: str,
    body: str,
) -> Review:
    """
    Write one.

    It arrives `pending` — nothing a customer writes appears on a product page
    until somebody has looked at it.

    `verified_purchase` is **derived from the orders table**, not accepted from
    the client. A badge that says "verified" has to mean something, and the
    only way it can is if the server checks.
    """
    product = db.get(Product, product_id)
    if product is None:
        raise NotFoundError("That product does not exist.", error_code="PRODUCT_NOT_FOUND")

    existing = db.execute(
        select(Review.id).where(
            Review.product_id == product_id, Review.customer_id == customer.id
        )
    ).scalar_one_or_none()

    if existing:
        raise ConflictError(
            "You have already reviewed this product.", error_code="REVIEW_EXISTS"
        )

    purchased = db.execute(
        select(func.count())
        .select_from(OrderItem)
        .join(Order, Order.id == OrderItem.order_id)
        .where(
            OrderItem.product_id == product_id,
            Order.customer_id == customer.id,
            Order.status.in_(("delivered", "shipped")),
        )
    ).scalar_one()

    review = Review(
        id=next_id(db, Review, "review"),
        product_id=product_id,
        customer_id=customer.id,
        author=f"{customer.first_name} {customer.last_name[:1]}.".strip(" ."),
        rating=rating,
        title=title.strip(),
        body=body.strip(),
        verified_purchase=purchased > 0,
        status="pending",
        submitted_at=datetime.utcnow(),
    )

    db.add(review)
    db.commit()
    db.refresh(review)
    return review


# ------------------------------------------------------------- moderation


def list_all(db: Session, *, status: Optional[str] = None) -> List[Review]:
    statement = select(Review).order_by(Review.submitted_at.desc())
    if status and status != "all":
        statement = statement.where(Review.status == status)
    return list(db.execute(statement).scalars().all())


def get_review(db: Session, review_id: str) -> Review:
    review = db.get(Review, review_id)
    if review is None:
        raise NotFoundError("No such review.", error_code="REVIEW_NOT_FOUND")
    return review


def set_status(db: Session, review_id: str, status: str) -> Review:
    """
    Approve or reject.

    The product's cached rating is recomputed here, because approving a review
    changes what the product is worth on a listing page and nothing else runs
    to notice.
    """
    review = get_review(db, review_id)
    review.status = status
    db.flush()

    _recompute_product_rating(db, review.product_id)

    db.commit()
    db.refresh(review)
    return review


def delete_review(db: Session, review_id: str) -> None:
    review = get_review(db, review_id)
    product_id = review.product_id

    db.delete(review)
    db.flush()

    _recompute_product_rating(db, product_id)
    db.commit()


def _recompute_product_rating(db: Session, product_id: str) -> None:
    """Keep the listing badge in step with the approved reviews."""
    row = db.execute(
        select(func.avg(Review.rating), func.count(Review.id)).where(
            Review.product_id == product_id, Review.status == APPROVED
        )
    ).one()

    product = db.get(Product, product_id)
    if product is None:
        return

    average, count = row
    # `review_count` on the product is the marketing figure the catalogue
    # shipped with; only the rating is re-derived, so an approved review moves
    # the stars without rewriting a number that was never a count of these rows.
    if count:
        product.rating = round(float(average), 2)
