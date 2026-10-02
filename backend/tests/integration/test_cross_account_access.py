"""
One customer can never reach another's records by knowing (or guessing) an id.

The victim builds real records through the API: an address, a paid order with
its invoice and payment, a cart line, an alert, a gift card purchase, a return
and a support ticket. A second, fully signed-in customer then tries every route
that takes one of those ids. Each attempt must be refused (403 or 404, never
200), must not reveal the record, and must leave it exactly as it was.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.core import rate_limit
from app.core.security import create_access_token

pytestmark = pytest.mark.integration

ADDRESS = {"fullName": "Asha Rao", "phone": "9876500001", "line1": "4 Brigade Road", "line2": "",
           "city": "Bengaluru", "state": "Karnataka", "pincode": "560001", "country": "India"}


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def attacker(other_customer):
    return {"Authorization": "Bearer " + create_access_token(other_customer.id, actor="customer")}


@pytest.fixture()
def victim(client, db, auth, catalogue, settings_documents):
    """Everything the victim owns, built the way a shopper would build it."""
    from app.models import Order, OrderEvent

    owned = {"address": "ADR001"}

    # An order, paid on the spot by the mock gateway: order, invoice, payment.
    assert client.post("/api/cart/items", headers=auth, json={"productId": "PRD001", "quantity": 1}).status_code == 201
    placed = client.post("/api/orders", headers=auth, json={
        "shippingAddress": ADDRESS, "deliveryMethod": "standard", "paymentMethod": "upi"})
    assert placed.status_code == 201, placed.text
    data = placed.json()["data"]
    owned.update(order=data["order"]["id"], order_number=data["order"]["orderNumber"],
                 invoice=data.get("invoiceId") or data["order"].get("invoiceId"), payment=data.get("paymentId"))

    # Delivered, so a return can be requested against it.
    order = db.get(Order, owned["order"])
    order.status = "delivered"
    order.events.append(OrderEvent(status="delivered", note="", actor="system",
                                   occurred_at=datetime.utcnow() - timedelta(days=1)))
    db.flush()
    item_id = order.items[0].id
    ret = client.post(f"/api/orders/{order.id}/returns", headers=auth, json={
        "kind": "return", "reason": "Size or fit isn't right", "items": [{"orderItemId": item_id, "quantity": 1}]})
    assert ret.status_code == 201, ret.text
    owned["return"] = ret.json()["data"]["id"]

    # A cart line and a stock alert.
    line = client.post("/api/cart/items", headers=auth, json={"productId": "PRD002", "quantity": 1})
    owned["cart_item"] = next(i["id"] for i in line.json()["data"]["items"] if i["productId"] == "PRD002")
    alert = client.post("/api/alerts/stock", headers=auth, json={"productId": "PRD003"})
    assert alert.status_code == 201, alert.text
    owned["alert"] = alert.json()["data"]["id"]

    # A gift card purchase.
    card = client.post("/api/gift-cards/purchase", headers=auth, json={
        "amount": 500, "recipientName": "Ravi", "recipientEmail": "ravi@example.com"})
    assert card.status_code == 201, card.text
    owned["gift_card"] = card.json()["data"]["giftCard"]["id"]
    return owned


@pytest.fixture()
def ticket(client, auth, db):
    from app.support_defaults import install
    from tests.integration.test_support import raise_ticket

    install(db.connection())
    db.flush()
    response = raise_ticket(client, auth, "Orders", "Order Status")
    assert response.status_code == 201, response.text
    return response.json()["data"]["ticket"]["number"]


def _refused(response):
    assert response.status_code in (403, 404), f"{response.status_code}: {response.text[:300]}"
    assert response.json()["success"] is False


# ------------------------------------------------------------------ reads


READS = [
    ("GET", "/api/orders/{order}"),
    ("GET", "/api/orders/{order_number}"),
    ("GET", "/api/orders/{order}/returns"),
    ("GET", "/api/orders/{order}/reorder"),
    ("GET", "/api/invoices/{invoice}"),
    ("GET", "/api/payments/{payment}/session"),
]


@pytest.mark.parametrize("method, template", READS, ids=[t for _, t in READS])
def test_another_customers_records_cannot_be_read(client, victim, attacker, method, template):
    url = template.format(**victim)
    response = client.request(method, url, headers=attacker)
    _refused(response)
    # Nothing about the victim leaks into the refusal. (The id the attacker sent
    # may be echoed back; that tells them nothing they didn't know.)
    for secret in ("Brigade", "Asha", "shopper@example.com", "9876500001"):
        assert secret not in response.text


def test_the_owner_can_read_them(client, victim, auth):
    """The control: the same requests succeed for the person they belong to."""
    for method, template in READS[:5]:
        assert client.request(method, template.format(**victim), headers=auth).status_code == 200, template


# ----------------------------------------------------------------- writes


WRITES = [
    ("PUT", "/api/account/addresses/{address}", {**ADDRESS, "fullName": "Hijacked"}),
    ("DELETE", "/api/account/addresses/{address}", None),
    ("PUT", "/api/cart/items/{cart_item}", {"quantity": 5}),
    ("DELETE", "/api/cart/items/{cart_item}", None),
    ("DELETE", "/api/alerts/stock/{alert}", None),
    ("POST", "/api/orders/{order}/cancel", {"reason": "not mine"}),
    ("POST", "/api/orders/{order}/returns", {"kind": "return", "reason": "x", "items": [{"orderItemId": 1, "quantity": 1}]}),
    ("POST", "/api/orders/{order}/reorder", {}),
    ("POST", "/api/returns/{return}/cancel", {}),
    ("POST", "/api/gift-cards/{gift_card}/abandon", {}),
    ("POST", "/api/gift-cards/{gift_card}/verify", {"razorpayPaymentId": "pay_x", "razorpayOrderId": "order_x",
                                                     "razorpaySignature": "sig"}),
    ("POST", "/api/payments/{payment}/verify", {"razorpayPaymentId": "pay_x", "razorpayOrderId": "order_x",
                                                "razorpaySignature": "sig"}),
    ("POST", "/api/payments/{payment}/qr", {}),
]


def _snapshot(db, victim):
    from app.models import Address, CartItem, GiftCard, Order, ReturnRequest, StockAlert

    db.expire_all()
    return (
        db.get(Address, victim["address"]).full_name,
        db.get(CartItem, victim["cart_item"]).quantity,
        db.get(StockAlert, victim["alert"]).status,
        db.get(Order, victim["order"]).status,
        db.get(ReturnRequest, victim["return"]).status,
        db.get(GiftCard, victim["gift_card"]).status,
    )


@pytest.mark.parametrize("method, template, body", WRITES, ids=[f"{m} {t}" for m, t, _ in WRITES])
def test_another_customers_records_cannot_be_changed(client, db, victim, attacker, method, template, body):
    before = _snapshot(db, victim)
    kwargs = {"json": body} if body is not None else {}
    _refused(client.request(method, template.format(**victim), headers=attacker, **kwargs))
    assert _snapshot(db, victim) == before


def test_the_attackers_own_lists_show_nothing_of_the_victims(client, victim, attacker):
    for url in ("/api/orders", "/api/returns", "/api/account/addresses", "/api/cart", "/api/alerts",
                "/api/gift-cards/mine", "/api/wishlist"):
        response = client.get(url, headers=attacker)
        assert response.status_code == 200, url
        text = response.text
        assert victim["order"] not in text and victim["order_number"] not in text and "Brigade" not in text, url


# ------------------------------------------------------------------ tickets


TICKET_ROUTES = [
    ("GET", "/api/support/tickets/{number}", None),
    ("POST", "/api/support/tickets/{number}/read", {}),
    ("POST", "/api/support/tickets/{number}/typing", {}),
    ("POST", "/api/support/tickets/{number}/close", {}),
    ("POST", "/api/support/tickets/{number}/reopen", {"reason": "x"}),
    ("POST", "/api/support/tickets/{number}/feedback", {"rating": 1, "comment": "x"}),
]


@pytest.mark.parametrize("method, template, body", TICKET_ROUTES, ids=[f"{m} {t}" for m, t, _ in TICKET_ROUTES])
def test_another_customers_ticket_is_out_of_reach(client, db, ticket, attacker, method, template, body):
    from app.models import SupportTicket

    before = db.query(SupportTicket).filter_by(number=ticket).one().status
    kwargs = {"json": body} if body is not None else {}
    response = client.request(method, template.format(number=ticket), headers=attacker, **kwargs)
    _refused(response)
    db.expire_all()
    assert db.query(SupportTicket).filter_by(number=ticket).one().status == before


def test_another_customer_cannot_post_into_a_ticket(client, db, ticket, attacker):
    import json

    from app.models import TicketMessage

    before = db.query(TicketMessage).count()
    response = client.post(f"/api/support/tickets/{ticket}/messages", headers=attacker,
                           data={"data": json.dumps({"body": "Let me in"})})
    _refused(response)
    assert db.query(TicketMessage).count() == before


def test_a_signed_out_visitor_cannot_open_a_ticket_by_number(client, ticket):
    _refused(client.get(f"/api/support/tickets/{ticket}"))


def test_the_owner_can_open_their_ticket(client, ticket, auth):
    assert client.get(f"/api/support/tickets/{ticket}", headers=auth).status_code == 200
