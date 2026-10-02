"""
The referral programme, the edges: settings validation, code generation that
runs out of attempts, sign-up checks (blank and switched-off codes, Gmail's
dots, several sign-ups from one network), the rules that decide when an order
qualifies, paying and taking back rewards that were already posted or spent,
expiry, and the portal's decisions on the paths the main tests don't walk.

Orders and referrals are written directly, so each rule is tested on its own.
"""

from __future__ import annotations

import contextlib
from datetime import datetime, timedelta

import pytest

from app.core import rate_limit
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.core.security import hash_password
from app.models import Customer, Order, Referral, ReferralCode, SettingDocument
from app.services import referrals, store_credit

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def sent(monkeypatch):
    """The referral emails asked for, by recipient."""
    from app.services import email as email_service

    out = []
    monkeypatch.setattr(email_service, "notify", lambda db, key, **kw: out.append((key, kw["to"])) or True)
    return out


def configure(db, **values):
    conf = {**referrals.DEFAULTS, **values}
    row = db.get(SettingDocument, "referrals")
    if row is None:
        db.add(SettingDocument(key="referrals", value=conf))
    else:
        row.value = conf
    db.flush()


def person(db, cid, email, first="Ravi", phone="9811122233", status="active"):
    row = Customer(id=cid, email=email, password_hash=hash_password("Friend@1234"), first_name=first,
                   last_name="Kumar", phone=phone, status=status, joined_at=datetime.utcnow())
    db.add(row)
    db.flush()
    return row


def referral(db, referee_id, *, status="pending", referrer_id="CUS001", expires_in_days=60, **extra):
    now = datetime.utcnow()
    row = Referral(referrer_id=referrer_id, referee_id=referee_id, code="ASHATEST", status=status, flags=[],
                   signup_ip_hash="", reward_type=extra.pop("reward_type", "store_credit"),
                   referrer_reward=extra.pop("referrer_reward", 0), referee_reward=extra.pop("referee_reward", 0),
                   reversal_shortfall=0, note="", expires_at=now + timedelta(days=expires_in_days),
                   created_at=now, updated_at=now, **extra)
    db.add(row)
    db.flush()
    return row


def order(db, oid, customer_id, *, total=1500.0, status="confirmed", payment_status="paid", placed_at=None,
          line1="", pincode="", phone=""):
    row = Order(id=oid, order_number=f"DCZ-R-{oid}", customer_id=customer_id, customer_name="Ravi Kumar",
                customer_email="friend@example.com", placed_at=placed_at or datetime.utcnow(), status=status,
                payment_status=payment_status, payment_method="upi", total=total, subtotal=total, item_count=1,
                shipping_line1=line1, shipping_pincode=pincode, shipping_phone=phone)
    db.add(row)
    db.flush()
    return row


def credit(db, customer_id):
    db.expire_all()
    return store_credit.balance(db, customer_id)


@pytest.fixture()
def friend(db, customer):
    return person(db, "CUS200", "friend@example.com")


# ---------------------------------------------------------------- settings


class TestSettings:
    @pytest.mark.parametrize("payload, words", [
        ({"referrerReward": "lots"}, "must be a number"),
        ({"refereeReward": 10001}, "between 0 and 10000"),
        ({"windowDays": 0}, "between 1 and 365"),
        ({"maxRewardsPerMonth": 2.5}, "whole number"),
        ({"rewardType": "cash"}, "store credit or reward points"),
        ({"referrerReward": 0, "refereeReward": 0}, "at least one side"),
    ])
    def test_bad_settings_are_refused(self, client, db, admin_auth, payload, words):
        response = client.put("/api/admin/referrals/settings", headers=admin_auth, json=payload)
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_SETTING"
        assert words in response.json()["message"]
        assert db.get(SettingDocument, "referrals") is None

    def test_points_allow_larger_rewards_and_a_programme_off_may_reward_nothing(self, client, db, admin_auth):
        response = client.put("/api/admin/referrals/settings", headers=admin_auth,
                              json={"rewardType": "points", "referrerReward": 50000})
        assert response.status_code == 200 and response.json()["data"]["referrerReward"] == 50000
        response = client.put("/api/admin/referrals/settings", headers=admin_auth,
                              json={"enabled": False, "referrerReward": 0, "refereeReward": 0})
        assert response.status_code == 200
        stored = client.get("/api/admin/referrals/settings", headers=admin_auth).json()["data"]
        assert stored["enabled"] is False and stored["rewardType"] == "points" and stored["refereeReward"] == 0

    def test_the_rules_shown_to_customers_name_the_unit(self):
        assert referrals.rules({**referrals.DEFAULTS, "rewardType": "points"})["unit"] == "points"
        assert referrals.rules(referrals.DEFAULTS)["unit"] == "store credit"


# ------------------------------------------------------------------- codes


class TestCodes:
    def test_a_code_is_made_once_and_kept(self, db, customer):
        first = referrals.code_for(db, customer)
        assert first.code.startswith("ASHA") and len(first.code) == 8
        assert referrals.code_for(db, customer).id == first.id

    def test_a_name_without_letters_gets_the_shops_stem(self, db, customer):
        person(db, "CUS201", "digits@example.com", first="123")
        assert referrals.code_for(db, db.get(Customer, "CUS201")).code.startswith("DCZ")

    def test_running_out_of_unique_codes_is_a_conflict(self, db, customer, other_customer, monkeypatch):
        db.add(ReferralCode(customer_id="CUS002", code="ASHAAAAA", disabled=False, created_at=datetime.utcnow()))
        db.commit()
        monkeypatch.setattr(referrals.secrets, "choice", lambda alphabet: "A")
        with pytest.raises(ConflictError) as error:
            referrals.code_for(db, customer)
        assert error.value.error_code == "REFERRAL_CODE_FAILED"

    def test_a_code_made_only_of_punctuation_is_not_valid(self, db, customer):
        assert referrals.check_code(db, "--!!--") == {"valid": False, "code": None, "rules": None}

    def test_a_code_of_a_blocked_referrer_is_not_valid(self, db, customer):
        code = referrals.code_for(db, customer).code
        customer.status = "blocked"
        db.flush()
        assert referrals.check_code(db, code)["valid"] is False

    def test_switching_a_code_needs_a_code_and_a_known_action(self, client, db, customer, other_customer,
                                                             admin_auth):
        response = client.post("/api/admin/referrals/codes/CUS002/disable", headers=admin_auth)
        assert response.status_code == 404 and response.json()["error_code"] == "REFERRAL_CODE_NOT_FOUND"
        referrals.code_for(db, customer)
        response = client.post("/api/admin/referrals/codes/CUS001/delete", headers=admin_auth)
        assert response.status_code == 404 and response.json()["error_code"] == "NOT_FOUND"
        response = client.post("/api/admin/referrals/codes/CUS001/enable", headers=admin_auth)
        assert response.status_code == 200 and response.json()["data"]["disabled"] is False


# ----------------------------------------------------------------- sign-up


class TestSigningUp:
    def test_no_code_or_a_programme_switched_off_links_nothing(self, db, customer, friend, sent):
        assert referrals.attach_at_signup(db, friend, None) is None
        assert referrals.attach_at_signup(db, friend, "   ") is None
        code = referrals.code_for(db, customer).code
        configure(db, enabled=False)
        assert referrals.attach_at_signup(db, friend, code) is None
        assert db.query(Referral).count() == 0 and sent == []

    def test_gmail_ignores_dots_and_tags_so_the_same_mailbox_cannot_refer_itself(self, db, sent):
        owner = person(db, "CUS210", "asha.rao@gmail.com", first="Asha", phone="")
        again = person(db, "CUS211", "asharao+shop@googlemail.com", first="Asha", phone="")
        code = referrals.code_for(db, owner).code
        with pytest.raises(ValidationError) as error:
            referrals.attach_at_signup(db, again, code)
        assert error.value.error_code == "SELF_REFERRAL"

    def test_a_sign_up_without_an_address_keeps_no_network_hash(self, db, customer, friend, sent):
        row = referrals.attach_at_signup(db, friend, referrals.code_for(db, customer).code, ip="")
        assert row.signup_ip_hash == "" and row.flags == []
        assert sent == [("referrals", "shopper@example.com")]

    def test_several_sign_ups_from_one_network_are_flagged(self, db, customer, sent):
        code = referrals.code_for(db, customer).code
        rows = []
        for index in range(3):
            newcomer = person(db, f"CUS22{index}", f"newcomer{index}@example.com", phone=f"98000000{index}0")
            rows.append(referrals.attach_at_signup(db, newcomer, code, ip="203.0.113.7"))
        assert [r.flags for r in rows] == [[], [], ["same_network"]]
        assert rows[0].signup_ip_hash and "203.0.113.7" not in rows[0].signup_ip_hash

    def test_the_same_phone_is_flagged_at_sign_up(self, db, customer, sent):
        twin = person(db, "CUS230", "twin@example.com", phone="+91 98765 00001")
        row = referrals.attach_at_signup(db, twin, referrals.code_for(db, customer).code)
        assert row.flags == ["same_phone"]


# -------------------------------------------------------------- qualifying


class TestQualifying:
    def test_an_unpaid_delivered_order_does_not_qualify(self, db, friend):
        row = referral(db, "CUS200")
        referrals.on_order_delivered(db, order(db, "ORDR01", "CUS200", payment_status="cod-pending",
                                               status="delivered"))
        assert row.status == "pending"

    def test_nothing_is_paid_while_the_programme_is_off(self, db, friend):
        configure(db, enabled=False, rewardOn="paid")
        row = referral(db, "CUS200")
        referrals.on_order_paid(db, order(db, "ORDR02", "CUS200"))
        assert row.status == "pending" and credit(db, "CUS001") == 0

    def test_a_referral_already_decided_is_left_alone(self, db, friend):
        configure(db, rewardOn="paid", holdSuspicious=False)
        row = referral(db, "CUS200", status="rejected")
        referrals.on_order_paid(db, order(db, "ORDR03", "CUS200"))
        assert row.status == "rejected"

    def test_a_cancelled_or_unpaid_order_does_not_qualify(self, db, friend):
        configure(db, rewardOn="paid", holdSuspicious=False)
        row = referral(db, "CUS200")
        referrals._qualify(db, order(db, "ORDR04", "CUS200", status="cancelled"))
        referrals._qualify(db, order(db, "ORDR05", "CUS200", payment_status="failed"))
        assert row.status == "pending" and row.qualifying_order_id is None

    def test_an_order_after_the_window_expires_the_referral(self, db, friend):
        configure(db, rewardOn="paid", holdSuspicious=False)
        row = referral(db, "CUS200", expires_in_days=-1)
        referrals.on_order_paid(db, order(db, "ORDR06", "CUS200"))
        assert row.status == "expired" and row.note == "No qualifying order in time."

    def test_an_order_with_no_address_is_not_a_shared_address(self, db, friend, sent):
        configure(db, rewardOn="paid")  # holding suspicious ones on
        row = referral(db, "CUS200")
        referrals.on_order_paid(db, order(db, "ORDR07", "CUS200"))
        assert row.flags == [] and row.status == "rewarded"
        assert credit(db, "CUS001") == 10000 and credit(db, "CUS200") == 10000

    def test_delivery_to_an_address_the_referrer_ordered_to_before_is_flagged(self, db, friend):
        configure(db, rewardOn="paid")
        order(db, "ORDR08", "CUS001", line1="77 Lake View", pincode="560034")
        row = referral(db, "CUS200")
        referrals.on_order_paid(db, order(db, "ORDR09", "CUS200", line1="77, LAKE VIEW", pincode="560034",
                                          phone="9876500001"))
        assert row.status == "review" and row.flags == ["same_phone", "shared_address"]

    def test_delivery_to_an_unrelated_address_is_not_flagged(self, db, friend, sent):
        configure(db, rewardOn="paid")
        row = referral(db, "CUS200")
        referrals.on_order_paid(db, order(db, "ORDR12", "CUS200", line1="9 Hill Road", pincode="400050"))
        assert row.flags == [] and row.status == "rewarded"
    def test_a_reward_already_posted_is_not_paid_twice(self, db, friend, sent):
        configure(db, rewardOn="paid", holdSuspicious=False)
        row = referral(db, "CUS200")
        store_credit.post(db, "CUS200", kind="referral", amount=10000, reason="earlier",
                          idempotency_key=f"referral:{row.id}:referee")
        referrals.on_order_paid(db, order(db, "ORDR10", "CUS200"))
        assert row.status == "rewarded" and row.referee_reward == 0 and row.referrer_reward == 10000
        assert credit(db, "CUS200") == 10000

    def test_an_inactive_referrer_earns_but_is_not_emailed(self, db, friend, sent):
        configure(db, rewardOn="paid", holdSuspicious=False)
        db.get(Customer, "CUS001").status = "blocked"
        row = referral(db, "CUS200")
        referrals.on_order_paid(db, order(db, "ORDR11", "CUS200"))
        assert row.status == "rewarded"
        assert [to for _, to in sent] == ["friend@example.com"]


# -------------------------------------------------------------- reversals


class TestReversals:
    def test_an_order_no_referral_waited_on(self, db, friend):
        referrals.on_order_reversed(db, order(db, "ORDV01", "CUS200"), reason="Cancelled")
        assert db.query(Referral).count() == 0

    def test_a_held_referral_goes_back_to_waiting(self, db, friend):
        held = order(db, "ORDV02", "CUS200")
        row = referral(db, "CUS200", status="review", qualifying_order_id=held.id, qualified_at=datetime.utcnow())
        referrals.on_order_reversed(db, held, reason="Cancelled")
        assert row.status == "pending" and row.qualifying_order_id is None and row.qualified_at is None

    def test_a_rejected_referral_is_left_as_it_is(self, db, friend):
        placed = order(db, "ORDV03", "CUS200")
        row = referral(db, "CUS200", status="rejected", qualifying_order_id=placed.id)
        referrals.on_order_reversed(db, placed, reason="Cancelled")
        assert row.status == "rejected"

    def test_credit_already_spent_is_recorded_as_a_shortfall(self, db, friend):
        placed = order(db, "ORDV04", "CUS200")
        row = referral(db, "CUS200", status="rewarded", qualifying_order_id=placed.id, referrer_reward=10000,
                       referee_reward=0)
        store_credit.post(db, "CUS001", kind="referral", amount=4000, reason="what is left")
        referrals.on_order_reversed(db, placed, reason="Returned")
        assert row.status == "reversed" and row.reversal_shortfall == 6000
        assert "had already been spent" in row.note and credit(db, "CUS001") == 0

    def test_credit_spent_in_full_is_all_shortfall(self, db, friend):
        placed = order(db, "ORDV07", "CUS200")
        row = referral(db, "CUS200", status="rewarded", qualifying_order_id=placed.id, referrer_reward=10000)
        referrals.on_order_reversed(db, placed, reason="Returned")
        assert row.status == "reversed" and row.reversal_shortfall == 10000 and credit(db, "CUS001") == 0
    def test_a_take_back_already_posted_is_not_taken_twice(self, db, friend):
        placed = order(db, "ORDV05", "CUS200")
        row = referral(db, "CUS200", status="rewarded", qualifying_order_id=placed.id, referrer_reward=5000)
        store_credit.post(db, "CUS001", kind="referral", amount=5000, reason="reward")
        store_credit.post(db, "CUS001", kind="referral-reversed", amount=-1, reason="earlier",
                          idempotency_key=f"referral:{row.id}:referrer:reversed")
        referrals.on_order_reversed(db, placed, reason="Returned")
        assert row.status == "reversed" and row.reversal_shortfall == 0
        assert credit(db, "CUS001") == 4999

    def test_points_are_taken_back_as_points(self, db, friend):
        from app.services import loyalty

        placed = order(db, "ORDV06", "CUS200")
        row = referral(db, "CUS200", status="rewarded", qualifying_order_id=placed.id, reward_type="points",
                       referrer_reward=250, referee_reward=100)
        loyalty.grant(db, "CUS001", 250, kind="referral", reason="reward", key=f"referral:{row.id}:referrer")
        loyalty.grant(db, "CUS200", 100, kind="referral", reason="reward", key=f"referral:{row.id}:referee")
        db.flush()
        referrals.on_order_reversed(db, placed, reason="Returned")
        db.flush()
        assert row.status == "reversed" and row.reversal_shortfall == 0
        assert loyalty.spendable(db, "CUS001") == 0 and loyalty.spendable(db, "CUS200") == 0


# ------------------------------------------------------------------ expiry


class TestExpiry:
    def test_pending_referrals_past_their_window_expire(self, db, customer):
        late = referral(db, person(db, "CUS240", "late@example.com").id, expires_in_days=-2)
        fresh = referral(db, person(db, "CUS241", "fresh@example.com", phone="9811100000").id)
        held = referral(db, person(db, "CUS242", "held@example.com", phone="9811100001").id, status="review",
                        expires_in_days=-2)
        assert referrals.expire_due(db) == 1
        db.expire_all()
        assert db.get(Referral, late.id).status == "expired"
        assert db.get(Referral, fresh.id).status == "pending" and db.get(Referral, held.id).status == "review"

    def test_the_background_pass(self, db, customer, monkeypatch):
        from app.core import database

        late = referral(db, person(db, "CUS243", "late2@example.com").id, expires_in_days=-1)
        monkeypatch.setattr(database, "SessionLocal", lambda: contextlib.nullcontext(db))
        referrals._sweep_once()
        db.expire_all()
        assert db.get(Referral, late.id).status == "expired"

        def broken(db, now=None):
            raise RuntimeError("locked")

        monkeypatch.setattr(referrals, "expire_due", broken)
        with pytest.raises(RuntimeError):
            referrals._sweep_once()


# --------------------------------------------------------------- the portal


class TestDecisions:
    def test_an_unknown_referral(self, client, admin_auth):
        for action in ("approve", "reject"):
            response = client.post(f"/api/admin/referrals/987654/{action}", headers=admin_auth,
                                   json={"note": "Not a real one"})
            assert response.status_code == 404 and response.json()["error_code"] == "REFERRAL_NOT_FOUND"

    def test_a_held_referral_whose_order_was_cancelled_cannot_be_approved(self, client, db, friend, admin_auth):
        held = order(db, "ORDD01", "CUS200", status="cancelled")
        row = referral(db, "CUS200", status="review", qualifying_order_id=held.id)
        response = client.post(f"/api/admin/referrals/{row.id}/approve", headers=admin_auth, json={})
        assert response.status_code == 409 and response.json()["error_code"] == "REFERRAL_STATE"
        assert credit(db, "CUS001") == 0

    def test_approving_with_a_note_keeps_the_note(self, client, db, friend, admin_auth, sent):
        held = order(db, "ORDD02", "CUS200")
        row = referral(db, "CUS200", status="review", qualifying_order_id=held.id)
        response = client.post(f"/api/admin/referrals/{row.id}/approve", headers=admin_auth,
                               json={"note": "Checked: different households"})
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["status"] == "rewarded" and data["note"] == "Checked: different households"
        assert data["order"]["orderNumber"] == "DCZ-R-ORDD02" and data["referrerReward"] == 100.0
        db.expire_all()
        assert db.get(Referral, row.id).decided_by == "ADM001"

    def test_a_rewarded_referral_cannot_be_rejected(self, client, db, friend, admin_auth):
        row = referral(db, "CUS200", status="rewarded")
        response = client.post(f"/api/admin/referrals/{row.id}/reject", headers=admin_auth,
                               json={"note": "Changed my mind"})
        assert response.status_code == 409 and response.json()["error_code"] == "REFERRAL_STATE"

    def test_an_unknown_decision(self, db, admin, friend):
        row = referral(db, "CUS200")
        with pytest.raises(ValidationError) as error:
            referrals.decide(db, admin, row.id, "escalate")
        assert error.value.error_code == "INVALID_ACTION"
        with pytest.raises(NotFoundError):
            referrals.decide(db, admin, row.id + 1000, "approve")

    def test_the_list_searches_by_name_and_code(self, client, db, friend, admin_auth):
        referral(db, "CUS200")
        by_name = client.get("/api/admin/referrals?q=Ravi", headers=admin_auth).json()["data"]
        assert by_name["pagination"]["total"] == 1 and by_name["items"][0]["referee"]["email"] == "friend@example.com"
        by_code = client.get("/api/admin/referrals?q=ashatest", headers=admin_auth).json()["data"]
        assert by_code["pagination"]["total"] == 1
        nobody = client.get("/api/admin/referrals?q=zzz-nobody", headers=admin_auth).json()["data"]
        assert nobody["items"] == [] and nobody["counts"]["pending"] == 1


class TestCustomerView:
    def test_a_programme_switched_off_shows_the_existing_code_only(self, client, db, customer, auth):
        configure(db, enabled=False)
        assert client.get("/api/account/referrals", headers=auth).json()["data"]["code"] is None
        assert db.query(ReferralCode).count() == 0  # none made while it is off
        configure(db, enabled=True)
        code = client.get("/api/account/referrals", headers=auth).json()["data"]["code"]
        configure(db, enabled=False)
        assert client.get("/api/account/referrals", headers=auth).json()["data"]["code"] == code

    def test_a_switched_off_code_is_not_shared(self, client, db, customer, auth, admin_auth):
        client.get("/api/account/referrals", headers=auth)
        client.post("/api/admin/referrals/codes/CUS001/disable", headers=admin_auth)
        data = client.get("/api/account/referrals", headers=auth).json()["data"]
        assert data["code"] is None and data["codeDisabled"] is True and data["shareUrl"] is None

    def test_the_new_customer_sees_how_they_joined(self, client, db, friend):
        referral(db, "CUS200", status="rewarded", referee_reward=10000)
        token = client.post("/api/auth/login", json={"email": "friend@example.com", "password": "Friend@1234"})
        headers = {"Authorization": f"Bearer {token.json()['data']['token']['accessToken']}"}
        joined = client.get("/api/account/referrals", headers=headers).json()["data"]["joinedWith"]
        assert joined["status"] == "rewarded" and joined["reward"].endswith("store credit")
        assert joined["expiresAt"] is None

    def test_a_missing_person_has_a_neutral_name(self):
        assert referrals._display_name(None) == "A customer"
