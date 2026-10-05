"""
Placing an order.

This is the transaction the whole backend exists for: the order, the stock, the
invoice, the payment and the coupon usage all move together or none of them do.
The tests that matter here are the ones about *atomicity* and about what the
client is not allowed to decide.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from tests.integration.fulfilment_helpers import advance  # noqa: E402

pytestmark = pytest.mark.integration


ADDRESS = {
    "fullName": "Asha Rao", "phone": "9876500001", "line1": "4 Brigade Road",
    "line2": "", "city": "Bengaluru", "state": "Karnataka", "pincode": "560001",
    "country": "India", "email": "shopper@example.com",
}


def place(client, auth, **overrides):
    payload = {
        "shippingAddress": ADDRESS,
        "billingAddress": None,
        "deliveryMethod": "standard",
        "paymentMethod": "cod",
        "couponCode": None,
        "email": "shopper@example.com",
        "saveAddress": False,
    }
    payload.update(overrides)
    return client.post("/api/orders", headers=auth, json=payload)


def add(client, auth, product_id="PRD001", quantity=1):
    return client.post("/api/cart/items", headers=auth,
                       json={"productId": product_id, "quantity": quantity})


def someone_elses_order(order_id: str, number: str, owner):
    """An order belonging to another account, for the "can I read it?" tests."""
    from datetime import datetime

    from app.models import Order

    return Order(
        id=order_id, order_number=number, customer_id=owner.id,
        customer_name="Ravi Nair", customer_email=owner.email,
        placed_at=datetime.utcnow(),
        status="confirmed", payment_method="cod", payment_status="pending",
        delivery_method="standard",
        shipping_name=ADDRESS["fullName"], shipping_phone=ADDRESS["phone"],
        shipping_line1=ADDRESS["line1"], shipping_city=ADDRESS["city"],
        shipping_state=ADDRESS["state"], shipping_pincode=ADDRESS["pincode"],
        item_count=1, subtotal=1000, total=1000,
    )


@pytest.fixture()
def ready(client, auth, catalogue, settings_documents):
    """A signed-in customer with something in the bag."""
    add(client, auth, "PRD001", 2)
    return auth


class TestPlacingAnOrder:
    def test_creates_the_order_the_invoice_and_the_payment_together(self, client, ready):
        response = place(client, ready)
        assert response.status_code == 201, response.text

        data = response.json()["data"]
        assert data["order"]["orderNumber"]
        assert data["invoiceNumber"]
        assert data["paymentId"]

    def test_the_ids_follow_the_house_scheme(self, client, ready):
        data = place(client, ready).json()["data"]
        assert data["order"]["id"].startswith("ORD")
        assert data["invoiceId"].startswith("INV")
        assert data["paymentId"].startswith("PAY")

    def test_the_cart_is_emptied(self, client, ready):
        place(client, ready)
        assert client.get("/api/cart", headers=ready).json()["data"]["items"] == []

    def test_the_stock_is_taken(self, client, ready, db, catalogue):
        from app.models import Product

        place(client, ready)
        db.expire_all()
        assert db.get(Product, "PRD001").stock == 8  # ten, less the two bought

    def test_an_empty_cart_cannot_be_ordered(self, client, auth, catalogue, settings_documents):
        response = place(client, auth)
        assert response.status_code in (409, 422)
        assert response.json()["success"] is False

    def test_ordering_needs_an_account(self, client):
        assert place(client, {}).status_code == 401

    def test_the_invoice_total_equals_the_order_total(self, client, ready):
        """
        The order carries rupees and the invoice carries paise.

        Two units for the same number is a thing to watch rather than a thing
        to fix — the catalogue prices in rupees and billing is exact in minor
        units — so the conversion is asserted rather than assumed.
        """
        data = place(client, ready).json()["data"]

        invoice = client.get(f"/api/invoices/{data['invoiceId']}",
                             headers=ready).json()["data"]

        assert invoice["breakdown"]["grandTotal"] == round(data["order"]["totals"]["total"] * 100)

    def test_the_invoice_lines_reconcile_with_its_total(self, client, ready):
        data = place(client, ready).json()["data"]
        invoice = client.get(f"/api/invoices/{data['invoiceId']}",
                             headers=ready).json()["data"]

        breakdown = invoice["breakdown"]
        lines = sum(line["lineTotal"] for line in invoice["lines"])
        expected = lines + breakdown["shipping"] + breakdown["otherCharges"]

        assert expected == breakdown["grandTotal"]

    def test_the_line_taxes_sum_to_the_invoice_tax(self, client, ready):
        """
        The coupon is apportioned across lines before tax, using `allocate`.

        If the parts did not sum back exactly, the line taxes would not
        reconcile with the invoice total — the error an auditor finds first.
        """
        data = place(client, ready).json()["data"]
        invoice = client.get(f"/api/invoices/{data['invoiceId']}",
                             headers=ready).json()["data"]

        assert sum(line["tax"] for line in invoice["lines"]) == invoice["breakdown"]["tax"]["totalTax"]


class TestWhatTheClientCannotDecide:
    def test_a_total_sent_by_the_client_is_ignored(self, client, ready):
        """
        The server prices the cart it holds.

        Nothing in the payload names a price, and a payload that tries to must
        change nothing — this is the test that says so out loud.
        """
        honest = place(client, ready).json()["data"]["order"]["totals"]["total"]

        add(client, ready, "PRD001", 2)
        cheeky = place(client, ready, total=1, grandTotal=1, subtotal=1).json()
        assert cheeky["data"]["order"]["totals"]["total"] == honest

    def test_an_unknown_coupon_stops_the_order_rather_than_being_ignored(self, client, ready):
        """
        Refused, not silently dropped.

        Somebody who typed a code and saw a discount must not be charged full
        price with no explanation — and the order is the last point at which
        the two can be reconciled, so it is the point that says no.
        """
        response = place(client, ready, couponCode="FREEMONEY")

        assert response.status_code == 422
        assert response.json()["error_code"] == "COUPON_INVALID"

    def test_a_refused_coupon_leaves_the_cart_intact(self, client, ready):
        """The whole thing rolls back — nothing half-placed, nothing half-taken."""
        place(client, ready, couponCode="FREEMONEY")

        assert client.get("/api/cart", headers=ready).json()["data"]["items"]
        assert client.get("/api/orders", headers=ready).json()["data"] == []

    def test_a_real_coupon_is_applied_by_the_server(self, client, ready, coupon):
        plain = place(client, ready).json()["data"]["order"]["totals"]["total"]

        add(client, ready, "PRD001", 2)
        discounted = place(client, ready, couponCode="SAVE10")
        assert discounted.json()["data"]["order"]["totals"]["total"] < plain

    def test_the_status_starts_where_the_server_says(self, client, ready):
        response = place(client, ready, status="delivered")
        assert response.json()["data"]["order"]["status"] != "delivered"


class TestReadingOrders:
    def test_history_is_the_callers_own(self, client, ready):
        place(client, ready)
        response = client.get("/api/orders", headers=ready)
        assert response.status_code == 200
        assert len(response.json()["data"]) == 1

    def test_by_id(self, client, ready):
        order_id = place(client, ready).json()["data"]["order"]["id"]
        assert client.get(f"/api/orders/{order_id}", headers=ready).status_code == 200

    def test_cannot_read_somebody_elses_order(self, client, ready, db, other_customer):
        """
        404, not 403.

        Confirming that an order exists but is not yours is still telling
        somebody it exists.
        """
        db.add(someone_elses_order("ORD900", "DCZ19900", other_customer))
        db.flush()

        assert client.get("/api/orders/ORD900", headers=ready).status_code == 404

    def test_an_unknown_order(self, client, ready):
        assert client.get("/api/orders/ORD999", headers=ready).status_code == 404


class TestCancelling:
    def test_a_new_order_can_be_cancelled(self, client, ready):
        order_id = place(client, ready).json()["data"]["order"]["id"]
        response = client.post(f"/api/orders/{order_id}/cancel", headers=ready, json={"reason": "Changed my mind"})
        assert response.status_code == 200
        assert response.json()["data"]["status"] == "cancelled"

    def test_cancelling_puts_the_stock_back(self, client, ready, db):
        from app.models import Product

        order_id = place(client, ready).json()["data"]["order"]["id"]
        client.post(f"/api/orders/{order_id}/cancel", headers=ready, json={"reason": "Changed my mind"})

        db.expire_all()
        assert db.get(Product, "PRD001").stock == 10

    def test_an_unpaid_invoice_is_voided_with_its_order(self, client, ready, db):
        from app.models import Invoice

        placed = place(client, ready).json()["data"]
        client.post(f"/api/orders/{placed['order']['id']}/cancel", headers=ready, json={"reason": ""})
        db.expire_all()
        assert db.get(Invoice, placed["invoiceId"]).status == "cancelled"

    def test_a_delivered_order_cannot_be_cancelled(self, client, ready, db):
        from app.models import Order

        order_id = place(client, ready).json()["data"]["order"]["id"]
        db.get(Order, order_id).status = "delivered"
        db.flush()

        response = client.post(f"/api/orders/{order_id}/cancel", headers=ready, json={"reason": "Changed my mind"})
        assert response.status_code in (409, 422)

    def test_cannot_cancel_somebody_elses_order(self, client, ready, db, other_customer):
        db.add(someone_elses_order("ORD901", "DCZ19901", other_customer))
        db.flush()

        assert client.post("/api/orders/ORD901/cancel", headers=ready, json={"reason": ""}).status_code == 404


class TestTheFulfilmentPipeline:
    """
    The order status endpoint confirms, cancels and records a return to
    origin. Every other stage belongs to packing or a shipment, and nothing
    can be skipped or reversed by asking, `confirm` or not
    (docs/order-fulfilment.md).
    """

    def _move(self, client, admin_auth, order_id, status, confirm=False, reason=""):
        return client.put(
            f"/api/admin/orders/{order_id}/status",
            headers=admin_auth,
            json={"status": status, "note": "", "confirm": confirm, "reason": reason},
        )

    @pytest.fixture()
    def order_id(self, client, ready):
        # Cash on delivery: confirmed on placement.
        return place(client, ready).json()["data"]["order"]["id"]

    def test_the_real_flow_reaches_every_stage_in_order(self, client, admin_auth, order_id):
        seen = []
        for status in ("processing", "packed", "shipped", "in-transit", "out-for-delivery", "delivered"):
            advance(client, admin_auth, order_id, status)
            seen.append(client.get(f"/api/admin/orders/{order_id}", headers=admin_auth).json()["data"]["status"])
        assert seen == ["processing", "packed", "shipped", "in-transit", "out-for-delivery", "delivered"]

    @pytest.mark.parametrize("target", ["processing", "packed", "shipped", "in-transit", "out-for-delivery",
                                        "delivered"])
    def test_no_stage_can_be_typed_in(self, client, admin_auth, order_id, target):
        for confirm in (False, True):
            response = self._move(client, admin_auth, order_id, target, confirm=confirm)
            assert response.status_code == 409, target
            assert response.json()["error_code"] in ("WORKFLOW_OWNED", "INVALID_TRANSITION")

    def test_confirmed_to_delivered_says_why(self, client, admin_auth, order_id):
        response = self._move(client, admin_auth, order_id, "delivered", confirm=True)
        assert response.json()["message"].startswith("Order cannot be moved directly from Confirmed to Delivered")

    def test_a_shipped_order_is_moved_by_its_shipment(self, client, admin_auth, order_id):
        advance(client, admin_auth, order_id, "packed")
        response = self._move(client, admin_auth, order_id, "shipped")
        assert response.status_code == 409 and response.json()["error_code"] == "WORKFLOW_OWNED"
        assert "create the shipment" in response.json()["message"]

    @pytest.mark.parametrize(
        ("reach", "target"),
        [
            ("processing", "pending"),  # only a payment leaves pending
            ("shipped", "cancelled"),  # dispatched: a return
            ("processing", "returned"),  # never dispatched: a cancellation
            ("packed", "confirmed"),  # backwards
        ],
    )
    def test_moves_that_are_never_allowed(self, client, admin_auth, order_id, reach, target):
        advance(client, admin_auth, order_id, reach)
        response = self._move(client, admin_auth, order_id, target, confirm=True, reason="Because")
        assert response.status_code == 409
        assert response.json()["error_code"] in ("INVALID_TRANSITION", "ORDER_NOT_CANCELLABLE")

    def test_cancelling_after_picking_needs_a_reason(self, client, admin_auth, order_id):
        advance(client, admin_auth, order_id, "processing")
        refused = self._move(client, admin_auth, order_id, "cancelled")
        assert refused.status_code == 422 and refused.json()["error_code"] == "REASON_REQUIRED"
        done = self._move(client, admin_auth, order_id, "cancelled", reason="Out of stock on the shelf")
        assert done.status_code == 200 and done.json()["data"]["status"] == "cancelled"

    def test_a_booked_shipment_blocks_cancelling(self, client, admin_auth, order_id):
        advance(client, admin_auth, order_id, "packed")
        from tests.integration.fulfilment_helpers import _shipment

        _shipment(client, admin_auth, order_id)
        response = self._move(client, admin_auth, order_id, "cancelled", reason="Changed mind")
        assert response.status_code == 409 and response.json()["error_code"] == "SHIPMENT_ACTIVE"

    def test_a_delivered_order_cannot_go_back_or_be_cancelled(self, client, admin_auth, order_id):
        advance(client, admin_auth, order_id, "delivered")
        assert self._move(client, admin_auth, order_id, "shipped", confirm=True).status_code == 409
        cancel = self._move(client, admin_auth, order_id, "cancelled", reason="Too late")
        assert cancel.status_code == 409 and cancel.json()["error_code"] == "ORDER_NOT_CANCELLABLE"
        # Items coming back after delivery are a return request, not a status.
        assert self._move(client, admin_auth, order_id, "returned", reason="Sent back").status_code == 409

    def test_a_return_to_origin_closes_the_order_and_restocks(self, client, admin_auth, order_id, db):
        from app.models import Order, Product

        before = db.get(Product, "PRD001").stock
        units = sum(item.quantity for item in db.get(Order, order_id).items if item.product_id == "PRD001")
        advance(client, admin_auth, order_id, "returned")
        db.expire_all()
        order = db.get(Order, order_id)
        assert order.status == "returned" and order.stock_state == "released"
        assert db.get(Product, "PRD001").stock == before + units

    def test_a_finished_order_is_final(self, client, admin_auth, order_id):
        self._move(client, admin_auth, order_id, "cancelled")
        response = self._move(client, admin_auth, order_id, "confirmed", confirm=True)
        assert response.status_code == 409

    def test_the_customer_can_cancel_only_before_picking(self, client, admin_auth, ready, order_id):
        advance(client, admin_auth, order_id, "processing")
        response = client.post(f"/api/orders/{order_id}/cancel", headers=ready, json={"reason": ""})
        assert response.status_code == 409 and response.json()["error_code"] == "ORDER_NOT_CANCELLABLE"

    def test_every_change_is_recorded_with_where_it_came_from(self, client, admin_auth, order_id, db):
        from app.models import OrderEvent

        advance(client, admin_auth, order_id, "shipped")
        rows = db.execute(select(OrderEvent).where(OrderEvent.order_id == order_id, OrderEvent.source != "")
                          .order_by(OrderEvent.id)).scalars().all()
        assert [(r.from_status, r.status, r.source) for r in rows] == [
            ("confirmed", "processing", "packing"), ("processing", "packed", "packing"),
            ("packed", "shipped", "shipment")]

    def test_an_unknown_status_is_refused(self, client, admin_auth, order_id):
        response = self._move(client, admin_auth, order_id, "teleported", confirm=True)
        assert response.status_code == 422


class TestSavedAddresses:
    """Checkout saves the address it shipped to — once, not once per order."""

    def test_ordering_twice_to_the_same_address_saves_it_once(self, client, auth, catalogue, settings_documents):
        for _ in range(2):
            add(client, auth, "PRD001", 1)
            assert place(client, auth, saveAddress=True).status_code == 201
        saved = client.get("/api/account/addresses", headers=auth).json()["data"]
        assert len(saved) == 1

    def test_the_same_address_written_differently_is_still_the_same(self, client, auth, catalogue, settings_documents):
        add(client, auth, "PRD001", 1)
        place(client, auth, saveAddress=True)
        add(client, auth, "PRD001", 1)
        shouty = {**ADDRESS, "line1": "  4, BRIGADE road ", "city": "bengaluru", "phone": "+91 98765 00001"}
        place(client, auth, saveAddress=True, shippingAddress=shouty)
        assert len(client.get("/api/account/addresses", headers=auth).json()["data"]) == 1

    def test_a_different_address_is_saved(self, client, auth, catalogue, settings_documents):
        add(client, auth, "PRD001", 1)
        place(client, auth, saveAddress=True)
        add(client, auth, "PRD001", 1)
        place(client, auth, saveAddress=True, shippingAddress={**ADDRESS, "line1": "9 MG Road"})
        assert len(client.get("/api/account/addresses", headers=auth).json()["data"]) == 2
