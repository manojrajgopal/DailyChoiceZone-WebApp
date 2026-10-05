"""
Gift cards, store credit, reward points, and the tenders they pay orders with.

The existing wallet suites cover buying and spending on the mock provider.
This one covers what a live gateway adds -- a gift card that waits for its
payment, a webhook that activates it, a refund back through the gateway -- and
the rules and edges around each balance: settings that are refused, limits
that stop a spend, idempotent adjustments, debt from points already spent, and
every tender going back when an order does not go ahead.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

import app.main  # noqa: F401 -- import the app before any fixture patches `get_provider`
from app.core import rate_limit
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import (
    GiftCard,
    GiftCardTransaction,
    LoyaltyAccount,
    LoyaltyLot,
    LoyaltyTransaction,
    Order,
    SettingDocument,
    StoreCreditAccount,
    StoreCreditTransaction,
)
from app.services import gift_cards, loyalty, store_credit, tenders
from tests.integration.test_payment_security import (  # noqa: F401 -- `gateway` is a fixture
    WEBHOOK_SECRET,
    captured,
    gateway,
    lapse,
    refunds_sent,
    sign,
    webhook,
)
from tests.integration.wallet_helpers import (  # noqa: F401 -- `mailbox` is a fixture
    codes_in,
    fill_bag,
    issue_card,
    mailbox,
    place,
)
from tests.integration.fulfilment_helpers import advance

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


def fresh(db, model, key):
    row = db.get(model, key)
    db.refresh(row)
    return row


def card_for(db, code) -> GiftCard:
    db.expire_all()
    return gift_cards.find(db, code)


def grant_credit(client, admin_auth, rupees, reason="Credit for the test"):
    response = client.post("/api/admin/store-credit/CUS001", headers=admin_auth,
                           json={"kind": "grant", "amount": rupees, "reason": reason})
    assert response.status_code == 201, response.text
    return response.json()["data"]


def give_points(client, admin_auth, points):
    response = client.post("/api/admin/loyalty/customers/CUS001/adjust", headers=admin_auth,
                           json={"kind": "manual_credit", "points": points, "reason": "Welcome bonus points"})
    assert response.status_code == 201, response.text
    return response.json()["data"]


def spendable(db, customer_id="CUS001"):
    db.expire_all()
    return loyalty.spendable(db, customer_id)


def deliver(client, admin_auth, order_id):
    """Picked, packed, shipped and delivered, the way the store does it (docs/order-fulfilment.md)."""
    advance(client, admin_auth, order_id, "delivered")


def save_loyalty(db, **values):
    return loyalty.save_settings(db, values)


def make_lot(db, points, *, customer_id="CUS001", released=True, available_at=None, expires_at=None,
             order_id=None):
    now = datetime.utcnow().replace(microsecond=0)
    loyalty.account(db, customer_id)
    entry = loyalty._txn(db, customer_id, "manual_credit", points, reason="Test lot")
    lot = LoyaltyLot(customer_id=customer_id, transaction_id=entry.id, order_id=order_id, points=points,
                     remaining=points, available_at=available_at or now, released=released,
                     expires_at=expires_at, created_at=now)
    db.add(lot)
    db.flush()
    return lot


# =================================================== gift cards via gateway


def buy(client, auth, amount=1000, email="meera@example.com"):
    response = client.post("/api/gift-cards/purchase", headers=auth, json={
        "amount": amount, "recipientName": "Meera", "recipientEmail": email, "message": "Enjoy"})
    assert response.status_code == 201, response.text
    return response.json()["data"]


def confirm(client, auth, bought, pay_id, *, secret=None):
    ref = bought["gateway"]["orderReference"]
    signature = sign(f"{ref}|{pay_id}") if secret is None else sign(f"{ref}|{pay_id}", secret)
    return client.post(f"/api/gift-cards/{bought['giftCard']['id']}/verify", headers=auth, json={
        "razorpayOrderId": ref, "razorpayPaymentId": pay_id, "razorpaySignature": signature})


def gift_card_capture(bought, pay_id, *, amount=None, status="captured", card_id=None):
    return {"event": "payment.captured", "payload": {"payment": {"entity": {
        "id": pay_id, "status": status, "order_id": bought["gateway"]["orderReference"],
        "amount": bought["gateway"]["amount"] if amount is None else amount, "currency": "INR", "method": "upi",
        "notes": {"giftCardId": str(card_id if card_id is not None else bought["giftCard"]["id"])}}}}}


class TestBuyingAGiftCardThroughTheGateway:
    def test_the_card_waits_for_its_payment(self, client, db, auth, gateway, mailbox):
        bought = buy(client, auth)

        assert bought["giftCard"]["status"] == "pending"
        handoff = bought["gateway"]
        assert handoff["amount"] == 100000 and handoff["orderReference"].startswith("order_")
        assert handoff["description"] == "Gift card for Meera"
        sent = next(c for c in gateway.calls if c["path"] == "/orders")
        assert sent["json"]["amount"] == 100000
        assert sent["json"]["notes"]["giftCardId"] == str(bought["giftCard"]["id"])
        # No code exists, so none was sent.
        assert codes_in(mailbox) == []
        card = db.get(GiftCard, bought["giftCard"]["id"])
        assert card.balance == 0 and card.status == "pending"

    def test_a_verified_payment_activates_and_delivers_it(self, client, db, auth, gateway, mailbox):
        bought = buy(client, auth)
        ref = bought["gateway"]["orderReference"]
        gateway.responses["/payments/pay_gc0001"] = captured(ref, "pay_gc0001", 100000)

        response = confirm(client, auth, bought, "pay_gc0001")

        assert response.status_code == 200, response.text
        assert response.json()["data"]["status"] == "active"
        card = fresh(db, GiftCard, bought["giftCard"]["id"])
        assert card.balance == 100000 and card.gateway_payment_id == "pay_gc0001" and card.paid_at
        assert len(codes_in([m for m in mailbox if m["to"] == "meera@example.com"])) == 1
        # Confirming twice changes nothing.
        again = confirm(client, auth, bought, "pay_gc0001")
        assert again.status_code == 200 and fresh(db, GiftCard, card.id).balance == 100000

    def test_a_forged_signature_activates_nothing(self, client, db, auth, gateway, mailbox):
        bought = buy(client, auth)

        response = confirm(client, auth, bought, "pay_gc_forged", secret="someone_elses_secret")

        assert response.status_code == 409 and response.json()["error_code"] == "PAYMENT_UNVERIFIED"
        assert fresh(db, GiftCard, bought["giftCard"]["id"]).status == "pending"
        assert codes_in(mailbox) == []

    def test_a_payment_for_less_activates_nothing(self, client, db, auth, gateway, mailbox):
        bought = buy(client, auth)
        ref = bought["gateway"]["orderReference"]
        gateway.responses["/payments/pay_gc_short"] = captured(ref, "pay_gc_short", 100)

        response = confirm(client, auth, bought, "pay_gc_short")

        assert response.status_code == 409 and response.json()["error_code"] == "AMOUNT_MISMATCH"
        assert fresh(db, GiftCard, bought["giftCard"]["id"]).balance == 0

    def test_someone_elses_card_is_not_there(self, client, auth, gateway, mailbox, other_customer):
        bought = buy(client, auth)
        login = client.post("/api/auth/login", json={"email": other_customer.email, "password": "Customer@123"})
        theirs = {"Authorization": f"Bearer {login.json()['data']['token']['accessToken']}"}

        response = confirm(client, theirs, bought, "pay_x")

        assert response.status_code == 404 and response.json()["error_code"] == "GIFT_CARD_NOT_FOUND"

    def test_an_abandoned_purchase_is_closed(self, client, db, auth, gateway, mailbox):
        bought = buy(client, auth)

        assert client.post(f"/api/gift-cards/{bought['giftCard']['id']}/abandon", headers=auth).status_code == 200

        assert fresh(db, GiftCard, bought["giftCard"]["id"]).status == "cancelled"
        assert client.get("/api/gift-cards/mine", headers=auth).json()["data"] == []
        closed = confirm(client, auth, bought, "pay_late")
        assert closed.status_code == 409 and closed.json()["error_code"] == "PURCHASE_CLOSED"

    def test_the_webhook_activates_a_card_once(self, client, db, auth, gateway, mailbox):
        bought = buy(client, auth)

        first = webhook(client, gift_card_capture(bought, "pay_gchook"), event_id="evt_gc_1")
        second = webhook(client, {**gift_card_capture(bought, "pay_gchook"), "event": "order.paid"},
                         event_id="evt_gc_2")

        assert first.json()["data"]["handled"] is True and second.status_code == 200
        from app.models import WebhookEvent

        assert db.get(WebhookEvent, "evt_gc_1").result == "activated gift card"
        assert db.get(WebhookEvent, "evt_gc_2").result.startswith("duplicate")
        card = fresh(db, GiftCard, bought["giftCard"]["id"])
        assert card.balance == 100000
        assert db.query(GiftCardTransaction).filter_by(gift_card_id=card.id, kind="issue").count() == 1

    @pytest.mark.parametrize("change,result", [
        ({"status": "failed"}, "ignored: payment failed"),
        ({"amount": 50000}, "ignored: mismatch"),
        ({"card_id": 999999}, "ignored: unknown gift card"),
        ({"card_id": "not-a-number"}, "ignored: bad gift card id"),
    ])
    def test_the_webhook_ignores_what_does_not_match(self, client, db, auth, gateway, mailbox, change, result):
        from app.models import WebhookEvent

        bought = buy(client, auth)

        webhook(client, gift_card_capture(bought, "pay_gcbad", **change), event_id="evt_gc_bad")

        assert db.get(WebhookEvent, "evt_gc_bad").result == result
        assert fresh(db, GiftCard, bought["giftCard"]["id"]).status == "pending"

    # Regression: was a real bug, fixed alongside this test.
    def test_money_for_an_abandoned_card_goes_back(self, client, db, auth, gateway, mailbox):
        bought = buy(client, auth)
        client.post(f"/api/gift-cards/{bought['giftCard']['id']}/abandon", headers=auth)

        webhook(client, gift_card_capture(bought, "pay_gc_after"), event_id="evt_gc_after")

        assert [c["path"] for c in refunds_sent(gateway)] == ["/payments/pay_gc_after/refund"]

    def test_gift_cards_switched_off(self, client, db, auth, admin_auth):
        client.put("/api/admin/gift-cards/settings", headers=admin_auth, json={"enabled": False})
        response = client.post("/api/gift-cards/purchase", headers=auth, json={
            "amount": 500, "recipientName": "M", "recipientEmail": "m@example.com"})
        assert response.status_code == 409 and response.json()["error_code"] == "GIFT_CARDS_OFF"


class TestRefundingAnUnusedCard:
    @pytest.fixture()
    def bought(self, client, db, auth, gateway, mailbox):
        bought = buy(client, auth)
        webhook(client, gift_card_capture(bought, "pay_gcref1"), event_id="evt_gc_ref")
        return bought

    def test_it_goes_back_through_the_gateway(self, client, db, admin_auth, gateway, bought, mailbox):
        card_id = bought["giftCard"]["id"]
        response = client.post(f"/api/admin/gift-cards/{card_id}/refund", headers=admin_auth,
                               json={"reason": "Bought by mistake"})

        assert response.status_code == 200, response.text
        sent = refunds_sent(gateway)
        assert [c["path"] for c in sent] == ["/payments/pay_gcref1/refund"] and sent[0]["json"]["amount"] == 100000
        card = fresh(db, GiftCard, card_id)
        assert card.status == "refunded" and card.balance == 0
        assert any(m["to"] == "shopper@example.com" and "refunded" in m["subject"] for m in mailbox)
        # A refunded card pays for nothing.
        assert gift_cards.usable_reason(card) == "That gift card has been cancelled."

    def test_a_used_card_is_not_refunded(self, client, db, admin_auth, gateway, bought):
        card = db.get(GiftCard, bought["giftCard"]["id"])
        card.balance -= 100
        db.flush()

        response = client.post(f"/api/admin/gift-cards/{card.id}/refund", headers=admin_auth,
                               json={"reason": "Bought by mistake"})

        assert response.status_code == 409 and response.json()["error_code"] == "NOT_REFUNDABLE"
        assert refunds_sent(gateway) == []

    def test_a_refusal_at_the_gateway_keeps_the_card(self, client, db, admin_auth, gateway, bought):
        from app.services.payments.razorpay import RazorpayError

        def refuse():
            raise RazorpayError("Refund window over.", status=400)

        gateway.responses["/payments/pay_gcref1/refund"] = refuse

        response = client.post(f"/api/admin/gift-cards/{bought['giftCard']['id']}/refund", headers=admin_auth,
                               json={"reason": "Bought by mistake"})

        assert response.status_code == 409 and response.json()["error_code"] == "PROVIDER_REFUSED"
        card = fresh(db, GiftCard, bought["giftCard"]["id"])
        assert card.status == "active" and card.balance == 100000

    def test_a_store_issued_card_was_never_paid_for(self, client, admin_auth, mailbox, db):
        issue_card(client, admin_auth, mailbox, 500)
        card = db.query(GiftCard).one()
        response = client.post(f"/api/admin/gift-cards/{card.id}/refund", headers=admin_auth,
                               json={"reason": "Bought by mistake"})
        assert response.status_code == 409 and response.json()["error_code"] == "NOT_REFUNDABLE"


# ===================================================== gift cards: portal


class TestTheGiftCardPortal:
    def test_search_by_status_reference_and_code(self, client, db, admin_auth, mailbox):
        first = issue_card(client, admin_auth, mailbox, 500, email="first@example.com")
        second = issue_card(client, admin_auth, mailbox, 700, email="second@example.com")
        one = card_for(db, first)
        two = card_for(db, second)
        one.balance = 20000
        two.expires_at = datetime.utcnow() - timedelta(days=1)
        db.flush()

        def ids(**params):
            response = client.get("/api/admin/gift-cards", headers=admin_auth, params=params)
            assert response.status_code == 200, response.text
            return {row["id"] for row in response.json()["data"]["items"]}

        assert ids() == {one.id, two.id}
        assert ids(status="partially-used") == {one.id}
        assert ids(status="expired") == {two.id}
        assert ids(status="active") == {one.id, two.id}
        assert ids(q=f"GC-{one.id:06d}") == {one.id}
        assert ids(q=f"GC{two.id}") == {two.id}
        # A whole code is an identifier (matched by its hash); its last four
        # characters and the purchaser's email are not.
        assert ids(code=first) == {one.id}
        assert ids(q=second[-4:]) == set()
        assert ids(q="second@example") == set()
        assert ids(code=second[-4:]) == set()
        body = client.get("/api/admin/gift-cards", headers=admin_auth).json()["data"]
        assert body["outstanding"] == 200 + 700 and body["counts"] == {"active": 2}

    def test_one_card_and_a_missing_one(self, client, db, admin_auth, mailbox):
        issue_card(client, admin_auth, mailbox, 500)
        card = db.query(GiftCard).one()
        detail = client.get(f"/api/admin/gift-cards/{card.id}", headers=admin_auth).json()["data"]
        assert detail["reference"] == f"GC-{card.id:06d}" and detail["transactions"][0]["kind"] == "issue"
        missing = client.get("/api/admin/gift-cards/999999", headers=admin_auth)
        assert missing.status_code == 404 and missing.json()["error_code"] == "GIFT_CARD_NOT_FOUND"

    def test_disable_and_enable_follow_the_status(self, client, db, admin_auth, mailbox):
        code = issue_card(client, admin_auth, mailbox, 500)
        card = card_for(db, code)
        url = f"/api/admin/gift-cards/{card.id}"

        wrong = client.post(f"{url}/enable", headers=admin_auth, json={"reason": "Never was disabled"})
        assert wrong.status_code == 409 and wrong.json()["error_code"] == "INVALID_STATUS"
        assert client.post(f"{url}/disable", headers=admin_auth, json={"reason": "Reported stolen"}).status_code == 200
        again = client.post(f"{url}/disable", headers=admin_auth, json={"reason": "Reported stolen"})
        assert again.status_code == 409

        # A disabled card can't get a new code: it can't be spent.
        reissue = client.post(f"{url}/reissue", headers=admin_auth, json={"reason": "Lost the email"})
        assert reissue.status_code == 409 and reissue.json()["error_code"] == "INVALID_STATUS"

        card.balance = 0
        db.flush()
        enabled = client.post(f"{url}/enable", headers=admin_auth, json={"reason": "Found it again"})
        assert enabled.status_code == 200 and fresh(db, GiftCard, card.id).status == "used"

    def test_a_new_code_kills_the_old_one(self, client, db, admin_auth, mailbox):
        old = issue_card(client, admin_auth, mailbox, 500)
        card = card_for(db, old)

        response = client.post(f"/api/admin/gift-cards/{card.id}/reissue", headers=admin_auth,
                               json={"reason": "Customer lost the email"})

        assert response.status_code == 200
        new = codes_in(mailbox)[-1]
        assert new != old and card_for(db, old) is None and card_for(db, new).id == card.id

    @pytest.mark.parametrize("call", [
        lambda db, admin, card: gift_cards.admin_set_status(db, admin, card.id, action="disable", reason="no"),
        lambda db, admin, card: gift_cards.admin_set_status(db, admin, card.id, action="freeze", reason="Because"),
        lambda db, admin, card: gift_cards.admin_reissue(db, admin, card.id, reason="no"),
        lambda db, admin, card: gift_cards.admin_refund_unused(db, admin, card.id, reason="no"),
    ])
    def test_the_service_refuses_short_reasons_and_unknown_actions(self, client, db, admin, admin_auth, mailbox, call):
        issue_card(client, admin_auth, mailbox, 500)
        card = db.query(GiftCard).one()
        with pytest.raises(ValidationError):
            call(db, admin, card)

    @pytest.mark.parametrize("kwargs,code", [
        ({"amount": "lots"}, "INVALID_AMOUNT"),
        ({"amount": 0.5}, "INVALID_AMOUNT"),
        ({"amount": 100001}, "INVALID_AMOUNT"),
        ({"amount": 100, "reason": "x"}, "REASON_REQUIRED"),
        ({"amount": 100, "recipient_name": "<b></b>"}, "RECIPIENT_NAME_REQUIRED"),
    ])
    def test_issuing_is_validated(self, db, admin, kwargs, code):
        args = {"recipient_name": "A Friend", "recipient_email": "friend@example.com", "reason": "Contest prize"}
        args.update(kwargs)
        with pytest.raises(ValidationError) as raised:
            gift_cards.admin_issue(db, admin, **args)
        assert raised.value.error_code == code

    @pytest.mark.parametrize("payload", [
        {"minAmount": True},
        {"maxAmount": "lots"},
        {"minAmount": 5000, "maxAmount": 100},
        {"denominations": "500"},
        {"denominations": [100, 200, 300, 400, 500, 600, 700, 800, 900]},
        {"denominations": [50]},
        {"denominations": [], "allowCustomAmount": False},
        {"validityMonths": 121},
        {"maxCardsPerOrder": 6},
    ])
    def test_settings_that_are_refused(self, client, admin_auth, payload):
        response = client.put("/api/admin/gift-cards/settings", headers=admin_auth, json=payload)
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_SETTING"

    def test_settings_are_saved_and_read_back(self, client, admin_auth):
        saved = client.put("/api/admin/gift-cards/settings", headers=admin_auth, json={
            "denominations": [1000, 500, 500], "validityMonths": 0, "maxCardsPerOrder": 2})
        assert saved.status_code == 200
        again = client.put("/api/admin/gift-cards/settings", headers=admin_auth, json={"minAmount": 200})
        data = again.json()["data"]
        assert data["denominations"] == [500, 1000] and data["validityMonths"] == 0 and data["minAmount"] == 200
        assert client.get("/api/admin/gift-cards/settings", headers=admin_auth).json()["data"] == data

    def test_a_card_with_no_expiry_never_expires(self, client, db, admin_auth, mailbox):
        client.put("/api/admin/gift-cards/settings", headers=admin_auth, json={"validityMonths": 0})
        code = issue_card(client, admin_auth, mailbox, 500)
        assert card_for(db, code).expires_at is None

    def test_cards_past_their_date_are_written_off(self, client, db, admin_auth, mailbox):
        code = issue_card(client, admin_auth, mailbox, 500)
        card = card_for(db, code)
        card.expires_at = datetime.utcnow() - timedelta(minutes=1)
        db.flush()
        assert gift_cards.display_status(card) == "expired"

        assert gift_cards.expire_due(db) == 1

        card = fresh(db, GiftCard, card.id)
        assert card.status == "expired" and card.balance == 0
        entry = db.query(GiftCardTransaction).filter_by(gift_card_id=card.id, kind="expire").one()
        assert entry.amount == -50000 and entry.balance_after == 0
        assert gift_cards.expire_due(db) == 0

    def test_a_balance_check_on_a_spent_card(self, client, db, auth, admin_auth, mailbox):
        code = issue_card(client, admin_auth, mailbox, 500)
        card = card_for(db, code)
        card.balance = 20000
        db.flush()
        data = client.post("/api/gift-cards/check", headers=auth, json={"code": code}).json()["data"]
        assert data["valid"] is True and data["status"] == "partially-used" and data["balance"] == 200


# ============================================================ store credit


class TestStoreCredit:
    def test_revoking_more_than_the_balance_is_refused(self, client, db, admin_auth, customer):
        grant_credit(client, admin_auth, 100)

        response = client.post("/api/admin/store-credit/CUS001", headers=admin_auth,
                               json={"kind": "revoke", "amount": 100.01, "reason": "Granted in error"})

        assert response.status_code == 409 and response.json()["error_code"] == "INSUFFICIENT_STORE_CREDIT"
        assert response.json()["details"] == {"balance": 100}
        assert store_credit.balance(db, "CUS001") == 10000

    def test_a_double_clicked_grant_posts_once(self, client, db, admin_auth, customer):
        body = {"kind": "goodwill", "amount": 250, "reason": "Late delivery apology", "requestKey": "abc-123"}
        first = client.post("/api/admin/store-credit/CUS001", headers=admin_auth, json=body)
        second = client.post("/api/admin/store-credit/CUS001", headers=admin_auth, json=body)

        assert first.status_code == second.status_code == 201
        assert first.json()["data"]["id"] == second.json()["data"]["id"]
        assert store_credit.balance(db, "CUS001") == 25000
        assert db.query(StoreCreditTransaction).count() == 1

    @pytest.mark.parametrize("kwargs,error", [
        ({"customer_id": "CUS999"}, NotFoundError),
        ({"kind": "refund"}, ValidationError),
        ({"amount": "lots"}, ValidationError),
        ({"amount": 0.001}, ValidationError),
        ({"amount": 100001}, ValidationError),
        ({"reason": "abc"}, ValidationError),
    ])
    def test_adjustments_are_validated(self, db, admin, customer, kwargs, error):
        args = {"customer_id": "CUS001", "kind": "grant", "amount": 100, "reason": "A good reason"}
        args.update(kwargs)
        customer_id = args.pop("customer_id")
        with pytest.raises(error):
            store_credit.admin_adjust(db, admin, customer_id, **args)

    def test_a_zero_movement_is_refused(self, db, customer):
        with pytest.raises(ValidationError):
            store_credit.post(db, "CUS001", kind="adjust", amount=0)

    def test_a_system_credit_posts_once_per_key(self, db, customer):
        assert store_credit.credit_customer(db, "CUS001", kind="refund", amount=0, reason="x", key="k0") is None
        first = store_credit.credit_customer(db, "CUS001", kind="refund", amount=500, reason="Refund", key="k1",
                                             notify=False)
        again = store_credit.credit_customer(db, "CUS001", kind="refund", amount=500, reason="Refund", key="k1")
        assert first is not None and again is None
        assert store_credit.balance(db, "CUS001") == 500

    def test_the_portal_lists_and_searches(self, client, admin_auth, customer, other_customer):
        grant_credit(client, admin_auth, 300)

        everyone = client.get("/api/admin/store-credit", headers=admin_auth).json()["data"]
        assert [i["customer"]["id"] for i in everyone["items"]] == ["CUS001"] and everyone["outstanding"] == 300

        # A Customer ID reaches customers who have never had credit too.
        ravi = client.get("/api/admin/store-credit", headers=admin_auth, params={"q": "CUS002"}).json()["data"]
        assert [i["customer"]["id"] for i in ravi["items"]] == ["CUS002"] and ravi["items"][0]["balance"] == 0
        with_balance = client.get("/api/admin/store-credit", headers=admin_auth,
                                  params={"q": "CUS001", "withBalance": True}).json()["data"]
        assert [i["customer"]["id"] for i in with_balance["items"]] == ["CUS001"]
        assert client.get("/api/admin/store-credit", headers=admin_auth,
                          params={"q": "CUS002", "withBalance": True}).json()["data"]["items"] == []
        # Names and emails are not IDs.
        for text in ("Ravi", "Asha", "shopper@example.com", "CUS00"):
            assert client.get("/api/admin/store-credit", headers=admin_auth,
                              params={"q": text}).json()["data"]["items"] == []

    def test_one_customers_ledger(self, client, admin_auth, customer):
        grant_credit(client, admin_auth, 300)
        ledger = client.get("/api/admin/store-credit/CUS001", headers=admin_auth).json()["data"]
        assert ledger["balance"] == 300 and ledger["items"][0]["by"] == "Manoj Rajan"
        missing = client.get("/api/admin/store-credit/CUS999", headers=admin_auth)
        assert missing.status_code == 404 and missing.json()["error_code"] == "CUSTOMER_NOT_FOUND"


# ============================================================ reward points


class TestPointsSettings:
    @pytest.mark.parametrize("payload", [
        {"pointsPer100": True},
        {"pointsPer100": "many"},
        {"redeemPoints": 1.5},
        {"maxOrderPercent": 101},
        {"memberMultiplier": 11},
        {"planMultipliers": ["MBP001"]},
        {"planMultipliers": {"MBP001": 0.5}},
        {"excludedProducts": "PRD001"},
        {"pendingDays": 400},
    ])
    def test_refused(self, client, admin_auth, payload):
        response = client.put("/api/admin/loyalty/settings", headers=admin_auth, json=payload)
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_SETTING"

    def test_saved_and_saved_again(self, client, admin_auth):
        first = client.put("/api/admin/loyalty/settings", headers=admin_auth, json={
            "pendingDays": 3, "planMultipliers": {"MBP001": 1.5}, "excludedCategories": [" women ", "", "women"]})
        assert first.status_code == 200
        second = client.put("/api/admin/loyalty/settings", headers=admin_auth, json={"pendingDays": ""}).json()["data"]
        assert second["pendingDays"] is None and second["planMultipliers"] == {"MBP001": 1.5}
        assert second["excludedCategories"] == ["women"]
        assert client.get("/api/admin/loyalty/settings", headers=admin_auth).json()["data"] == second


class TestWhatEarnsPoints:
    @pytest.fixture()
    def order(self, client, db, auth, catalogue, settings_documents):
        fill_bag(client, auth)
        placed = place(client, auth)
        return db.get(Order, placed["order"]["id"])

    def test_the_default_rules(self, db, order):
        assert loyalty.earnable(db, order) == 47

    @pytest.mark.parametrize("rules,points", [
        ({"enabled": False}, 0),
        ({"pointsPer100": 0}, 0),
        ({"eligibleCategories": ["electronics"]}, 0),
        ({"eligibleCategories": ["CAT001"]}, 47),
        ({"excludedCategories": ["women"]}, 0),
        ({"excludeDiscountedItems": True}, 0),
    ])
    def test_rules_narrow_it(self, db, order, rules, points):
        save_loyalty(db, **rules)
        assert loyalty.earnable(db, order) == points

    def test_a_plan_can_earn_at_its_own_multiple(self, db, order, customer):
        from app.models import CustomerMembership, MembershipPlan

        now = datetime.utcnow()
        db.add(MembershipPlan(id="MBP901", name="Gold", duration_months=12, price=500, created_at=now,
                              updated_at=now))
        db.flush()
        db.add(CustomerMembership(id="MEM901", customer_id="CUS001", plan_id="MBP901", plan_name="Gold",
                                  duration_months=12, status="active", starts_at=now, ends_at=now + timedelta(days=30),
                                  amount=50000, benefits={}, created_at=now, updated_at=now))
        db.flush()
        order.membership_id = "MEM901"
        save_loyalty(db, memberMultiplier=2, planMultipliers={"MBP901": 3})
        assert loyalty.earnable(db, order) == 141
        save_loyalty(db, planMultipliers={})
        assert loyalty.earnable(db, order) == 94

    def test_an_order_without_an_invoice_earns_nothing(self, db, order):
        from app.models import Invoice

        invoice = db.query(Invoice).filter_by(order_id=order.id).one()
        invoice.grand_total = 0
        db.flush()
        assert loyalty.earnable(db, order) == 0
        assert loyalty.award_for_order(db, order) == 0

    def test_the_pending_period_is_configurable_and_has_a_fallback(self, db, order, monkeypatch):
        from app.services import returns

        save_loyalty(db, pendingDays=2)
        assert loyalty._pending_days(db, loyalty.settings(db), order) == 2

        def broken(db):
            raise RuntimeError("no return settings")

        monkeypatch.setattr(returns, "window_days", broken)
        assert loyalty._pending_days(db, loyalty.DEFAULTS, order) == 15

    def test_points_earned_with_no_pending_period_are_spendable_at_once(self, client, db, admin_auth, order, mailbox):
        save_loyalty(db, pendingDays=0, expiryMonths=0)
        deliver(client, admin_auth, order.id)
        lot = db.query(LoyaltyLot).filter_by(order_id=order.id).one()
        assert lot.released is True and lot.expires_at is None
        assert spendable(db) == 47


class TestTakingPointsBack:
    def test_a_refund_after_the_points_were_spent_becomes_debt(self, client, db, auth, admin_auth, catalogue,
                                                               settings_documents, mailbox):
        fill_bag(client, auth)
        placed = place(client, auth)
        deliver(client, admin_auth, placed["order"]["id"])
        lot = db.query(LoyaltyLot).filter_by(order_id=placed["order"]["id"]).one()
        lot.remaining = 10  # 37 of the 47 already spent
        db.flush()
        order = db.get(Order, placed["order"]["id"])

        taken = loyalty.reverse_for_order(db, order, fraction=1.0, refund_id="RFD1", reason="Refunded")

        assert taken == 47
        account = fresh(db, LoyaltyAccount, "CUS001")
        assert account.debt == 37 and account.lifetime_reversed == 47
        assert any("taken back" in m["subject"] for m in mailbox)
        # Once per refund, and never more than was earned.
        assert loyalty.reverse_for_order(db, order, fraction=1.0, refund_id="RFD1") == 0
        assert loyalty.reverse_for_order(db, order, fraction=1.0, refund_id="RFD2") == 0

        # The debt comes out of the next points to become spendable.
        pending_lot = make_lot(db, 50, released=False, available_at=datetime.utcnow() - timedelta(seconds=1))
        assert loyalty.release_due(db) == 1
        db.refresh(pending_lot)
        assert pending_lot.remaining == 13 and fresh(db, LoyaltyAccount, "CUS001").debt == 0
        assert spendable(db) == 13

    def test_nothing_earned_nothing_taken(self, client, db, auth, catalogue, settings_documents):
        fill_bag(client, auth)
        placed = place(client, auth)
        assert loyalty.reverse_for_order(db, db.get(Order, placed["order"]["id"]), fraction=1.0) == 0

    def test_a_grant_pays_off_debt_first(self, db, customer):
        loyalty.account(db, "CUS001").debt = 30
        db.flush()

        entry = loyalty.grant(db, "CUS001", 100, kind="referral", reason="Referral", key="ref:1")

        assert entry.balance_after == 70 and fresh(db, LoyaltyAccount, "CUS001").debt == 0
        assert loyalty.grant(db, "CUS001", 100, kind="referral", reason="Referral", key="ref:1") is None
        assert loyalty.grant(db, "CUS001", 0, kind="referral", reason="Referral", key="ref:2") is None

    def test_revoking_a_grant_takes_only_what_is_left(self, db, customer):
        loyalty.grant(db, "CUS001", 100, kind="referral", reason="Referral", key="ref:9")
        lot = db.query(LoyaltyLot).one()
        lot.remaining = 40
        db.flush()

        short = loyalty.revoke(db, "CUS001", 100, kind="referral_reversed", reason="Referral reversed",
                               key="rev:9")

        assert short == 60 and spendable(db) == 0
        assert loyalty.revoke(db, "CUS001", 100, kind="referral_reversed", reason="x", key="rev:9") == 0
        assert loyalty.revoke(db, "CUS001", 0, kind="referral_reversed", reason="x", key="rev:10") == 0

    def test_restoring_an_order_that_spent_nothing(self, db, customer):
        assert loyalty.restore(db, "ORD-NONE", 100, key="restore:none") == 0
        assert loyalty.restore(db, "ORD-NONE", 0, key="restore:zero") == 0


class TestPointsLimits:
    def limits(self, db, total=100000, **flags):
        args = {"coupon": False, "gift_cards": False, "store_credit": False}
        args.update(flags)
        return loyalty.redemption_limits(db, "CUS001", total, **args)

    def test_each_reason_points_cannot_be_used(self, db, customer):
        assert self.limits(db)["reason"] == "You don't have points to spend yet."
        make_lot(db, 50)
        assert "once you have 100" in self.limits(db)["reason"]
        make_lot(db, 1000)
        assert self.limits(db)["maxPoints"] == 1000

        save_loyalty(db, allowWithCoupons=False, allowWithGiftCards=False, allowWithStoreCredit=False)
        assert "coupon" in self.limits(db, coupon=True)["reason"]
        assert "gift card" in self.limits(db, gift_cards=True)["reason"]
        assert "store credit" in self.limits(db, store_credit=True)["reason"]
        # Half of ₹100 is exactly the 100-point minimum; half of ₹99.99 is not.
        assert self.limits(db, total=10000)["maxPoints"] == 100
        assert self.limits(db, total=9999)["reason"] == "This order is too small to spend points on."

        save_loyalty(db, maxPointsPerOrder=300)
        assert self.limits(db)["maxPoints"] == 300

        save_loyalty(db, enabled=False)
        assert self.limits(db)["reason"] == "Reward points aren't available right now."

    def test_debt_blocks_spending(self, db, customer):
        make_lot(db, 100)
        loyalty.account(db, "CUS001").debt = 150
        db.flush()
        limits = self.limits(db)
        assert limits["available"] == 0 and "taken back first" in limits["reason"]


class TestPointsHousekeeping:
    def test_the_portal_runs_it_now(self, client, db, admin_auth, customer):
        make_lot(db, 40, released=False, available_at=datetime.utcnow() - timedelta(minutes=1))
        make_lot(db, 25, expires_at=datetime.utcnow() - timedelta(minutes=1))

        response = client.post("/api/admin/loyalty/housekeeping", headers=admin_auth)

        assert response.status_code == 200, response.text
        assert response.json()["data"] == {"released": 1, "expiredPoints": 25}
        assert spendable(db) == 40
        assert fresh(db, LoyaltyAccount, "CUS001").lifetime_expired == 25

    def test_the_portal_run_is_rate_limited(self, client, admin_auth):
        codes = [client.post("/api/admin/loyalty/housekeeping", headers=admin_auth).status_code for _ in range(6)]
        assert codes[:5] == [200] * 5 and codes[5] == 429

    def test_a_warning_before_points_expire_once(self, db, customer, mailbox):
        make_lot(db, 300, expires_at=datetime.utcnow() + timedelta(days=5))

        assert loyalty.warn_expiring(db) == 1
        assert any("expire" in m["subject"] for m in mailbox)
        assert loyalty.warn_expiring(db) == 0

    def test_no_warning_when_switched_off_or_for_an_inactive_account(self, db, customer, mailbox):
        make_lot(db, 300, expires_at=datetime.utcnow() + timedelta(days=5))
        save_loyalty(db, expiryWarningDays=0)
        assert loyalty.warn_expiring(db) == 0
        save_loyalty(db, expiryWarningDays=30)
        customer.status = "suspended"
        db.flush()
        assert loyalty.warn_expiring(db) == 1
        assert mailbox == []

    def test_the_background_loop_runs_every_job_and_survives_one_failing(self, monkeypatch):
        import asyncio

        from app.core import database
        from app.services import jobs

        class Dummy:
            rolled_back = 0

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def rollback(self):
                Dummy.rolled_back += 1

        ran = []

        def job(name, fail=False):
            def run(db):
                ran.append(name)
                if fail:
                    raise RuntimeError(name)
            run.__name__ = name
            return run

        monkeypatch.setattr(database, "SessionLocal", lambda: Dummy())
        monkeypatch.setattr(loyalty, "release_due", job("release", fail=True))
        monkeypatch.setattr(loyalty, "expire_due", job("expire"))
        monkeypatch.setattr(loyalty, "warn_expiring", job("warn"))
        monkeypatch.setattr(gift_cards, "expire_due", job("cards"))
        rounds = []

        def tracked(name, interval, fn):
            rounds.append(name)
            if len(rounds) == 2:
                def boom():
                    raise RuntimeError("tracking failed")
                return boom
            return fn

        async def sleep(seconds):
            if len(rounds) >= 2:
                raise asyncio.CancelledError

        monkeypatch.setattr(jobs, "tracked", tracked)
        monkeypatch.setattr(asyncio, "sleep", sleep)

        with pytest.raises(asyncio.CancelledError):
            asyncio.run(loyalty.run_forever())

        assert ran == ["release", "expire", "warn", "cards"] and Dummy.rolled_back == 1
        assert rounds == ["loyalty", "loyalty"]


class TestPointsAdjustments:
    def test_a_double_clicked_adjustment_posts_once(self, client, db, admin_auth, customer):
        body = {"kind": "manual_credit", "points": 250, "reason": "Survey reward", "requestKey": "k-1"}
        first = client.post("/api/admin/loyalty/customers/CUS001/adjust", headers=admin_auth, json=body)
        again = client.post("/api/admin/loyalty/customers/CUS001/adjust", headers=admin_auth, json=body)
        assert first.json()["data"]["id"] == again.json()["data"]["id"]
        assert spendable(db) == 250

    def test_a_credit_pays_debt_and_a_debit_needs_points(self, client, db, admin_auth, customer):
        loyalty.account(db, "CUS001").debt = 50
        db.flush()
        give_points(client, admin_auth, 200)
        assert spendable(db) == 150 and fresh(db, LoyaltyAccount, "CUS001").debt == 0

        too_many = client.post("/api/admin/loyalty/customers/CUS001/adjust", headers=admin_auth,
                               json={"kind": "manual_debit", "points": 151, "reason": "Correction of error"})
        assert too_many.status_code == 409 and too_many.json()["error_code"] == "INSUFFICIENT_POINTS"
        ok = client.post("/api/admin/loyalty/customers/CUS001/adjust", headers=admin_auth,
                         json={"kind": "manual_debit", "points": 100, "reason": "Correction of error"})
        assert ok.status_code == 201 and ok.json()["data"]["points"] == -100
        assert spendable(db) == 50

    @pytest.mark.parametrize("customer_id,kind,reason,error", [
        ("CUS999", "manual_credit", "A good reason", NotFoundError),
        ("CUS001", "bonus", "A good reason", ValidationError),
        ("CUS001", "manual_credit", "abc", ValidationError),
    ])
    def test_the_service_validates(self, db, admin, customer, customer_id, kind, reason, error):
        with pytest.raises(error):
            loyalty.admin_adjust(db, admin, customer_id, kind=kind, points=10, reason=reason)

    def test_the_portal_views(self, client, db, admin_auth, customer, other_customer):
        give_points(client, admin_auth, 500)
        make_lot(db, 30, released=False, available_at=datetime.utcnow() + timedelta(days=3))

        balances = client.get("/api/admin/loyalty/balances", headers=admin_auth, params={"q": "CUS001"}).json()["data"]
        assert balances["items"][0]["available"] == 500 and balances["items"][0]["pending"] == 30
        # CUS002 has no points account; names and emails are not IDs.
        for text in ("CUS002", "Asha", "shopper@example.com"):
            assert client.get("/api/admin/loyalty/balances", headers=admin_auth,
                              params={"q": text}).json()["data"]["items"] == []

        def kinds(**params):
            data = client.get("/api/admin/loyalty/ledger", headers=admin_auth, params=params).json()["data"]
            return [item["kind"] for item in data["items"]]

        assert kinds(kind="manual_credit", customerId="CUS001", q="CUS001") == ["manual_credit", "manual_credit"]
        # Names and words from the reason are not IDs.
        assert kinds(q="Asha") == [] and kinds(q="Welcome bonus") == []
        assert kinds(customerId="CUS002") == []

        one = client.get("/api/admin/loyalty/customers/CUS001", headers=admin_auth).json()["data"]
        assert one["available"] == 500 and one["pending"] == 30 and one["nextReleaseAt"]
        missing = client.get("/api/admin/loyalty/customers/CUS999", headers=admin_auth)
        assert missing.status_code == 404
        metrics = client.get("/api/admin/loyalty/metrics", headers=admin_auth).json()["data"]
        assert metrics["outstanding"] == 500 and metrics["pending"] == 30


# ============================================================ the tenders


class TestPlanningTenders:
    def test_the_preview_shows_what_each_pays(self, client, db, auth, admin_auth, catalogue, settings_documents,
                                              mailbox):
        code = issue_card(client, admin_auth, mailbox, 300)
        grant_credit(client, admin_auth, 200)
        give_points(client, admin_auth, 1000)
        fill_bag(client, auth)

        view = client.post("/api/checkout/tenders", headers=auth, json={
            "giftCardCodes": [code], "useStoreCredit": True, "points": 200}).json()["data"]

        assert view["points"]["applied"] == 200 and view["points"]["value"] == 10000
        assert view["giftCards"] == [{"last4": code[-4:], "applied": 30000, "balance": 30000, "error": ""}]
        assert view["storeCredit"] == {"available": 20000, "applied": 20000}
        assert view["tenderTotal"] == 60000 and view["amountDue"] == 40000

    def test_a_bad_code_and_the_same_card_twice(self, client, auth, admin_auth, catalogue, settings_documents, mailbox):
        code = issue_card(client, admin_auth, mailbox, 300)
        fill_bag(client, auth)

        view = client.post("/api/checkout/tenders", headers=auth, json={
            "giftCardCodes": [code, code.lower(), "DCZG-AAAA-BBBB-CCCC-DDDD"]}).json()["data"]

        assert [c["applied"] for c in view["giftCards"]] == [30000, 0]
        assert view["giftCards"][1]["error"] == "That gift card code isn't valid."
        assert view["amountDue"] == 70000

    def test_the_gateway_is_never_left_less_than_a_rupee(self, client, auth, admin_auth, catalogue,
                                                         settings_documents, mailbox):
        code = issue_card(client, admin_auth, mailbox, 999.5)
        fill_bag(client, auth)

        view = client.post("/api/checkout/tenders", headers=auth, json={"giftCardCodes": [code]}).json()["data"]

        assert view["giftCardTotal"] == 99900 and view["amountDue"] == 100
        assert any("start at" in message for message in view["messages"])

    def test_the_rupee_comes_back_off_store_credit_first(self, client, auth, admin_auth, catalogue, settings_documents):
        grant_credit(client, admin_auth, 999.5)
        fill_bag(client, auth)
        view = client.post("/api/checkout/tenders", headers=auth, json={"useStoreCredit": True}).json()["data"]
        assert view["storeCredit"]["applied"] == 99900 and view["amountDue"] == 100

    def test_the_rupee_comes_back_off_points_when_they_pay_it_all(self, client, db, auth, admin_auth, catalogue,
                                                                  settings_documents):
        save_loyalty(db, maxOrderPercent=100, minRedeemPoints=1)
        give_points(client, admin_auth, 2000)
        fill_bag(client, auth)
        view = client.post("/api/checkout/tenders", headers=auth, json={"points": 1999}).json()["data"]
        assert view["points"]["applied"] == 1998 and view["amountDue"] == 100

    @pytest.mark.parametrize("settings,body,code", [
        ({"maxCardsPerOrder": 1}, {"giftCardCodes": ["DCZG-AAAA-AAAA-AAAA-AAAA", "DCZG-BBBB-BBBB-BBBB-BBBB"]},
         "TOO_MANY_GIFT_CARDS"),
        ({"allowWithCoupons": False}, {"giftCardCodes": ["DCZG-AAAA-AAAA-AAAA-AAAA"], "couponCode": "SAVE10"},
         "GIFT_CARD_WITH_COUPON"),
        ({"storeCreditEnabled": False}, {"useStoreCredit": True}, "STORE_CREDIT_OFF"),
        ({"storeCreditWithGiftCards": False}, {"useStoreCredit": True, "giftCardCodes": ["DCZG-AAAA-AAAA-AAAA-AAAA"]},
         "STORE_CREDIT_WITH_GIFT_CARD"),
        ({"storeCreditWithCoupons": False}, {"useStoreCredit": True, "couponCode": "SAVE10"},
         "STORE_CREDIT_WITH_COUPON"),
    ])
    def test_combinations_the_store_does_not_allow(self, client, auth, admin_auth, catalogue, settings_documents,
                                                   coupon, settings, body, code):
        client.put("/api/admin/gift-cards/settings", headers=admin_auth, json=settings)
        fill_bag(client, auth)
        response = client.post("/api/checkout/tenders", headers=auth, json=body)
        assert response.status_code == 422 and response.json()["error_code"] == code

    def test_the_preview_explains_points_that_cannot_be_used(self, client, db, auth, admin_auth, catalogue,
                                                             settings_documents):
        fill_bag(client, auth)
        none = client.post("/api/checkout/tenders", headers=auth, json={"points": 500}).json()["data"]
        assert none["points"]["applied"] == 0 and none["messages"] == ["You don't have points to spend yet."]

        give_points(client, admin_auth, 1000)
        save_loyalty(db, minRedeemPoints=300)
        small = client.post("/api/checkout/tenders", headers=auth, json={"points": 200}).json()["data"]
        assert small["points"]["applied"] == 0 and "at least 300" in small["messages"][0]

    @pytest.mark.parametrize("points,code", [(1001, "POINTS_OVER_LIMIT"), (50, "POINTS_UNDER_MINIMUM")])
    def test_placing_an_order_with_points_out_of_bounds(self, client, auth, admin_auth, catalogue, settings_documents,
                                                        points, code):
        give_points(client, admin_auth, 5000)
        fill_bag(client, auth)
        body = place(client, auth, points=points, expect=409)
        assert body["error_code"] == code

    def test_placing_an_order_with_no_points_at_all(self, client, auth, catalogue, settings_documents):
        fill_bag(client, auth)
        body = place(client, auth, points=100, expect=409)
        assert body["error_code"] == "POINTS_NOT_ALLOWED"

    def test_placing_an_order_with_no_store_credit(self, client, auth, catalogue, settings_documents):
        fill_bag(client, auth)
        body = place(client, auth, store_credit=True, expect=409)
        assert body["error_code"] == "NO_STORE_CREDIT"

    def test_placing_an_order_with_an_unusable_card(self, client, db, auth, admin_auth, catalogue,
                                                    settings_documents, mailbox):
        code = issue_card(client, admin_auth, mailbox, 300)
        card_for(db, code).status = "disabled"
        db.flush()
        fill_bag(client, auth)
        body = place(client, auth, cards=[code], expect=409)
        assert body["error_code"] == "GIFT_CARD_UNUSABLE" and code[-4:] in body["message"]


class TestTendersGoBack:
    @pytest.fixture()
    def tendered(self, client, db, auth, admin_auth, gateway, catalogue, settings_documents, mailbox):
        """₹1,000: points ₹100, a gift card ₹300, store credit ₹200, the gateway ₹400 -- and unpaid."""
        code = issue_card(client, admin_auth, mailbox, 300)
        grant_credit(client, admin_auth, 200)
        give_points(client, admin_auth, 1000)
        fill_bag(client, auth)
        placed = place(client, auth, cards=[code], store_credit=True, points=200)
        assert placed["amount"] == 40000 and placed["order"]["status"] == "pending"
        assert card_for(db, code).balance == 0 and store_credit.balance(db, "CUS001") == 0
        assert spendable(db) == 800
        return {"placed": placed, "code": code}

    def assert_all_back(self, db, code):
        assert card_for(db, code).balance == 30000 and card_for(db, code).status == "active"
        assert store_credit.balance(db, "CUS001") == 20000
        assert spendable(db) == 1000

    def test_cancelling_returns_every_tender(self, client, db, auth, tendered):
        placed = tendered["placed"]
        response = client.post(f"/api/orders/{placed['order']['id']}/cancel", headers=auth,
                               json={"reason": "Changed my mind"})
        assert response.status_code == 200, response.text
        self.assert_all_back(db, tendered["code"])

        invoice = client.get(f"/api/invoices/{placed['invoiceId']}", headers=auth).json()["data"]
        assert invoice["tenderTotal"] == 60000 and invoice["tenderRefundable"] == 0
        assert {t["label"] for t in invoice["tenders"]} == {
            "Reward points", "Store credit", f"Gift card ending {tendered['code'][-4:]}"}

    def test_the_payment_window_closing_returns_every_tender(self, client, db, tendered):
        from app.services.payment_expiry import sweep

        lapse(db, tendered["placed"]["order"]["id"])
        assert sweep(db) == 1
        self.assert_all_back(db, tendered["code"])
        # Released once: a second pass gives nothing more.
        tenders.release_for_order(db, db.get(Order, tendered["placed"]["order"]["id"]))
        self.assert_all_back(db, tendered["code"])

    def test_a_card_that_expired_meanwhile_returns_its_share_as_store_credit(self, client, db, auth, tendered):
        card = card_for(db, tendered["code"])
        card.expires_at = datetime.utcnow() - timedelta(minutes=1)
        db.flush()

        client.post(f"/api/orders/{tendered['placed']['order']['id']}/cancel", headers=auth,
                    json={"reason": "Changed my mind"})

        assert card_for(db, tendered["code"]).balance == 0
        assert store_credit.balance(db, "CUS001") == 20000 + 30000
        entry = db.query(StoreCreditTransaction).filter_by(kind="gift-card-refund").one()
        assert entry.amount == 30000

    def test_a_card_with_nobody_to_credit_is_logged_not_lost_silently(self, client, db, tendered):
        card = card_for(db, tendered["code"])
        card.status = "disabled"
        db.flush()
        assert gift_cards.restore(db, card.id, 100, order_id="ORD-X", key="lost:1") == "lost"
        assert gift_cards.restore(db, card.id, 0, order_id="ORD-X", key="lost:2") == "card"

    def test_paying_the_rest_keeps_the_tenders_spent(self, client, db, auth, gateway, tendered):
        from tests.integration.test_payment_security import verify

        placed = tendered["placed"]
        ref = placed["gateway"]["orderReference"]
        gateway.responses["/payments/pay_tend01"] = captured(ref, "pay_tend01", 40000)

        assert verify(client, auth, placed, "pay_tend01").status_code == 200

        from app.models import Invoice

        invoice = fresh(db, Invoice, placed["invoiceId"])
        assert invoice.amount_paid == invoice.grand_total == 100000
        assert store_credit.balance(db, "CUS001") == 0 and spendable(db) == 800


class TestSharingARefund:
    """`split_refund` and `reverse_for_refund` at their edges, on an order the mock provider settled."""

    @pytest.fixture()
    def paid(self, client, db, auth, admin_auth, catalogue, settings_documents, mailbox):
        code = issue_card(client, admin_auth, mailbox, 300)
        fill_bag(client, auth)
        placed = place(client, auth, cards=[code])
        from app.models import Invoice, Payment

        return {"placed": placed, "code": code, "invoice": db.get(Invoice, placed["invoiceId"]),
                "payment": db.get(Payment, placed["paymentId"])}

    def test_the_share_follows_what_each_paid(self, db, paid):
        # The card paid 30%, the gateway 70%.
        assert tenders.split_refund(db, paid["invoice"], paid["payment"], 10000) == (7000, 3000)

    def test_more_than_both_can_return_is_refused(self, db, paid):
        with pytest.raises(ConflictError) as raised:
            tenders.split_refund(db, paid["invoice"], paid["payment"], 100001)
        assert raised.value.error_code == "REFUND_EXCEEDS_PAYMENT"

    def test_when_the_tender_has_nothing_left_the_gateway_takes_the_rest(self, db, paid):
        for row in tenders.tenders_for(db, paid["placed"]["order"]["id"]):
            row.reversed_amount = row.amount
        db.flush()
        assert tenders.split_refund(db, paid["invoice"], paid["payment"], 10000) == (10000, 0)

    def test_an_invoice_with_no_tenders_goes_wholly_to_the_gateway(self, client, db, auth, catalogue,
                                                                   settings_documents):
        from app.models import Invoice, Payment

        fill_bag(client, auth)
        placed = place(client, auth)
        invoice, payment = db.get(Invoice, placed["invoiceId"]), db.get(Payment, placed["paymentId"])
        assert tenders.split_refund(db, invoice, payment, 5000) == (5000, 0)
        assert tenders.tender_total(None) == 0

    def test_reversing_does_nothing_without_a_tender_share_or_an_order(self, db, paid):
        from app.models import Refund

        nothing = Refund(order_id=paid["placed"]["order"]["id"], tender_amount=0)
        tenders.reverse_for_refund(db, nothing)
        orphan = Refund(order_id="ORD-GONE", tender_amount=500)
        tenders.reverse_for_refund(db, orphan)
        assert card_for(db, paid["code"]).balance == 0

    def test_reversing_twice_returns_once(self, client, db, admin_auth, paid):
        refund = client.post("/api/admin/billing/refunds", headers=admin_auth, json={
            "invoiceId": paid["placed"]["invoiceId"], "amount": 100000, "reason": "Returned"}).json()["data"]
        assert refund["tenderAmount"] == 30000
        assert card_for(db, paid["code"]).balance == 30000

        from app.models import Refund

        tenders.reverse_for_refund(db, db.get(Refund, refund["id"]))
        assert card_for(db, paid["code"]).balance == 30000
