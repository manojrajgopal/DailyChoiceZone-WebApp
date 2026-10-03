"""
Segments in the rest of the shop: campaigns targeting a segment (consent still
applies, old audiences unchanged), coupons restricted to a segment, and the
customers admin routes' permissions.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from app.models import ChannelPreference
from app.models.segments import Segment
from app.services.segments import metrics
from tests.integration.segments_helpers import order, person, segment_payload
from tests.integration.test_suppliers_helpers import role_headers

pytestmark = pytest.mark.integration


@pytest.fixture()
def big_spenders(client, admin_auth, db, catalogue, customer):
    """CUS801 and CUS802 spent ₹5,000+; CUS803 and the fixture customer (CUS001) didn't."""
    for cid in ("CUS801", "CUS802", "CUS803"):
        person(db, cid)
    order(db, "CUS801", 6000)
    order(db, "CUS802", 7000)
    order(db, "CUS803", 100)
    metrics.refresh(db, ["CUS801", "CUS802", "CUS803", "CUS001"])
    response = client.post("/api/admin/segments", headers=admin_auth, json=segment_payload(
        name="Spent 5k", rules=[{"field": "totalSpend", "operator": "gte", "value": 5000}]))
    assert response.status_code == 201
    return response.json()["data"]


def estimate(client, headers, audience, channels=("email",)):
    return client.post("/api/admin/campaigns/estimate", json={"audience": audience, "channels": list(channels)},
                       headers=headers)


class TestCampaigns:
    def test_a_segment_audience_is_its_members(self, client, admin_auth, big_spenders):
        data = estimate(client, admin_auth, {"segment": "all", "segmentId": big_spenders["id"]}).json()["data"]
        assert data["matching"] == 2 and data["channels"]["email"] == 2

    def test_consent_still_applies(self, client, admin_auth, big_spenders, db):
        db.add(ChannelPreference(customer_id="CUS801", channel="email", category="marketing", enabled=False,
                                 updated_at=datetime.utcnow()))
        db.add(ChannelPreference(customer_id="CUS802", channel="sms", category="marketing", enabled=True,
                                 updated_at=datetime.utcnow()))
        db.flush()
        data = estimate(client, admin_auth, {"segmentId": big_spenders["id"]}, ("email", "sms")).json()["data"]
        assert data["matching"] == 2
        assert data["channels"] == {"email": 1, "sms": 1}

    def test_other_filters_intersect(self, client, admin_auth, big_spenders):
        data = estimate(client, admin_auth, {"segmentId": big_spenders["id"], "minSpent": 6500}).json()["data"]
        assert data["matching"] == 1

    def test_old_audiences_still_work(self, client, admin_auth, big_spenders):
        assert estimate(client, admin_auth, {"segment": "all"}).json()["data"]["matching"] == 4
        assert estimate(client, admin_auth, {"segment": "all", "segmentId": None}).json()["data"]["matching"] == 4

    def test_unknown_archived_and_malformed_segments(self, client, admin_auth, big_spenders, db):
        missing = estimate(client, admin_auth, {"segmentId": 99999})
        assert missing.status_code == 422 and missing.json()["error_code"] == "SEGMENT_NOT_FOUND"
        assert estimate(client, admin_auth, {"segmentId": "abc"}).json()["error_code"] == "INVALID_AUDIENCE"
        client.post(f"/api/admin/segments/{big_spenders['id']}/archive", headers=admin_auth)
        assert estimate(client, admin_auth, {"segmentId": big_spenders["id"]}).json()["error_code"] == "SEGMENT_ARCHIVED"

    def test_saved_with_the_campaign_and_offered_in_the_options(self, client, admin_auth, big_spenders):
        options = client.get("/api/admin/campaigns/options", headers=admin_auth).json()["data"]
        assert {"id": big_spenders["id"], "name": "Spent 5k"} in [{"id": s["id"], "name": s["name"]}
                                                                for s in options["savedSegments"]]
        saved = client.post("/api/admin/campaigns", headers=admin_auth, json={
            "name": "To big spenders", "kind": "promotional", "channels": ["email"],
            "audience": {"segment": "all", "segmentId": big_spenders["id"]}, "content": {}})
        assert saved.status_code == 201 and saved.json()["data"]["audience"]["segmentId"] == big_spenders["id"]


def coupon_body(**overrides):
    body = {"code": "BIG500", "type": "flat", "value": 500, "minSubtotal": 0, "audience": "segment", "status": "active"}
    body.update(overrides)
    return body


class TestCoupons:
    def test_saving_needs_an_active_segment(self, client, admin_auth, big_spenders, db):
        assert client.post("/api/admin/coupons", json=coupon_body(), headers=admin_auth).json()["error_code"] \
            == "SEGMENT_REQUIRED"
        assert client.post("/api/admin/coupons", json=coupon_body(code="BIG501", segmentId=99999), headers=admin_auth
                           ).json()["error_code"] == "SEGMENT_NOT_FOUND"
        db.rollback()  # the API's session would be discarded after a refusal; the test shares it
        created = client.post("/api/admin/coupons", json=coupon_body(segmentId=big_spenders["id"]), headers=admin_auth)
        assert created.status_code == 201
        listed = client.get("/api/admin/coupons", headers=admin_auth).json()["data"]
        row = next(c for c in listed if c["code"] == "BIG500")
        assert row["segmentId"] == big_spenders["id"] and row["segmentName"] == "Spent 5k"

    def test_members_may_use_it_and_others_may_not(self, client, admin_auth, auth, big_spenders, db):
        client.post("/api/admin/coupons", json=coupon_body(segmentId=big_spenders["id"]), headers=admin_auth)
        refused = client.post("/api/coupons/validate", json={"code": "BIG500", "subtotal": 200000}, headers=auth)
        assert refused.json()["data"] == {"valid": False, "reason": "That code isn't available on your account."}
        assert client.post("/api/coupons/validate", json={"code": "BIG500", "subtotal": 200000}
                           ).json()["data"]["reason"] == "Sign in to use that code."
        # CUS001 becomes a big spender: the check is live, against their figures now.
        order(db, "CUS001", 9000)
        metrics.refresh(db, ["CUS001"])
        allowed = client.post("/api/coupons/validate", json={"code": "BIG500", "subtotal": 200000}, headers=auth)
        assert allowed.json()["data"]["valid"] is True

    def test_an_archived_segment_refuses_everyone(self, client, admin_auth, auth, big_spenders, db):
        client.post("/api/admin/coupons", json=coupon_body(segmentId=big_spenders["id"]), headers=admin_auth)
        order(db, "CUS001", 9000)
        metrics.refresh(db, ["CUS001"])
        client.post(f"/api/admin/segments/{big_spenders['id']}/archive", headers=admin_auth)
        refused = client.post("/api/coupons/validate", json={"code": "BIG500", "subtotal": 200000}, headers=auth)
        assert refused.json()["data"]["valid"] is False

    def test_a_customer_without_metrics_yet_is_computed_on_the_spot(self, client, admin_auth, auth, big_spenders, db):
        from app.models.segments import CustomerMetrics

        client.post("/api/admin/coupons", json=coupon_body(segmentId=big_spenders["id"]), headers=admin_auth)
        order(db, "CUS001", 9000)
        db.execute(CustomerMetrics.__table__.delete().where(CustomerMetrics.customer_id == "CUS001"))
        allowed = client.post("/api/coupons/validate", json={"code": "BIG500", "subtotal": 200000}, headers=auth)
        assert allowed.json()["data"]["valid"] is True
        assert db.get(Segment, big_spenders["id"]) is not None

    def test_the_storefront_lists_it_only_to_members(self, client, admin_auth, auth, big_spenders):
        client.post("/api/admin/coupons", json=coupon_body(segmentId=big_spenders["id"]), headers=admin_auth)
        codes = [c["code"] for c in client.get("/api/coupons", headers=auth).json()["data"]]
        assert "BIG500" not in codes


class TestCustomersRoutes:
    def test_editor_can_no_longer_read_customers(self, client, db, editor, customer):
        from app.core.security import create_access_token

        headers = {"Authorization": "Bearer " + create_access_token(editor.id, actor="admin", role="editor")}
        assert client.get("/api/admin/customers", headers=headers).status_code == 403
        assert client.get("/api/admin/customers/CUS001", headers=headers).status_code == 403

    def test_staff_can_open_one_customer_but_not_the_list(self, client, db, customer):
        staff = role_headers(db, "ADM041", "staff")
        assert client.get("/api/admin/customers", headers=staff).status_code == 403
        assert client.get("/api/admin/customers/CUS001", headers=staff).status_code == 200

    def test_managers_and_admins_still_can(self, client, db, admin_auth, customer):
        manager = role_headers(db, "ADM042", "manager")
        for headers in (manager, admin_auth):
            assert client.get("/api/admin/customers", headers=headers).status_code == 200
            assert client.get("/api/admin/customers/CUS001", headers=headers).status_code == 200
