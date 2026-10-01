"""
The product comparison list.

Signed-in customers keep theirs here, so it follows them between devices;
guests keep theirs in the browser and it is merged in when they sign in. Four
products at most — beyond that a side-by-side stops being readable on any
screen. Only listed products (active or out of stock) can be compared, and a
product that is later unlisted simply drops out of the list.
"""

from __future__ import annotations

from datetime import datetime
from typing import Iterable, List

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import ComparisonItem, Customer, Product

LIMIT = 4
LISTED = ("active", "out-of-stock")


def _listed(db: Session, product_id: str) -> Product:
    from app.repositories import products as repo

    product = repo.get_by_identifier(db, product_id, published_only=True)
    if product is None:
        raise NotFoundError("That product is not available.", error_code="PRODUCT_NOT_FOUND")
    return product


def products(db: Session, customer: Customer) -> List[Product]:
    rows = db.execute(
        select(ComparisonItem, Product)
        .join(Product, Product.id == ComparisonItem.product_id)
        .where(ComparisonItem.customer_id == customer.id, Product.status.in_(LISTED))
        .order_by(ComparisonItem.created_at, ComparisonItem.id)
    ).all()
    return [product for _, product in rows]


def ids(db: Session, customer: Customer) -> List[str]:
    return [p.id for p in products(db, customer)]


def add(db: Session, customer: Customer, product_id: str, *, replace: str = "") -> List[str]:
    """
    Add one. At the limit, `replace` names the product to swap out; without it
    the request is refused with the list, so the page can offer the choice.
    """
    product = _listed(db, product_id)
    # Serialise this customer's changes, so two tabs can't both add a fourth.
    db.execute(select(Customer.id).where(Customer.id == customer.id).with_for_update())
    current = ids(db, customer)
    if product.id in current:
        return current
    if replace:
        if replace not in current:
            raise ValidationError("The product to replace isn't in your comparison.", error_code="NOT_IN_COMPARISON")
        db.execute(delete(ComparisonItem).where(ComparisonItem.customer_id == customer.id,
                                                ComparisonItem.product_id == replace))
        current = [i for i in current if i != replace]
    if len(current) >= LIMIT:
        db.rollback()
        raise ConflictError(f"You can compare up to {LIMIT} products. Remove one to add another.",
                            error_code="COMPARISON_FULL", details={"limit": LIMIT, "productIds": current})
    # Rows for products no longer listed don't count, and are cleared out.
    db.execute(delete(ComparisonItem).where(
        ComparisonItem.customer_id == customer.id,
        ComparisonItem.product_id.in_(select(Product.id).where(Product.status.notin_(LISTED))),
    ))
    db.add(ComparisonItem(customer_id=customer.id, product_id=product.id, created_at=datetime.utcnow()))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
    return ids(db, customer)


def remove(db: Session, customer: Customer, product_id: str) -> List[str]:
    db.execute(delete(ComparisonItem).where(ComparisonItem.customer_id == customer.id,
                                            ComparisonItem.product_id == product_id))
    db.commit()
    return ids(db, customer)


def clear(db: Session, customer: Customer) -> List[str]:
    db.execute(delete(ComparisonItem).where(ComparisonItem.customer_id == customer.id))
    db.commit()
    return []


def merge(db: Session, customer: Customer, product_ids: Iterable[str]) -> List[str]:
    """A guest's list, brought in at sign-in: added in order until the limit; unknown ids skipped."""
    wanted = [str(i)[:20] for i in product_ids][:LIMIT * 2]
    for product_id in wanted:
        current = ids(db, customer)
        if len(current) >= LIMIT:
            break
        try:
            add(db, customer, product_id)
        except (NotFoundError, ConflictError):
            db.rollback()
            continue
    return ids(db, customer)
