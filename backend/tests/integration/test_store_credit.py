"""Store credit: the ledger, the portal, paying with it, and getting it back."""

from __future__ import annotations

import pytest

from app.core import rate_limit
from app.models import Payment, StoreCreditAccount, StoreCreditTransaction
from app.services import store_credit
from tests.integration.wallet_helpers import fill_bag, mailbox, place, refund  # noqa: F401

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


def grant(client, admin_auth, amount, kind="grant", reason="Sorry for the late parcel", key=""):
    return client.post("/api/admin/store-credit/CUS001", headers=admin_auth,
                       json={"kind": kind, "amount": amount, "reason": reason, "requestKey": key})


class TestLedger:
    def test_a_grant_adds_and_is_recorded(self, client, db, auth, admin_auth, customer, mailbox):  # noqa: F811
        response = grant(client, admin_auth, 250)
        assert response.status_code == 201, response.text
        assert store_credit.balance(db, "CUS001") == 25000
        entry = db.query(StoreCreditTransaction).one()
        assert (entry.kind, entry.amount, entry.balance_after, entry.admin_id) == ("grant", 25000, 25000, "ADM001")
        mine = client.get("/api/account/store-credit", headers=auth).json()["data"]
        assert mine["balance"] == 250 and mine["items"][0]["reason"] == "Sorry for the late parcel"
        assert mailbox and "Store credit added" in mailbox[0]["subject"]

    def test_removing_more_than_there_is_refused(self, client, db, admin_auth, customer, mailbox):  # noqa: F811
        grant(client, admin_auth, 100)
        response = grant(client, admin_auth, 150, kind="revoke", reason="Granted by mistake")
        assert response.status_code == 409 and response.json()["error_code"] == "INSUFFICIENT_STORE_CREDIT"
        assert store_credit.balance(db, "CUS001") == 10000
        grant(client, admin_auth, 40, kind="revoke", reason="Partly granted by mistake")
        assert store_credit.balance(db, "CUS001") == 6000

    @pytest.mark.parametrize("body", [
        {"kind": "grant", "amount": 100, "reason": "no"},
        {"kind": "grant", "amount": 0, "reason": "A fine reason"},
        {"kind": "redeem", "amount": 100, "reason": "A fine reason"},
        {"kind": "grant", "amount": 200000, "reason": "A fine reason"},
    ])
    def test_bad_adjustments(self, client, admin_auth, customer, body):
        assert client.post("/api/admin/store-credit/CUS001", headers=admin_auth, json=body).status_code == 422

    def test_a_double_click_posts_once(self, client, db, admin_auth, customer, mailbox):  # noqa: F811
        grant(client, admin_auth, 100, key="click-1")
        grant(client, admin_auth, 100, key="click-1")
        assert store_credit.balance(db, "CUS001") == 10000
        assert db.query(StoreCreditTransaction).count() == 1

    def test_the_balance_is_the_sum_of_the_ledger(self, client, db, admin_auth, customer, mailbox):  # noqa: F811
        grant(client, admin_auth, 100)
        grant(client, admin_auth, 50, kind="goodwill")
        grant(client, admin_auth, 30, kind="revoke", reason="Correction to an earlier grant")
        total = sum(t.amount for t in db.query(StoreCreditTransaction).all())
        assert total == db.get(StoreCreditAccount, "CUS001").balance == 12000

    def test_portal_listing_and_permissions(self, client, admin_auth, editor, customer, mailbox):  # noqa: F811
        grant(client, admin_auth, 100)
        data = client.get("/api/admin/store-credit?withBalance=true", headers=admin_auth).json()["data"]
        assert data["outstanding"] == 100 and data["items"][0]["customer"]["id"] == "CUS001"
        ledger = client.get("/api/admin/store-credit/CUS001", headers=admin_auth).json()["data"]
        assert ledger["items"][0]["by"] == "Manoj Rajan"
        token = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"}
                            ).json()["data"]["token"]["accessToken"]
        assert grant(client, {"Authorization": f"Bearer {token}"}, 100).status_code == 403


class TestPaying:
    def test_credit_pays_part_of_an_order(self, client, db, auth, admin_auth, catalogue, settings_documents,
                                          mailbox):  # noqa: F811
        grant(client, admin_auth, 400)
        fill_bag(client, auth)
        placed = place(client, auth, store_credit=True)
        assert placed["amount"] == 60000
        assert store_credit.balance(db, "CUS001") == 0
        assert placed["order"]["totals"]["storeCreditAmount"] == 400

    def test_asking_to_use_credit_you_dont_have(self, client, auth, catalogue, settings_documents, customer):
        fill_bag(client, auth)
        error = place(client, auth, store_credit=True, expect=409)
        assert error["error_code"] == "NO_STORE_CREDIT"

    def test_cancelling_returns_the_credit(self, client, db, auth, admin_auth, catalogue, settings_documents,
                                           mailbox):  # noqa: F811
        grant(client, admin_auth, 2000)
        fill_bag(client, auth)
        placed = place(client, auth, store_credit=True)
        assert placed["amount"] == 0 and store_credit.balance(db, "CUS001") == 100000
        client.post(f"/api/orders/{placed['order']['id']}/cancel", headers=auth, json={"reason": "No longer needed"})
        db.expire_all()
        assert store_credit.balance(db, "CUS001") == 200000
        kinds = [t.kind for t in db.query(StoreCreditTransaction).order_by(StoreCreditTransaction.id)]
        assert kinds == ["grant", "redeem", "restore"]

    def test_a_refund_returns_credit_in_proportion(self, client, db, auth, admin_auth, catalogue, settings_documents,
                                                    mailbox):  # noqa: F811
        grant(client, admin_auth, 250)
        fill_bag(client, auth)
        placed = place(client, auth, store_credit=True)
        refund(client, admin_auth, placed["invoiceId"], 100000)
        db.expire_all()
        assert store_credit.balance(db, "CUS001") == 25000
        payment = db.get(Payment, placed["paymentId"])
        assert payment.refunded_amount == 75000 and payment.status == "refunded"

    def test_store_credit_and_coupons_can_be_kept_apart(self, client, auth, admin_auth, catalogue, settings_documents,
                                                         coupon, mailbox):  # noqa: F811
        grant(client, admin_auth, 100)
        client.put("/api/admin/gift-cards/settings", headers=admin_auth, json={"storeCreditWithCoupons": False})
        fill_bag(client, auth)
        error = place(client, auth, store_credit=True, coupon="SAVE10", expect=422)
        assert error["error_code"] == "STORE_CREDIT_WITH_COUPON"


class TestPaidInFull:
    def test_tender_as_the_method_when_credit_covers_it(self, client, db, auth, admin_auth, catalogue,
                                                        settings_documents, mailbox):  # noqa: F811
        grant(client, admin_auth, 2000)
        fill_bag(client, auth)
        placed = place(client, auth, method="tender", store_credit=True)
        assert placed["amount"] == 0 and placed["order"]["paymentMethod"]

    def test_tender_alone_is_refused_when_it_doesnt_cover_it(self, client, auth, admin_auth, catalogue,
                                                             settings_documents, mailbox):  # noqa: F811
        grant(client, admin_auth, 100)
        fill_bag(client, auth)
        error = place(client, auth, method="tender", store_credit=True, expect=422)
        assert error["error_code"] == "PAYMENT_METHOD_REQUIRED"
