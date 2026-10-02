"""
Regressions for the crashes `test_api_contract.py` found: each was a 500 on
input a client can send, and is now a client error that names the problem.
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.integration


class TestQrImage:
    """`GET /api/payments/qr-image/{id}` is public and keyed on any string."""

    def test_unknown_code_under_the_mock_provider_is_a_404(self, client):
        response = client.get("/api/payments/qr-image/qr_unknown")
        assert response.status_code == 404
        assert response.json()["error_code"] == "QR_UNAVAILABLE"

    def test_a_code_the_gateway_does_not_know_is_a_404(self, client, monkeypatch):
        from app.services import settlement
        from app.services.payments.razorpay import RazorpayError

        class Gateway:
            def qr_poster_url(self, qr_id):
                raise RazorpayError("The id provided does not exist", status=400)

        monkeypatch.setattr(settlement, "get_provider", lambda: Gateway())
        response = client.get("/api/payments/qr-image/qr_nope")
        assert response.status_code == 404
        assert response.json()["error_code"] == "QR_UNAVAILABLE"

    def test_a_gateway_with_no_image_is_a_404(self, client, monkeypatch):
        from app.services import settlement

        class Gateway:
            def qr_poster_url(self, qr_id):
                return ""

        monkeypatch.setattr(settlement, "get_provider", lambda: Gateway())
        assert client.get("/api/payments/qr-image/qr_blank").status_code == 404


class TestCouponFieldTypes:
    @pytest.mark.parametrize("field, value, code", [
        ("code", 7, "INVALID_COUPON_FIELD"),
        ("description", ["x"], "INVALID_COUPON_FIELD"),
        ("type", 1, "INVALID_COUPON_FIELD"),
        ("startsAt", 20260101, "INVALID_COUPON_FIELD"),
        ("status", {"x": 1}, "INVALID_COUPON_FIELD"),
        ("value", "lots", "INVALID_COUPON_VALUE"),
        ("value", True, "INVALID_COUPON_VALUE"),
        ("usageLimit", "many", "INVALID_COUPON_VALUE"),
        ("maxDiscount", {"a": 1}, "INVALID_COUPON_VALUE"),
        ("customerIds", "CUS001", "INVALID_COUPON_FIELD"),
    ])
    def test_wrong_kind_of_value_is_a_422_naming_the_field(self, client, admin_auth, db, field, value, code):
        from app.models import Coupon

        payload = {"code": "TYPED", "type": "percent", "value": 10, field: value}
        response = client.post("/api/admin/coupons", headers=admin_auth, json=payload)
        assert response.status_code == 422, response.text
        body = response.json()
        assert body["error_code"] == code and body["details"] == {"field": field}
        assert db.query(Coupon).count() == 0  # nothing half-written

    def test_numbers_sent_as_strings_are_still_accepted(self, client, admin_auth):
        """The portal's inputs may send "10" rather than 10; that was fine before and still is."""
        response = client.post("/api/admin/coupons", headers=admin_auth,
                               json={"code": "STRINGY", "type": "flat", "value": "100", "usageLimit": ""})
        assert response.status_code == 201, response.text


class TestInventoryLogLimit:
    @pytest.mark.parametrize("limit", [-5, 0, 1001])
    def test_out_of_range_limit_is_a_422(self, client, admin_auth, limit):
        response = client.get("/api/admin/inventory/log", headers=admin_auth, params={"limit": limit})
        assert response.status_code == 422
        assert response.json()["details"][0]["field"] == "limit"

    @pytest.mark.parametrize("limit", [1, 200, 1000])
    def test_in_range_limit(self, client, admin_auth, limit):
        assert client.get("/api/admin/inventory/log", headers=admin_auth, params={"limit": limit}).status_code == 200

    def test_the_default_still_works(self, client, admin_auth):
        assert client.get("/api/admin/inventory/log", headers=admin_auth).json()["data"] == []
