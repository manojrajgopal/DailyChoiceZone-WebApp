"""
The payment module, attacked.

Every test here corresponds to a way real money or real stock could go wrong,
most of them found in an audit of this code and fixed alongside these tests:

- stock read, checked and written with no lock, so two orders for the last
  unit both succeeded;
- a free-text payment method, so `"cod"` confirmed unpaid orders on a store
  with cash on delivery switched off;
- cancelling a paid order put the stock back and kept the money;
- unpaid orders held stock forever;
- a second payment for a paid order was silently ignored — charged twice;
- refunds recorded as complete while the gateway was still processing them.

The gateway is stubbed at its HTTP seam, never at the logic: signatures are
real HMACs, the locks are real `SELECT … FOR UPDATE`, and the concurrency test
runs two genuine database connections against the same row.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import threading
from datetime import datetime, timedelta

import pytest

pytestmark = pytest.mark.integration


KEY_ID = "rzp_test_securitysuite00"
KEY_SECRET = "secret_for_the_security_suite"
WEBHOOK_SECRET = "webhook_secret_for_the_suite"

ADDRESS = {
    "fullName": "Asha Rao", "phone": "9876500001", "line1": "4 Brigade Road",
    "line2": "", "city": "Bengaluru", "state": "Karnataka", "pincode": "560001",
    "country": "India", "email": "shopper@example.com",
}


def sign(message: str, secret: str = KEY_SECRET) -> str:
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()


def order_payload(**overrides) -> dict:
    body = {
        "shippingAddress": ADDRESS, "billingAddress": None, "deliveryMethod": "standard",
        "paymentMethod": "upi", "couponCode": None, "email": "shopper@example.com",
        "saveAddress": False,
    }
    body.update(overrides)
    return body


# ---------------------------------------------------------------- fixtures


@pytest.fixture()
def gateway(monkeypatch):
    """
    Razorpay, with its HTTP transport replaced and everything else real.

    `calls` records every request that would have gone to the gateway, so a
    test can assert that a refund *was* asked for, and for how much.
    Unstubbed paths answer `{}` — closing a QR code or a link has nothing
    interesting to say back.
    """
    from app.core.config import settings
    from app.services import payments
    from app.services.payments.razorpay import RazorpayPaymentProvider

    monkeypatch.setattr(settings, "PAYMENT_PROVIDER", "razorpay")
    monkeypatch.setattr(settings, "RAZOR_KEY_ID", KEY_ID)
    monkeypatch.setattr(settings, "RAZOR_KEY_SECRET", KEY_SECRET)
    monkeypatch.setattr(settings, "RAZOR_WEBHOOK_SECRET", WEBHOOK_SECRET)

    provider = RazorpayPaymentProvider()
    provider.calls = []
    provider.responses = {}
    provider.refund_count = 0

    def fake_request(method, path, **kwargs):
        provider.calls.append({"method": method, "path": path, **kwargs})
        if path in provider.responses:
            answer = provider.responses[path]
            return answer() if callable(answer) else answer
        if path.endswith("/refund"):
            provider.refund_count += 1
            return {"id": f"rfnd_auto{provider.refund_count:04d}", "status": "processed"}
        if path == "/orders":
            return {"id": f"order_sec{len(provider.calls):04d}"}
        return {}

    monkeypatch.setattr(provider, "_request", fake_request)

    payments.get_provider.cache_clear() if hasattr(payments.get_provider, "cache_clear") else None
    for target in (
        "app.services.payments.get_provider",
        "app.services.orders.get_provider",
        "app.services.settlement.get_provider",
        "app.services.invoices.get_provider",
    ):
        monkeypatch.setattr(target, lambda: provider)

    return provider


def refunds_sent(provider) -> list:
    return [call for call in provider.calls if call["path"].endswith("/refund")]


def place(client, auth, *, product="PRD001", quantity=1, **overrides):
    client.post("/api/cart/items", headers=auth, json={"productId": product, "quantity": quantity})
    return client.post("/api/orders", headers=auth, json=order_payload(**overrides))


def captured(order_ref, pay_id, amount, *, currency="INR", notes=None):
    return {
        "id": pay_id, "status": "captured", "order_id": order_ref, "amount": amount,
        "currency": currency, "method": "upi", "vpa": "asha@okhdfc", "notes": notes or {},
    }


def verify(client, auth, placed, pay_id):
    order_ref = placed["gateway"]["orderReference"]
    return client.post(
        f"/api/payments/{placed['paymentId']}/verify", headers=auth,
        json={
            "razorpayOrderId": order_ref,
            "razorpayPaymentId": pay_id,
            "razorpaySignature": sign(f"{order_ref}|{pay_id}"),
        },
    )


def webhook(client, body: dict, *, event_id: str):
    raw = json.dumps(body).encode()
    return client.post(
        "/api/payments/webhook/razorpay", content=raw,
        headers={
            "Content-Type": "application/json",
            "X-Razorpay-Signature": sign(raw.decode(), WEBHOOK_SECRET),
            "X-Razorpay-Event-Id": event_id,
        },
    )


# ========================================================== 1. authentication


class TestAuthentication:
    """Nothing about money is reachable without an account."""

    def test_an_order_needs_an_account(self, client, catalogue, settings_documents):
        assert client.post("/api/orders", json=order_payload()).status_code == 401

    def test_a_payment_session_needs_an_account(self, client):
        assert client.get("/api/payments/PAY001/session").status_code == 401

    def test_a_qr_code_needs_an_account(self, client):
        assert client.post("/api/payments/PAY001/qr").status_code == 401

    def test_an_admin_token_cannot_place_a_customer_order(
        self, client, admin_auth, catalogue, settings_documents
    ):
        assert client.post("/api/orders", headers=admin_auth, json=order_payload()).status_code == 403

    def test_someone_elses_payment_is_not_there(
        self, client, auth, gateway, catalogue, settings_documents, other_customer
    ):
        placed = place(client, auth).json()["data"]

        response = client.post("/api/auth/login", json={
            "email": other_customer.email, "password": "Customer@123"})
        theirs = {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}

        # 404, not 403: "that exists but is not yours" is itself worth hiding.
        assert client.get(f"/api/payments/{placed['paymentId']}/session", headers=theirs).status_code == 404
        assert client.post(f"/api/payments/{placed['paymentId']}/qr", headers=theirs).status_code == 404


# ======================================================== 2. input validation


class TestInputs:
    @pytest.mark.parametrize("quantity", [0, -5, 11, 10_000])
    def test_a_quantity_out_of_bounds_is_refused(self, client, auth, catalogue, quantity):
        response = client.post("/api/cart/items", headers=auth,
                               json={"productId": "PRD001", "quantity": quantity})
        assert response.status_code == 422, response.text

    def test_a_size_the_product_does_not_come_in_is_refused(self, client, auth, catalogue, db):
        from app.models import ProductSize

        db.add_all([ProductSize(product_id="PRD001", label=label, position=index)
                    for index, label in enumerate(["S", "M", "L"])])
        db.flush()

        refused = client.post("/api/cart/items", headers=auth,
                              json={"productId": "PRD001", "size": "XXXL", "quantity": 1})
        assert refused.status_code == 422
        assert refused.json()["error_code"] == "SIZE_UNAVAILABLE"

        accepted = client.post("/api/cart/items", headers=auth,
                               json={"productId": "PRD001", "size": "M", "quantity": 1})
        assert accepted.status_code == 201, accepted.text

    def test_an_unknown_delivery_method_is_refused(self, client, auth, catalogue, settings_documents):
        response = place(client, auth, deliveryMethod="teleport")
        assert response.status_code == 422
        assert response.json()["error_code"] == "DELIVERY_METHOD_INVALID"

    def test_an_unknown_payment_method_is_refused(self, client, auth, catalogue, settings_documents):
        response = place(client, auth, paymentMethod="free")
        assert response.status_code == 422
        assert response.json()["error_code"] == "PAYMENT_METHOD_INVALID"

    def test_cash_on_delivery_cannot_be_chosen_when_the_store_has_it_off(
        self, client, auth, catalogue, settings_documents, db
    ):
        """
        The finding: `"cod"` used to confirm an unpaid order regardless.

        That is a confirmed order with nothing paid and nothing to collect.
        """
        from app.models import SettingDocument

        document = db.get(SettingDocument, "billing")
        document.value = {**document.value, "payment": {"enabledMethods": ["upi", "card"], "codFee": 0}}
        db.flush()

        response = place(client, auth, paymentMethod="cod")
        assert response.status_code == 422
        assert response.json()["error_code"] == "PAYMENT_METHOD_UNAVAILABLE"


# ================================================================ 3. pricing


class TestPricing:
    def test_money_in_the_request_is_ignored(
        self, client, auth, gateway, catalogue, settings_documents
    ):
        """
        A client that names its own price gets the catalogue's instead.

        PRD001 sells at ₹1,000. The request claims ₹1.
        """
        client.post("/api/cart/items", headers=auth, json={"productId": "PRD001", "quantity": 1})
        response = client.post("/api/orders", headers=auth, json={
            **order_payload(),
            "total": 1, "amount": 100, "price": 1, "grandTotal": 100, "discount": 99999,
        })
        assert response.status_code == 201, response.text

        data = response.json()["data"]
        assert data["amount"] == 100_000
        # And the gateway was asked for the real figure, which is what is charged.
        opened = next(call for call in gateway.calls if call["path"] == "/orders")
        assert opened["json"]["amount"] == 100_000


# ================================================================== 4. stock


class TestStockHolds:
    def test_a_prepaid_order_holds_stock_without_taking_it(
        self, client, auth, gateway, catalogue, settings_documents, db
    ):
        from app.models import Order, Product

        placed = place(client, auth, quantity=2).json()["data"]
        product = db.get(Product, "PRD001")
        db.refresh(product)

        assert product.stock == 10
        assert product.reserved_stock == 2
        assert product.available_stock == 8

        order = db.get(Order, placed["order"]["id"])
        assert order.stock_state == "reserved"
        assert order.payment_expires_at is not None

    def test_cash_on_delivery_takes_stock_at_once(
        self, client, auth, gateway, catalogue, settings_documents, db
    ):
        from app.models import Product

        assert place(client, auth, quantity=2, paymentMethod="cod").status_code == 201
        product = db.get(Product, "PRD001")
        db.refresh(product)

        assert product.stock == 8
        assert product.reserved_stock == 0

    def test_a_held_unit_cannot_be_bought_by_someone_else(
        self, client, auth, gateway, catalogue, settings_documents, other_customer
    ):
        """PRD002 has three. Hold all three, and it is sold out to everybody else."""
        assert place(client, auth, product="PRD002", quantity=3).status_code == 201

        response = client.post("/api/auth/login", json={
            "email": other_customer.email, "password": "Customer@123"})
        theirs = {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}

        refused = client.post("/api/cart/items", headers=theirs,
                              json={"productId": "PRD002", "quantity": 1})
        assert refused.status_code == 409
        assert refused.json()["error_code"] == "OUT_OF_STOCK"

    def test_payment_turns_the_hold_into_a_sale(
        self, client, auth, gateway, catalogue, settings_documents, db
    ):
        from app.models import Order, Product

        placed = place(client, auth, quantity=2).json()["data"]
        ref = placed["gateway"]["orderReference"]
        gateway.responses["/payments/pay_hold01"] = captured(ref, "pay_hold01", placed["amount"])

        assert verify(client, auth, placed, "pay_hold01").status_code == 200

        product = db.get(Product, "PRD001")
        db.refresh(product)
        assert product.stock == 8
        assert product.reserved_stock == 0

        order = db.get(Order, placed["order"]["id"])
        assert order.stock_state == "consumed"
        assert order.status == "confirmed"

    def test_one_customer_cannot_hoard_the_shelf(
        self, client, auth, gateway, catalogue, settings_documents
    ):
        """Three unpaid holds are allowed; a fourth is refused."""
        for _ in range(3):
            assert place(client, auth).status_code == 201

        refused = place(client, auth)
        assert refused.status_code == 409
        assert refused.json()["error_code"] == "TOO_MANY_UNPAID_ORDERS"


class TestConcurrency:
    """
    Two shoppers, one unit, the same instant.

    Run against real, separate database connections, because the bug this
    guards against — read, check, write with no lock — only exists when two
    transactions genuinely overlap. A single session cannot reproduce it.
    """

    def test_the_last_unit_is_sold_exactly_once(self, engine):
        from sqlalchemy import delete
        from sqlalchemy.orm import sessionmaker

        from app.core.security import hash_password
        from app.models import (
            CartItem, Category, Customer, Invoice, InvoiceItem, Order, OrderEvent, OrderItem,
            Payment, PaymentEvent, Product, SettingDocument, StockAdjustment,
        )
        from app.services import orders as order_service

        Session = sessionmaker(bind=engine, expire_on_commit=False)

        setup = Session()
        setup.add(Category(id="CATRACE", slug="race", name="Race", display_order=99))
        setup.add(Product(
            id="PRDRACE", slug="the-last-one", sku="DCZ-RACE01", name="The Last One",
            brand="Test", category_id="CATRACE", subcategory="race", price=500.0,
            original_price=500.0, discount=0, stock=1, status="active",
        ))
        shoppers = []
        for index in range(2):
            shopper = Customer(
                id=f"CUSRACE{index}", email=f"race{index}@example.com",
                password_hash=hash_password("Race@12345"), first_name="Race",
                last_name=str(index), phone="9876500009", status="active",
                joined_at=datetime(2026, 1, 1),
            )
            setup.add(shopper)
            setup.add(CartItem(customer_id=shopper.id, product_id="PRDRACE", quantity=1))
            shoppers.append(shopper.id)
        created_settings = setup.get(SettingDocument, "billing") is None
        if created_settings:
            setup.add(SettingDocument(key="billing", value={
                "currency": {"code": "INR"},
                "invoice": {"prefix": "RACE-INV", "startNumber": 1, "padding": 6, "dueDays": 7},
                "payment": {"enabledMethods": ["cod"]},
                "order": {"prefix": "RACE", "startNumber": 1},
            }))
        setup.commit()

        start = threading.Barrier(2)
        outcomes = {}

        def buy(customer_id):
            session = Session()
            try:
                customer = session.get(Customer, customer_id)
                start.wait()
                order_service.place_order(
                    session, customer, shipping_address=ADDRESS, billing_address=None,
                    delivery_method="standard", payment_method="cod",
                )
                outcomes[customer_id] = "bought"
            except Exception as error:  # noqa: BLE001
                session.rollback()
                outcomes[customer_id] = getattr(error, "error_code", type(error).__name__)
            finally:
                session.close()

        threads = [threading.Thread(target=buy, args=(shopper,)) for shopper in shoppers]
        try:
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=60)

            check = Session()
            product = check.get(Product, "PRDRACE")
            assert product.stock == 0, "stock went below what was on the shelf"
            assert sorted(outcomes.values()) == ["INSUFFICIENT_STOCK", "bought"], outcomes
            check.close()
        finally:
            cleanup = Session()
            order_ids = [row for row in cleanup.execute(
                Order.__table__.select().with_only_columns(Order.id).where(Order.customer_id.in_(shoppers))
            ).scalars()]
            if order_ids:
                payment_ids = [row for row in cleanup.execute(
                    Payment.__table__.select().with_only_columns(Payment.id).where(Payment.order_id.in_(order_ids))
                ).scalars()]
                invoice_ids = [row for row in cleanup.execute(
                    Invoice.__table__.select().with_only_columns(Invoice.id).where(Invoice.order_id.in_(order_ids))
                ).scalars()]
                if payment_ids:
                    cleanup.execute(delete(PaymentEvent).where(PaymentEvent.payment_id.in_(payment_ids)))
                cleanup.execute(Invoice.__table__.update().where(Invoice.id.in_(invoice_ids)).values(payment_id=None))
                cleanup.execute(delete(Payment).where(Payment.order_id.in_(order_ids)))
                cleanup.execute(delete(InvoiceItem).where(InvoiceItem.invoice_id.in_(invoice_ids)))
                cleanup.execute(delete(Invoice).where(Invoice.id.in_(invoice_ids)))
                cleanup.execute(delete(OrderEvent).where(OrderEvent.order_id.in_(order_ids)))
                cleanup.execute(delete(OrderItem).where(OrderItem.order_id.in_(order_ids)))
                cleanup.execute(delete(Order).where(Order.id.in_(order_ids)))
            cleanup.execute(delete(StockAdjustment).where(StockAdjustment.product_id == "PRDRACE"))
            cleanup.execute(delete(CartItem).where(CartItem.customer_id.in_(shoppers)))
            cleanup.execute(delete(Customer).where(Customer.id.in_(shoppers)))
            cleanup.execute(delete(Product).where(Product.id == "PRDRACE"))
            cleanup.execute(delete(Category).where(Category.id == "CATRACE"))
            if created_settings:
                cleanup.execute(delete(SettingDocument).where(SettingDocument.key == "billing"))
            cleanup.commit()
            cleanup.close()


# =============================================================== 5. timeout


def lapse(db, order_id: str) -> None:
    """Move an order's deadline into the past, beyond the grace period."""
    from app.models import Order

    order = db.get(Order, order_id)
    order.payment_expires_at = datetime.utcnow() - timedelta(minutes=10)
    db.flush()


class TestTheWindow:
    def test_the_sweeper_cancels_and_releases(
        self, client, auth, gateway, catalogue, settings_documents, db
    ):
        from app.models import Invoice, Order, Payment, Product
        from app.services.payment_expiry import sweep

        placed = place(client, auth, quantity=2).json()["data"]
        lapse(db, placed["order"]["id"])

        assert sweep(db) == 1

        order = db.get(Order, placed["order"]["id"])
        db.refresh(order)
        assert order.status == "cancelled"
        assert order.stock_state == "released"

        product = db.get(Product, "PRD001")
        db.refresh(product)
        assert product.reserved_stock == 0
        assert product.stock == 10, "releasing a hold must not add stock that was never taken"

        payment = db.get(Payment, placed["paymentId"])
        db.refresh(payment)
        assert payment.status == "expired"
        assert db.get(Invoice, placed["invoiceId"]).status == "cancelled"

    def test_the_sweeper_never_touches_legacy_or_cash_orders(
        self, client, auth, gateway, catalogue, settings_documents, db
    ):
        """
        Every order placed before holds existed has no deadline.

        The sweeper must be structurally unable to select it — the database
        this runs against in development holds two hundred such orders.
        """
        from app.models import Order
        from app.services.payment_expiry import sweep

        cod = place(client, auth, paymentMethod="cod").json()["data"]
        legacy = db.get(Order, cod["order"]["id"])
        legacy.placed_at = datetime.utcnow() - timedelta(days=30)
        db.flush()

        assert sweep(db) == 0
        db.refresh(legacy)
        assert legacy.status == "confirmed"

    def test_a_payment_after_the_window_is_refunded_not_accepted(
        self, client, auth, gateway, catalogue, settings_documents, db
    ):
        from app.models import Order, Product
        from app.services.payment_expiry import sweep

        placed = place(client, auth).json()["data"]
        ref = placed["gateway"]["orderReference"]
        lapse(db, placed["order"]["id"])
        sweep(db)

        gateway.responses["/payments/pay_late01"] = captured(ref, "pay_late01", placed["amount"])
        verify(client, auth, placed, "pay_late01")

        order = db.get(Order, placed["order"]["id"])
        db.refresh(order)
        assert order.status == "cancelled", "a late payment must never revive a cancelled order"

        sent = refunds_sent(gateway)
        assert [call["path"] for call in sent] == ["/payments/pay_late01/refund"]
        assert sent[0]["json"]["amount"] == placed["amount"]

        product = db.get(Product, "PRD001")
        db.refresh(product)
        assert product.stock == 10

    def test_a_late_payment_before_the_sweep_is_caught_too(
        self, client, auth, gateway, catalogue, settings_documents, db
    ):
        """The sweeper runs every thirty seconds; the verify call does not wait for it."""
        from app.models import Order

        placed = place(client, auth).json()["data"]
        ref = placed["gateway"]["orderReference"]
        lapse(db, placed["order"]["id"])

        gateway.responses["/payments/pay_late02"] = captured(ref, "pay_late02", placed["amount"])
        verify(client, auth, placed, "pay_late02")

        order = db.get(Order, placed["order"]["id"])
        db.refresh(order)
        assert order.status == "cancelled"
        assert len(refunds_sent(gateway)) == 1

    def test_a_payment_inside_the_grace_period_confirms(
        self, client, auth, gateway, catalogue, settings_documents, db
    ):
        """Started at 4:58, confirmed by the bank at 5:20 — not the shopper's fault."""
        from app.models import Order

        placed = place(client, auth).json()["data"]
        ref = placed["gateway"]["orderReference"]
        order = db.get(Order, placed["order"]["id"])
        order.payment_expires_at = datetime.utcnow() - timedelta(seconds=20)
        db.flush()

        gateway.responses["/payments/pay_grace1"] = captured(ref, "pay_grace1", placed["amount"])
        assert verify(client, auth, placed, "pay_grace1").status_code == 200

        db.refresh(order)
        assert order.status == "confirmed"
        assert refunds_sent(gateway) == []

    def test_no_new_payment_can_start_after_the_window(
        self, client, auth, gateway, catalogue, settings_documents, db
    ):
        from app.models import Order

        placed = place(client, auth).json()["data"]
        order = db.get(Order, placed["order"]["id"])
        order.payment_expires_at = datetime.utcnow() - timedelta(seconds=5)
        db.flush()

        qr = client.post(f"/api/payments/{placed['paymentId']}/qr", headers=auth)
        assert qr.status_code == 409
        assert qr.json()["error_code"] == "PAYMENT_WINDOW_CLOSED"

        session = client.get(f"/api/payments/{placed['paymentId']}/session", headers=auth).json()["data"]
        assert session["gateway"] is None

    def test_the_handoff_carries_the_deadline(
        self, client, auth, gateway, catalogue, settings_documents
    ):
        handoff = place(client, auth).json()["data"]["gateway"]
        assert handoff["expiresAt"].endswith("Z")
        assert 0 < handoff["secondsLeft"] <= 300


# ========================================================== 6. duplicates


class TestDuplicates:
    def test_a_second_payment_for_a_paid_order_is_refunded(
        self, client, auth, gateway, catalogue, settings_documents, db
    ):
        """
        The customer pays by QR and then by card as well. They were charged
        twice; the second charge goes back, automatically, exactly once.
        """
        from app.models import Order

        placed = place(client, auth).json()["data"]
        ref = placed["gateway"]["orderReference"]
        gateway.responses["/payments/pay_first1"] = captured(ref, "pay_first1", placed["amount"])
        assert verify(client, auth, placed, "pay_first1").status_code == 200

        second = {
            "event": "payment.captured",
            "payload": {"payment": {"entity": captured(ref, "pay_second", placed["amount"])}},
        }
        webhook(client, second, event_id="evt_dup_1")
        # The same stray payment reported again under a different event id.
        webhook(client, second, event_id="evt_dup_2")

        sent = refunds_sent(gateway)
        assert [call["path"] for call in sent] == ["/payments/pay_second/refund"]

        order = db.get(Order, placed["order"]["id"])
        db.refresh(order)
        assert order.status == "confirmed"
        assert order.payment_status == "paid"

    def test_a_redelivered_webhook_is_applied_once(
        self, client, auth, gateway, catalogue, settings_documents, db
    ):
        from app.models import Invoice

        placed = place(client, auth).json()["data"]
        ref = placed["gateway"]["orderReference"]
        body = {
            "event": "payment.captured",
            "payload": {"payment": {"entity": captured(ref, "pay_redeliv", placed["amount"])}},
        }

        first = webhook(client, body, event_id="evt_same")
        again = webhook(client, body, event_id="evt_same")

        assert first.status_code == 200 and again.status_code == 200
        assert again.json()["data"].get("duplicate") is True

        invoice = db.get(Invoice, placed["invoiceId"])
        db.refresh(invoice)
        assert invoice.amount_paid == placed["amount"]

    def test_a_payment_in_the_wrong_currency_is_refused(
        self, client, auth, gateway, catalogue, settings_documents, db
    ):
        from app.models import Order

        placed = place(client, auth).json()["data"]
        ref = placed["gateway"]["orderReference"]
        gateway.responses["/payments/pay_usd001"] = captured(
            ref, "pay_usd001", placed["amount"], currency="USD")

        assert verify(client, auth, placed, "pay_usd001").status_code == 409

        order = db.get(Order, placed["order"]["id"])
        db.refresh(order)
        assert order.payment_status != "paid"


# ======================================================= 7. cancellation


class TestCancellation:
    def test_cancelling_a_held_order_releases_rather_than_restocks(
        self, client, auth, gateway, catalogue, settings_documents, db
    ):
        from app.models import Product

        placed = place(client, auth, quantity=2).json()["data"]
        response = client.post(f"/api/orders/{placed['order']['id']}/cancel", headers=auth,
                               json={"reason": "Changed my mind"})
        assert response.status_code == 200, response.text

        product = db.get(Product, "PRD001")
        db.refresh(product)
        assert product.reserved_stock == 0
        assert product.stock == 10, "a hold released must not become stock added"

    def test_cancelling_a_paid_order_refunds_it(
        self, client, auth, gateway, catalogue, settings_documents, db
    ):
        """The finding: this used to put the stock back and keep the money."""
        from app.models import Payment, Product

        placed = place(client, auth).json()["data"]
        ref = placed["gateway"]["orderReference"]
        gateway.responses["/payments/pay_cancel1"] = captured(ref, "pay_cancel1", placed["amount"])
        verify(client, auth, placed, "pay_cancel1")

        response = client.post(f"/api/orders/{placed['order']['id']}/cancel", headers=auth,
                               json={"reason": "Ordered by mistake"})
        assert response.status_code == 200, response.text

        sent = refunds_sent(gateway)
        assert [call["path"] for call in sent] == ["/payments/pay_cancel1/refund"]
        assert sent[0]["json"]["amount"] == placed["amount"]

        payment = db.get(Payment, placed["paymentId"])
        db.refresh(payment)
        assert payment.status == "refunded"

        product = db.get(Product, "PRD001")
        db.refresh(product)
        assert product.stock == 10


# ============================================================ 8. refunds


class TestAsynchronousRefunds:
    @pytest.fixture()
    def paid(self, client, auth, gateway, catalogue, settings_documents):
        placed = place(client, auth).json()["data"]
        ref = placed["gateway"]["orderReference"]
        gateway.responses["/payments/pay_refnd01"] = captured(ref, "pay_refnd01", placed["amount"])
        verify(client, auth, placed, "pay_refnd01")
        # Razorpay answers "pending" for a normal-speed refund.
        gateway.responses["/payments/pay_refnd01/refund"] = {"id": "rfnd_async01", "status": "pending"}
        return placed

    def _refund(self, client, admin_auth, placed, amount):
        return client.post("/api/admin/billing/refunds", headers=admin_auth, json={
            "invoiceId": placed["invoiceId"], "amount": amount,
            "reason": "Damaged in transit", "status": "completed",
        })

    def test_a_pending_refund_is_processing_not_complete(self, client, admin_auth, paid):
        response = self._refund(client, admin_auth, paid, 50_000)
        assert response.status_code == 201, response.text
        assert response.json()["data"]["status"] == "processing"

    def test_a_processed_webhook_completes_it(self, client, admin_auth, paid, db):
        from app.models import Refund

        refund_id = self._refund(client, admin_auth, paid, 50_000).json()["data"]["id"]
        webhook(client, {"event": "refund.processed", "payload": {"refund": {"entity": {
            "id": "rfnd_async01", "payment_id": "pay_refnd01", "status": "processed"}}}},
            event_id="evt_rfnd_ok")

        refund = db.get(Refund, refund_id)
        db.refresh(refund)
        assert refund.status == "completed"

    def test_a_failed_refund_gives_the_amount_back(self, client, admin_auth, paid, db):
        """
        If the money did not go back, the payment must not say it did.

        Otherwise the refundable balance is wrong and nobody can retry.
        """
        from app.models import Payment, Refund

        refund_id = self._refund(client, admin_auth, paid, 50_000).json()["data"]["id"]
        webhook(client, {"event": "refund.failed", "payload": {"refund": {"entity": {
            "id": "rfnd_async01", "payment_id": "pay_refnd01", "status": "failed"}}}},
            event_id="evt_rfnd_fail")

        refund = db.get(Refund, refund_id)
        db.refresh(refund)
        assert refund.status == "failed"

        payment = db.get(Payment, paid["paymentId"])
        db.refresh(payment)
        assert payment.refunded_amount == 0
        assert payment.status == "paid"

    def test_a_refund_in_progress_cannot_be_sent_twice(self, client, admin_auth, paid, gateway):
        refund_id = self._refund(client, admin_auth, paid, 50_000).json()["data"]["id"]
        again = client.put(f"/api/admin/billing/refunds/{refund_id}", headers=admin_auth,
                           json={"status": "completed"})
        assert again.status_code == 409
        assert len([c for c in gateway.calls if c["path"].endswith("/refund")]) == 1


# ======================================================= 9. QR and links


class TestQrCodes:
    def test_only_a_code_issued_for_the_payment_can_settle_it(
        self, client, auth, gateway, catalogue, settings_documents
    ):
        placed = place(client, auth).json()["data"]
        polled = client.get(f"/api/payments/{placed['paymentId']}/qr/qr_notours", headers=auth)
        assert polled.status_code == 404

    def test_a_new_code_retires_the_old_one(
        self, client, auth, gateway, catalogue, settings_documents
    ):
        """Two live codes for one invoice is how somebody pays twice."""
        placed = place(client, auth).json()["data"]
        codes = iter(["qr_first0001", "qr_second001"])
        gateway.responses["/payments/qr_codes"] = lambda: {
            "id": next(codes), "image_url": "https://rzp.io/x", "status": "active",
            "payment_amount": placed["amount"],
        }

        client.post(f"/api/payments/{placed['paymentId']}/qr", headers=auth)
        client.post(f"/api/payments/{placed['paymentId']}/qr", headers=auth)

        closed = [c["path"] for c in gateway.calls if c["path"].endswith("/close")]
        assert closed == ["/payments/qr_codes/qr_first0001/close"]

    def test_the_code_closes_itself_at_the_deadline(
        self, client, auth, gateway, catalogue, settings_documents
    ):
        placed = place(client, auth).json()["data"]
        gateway.responses["/payments/qr_codes"] = {
            "id": "qr_deadline1", "image_url": "https://rzp.io/x", "status": "active",
            "payment_amount": placed["amount"],
        }
        client.post(f"/api/payments/{placed['paymentId']}/qr", headers=auth)

        minted = next(c for c in gateway.calls if c["path"] == "/payments/qr_codes")
        assert "close_by" in minted["json"]
        assert minted["json"]["usage"] == "single_use"
        assert minted["json"]["fixed_amount"] is True


class TestPaymentLinks:
    @pytest.fixture()
    def cod_order(self, client, auth, gateway, catalogue, settings_documents):
        return place(client, auth, paymentMethod="cod").json()["data"]

    def _link(self, client, admin_auth, placed):
        return client.post(f"/api/admin/orders/{placed['order']['id']}/payment-link", headers=admin_auth)

    def test_a_link_is_raised_for_a_cash_order(self, client, admin_auth, gateway, cod_order, db):
        from app.models import Payment

        gateway.responses["/payment_links"] = {
            "id": "plink_test0001", "short_url": "https://rzp.io/i/abc", "status": "created"}
        response = self._link(client, admin_auth, cod_order)
        assert response.status_code == 201, response.text

        sent = next(c for c in gateway.calls if c["path"] == "/payment_links")
        assert sent["json"]["reference_id"] == cod_order["paymentId"]
        assert sent["json"]["accept_partial"] is False
        assert sent["json"]["amount"] == cod_order["amount"]

        payment = db.get(Payment, cod_order["paymentId"])
        db.refresh(payment)
        assert payment.payment_link_id == "plink_test0001"

    def test_a_link_needs_the_orders_permission(self, client, editor, cod_order):
        response = client.post("/api/admin/auth/login",
                               json={"email": editor.email, "password": "Admin@123"})
        headers = {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}
        assert self._link(client, headers, cod_order).status_code == 403

    def test_a_checkout_order_cannot_be_paid_by_link(
        self, client, auth, admin_auth, gateway, catalogue, settings_documents
    ):
        """A link lives fifteen minutes at least; a checkout hold lives five."""
        placed = place(client, auth).json()["data"]
        response = self._link(client, admin_auth, placed)
        assert response.status_code == 409
        assert response.json()["error_code"] == "ORDER_IN_CHECKOUT"

    def test_a_forged_callback_settles_nothing(self, client, admin_auth, gateway, cod_order, db):
        from app.models import Order

        gateway.responses["/payment_links"] = {"id": "plink_forge001", "short_url": "x", "status": "created"}
        self._link(client, admin_auth, cod_order)

        response = client.get("/api/payments/link-callback", params={
            "razorpay_payment_id": "pay_forged01",
            "razorpay_payment_link_id": "plink_forge001",
            "razorpay_payment_link_reference_id": cod_order["paymentId"],
            "razorpay_payment_link_status": "paid",
            "razorpay_signature": "0" * 64,
        })
        assert response.status_code == 422

        order = db.get(Order, cod_order["order"]["id"])
        db.refresh(order)
        assert order.payment_status == "cod-pending"

    def test_a_signed_callback_settles_the_order(self, client, admin_auth, gateway, cod_order, db):
        from app.models import Order

        gateway.responses["/payment_links"] = {"id": "plink_good0001", "short_url": "x", "status": "created"}
        self._link(client, admin_auth, cod_order)
        gateway.responses["/payments/pay_link0001"] = {
            "id": "pay_link0001", "status": "captured", "amount": cod_order["amount"],
            "currency": "INR", "method": "upi", "vpa": "asha@okhdfc", "notes": {},
        }

        fields = ("plink_good0001", cod_order["paymentId"], "paid", "pay_link0001")
        response = client.get("/api/payments/link-callback", params={
            "razorpay_payment_id": fields[3],
            "razorpay_payment_link_id": fields[0],
            "razorpay_payment_link_reference_id": fields[1],
            "razorpay_payment_link_status": fields[2],
            "razorpay_signature": sign("|".join(fields)),
        })
        assert response.status_code == 200, response.text
        assert response.json()["data"]["paid"] is True

        order = db.get(Order, cod_order["order"]["id"])
        db.refresh(order)
        assert order.payment_status == "paid"


# ================================================= 10. production safeguards


class TestProductionGuard:
    def test_production_refuses_test_keys(self):
        from app.core.config import Settings

        problems = Settings(
            ENVIRONMENT="production", DEBUG=False, JWT_SECRET_KEY="x" * 40,
            PAYMENT_PROVIDER="razorpay", RAZOR_KEY_ID="rzp_test_abc", RAZOR_KEY_SECRET="s",
            RAZOR_WEBHOOK_SECRET="w", STOREFRONT_URL="https://shop.example",
        ).validate_production()
        assert any("test key" in problem for problem in problems)

    def test_production_refuses_the_mock(self):
        from app.core.config import Settings

        problems = Settings(
            ENVIRONMENT="production", DEBUG=False, JWT_SECRET_KEY="x" * 40,
            PAYMENT_PROVIDER="mock", STOREFRONT_URL="https://shop.example",
        ).validate_production()
        assert any("must be 'razorpay'" in problem for problem in problems)

    def test_production_requires_a_webhook_secret(self):
        from app.core.config import Settings

        problems = Settings(
            ENVIRONMENT="production", DEBUG=False, JWT_SECRET_KEY="x" * 40,
            PAYMENT_PROVIDER="razorpay", RAZOR_KEY_ID="rzp_live_abc", RAZOR_KEY_SECRET="s",
            RAZOR_WEBHOOK_SECRET="", STOREFRONT_URL="https://shop.example",
        ).validate_production()
        assert any("RAZOR_WEBHOOK_SECRET" in problem for problem in problems)

    def test_a_complete_live_configuration_passes(self):
        from app.core.config import Settings

        problems = Settings(
            ENVIRONMENT="production", DEBUG=False, JWT_SECRET_KEY="x" * 40,
            PAYMENT_PROVIDER="razorpay", RAZOR_KEY_ID="rzp_live_abc", RAZOR_KEY_SECRET="s",
            RAZOR_WEBHOOK_SECRET="w", STOREFRONT_URL="https://shop.example",
            CORS_ORIGINS=["https://shop.example"],
        ).validate_production()
        assert problems == []

    def test_the_mock_cannot_be_built_in_production(self, monkeypatch):
        from app.core.config import settings
        from app.services.payments.mock import MockPaymentProvider

        monkeypatch.setattr(settings, "ENVIRONMENT", "production")
        with pytest.raises(RuntimeError, match="cannot run in production"):
            MockPaymentProvider()
