"""
Gift cards: buying, codes, checking, paying for orders (in full and in part),
cancellation and refunds giving the money back, and the portal.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from sqlalchemy import select

from app.core import rate_limit
from app.models import GiftCard, GiftCardTransaction, Invoice, Order, OrderTender, Payment, Product
from app.services import gift_cards
from tests.integration.wallet_helpers import (  # noqa: F401 — fixtures
    codes_in,
    fill_bag,
    issue_card,
    mailbox,
    place,
    refund,
)

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


def card_by_code(db, code) -> GiftCard:
    db.expire_all()
    return gift_cards.find(db, code)


class TestBuying:
    def test_the_options_are_public(self, client):
        data = client.get("/api/gift-cards/options").json()["data"]
        assert data["denominations"] == [500, 1000, 2000, 5000] and data["minAmount"] == 100

    def test_buying_sends_the_code_to_the_recipient_only(self, client, db, auth, mailbox):  # noqa: F811
        response = client.post("/api/gift-cards/purchase", headers=auth, json={
            "amount": 1000, "recipientName": "Meera", "recipientEmail": "meera@example.com",
            "message": "<b>Happy</b> birthday!",
        })
        assert response.status_code == 201, response.text
        assert response.json()["data"]["giftCard"]["status"] == "active"
        to_recipient = [m for m in mailbox if m["to"] == "meera@example.com"]
        assert len(to_recipient) == 1 and len(codes_in(to_recipient)) == 1
        to_buyer = [m for m in mailbox if m["to"] == "shopper@example.com"]
        assert to_buyer and not codes_in(to_buyer)
        code = codes_in(to_recipient)[0]
        card = db.query(GiftCard).one()
        assert card.balance == card.initial_amount == 100000 and card.message == "Happy birthday!"
        # The code itself is stored nowhere.
        row = {c.name: getattr(card, c.name) for c in GiftCard.__table__.columns}
        assert not any(code.replace("-", "") in str(value).replace("-", "") for value in row.values())
        assert card.code_last4 == code[-4:]
        mine = client.get("/api/gift-cards/mine", headers=auth).json()["data"]
        assert mine[0]["recipientEmail"] == "meera@example.com" and "code" not in mine[0]

    @pytest.mark.parametrize("body", [
        {"amount": 50, "recipientName": "M", "recipientEmail": "m@example.com"},
        {"amount": 20000, "recipientName": "M", "recipientEmail": "m@example.com"},
        {"amount": 750.5, "recipientName": "M", "recipientEmail": "m@example.com"},
        {"amount": 500, "recipientName": "M", "recipientEmail": "not-an-email"},
    ])
    def test_bad_purchases_are_refused(self, client, auth, body):
        assert client.post("/api/gift-cards/purchase", headers=auth, json=body).status_code == 422

    def test_custom_amounts_can_be_switched_off(self, client, auth, admin_auth):
        client.put("/api/admin/gift-cards/settings", headers=admin_auth, json={"allowCustomAmount": False})
        bad = client.post("/api/gift-cards/purchase", headers=auth,
                          json={"amount": 750, "recipientName": "M", "recipientEmail": "m@example.com"})
        assert bad.status_code == 422

    def test_buying_needs_an_account(self, client):
        assert client.post("/api/gift-cards/purchase",
                           json={"amount": 500, "recipientName": "M", "recipientEmail": "m@example.com"}).status_code == 401


class TestChecking:
    def test_a_balance_check(self, client, auth, admin_auth, mailbox):  # noqa: F811
        code = issue_card(client, admin_auth, mailbox, 500)
        data = client.post("/api/gift-cards/check", headers=auth, json={"code": code.lower().replace("-", " ")}).json()["data"]
        assert data["valid"] is True and data["balance"] == 500 and data["last4"] == code[-4:]
        assert "recipientEmail" not in data

    def test_a_wrong_code(self, client, auth):
        data = client.post("/api/gift-cards/check", headers=auth, json={"code": "DCZG-AAAA-BBBB-CCCC-DDDD"}).json()["data"]
        assert data["valid"] is False

    def test_checking_is_rate_limited(self, client, auth):
        codes = [client.post("/api/gift-cards/check", headers=auth, json={"code": f"DCZG-AAAA-BBBB-CCCC-{i:04d}"}).status_code
                 for i in range(11)]
        assert codes[-1] == 429


class TestPaying:
    def test_a_card_can_pay_the_whole_order(self, client, db, auth, admin_auth, catalogue, settings_documents, mailbox):  # noqa: F811
        code = issue_card(client, admin_auth, mailbox, 2000)
        fill_bag(client, auth)
        placed = place(client, auth, cards=[code])
        assert placed["gateway"] is None and placed["amount"] == 0 and placed["invoiceTotal"] == 100000
        order = db.get(Order, placed["order"]["id"])
        assert order.status == "confirmed" and order.payment_status == "paid" and order.stock_state == "consumed"
        assert placed["order"]["totals"]["giftCardAmount"] == 1000 and placed["order"]["totals"]["amountDue"] == 0
        invoice = db.get(Invoice, placed["invoiceId"])
        assert invoice.gift_card_amount == 100000 and invoice.amount_paid == invoice.grand_total == 100000
        payment = db.get(Payment, placed["paymentId"])
        assert payment.amount == 0 and payment.provider == "internal" and payment.status == "paid"
        assert card_by_code(db, code).balance == 100000
        assert db.get(Product, "PRD001").stock == 9

    def test_a_card_can_pay_part_and_the_rest_goes_to_the_gateway(self, client, db, auth, admin_auth, catalogue,
                                                                  settings_documents, mailbox):  # noqa: F811
        code = issue_card(client, admin_auth, mailbox, 300)
        fill_bag(client, auth)
        placed = place(client, auth, cards=[code])
        payment = db.get(Payment, placed["paymentId"])
        assert payment.amount == 70000 and placed["amount"] == 70000
        card = card_by_code(db, code)
        assert card.balance == 0 and card.status == "used"
        invoice = db.get(Invoice, placed["invoiceId"])
        assert invoice.amount_paid == 100000  # paid in full: 300 card + 700 gateway

    def test_two_cards_on_one_order(self, client, db, auth, admin_auth, catalogue, settings_documents, mailbox):  # noqa: F811
        first = issue_card(client, admin_auth, mailbox, 400)
        second = issue_card(client, admin_auth, mailbox, 400, email="two@example.com")
        fill_bag(client, auth)
        placed = place(client, auth, cards=[first, second])
        assert placed["amount"] == 20000
        assert db.query(OrderTender).count() == 2

    @pytest.mark.parametrize("problem", ["disabled", "expired", "unknown", "empty"])
    def test_an_unusable_card_fails_the_checkout(self, client, db, auth, admin_auth, catalogue, settings_documents,
                                                 mailbox, problem):  # noqa: F811
        code = issue_card(client, admin_auth, mailbox, 300)
        card = card_by_code(db, code)
        if problem == "disabled":
            card.status = "disabled"
        elif problem == "expired":
            card.expires_at = datetime.utcnow() - timedelta(days=1)
        elif problem == "empty":
            card.balance, card.status = 0, "used"
        else:
            code = "DCZG-ZZZZ-ZZZZ-ZZZZ-ZZZZ"
        db.flush()
        fill_bag(client, auth)
        error = place(client, auth, cards=[code], expect=409)
        assert error["error_code"] == "GIFT_CARD_UNUSABLE"
        assert db.query(Order).count() == 0
        if problem != "unknown":
            assert card_by_code(db, code).balance == card.balance

    def test_the_preview_explains_without_failing(self, client, auth, admin_auth, catalogue, settings_documents, mailbox):  # noqa: F811
        code = issue_card(client, admin_auth, mailbox, 300)
        fill_bag(client, auth)
        data = client.post("/api/checkout/tenders", headers=auth,
                           json={"giftCardCodes": [code, "DCZG-ZZZZ-ZZZZ-ZZZZ-ZZZZ"]}).json()["data"]
        assert data["grandTotal"] == 100000 and data["giftCardTotal"] == 30000 and data["amountDue"] == 70000
        assert data["giftCards"][1]["error"]

    def test_too_many_cards(self, client, auth, catalogue, settings_documents):
        fill_bag(client, auth)
        codes = [f"DCZG-AAAA-BBBB-CCCC-{i:04d}" for i in range(4)]
        assert client.post("/api/checkout/tenders", headers=auth, json={"giftCardCodes": codes}).status_code == 422

    def test_the_gateway_minimum_is_respected(self, client, db, auth, admin_auth, catalogue, settings_documents,
                                              mailbox):  # noqa: F811
        code = issue_card(client, admin_auth, mailbox, 999.5)
        fill_bag(client, auth)
        placed = place(client, auth, cards=[code])
        assert placed["amount"] == 100  # ₹1, not 50 paise
        assert card_by_code(db, code).balance == 50  # the 50 paise stay on the card


class TestGoingBack:
    def test_cancelling_puts_the_money_back_on_the_card(self, client, db, auth, admin_auth, catalogue,
                                                        settings_documents, mailbox):  # noqa: F811
        code = issue_card(client, admin_auth, mailbox, 2000)
        fill_bag(client, auth)
        placed = place(client, auth, cards=[code])
        response = client.post(f"/api/orders/{placed['order']['id']}/cancel", headers=auth, json={"reason": "Changed my mind"})
        assert response.status_code == 200, response.text
        card = card_by_code(db, code)
        assert card.balance == 200000 and card.status == "active"
        kinds = [t.kind for t in db.query(GiftCardTransaction).filter_by(gift_card_id=card.id).order_by(GiftCardTransaction.id)]
        assert kinds == ["issue", "redeem", "restore"]
        # Cancelling again (a retry) gives nothing back twice.
        from app.services import tenders

        tenders.release_for_order(db, db.get(Order, placed["order"]["id"]))
        assert card_by_code(db, code).balance == 200000

    def test_a_refund_is_shared_in_proportion(self, client, db, auth, admin_auth, catalogue, settings_documents,
                                              mailbox):  # noqa: F811
        code = issue_card(client, admin_auth, mailbox, 300)
        fill_bag(client, auth)
        placed = place(client, auth, cards=[code])
        made = refund(client, admin_auth, placed["invoiceId"], 50000)  # half the order
        assert made["status"] == "completed"
        payment = db.get(Payment, placed["paymentId"])
        db.refresh(payment)
        assert payment.refunded_amount == 35000  # 70% of ₹500 through the gateway
        assert card_by_code(db, code).balance == 15000  # 30% back on the card
        # The rest of the order: everything left goes back, exactly.
        refund(client, admin_auth, placed["invoiceId"], 50000)
        db.refresh(payment)
        assert payment.refunded_amount == 70000 and card_by_code(db, code).balance == 30000
        too_much = client.post("/api/admin/billing/refunds", headers=admin_auth,
                               json={"invoiceId": placed["invoiceId"], "amount": 1, "reason": "again"})
        assert too_much.status_code == 409

    def test_a_card_that_cant_take_it_back_becomes_store_credit(self, client, db, auth, admin_auth, catalogue,
                                                                settings_documents, mailbox):  # noqa: F811
        from app.services import store_credit

        code = issue_card(client, admin_auth, mailbox, 2000)
        fill_bag(client, auth)
        placed = place(client, auth, cards=[code])
        card = card_by_code(db, code)
        card.status = "disabled"
        db.flush()
        refund(client, admin_auth, placed["invoiceId"], 100000)
        assert store_credit.balance(db, "CUS001") == 100000
        assert card_by_code(db, code).balance == 100000


class TestPortal:
    def test_list_search_and_detail(self, client, auth, admin_auth, catalogue, settings_documents, mailbox):  # noqa: F811
        code = issue_card(client, admin_auth, mailbox, 500)
        data = client.get(f"/api/admin/gift-cards?q={code[-4:]}", headers=admin_auth).json()["data"]
        assert data["pagination"]["total"] == 1 and data["outstanding"] == 500
        card_id = data["items"][0]["id"]
        assert client.get(f"/api/admin/gift-cards?q={code}", headers=admin_auth).json()["data"]["pagination"]["total"] == 1
        detail = client.get(f"/api/admin/gift-cards/{card_id}", headers=admin_auth).json()["data"]
        assert detail["transactions"][0]["kind"] == "issue" and detail["source"] == "admin"
        assert code not in str(detail)

    def test_disable_and_enable(self, client, auth, admin_auth, mailbox):  # noqa: F811
        code = issue_card(client, admin_auth, mailbox, 500)
        card_id = client.get("/api/admin/gift-cards", headers=admin_auth).json()["data"]["items"][0]["id"]
        assert client.post(f"/api/admin/gift-cards/{card_id}/disable", headers=admin_auth, json={"reason": "x"}).status_code == 422
        client.post(f"/api/admin/gift-cards/{card_id}/disable", headers=admin_auth, json={"reason": "Reported stolen"})
        assert client.post("/api/gift-cards/check", headers=auth, json={"code": code}).json()["data"]["usable"] is False
        client.post(f"/api/admin/gift-cards/{card_id}/enable", headers=admin_auth, json={"reason": "Found by owner"})
        assert client.post("/api/gift-cards/check", headers=auth, json={"code": code}).json()["data"]["usable"] is True

    def test_reissue_kills_the_old_code(self, client, auth, admin_auth, mailbox):  # noqa: F811
        old = issue_card(client, admin_auth, mailbox, 500)
        card_id = client.get("/api/admin/gift-cards", headers=admin_auth).json()["data"]["items"][0]["id"]
        client.post(f"/api/admin/gift-cards/{card_id}/reissue", headers=admin_auth, json={"reason": "Email never arrived"})
        new = codes_in(mailbox)[-1]
        assert new != old
        assert client.post("/api/gift-cards/check", headers=auth, json={"code": old}).json()["data"]["valid"] is False
        assert client.post("/api/gift-cards/check", headers=auth, json={"code": new}).json()["data"]["balance"] == 500

    def test_refund_an_unused_purchase(self, client, db, auth, admin_auth, mailbox):  # noqa: F811
        client.post("/api/gift-cards/purchase", headers=auth,
                    json={"amount": 500, "recipientName": "M", "recipientEmail": "m@example.com"})
        card_id = db.query(GiftCard).one().id
        response = client.post(f"/api/admin/gift-cards/{card_id}/refund", headers=admin_auth,
                               json={"reason": "Bought by mistake"})
        assert response.status_code == 200 and response.json()["data"]["rawStatus"] == "refunded"
        assert db.get(GiftCard, card_id).balance == 0

    def test_expiry_writes_off_the_balance(self, db, client, admin_auth, mailbox):  # noqa: F811
        code = issue_card(client, admin_auth, mailbox, 500)
        card = card_by_code(db, code)
        card.expires_at = datetime.utcnow() - timedelta(minutes=1)
        db.flush()
        assert gift_cards.expire_due(db) == 1
        card = card_by_code(db, code)
        assert card.status == "expired" and card.balance == 0
        assert db.execute(select(GiftCardTransaction.kind).where(GiftCardTransaction.gift_card_id == card.id)
                          .order_by(GiftCardTransaction.id.desc())).scalars().first() == "expire"

    @pytest.mark.parametrize("body", [{"minAmount": 0}, {"denominations": [50]}, {"maxCardsPerOrder": 9},
                                      {"validityMonths": "soon"}])
    def test_bad_settings(self, client, admin_auth, body):
        assert client.put("/api/admin/gift-cards/settings", headers=admin_auth, json=body).status_code == 422

    def test_permissions(self, client, auth, editor):
        token = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"}
                            ).json()["data"]["token"]["accessToken"]
        assert client.get("/api/admin/gift-cards", headers={"Authorization": f"Bearer {token}"}).status_code == 403
        assert client.get("/api/admin/gift-cards", headers=auth).status_code in (401, 403)


class TestGatewayPurchase:
    """A card bought through Razorpay is activated by the webhook, once."""

    def test_the_webhook_activates_it_once(self, client, db, auth, mailbox, monkeypatch):  # noqa: F811
        import json

        from tests.integration.test_payments_razorpay import WEBHOOK_SECRET, razorpay, sign  # noqa: F401

        from app.core.config import settings
        from app.services import payments
        from app.services.payments.razorpay import RazorpayPaymentProvider

        monkeypatch.setattr(settings, "PAYMENT_PROVIDER", "razorpay")
        monkeypatch.setattr(settings, "RAZOR_KEY_ID", "rzp_test_abcdefghijklmn")
        monkeypatch.setattr(settings, "RAZOR_KEY_SECRET", "secret_for_tests_only_xx")
        monkeypatch.setattr(settings, "RAZOR_WEBHOOK_SECRET", WEBHOOK_SECRET)
        provider = RazorpayPaymentProvider()
        monkeypatch.setattr(provider, "_request", lambda method, path, **kw: {"id": "order_gc01"})
        payments.get_provider.cache_clear()
        monkeypatch.setattr(payments, "get_provider", lambda: provider)

        started = client.post("/api/gift-cards/purchase", headers=auth,
                              json={"amount": 1000, "recipientName": "Meera", "recipientEmail": "meera@example.com"})
        assert started.status_code == 201, started.text
        data = started.json()["data"]
        assert data["giftCard"]["status"] == "pending" and data["gateway"]["amount"] == 100000
        assert not codes_in(mailbox)

        card_id = data["giftCard"]["id"]
        raw = json.dumps({"event": "payment.captured", "payload": {"payment": {"entity": {
            "id": "pay_gc01", "order_id": "order_gc01", "status": "captured", "amount": 100000, "currency": "INR",
            "notes": {"giftCardId": str(card_id)},
        }}}}).encode()
        headers = {"Content-Type": "application/json", "X-Razorpay-Signature": sign(raw.decode(), WEBHOOK_SECRET)}
        assert client.post("/api/payments/webhook/razorpay", content=raw,
                           headers={**headers, "X-Razorpay-Event-Id": "evt_gc_1"}).status_code == 200
        # The same payment again, as a new event id: still one card, one code.
        assert client.post("/api/payments/webhook/razorpay", content=raw,
                           headers={**headers, "X-Razorpay-Event-Id": "evt_gc_2"}).status_code == 200
        db.expire_all()
        card = db.get(GiftCard, card_id)
        assert card.status == "active" and card.balance == 100000 and card.gateway_payment_id == "pay_gc01"
        assert len(codes_in([m for m in mailbox if m["to"] == "meera@example.com"])) == 1
        assert db.query(GiftCardTransaction).filter_by(gift_card_id=card_id, kind="issue").count() == 1

    def test_a_wrong_amount_does_not_activate(self, client, db, auth, monkeypatch):
        from app.services import gift_cards as service

        card = GiftCard(code_hash="x" * 64, code_last4="----", status="pending", initial_amount=100000, balance=0,
                        currency="INR", source="purchase", purchaser_id="CUS001", recipient_name="M",
                        recipient_email="m@example.com", message="", status_reason="", gateway_order_id="order_x",
                        created_at=datetime.utcnow(), updated_at=datetime.utcnow())
        db.add(card)
        db.flush()
        outcome = service.settle_from_gateway(db, str(card.id), {"status": "captured", "amount": 50000,
                                                                 "order_id": "order_x", "id": "pay_x"})
        assert outcome == "ignored: mismatch" and db.get(GiftCard, card.id).status == "pending"
