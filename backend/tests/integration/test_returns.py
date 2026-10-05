"""
Returns and replacements after delivery.

Who may ask, for which items, within what window — and what each step does to
stock and money.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from tests.integration.test_orders import ADDRESS, add, place
from tests.integration.fulfilment_helpers import advance

pytestmark = pytest.mark.integration


@pytest.fixture()
def other_customer_auth(client, other_customer):
    from tests.conftest import PASSWORD

    response = client.post(
        "/api/auth/login", json={"email": other_customer.email, "password": PASSWORD}
    )
    return {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}


@pytest.fixture()
def delivered(client, auth, admin_auth, catalogue, settings_documents):
    """A cash-on-delivery order for 2 × PRD001, delivered (and so paid)."""
    add(client, auth, "PRD001", 2)
    order = place(client, auth).json()["data"]["order"]
    advance(client, admin_auth, order["id"], "delivered")
    response = client.get(f"/api/admin/orders/{order['id']}", headers=admin_auth)
    assert response.status_code == 200, response.text
    return order


def options(client, auth, order):
    return client.get(f"/api/orders/{order['id']}/returns", headers=auth).json()["data"]


def ask(client, auth, order, kind="return", quantity=1, reason=None):
    item = options(client, auth, order)["eligibility"]["items"][0]
    return client.post(
        f"/api/orders/{order['id']}/returns",
        headers=auth,
        json={
            "kind": kind,
            "reason": reason
            or ("Size or fit isn't right" if kind == "return" else "Arrived damaged or defective"),
            "comment": "",
            "items": [{"orderItemId": item["orderItemId"], "quantity": quantity}],
        },
    )


def move(client, admin_auth, request_id, status, note=""):
    return client.put(
        f"/api/admin/returns/{request_id}/status",
        headers=admin_auth,
        json={"status": status, "note": note},
    )


class TestWhoMayAsk:
    def test_a_delivered_order_can_be_returned(self, client, auth, delivered):
        eligibility = options(client, auth, delivered)["eligibility"]
        assert eligibility["eligible"] is True
        assert eligibility["items"][0]["available"] == 2
        assert eligibility["items"][0]["returnable"] is True

    def test_an_order_not_yet_delivered_cannot(self, client, auth, catalogue, settings_documents):
        add(client, auth, "PRD001", 1)
        order = place(client, auth).json()["data"]["order"]
        assert options(client, auth, order)["eligibility"]["eligible"] is False
        assert ask(client, auth, order).status_code == 409

    def test_the_window_closes(self, client, auth, delivered, db):
        from app.models import Order

        for event in db.get(Order, delivered["id"]).events:
            if event.status == "delivered":
                event.occurred_at = datetime.utcnow() - timedelta(days=16)
        db.flush()
        eligibility = options(client, auth, delivered)["eligibility"]
        assert eligibility["eligible"] is False
        assert "window" in eligibility["reason"]
        assert ask(client, auth, delivered).status_code == 409

    def test_a_non_returnable_item_cannot_be_returned_but_can_be_replaced(self, client, auth, delivered, db):
        from app.models import OrderItem

        for item in db.query(OrderItem).filter(OrderItem.order_id == delivered["id"]):
            item.is_returnable = False
        db.flush()
        assert ask(client, auth, delivered, "return").status_code == 409
        assert ask(client, auth, delivered, "replacement").status_code == 201

    def test_the_policy_is_the_one_bought_under(self, client, auth, admin_auth, catalogue, settings_documents):
        # Made non-returnable *after* the purchase: the customer keeps the right.
        add(client, auth, "PRD001", 1)
        order = place(client, auth).json()["data"]["order"]
        client.put("/api/products/PRD001", headers=admin_auth, json={"isReturnable": False})
        advance(client, admin_auth, order["id"], "delivered")
        assert ask(client, auth, order).status_code == 201

    def test_new_orders_carry_the_new_policy(self, client, auth, admin_auth, catalogue, settings_documents):
        client.put("/api/products/PRD001", headers=admin_auth, json={"isReturnable": False})
        assert client.get("/api/products/PRD001").json()["data"]["isReturnable"] is False
        add(client, auth, "PRD001", 1)
        order = place(client, auth).json()["data"]["order"]
        assert order["items"][0]["isReturnable"] is False

    def test_no_more_units_than_were_bought(self, client, auth, delivered):
        assert ask(client, auth, delivered, quantity=3).status_code == 422
        assert ask(client, auth, delivered, quantity=2).status_code == 201
        # Everything is now claimed.
        assert ask(client, auth, delivered, quantity=1).status_code == 409

    def test_the_reason_must_be_one_offered(self, client, auth, delivered):
        assert ask(client, auth, delivered, reason="Because I said so").status_code == 422

    def test_nobody_else_can_see_or_ask(self, client, delivered, other_customer_auth):
        assert client.get(f"/api/orders/{delivered['id']}/returns", headers=other_customer_auth).status_code == 404


class TestAReturn:
    def test_the_whole_way_to_a_refund(self, client, auth, admin_auth, delivered, db):
        from app.models import Payment, Product, Refund

        request = ask(client, auth, delivered, quantity=1).json()["data"]
        assert request["status"] == "requested" and request["amount"] > 0

        assert move(client, admin_auth, request["id"], "approved", "Pickup tomorrow").status_code == 200
        assert move(client, admin_auth, request["id"], "picked-up").status_code == 200

        db.expire_all()
        before = db.get(Product, "PRD001").stock
        assert move(client, admin_auth, request["id"], "received").status_code == 200
        db.expire_all()
        assert db.get(Product, "PRD001").stock == before + 1  # restocked

        refunded = move(client, admin_auth, request["id"], "refunded")
        assert refunded.status_code == 200, refunded.text
        data = refunded.json()["data"]
        assert data["status"] == "refunded" and data["refundId"]

        db.expire_all()
        refund = db.get(Refund, data["refundId"])
        assert refund.amount == request["amount"]
        assert refund.status == "completed"  # cash order: paid back directly
        payment = db.query(Payment).filter(Payment.order_id == delivered["id"]).one()
        assert payment.refunded_amount == request["amount"]

    def test_steps_cannot_be_skipped(self, client, auth, admin_auth, delivered):
        request = ask(client, auth, delivered).json()["data"]
        assert move(client, admin_auth, request["id"], "refunded").status_code == 409

    def test_a_rejected_request_frees_its_items(self, client, auth, admin_auth, delivered):
        request = ask(client, auth, delivered, quantity=2).json()["data"]
        move(client, admin_auth, request["id"], "rejected", "Item shows signs of wear")
        assert options(client, auth, delivered)["eligibility"]["items"][0]["available"] == 2

    def test_the_customer_can_withdraw_until_it_is_processed(self, client, auth, admin_auth, delivered):
        first = ask(client, auth, delivered).json()["data"]
        assert client.post(f"/api/returns/{first['id']}/cancel", headers=auth).status_code == 200

        second = ask(client, auth, delivered).json()["data"]
        move(client, admin_auth, second["id"], "approved")
        assert client.post(f"/api/returns/{second['id']}/cancel", headers=auth).status_code == 409


class TestAReplacement:
    def test_the_whole_way_to_a_new_item(self, client, auth, admin_auth, delivered, db):
        from app.models import Product

        request = ask(client, auth, delivered, "replacement").json()["data"]
        for status in ("approved", "received"):
            assert move(client, admin_auth, request["id"], status).status_code == 200

        db.expire_all()
        before = db.get(Product, "PRD001").stock
        shipped = move(client, admin_auth, request["id"], "replacement-shipped")
        assert shipped.status_code == 200, shipped.text
        db.expire_all()
        assert db.get(Product, "PRD001").stock == before - 1  # the new unit
        assert move(client, admin_auth, request["id"], "completed").status_code == 200

    def test_a_replacement_is_never_refunded(self, client, auth, admin_auth, delivered):
        request = ask(client, auth, delivered, "replacement").json()["data"]
        move(client, admin_auth, request["id"], "approved")
        move(client, admin_auth, request["id"], "received")
        assert move(client, admin_auth, request["id"], "refunded").status_code == 409


class TestTheStoreSide:
    def test_only_staff_see_every_request(self, client, auth, admin_auth, delivered):
        ask(client, auth, delivered)
        assert client.get("/api/admin/returns", headers=auth).status_code in (401, 403)
        listed = client.get("/api/admin/returns", headers=admin_auth).json()["data"]
        assert len(listed) == 1 and listed[0]["nextSteps"] == ["approved", "rejected", "cancelled"]


class TestFindingByID:
    """`q` is a Return ID or the order's number/ID and `customer` a Customer ID — exact, never a name."""

    @pytest.fixture()
    def two(self, client, auth, admin_auth, delivered):
        add(client, auth, "PRD002", 1)
        second = place(client, auth).json()["data"]["order"]
        advance(client, admin_auth, second["id"], "delivered")
        first_request = ask(client, auth, delivered).json()["data"]
        second_request = ask(client, auth, second).json()["data"]
        return (delivered, first_request), (second, second_request)

    def _ids(self, client, admin_auth, **params):
        response = client.get("/api/admin/returns", headers=admin_auth, params=params)
        assert response.status_code == 200, response.text
        return sorted(r["id"] for r in response.json()["data"])

    def test_by_return_id_exactly(self, client, admin_auth, two):
        (_, first), (_, second) = two
        assert self._ids(client, admin_auth, q=first["id"]) == [first["id"]]
        assert self._ids(client, admin_auth, q=f" {second['id'].lower()} ") == [second["id"]]

    def test_a_partial_return_id_is_not_a_match(self, client, admin_auth, two):
        (_, first), _ = two
        assert self._ids(client, admin_auth, q=first["id"][:-1]) == []

    def test_by_the_orders_number_or_id(self, client, admin_auth, two):
        _, (order, request) = two
        assert self._ids(client, admin_auth, q=order["orderNumber"]) == [request["id"]]
        assert self._ids(client, admin_auth, q=order["id"]) == [request["id"]]

    def test_by_customer_id(self, client, admin_auth, two, customer):
        (_, first), (_, second) = two
        assert self._ids(client, admin_auth, customer=customer.id) == sorted([first["id"], second["id"]])
        assert self._ids(client, admin_auth, customer="CUS999") == []
        assert self._ids(client, admin_auth, customer=customer.email) == []

    @pytest.mark.parametrize("junk", ["Asha", "Cotton Kurta", "shopper@example.com", "'; DROP TABLE return_requests; --", "%"])
    def test_names_and_junk_match_nothing(self, client, admin_auth, two, junk):
        assert self._ids(client, admin_auth, q=junk) == []

    def test_filters_combine_with_status(self, client, admin_auth, two):
        (_, first), _ = two
        assert self._ids(client, admin_auth, q=first["id"], status="requested") == [first["id"]]
        assert self._ids(client, admin_auth, q=first["id"], status="refunded") == []
