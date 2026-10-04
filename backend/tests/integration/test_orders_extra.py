"""
Orders, beyond the happy path: what checkout refuses (payment and delivery
methods, a bag that changed underneath it, a total that moved), the order a
gateway has not settled yet (stock held, not taken), cancelling with money
collected, and the portal's view and controls.

The transition rules themselves are unit-tested in
`tests/unit/test_service_rules.py`; here they are exercised through the API
with the database effects -- stock, holds, refunds, timeline -- asserted.
"""

from __future__ import annotations

import pytest

from app.models import (
    CartItem,
    Invoice,
    Order,
    OrderEvent,
    Payment,
    PaymentEvent,
    Product,
    Refund,
)
from app.services.payments.base import PaymentResult
from app.services.payments.mock import MockPaymentProvider
from tests.integration.test_orders import ADDRESS, add, place, someone_elses_order

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _no_outgoing_mail(monkeypatch):
    """Nothing in these tests may leave the process."""
    from app.services.email import senders

    sent = []
    monkeypatch.setattr(senders, "deliver", lambda provider, credentials, message: sent.append(message) or "local")
    return sent


@pytest.fixture()
def ready(client, auth, catalogue, settings_documents):
    """A signed-in customer with two kurtas in the bag."""
    add(client, auth, "PRD001", 2)
    return auth


def stock_of(db, product_id):
    db.expire_all()
    product = db.get(Product, product_id)
    return product.stock, product.reserved_stock


class HeldProvider(MockPaymentProvider):
    """A gateway that has not settled by the time the order is placed, like a real one."""

    name = "held-test"

    def __init__(self, status="created"):
        super().__init__()
        self.status = status
        self.cancelled_links = []
        self.closed_qrs = []

    def create(self, request):
        if request.method == "cod":
            return super().create(request)
        return PaymentResult(ok=self.status != "failed", transaction_id=f"HELD-{request.order_id}",
                             status=self.status, failure_reason="Card declined" if self.status == "failed" else "")

    def cancel_payment_link(self, link_id):
        self.cancelled_links.append(link_id)

    def close_qr(self, qr_id):
        if qr_id.startswith("bad"):
            raise RuntimeError("gateway unreachable")
        self.closed_qrs.append(qr_id)


@pytest.fixture()
def held(monkeypatch):
    provider = HeldProvider()
    monkeypatch.setattr("app.services.orders.get_provider", lambda: provider)
    return provider


# ============================================================ what checkout checks


class TestPaymentAndDeliveryMethods:
    def test_an_unknown_payment_method_is_refused_and_nothing_moves(self, client, db, ready):
        response = place(client, ready, paymentMethod="bitcoin")
        assert response.status_code == 422
        assert response.json()["error_code"] == "PAYMENT_METHOD_INVALID"
        assert db.query(Order).count() == 0
        assert stock_of(db, "PRD001") == (10, 0)
        assert client.get("/api/cart", headers=ready).json()["data"]["items"][0]["quantity"] == 2

    def test_a_method_the_store_has_switched_off_is_refused(self, client, db, ready):
        response = place(client, ready, paymentMethod="netbanking")
        assert response.status_code == 422
        assert response.json()["error_code"] == "PAYMENT_METHOD_UNAVAILABLE"
        assert db.query(Order).count() == 0

    def test_debit_card_rides_on_the_card_switch(self, client, ready):
        response = place(client, ready, paymentMethod="debit-card")
        assert response.status_code == 201, response.text
        assert response.json()["data"]["order"]["paymentMethod"] == "debit-card"

    def test_an_unconfigured_store_offers_every_known_method(self, client, auth, catalogue):
        add(client, auth, "PRD001", 1)
        response = place(client, auth, paymentMethod="netbanking")
        assert response.status_code == 201, response.text

    def test_an_unknown_delivery_method_is_refused(self, client, db, ready):
        response = place(client, ready, deliveryMethod="drone")
        assert response.status_code == 422
        assert response.json()["error_code"] == "DELIVERY_METHOD_INVALID"
        assert db.query(Order).count() == 0

    def test_express_delivery_is_recorded_and_priced(self, client, db, ready):
        response = place(client, ready, deliveryMethod="express")
        assert response.status_code == 201, response.text
        order = response.json()["data"]["order"]
        assert order["deliveryMethod"] == "express"
        totals = order["totals"]
        assert totals["deliveryFee"] >= 0
        assert round(totals["subtotal"] + totals["deliveryFee"], 2) == totals["total"]
        assert order["expectedDelivery"]


class TestTheOrderPlaced:
    def test_cash_on_delivery_is_confirmed_and_owed(self, client, db, ready):
        data = place(client, ready).json()["data"]
        order = data["order"]
        assert order["status"] == "confirmed" and order["paymentStatus"] == "cod-pending"
        assert order["awaitingPayment"] is False
        assert data["paymentStatus"] == "pending" and data["gateway"] is None
        assert order["totals"]["subtotal"] == 2000 and order["totals"]["itemCount"] == 2
        assert order["totals"]["total"] == 2000  # above the free delivery threshold
        assert [e["status"] for e in order["timeline"]] == ["pending", "confirmed"]
        assert order["items"][0]["unitPrice"] == 1000 and order["items"][0]["lineTotal"] == 2000
        stored = db.get(Order, order["id"])
        assert stored.stock_state == "consumed"
        assert stock_of(db, "PRD001") == (8, 0)

    def test_a_prepaid_order_through_a_settling_provider_is_paid(self, client, db, ready):
        data = place(client, ready, paymentMethod="upi").json()["data"]
        assert data["order"]["paymentStatus"] == "paid" and data["paymentStatus"] == "paid"
        invoice = db.get(Invoice, data["invoiceId"])
        assert invoice.status == "paid" and invoice.amount_paid == invoice.grand_total
        events = [e.status for e in db.get(Payment, data["paymentId"]).events]
        assert events == ["initiated", "succeeded"]

    def test_the_email_given_at_checkout_is_the_one_on_the_order(self, client, db, ready):
        data = place(client, ready, email="asha.work@example.com").json()["data"]
        assert data["order"]["customerEmail"] == "asha.work@example.com"

    def test_a_billing_address_elsewhere_sets_the_place_of_supply(self, client, db, ready):
        billing = {**ADDRESS, "state": "Maharashtra", "city": "Mumbai", "pincode": "400001"}
        data = place(client, ready, billingAddress=billing).json()["data"]
        invoice = db.get(Invoice, data["invoiceId"])
        assert invoice.place_of_supply == "Maharashtra"
        assert invoice.igst > 0 and invoice.cgst == 0

    def test_a_matching_expected_total_goes_through(self, client, ready):
        total = client.get("/api/cart", headers=ready).json()["data"]["breakdown"]["grandTotal"]
        assert place(client, ready, expectedTotal=total).status_code == 201

    def test_a_total_that_moved_is_refused_with_the_new_figure(self, client, db, ready):
        total = client.get("/api/cart", headers=ready).json()["data"]["breakdown"]["grandTotal"]
        response = place(client, ready, expectedTotal=total - 100)
        assert response.status_code == 409
        body = response.json()
        assert body["error_code"] == "PRICE_CHANGED"
        assert body["details"]["grandTotal"] == total / 100
        assert db.query(Order).count() == 0
        assert stock_of(db, "PRD001") == (10, 0)

    def test_an_address_that_cannot_be_saved_does_not_fail_the_order(self, client, db, ready, monkeypatch):
        from app.models import Address
        from app.services import auth as auth_service

        def broken(*args, **kwargs):
            raise RuntimeError("address book unavailable")

        monkeypatch.setattr(auth_service, "create_address", broken)
        response = place(client, ready, saveAddress=True,
                         shippingAddress={**ADDRESS, "line1": "9 New Street"})
        assert response.status_code == 201, response.text
        assert db.query(Order).count() == 1
        assert db.query(Address).filter_by(line1="9 New Street").count() == 0

    def test_an_unknown_gift_card_stops_the_order(self, client, db, ready):
        response = place(client, ready, giftCardCodes=["DCZG-NOPE-NOPE-NOPE-NOPE"])
        assert response.status_code in (404, 409, 422)
        assert response.json()["success"] is False
        assert db.query(Order).count() == 0
        assert stock_of(db, "PRD001") == (10, 0)


class TestTheBagChangedUnderneath:
    def test_a_product_withdrawn_since_it_was_added(self, client, db, ready):
        db.get(Product, "PRD001").status = "draft"
        db.flush()
        response = place(client, ready)
        assert response.status_code == 409
        assert response.json()["error_code"] == "PRODUCT_UNAVAILABLE"
        assert db.query(Order).count() == 0

    def test_stock_that_ran_low_since_it_was_added(self, client, db, ready):
        db.get(Product, "PRD001").stock = 1
        db.flush()
        response = place(client, ready)
        assert response.status_code == 409
        body = response.json()
        assert body["error_code"] == "INSUFFICIENT_STOCK" and "Only 1" in body["message"]
        assert stock_of(db, "PRD001") == (1, 0)

    def test_stock_that_ran_out_since_it_was_added(self, client, db, ready):
        db.get(Product, "PRD001").stock = 0
        db.flush()
        response = place(client, ready)
        assert response.status_code == 409
        assert "sold out" in response.json()["message"]

    def test_a_broken_quantity_in_the_bag_is_refused(self, client, db, ready):
        db.query(CartItem).one().quantity = 0
        db.flush()
        response = place(client, ready)
        assert response.status_code == 422
        assert response.json()["error_code"] == "INVALID_QUANTITY"
        assert db.query(Order).count() == 0

    def test_an_empty_bag_through_the_service(self, db, customer, catalogue, settings_documents):
        from app.core.errors import ValidationError
        from app.services import orders

        with pytest.raises(ValidationError) as caught:
            orders.place_order(db, customer, shipping_address=dict(ADDRESS), billing_address=None,
                               delivery_method="standard", payment_method="cod")
        assert caught.value.error_code == "CART_EMPTY"


# ===================================================== an order the gateway holds


class TestAnOrderAwaitingTheGateway:
    def test_the_stock_is_held_not_taken(self, client, db, ready, held):
        data = place(client, ready, paymentMethod="upi").json()["data"]
        order = data["order"]
        assert order["status"] == "pending" and order["awaitingPayment"] is True
        assert order["paymentStatus"] == "pending"
        stored = db.get(Order, order["id"])
        assert stored.stock_state == "reserved" and stored.payment_expires_at is not None
        assert stock_of(db, "PRD001") == (10, 2)
        assert [e.status for e in db.get(Payment, data["paymentId"]).events] == ["initiated", "processing"]

    def test_the_portal_cannot_confirm_it_before_the_money(self, client, db, ready, held, admin_auth):
        order_id = place(client, ready, paymentMethod="upi").json()["data"]["order"]["id"]
        response = client.put(f"/api/admin/orders/{order_id}/status", headers=admin_auth,
                              json={"status": "confirmed"})
        assert response.status_code == 409
        assert response.json()["error_code"] == "AWAITING_PAYMENT"
        db.expire_all()
        assert db.get(Order, order_id).status == "pending"

    def test_one_account_cannot_hold_the_shelf(self, client, db, ready, held, monkeypatch):
        from app.core.config import settings

        monkeypatch.setattr(settings, "MAX_UNPAID_ORDERS_PER_CUSTOMER", 2)
        for _ in range(2):
            add(client, ready, "PRD001", 1)
            assert place(client, ready, paymentMethod="upi").status_code == 201
        add(client, ready, "PRD001", 1)
        response = place(client, ready, paymentMethod="upi")
        assert response.status_code == 409
        assert response.json()["error_code"] == "TOO_MANY_UNPAID_ORDERS"
        # Cash on delivery holds nothing, so it is not limited.
        assert place(client, ready, paymentMethod="cod").status_code == 201

    def test_cancelling_releases_the_hold_and_retires_every_way_to_pay(self, client, db, ready, held):
        data = place(client, ready, paymentMethod="upi").json()["data"]
        order_id = data["order"]["id"]
        payment = db.get(Payment, data["paymentId"])
        payment.payment_link_id = "plink_test_1"
        payment.events.append(PaymentEvent(status="qr-issued", note="qr_good issued", occurred_at=payment.created_at_utc))
        payment.events.append(PaymentEvent(status="qr-issued", note="bad_qr issued", occurred_at=payment.created_at_utc))
        db.flush()

        response = client.post(f"/api/orders/{order_id}/cancel", headers=ready, json={"reason": "Too slow"})
        assert response.status_code == 200, response.text
        assert response.json()["data"]["status"] == "cancelled"
        stored = db.get(Order, order_id)
        db.refresh(stored)
        assert stored.stock_state == "released"
        # Nothing ever left the shelf, so nothing is added back to it.
        assert stock_of(db, "PRD001") == (10, 0)
        assert held.cancelled_links == ["plink_test_1"]
        assert held.closed_qrs == ["qr_good"]  # the failing one is logged, not raised
        assert db.query(Refund).count() == 0

    def test_a_declined_payment_leaves_the_order_waiting(self, client, db, ready, held):
        held.status = "failed"
        data = place(client, ready, paymentMethod="card").json()["data"]
        assert data["order"]["status"] == "pending" and data["order"]["paymentStatus"] == "failed"
        events = db.get(Payment, data["paymentId"]).events
        assert [e.status for e in events] == ["initiated", "failed"]
        assert events[-1].note == "Card declined"


# ================================================================ cancelling


class TestCancellingWithMoneyCollected:
    def test_a_paid_order_is_refunded_when_cancelled(self, client, db, ready):
        data = place(client, ready, paymentMethod="upi").json()["data"]
        order_id = data["order"]["id"]
        response = client.post(f"/api/orders/{order_id}/cancel", headers=ready, json={"reason": "Ordered twice"})
        assert response.status_code == 200, response.text
        refund = db.query(Refund).one()
        assert refund.status == "completed" and refund.invoice_id == data["invoiceId"]
        assert stock_of(db, "PRD001") == (10, 0)
        # Run again: nothing more is owed, so nothing more is refunded.
        from app.services import orders

        orders.refund_if_collected(db, db.get(Order, order_id), reason="again")
        assert db.query(Refund).count() == 1

    def test_a_refund_with_no_invoice_is_a_no_op(self, db, customer, catalogue):
        from app.services import orders

        order = someone_elses_order("ORD950", "DCZ950", customer)
        db.add(order)
        db.flush()
        orders.refund_if_collected(db, order, reason="nothing")
        assert db.query(Refund).count() == 0

    def test_the_admin_cancel_puts_stock_back_and_says_who(self, client, db, ready, admin_auth):
        order_id = place(client, ready).json()["data"]["order"]["id"]
        response = client.put(f"/api/admin/orders/{order_id}/status", headers=admin_auth,
                              json={"status": "cancelled", "note": "Customer called"})
        assert response.status_code == 200
        last = response.json()["data"]["timeline"][-1]
        assert last["status"] == "cancelled" and last["by"] == "ADM001" and last["note"] == "Customer called"
        assert stock_of(db, "PRD001") == (10, 0)

    def test_cancelling_twice_does_not_restock_twice(self, client, db, ready):
        from app.services import orders

        order_id = place(client, ready).json()["data"]["order"]["id"]
        client.post(f"/api/orders/{order_id}/cancel", headers=ready, json={"reason": ""})
        orders.return_stock(db, db.get(Order, order_id), note="again")
        db.flush()
        assert stock_of(db, "PRD001") == (10, 0)

    def test_restocking_a_deleted_product_is_skipped(self, db, customer, catalogue):
        from app.models import OrderItem
        from app.services import orders

        order = someone_elses_order("ORD951", "DCZ951", customer)
        order.stock_state = "consumed"
        order.items.append(OrderItem(product_id="PRD003", name="Wireless Earbuds", quantity=2, unit_price=3000,
                                     line_total=6000))
        db.add(order)
        db.flush()
        orders.return_stock(db, order, note="Order cancelled")
        db.flush()
        product = db.get(Product, "PRD003")
        assert product.stock == 2 and product.status == "active"
        assert order.stock_state == "released"

    def test_the_customer_reason_defaults_when_blank(self, client, ready):
        order_id = place(client, ready).json()["data"]["order"]["id"]
        timeline = client.post(f"/api/orders/{order_id}/cancel", headers=ready,
                               json={"reason": ""}).json()["data"]["timeline"]
        assert timeline[-1]["note"] == "Cancelled by the customer." and timeline[-1]["by"] == "customer"


# =================================================================== reading


class TestReadingOrders:
    def test_an_order_by_its_number(self, client, ready):
        order = place(client, ready).json()["data"]["order"]
        response = client.get(f"/api/orders/{order['orderNumber']}", headers=ready)
        assert response.status_code == 200 and response.json()["data"]["id"] == order["id"]
        assert response.json()["data"]["invoiceId"]

    def test_the_list_holds_only_the_callers_orders(self, client, db, ready, other_customer):
        mine = place(client, ready).json()["data"]["order"]["id"]
        db.add(someone_elses_order("ORD952", "DCZ952", other_customer))
        db.flush()
        listed = [o["id"] for o in client.get("/api/orders", headers=ready).json()["data"]]
        assert listed == [mine]

    def test_an_admin_token_cannot_read_customer_orders(self, client, admin_auth, catalogue):
        assert client.get("/api/orders", headers=admin_auth).status_code == 403


class TestThePortal:
    def test_every_order_or_one_customers(self, client, db, ready, admin_auth, other_customer):
        mine = place(client, ready).json()["data"]["order"]["id"]
        db.add(someone_elses_order("ORD953", "DCZ953", other_customer))
        db.flush()
        everything = client.get("/api/admin/orders", headers=admin_auth)
        assert everything.status_code == 200
        assert {o["id"] for o in everything.json()["data"]} == {mine, "ORD953"}
        theirs = client.get("/api/admin/orders?customerId=CUS002", headers=admin_auth).json()["data"]
        assert [o["id"] for o in theirs] == ["ORD953"]
        assert theirs[0]["invoiceId"] is None

    def test_the_order_id_filter_matches_ids_only(self, client, db, ready, admin_auth, other_customer):
        mine = place(client, ready).json()["data"]["order"]
        db.add(someone_elses_order("ORD953", "DCZ953", other_customer))
        db.flush()

        def ids(**params):
            response = client.get("/api/admin/orders", headers=admin_auth, params=params)
            assert response.status_code == 200, response.text
            return [o["id"] for o in response.json()["data"]]

        assert ids(q="DCZ953") == ["ORD953"]
        assert ids(q="dcz953") == ["ORD953"]
        assert ids(q="ORD953") == ["ORD953"]
        assert ids(q=mine["orderNumber"]) == [mine["id"]]
        assert ids(q="DCZ953", customerId="CUS002") == ["ORD953"]
        assert ids(q="DCZ953", customerId="CUS001") == []
        # A name, an email or part of a number is not an Order ID.
        assert ids(q="Ravi") == []
        assert ids(q="someone.else@example.com") == []
        assert ids(q="DCZ95") == []
        assert len(ids(q="")) == 2

    def test_one_order_by_id_or_number(self, client, ready, admin_auth):
        order = place(client, ready).json()["data"]["order"]
        by_id = client.get(f"/api/admin/orders/{order['id']}", headers=admin_auth).json()["data"]
        by_number = client.get(f"/api/admin/orders/{order['orderNumber']}", headers=admin_auth).json()["data"]
        assert by_id["id"] == by_number["id"] == order["id"]
        assert by_id["invoiceNumber"]
        assert client.get("/api/admin/orders/ORD999", headers=admin_auth).status_code == 404

    def test_the_portal_needs_an_administrator(self, client, ready):
        assert client.get("/api/admin/orders", headers=ready).status_code in (401, 403)
        assert client.get("/api/admin/orders").status_code == 401

    def test_setting_the_same_status_records_nothing(self, client, db, ready, admin_auth):
        from app.models import AuditLog

        order_id = place(client, ready).json()["data"]["order"]["id"]
        response = client.put(f"/api/admin/orders/{order_id}/status", headers=admin_auth,
                              json={"status": "confirmed"})
        assert response.status_code == 200
        assert len(response.json()["data"]["timeline"]) == 2
        # Only the request itself is logged; no "Moved order" entry with changes.
        assert db.query(AuditLog).filter(AuditLog.summary.like("Moved order%")).count() == 0

    def test_a_move_is_audited_with_its_note(self, client, db, ready, admin_auth):
        from app.models import AuditLog

        order_id = place(client, ready).json()["data"]["order"]["id"]
        response = client.put(f"/api/admin/orders/{order_id}/status", headers=admin_auth,
                              json={"status": "packed", "note": "Rush", "confirm": True})
        assert response.status_code == 200
        assert response.json()["data"]["timeline"][-1]["note"] == "Skipped Processing. Rush"
        entry = db.query(AuditLog).filter(AuditLog.summary.like("Moved order%")).one()
        assert entry.changes == {"status": {"from": "confirmed", "to": "packed"}}

    def test_delivery_settles_cash_on_delivery_and_a_return_follows(self, client, db, ready, admin_auth):
        order_id = place(client, ready).json()["data"]["order"]["id"]
        moved = client.put(f"/api/admin/orders/{order_id}/status", headers=admin_auth,
                           json={"status": "delivered", "confirm": True})
        assert moved.status_code == 200
        assert moved.json()["data"]["paymentStatus"] == "paid"
        returned = client.put(f"/api/admin/orders/{order_id}/status", headers=admin_auth,
                              json={"status": "returned"})
        assert returned.status_code == 200 and returned.json()["data"]["status"] == "returned"
        again = client.put(f"/api/admin/orders/{order_id}/status", headers=admin_auth,
                           json={"status": "processing", "confirm": True})
        assert again.status_code == 409 and again.json()["error_code"] == "INVALID_TRANSITION"

    def test_a_role_without_orders_cannot_move_one(self, client, db, ready, editor):
        order_id = place(client, ready).json()["data"]["order"]["id"]
        token = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"}
                            ).json()["data"]["token"]["accessToken"]
        response = client.put(f"/api/admin/orders/{order_id}/status",
                              headers={"Authorization": f"Bearer {token}"}, json={"status": "processing"})
        assert response.status_code == 403
        db.expire_all()
        assert db.get(Order, order_id).status == "confirmed"

    def test_a_payment_link_needs_a_payment_record(self, client, db, admin_auth, customer, catalogue):
        db.add(someone_elses_order("ORD954", "DCZ954", customer))
        db.flush()
        response = client.post("/api/admin/orders/ORD954/payment-link", headers=admin_auth)
        assert response.status_code == 404
        assert response.json()["error_code"] == "PAYMENT_NOT_FOUND"

    def test_a_payment_link_needs_a_live_gateway(self, client, ready, admin_auth):
        order_id = place(client, ready).json()["data"]["order"]["id"]
        response = client.post(f"/api/admin/orders/{order_id}/payment-link", headers=admin_auth)
        assert response.status_code == 409
        assert response.json()["error_code"] == "PROVIDER_UNSUPPORTED"

    def test_a_paid_order_needs_no_payment_link(self, client, ready, admin_auth):
        order_id = place(client, ready, paymentMethod="upi").json()["data"]["order"]["id"]
        response = client.post(f"/api/admin/orders/{order_id}/payment-link", headers=admin_auth)
        assert response.status_code == 409 and response.json()["error_code"] == "ALREADY_PAID"

    def test_a_payment_link_for_an_unknown_order(self, client, admin_auth, catalogue):
        assert client.post("/api/admin/orders/ORD999/payment-link", headers=admin_auth).status_code == 404


class TestTheTimelineIsTheRecord:
    def test_each_move_adds_one_event(self, client, db, ready, admin_auth):
        order_id = place(client, ready).json()["data"]["order"]["id"]
        for status in ("processing", "packed", "shipped"):
            assert client.put(f"/api/admin/orders/{order_id}/status", headers=admin_auth,
                              json={"status": status}).status_code == 200
        statuses = [e.status for e in db.query(OrderEvent).filter_by(order_id=order_id).order_by(OrderEvent.id)]
        assert statuses == ["pending", "confirmed", "processing", "packed", "shipped"]
        # Shipped: the customer can no longer cancel.
        response = client.post(f"/api/orders/{order_id}/cancel", headers=ready, json={"reason": ""})
        assert response.status_code == 409 and response.json()["error_code"] == "ORDER_NOT_CANCELLABLE"
