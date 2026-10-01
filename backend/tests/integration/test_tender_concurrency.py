"""
Spending the same balance twice at the same moment.

Two checkouts race, each in its own database session and transaction — the
way two browser tabs or two people sharing a gift card code would. Exactly one
may spend the balance; the other must be refused, and the ledgers must show a
single spend. These commit for real, so they clean up after themselves.
"""

from __future__ import annotations

import threading
from datetime import datetime

import pytest
from sqlalchemy import delete, select
from sqlalchemy.orm import sessionmaker

pytestmark = pytest.mark.integration

ADDRESS = {"fullName": "Race Shopper", "phone": "9876500009", "line1": "1 Race Road", "line2": "", "city": "Bengaluru",
           "state": "Karnataka", "pincode": "560001", "country": "India", "email": "race@example.com"}


@pytest.fixture()
def race(engine):
    """Committed shoppers with a bag each, and a way to clean everything up."""
    from app.core.security import hash_password
    from app.models import CartItem, Category, Customer, Product, SettingDocument

    Session = sessionmaker(bind=engine, expire_on_commit=False)
    setup = Session()
    setup.add(Category(id="CATTND", slug="tender-race", name="Race", display_order=99))
    setup.add(Product(id="PRDTND", slug="tender-race-item", sku="DCZ-TND01", name="Race Item", brand="Test",
                      category_id="CATTND", subcategory="race", price=1000.0, original_price=1000.0, discount=0,
                      stock=20, status="active"))
    created_billing = setup.get(SettingDocument, "billing") is None
    if created_billing:
        setup.add(SettingDocument(key="billing", value={
            "currency": {"code": "INR"}, "invoice": {"startNumber": 1, "dueDays": 7},
            "payment": {"enabledMethods": ["cod", "upi"]},
        }))
    shoppers = []
    for index in range(2):
        shopper = Customer(id=f"CUSTND{index}", email=f"tnd{index}@example.com", password_hash=hash_password("Race@12345"),
                           first_name="Race", last_name=str(index), phone="9876500009", status="active",
                           joined_at=datetime(2026, 1, 1))
        setup.add(shopper)
        shoppers.append(shopper.id)
    setup.flush()
    for shopper in shoppers:
        setup.add(CartItem(customer_id=shopper, product_id="PRDTND", quantity=1))
    setup.commit()
    setup.close()

    yield Session, shoppers

    _cleanup(Session, shoppers, created_billing)


def _cleanup(Session, shoppers, created_billing):
    from app.models import (
        CartItem, CartRecovery, Category, Customer, GiftCard, GiftCardTransaction, Invoice, InvoiceItem,
        LoyaltyAccount, LoyaltyLot, LoyaltyRedemption, LoyaltyTransaction, Order, OrderEvent, OrderItem, OrderTender,
        Payment, PaymentEvent, Product, SettingDocument, StockAdjustment, StoreCreditAccount, StoreCreditTransaction,
    )

    db = Session()
    orders = list(db.execute(select(Order.id).where(Order.customer_id.in_(shoppers))).scalars())
    cards = list(db.execute(select(GiftCard.id).where(GiftCard.recipient_email == "race-card@example.com")).scalars())
    if orders:
        payments = list(db.execute(select(Payment.id).where(Payment.order_id.in_(orders))).scalars())
        invoices = list(db.execute(select(Invoice.id).where(Invoice.order_id.in_(orders))).scalars())
        db.execute(delete(LoyaltyRedemption).where(LoyaltyRedemption.order_id.in_(orders)))
        db.execute(delete(OrderTender).where(OrderTender.order_id.in_(orders)))
        db.execute(delete(GiftCardTransaction).where(GiftCardTransaction.order_id.in_(orders)))
        db.execute(delete(StoreCreditTransaction).where(StoreCreditTransaction.order_id.in_(orders)))
        if payments:
            db.execute(delete(PaymentEvent).where(PaymentEvent.payment_id.in_(payments)))
        db.execute(Invoice.__table__.update().where(Invoice.id.in_(invoices)).values(payment_id=None))
        db.execute(delete(Payment).where(Payment.order_id.in_(orders)))
        db.execute(delete(InvoiceItem).where(InvoiceItem.invoice_id.in_(invoices)))
        db.execute(delete(Invoice).where(Invoice.id.in_(invoices)))
        db.execute(delete(OrderEvent).where(OrderEvent.order_id.in_(orders)))
        db.execute(delete(OrderItem).where(OrderItem.order_id.in_(orders)))
    db.execute(delete(LoyaltyLot).where(LoyaltyLot.customer_id.in_(shoppers)))
    db.execute(delete(LoyaltyTransaction).where(LoyaltyTransaction.customer_id.in_(shoppers)))
    db.execute(delete(LoyaltyAccount).where(LoyaltyAccount.customer_id.in_(shoppers)))
    db.execute(delete(StoreCreditTransaction).where(StoreCreditTransaction.customer_id.in_(shoppers)))
    db.execute(delete(StoreCreditAccount).where(StoreCreditAccount.customer_id.in_(shoppers)))
    if cards:
        db.execute(delete(GiftCardTransaction).where(GiftCardTransaction.gift_card_id.in_(cards)))
        db.execute(delete(GiftCard).where(GiftCard.id.in_(cards)))
    if orders:
        db.execute(delete(Order).where(Order.id.in_(orders)))
    db.execute(delete(StockAdjustment).where(StockAdjustment.product_id == "PRDTND"))
    db.execute(delete(CartRecovery).where(CartRecovery.customer_id.in_(shoppers)))
    db.execute(delete(CartItem).where(CartItem.customer_id.in_(shoppers)))
    db.execute(delete(Customer).where(Customer.id.in_(shoppers)))
    db.execute(delete(Product).where(Product.id == "PRDTND"))
    db.execute(delete(Category).where(Category.id == "CATTND"))
    if created_billing:
        db.execute(delete(SettingDocument).where(SettingDocument.key == "billing"))
    db.commit()
    db.close()


def _race(Session, customers, **tender):
    """Both place an order at the same instant; returns each one's outcome."""
    from app.models import Customer
    from app.services import orders as order_service

    start = threading.Barrier(len(customers))
    outcomes = {}

    def buy(index, customer_id):
        session = Session()
        try:
            customer = session.get(Customer, customer_id)
            start.wait()
            order_service.place_order(session, customer, shipping_address=ADDRESS, billing_address=None,
                                      delivery_method="standard", payment_method="cod", **tender)
            outcomes[index] = "bought"
        except Exception as error:  # noqa: BLE001
            session.rollback()
            outcomes[index] = getattr(error, "error_code", type(error).__name__)
        finally:
            session.close()

    threads = [threading.Thread(target=buy, args=(i, c)) for i, c in enumerate(customers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)
    return sorted(outcomes.values())


def test_one_gift_card_cannot_pay_twice(race):
    from app.models import GiftCard, GiftCardTransaction
    from app.services import gift_cards

    Session, shoppers = race
    setup = Session()
    now = datetime.utcnow()
    code = "DCZG-RACE-RACE-RACE-RACE"
    card = GiftCard(code_hash=gift_cards.hash_code(code), code_last4="RACE", status="active", initial_amount=100000,
                    balance=100000, currency="INR", source="admin", recipient_name="Race",
                    recipient_email="race-card@example.com", message="", status_reason="", activated_at=now,
                    created_at=now, updated_at=now)
    setup.add(card)
    setup.commit()
    card_id = card.id
    setup.close()

    # Two different shoppers, one card that covers one order exactly.
    outcomes = _race(Session, shoppers, gift_card_codes=[code])
    assert outcomes == ["GIFT_CARD_UNUSABLE", "bought"], outcomes

    check = Session()
    card = check.get(GiftCard, card_id)
    redeems = check.execute(select(GiftCardTransaction).where(
        GiftCardTransaction.gift_card_id == card_id, GiftCardTransaction.kind == "redeem")).scalars().all()
    assert card.balance == 0 and len(redeems) == 1
    check.close()


def test_store_credit_cannot_be_spent_twice(race):
    from app.models import StoreCreditTransaction
    from app.services import store_credit

    Session, shoppers = race
    setup = Session()
    store_credit.post(setup, shoppers[0], kind="grant", amount=100000, reason="Race credit")
    setup.commit()
    setup.close()

    # The same account in two checkouts at once (two tabs).
    outcomes = _race(Session, [shoppers[0], shoppers[0]], use_store_credit=True)
    assert outcomes.count("bought") == 1, outcomes

    check = Session()
    assert store_credit.balance(check, shoppers[0]) == 0
    spends = check.execute(select(StoreCreditTransaction).where(
        StoreCreditTransaction.customer_id == shoppers[0], StoreCreditTransaction.kind == "redeem")).scalars().all()
    assert len(spends) == 1
    check.close()


def test_points_cannot_be_spent_twice(race):
    from app.models import AdminUser, LoyaltyTransaction
    from app.services import loyalty

    Session, shoppers = race
    setup = Session()
    admin = AdminUser(id="ADMTND", email="tnd-admin@example.com", password_hash="x", name="Race Admin",
                      role="super-admin", permissions=[], status="active", created_at=datetime(2026, 1, 1))
    setup.add(admin)
    setup.commit()
    try:
        loyalty.admin_adjust(setup, admin, shoppers[0], kind="manual_credit", points=1000, reason="Race points")
        setup.close()

        outcomes = _race(Session, [shoppers[0], shoppers[0]], points=1000)
        assert outcomes.count("bought") == 1, outcomes

        check = Session()
        assert loyalty.spendable(check, shoppers[0]) == 0
        redeemed = check.execute(select(LoyaltyTransaction).where(
            LoyaltyTransaction.customer_id == shoppers[0], LoyaltyTransaction.kind == "redeemed")).scalars().all()
        assert len(redeemed) == 1
        check.close()
    finally:
        cleanup = Session()
        cleanup.execute(delete(AdminUser).where(AdminUser.id == "ADMTND"))
        cleanup.commit()
        cleanup.close()
