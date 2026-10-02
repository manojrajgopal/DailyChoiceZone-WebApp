"""
Sign-in throttling: password guessing is paused after repeated failures.

Only failures count, per address and per caller, for fifteen minutes. A normal
sign-in never meets the limit. While paused, even the right password is
refused, so a guesser can't tell when they've hit it.
"""

from __future__ import annotations

import pytest

from app.api.routes import auth as auth_routes
from app.core import rate_limit

pytestmark = pytest.mark.integration

LOGIN = "/api/auth/login"
ADMIN_LOGIN = "/api/admin/auth/login"


def _fail(client, url, email, times):
    for _ in range(times):
        assert client.post(url, json={"email": email, "password": "Wrong-pass1"}).status_code == 401


class TestCustomerSignIn:
    def test_paused_after_ten_failures_even_with_the_right_password(self, client, customer):
        _fail(client, LOGIN, customer.email, auth_routes.LOGIN_FAILURES_PER_EMAIL)
        response = client.post(LOGIN, json={"email": customer.email, "password": "Customer@123"})
        assert response.status_code == 429
        assert response.json()["error_code"] == "TOO_MANY_ATTEMPTS"

    def test_nine_failures_then_the_right_password_works(self, client, customer):
        _fail(client, LOGIN, customer.email, auth_routes.LOGIN_FAILURES_PER_EMAIL - 1)
        assert client.post(LOGIN, json={"email": customer.email, "password": "Customer@123"}).status_code == 200

    def test_successful_sign_ins_never_count(self, client, customer):
        for _ in range(auth_routes.LOGIN_FAILURES_PER_EMAIL + 5):
            assert client.post(LOGIN, json={"email": customer.email, "password": "Customer@123"}).status_code == 200

    def test_the_address_is_matched_whatever_its_case(self, client, customer):
        _fail(client, LOGIN, customer.email.upper(), auth_routes.LOGIN_FAILURES_PER_EMAIL)
        assert client.post(LOGIN, json={"email": customer.email, "password": "Customer@123"}).status_code == 429

    def test_one_paused_address_does_not_lock_out_another(self, client, customer, other_customer):
        _fail(client, LOGIN, customer.email, auth_routes.LOGIN_FAILURES_PER_EMAIL)
        assert client.post(LOGIN, json={"email": other_customer.email, "password": "Customer@123"}).status_code == 200

    def test_unknown_addresses_are_counted_too(self, client):
        """Otherwise the 429 itself would tell a guesser which addresses have accounts."""
        _fail(client, LOGIN, "nobody@example.com", auth_routes.LOGIN_FAILURES_PER_EMAIL)
        assert client.post(LOGIN, json={"email": "nobody@example.com", "password": "x"}).status_code == 429

    def test_spraying_many_addresses_from_one_caller_is_paused(self, client, customer, monkeypatch):
        monkeypatch.setattr(auth_routes, "LOGIN_FAILURES_PER_IP", 5)
        for i in range(5):
            _fail(client, LOGIN, f"guess{i}@example.com", 1)
        assert client.post(LOGIN, json={"email": customer.email, "password": "Customer@123"}).status_code == 429

    def test_the_pause_ends_after_the_window(self, client, customer, monkeypatch):
        clock = [1000.0]
        monkeypatch.setattr(rate_limit.time, "monotonic", lambda: clock[0])
        _fail(client, LOGIN, customer.email, auth_routes.LOGIN_FAILURES_PER_EMAIL)
        assert client.post(LOGIN, json={"email": customer.email, "password": "Customer@123"}).status_code == 429
        clock[0] += auth_routes.LOGIN_WINDOW_SECONDS + 1
        assert client.post(LOGIN, json={"email": customer.email, "password": "Customer@123"}).status_code == 200

    def test_a_suspended_account_is_not_counted_as_a_guess(self, client, db, customer):
        customer.status = "blocked"
        db.flush()
        for _ in range(auth_routes.LOGIN_FAILURES_PER_EMAIL + 2):
            response = client.post(LOGIN, json={"email": customer.email, "password": "Customer@123"})
            assert response.status_code == 403  # still told the truth, never paused


class TestAdminSignIn:
    def test_paused_after_ten_failures(self, client, admin):
        _fail(client, ADMIN_LOGIN, admin.email, auth_routes.LOGIN_FAILURES_PER_EMAIL)
        response = client.post(ADMIN_LOGIN, json={"email": admin.email, "password": "Admin@123"})
        assert response.status_code == 429 and response.json()["error_code"] == "TOO_MANY_ATTEMPTS"

    def test_the_pause_is_in_the_audit_trail(self, client, db, admin):
        from app.models import AuditLog

        _fail(client, ADMIN_LOGIN, admin.email, auth_routes.LOGIN_FAILURES_PER_EMAIL)
        client.post(ADMIN_LOGIN, json={"email": admin.email, "password": "Admin@123"})
        rows = db.query(AuditLog).filter(AuditLog.action == "auth.login_failed").all()
        assert any(row.error_code == "TOO_MANY_ATTEMPTS" for row in rows)

    def test_portal_and_storefront_are_paused_separately(self, client, customer, admin):
        """Guessing at the portal doesn't sign a shopper out of the shop, or the reverse."""
        _fail(client, ADMIN_LOGIN, customer.email, auth_routes.LOGIN_FAILURES_PER_EMAIL)
        assert client.post(LOGIN, json={"email": customer.email, "password": "Customer@123"}).status_code == 200


class TestLimiterPrimitives:
    def test_exceeded_records_nothing(self):
        for _ in range(5):
            assert not rate_limit.exceeded("k", limit=1, window_seconds=60)

    def test_record_then_exceeded(self):
        rate_limit.record("k")
        assert rate_limit.exceeded("k", limit=1, window_seconds=60)
        assert not rate_limit.exceeded("k", limit=2, window_seconds=60)

    def test_old_hits_fall_out_of_the_window(self, monkeypatch):
        clock = [0.0]
        monkeypatch.setattr(rate_limit.time, "monotonic", lambda: clock[0])
        rate_limit.record("k")
        clock[0] = 61.0
        assert not rate_limit.exceeded("k", limit=1, window_seconds=60)
