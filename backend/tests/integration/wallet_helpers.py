"""Shared helpers for the gift card, store credit and reward points tests."""

from __future__ import annotations

import re

import pytest

ADDRESS = {
    "fullName": "Asha Rao", "phone": "9876500001", "line1": "4 Brigade Road", "line2": "", "city": "Bengaluru",
    "state": "Karnataka", "pincode": "560001", "country": "India", "email": "shopper@example.com",
}
CODE = re.compile(r"DCZG-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}")


@pytest.fixture()
def mailbox(monkeypatch):
    from app.services import email as email_service

    sent = []

    def record(db, key, *, to, customer_id, subject, html, text, reference=""):
        if not email_service.wants(db, key, customer_id):
            return False
        sent.append({"key": key, "to": to, "subject": subject, "html": html, "text": text, "reference": reference})
        return True

    monkeypatch.setattr(email_service, "notify", record)
    return sent


def codes_in(mailbox) -> list:
    return [match for mail in mailbox for match in CODE.findall(mail["text"])]


def issue_card(client, admin_auth, mailbox, amount=500, email="friend@example.com") -> str:
    response = client.post("/api/admin/gift-cards", headers=admin_auth, json={
        "amount": amount, "recipientName": "A Friend", "recipientEmail": email, "reason": "Prize for a contest",
    })
    assert response.status_code == 201, response.text
    return codes_in(mailbox)[-1]


def fill_bag(client, auth, product="PRD001", quantity=1):
    response = client.post("/api/cart/items", headers=auth, json={"productId": product, "quantity": quantity})
    assert response.status_code in (200, 201), response.text


def place(client, auth, *, method="upi", cards=(), store_credit=False, points=0, coupon=None, expect=201):
    response = client.post("/api/orders", headers=auth, json={
        "shippingAddress": ADDRESS, "billingAddress": None, "deliveryMethod": "standard", "paymentMethod": method,
        "couponCode": coupon, "email": "shopper@example.com", "saveAddress": False,
        "giftCardCodes": list(cards), "useStoreCredit": store_credit, "points": points,
    })
    assert response.status_code == expect, response.text
    return response.json()["data"] if expect == 201 else response.json()


def refund(client, admin_auth, invoice_id, amount, reason="Customer returned it"):
    response = client.post("/api/admin/billing/refunds", headers=admin_auth,
                           json={"invoiceId": invoice_id, "amount": amount, "reason": reason})
    assert response.status_code == 201, response.text
    return response.json()["data"]
