"""
Coupons in the portal: creating, editing, disabling and deleting a code, and
the redemption bookkeeping checkout relies on (a use recorded under a lock,
given back when the order is cancelled).

`test_coupons.py` covers validation of a live code and
`test_membership_coupons.py` limits and audiences; this file covers the admin
side and the service's edges.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.models import Coupon, CouponUsage
from tests.integration.test_membership_coupons import make_coupon, order_with, second_auth  # noqa: F401

pytestmark = pytest.mark.integration


@pytest.fixture()
def placed_orders(db, customer):
    """Two orders a usage row can point at."""
    from tests.integration.test_orders import someone_elses_order

    db.add_all([someone_elses_order("ORD801", "DCZ801", customer), someone_elses_order("ORD802", "DCZ802", customer)])
    db.flush()


def admin_coupons(client, admin_auth) -> dict:
    response = client.get("/api/admin/coupons", headers=admin_auth)
    assert response.status_code == 200, response.text
    return {c["code"]: c for c in response.json()["data"]}


def save(client, admin_auth, coupon_id=None, **payload):
    if coupon_id:
        return client.put(f"/api/admin/coupons/{coupon_id}", headers=admin_auth, json=payload)
    return client.post("/api/admin/coupons", headers=admin_auth, json=payload)


class TestCreatingAndEditing:
    def test_a_minimal_coupon_is_upper_cased_and_live(self, client, db, admin_auth):
        response = save(client, admin_auth, code="  welcome5 ", type="flat", value=5, startsAt="2026-01-01T00:00:00Z")
        assert response.status_code == 201, response.text
        assert response.json()["data"]["code"] == "WELCOME5"
        listed = admin_coupons(client, admin_auth)["WELCOME5"]
        assert listed["status"] == "active" and listed["usageCount"] == 0
        assert listed["customersUsed"] == 0 and listed["totalDiscount"] == 0
        assert listed["audience"] == "everyone" and listed["showInStore"] is True

    def test_a_code_is_required(self, client, db, admin_auth):
        response = save(client, admin_auth, code="   ", type="flat", value=5)
        assert response.status_code == 422 and response.json()["error_code"] == "COUPON_INCOMPLETE"
        assert db.query(Coupon).count() == 0

    def test_a_code_in_use_is_refused(self, client, db, admin_auth, coupon):
        response = save(client, admin_auth, code="save10", type="flat", value=5)
        assert response.status_code == 409 and response.json()["error_code"] == "COUPON_CODE_TAKEN"
        assert db.query(Coupon).count() == 1

    def test_an_edit_changes_only_what_is_sent(self, client, db, admin_auth, coupon):
        response = save(client, admin_auth, "CPN001", description="Now 15% off", value=15, maxDiscount=None)
        assert response.status_code == 200 and response.json()["data"]["code"] == "SAVE10"
        db.expire_all()
        stored = db.get(Coupon, "CPN001")
        assert stored.description == "Now 15% off" and float(stored.value) == 15
        assert stored.max_discount is None and float(stored.min_subtotal) == 500

    def test_an_edit_can_find_the_coupon_by_its_code(self, client, db, admin_auth, coupon):
        assert save(client, admin_auth, "save10", description="By code").status_code == 200
        db.expire_all()
        assert db.get(Coupon, "CPN001").description == "By code"

    def test_disabling_by_status_and_by_flag(self, client, db, admin_auth, coupon):
        save(client, admin_auth, "CPN001", status="disabled")
        assert admin_coupons(client, admin_auth)["SAVE10"]["status"] == "disabled"
        save(client, admin_auth, "CPN001", active=True)
        assert admin_coupons(client, admin_auth)["SAVE10"]["status"] == "active"

    def test_dates_are_parsed_and_an_end_can_be_cleared(self, client, db, admin_auth, coupon):
        future = (datetime.utcnow() + timedelta(days=3)).replace(microsecond=0).isoformat() + "Z"
        save(client, admin_auth, "CPN001", startsAt=future)
        assert admin_coupons(client, admin_auth)["SAVE10"]["status"] == "scheduled"
        save(client, admin_auth, "CPN001", startsAt="2026-01-01T00:00:00Z", endsAt="2026-01-02T00:00:00Z")
        assert admin_coupons(client, admin_auth)["SAVE10"]["status"] == "expired"
        save(client, admin_auth, "CPN001", endsAt=None)
        db.expire_all()
        assert db.get(Coupon, "CPN001").ends_at is None

    def test_an_unreadable_date_is_refused(self, client, admin_auth, coupon):
        response = save(client, admin_auth, "CPN001", startsAt="next tuesday")
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_DATE"

    def test_zero_or_blank_limits_mean_unlimited(self, client, db, admin_auth, coupon):
        save(client, admin_auth, "CPN001", usageLimit=0, perCustomerLimit="")
        db.expire_all()
        stored = db.get(Coupon, "CPN001")
        assert stored.usage_limit is None and stored.per_customer_limit is None

    def test_a_negative_limit_is_refused(self, client, admin_auth, coupon):
        response = save(client, admin_auth, "CPN001", usageLimit=-1)
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_LIMIT"

    def test_an_unknown_audience_is_refused(self, client, admin_auth, coupon):
        response = save(client, admin_auth, "CPN001", audience="vips")
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_AUDIENCE"

    def test_selected_customers_are_kept_and_strangers_dropped(self, client, db, admin_auth, coupon, customer):
        response = save(client, admin_auth, "CPN001", audience="selected", customerIds=["CUS001", "CUS999"])
        assert response.status_code == 200, response.text
        assert admin_coupons(client, admin_auth)["SAVE10"]["customerIds"] == ["CUS001"]

    def test_an_unknown_coupon_cannot_be_edited(self, client, admin_auth):
        response = save(client, admin_auth, "CPN999", description="x")
        assert response.status_code == 404 and response.json()["error_code"] == "COUPON_NOT_FOUND"

    def test_only_staff_with_coupons_may_write(self, client, auth, editor, coupon):
        token = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"}
                            ).json()["data"]["token"]["accessToken"]
        headers = {"Authorization": f"Bearer {token}"}
        assert save(client, headers, code="NOPE", type="flat", value=1).status_code == 403
        assert client.delete("/api/admin/coupons/CPN001", headers=headers).status_code == 403
        assert save(client, auth, code="NOPE", type="flat", value=1).status_code in (401, 403)

    # Regression: was a real bug, fixed alongside this test.
    def test_an_unknown_type_is_refused(self, client, admin_auth):
        response = save(client, admin_auth, code="ODD", type="banana", value=10)
        assert response.status_code == 422

    # Regression: was a real bug, fixed alongside this test.
    def test_a_negative_value_is_refused(self, client, admin_auth):
        response = save(client, admin_auth, code="MINUS", type="flat", value=-100)
        assert response.status_code == 422


class TestDeleting:
    def test_an_unused_coupon_is_deleted(self, client, db, admin_auth, coupon):
        response = client.delete("/api/admin/coupons/CPN001", headers=admin_auth)
        assert response.status_code == 200
        db.expire_all()
        assert db.get(Coupon, "CPN001") is None

    def test_a_redeemed_coupon_is_kept(self, client, db, admin_auth, auth, catalogue, settings_documents, coupon):
        assert order_with(client, auth, "SAVE10").status_code == 201
        response = client.delete("/api/admin/coupons/SAVE10", headers=admin_auth)
        assert response.status_code == 409 and response.json()["error_code"] == "COUPON_IN_USE"
        listed = admin_coupons(client, admin_auth)["SAVE10"]
        assert listed["usageCount"] == 1 and listed["customersUsed"] == 1 and listed["totalDiscount"] == 100

    def test_an_unknown_coupon(self, client, admin_auth):
        assert client.delete("/api/admin/coupons/CPN999", headers=admin_auth).status_code == 404


class TestValidationEdges:
    def validate(self, client, code, subtotal=100000, headers=None):
        response = client.post("/api/coupons/validate", headers=headers or {}, json={"code": code, "subtotal": subtotal})
        assert response.status_code == 200, response.text
        return response.json()["data"]

    def test_an_empty_code(self, client):
        assert self.validate(client, "   ") == {"valid": False, "reason": "Enter a coupon code."}

    def test_a_restricted_code_needs_a_sign_in(self, client, admin_auth, customer):
        make_coupon(client, admin_auth, code="FIRST", audience="first-order")
        result = self.validate(client, "FIRST")
        assert result["valid"] is False and "Sign in" in result["reason"]

    def test_a_multi_use_limit_says_how_many(self, client, db, auth, catalogue, settings_documents, admin_auth,
                                             placed_orders):
        make_coupon(client, admin_auth, code="TWICE", perCustomerLimit=2)
        coupon = db.query(Coupon).filter_by(code="TWICE").one()
        for order_id in ("ORD801", "ORD802"):
            db.add(CouponUsage(coupon_id=coupon.id, customer_id="CUS001", order_id=order_id, discount_amount=10,
                               used_at=datetime.utcnow()))
        db.flush()
        result = self.validate(client, "TWICE", headers=auth)
        assert result["valid"] is False and "maximum 2 times" in result["reason"]

    def test_an_unknown_audience_value_is_refused(self, db, coupon, customer):
        from app.services import coupons

        coupon.audience = "martians"
        db.flush()
        assert coupons.audience_refusal(db, coupon, "CUS001") == "That code isn't available."

    def test_uses_by_an_anonymous_shopper_is_empty(self, db):
        from app.services import coupons

        assert coupons.uses_by(db, None) == {}

    def test_the_storefront_list_for_a_signed_in_shopper(self, client, auth, coupon):
        listed = client.get("/api/coupons", headers=auth).json()["data"]
        assert listed[0]["code"] == "SAVE10" and listed[0]["timesUsed"] == 0 and listed[0]["soldOut"] is False


class TestRedemptionBookkeeping:
    def test_recording_a_use_counts_it(self, db, coupon, placed_orders):
        from app.services import coupons

        coupons.record_usage(db, "save10", "CUS001", "ORD801", 10000)
        db.flush()
        assert coupon.usage_count == 1
        usage = db.query(CouponUsage).one()
        assert float(usage.discount_amount) == 100 and usage.order_id == "ORD801"

    def test_an_unknown_code_records_nothing(self, db, coupon):
        from app.services import coupons

        coupons.record_usage(db, "GHOST", "CUS001", "ORD801", 100)
        assert db.query(CouponUsage).count() == 0

    def test_the_last_use_taken_meanwhile_is_refused(self, db, coupon, customer):
        from app.core.errors import ConflictError
        from app.services import coupons

        coupon.usage_limit, coupon.usage_count = 1, 1
        db.flush()
        with pytest.raises(ConflictError) as caught:
            coupons.record_usage(db, "SAVE10", "CUS001", "ORD801", 100)
        assert caught.value.error_code == "COUPON_EXHAUSTED"

    def test_a_second_use_by_the_same_customer_is_refused(self, db, coupon, placed_orders):
        from app.core.errors import ConflictError
        from app.services import coupons

        coupon.per_customer_limit = 1
        coupons.record_usage(db, "SAVE10", "CUS001", "ORD801", 100)
        db.flush()
        with pytest.raises(ConflictError) as caught:
            coupons.record_usage(db, "SAVE10", "CUS001", "ORD802", 100)
        assert caught.value.error_code == "COUPON_USED"

    def test_releasing_gives_the_use_back_but_never_below_zero(self, db, coupon, placed_orders):
        from app.services import coupons

        coupons.record_usage(db, "SAVE10", "CUS001", "ORD801", 100)
        db.flush()
        coupon.usage_count = 0  # already corrected by hand
        db.flush()
        coupons.release_usage(db, "ORD801")
        db.flush()
        assert coupon.usage_count == 0 and db.query(CouponUsage).count() == 0

    def test_an_order_with_a_coupon_is_cancelled_and_the_use_returns(self, client, db, auth, catalogue,
                                                                    settings_documents, coupon):
        order = order_with(client, auth, "SAVE10").json()["data"]["order"]
        db.expire_all()
        assert db.get(Coupon, "CPN001").usage_count == 1
        client.post(f"/api/orders/{order['id']}/cancel", headers=auth, json={"reason": ""})
        db.expire_all()
        assert db.get(Coupon, "CPN001").usage_count == 0
        assert db.query(CouponUsage).count() == 0
