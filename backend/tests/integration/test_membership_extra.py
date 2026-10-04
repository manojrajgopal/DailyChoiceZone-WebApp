"""
Buying a membership through the gateway, and running the programme.

A plan is paid for like an order: the browser opens Razorpay, comes back with
three references, and the server checks the signature and reads the payment
back before anything is activated. The webhook does the same independently.
Signatures here are real HMACs over the stubbed gateway's key secret.

The portal side -- plans, the programme switch, the member list, ending a
membership -- is exercised with the validation each form has.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

import app.main  # noqa: F401 -- import the app before any fixture patches `get_provider`
from app.core import rate_limit
from app.models import CustomerMembership, MembershipPlan, WebhookEvent
from app.services import membership as service
from tests.integration.test_payment_security import (  # noqa: F401 -- `gateway` is a fixture
    captured,
    gateway,
    refunds_sent,
    sign,
    webhook,
)

pytestmark = pytest.mark.integration

PLANS = "/api/admin/memberships/plans"


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


def fresh(db, model, key):
    row = db.get(model, key)
    db.refresh(row)
    return row


def make_plan(client, admin_auth, **overrides) -> dict:
    body = {"name": "Yearly", "durationMonths": 12, "price": 499, "freeDelivery": True,
            "freeDeliveriesPerMonth": 3, "memberDiscountPercent": 5, "extraReturnDays": 10}
    body.update(overrides)
    response = client.post(PLANS, headers=admin_auth, json=body)
    assert response.status_code == 201, response.text
    return response.json()["data"]


def checkout(client, auth, plan_id) -> dict:
    response = client.post("/api/memberships/checkout", headers=auth, json={"planId": plan_id})
    assert response.status_code == 201, response.text
    return response.json()["data"]


def confirm(client, auth, started, pay_id, *, secret=None):
    ref = started["gateway"]["orderReference"]
    signature = sign(f"{ref}|{pay_id}") if secret is None else sign(f"{ref}|{pay_id}", secret)
    return client.post(f"/api/memberships/{started['membershipId']}/verify", headers=auth, json={
        "razorpayOrderId": ref, "razorpayPaymentId": pay_id, "razorpaySignature": signature})


def capture_event(started, pay_id, *, event="payment.captured", **changes):
    entity = {"id": pay_id, "status": "captured", "order_id": started["gateway"]["orderReference"],
              "amount": started["gateway"]["amount"], "currency": "INR", "method": "upi",
              "notes": {"membershipId": started["membershipId"]}}
    entity.update(changes)
    return {"event": event, "payload": {"payment": {"entity": entity}}}


def login(client, person) -> dict:
    response = client.post("/api/auth/login", json={"email": person.email, "password": "Customer@123"})
    return {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}


@pytest.fixture()
def plan(client, admin_auth):
    return make_plan(client, admin_auth)


# ======================================================== buying a plan


class TestBuyingThroughTheGateway:
    def test_the_membership_waits_for_its_payment(self, client, db, auth, gateway, plan):
        started = checkout(client, auth, plan["id"])

        assert started["status"] == "pending" and started["membership"] is None
        handoff = started["gateway"]
        assert handoff["amount"] == 49900 and handoff["description"] == "Choice Circle · Yearly"
        sent = next(c for c in gateway.calls if c["path"] == "/orders")
        assert sent["json"]["notes"]["membershipId"] == started["membershipId"]
        assert service.active_membership(db, "CUS001") is None

    def test_a_verified_payment_starts_it_for_the_plans_length(self, client, db, auth, admin_auth, gateway, plan):
        started = checkout(client, auth, plan["id"])
        gateway.responses["/payments/pay_mem001"] = captured(started["gateway"]["orderReference"], "pay_mem001", 49900)

        response = confirm(client, auth, started, "pay_mem001")

        assert response.status_code == 200, response.text
        assert response.json()["message"] == "Welcome to Choice Circle!"
        summary = response.json()["data"]
        assert summary["status"] == "active" and summary["freeDeliveriesLeftThisMonth"] == 3
        row = fresh(db, CustomerMembership, started["membershipId"])
        assert row.gateway_payment_id == "pay_mem001" and row.ends_at == service.add_months(row.starts_at, 12)
        # Benefits are copied, so a later change to the plan alters nothing.
        client.put(f"{PLANS}/{plan['id']}", headers=admin_auth, json={"memberDiscountPercent": 20})
        assert fresh(db, CustomerMembership, started["membershipId"]).benefits["memberDiscountPercent"] == 5.0

        again = confirm(client, auth, started, "pay_mem001")
        assert again.status_code == 200 and fresh(db, CustomerMembership, started["membershipId"]).ends_at == row.ends_at

    def test_a_forged_signature_starts_nothing(self, client, db, auth, gateway, plan):
        started = checkout(client, auth, plan["id"])

        response = confirm(client, auth, started, "pay_memfake", secret="not_our_secret")

        assert response.status_code == 409 and response.json()["error_code"] == "PAYMENT_UNVERIFIED"
        assert fresh(db, CustomerMembership, started["membershipId"]).status == "pending"

    def test_a_declined_payment_starts_nothing(self, client, db, auth, gateway, plan):
        started = checkout(client, auth, plan["id"])
        gateway.responses["/payments/pay_memdec"] = {
            **captured(started["gateway"]["orderReference"], "pay_memdec", 49900), "status": "failed",
            "error_description": "Payment declined."}

        response = confirm(client, auth, started, "pay_memdec")

        assert response.status_code == 409 and response.json()["message"] == "Payment declined."

    def test_a_payment_for_less_than_the_plan_starts_nothing(self, client, db, auth, gateway, plan):
        started = checkout(client, auth, plan["id"])
        gateway.responses["/payments/pay_memlow"] = captured(started["gateway"]["orderReference"], "pay_memlow", 100)

        response = confirm(client, auth, started, "pay_memlow")

        assert response.status_code == 409 and response.json()["error_code"] == "AMOUNT_MISMATCH"
        assert fresh(db, CustomerMembership, started["membershipId"]).status == "pending"

    def test_an_abandoned_purchase_is_closed_and_kept_out_of_history(self, client, db, auth, gateway, plan):
        started = checkout(client, auth, plan["id"])
        pending_history = client.get("/api/memberships/me", headers=auth).json()["data"]["history"]
        assert pending_history == []

        assert client.post(f"/api/memberships/{started['membershipId']}/abandon", headers=auth).status_code == 200

        assert fresh(db, CustomerMembership, started["membershipId"]).status == "cancelled"
        closed = confirm(client, auth, started, "pay_memlate")
        assert closed.status_code == 409 and closed.json()["error_code"] == "MEMBERSHIP_CLOSED"
        mine = client.get("/api/memberships/me", headers=auth).json()["data"]
        assert mine["membership"] is None and [h["status"] for h in mine["history"]] == ["cancelled"]

    def test_someone_elses_purchase_is_not_there(self, client, auth, gateway, plan, other_customer):
        started = checkout(client, auth, plan["id"])
        theirs = login(client, other_customer)

        assert confirm(client, theirs, started, "pay_x").json()["error_code"] == "MEMBERSHIP_NOT_FOUND"
        assert client.post(f"/api/memberships/{started['membershipId']}/abandon",
                           headers=theirs).status_code == 404

    def test_a_second_term_starts_when_the_first_ends(self, client, db, auth, gateway, plan):
        first = checkout(client, auth, plan["id"])
        webhook(client, capture_event(first, "pay_term1"), event_id="evt_term1")
        second = checkout(client, auth, plan["id"])
        webhook(client, capture_event(second, "pay_term2"), event_id="evt_term2")

        one = fresh(db, CustomerMembership, first["membershipId"])
        two = fresh(db, CustomerMembership, second["membershipId"])
        assert two.starts_at == one.ends_at and two.ends_at == service.add_months(one.ends_at, 12)
        assert service.active_membership(db, "CUS001").id == one.id


class TestTheMembershipWebhook:
    def test_it_activates_once(self, client, db, auth, gateway, plan):
        started = checkout(client, auth, plan["id"])

        webhook(client, capture_event(started, "pay_memhook"), event_id="evt_mem_1")
        webhook(client, capture_event(started, "pay_memhook", event="order.paid"), event_id="evt_mem_2")

        assert db.get(WebhookEvent, "evt_mem_1").result == "activated membership"
        assert db.get(WebhookEvent, "evt_mem_2").result == "duplicate: already active"
        assert fresh(db, CustomerMembership, started["membershipId"]).gateway_payment_id == "pay_memhook"

    @pytest.mark.parametrize("changes,result", [
        ({"status": "authorized"}, "ignored: payment authorized"),
        ({"amount": 100}, "ignored: mismatch"),
        ({"order_id": "order_someone_else"}, "ignored: mismatch"),
        ({"notes": {"membershipId": "MEM_NOBODY"}}, "ignored: unknown membership"),
    ])
    def test_it_ignores_what_does_not_match(self, client, db, auth, gateway, plan, changes, result):
        started = checkout(client, auth, plan["id"])

        webhook(client, capture_event(started, "pay_membad", **changes), event_id="evt_mem_bad")

        assert db.get(WebhookEvent, "evt_mem_bad").result == result
        assert fresh(db, CustomerMembership, started["membershipId"]).status == "pending"

    # Regression: was a real bug, fixed alongside this test.
    def test_a_cancelled_membership_is_not_revived_by_a_second_event(self, client, db, auth, admin_auth, gateway,
                                                                     plan):
        started = checkout(client, auth, plan["id"])
        webhook(client, capture_event(started, "pay_revive"), event_id="evt_revive_1")
        assert client.post(f"/api/admin/memberships/{started['membershipId']}/cancel",
                           headers=admin_auth).status_code == 200

        webhook(client, capture_event(started, "pay_revive", event="order.paid"), event_id="evt_revive_2")

        assert fresh(db, CustomerMembership, started["membershipId"]).status == "cancelled"


class TestWhatCanBeBought:
    def test_a_retired_plan(self, client, admin_auth, auth, plan):
        client.put(f"{PLANS}/{plan['id']}", headers=admin_auth, json={"active": False})
        response = client.post("/api/memberships/checkout", headers=auth, json={"planId": plan["id"]})
        assert response.status_code == 409 and response.json()["error_code"] == "PLAN_RETIRED"

    def test_an_unknown_plan(self, client, auth):
        response = client.post("/api/memberships/checkout", headers=auth, json={"planId": "MBP999"})
        assert response.status_code == 404 and response.json()["error_code"] == "PLAN_NOT_FOUND"

    def test_the_programme_switched_off(self, client, db, admin_auth, auth, plan, customer):
        client.put("/api/admin/memberships/programme", headers=admin_auth, json={"enabled": False})

        response = client.post("/api/memberships/checkout", headers=auth, json={"planId": plan["id"]})
        assert response.status_code == 409 and response.json()["error_code"] == "PROGRAMME_OFF"
        public = client.get("/api/memberships").json()["data"]
        assert public["enabled"] is False and public["plans"] == []
        # Nor does an existing membership give anything while it is off.
        assert service.order_benefits(db, "CUS001")["membership"] is None


# ========================================================== the portal


class TestThePlans:
    @pytest.mark.parametrize("payload,code", [
        ({"name": "  "}, "PLAN_INCOMPLETE"),
        ({"durationMonths": 0}, "INVALID_DURATION"),
        ({"durationMonths": 61}, "INVALID_DURATION"),
        ({"durationMonths": "twelve"}, "INVALID_PLAN"),
        ({"price": 0.5}, "INVALID_PRICE"),
        ({"memberDiscountPercent": 51}, "INVALID_DISCOUNT"),
        ({"extraReturnDays": 61}, "INVALID_RETURN_DAYS"),
    ])
    def test_a_plan_that_is_refused(self, client, admin_auth, payload, code):
        body = {"name": "Monthly", "durationMonths": 1, "price": 99}
        body.update(payload)
        response = client.post(PLANS, headers=admin_auth, json=body)
        assert response.status_code == 422 and response.json()["error_code"] == code

    def test_unlimited_free_delivery_and_an_optional_compare_price(self, client, admin_auth):
        plan = make_plan(client, admin_auth, freeDeliveriesPerMonth=0, compareAtPrice="", badge="Best value")
        assert plan["freeDeliveriesPerMonth"] is None and plan["compareAtPrice"] is None
        updated = client.put(f"{PLANS}/{plan['id']}", headers=admin_auth,
                             json={"compareAtPrice": 699, "freeDeliveriesPerMonth": ""}).json()["data"]
        assert updated["compareAtPrice"] == 699.0 and updated["freeDeliveriesPerMonth"] is None

    def test_the_list_includes_retired_plans(self, client, admin_auth, plan):
        client.put(f"{PLANS}/{plan['id']}", headers=admin_auth, json={"active": False})
        other = make_plan(client, admin_auth, name="Monthly", durationMonths=1, price=59)
        listed = client.get(PLANS, headers=admin_auth).json()["data"]
        assert {p["id"] for p in listed} == {plan["id"], other["id"]}
        assert [p["id"] for p in client.get("/api/memberships").json()["data"]["plans"]] == [other["id"]]

    def test_a_missing_plan(self, client, admin_auth):
        assert client.put(f"{PLANS}/MBP999", headers=admin_auth, json={"price": 10}).status_code == 404
        assert client.delete(f"{PLANS}/MBP999", headers=admin_auth).json()["error_code"] == "PLAN_NOT_FOUND"

    def test_the_programme_needs_a_name(self, client, admin_auth):
        response = client.put("/api/admin/memberships/programme", headers=admin_auth, json={"name": "   "})
        assert response.status_code == 422 and response.json()["error_code"] == "NAME_REQUIRED"
        saved = client.put("/api/admin/memberships/programme", headers=admin_auth,
                           json={"tagline": "Members save more"}).json()["data"]
        assert saved == {"name": "Choice Circle", "tagline": "Members save more", "enabled": True}
        again = client.put("/api/admin/memberships/programme", headers=admin_auth, json={"name": "DCZ Plus"})
        assert again.json()["data"]["tagline"] == "Members save more"
        assert client.get("/api/admin/memberships/programme", headers=admin_auth).json()["data"]["name"] == "DCZ Plus"

    def test_the_portal_needs_the_customers_permission(self, client, editor):
        response = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"})
        headers = {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}
        assert client.get(PLANS, headers=headers).status_code == 403


def member(db, customer_id="CUS001", *, status="active", ends_in_days=30, membership_id="MEM800", plan_id="MBP800"):
    now = datetime.utcnow().replace(microsecond=0)
    if db.get(MembershipPlan, plan_id) is None:
        db.add(MembershipPlan(id=plan_id, name="Quarterly", duration_months=3, price=199, created_at=now,
                              updated_at=now))
        db.flush()
    row = CustomerMembership(
        id=membership_id, customer_id=customer_id, plan_id=plan_id, plan_name="Quarterly", duration_months=3,
        status=status, starts_at=now - timedelta(days=10), ends_at=now + timedelta(days=ends_in_days),
        amount=19900, benefits={"freeDelivery": True, "freeDeliveriesPerMonth": 2, "memberDiscountPercent": 3},
        created_at=now, updated_at=now, paid_at=now)
    db.add(row)
    db.flush()
    return row


class TestTheMembers:
    def test_a_lapsed_membership_expires_when_anyone_looks(self, client, db, auth, customer):
        member(db, ends_in_days=-1)

        mine = client.get("/api/memberships/me", headers=auth).json()["data"]

        assert mine["membership"] is None
        assert fresh(db, CustomerMembership, "MEM800").status == "expired"
        assert service.expire_lapsed(db) == 0

    def test_the_public_page_shows_the_shoppers_own_membership(self, client, db, auth, customer):
        member(db)
        data = client.get("/api/memberships", headers=auth).json()["data"]
        assert data["membership"]["planName"] == "Quarterly"
        assert data["membership"]["freeDeliveriesLeftThisMonth"] == 2
        assert client.get("/api/memberships").json()["data"]["membership"] is None

    def test_the_list_and_search(self, client, db, admin_auth, customer, other_customer):
        member(db)
        member(db, "CUS002", status="pending", membership_id="MEM801")

        everyone = client.get("/api/admin/memberships", headers=admin_auth).json()["data"]
        assert [m["id"] for m in everyone] == ["MEM800"] and everyone[0]["customerName"] == "Asha Rao"
        waiting = client.get("/api/admin/memberships", headers=admin_auth, params={"status": "pending"}).json()["data"]
        assert [m["id"] for m in waiting] == ["MEM801"]

        def search(**params):
            response = client.get("/api/admin/memberships/search", headers=admin_auth, params=params)
            assert response.status_code == 200, response.text
            return response.json()["data"]

        found = search()
        assert [m["id"] for m in found["items"]] == ["MEM800"]
        assert found["counts"] == {"active": 1, "pending": 1, "expired": 0, "cancelled": 0}
        assert found["plans"] == [{"id": "MBP800", "name": "Quarterly"}]
        # Identifiers only: a Membership ID or a Customer ID, exactly.
        assert [m["id"] for m in search(q="MEM800")["items"]] == ["MEM800"]
        assert [m["id"] for m in search(q="CUS002", status="pending")["items"]] == ["MEM801"]
        assert [m["id"] for m in search(customer="CUS002", status="pending")["items"]] == ["MEM801"]
        assert search(customer="CUS001", status="pending")["items"] == []
        assert search(q="MEM80")["items"] == []
        # Names, emails and plan names are not IDs.
        assert search(q="Asha Rao")["items"] == []
        assert search(q="someone.else", status="pending")["items"] == []
        assert search(q="Quarterly")["items"] == []
        assert search(plan="MBP800", q="nobody-at-all")["items"] == []
        # The plan filter is a Membership plan ID too, exactly.
        assert [m["id"] for m in search(plan="mbp800")["items"]] == ["MEM800"]
        for plan in ("MBP80", "MBP8000", "Quarterly"):
            assert search(plan=plan, status="pending")["items"] == [], plan
        # Longer IDs with the same start, and junk, match nothing (and never error).
        for text in ("MEM8000", "CUS0021", "'; DROP TABLE customer_memberships; --"):
            assert search(q=text)["items"] == [] and search(customer=text[:40])["items"] == [], text

    def test_ending_a_membership_now(self, client, db, admin_auth, customer):
        member(db)

        response = client.post("/api/admin/memberships/MEM800/cancel", headers=admin_auth)

        assert response.status_code == 200 and response.json()["data"]["status"] == "cancelled"
        assert service.active_membership(db, "CUS001") is None
        again = client.post("/api/admin/memberships/MEM800/cancel", headers=admin_auth)
        assert again.status_code == 409 and again.json()["error_code"] == "MEMBERSHIP_NOT_ACTIVE"
        missing = client.post("/api/admin/memberships/MEM999/cancel", headers=admin_auth)
        assert missing.status_code == 404 and missing.json()["error_code"] == "MEMBERSHIP_NOT_FOUND"

    def test_the_quota_resets_each_membership_month(self, db, customer):
        row = member(db)
        row.starts_at = datetime(2026, 1, 31, 9, 0, 0)
        assert service._period_start(row, datetime(2026, 3, 15)) == datetime(2026, 2, 28, 9, 0, 0)
        assert service._period_start(row, datetime(2026, 3, 31, 10)) == datetime(2026, 3, 31, 9, 0, 0)
        assert service._period_start(row, datetime(2026, 1, 31, 8)) == datetime(2026, 1, 31, 9, 0, 0)

    def test_express_delivery_is_never_waived(self, db, customer):
        member(db)
        benefits = service.order_benefits(db, "CUS001", delivery_method="express")
        assert benefits["freeDelivery"] is False and benefits["discountPercent"] == 3.0
        assert service.order_benefits(db, None)["membership"] is None
        assert service.is_member(db, "CUS001") and not service.is_member(db, None)
