"""
Reward points: earning on delivery, pending then spendable, spending at
checkout within the rules, and taking points back on cancellations, refunds
and returns — including when they've already been spent.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.core import rate_limit
from app.models import LoyaltyAccount, LoyaltyLot, LoyaltyTransaction, Order
from app.services import loyalty
from tests.integration.wallet_helpers import fill_bag, mailbox, place, refund  # noqa: F401
from tests.integration.fulfilment_helpers import advance

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


def deliver(client, admin_auth, order_id):
    """Picked, packed, shipped and delivered, the way the store does it (docs/order-fulfilment.md)."""
    advance(client, admin_auth, order_id, "delivered")


def release_all(db, customer_id="CUS001"):
    for lot in db.query(LoyaltyLot).filter_by(customer_id=customer_id).all():
        lot.available_at = datetime.utcnow() - timedelta(seconds=1)
    db.flush()
    loyalty.release_due(db)


def give(client, admin_auth, points, kind="manual_credit", reason="Welcome bonus points"):
    return client.post("/api/admin/loyalty/customers/CUS001/adjust", headers=admin_auth,
                       json={"kind": kind, "points": points, "reason": reason})


def available(db):
    db.expire_all()
    return loyalty.spendable(db, "CUS001")


class TestEarning:
    def test_nothing_is_earned_when_an_order_is_placed(self, client, db, auth, catalogue, settings_documents):
        fill_bag(client, auth)
        place(client, auth)
        assert db.query(LoyaltyTransaction).count() == 0

    def test_delivery_earns_pending_points(self, client, db, auth, admin_auth, catalogue, settings_documents,
                                           mailbox):  # noqa: F811
        fill_bag(client, auth)
        placed = place(client, auth)
        deliver(client, admin_auth, placed["order"]["id"])
        earned = db.query(LoyaltyTransaction).one()
        # ₹1,000 incl. 5% GST → taxable ₹952.38; 5 points per ₹100 → 47 points.
        assert (earned.kind, earned.points) == ("earned", 47)
        summary = client.get("/api/account/rewards", headers=auth).json()["data"]
        assert summary["pending"] == 47 and summary["available"] == 0
        assert any("earned" in m["subject"] for m in mailbox)
        release_all(db)
        assert available(db) == 47

    def test_earning_happens_once(self, client, db, auth, admin_auth, catalogue, settings_documents, mailbox):  # noqa: F811
        fill_bag(client, auth)
        placed = place(client, auth)
        deliver(client, admin_auth, placed["order"]["id"])
        loyalty.award_for_order(db, db.get(Order, placed["order"]["id"]))
        assert db.query(LoyaltyTransaction).filter_by(kind="earned").count() == 1

    def test_rules_exclude_and_multiply(self, client, db, auth, admin_auth, catalogue, settings_documents, mailbox):  # noqa: F811
        client.put("/api/admin/loyalty/settings", headers=admin_auth,
                   json={"excludeTax": False, "memberMultiplier": 2, "excludedProducts": ["PRD002"]})
        fill_bag(client, auth)
        fill_bag(client, auth, "PRD002")
        placed = place(client, auth)
        order = db.get(Order, placed["order"]["id"])
        assert loyalty.earnable(db, order) == 50  # PRD001 only, tax included; not a member
        order.membership_id = "MEM999"
        assert loyalty.earnable(db, order) == 100

    def test_tender_paid_value_does_not_earn(self, client, db, auth, admin_auth, catalogue, settings_documents,
                                             mailbox):  # noqa: F811
        client.post("/api/admin/store-credit/CUS001", headers=admin_auth,
                    json={"kind": "grant", "amount": 500, "reason": "Credit for the test"})
        fill_bag(client, auth)
        placed = place(client, auth, store_credit=True)
        assert loyalty.earnable(db, db.get(Order, placed["order"]["id"])) == 23  # half of 47, rounded down


class TestSpending:
    def test_points_pay_part_of_an_order(self, client, db, auth, admin_auth, catalogue, settings_documents, mailbox):  # noqa: F811
        give(client, admin_auth, 1000)
        fill_bag(client, auth)
        placed = place(client, auth, points=400)
        # 100 points = ₹50, so 400 points = ₹200.
        assert placed["amount"] == 80000 and placed["order"]["totals"]["pointsRedeemed"] == 400
        assert available(db) == 600
        assert db.get(LoyaltyAccount, "CUS001").lifetime_redeemed == 400

    def test_the_limits_apply(self, client, db, auth, admin_auth, catalogue, settings_documents, mailbox):  # noqa: F811
        give(client, admin_auth, 5000)
        fill_bag(client, auth)
        preview = client.post("/api/checkout/tenders", headers=auth, json={"points": 5000}).json()["data"]
        # At most half of ₹1,000 = ₹500 = 1,000 points.
        assert preview["points"]["maxPoints"] == 1000 and preview["points"]["applied"] == 1000
        assert preview["amountDue"] == 50000
        assert place(client, auth, points=1500, expect=409)["error_code"] == "POINTS_OVER_LIMIT"
        assert place(client, auth, points=50, expect=409)["error_code"] == "POINTS_UNDER_MINIMUM"

    def test_points_and_coupons_can_be_kept_apart(self, client, auth, admin_auth, catalogue, settings_documents,
                                                  coupon, mailbox):  # noqa: F811
        give(client, admin_auth, 1000)
        client.put("/api/admin/loyalty/settings", headers=admin_auth, json={"allowWithCoupons": False})
        fill_bag(client, auth)
        assert place(client, auth, points=200, coupon="SAVE10", expect=409)["error_code"] == "POINTS_NOT_ALLOWED"

    def test_you_cant_spend_points_you_dont_have(self, client, auth, catalogue, settings_documents, customer):
        fill_bag(client, auth)
        assert place(client, auth, points=200, expect=409)["error_code"] == "POINTS_NOT_ALLOWED"

    def test_cancelling_puts_points_back_in_the_same_lots(self, client, db, auth, admin_auth, catalogue,
                                                          settings_documents, mailbox):  # noqa: F811
        give(client, admin_auth, 1000)
        lot = db.query(LoyaltyLot).one()
        fill_bag(client, auth)
        placed = place(client, auth, points=400)
        client.post(f"/api/orders/{placed['order']['id']}/cancel", headers=auth, json={"reason": "Changed my mind"})
        assert available(db) == 1000
        db.refresh(lot)
        assert lot.remaining == 1000
        kinds = [t.kind for t in db.query(LoyaltyTransaction).order_by(LoyaltyTransaction.id)]
        assert kinds == ["manual_credit", "redeemed", "restored"]


class TestTakingBack:
    def _delivered(self, client, auth, admin_auth):
        fill_bag(client, auth)
        placed = place(client, auth)
        deliver(client, admin_auth, placed["order"]["id"])
        return placed

    def test_a_full_refund_takes_back_every_point(self, client, db, auth, admin_auth, catalogue, settings_documents,
                                                  mailbox):  # noqa: F811
        placed = self._delivered(client, auth, admin_auth)
        refund(client, admin_auth, placed["invoiceId"], 100000)
        assert loyalty.pending(db, "CUS001") == 0 and available(db) == 0
        assert db.get(LoyaltyAccount, "CUS001").lifetime_reversed == 47

    def test_partial_refunds_add_up_exactly(self, client, db, auth, admin_auth, catalogue, settings_documents,
                                            mailbox):  # noqa: F811
        placed = self._delivered(client, auth, admin_auth)
        refund(client, admin_auth, placed["invoiceId"], 30000)
        assert loyalty.pending(db, "CUS001") == 47 - 14  # 30% of 47, rounded
        refund(client, admin_auth, placed["invoiceId"], 70000)
        assert loyalty.pending(db, "CUS001") == 0

    def test_points_already_spent_become_debt(self, client, db, auth, admin_auth, catalogue, settings_documents,
                                              mailbox):  # noqa: F811
        placed = self._delivered(client, auth, admin_auth)
        release_all(db)
        give(client, admin_auth, 100)  # 147 spendable
        fill_bag(client, auth)
        place(client, auth, points=147)
        assert available(db) == 0
        # Items back after delivery are refunded (a return request ends in one), never a status change.
        refund(client, admin_auth, placed["invoiceId"], 100000)
        db.expire_all()
        assert db.get(LoyaltyAccount, "CUS001").debt == 47 and loyalty.spendable(db, "CUS001") == -47
        summary = client.get("/api/account/rewards", headers=auth).json()["data"]
        assert summary["available"] == 0 and summary["debt"] == 47
        # New points repay the debt first.
        give(client, admin_auth, 60)
        assert available(db) == 13

    def test_a_delivered_order_is_never_marked_returned(self, client, db, auth, admin_auth, catalogue,
                                                        settings_documents, mailbox):  # noqa: F811
        placed = self._delivered(client, auth, admin_auth)
        response = client.put(f"/api/admin/orders/{placed['order']['id']}/status", headers=admin_auth,
                              json={"status": "returned", "reason": "Customer sent it back"})
        assert response.status_code == 409
        assert loyalty.pending(db, "CUS001") == 47

    def test_a_return_to_origin_takes_back_nothing_it_never_gave(self, client, db, auth, admin_auth, catalogue,
                                                                 settings_documents, mailbox):  # noqa: F811
        fill_bag(client, auth)
        placed = place(client, auth)
        advance(client, admin_auth, placed["order"]["id"], "returned")
        assert loyalty.pending(db, "CUS001") == 0


class TestHousekeepingAndPortal:
    def test_points_expire_with_a_ledger_entry(self, client, db, admin_auth, customer, mailbox):  # noqa: F811
        give(client, admin_auth, 300)
        lot = db.query(LoyaltyLot).one()
        lot.expires_at = datetime.utcnow() - timedelta(minutes=1)
        db.flush()
        assert loyalty.expire_due(db) == 300
        assert available(db) == 0
        assert db.query(LoyaltyTransaction).filter_by(kind="expired").one().points == -300

    def test_expiring_points_are_warned_about_once(self, client, db, admin_auth, customer, mailbox):  # noqa: F811
        give(client, admin_auth, 300)
        lot = db.query(LoyaltyLot).one()
        lot.expires_at = datetime.utcnow() + timedelta(days=5)
        db.flush()
        assert loyalty.warn_expiring(db) == 1
        assert loyalty.warn_expiring(db) == 0
        assert any("expire" in m["subject"] for m in mailbox)

    def test_manual_adjustments_need_a_reason_and_balance(self, client, db, admin_auth, customer):
        assert give(client, admin_auth, 100, reason="no").status_code == 422
        assert give(client, admin_auth, 100, kind="manual_debit").status_code == 409
        give(client, admin_auth, 100)
        assert give(client, admin_auth, 40, kind="manual_debit", reason="Duplicate credit").status_code == 201
        assert available(db) == 60
        ledger = client.get("/api/admin/loyalty/ledger?customerId=CUS001", headers=admin_auth).json()["data"]
        assert [i["kind"] for i in ledger["items"]] == ["manual_debit", "manual_credit"]
        assert ledger["items"][0]["by"] == "Manoj Rajan"

    def test_dashboard_and_balances(self, client, admin_auth, customer):
        give(client, admin_auth, 200)
        metrics = client.get("/api/admin/loyalty/metrics", headers=admin_auth).json()["data"]
        assert metrics["outstanding"] == 200 and metrics["outstandingValue"] == 100
        balances = client.get("/api/admin/loyalty/balances", headers=admin_auth).json()["data"]
        assert balances["items"][0]["available"] == 200

    @pytest.mark.parametrize("body", [{"maxOrderPercent": 0}, {"redeemValue": 0}, {"memberMultiplier": 50},
                                      {"pendingDays": "x"}, {"excludedProducts": "PRD001"}])
    def test_bad_settings(self, client, admin_auth, body):
        assert client.put("/api/admin/loyalty/settings", headers=admin_auth, json=body).status_code == 422

    def test_permissions(self, client, auth, editor):
        token = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"}
                            ).json()["data"]["token"]["accessToken"]
        assert client.get("/api/admin/loyalty/metrics", headers={"Authorization": f"Bearer {token}"}).status_code == 403
        assert client.get("/api/account/rewards").status_code == 401
