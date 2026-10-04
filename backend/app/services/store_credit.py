"""
Store credit: a customer's balance with the store, and its ledger.

`StoreCreditAccount.balance` is changed only by `post`, which locks the
account, refuses to go below zero, and writes the ledger entry in the same
transaction. Entries that must happen once — spending on an order, a refund's
share — carry an idempotency key, and the database refuses the second one.
"""

from __future__ import annotations

import html as html_lib
from datetime import datetime
from typing import Optional

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings as app_settings
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import AdminUser, Customer, StoreCreditAccount, StoreCreditTransaction
from app.services import billing
from app.services.lookup.filters import id_condition

CREDIT_KINDS = ("grant", "goodwill", "promotion", "refund", "gift-card-refund", "restore", "adjust", "referral")
DEBIT_KINDS = ("redeem", "revoke", "adjust", "referral-reversed")
ADMIN_KINDS = {"grant": 1, "goodwill": 1, "promotion": 1, "revoke": -1}
LABELS = {
    "grant": "Credit added", "goodwill": "Goodwill credit", "promotion": "Promotional credit",
    "refund": "Refund to store credit", "gift-card-refund": "Gift card refund", "restore": "Returned from an order",
    "redeem": "Spent on an order", "revoke": "Credit removed", "adjust": "Adjustment",
    "referral": "Referral reward", "referral-reversed": "Referral reward taken back",
}
MAX_ADMIN_AMOUNT = billing.to_minor(100000)


class AlreadyPosted(Exception):
    """An entry with this idempotency key already exists."""


def account(db: Session, customer_id: str, *, lock: bool = False) -> StoreCreditAccount:
    """The customer's account, created at zero on first use."""
    query = select(StoreCreditAccount).where(StoreCreditAccount.customer_id == customer_id)
    row = db.execute(query.with_for_update() if lock else query).scalar_one_or_none()
    if row is not None:
        return row
    now = datetime.utcnow()
    try:
        with db.begin_nested():
            db.add(StoreCreditAccount(customer_id=customer_id, balance=0, lifetime_credited=0, lifetime_spent=0,
                                      created_at=now, updated_at=now))
    except IntegrityError:
        pass  # created by a concurrent request; read it below
    return db.execute(query.with_for_update() if lock else query).scalar_one()


def balance(db: Session, customer_id: str) -> int:
    row = db.execute(select(StoreCreditAccount.balance).where(StoreCreditAccount.customer_id == customer_id)).scalar_one_or_none()
    return int(row or 0)


def post(db: Session, customer_id: str, *, kind: str, amount: int, reason: str = "", order_id: Optional[str] = None,
         refund_id: Optional[str] = None, admin: Optional[AdminUser] = None,
         idempotency_key: Optional[str] = None) -> StoreCreditTransaction:
    """
    Move credit. `amount` is signed: positive adds, negative spends. Never
    commits — the caller's transaction carries it. Raises `AlreadyPosted` when
    the idempotency key was used before.
    """
    if amount == 0:
        raise ValidationError("The amount can't be zero.", error_code="INVALID_AMOUNT")
    if idempotency_key:
        seen = db.execute(select(StoreCreditTransaction).where(
            StoreCreditTransaction.idempotency_key == idempotency_key)).scalar_one_or_none()
        if seen is not None:
            raise AlreadyPosted(idempotency_key)
    row = account(db, customer_id, lock=True)
    if row.balance + amount < 0:
        raise ConflictError("There isn't enough store credit for that.", error_code="INSUFFICIENT_STORE_CREDIT",
                            details={"balance": billing.to_major(row.balance)})
    now = datetime.utcnow()
    row.balance += amount
    if amount > 0:
        row.lifetime_credited += amount
    elif kind == "redeem":
        row.lifetime_spent += -amount
    row.updated_at = now
    entry = StoreCreditTransaction(
        customer_id=customer_id, kind=kind, amount=amount, balance_after=row.balance, reason=(reason or "")[:300],
        order_id=order_id, refund_id=refund_id, admin_id=admin.id if admin else None,
        admin_name=(admin.name if admin else "")[:120], idempotency_key=idempotency_key, created_at=now,
    )
    db.add(entry)
    db.flush()
    return entry


def view(entry: StoreCreditTransaction) -> dict:
    return {
        "id": entry.id, "kind": entry.kind, "label": LABELS.get(entry.kind, entry.kind),
        "amount": billing.to_major(entry.amount), "balanceAfter": billing.to_major(entry.balance_after),
        "reason": entry.reason, "orderId": entry.order_id, "createdAt": entry.created_at,
    }


def history(db: Session, customer_id: str, *, page: int = 1, page_size: int = 25) -> tuple:
    total = db.execute(select(func.count()).select_from(StoreCreditTransaction).where(
        StoreCreditTransaction.customer_id == customer_id)).scalar_one()
    rows = db.execute(select(StoreCreditTransaction).where(StoreCreditTransaction.customer_id == customer_id)
                      .order_by(StoreCreditTransaction.id.desc())
                      .offset((max(1, page) - 1) * page_size).limit(page_size)).scalars().all()
    return rows, total


def summary(db: Session, customer_id: str) -> dict:
    row = db.execute(select(StoreCreditAccount).where(StoreCreditAccount.customer_id == customer_id)).scalar_one_or_none()
    return {
        "balance": billing.to_major(row.balance if row else 0),
        "lifetimeCredited": billing.to_major(row.lifetime_credited if row else 0),
        "lifetimeSpent": billing.to_major(row.lifetime_spent if row else 0),
    }


def _email(db: Session, customer: Customer, entry: StoreCreditTransaction) -> None:
    from app.services import email as email_service

    esc = html_lib.escape
    added = entry.amount > 0
    amount = f"₹{billing.to_major(abs(entry.amount)):,.2f}"
    left = f"₹{billing.to_major(entry.balance_after):,.2f}"
    title = "Store credit added" if added else "Store credit updated"
    intro = (f"Hello {esc(customer.first_name or 'there')}, <strong>{amount}</strong> of store credit has been "
             f"{'added to' if added else 'taken from'} your account. Your balance is now <strong>{left}</strong>.")
    from app.services.email import templates

    link = f"{app_settings.STOREFRONT_URL.rstrip('/')}/account/wallet"
    body = templates.stats([("Added" if added else "Deducted", f"{'+' if added else '−'}{amount}"),
                            ("New balance", left, "ready to spend")], tone="success" if added else "info")
    if entry.reason:
        body += templates.note(entry.reason, title="Note from our team")
    if added:
        body += templates.steps(["Add what you love to your bag.",
                                 "At checkout, your store credit is offered as a way to pay."],
                                title="How to use it", tone="success")
    html = email_service.layout(title, intro, body, cta=("See your balance", link),
                                footnote="Store credit is used at checkout and has no cash value.",
                                tone="success" if added else "info", icon="wallet", eyebrow="Store credit",
                                secondary=[("Shop now", email_service.link("/shop"))])
    email_service.notify(db, "store_credit", to=customer.email, customer_id=customer.id,
                         subject=f"{title}: {amount}", html=html,
                         text=f"{title}: {amount}. Balance {left}. {link}", reference=f"store-credit-{entry.id}")


def admin_adjust(db: Session, admin: AdminUser, customer_id: str, *, kind: str, amount: float, reason: str,
                 request_key: str = "") -> StoreCreditTransaction:
    """
    Add or remove credit from the portal. A reason is required and kept on the
    entry with who made it. `request_key` makes a double-clicked submit post once.
    """
    customer = db.get(Customer, customer_id)
    if customer is None:
        raise NotFoundError("No such customer.", error_code="CUSTOMER_NOT_FOUND")
    if kind not in ADMIN_KINDS:
        raise ValidationError("Choose what kind of change this is.", error_code="INVALID_KIND")
    try:
        minor = billing.to_minor(float(amount))
    except (TypeError, ValueError):
        raise ValidationError("Enter an amount in rupees.", error_code="INVALID_AMOUNT") from None
    if minor <= 0 or minor > MAX_ADMIN_AMOUNT:
        raise ValidationError("Enter an amount between ₹0.01 and ₹1,00,000.", error_code="INVALID_AMOUNT")
    reason = (reason or "").strip()
    if len(reason) < 5:
        raise ValidationError("Give a reason (at least 5 characters). The customer may see it.", error_code="REASON_REQUIRED")
    key = f"admin:{admin.id}:{request_key[:40]}" if request_key else None
    try:
        entry = post(db, customer.id, kind=kind, amount=minor * ADMIN_KINDS[kind], reason=reason, admin=admin,
                     idempotency_key=key)
    except AlreadyPosted:
        db.rollback()
        return db.execute(select(StoreCreditTransaction).where(StoreCreditTransaction.idempotency_key == key)).scalar_one()
    _email(db, customer, entry)
    db.commit()
    db.refresh(entry)
    return entry


def credit_customer(db: Session, customer_id: str, *, kind: str, amount: int, reason: str, key: str,
                    order_id: Optional[str] = None, refund_id: Optional[str] = None, notify: bool = True) -> Optional[StoreCreditTransaction]:
    """A system credit (a refund's share, a gift card that couldn't take its money back). Once per key."""
    if amount <= 0:
        return None
    try:
        entry = post(db, customer_id, kind=kind, amount=amount, reason=reason, order_id=order_id,
                     refund_id=refund_id, idempotency_key=key)
    except AlreadyPosted:
        return None
    customer = db.get(Customer, customer_id)
    if notify and customer is not None:
        _email(db, customer, entry)
    return entry


def admin_search(db: Session, *, q: str = "", only_with_balance: bool = False, page: int = 1,
                 page_size: int = 25) -> tuple:
    conditions = []
    text = (q or "").strip()
    # A Customer ID, exactly (docs/id-lookup.md) — found even without an
    # account yet, so credit can be added to anyone. Names and emails match nothing.
    condition = id_condition("customer", text)
    if condition is not None:
        conditions.append(condition)
    if only_with_balance:
        conditions.append(StoreCreditAccount.balance > 0)
    base = select(Customer, StoreCreditAccount).outerjoin(StoreCreditAccount,
                                                          StoreCreditAccount.customer_id == Customer.id)
    if only_with_balance or not text:
        base = select(Customer, StoreCreditAccount).join(StoreCreditAccount,
                                                         StoreCreditAccount.customer_id == Customer.id)
    total = db.execute(select(func.count()).select_from(base.where(*conditions).subquery())).scalar_one()
    rows = db.execute(base.where(*conditions).order_by(Customer.first_name, Customer.id)
                      .offset((max(1, page) - 1) * page_size).limit(page_size)).all()
    outstanding = db.execute(select(func.coalesce(func.sum(StoreCreditAccount.balance), 0))).scalar_one()
    items = [{
        "customer": {"id": c.id, "name": c.full_name, "email": c.email, "status": c.status},
        "balance": billing.to_major(a.balance if a else 0),
        "lifetimeCredited": billing.to_major(a.lifetime_credited if a else 0),
        "lifetimeSpent": billing.to_major(a.lifetime_spent if a else 0),
        "updatedAt": a.updated_at if a else None,
    } for c, a in rows]
    return items, total, billing.to_major(int(outstanding or 0))
