"""
Coupons.

Validated on the server, always. A discount the browser works out is a discount
the browser can change, and the order recalculates it regardless — so asking
here is the only way the figure shown matches the one charged.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

pytestmark = pytest.mark.integration


def validate(client, code, subtotal):
    return client.post("/api/coupons/validate", json={"code": code, "subtotal": subtotal})


class TestValidation:
    def test_accepts_a_live_code(self, client, coupon):
        response = validate(client, "SAVE10", 200_000)
        assert response.status_code == 200

        data = response.json()["data"]
        assert data["valid"] is True
        assert data["discount"] == 20_000

    def test_the_code_is_not_case_sensitive(self, client, coupon):
        assert validate(client, "save10", 200_000).json()["data"]["valid"] is True

    def test_an_unknown_code_is_refused_with_a_reason(self, client, coupon):
        data = validate(client, "FREEMONEY", 200_000).json()["data"]
        assert data["valid"] is False
        assert data["reason"]

    def test_below_the_minimum_subtotal(self, client, coupon):
        """The coupon needs ₹500; this basket is ₹100."""
        data = validate(client, "SAVE10", 10_000).json()["data"]
        assert data["valid"] is False

    def test_the_cap_is_applied(self, client, coupon):
        """10% of ₹10,000 is ₹1,000, but the coupon caps at ₹500."""
        assert validate(client, "SAVE10", 1_000_000).json()["data"]["discount"] == 50_000

    def test_an_inactive_coupon_is_refused(self, client, db, coupon):
        coupon.active = False
        db.flush()
        assert validate(client, "SAVE10", 200_000).json()["data"]["valid"] is False

    def test_an_expired_coupon_is_refused(self, client, db, coupon):
        coupon.ends_at = datetime.utcnow() - timedelta(days=1)
        db.flush()
        assert validate(client, "SAVE10", 200_000).json()["data"]["valid"] is False

    def test_a_coupon_that_has_not_started_is_refused(self, client, db, coupon):
        coupon.starts_at = datetime.utcnow() + timedelta(days=1)
        db.flush()
        assert validate(client, "SAVE10", 200_000).json()["data"]["valid"] is False

    def test_an_exhausted_coupon_is_refused(self, client, db, coupon):
        coupon.usage_limit = 5
        coupon.usage_count = 5
        db.flush()
        assert validate(client, "SAVE10", 200_000).json()["data"]["valid"] is False

    def test_a_discount_can_never_exceed_the_basket(self, client, db, coupon):
        """A ₹500 flat coupon against a ₹100 basket takes off ₹100, not ₹500."""
        coupon.type = "flat"
        coupon.value = 500
        coupon.min_subtotal = 0
        coupon.max_discount = None
        db.flush()

        assert validate(client, "SAVE10", 10_000).json()["data"]["discount"] == 10_000


class TestListing:
    def test_lists_the_codes_on_offer(self, client, coupon):
        response = client.get("/api/coupons")
        assert response.status_code == 200
        assert "SAVE10" in [c["code"] for c in response.json()["data"]]

    def test_an_inactive_coupon_is_not_advertised(self, client, db, coupon):
        coupon.active = False
        db.flush()
        assert client.get("/api/coupons").json()["data"] == []
