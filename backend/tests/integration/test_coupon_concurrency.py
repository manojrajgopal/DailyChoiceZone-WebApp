"""
A coupon's last use, claimed by several shoppers at the same instant.

Run on real, separate connections that commit, because the failure it guards
against (two transactions both reading "one use left") only exists when they
genuinely overlap. These commit for real, so they clean up after themselves.
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
SHOPPERS = [f"CUSCPN{i}" for i in range(4)]
CODE = "LASTONE"


@pytest.fixture()
def arena(engine):
    from app.core.security import hash_password
    from app.models import CartItem, Category, Coupon, Customer, Product, SettingDocument

    Session = sessionmaker(bind=engine, expire_on_commit=False)
    setup = Session()
    setup.add(Category(id="CATCPN", slug="race-coupons", name="Race", display_order=99))
    setup.add(Product(id="PRDCPN", slug="race-cpn", sku="DCZ-CPNRACE", name="Race product", brand="Test",
                      category_id="CATCPN", subcategory="race", price=1000.0, original_price=1000.0, discount=0,
                      stock=50, status="active"))
    created_billing = setup.get(SettingDocument, "billing") is None
    if created_billing:
        setup.add(SettingDocument(key="billing", value={"currency": {"code": "INR"},
                                                        "payment": {"enabledMethods": ["cod"]}}))
    setup.add(Coupon(id="CPNRACE", code=CODE, description="", type="flat", value=100, min_subtotal=0,
                     active=True, starts_at=datetime.utcnow() - timedelta(days=1), usage_limit=1, usage_count=0))
    for shopper in SHOPPERS:
        setup.add(Customer(id=shopper, email=f"{shopper.lower()}@example.com", password_hash=hash_password("Race@12345"),
                           first_name="Race", last_name=shopper[-1], phone="9800000000", status="active",
                           joined_at=datetime(2026, 1, 1)))
        setup.add(CartItem(customer_id=shopper, product_id="PRDCPN", quantity=1))
    setup.commit()
    setup.close()
    yield Session
    _cleanup(Session, created_billing)


def _cleanup(Session, created_billing):
    from app.models import (
        CartItem, Category, Coupon, CouponUsage, Customer, Invoice, InvoiceItem, Notification, Order, OrderEvent,
        OrderItem, Payment, PaymentEvent, Product, SettingDocument, StockAdjustment,
    )

    db = Session()
    orders = list(db.execute(select(Order.id).where(Order.customer_id.in_(SHOPPERS))).scalars())
    db.execute(delete(CouponUsage).where(CouponUsage.customer_id.in_(SHOPPERS)))
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
    db.execute(delete(CartItem).where(CartItem.customer_id.in_(SHOPPERS)))
    db.execute(delete(Coupon).where(Coupon.id == "CPNRACE"))
    db.execute(delete(StockAdjustment).where(StockAdjustment.product_id == "PRDCPN"))
    db.execute(delete(Notification).where(Notification.title.like("%Race product%")))
    db.execute(delete(Customer).where(Customer.id.in_(SHOPPERS)))
    db.execute(delete(Product).where(Product.id == "PRDCPN"))
    db.execute(delete(Category).where(Category.id == "CATCPN"))
    if created_billing:
        db.execute(delete(SettingDocument).where(SettingDocument.key == "billing"))
    db.commit()
    db.close()


def _race(Session, count):
    from app.models import Customer
    from app.services import orders as order_service

    start = threading.Barrier(count)
    outcomes = {}

    def buy(customer_id):
        session = Session()
        try:
            customer = session.get(Customer, customer_id)
            start.wait()
            order_service.place_order(session, customer, shipping_address=ADDRESS, billing_address=None,
                                      delivery_method="standard", payment_method="cod", coupon_code=CODE)
            outcomes[customer_id] = "bought"
        except Exception as error:  # noqa: BLE001
            session.rollback()
            outcomes[customer_id] = getattr(error, "error_code", type(error).__name__)
        finally:
            session.close()

    threads = [threading.Thread(target=buy, args=(shopper,)) for shopper in SHOPPERS[:count]]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)
    return outcomes


def test_the_last_use_of_a_coupon_is_redeemed_exactly_once(arena):
    from app.models import Coupon, CouponUsage

    outcomes = _race(arena, len(SHOPPERS))
    check = arena()
    try:
        coupon = check.get(Coupon, "CPNRACE")
        usages = check.execute(select(CouponUsage).where(CouponUsage.coupon_id == "CPNRACE")).scalars().all()
        assert coupon.usage_count == 1, outcomes
        assert len(usages) == 1, outcomes
        assert list(outcomes.values()).count("bought") == 1, outcomes
        refused = [o for o in outcomes.values() if o != "bought"]
        assert set(refused) <= {"COUPON_EXHAUSTED", "COUPON_UNAVAILABLE", "COUPON_INVALID", "COUPON_EXPIRED"}, outcomes
    finally:
        check.close()
