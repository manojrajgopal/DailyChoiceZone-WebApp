"""
The referral programme: a code at sign-up, rewards only for a qualifying paid
order, once, never to yourself, held for review when it looks like the same
person, and taken back when the order doesn't stand.
"""

from __future__ import annotations

import pytest

from app.core import rate_limit
from app.models import Referral, SettingDocument, StoreCreditTransaction
from app.services import referrals, store_credit
from tests.integration.wallet_helpers import fill_bag, mailbox, place  # noqa: F401
from tests.integration.fulfilment_helpers import advance

pytestmark = pytest.mark.integration

FRIEND = {"email": "friend@example.com", "password": "Friend@1234", "firstName": "Ravi", "lastName": "Kumar",
          "phone": "9811122233"}


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def shop(client, catalogue, customer, settings_documents, admin_auth, auth):
    return client


def code_of(client, auth) -> str:
    body = client.get("/api/account/referrals", headers=auth).json()["data"]
    return body["code"]


def sign_up(client, code, expect=201, **overrides):
    response = client.post("/api/auth/register", json={**FRIEND, **overrides, "referralCode": code})
    assert response.status_code == expect, response.text
    data = response.json()
    if expect != 201:
        return data
    return {"Authorization": f"Bearer {data['data']['token']['accessToken']}"}, data["data"]["customer"]["id"]


def configure(db, **values):
    conf = {**referrals.DEFAULTS, **values}
    row = db.get(SettingDocument, "referrals")
    if row is None:
        db.add(SettingDocument(key="referrals", value=conf))
    else:
        row.value = conf
    db.flush()


def deliver(client, admin_auth, order_id):
    """Picked, packed, shipped and delivered, the way the store does it (docs/order-fulfilment.md)."""
    advance(client, admin_auth, order_id, "delivered")


def credit(db, customer_id) -> int:
    db.expire_all()
    return store_credit.balance(db, customer_id)


class TestSigningUp:
    def test_a_code_links_the_new_account(self, shop, auth, db, mailbox):  # noqa: F811
        code = code_of(shop, auth)
        assert shop.get(f"/api/referrals/check?code={code.lower()}").json()["data"]["valid"] is True
        _, friend_id = sign_up(shop, code)
        referral = db.query(Referral).filter_by(referee_id=friend_id).one()
        assert referral.referrer_id == "CUS001" and referral.status == "pending"
        assert any(m["key"] == "referrals" and m["to"] == "shopper@example.com" for m in mailbox)

    def test_an_unknown_code_is_refused_and_no_account_is_made(self, shop, db):
        from app.models import Customer

        body = sign_up(shop, "NOPE1234", expect=422)
        assert body["error_code"] == "REFERRAL_CODE_INVALID"
        assert db.query(Customer).filter_by(email="friend@example.com").count() == 0

    def test_your_own_code_cannot_be_used(self, shop, auth):
        """The same mailbox with a +tag (or, on Gmail, with dots) is the same person."""
        code = code_of(shop, auth)
        body = sign_up(shop, code, email="shopper+again@example.com", expect=422)
        assert body["error_code"] == "SELF_REFERRAL"

    def test_a_customer_is_referred_only_once(self, shop, auth, db):
        code = code_of(shop, auth)
        _, friend_id = sign_up(shop, code)
        with pytest.raises(Exception):
            db.add(Referral(referrer_id="CUS001", referee_id=friend_id, code=code, status="pending", flags=[],
                            created_at=referrals.datetime.utcnow(), updated_at=referrals.datetime.utcnow()))
            db.flush()
        db.rollback()

    def test_the_check_says_nothing_about_whose_code_it_is(self, shop, auth):
        body = shop.get(f"/api/referrals/check?code={code_of(shop, auth)}").json()["data"]
        assert "Asha" not in str(body) and "CUS001" not in str(body)


class TestRewards:
    def test_rewards_are_paid_once_the_first_order_is_delivered(self, shop, auth, admin_auth, db, mailbox):  # noqa: F811
        configure(db, rewardOn="delivered", holdSuspicious=False)
        friend_auth, friend_id = sign_up(shop, code_of(shop, auth))
        fill_bag(shop, friend_auth, "PRD001", 1)
        order = place(shop, friend_auth)["order"]
        assert credit(db, "CUS001") == 0  # paid, not yet delivered
        deliver(shop, admin_auth, order["id"])
        assert credit(db, "CUS001") == 10000 and credit(db, friend_id) == 10000
        referral = db.query(Referral).filter_by(referee_id=friend_id).one()
        assert referral.status == "rewarded" and referral.qualifying_order_id == order["id"]
        # Firing again — a second webhook, a repeated event — pays nothing more.
        referrals.on_order_delivered(db, db.get(referrals.Order, order["id"]))
        referrals.on_order_paid(db, db.get(referrals.Order, order["id"]))
        db.commit()
        assert credit(db, "CUS001") == 10000
        assert db.query(StoreCreditTransaction).filter_by(kind="referral").count() == 2

    def test_rewarding_on_payment(self, shop, auth, db):
        configure(db, rewardOn="paid", holdSuspicious=False)
        friend_auth, friend_id = sign_up(shop, code_of(shop, auth))
        fill_bag(shop, friend_auth, "PRD001", 1)
        place(shop, friend_auth)
        assert credit(db, "CUS001") == 10000 and credit(db, friend_id) == 10000

    def test_an_order_under_the_minimum_does_not_qualify(self, shop, auth, db):
        configure(db, rewardOn="paid", minOrderAmount=5000, holdSuspicious=False)
        friend_auth, friend_id = sign_up(shop, code_of(shop, auth))
        fill_bag(shop, friend_auth, "PRD001", 1)
        place(shop, friend_auth)
        assert credit(db, "CUS001") == 0
        assert db.query(Referral).filter_by(referee_id=friend_id).one().status == "pending"

    def test_points_rewards(self, shop, auth, db):
        from app.services import loyalty

        configure(db, rewardOn="paid", rewardType="points", referrerReward=250, refereeReward=100,
                  holdSuspicious=False)
        friend_auth, friend_id = sign_up(shop, code_of(shop, auth))
        fill_bag(shop, friend_auth, "PRD001", 1)
        place(shop, friend_auth)
        db.expire_all()
        assert loyalty.spendable(db, "CUS001") == 250

    def test_the_monthly_cap_stops_the_referrers_reward_only(self, shop, auth, db):
        configure(db, rewardOn="paid", maxRewardsPerMonth=1, holdSuspicious=False)
        code = code_of(shop, auth)
        for index in range(2):
            friend_auth, friend_id = sign_up(shop, code, email=f"friend{index}@example.com", phone=f"98111222{index}0")
            fill_bag(shop, friend_auth, "PRD001", 1)
            place(shop, friend_auth)
            assert credit(db, friend_id) == 10000
        assert credit(db, "CUS001") == 10000

    def test_a_cancelled_order_takes_both_rewards_back(self, shop, auth, db):
        configure(db, rewardOn="paid", holdSuspicious=False)
        friend_auth, friend_id = sign_up(shop, code_of(shop, auth))
        fill_bag(shop, friend_auth, "PRD001", 1)
        order = place(shop, friend_auth)["order"]
        response = shop.post(f"/api/orders/{order['id']}/cancel", headers=friend_auth, json={"reason": "No"})
        assert response.status_code == 200, response.text
        assert credit(db, "CUS001") == 0 and credit(db, friend_id) == 0
        assert db.query(Referral).filter_by(referee_id=friend_id).one().status == "reversed"


class TestAbuse:
    def test_the_same_phone_is_held_for_review_then_approved(self, shop, auth, admin_auth, db):
        configure(db, rewardOn="paid")
        friend_auth, friend_id = sign_up(shop, code_of(shop, auth), phone="9876500001")
        fill_bag(shop, friend_auth, "PRD001", 1)
        place(shop, friend_auth)
        referral = db.query(Referral).filter_by(referee_id=friend_id).one()
        assert referral.status == "review" and "same_phone" in referral.flags
        assert credit(db, "CUS001") == 0
        listing = shop.get("/api/admin/referrals?status=review", headers=admin_auth).json()["data"]
        assert listing["counts"]["review"] == 1
        response = shop.post(f"/api/admin/referrals/{referral.id}/approve", headers=admin_auth, json={})
        assert response.status_code == 200, response.text
        assert credit(db, "CUS001") == 10000
        # Approving twice pays nothing more.
        assert shop.post(f"/api/admin/referrals/{referral.id}/approve", headers=admin_auth, json={}).status_code == 409
        assert credit(db, "CUS001") == 10000

    def test_delivery_to_the_referrers_address_is_held_and_can_be_rejected(self, shop, auth, admin_auth, db):
        configure(db, rewardOn="paid")
        friend_auth, friend_id = sign_up(shop, code_of(shop, auth))
        fill_bag(shop, friend_auth, "PRD001", 1)
        place(shop, friend_auth)  # the helper's address is the referrer's own
        referral = db.query(Referral).filter_by(referee_id=friend_id).one()
        assert "shared_address" in referral.flags
        assert shop.post(f"/api/admin/referrals/{referral.id}/reject", headers=admin_auth,
                         json={"note": "x"}).status_code == 422
        response = shop.post(f"/api/admin/referrals/{referral.id}/reject", headers=admin_auth,
                             json={"note": "Same household"})
        assert response.status_code == 200 and response.json()["data"]["status"] == "rejected"
        assert credit(db, "CUS001") == 0

    def test_a_switched_off_code_cannot_be_used(self, shop, auth, admin_auth):
        code = code_of(shop, auth)
        assert shop.post("/api/admin/referrals/codes/CUS001/disable", headers=admin_auth).status_code == 200
        assert sign_up(shop, code, expect=422)["error_code"] == "REFERRAL_CODE_INVALID"


class TestPrivacyAndPermissions:
    def test_a_customer_sees_only_their_own_referrals_with_names_shortened(self, shop, auth, db, other_customer, client):
        configure(db, holdSuspicious=False)
        sign_up(shop, code_of(shop, auth))
        mine = shop.get("/api/account/referrals", headers=auth).json()["data"]
        assert mine["stats"]["invited"] == 1
        assert mine["referrals"][0]["name"] == "Ravi K."
        assert "friend@example.com" not in str(mine)
        token = client.post("/api/auth/login", json={"email": other_customer.email, "password": "Customer@123"})
        other = {"Authorization": f"Bearer {token.json()['data']['token']['accessToken']}"}
        assert shop.get("/api/account/referrals", headers=other).json()["data"]["stats"]["invited"] == 0

    def test_rewards_come_from_settings_not_the_request(self, shop, auth, db):
        configure(db, rewardOn="paid", holdSuspicious=False)
        response = shop.post("/api/auth/register", json={**FRIEND, "referralCode": code_of(shop, auth),
                                                         "referrerReward": 99999, "reward": 99999})
        assert response.status_code == 201
        friend_auth = {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}
        fill_bag(shop, friend_auth, "PRD001", 1)
        place(shop, friend_auth)
        assert credit(db, "CUS001") == 10000

    def test_the_programme_settings_are_validated_and_permission_checked(self, shop, admin_auth, auth):
        assert shop.get("/api/admin/referrals/settings", headers=auth).status_code == 403
        response = shop.put("/api/admin/referrals/settings", headers=admin_auth, json={"rewardOn": "signup"})
        assert response.status_code == 422
        response = shop.put("/api/admin/referrals/settings", headers=admin_auth,
                            json={"referrerReward": 150, "rewardOn": "paid"})
        assert response.status_code == 200 and response.json()["data"]["referrerReward"] == 150
        metrics = shop.get("/api/admin/referrals/metrics", headers=admin_auth).json()["data"]
        assert metrics["signups"] == 0
