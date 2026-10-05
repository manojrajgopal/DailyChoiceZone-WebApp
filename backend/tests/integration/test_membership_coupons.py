"""
Coupon limits and audiences, and the membership programme.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from tests.integration.test_orders import add, place
from tests.integration.test_payment_security import gateway  # noqa: F401 — fixture
from tests.integration.fulfilment_helpers import advance

pytestmark = pytest.mark.integration


def make_coupon(client, admin_auth, **overrides):
    body = {
        "code": "SAVE10", "description": "10% off", "type": "percent", "value": 10,
        "minSubtotal": 0, "startsAt": "2026-01-01T00:00:00Z", "active": True,
    }
    body.update(overrides)
    response = client.post("/api/admin/coupons", headers=admin_auth, json=body)
    assert response.status_code in (200, 201), response.text
    return response.json()["data"]


def order_with(client, auth, code):
    add(client, auth, "PRD001", 1)
    return place(client, auth, couponCode=code)


@pytest.fixture()
def second_auth(client, other_customer):
    from tests.conftest import PASSWORD

    response = client.post("/api/auth/login", json={"email": other_customer.email, "password": PASSWORD})
    return {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}


# -------------------------------------------------------------------- limits


class TestCouponLimits:
    def test_each_customer_can_use_it_n_times(self, client, auth, admin_auth, catalogue, settings_documents):
        make_coupon(client, admin_auth, perCustomerLimit=2)
        assert order_with(client, auth, "SAVE10").status_code == 201
        assert order_with(client, auth, "SAVE10").status_code == 201
        third = order_with(client, auth, "SAVE10")
        assert third.status_code == 422
        assert "maximum 2 times" in third.json()["message"]

    def test_the_total_is_counted_across_all_customers(
        self, client, auth, second_auth, admin_auth, catalogue, settings_documents
    ):
        make_coupon(client, admin_auth, usageLimit=2)
        assert order_with(client, auth, "SAVE10").status_code == 201
        assert order_with(client, second_auth, "SAVE10").status_code == 201
        # Both customers' uses count toward the one total.
        assert order_with(client, auth, "SAVE10").status_code == 422
        listed = client.get("/api/admin/coupons", headers=admin_auth).json()["data"]
        coupon = next(c for c in listed if c["code"] == "SAVE10")
        assert coupon["usageCount"] == 2 and coupon["customersUsed"] == 2

    def test_both_limits_together(self, client, auth, second_auth, admin_auth, catalogue, settings_documents):
        make_coupon(client, admin_auth, usageLimit=3, perCustomerLimit=1)
        assert order_with(client, auth, "SAVE10").status_code == 201
        assert order_with(client, auth, "SAVE10").status_code == 422  # their own limit
        assert order_with(client, second_auth, "SAVE10").status_code == 201

    def test_a_cancelled_order_gives_the_use_back(self, client, auth, admin_auth, catalogue, settings_documents):
        make_coupon(client, admin_auth, perCustomerLimit=1, usageLimit=1)
        order = order_with(client, auth, "SAVE10").json()["data"]["order"]
        client.post(f"/api/orders/{order['id']}/cancel", headers=auth, json={"reason": ""})
        assert order_with(client, auth, "SAVE10").status_code == 201

    def test_an_unpaid_order_that_times_out_gives_the_use_back(
        self, client, auth, admin_auth, gateway, catalogue, settings_documents, db
    ):
        from app.services.payment_expiry import sweep
        from tests.integration.test_payment_security import lapse, place as place_prepaid

        make_coupon(client, admin_auth, perCustomerLimit=1)
        placed = place_prepaid(client, auth, couponCode="SAVE10").json()["data"]
        lapse(db, placed["order"]["id"])
        assert sweep(db) == 1
        assert order_with(client, auth, "SAVE10").status_code == 201

    def test_the_bag_says_why_a_code_does_not_apply(self, client, auth, admin_auth, catalogue, settings_documents):
        make_coupon(client, admin_auth, minSubtotal=99999)
        add(client, auth, "PRD001", 1)
        cart = client.get("/api/cart?coupon=SAVE10", headers=auth).json()["data"]
        assert cart["appliedCoupon"] is None
        assert "more to use SAVE10" in cart["couponError"]


# ------------------------------------------------------------------ audiences


class TestCouponDates:
    """The admin picks days in India; the server keeps UTC."""

    def test_a_coupon_started_today_in_india_works_today(
        self, client, auth, admin_auth, catalogue, settings_documents
    ):
        # Midnight IST today is 18:30 UTC yesterday — the browser sends that.
        today_ist = datetime.utcnow() + timedelta(hours=5, minutes=30)
        start = datetime(today_ist.year, today_ist.month, today_ist.day) - timedelta(hours=5, minutes=30)
        make_coupon(client, admin_auth, startsAt=start.strftime("%Y-%m-%dT%H:%M:%S.000Z"))
        assert order_with(client, auth, "SAVE10").status_code == 201

    def test_a_zoned_time_is_stored_as_utc(self):
        from app.utils.dates import parse_dt

        assert parse_dt("2026-09-29T00:00:00+05:30") == datetime(2026, 9, 28, 18, 30)
        assert parse_dt("2026-09-30T00:00:00Z") == datetime(2026, 9, 30, 0, 0)

    def test_a_scheduled_code_says_when_it_starts(self, client, auth, admin_auth, catalogue, settings_documents):
        make_coupon(client, admin_auth, startsAt="2099-03-04T18:30:00Z")  # 5 Mar 2099 in IST
        response = order_with(client, auth, "SAVE10")
        assert response.status_code == 422
        assert "starts on 5 Mar 2099" in response.json()["message"]

    def test_the_list_says_how_often_you_have_used_it(
        self, client, auth, admin_auth, catalogue, settings_documents
    ):
        make_coupon(client, admin_auth, perCustomerLimit=2)
        assert order_with(client, auth, "SAVE10").status_code == 201
        listed = {c["code"]: c for c in client.get("/api/coupons", headers=auth).json()["data"]}
        assert listed["SAVE10"]["timesUsed"] == 1 and listed["SAVE10"]["perCustomerLimit"] == 2
        guest = {c["code"]: c for c in client.get("/api/coupons").json()["data"]}
        assert guest["SAVE10"]["timesUsed"] is None


class TestCouponAudiences:
    def test_selected_customers_only(self, client, auth, second_auth, customer, admin_auth, catalogue, settings_documents):
        make_coupon(client, admin_auth, audience="selected", customerIds=[customer.id])
        # Shown to them, not to others.
        assert [c["code"] for c in client.get("/api/coupons", headers=auth).json()["data"]] == ["SAVE10"]
        assert client.get("/api/coupons", headers=second_auth).json()["data"] == []
        assert order_with(client, second_auth, "SAVE10").status_code == 422
        assert order_with(client, auth, "SAVE10").status_code == 201

    def test_a_selected_coupon_needs_customers(self, client, admin_auth):
        response = client.post(
            "/api/admin/coupons",
            headers=admin_auth,
            json={"code": "NOBODY", "type": "flat", "value": 50, "audience": "selected", "customerIds": []},
        )
        assert response.status_code == 422

    def test_members_only(self, client, auth, admin_auth, customer, db, catalogue, settings_documents):
        make_coupon(client, admin_auth, audience="members")
        assert order_with(client, auth, "SAVE10").status_code == 422
        make_member(db, customer)
        assert order_with(client, auth, "SAVE10").status_code == 201

    def test_first_order_only(self, client, auth, admin_auth, catalogue, settings_documents):
        make_coupon(client, admin_auth, audience="first-order")
        assert order_with(client, auth, "SAVE10").status_code == 201
        second = order_with(client, auth, "SAVE10")
        assert second.status_code == 422 and "first order" in second.json()["message"]

    def test_a_private_code_is_not_listed_but_still_works(self, client, auth, admin_auth, catalogue, settings_documents):
        make_coupon(client, admin_auth, showInStore=False)
        assert client.get("/api/coupons", headers=auth).json()["data"] == []
        assert order_with(client, auth, "SAVE10").status_code == 201


# ----------------------------------------------------------------- membership


def make_plan(client, admin_auth, **overrides):
    body = {
        "name": "Yearly", "durationMonths": 12, "price": 200, "freeDelivery": True,
        "memberDiscountPercent": 5, "extraReturnDays": 15, "earlyAccess": True,
    }
    body.update(overrides)
    response = client.post("/api/admin/memberships/plans", headers=admin_auth, json=body)
    assert response.status_code == 201, response.text
    return response.json()["data"]


def make_member(db, customer, **benefits):
    from app.models import CustomerMembership, MembershipPlan

    now = datetime.utcnow()
    plan = MembershipPlan(
        id="MBP900", name="Test", duration_months=12, price=200, created_at=now, updated_at=now
    )
    db.add(plan)
    db.flush()
    membership = CustomerMembership(
        id="MEM900", customer_id=customer.id, plan_id=plan.id, plan_name="Test", duration_months=12,
        status="active", starts_at=now - timedelta(days=1), ends_at=now + timedelta(days=300),
        amount=20000, benefits={
            "freeDelivery": True, "freeDeliveriesPerMonth": None, "memberDiscountPercent": 5,
            "extraReturnDays": 15, **benefits,
        },
        created_at=now, updated_at=now,
    )
    db.add(membership)
    db.flush()
    return membership


class TestMembership:
    def test_the_store_manages_plans(self, client, admin_auth):
        plan = make_plan(client, admin_auth)
        assert plan["pricePerMonth"] == pytest.approx(16.67, abs=0.01)
        updated = client.put(f"/api/admin/memberships/plans/{plan['id']}", headers=admin_auth, json={"price": 249})
        assert updated.json()["data"]["price"] == 249
        public = client.get("/api/memberships").json()["data"]
        assert public["name"] == "Choice Circle" and len(public["plans"]) == 1
        deleted = client.delete(f"/api/admin/memberships/plans/{plan['id']}", headers=admin_auth)
        assert deleted.json()["data"]["outcome"] == "deleted"

    def test_the_programme_can_be_renamed(self, client, admin_auth):
        client.put("/api/admin/memberships/programme", headers=admin_auth, json={"name": "DCZ Select"})
        assert client.get("/api/memberships").json()["data"]["name"] == "DCZ Select"

    def test_a_plan_somebody_bought_is_retired_not_deleted(self, client, admin_auth, db, customer):
        make_member(db, customer)
        deleted = client.delete("/api/admin/memberships/plans/MBP900", headers=admin_auth)
        assert deleted.json()["data"]["outcome"] == "retired"

    def test_members_get_free_delivery_and_their_discount(self, client, auth, db, customer, catalogue, settings_documents):
        add(client, auth, "PRD002", 1)  # ₹2,000
        before = client.get("/api/cart", headers=auth).json()["data"]
        make_member(db, customer)
        after = client.get("/api/cart", headers=auth).json()["data"]
        assert after["breakdown"]["memberDiscount"] == 10000  # 5% of ₹2,000, in paise
        assert after["breakdown"]["grandTotal"] < before["breakdown"]["grandTotal"]
        assert after["membership"]["discountPercent"] == 5

        order = place(client, auth).json()["data"]["order"]
        assert order["totals"]["memberDiscount"] == 100.0

    def test_the_monthly_free_delivery_quota(self, client, auth, db, customer, catalogue, settings_documents):
        from app.models import Order

        add(client, auth, "PRD001", 1)
        fee = client.get("/api/cart", headers=auth).json()["data"]["breakdown"]["shipping"]
        if fee == 0:
            # Only a delivery the membership paid for counts toward the quota.
            from app.services import billing

            settings = billing.store_settings(db)
            settings.setdefault("shipping", {})["standardFee"] = 75
            settings["shipping"]["freeDeliveryThreshold"] = 999999
            from app.models import SettingDocument

            document = db.get(SettingDocument, "store")
            if document is None:
                pytest.skip("no store settings document in this fixture")
            document.value = settings
            db.flush()
            fee = client.get("/api/cart", headers=auth).json()["data"]["breakdown"]["shipping"]
        assert fee > 0

        make_member(db, customer, freeDeliveriesPerMonth=1)
        first = client.get("/api/cart", headers=auth).json()["data"]
        assert first["membership"]["freeDelivery"] is True and first["breakdown"]["shipping"] == 0
        place(client, auth)
        assert db.query(Order).filter(Order.membership_id == "MEM900").one().member_free_delivery is True
        add(client, auth, "PRD001", 1)
        again = client.get("/api/cart", headers=auth).json()["data"]
        assert again["membership"]["freeDeliveriesLeft"] == 0
        assert again["membership"]["freeDelivery"] is False

    def test_buying_a_plan(self, client, auth, admin_auth):
        plan = make_plan(client, admin_auth)
        started = client.post("/api/memberships/checkout", headers=auth, json={"planId": plan["id"]})
        assert started.status_code == 201, started.text
        data = started.json()["data"]
        # The development provider settles at once; Razorpay returns a handoff.
        if data["gateway"] is None:
            mine = client.get("/api/memberships/me", headers=auth).json()["data"]
            assert mine["membership"]["status"] == "active"
            assert mine["membership"]["benefits"]["memberDiscountPercent"] == 5

    def test_members_get_a_longer_return_window(self, client, auth, admin_auth, db, customer, catalogue, settings_documents):
        make_member(db, customer)
        add(client, auth, "PRD001", 1)
        order = place(client, auth).json()["data"]["order"]
        advance(client, admin_auth, order["id"], "delivered")
        eligibility = client.get(f"/api/orders/{order['id']}/returns", headers=auth).json()["data"]["eligibility"]
        assert eligibility["windowDays"] == 30  # 15 + 15 for members
