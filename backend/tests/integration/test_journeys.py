"""
Whole journeys, through the API only, the way a shopper and the team use it.

Each step is tested on its own elsewhere. These check that the steps agree
with one another over a whole life: that stock, the invoice, the payment and
the refund still add up after an order has been placed, moved through every
stage, returned and refunded. A bug that lives *between* two services (each
correct alone) shows up here and nowhere else.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.core import rate_limit

from tests.integration.fulfilment_helpers import advance  # noqa: E402

pytestmark = pytest.mark.integration

ADDRESS = {"fullName": "Asha Rao", "phone": "9876500001", "line1": "4 Brigade Road", "line2": "",
           "city": "Bengaluru", "state": "Karnataka", "pincode": "560001", "country": "India"}
STAGES = ["confirmed", "processing", "packed", "shipped", "in-transit", "out-for-delivery", "delivered"]


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


def _stock(db, product_id):
    from app.models import Product

    db.expire_all()
    return db.get(Product, product_id).stock


def _checkout(client, headers, payment="upi", coupon=None, quantity=2, product="PRD001"):
    assert client.post("/api/cart/items", headers=headers,
                       json={"productId": product, "quantity": quantity}).status_code == 201
    response = client.post("/api/orders", headers=headers, json={
        "shippingAddress": ADDRESS, "deliveryMethod": "standard", "paymentMethod": payment, "couponCode": coupon})
    assert response.status_code == 201, response.text
    return response.json()["data"]


def _move(client, admin_auth, order_id, status, confirm=False):
    response = client.put(f"/api/admin/orders/{order_id}/status", headers=admin_auth,
                          json={"status": status, "note": "", "confirm": confirm})
    assert response.status_code == 200, f"{status}: {response.text}"
    return response.json()["data"]


class TestPrepaidOrderToRefund:
    """Placed and paid, delivered through every stage, returned, received back into stock, refunded."""

    def test_the_whole_life_of_an_order(self, client, db, auth, admin_auth, catalogue, settings_documents):
        from app.models import Invoice, Order, Payment

        start = _stock(db, "PRD001")
        placed = _checkout(client, auth, quantity=2)
        order_id = placed["order"]["id"]
        assert placed["order"]["paymentStatus"] == "paid"
        assert _stock(db, "PRD001") == start - 2

        # The customer sees it, the invoice and the order agree on the total.
        mine = client.get(f"/api/orders/{order_id}", headers=auth).json()["data"]
        invoice = db.get(Invoice, mine["invoiceId"])
        assert invoice.grand_total == round(mine["totals"]["total"] * 100)
        assert invoice.amount_paid == invoice.grand_total

        # The team moves it through every stage; each one is on the timeline.
        for stage in STAGES:
            advance(client, admin_auth, order_id, stage)
        timeline = [e["status"] for e in client.get(f"/api/orders/{order_id}", headers=auth).json()["data"]["timeline"]]
        assert timeline[-len(STAGES):] == STAGES

        # Delivered: a return is now open, and it is requested for one unit.
        options = client.get(f"/api/orders/{order_id}/returns", headers=auth).json()["data"]["eligibility"]
        assert options["eligible"] is True
        item_id = options["items"][0]["orderItemId"]
        request = client.post(f"/api/orders/{order_id}/returns", headers=auth, json={
            "kind": "return", "reason": "Size or fit isn't right", "items": [{"orderItemId": item_id, "quantity": 1}]})
        assert request.status_code == 201, request.text
        request_id = request.json()["data"]["id"]

        # Approved, received back (restocked), refunded.
        for status in ("approved", "received", "refunded"):
            moved = client.put(f"/api/admin/returns/{request_id}/status", headers=admin_auth,
                               json={"status": status, "note": f"{status} by the team"})
            assert moved.status_code == 200, f"{status}: {moved.text}"
        assert _stock(db, "PRD001") == start - 1

        db.expire_all()
        payment = db.get(Payment, placed["paymentId"])
        invoice = db.get(Invoice, mine["invoiceId"])
        assert 0 < payment.refunded_amount < payment.amount
        assert payment.status == "partially-refunded"
        assert invoice.amount_refunded == payment.refunded_amount
        assert db.get(Order, order_id).status == "delivered"

        # Finished: no further moves, and the customer sees it as refunded.
        again = client.put(f"/api/admin/returns/{request_id}/status", headers=admin_auth, json={"status": "approved"})
        assert again.status_code == 409
        returns = client.get("/api/returns", headers=auth).json()["data"]
        assert returns[0]["status"] == "refunded"

    def test_the_refund_is_never_more_than_the_line(self, client, db, auth, admin_auth, catalogue,
                                                   settings_documents):
        from app.models import Payment

        placed = _checkout(client, auth, quantity=1)
        order_id = placed["order"]["id"]
        for stage in STAGES:
            advance(client, admin_auth, order_id, stage)
        item_id = client.get(f"/api/orders/{order_id}/returns", headers=auth).json()["data"]["eligibility"]["items"][0][
            "orderItemId"]
        request_id = client.post(f"/api/orders/{order_id}/returns", headers=auth, json={
            "kind": "return", "reason": "Changed my mind",
            "items": [{"orderItemId": item_id, "quantity": 1}]}).json()["data"]["id"]
        for status in ("approved", "received", "refunded"):
            client.put(f"/api/admin/returns/{request_id}/status", headers=admin_auth, json={"status": status})
        db.expire_all()
        payment = db.get(Payment, placed["paymentId"])
        assert payment.refunded_amount <= payment.amount


class TestCashOnDelivery:
    def test_collected_on_delivery_then_cancel_is_refused(self, client, db, auth, admin_auth, catalogue,
                                                         settings_documents):
        from app.models import Payment

        start = _stock(db, "PRD001")
        placed = _checkout(client, auth, payment="cod", quantity=1)
        order_id = placed["order"]["id"]
        assert placed["order"]["paymentStatus"] == "cod-pending"  # owed, collected at the door
        assert _stock(db, "PRD001") == start - 1

        for stage in STAGES:
            advance(client, admin_auth, order_id, stage)
        # Delivering it records the courier's collection: the payment is settled.
        db.expire_all()
        assert db.get(Payment, placed["paymentId"]).status == "paid"
        # So marking it received by hand afterwards is refused, not applied twice.
        twice = client.post(f"/api/admin/billing/payments/{placed['paymentId']}/capture", headers=admin_auth)
        assert twice.status_code == 409 and twice.json()["error_code"] == "PAYMENT_NOT_CAPTURABLE"

        # A delivered order can't be cancelled by anyone.
        assert client.post(f"/api/orders/{order_id}/cancel", headers=auth, json={"reason": "x"}).status_code == 409

    def test_cash_can_be_marked_received_before_the_delivery_is(self, client, db, auth, admin_auth, catalogue,
                                                              settings_documents):
        """Collected early (a store pickup, say): captured by hand while the order is still on its way."""
        from app.models import Payment

        placed = _checkout(client, auth, payment="cod", quantity=1)
        _move(client, admin_auth, placed["order"]["id"], "confirmed")
        captured = client.post(f"/api/admin/billing/payments/{placed['paymentId']}/capture", headers=admin_auth)
        assert captured.status_code == 200, captured.text
        db.expire_all()
        assert db.get(Payment, placed["paymentId"]).status == "paid"


class TestCancelBeforeDispatch:
    def test_cancelling_gives_the_stock_back_and_refunds(self, client, db, auth, admin_auth, catalogue,
                                                        settings_documents):
        from app.models import Order, Payment

        start = _stock(db, "PRD002")
        placed = _checkout(client, auth, quantity=2, product="PRD002")
        order_id = placed["order"]["id"]
        assert _stock(db, "PRD002") == start - 2
        _move(client, admin_auth, order_id, "confirmed")

        cancelled = client.post(f"/api/orders/{order_id}/cancel", headers=auth, json={"reason": "Ordered by mistake"})
        assert cancelled.status_code == 200, cancelled.text
        assert _stock(db, "PRD002") == start
        db.expire_all()
        assert db.get(Order, order_id).status == "cancelled"
        payment = db.get(Payment, placed["paymentId"])
        assert payment.refunded_amount == payment.amount and payment.status == "refunded"

        # Cancelled is final.
        response = client.put(f"/api/admin/orders/{order_id}/status", headers=admin_auth,
                              json={"status": "confirmed", "confirm": True})
        assert response.status_code == 409
        # And cancelling twice changes nothing.
        assert client.post(f"/api/orders/{order_id}/cancel", headers=auth, json={}).status_code == 409
        assert _stock(db, "PRD002") == start

    def test_the_last_units_sell_out_and_come_back(self, client, db, auth, catalogue, settings_documents):
        from app.models import Product

        placed = _checkout(client, auth, quantity=3, product="PRD002")  # all three
        db.expire_all()
        assert db.get(Product, "PRD002").stock == 0
        # Nobody else can add it now.
        sold_out = client.post("/api/cart/items", headers=auth, json={"productId": "PRD002", "quantity": 1})
        assert sold_out.status_code in (409, 422)
        client.post(f"/api/orders/{placed['order']['id']}/cancel", headers=auth, json={"reason": "x"})
        db.expire_all()
        assert db.get(Product, "PRD002").stock == 3


class TestCoupons:
    def test_a_coupon_is_counted_once_per_order_and_not_after_its_limit(self, client, db, auth, admin_auth, catalogue,
                                                                       settings_documents):
        from app.models import Coupon

        created = client.post("/api/admin/coupons", headers=admin_auth, json={
            "code": "ONCE", "type": "flat", "value": 100, "usageLimit": 1,
            "startsAt": (datetime.utcnow() - timedelta(days=1)).isoformat()})
        assert created.status_code == 201, created.text

        first = _checkout(client, auth, coupon="ONCE", quantity=1)
        assert first["order"]["totals"]["couponDiscount"] == 100
        db.expire_all()
        assert db.query(Coupon).filter_by(code="ONCE").one().usage_count == 1

        # Exhausted: the next checkout is refused rather than silently charged full price.
        assert client.post("/api/cart/items", headers=auth, json={"productId": "PRD001", "quantity": 1}).status_code == 201
        second = client.post("/api/orders", headers=auth, json={
            "shippingAddress": ADDRESS, "deliveryMethod": "standard", "paymentMethod": "upi", "couponCode": "ONCE"})
        assert second.status_code in (409, 422), second.text


class TestAccountRecovery:
    def test_forgot_reset_and_sign_in_again(self, client, customer, monkeypatch):
        import re
        import time

        from jose import jwt

        from app.core.config import settings

        from app.services import email as email_service

        sent = []

        def record(db, key, *, to, customer_id, subject, html, text, reference="", **_):
            found = re.search(r"token=([A-Za-z0-9_\-]+)", text)
            sent.append({"to": to, "token": found.group(1) if found else None})
            return True

        monkeypatch.setattr(email_service, "notify", record)

        # A session from a minute ago, on another device. (Tokens are compared to
        # the reset by the second, so one issued in the same second would survive.)
        now = int(time.time())
        old = jwt.encode({"sub": customer.id, "actor": "customer", "iat": now - 60, "exp": now + 3600},
                         settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)
        auth = {"Authorization": f"Bearer {old}"}
        assert client.get("/api/auth/me", headers=auth).status_code == 200
        assert client.post("/api/auth/password/forgot", json={"email": customer.email}).status_code == 200
        token = next(m["token"] for m in sent if m["to"] == customer.email and m["token"])

        assert client.post("/api/auth/password/reset/check", json={"token": token}).status_code == 200
        reset = client.post("/api/auth/password/reset", json={
            "token": token, "password": "BrandNew123", "confirmPassword": "BrandNew123"})
        assert reset.status_code == 200, reset.text

        # Signed out everywhere: the old session's token stops working.
        assert client.get("/api/auth/me", headers=auth).status_code == 401
        # The old password is gone, the new one works, the link is spent.
        assert client.post("/api/auth/login", json={"email": customer.email,
                                                    "password": "Customer@123"}).status_code == 401
        assert client.post("/api/auth/login", json={"email": customer.email,
                                                    "password": "BrandNew123"}).status_code == 200
        assert client.post("/api/auth/password/reset", json={
            "token": token, "password": "Another123", "confirmPassword": "Another123"}).status_code in (400, 409, 410, 422)


class TestFirstInstall:
    def test_first_person_runs_the_shop_and_the_next_one_shops(self, client, db):
        """An empty store: the first account becomes the administrator, builds a product, the second buys it."""
        from app.models import SettingDocument

        db.add_all([
            SettingDocument(key="tax", value={"enabled": False, "taxType": "NONE"}),
            SettingDocument(key="billing", value={"payment": {"enabledMethods": ["upi", "cod"]}}),
            SettingDocument(key="store", value={"shipping": {"freeDeliveryThreshold": 0, "standardFee": 0}}),
        ])
        db.flush()
        owner = client.post("/api/auth/register", json={
            "email": "owner@example.com", "password": "Owner1234", "firstName": "Owner"})
        assert owner.status_code == 201, owner.text
        portal = client.post("/api/admin/auth/login", json={"email": "owner@example.com", "password": "Owner1234"})
        assert portal.status_code == 200
        admin = {"Authorization": "Bearer " + portal.json()["data"]["token"]["accessToken"]}

        category = client.post("/api/admin/categories", headers=admin, json={"name": "Home"}).json()["data"]
        product = client.post("/api/products", headers=admin, json={
            "name": "Brass Lamp", "brand": "DCZ", "category": category["slug"], "subcategory": "lighting",
            "price": 1500, "originalPrice": 1800, "stock": 4, "status": "active", "sku": "DCZ-LAMP-1",
            "description": "A lamp."})
        assert product.status_code == 201, product.text
        product_id = product.json()["data"]["id"]

        shopper = client.post("/api/auth/register", json={
            "email": "first.buyer@example.com", "password": "Buyer1234", "firstName": "Buyer"})
        assert shopper.status_code == 201
        headers = {"Authorization": "Bearer " + shopper.json()["data"]["token"]["accessToken"]}
        assert client.post("/api/admin/auth/login", json={"email": "first.buyer@example.com",
                                                          "password": "Buyer1234"}).status_code in (401, 403)

        found = client.get("/api/products", params={"search": "brass"}).json()["data"]
        assert [p["id"] for p in found] == [product_id]
        assert found[0]["discount"] == 16  # 16.67% off, floored: a badge never overstates a discount

        order = _checkout(client, headers, quantity=1, product=product_id)
        assert order["order"]["totals"]["total"] == 1500
        assert _stock(db, product_id) == 3
