"""
The small pieces everything else stands on: ids, slugs, dates, the response
envelope, the permission table, the rate limiter and the settings checks.

No database is needed for any of these, and none of them is mocked - each is
tested against its real inputs and outputs.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from app.core import permissions, rate_limit
from app.core.config import Settings
from app.core.errors import (
    AppError,
    AuthenticationError,
    AuthorizationError,
    BusinessRuleError,
    ConflictError,
    NotFoundError,
    RateLimitedError,
    ValidationError,
    _payload,
)
from app.schemas.base import to_camel
from app.utils import ids
from app.utils.dates import parse_dt
from app.utils.response import Pagination, ok, ok_list


# ------------------------------------------------------------------ ids


class TestIds:
    def test_build_id_pads_to_three_digits(self):
        assert ids.build_id("product", 7) == "PRD007"

    def test_build_id_grows_past_the_padding_without_truncating(self):
        assert ids.build_id("order", 1000) == "ORD1000"

    def test_build_id_for_uses_the_given_prefix(self):
        assert ids.build_id_for("XYZ", 42) == "XYZ042"

    def test_build_id_with_unknown_entity_raises(self):
        with pytest.raises(KeyError):
            ids.build_id("spaceship", 1)

    def test_every_prefix_is_unique(self):
        """A reused prefix would let two entities' ids collide."""
        prefixes = list(ids.PREFIXES.values())
        assert len(prefixes) == len(set(prefixes))

    @pytest.mark.parametrize("value, number", [("PRD001", 1), ("ORD1000", 1000), ("CUS042", 42)])
    def test_parse_number_reads_our_ids(self, value, number):
        assert ids.parse_number(value) == number

    @pytest.mark.parametrize("value", ["", None, "PRD", "prd001", "PR001", "PRD-001", "PRD001x", "12345"])
    def test_parse_number_rejects_anything_else(self, value):
        assert ids.parse_number(value) is None

    @pytest.mark.parametrize(
        "text, slug",
        [
            ("Cotton Kurta", "cotton-kurta"),
            ("Shoes & Bags", "shoes-and-bags"),
            ("  --Hello,  World!--  ", "hello-world"),
            ("Men's T-Shirt (XL)", "men-s-t-shirt-xl"),
            ("", ""),
            ("!!!", ""),
        ],
    )
    def test_slugify(self, text, slug):
        assert ids.slugify(text) == slug


# ---------------------------------------------------------------- dates


class TestParseDt:
    def test_none_and_empty_are_none(self):
        assert parse_dt(None) is None
        assert parse_dt("") is None

    def test_plain_date_is_midnight(self):
        assert parse_dt("2026-09-28") == datetime(2026, 9, 28)

    def test_naive_timestamp_is_kept(self):
        assert parse_dt("2026-09-28T10:30:00") == datetime(2026, 9, 28, 10, 30)

    def test_z_suffix_is_utc(self):
        value = parse_dt("2026-09-28T10:30:00Z")
        assert value == datetime(2026, 9, 28, 10, 30)
        assert value.tzinfo is None

    def test_offset_is_converted_to_utc_not_server_time(self):
        """IST 05:30 is UTC midnight - the bug this replaced stored it 5 and a half hours out."""
        assert parse_dt("2026-09-28T05:30:00+05:30") == datetime(2026, 9, 28, 0, 0)

    @pytest.mark.parametrize("value", ["not a date", "2026-13-01", "28/09/2026", "tomorrow"])
    def test_rubbish_is_none(self, value):
        assert parse_dt(value) is None


# ------------------------------------------------------------- envelope


class TestResponseEnvelope:
    def test_ok_shape(self):
        assert ok({"a": 1}, "done") == {"success": True, "data": {"a": 1}, "message": "done"}

    def test_ok_defaults(self):
        assert ok() == {"success": True, "data": None, "message": None}

    def test_ok_list_without_pagination_or_message_omits_them(self):
        assert ok_list([1, 2]) == {"success": True, "data": [1, 2]}

    def test_ok_list_with_pagination_and_message(self):
        payload = ok_list([], Pagination.build(2, 10, 35), "hi")
        assert payload["pagination"] == {"page": 2, "page_size": 10, "total": 35, "total_pages": 4}
        assert payload["message"] == "hi"

    @pytest.mark.parametrize("total, size, pages", [(0, 10, 0), (1, 10, 1), (10, 10, 1), (11, 10, 2), (5, 0, 0)])
    def test_pagination_total_pages(self, total, size, pages):
        assert Pagination.build(1, size, total).total_pages == pages


class TestToCamel:
    @pytest.mark.parametrize(
        "snake, camel",
        [("original_price", "originalPrice"), ("id", "id"), ("is_best_seller", "isBestSeller"), ("a_b_c", "aBC")],
    )
    def test_conversion(self, snake, camel):
        assert to_camel(snake) == camel


# --------------------------------------------------------------- errors


class TestErrors:
    @pytest.mark.parametrize(
        "cls, status, code",
        [
            (AppError, 400, "BAD_REQUEST"),
            (NotFoundError, 404, "NOT_FOUND"),
            (ConflictError, 409, "CONFLICT"),
            (ValidationError, 422, "VALIDATION_ERROR"),
            (AuthenticationError, 401, "UNAUTHENTICATED"),
            (AuthorizationError, 403, "FORBIDDEN"),
            (BusinessRuleError, 422, "BUSINESS_RULE_VIOLATION"),
            (RateLimitedError, 429, "RATE_LIMITED"),
        ],
    )
    def test_status_and_default_code(self, cls, status, code):
        error = cls("message")
        assert error.status_code == status
        assert error.error_code == code
        assert error.message == "message"
        assert str(error) == "message"
        assert error.details is None

    def test_error_code_can_be_overridden_per_instance(self):
        error = NotFoundError("gone", error_code="ORDER_NOT_FOUND", details={"id": "ORD1"})
        assert error.error_code == "ORDER_NOT_FOUND"
        assert error.details == {"id": "ORD1"}
        # ...without changing the class default for everyone else.
        assert NotFoundError("x").error_code == "NOT_FOUND"

    def test_payload_omits_absent_details(self):
        assert _payload("m", "C") == {"success": False, "message": "m", "error_code": "C"}

    def test_payload_keeps_falsy_but_present_details(self):
        assert _payload("m", "C", [])["details"] == []


# ---------------------------------------------------------- permissions


class TestPermissions:
    def test_super_admin_has_every_resource(self):
        assert set(permissions.permissions_for("super-admin")) == set(permissions.RESOURCES)

    def test_unknown_role_gets_nothing(self):
        assert permissions.permissions_for("superadmin") == []
        assert permissions.permissions_for("") == []

    def test_admin_lacks_the_super_admins_reserved_powers(self):
        granted = permissions.permissions_for("admin")
        for reserved in ("admins", "support-config", "payments-manage", "audit-logs", "backups"):
            assert reserved not in granted
        assert "orders" in granted

    def test_every_role_names_only_real_resources(self):
        for role, granted in permissions.PERMISSIONS_BY_ROLE.items():
            assert set(granted) <= set(permissions.RESOURCES), role

    def test_returns_a_copy_that_cannot_change_the_table(self):
        granted = permissions.permissions_for("editor")
        granted.append("admins")
        assert "admins" not in permissions.permissions_for("editor")


# ----------------------------------------------------------- rate limit


class TestRateLimit:
    @pytest.fixture(autouse=True)
    def _clean(self):
        rate_limit.reset()
        yield
        rate_limit.reset()

    def test_allows_up_to_the_limit_then_refuses(self):
        for _ in range(3):
            rate_limit.check("k", limit=3, window_seconds=60)
        with pytest.raises(RateLimitedError):
            rate_limit.check("k", limit=3, window_seconds=60)

    def test_keys_are_independent(self):
        rate_limit.check("a", limit=1, window_seconds=60)
        rate_limit.check("b", limit=1, window_seconds=60)
        with pytest.raises(RateLimitedError):
            rate_limit.check("a", limit=1, window_seconds=60)

    def test_custom_message(self):
        rate_limit.check("k", limit=1, window_seconds=60)
        with pytest.raises(RateLimitedError, match="slow down"):
            rate_limit.check("k", limit=1, window_seconds=60, message="slow down")

    def test_hits_outside_the_window_are_forgotten(self, monkeypatch):
        clock = iter([100.0, 200.0])
        monkeypatch.setattr(rate_limit.time, "monotonic", lambda: next(clock))
        rate_limit.check("k", limit=1, window_seconds=50)
        rate_limit.check("k", limit=1, window_seconds=50)  # 100 s later: the first hit expired

    def test_reset_forgets_everything(self):
        rate_limit.check("k", limit=1, window_seconds=60)
        rate_limit.reset()
        rate_limit.check("k", limit=1, window_seconds=60)


# -------------------------------------------------------------- settings


def _settings(**overrides) -> Settings:
    # `_env_file=None` so the developer's .env never leaks into the test.
    return Settings(_env_file=None, **overrides)


def _production(**overrides) -> Settings:
    values = dict(
        ENVIRONMENT="production",
        JWT_SECRET_KEY="x" * 40,
        DEBUG=False,
        PAYMENT_PROVIDER="razorpay",
        RAZOR_KEY_ID="rzp_live_abc",
        RAZOR_KEY_SECRET="secret",
        RAZOR_WEBHOOK_SECRET="hook",
        STOREFRONT_URL="https://shop.example.com",
    )
    values.update(overrides)
    return _settings(**values)


class TestSettings:
    def test_cors_origins_accepts_a_comma_separated_string(self):
        assert _settings(CORS_ORIGINS="http://a, http://b ,,").CORS_ORIGINS == ["http://a", "http://b"]

    def test_cors_origins_accepts_a_list(self):
        assert _settings(CORS_ORIGINS=["http://a"]).CORS_ORIGINS == ["http://a"]

    def test_urls(self):
        s = _settings(DATABASE_USER="u", DATABASE_PASSWORD="p", DATABASE_HOST="h", DATABASE_PORT=1,
                      DATABASE_NAME="d")
        assert s.server_url == "mysql+pymysql://u:p@h:1"
        assert s.database_url == "mysql+pymysql://u:p@h:1/d?charset=utf8mb4"

    @pytest.mark.parametrize("env, prod", [("production", True), ("PROD", True), ("development", False),
                                           ("staging", False)])
    def test_is_production(self, env, prod):
        assert _settings(ENVIRONMENT=env).is_production is prod

    def test_razorpay_flags(self):
        assert not _settings(RAZOR_KEY_ID="", RAZOR_KEY_SECRET="").razorpay_configured
        assert _settings(RAZOR_KEY_ID="rzp_test_1", RAZOR_KEY_SECRET="s").razorpay_configured
        assert not _settings(RAZOR_KEY_ID="rzp_test_1").razorpay_live
        assert _settings(RAZOR_KEY_ID="rzp_live_1").razorpay_live

    def test_a_correct_production_configuration_has_no_problems(self):
        assert _production().validate_production() == []

    @pytest.mark.parametrize(
        "overrides, fragment",
        [
            ({"JWT_SECRET_KEY": "change-this-secret"}, "still the default"),
            ({"JWT_SECRET_KEY": "short"}, "shorter than 32"),
            ({"DEBUG": True}, "DEBUG is on"),
            ({"CORS_ORIGINS": ["*"]}, "wildcard"),
            ({"PAYMENT_PROVIDER": "mock"}, "must be 'razorpay'"),
            ({"RAZOR_KEY_SECRET": ""}, "must both be set"),
            ({"RAZOR_KEY_ID": "rzp_test_abc"}, "test key"),
            ({"RAZOR_WEBHOOK_SECRET": ""}, "RAZOR_WEBHOOK_SECRET is empty"),
            ({"STOREFRONT_URL": "http://shop.example.com"}, "must be HTTPS"),
        ],
    )
    def test_each_unsafe_production_setting_is_reported(self, overrides, fragment):
        problems = _production(**overrides).validate_production()
        assert any(fragment in problem for problem in problems), problems
