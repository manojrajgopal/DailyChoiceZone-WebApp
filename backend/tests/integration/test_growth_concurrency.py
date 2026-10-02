"""
Races: shoppers checking out the last flash-sale unit, or the last bundle, at
the same instant; and a referral's reward being triggered twice at once. Each
side runs in its own committed transaction, the way two requests would. These
commit for real, so they clean up after themselves.
"""

from __future__ import annotations

import threading
from datetime import datetime, timedelta

import pytest
from sqlalchemy import delete, select
from sqlalchemy.orm import sessionmaker

pytestmark = pytest.mark.integration

ADDRESS = {"fullName": "Race Shopper", "phone": "9876500019", "line1": "9 Sprint Road", "line2": "", "city": "Pune",
           "state": "Maharashtra", "pincode": "411001", "country": "India", "email": "sprint@example.com"}
SHOPPERS = [f"CUSRCE{i}" for i in range(4)]


@pytest.fixture()
def arena(engine):
    from app.core.security import hash_password
    from app.models import Category, Customer, Product, SettingDocument

    Session = sessionmaker(bind=engine, expire_on_commit=False)
    setup = Session()
    setup.add(Category(id="CATRCE", slug="race-growth", name="Race", display_order=99))
    for pid, stock in (("PRDRC1", 50), ("PRDRC2", 1)):
        setup.add(Product(id=pid, slug=f"race-{pid.lower()}", sku=f"DCZ-{pid}", name=f"Race {pid}", brand="Test",
                          category_id="CATRCE", subcategory="race", price=1000.0, original_price=1000.0, discount=0,
                          stock=stock, status="active"))
    created_billing = setup.get(SettingDocument, "billing") is None
    if created_billing:
        setup.add(SettingDocument(key="billing", value={
            "currency": {"code": "INR"}, "invoice": {"startNumber": 1, "dueDays": 7},
            "payment": {"enabledMethods": ["cod", "upi"]},
        }))
    for shopper in SHOPPERS:
        setup.add(Customer(id=shopper, email=f"{shopper.lower()}@example.com", password_hash=hash_password("Race@12345"),
                           first_name="Race", last_name=shopper[-1], phone=f"98000000{shopper[-1]}0",
                           status="active", joined_at=datetime(2026, 1, 1)))
    setup.commit()
    setup.close()
    yield Session
    _cleanup(Session, created_billing)


def _cleanup(Session, created_billing):
    from app.models import (
        Bundle, CartBundle, CartItem, CartRecovery, Category, Customer, FlashSale, FlashSaleClaim, Invoice,
        InvoiceItem, Notification, Order, OrderEvent, OrderItem, Payment, PaymentEvent, Product, Referral, ReferralCode,
        SettingDocument, StockAdjustment, StoreCreditAccount, StoreCreditTransaction,
    )

    db = Session()
    orders = list(db.execute(select(Order.id).where(Order.customer_id.in_(SHOPPERS))).scalars())
    db.execute(delete(FlashSaleClaim).where(FlashSaleClaim.customer_id.in_(SHOPPERS)))
    db.execute(delete(Referral).where(Referral.referee_id.in_(SHOPPERS)))
    db.execute(delete(ReferralCode).where(ReferralCode.customer_id.in_(SHOPPERS)))
    if orders:
        payments = list(db.execute(select(Payment.id).where(Payment.order_id.in_(orders))).scalars())
        invoices = list(db.execute(select(Invoice.id).where(Invoice.order_id.in_(orders))).scalars())
        if payments:
            db.execute(delete(PaymentEvent).where(PaymentEvent.payment_id.in_(payments)))
        db.execute(Invoice.__table__.update().where(Invoice.id.in_(invoices)).values(payment_id=None))
        db.execute(delete(Payment).where(Payment.order_id.in_(orders)))
        db.execute(delete(InvoiceItem).where(InvoiceItem.invoice_id.in_(invoices)))
        db.execute(delete(Invoice).where(Invoice.id.in_(invoices)))
        db.execute(delete(OrderEvent).where(OrderEvent.order_id.in_(orders)))
        db.execute(delete(OrderItem).where(OrderItem.order_id.in_(orders)))
        db.execute(delete(Order).where(Order.id.in_(orders)))
    db.execute(delete(StoreCreditTransaction).where(StoreCreditTransaction.customer_id.in_(SHOPPERS)))
    db.execute(delete(StoreCreditAccount).where(StoreCreditAccount.customer_id.in_(SHOPPERS)))
    db.execute(delete(CartBundle).where(CartBundle.customer_id.in_(SHOPPERS)))
    db.execute(delete(CartItem).where(CartItem.customer_id.in_(SHOPPERS)))
    db.execute(delete(CartRecovery).where(CartRecovery.customer_id.in_(SHOPPERS)))
    for name in ("Race sale",):
        for sale in db.execute(select(FlashSale).where(FlashSale.name == name)).scalars():
            db.delete(sale)
        # Selling the last unit tells the team it sold out. Committed with the
        # race, so it has to go too, or every later test sees it in the tray.
        db.execute(delete(Notification).where(Notification.title.like(f"%{name}%")))
    for bundle in db.execute(select(Bundle).where(Bundle.slug == "race-bundle")).scalars():
        db.delete(bundle)
    db.flush()
    db.execute(delete(StockAdjustment).where(StockAdjustment.product_id.in_(("PRDRC1", "PRDRC2"))))
    db.execute(delete(Customer).where(Customer.id.in_(SHOPPERS)))
    db.execute(delete(Product).where(Product.id.in_(("PRDRC1", "PRDRC2"))))
    db.execute(delete(Category).where(Category.id == "CATRCE"))
    if created_billing:
        db.execute(delete(SettingDocument).where(SettingDocument.key == "billing"))
    db.commit()
    db.close()


def _together(Session, work, count):
    """Run `work(session, index)` in `count` threads released at the same instant."""
    start = threading.Barrier(count)
    outcomes = {}

    def run(index):
        session = Session()
        try:
            start.wait()
            work(session, index)
            outcomes[index] = "ok"
        except Exception as error:  # noqa: BLE001
            session.rollback()
            outcomes[index] = getattr(error, "error_code", type(error).__name__)
        finally:
            session.close()

    threads = [threading.Thread(target=run, args=(i,)) for i in range(count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=90)
    return sorted(outcomes.values())


def _checkout(session, customer_id):
    from app.models import Customer
    from app.services import orders as order_service

    order_service.place_order(session, session.get(Customer, customer_id), shipping_address=ADDRESS,
                              billing_address=None, delivery_method="standard", payment_method="cod")


def test_the_last_flash_sale_unit_sells_once(arena):
    from app.models import CartItem, FlashSale, FlashSaleClaim, FlashSaleItem

    Session = arena
    setup = Session()
    now = datetime.utcnow()
    sale = FlashSale(name="Race sale", status="published", starts_at=now - timedelta(minutes=1),
                     ends_at=now + timedelta(hours=1), allow_coupons=False, created_at=now, updated_at=now)
    sale.items = [FlashSaleItem(product_id="PRDRC1", sale_price=500.0, stock_limit=1, per_customer_limit=None)]
    setup.add(sale)
    for shopper in SHOPPERS:
        setup.add(CartItem(customer_id=shopper, product_id="PRDRC1", quantity=1))
    setup.commit()
    setup.close()

    outcomes = _together(Session, lambda s, i: _checkout(s, SHOPPERS[i]), len(SHOPPERS))
    check = Session()
    claims = check.execute(select(FlashSaleClaim).where(FlashSaleClaim.customer_id.in_(SHOPPERS))).scalars().all()
    # Exactly one shopper got the sale price; the others bought at the regular price (the sale ran out).
    assert [c.quantity for c in claims] == [1]
    assert outcomes.count("ok") == len(SHOPPERS)
    check.close()


def test_the_last_bundle_sells_once(arena):
    from app.models import Bundle, BundleItem, CartBundle, Product
    from app.services import pricing

    Session = arena
    setup = Session()
    now = datetime.utcnow()
    bundle = Bundle(slug="race-bundle", name="Race bundle", description="", pricing="fixed", price=1500.0,
                    status="active", max_per_order=5, created_at=now, updated_at=now)
    bundle.items = [BundleItem(product_id="PRDRC1", quantity=1, position=0),
                    BundleItem(product_id="PRDRC2", quantity=1, position=1)]
    setup.add(bundle)
    setup.flush()
    choice = [{"productId": "PRDRC1", "size": "", "color": ""}, {"productId": "PRDRC2", "size": "", "color": ""}]
    for shopper in SHOPPERS[:3]:
        setup.add(CartBundle(customer_id=shopper, bundle_id=bundle.id, quantity=1, selections=choice,
                             selection_key=pricing.selection_key(choice), created_at=now, updated_at=now))
    setup.commit()
    setup.close()

    outcomes = _together(Session, lambda s, i: _checkout(s, SHOPPERS[i]), 3)
    assert outcomes.count("ok") == 1
    assert all(o in ("ok", "INSUFFICIENT_STOCK", "BUNDLE_UNAVAILABLE") for o in outcomes)
    check = Session()
    assert check.get(Product, "PRDRC2").stock == 0
    assert check.get(Product, "PRDRC1").stock == 49
    check.close()


def test_a_referral_reward_is_paid_once_when_triggered_twice(arena):
    from app.models import Order, Referral, StoreCreditTransaction
    from app.services import referrals

    Session = arena
    setup = Session()
    from app.models import CartItem

    setup.add(CartItem(customer_id=SHOPPERS[1], product_id="PRDRC1", quantity=1))
    setup.add(Referral(referrer_id=SHOPPERS[0], referee_id=SHOPPERS[1], code="RACE1234", status="pending", flags=[],
                       signup_ip_hash="", reward_type="store_credit", referrer_reward=0, referee_reward=0,
                       reversal_shortfall=0, note="", expires_at=datetime.utcnow() + timedelta(days=30),
                       created_at=datetime.utcnow(), updated_at=datetime.utcnow()))
    setup.commit()
    _checkout(setup, SHOPPERS[1])
    order_id = setup.execute(select(Order.id).where(Order.customer_id == SHOPPERS[1])).scalar_one()
    order = setup.get(Order, order_id)
    order.payment_status = "paid"
    setup.commit()
    setup.close()

    def trigger(session, index):
        referrals._qualify(session, session.get(Order, order_id))
        session.commit()

    outcomes = _together(Session, trigger, 2)
    assert outcomes == ["ok", "ok"]
    check = Session()
    credits = check.execute(select(StoreCreditTransaction).where(
        StoreCreditTransaction.customer_id.in_(SHOPPERS[:2]), StoreCreditTransaction.kind == "referral")).scalars().all()
    assert len(credits) == 2  # one for each side, not four
    assert check.execute(select(Referral.status).where(Referral.referee_id == SHOPPERS[1])).scalar_one() == "rewarded"
    check.close()
