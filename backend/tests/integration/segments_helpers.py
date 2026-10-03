"""Shared helpers for the segmentation tests (no tests of its own). Rows are inserted directly: fast and exact."""

from __future__ import annotations

import itertools
from datetime import datetime, timedelta

from app.core.security import hash_password
from app.models import Customer, Order, OrderItem

_numbers = itertools.count(1)
_HASH = None


def now() -> datetime:
    return datetime.utcnow().replace(microsecond=0)


def person(db, cid: str, *, joined_days_ago: int = 400, city: str = "", **fields) -> Customer:
    global _HASH
    if _HASH is None:
        _HASH = hash_password("Customer@123")
    row = Customer(id=cid, email=f"{cid.lower()}@example.com", password_hash=_HASH, first_name=fields.pop("first", cid),
                   last_name=fields.pop("last", "Tester"), phone=fields.pop("phone", "98765" + "".join(c for c in cid if c.isdigit()).rjust(5, "0")[-5:]),
                   status=fields.pop("status", "active"), joined_at=now() - timedelta(days=joined_days_ago), **fields)
    db.add(row)
    if city:
        from app.models import Address

        db.add(Address(id=f"ADR{cid[3:]}", customer_id=cid, full_name=cid, line1="1 Road", city=city,
                       state="Karnataka", pincode="560001", is_default=True))
    db.flush()
    return row


def order(db, cid: str, total: float, *, days_ago: int = 5, status: str = "delivered", product: str = "PRD001",
          coupon: str | None = None) -> Order:
    n = next(_numbers)
    row = Order(id=f"ORS{n:05d}", order_number=f"SEG{n:06d}", customer_id=cid, customer_name=cid,
                customer_email=f"{cid.lower()}@example.com", placed_at=now() - timedelta(days=days_ago),
                status=status, payment_status="paid", total=total, subtotal=total, coupon_code=coupon,
                shipping_city="Mysuru", shipping_state="Karnataka", shipping_pincode="570001")
    row.items.append(OrderItem(product_id=product, name="Item", quantity=1, unit_price=total, line_total=total))
    db.add(row)
    db.flush()
    return row


def segment_payload(name="Big spenders", rules=None, match="all", **extra) -> dict:
    return {"name": name, "description": "", "match": match,
            "rules": rules if rules is not None else [{"field": "totalSpend", "operator": "gte", "value": 1000}],
            **extra}


def refund(db, row: Order, paise: int, *, status: str = "completed"):
    """A completed refund against an order (with the invoice and payment it needs). Read-only for segments."""
    from app.models import Invoice, Payment, Refund

    n = next(_numbers)
    invoice = Invoice(id=f"INS{n:05d}", invoice_number=f"SEG-INV-{n:06d}", order_id=row.id,
                      order_number=row.order_number, customer_id=row.customer_id, customer_name=row.customer_name,
                      customer_email=row.customer_email, issued_at=row.placed_at, due_at=row.placed_at)
    payment = Payment(id=f"PYS{n:05d}", transaction_id=f"seg-txn-{n}", order_id=row.id, invoice_id=invoice.id,
                      customer_id=row.customer_id, amount=paise, status="paid", created_at_utc=row.placed_at)
    db.add_all([invoice, payment])
    db.flush()
    db.add(Refund(id=f"RFS{n:05d}", refund_number=f"SEG-RF-{n:06d}", order_id=row.id, invoice_id=invoice.id,
                  payment_id=payment.id, customer_id=row.customer_id, amount=paise, status=status,
                  requested_at=row.placed_at))
    db.flush()
