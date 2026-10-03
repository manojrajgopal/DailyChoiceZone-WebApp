"""
Who is calling: the dependencies every protected endpoint goes through.

`test_auth.py` and `test_admin_authorization.py` cover the main paths (sign in,
wrong actor, suspension). These are the edges around them: tokens that are
expired, malformed, for accounts that no longer exist, or issued before a
password change; the "signed in if you are" dependency; and `require_access`,
which reads a role's current permissions as well as the stored copy.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from fastapi.security import HTTPAuthorizationCredentials
from starlette.requests import Request

from app.core.errors import AuthenticationError, AuthorizationError
from app.core.security import create_access_token
from app.dependencies import auth as deps

pytestmark = pytest.mark.integration


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _creds(token: str) -> HTTPAuthorizationCredentials:
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


# ---------------------------------------------------------------- over HTTP


class TestCustomerTokensOverHttp:
    def test_expired_token_is_refused_with_token_invalid(self, client, customer):
        token = create_access_token(customer.id, actor="customer", expires_minutes=-1)
        response = client.get("/api/auth/me", headers=_bearer(token))
        assert response.status_code == 401
        body = response.json()
        assert body == {"success": False, "message": body["message"], "error_code": "TOKEN_INVALID"}

    @pytest.mark.parametrize("header", ["Bearer", "Bearer ", "Basic dXNlcjpwYXNz", "Token abc", "abc.def.ghi"])
    def test_malformed_authorization_headers_are_unauthenticated(self, client, customer, header):
        response = client.get("/api/auth/me", headers={"Authorization": header})
        assert response.status_code == 401
        assert response.json()["success"] is False

    def test_token_signed_with_another_key_is_refused(self, client, customer):
        from jose import jwt

        forged = jwt.encode({"sub": customer.id, "actor": "customer", "exp": 4102444800}, "not-our-key",
                            algorithm="HS256")
        assert client.get("/api/auth/me", headers=_bearer(forged)).status_code == 401

    def test_unsigned_alg_none_token_is_refused(self, client, customer):
        import base64
        import json

        def part(value: dict) -> str:
            return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

        token = f'{part({"alg": "none", "typ": "JWT"})}.{part({"sub": customer.id, "actor": "customer"})}.'
        assert client.get("/api/auth/me", headers=_bearer(token)).status_code == 401

    def test_token_for_an_account_that_no_longer_exists(self, client, customer):
        token = create_access_token("CUS999", actor="customer")
        response = client.get("/api/auth/me", headers=_bearer(token))
        assert response.status_code == 401
        assert response.json()["error_code"] == "UNAUTHENTICATED"

    def test_token_issued_before_a_password_change_is_refused(self, client, customer, db, auth):
        assert client.get("/api/auth/me", headers=auth).status_code == 200
        customer.password_changed_at = datetime.utcnow() + timedelta(seconds=5)
        db.flush()
        response = client.get("/api/auth/me", headers=auth)
        assert response.status_code == 401
        assert response.json()["error_code"] == "TOKEN_INVALID"

    def test_blocked_customer_gets_account_blocked(self, client, customer, db, auth):
        customer.status = "blocked"
        db.flush()
        response = client.get("/api/auth/me", headers=auth)
        assert response.status_code == 403
        assert response.json()["error_code"] == "ACCOUNT_BLOCKED"


class TestAdminTokensOverHttp:
    def test_expired_admin_token(self, client, admin):
        token = create_access_token(admin.id, actor="admin", role=admin.role, expires_minutes=-1)
        assert client.get("/api/admin/auth/me", headers=_bearer(token)).status_code == 401

    def test_admin_that_no_longer_exists(self, client, admin):
        token = create_access_token("ADM999", actor="admin", role="super-admin")
        assert client.get("/api/admin/auth/me", headers=_bearer(token)).status_code == 401

    def test_suspended_admin_gets_account_blocked(self, client, admin, db, admin_auth):
        admin.status = "disabled"
        db.flush()
        response = client.get("/api/admin/auth/me", headers=admin_auth)
        assert response.status_code == 403
        assert response.json()["error_code"] == "ACCOUNT_BLOCKED"

    def test_a_role_claim_in_the_token_grants_nothing(self, client, editor):
        """The role is read from the database row, not from the token."""
        token = create_access_token(editor.id, actor="admin", role="super-admin")
        response = client.get("/api/admin/auth/accounts/settings", headers=_bearer(token))
        assert response.status_code == 403
        assert response.json()["error_code"] == "PERMISSION_DENIED"


class TestRequireAccess:
    """`require_access` accepts the stored permission list *or* the role's current one."""

    def test_permission_granted_by_the_role_table_but_not_stored(self, client, db, admin):
        from app.core.security import hash_password
        from app.models import AdminUser

        manager = AdminUser(id="ADM010", email="manager@dcz.test", password_hash=hash_password("Admin@123"),
                            name="M", role="manager", permissions=[], status="active",
                            created_at=datetime(2026, 1, 1))
        db.add(manager)
        db.flush()
        token = create_access_token(manager.id, actor="admin", role="manager")
        # `carts` is in the manager role's current list though not stored on the account.
        assert client.get("/api/admin/carts/abandoned/metrics", headers=_bearer(token)).status_code == 200
        # `payments` is in neither.
        response = client.get("/api/admin/payments/webhooks/metrics", headers=_bearer(token))
        assert response.status_code in (403, 404)
        if response.status_code == 403:
            assert response.json()["error_code"] == "PERMISSION_DENIED"

    def test_stored_permission_is_enough_for_an_unknown_role(self, client, db):
        from app.core.security import hash_password
        from app.models import AdminUser

        user = AdminUser(id="ADM011", email="custom@dcz.test", password_hash=hash_password("Admin@123"),
                         name="C", role="custom-role", permissions=["carts"], status="active",
                         created_at=datetime(2026, 1, 1))
        db.add(user)
        db.flush()
        token = create_access_token(user.id, actor="admin", role="custom-role")
        assert client.get("/api/admin/carts/abandoned/metrics", headers=_bearer(token)).status_code == 200

    def test_customer_token_on_require_access_endpoint(self, client, auth):
        assert client.get("/api/admin/carts/abandoned/metrics", headers=auth).status_code == 403


# ------------------------------------------------------- called directly


class TestCurrentCustomerDirectly:
    def test_no_credentials(self, db):
        with pytest.raises(AuthenticationError):
            deps.get_current_customer(None, db)

    def test_empty_credentials(self, db):
        with pytest.raises(AuthenticationError):
            deps.get_current_customer(_creds(""), db)

    def test_admin_token_on_customer_dependency(self, db, admin):
        with pytest.raises(AuthorizationError):
            deps.get_current_customer(_creds(create_access_token(admin.id, actor="admin")), db)

    def test_valid(self, db, customer):
        assert deps.get_current_customer(_creds(create_access_token(customer.id, actor="customer")), db) is customer


class TestOptionalCustomer:
    """Never raises: anything wrong with the token means "signed out"."""

    def test_no_header_is_none(self, db):
        assert deps.get_optional_customer(None, db) is None
        assert deps.get_optional_customer(_creds(""), db) is None

    def test_valid_token_is_the_customer(self, db, customer):
        assert deps.get_optional_customer(_creds(create_access_token(customer.id, actor="customer")), db) is customer

    @pytest.mark.parametrize("make", [
        lambda c: "rubbish",
        lambda c: create_access_token(c.id, actor="customer", expires_minutes=-1),
        lambda c: create_access_token(c.id, actor="admin"),
        lambda c: create_access_token("CUS999", actor="customer"),
    ])
    def test_bad_tokens_are_treated_as_signed_out(self, db, customer, make):
        assert deps.get_optional_customer(_creds(make(customer)), db) is None

    def test_blocked_customer_is_signed_out(self, db, customer):
        customer.status = "blocked"
        assert deps.get_optional_customer(_creds(create_access_token(customer.id, actor="customer")), db) is None

    def test_token_from_before_a_password_change_is_signed_out(self, db, customer):
        token = create_access_token(customer.id, actor="customer")
        customer.password_changed_at = datetime.utcnow() + timedelta(minutes=1)
        assert deps.get_optional_customer(_creds(token), db) is None

    def test_signed_out_and_signed_in_programme_both_answer(self, client, customer, auth):
        assert client.get("/api/memberships").status_code == 200
        assert client.get("/api/memberships", headers=auth).status_code == 200
        assert client.get("/api/memberships", headers=_bearer("rubbish")).status_code == 200


class TestPasswordChangeStamp:
    def test_no_stamp_never_invalidates(self, customer):
        customer.password_changed_at = None
        assert not deps._issued_before_password_change({"iat": 0}, customer)

    def test_token_issued_after_the_change_is_fine(self, customer):
        customer.password_changed_at = datetime(2026, 1, 1)
        assert not deps._issued_before_password_change({"iat": 1_900_000_000}, customer)

    def test_token_without_iat_is_treated_as_oldest(self, customer):
        customer.password_changed_at = datetime(2026, 1, 1)
        assert deps._issued_before_password_change({}, customer)


class TestRequirePermissionDirectly:
    def test_super_admin_passes_without_listing(self, admin):
        admin.permissions = []
        assert deps.require_permission("anything")(admin) is admin

    def test_listed_permission_passes(self, editor):
        assert deps.require_permission("content")(editor) is editor

    def test_unlisted_permission_is_denied(self, editor):
        with pytest.raises(AuthorizationError) as caught:
            deps.require_permission("settings")(editor)
        assert caught.value.error_code == "PERMISSION_DENIED"

    def test_null_permissions_deny(self, editor):
        editor.permissions = None
        with pytest.raises(AuthorizationError):
            deps.require_permission("content")(editor)

    def test_require_access_uses_the_role_table(self, editor):
        editor.permissions = []
        assert deps.require_access("bundles")(editor) is editor  # editor role includes bundles
        with pytest.raises(AuthorizationError):
            deps.require_access("backups")(editor)


class TestClientIp:
    def _request(self, headers=None, client=("10.0.0.1", 1234)):
        scope = {"type": "http", "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
                 "client": client}
        return Request(scope)

    def test_forwarded_for_is_ignored_from_an_untrusted_peer(self):
        # Anyone can send the header; from a peer that isn't a trusted proxy it must not change the address.
        assert deps.client_ip(self._request({"X-Forwarded-For": "1.2.3.4"})) == "10.0.0.1"

    def test_forwarded_for_from_a_trusted_proxy_is_the_last_untrusted_hop(self, monkeypatch):
        from app.core.config import settings

        monkeypatch.setattr(settings, "TRUSTED_PROXIES", ["10.0.0.1", "10.0.0.2"])
        # "1.2.3.4" was sent by the caller; 5.6.7.8 is who connected to our proxies.
        request = self._request({"X-Forwarded-For": " 1.2.3.4 , 5.6.7.8, 10.0.0.2"})
        assert deps.client_ip(request) == "5.6.7.8"

    def test_only_proxies_in_the_chain_falls_back_to_the_first(self, monkeypatch):
        from app.core.config import settings

        monkeypatch.setattr(settings, "TRUSTED_PROXIES", ["10.0.0.1", "10.0.0.2"])
        assert deps.client_ip(self._request({"X-Forwarded-For": "10.0.0.2"})) == "10.0.0.2"

    def test_falls_back_to_the_socket(self):
        assert deps.client_ip(self._request()) == "10.0.0.1"

    def test_unknown_without_either(self):
        assert deps.client_ip(self._request(client=None)) == "unknown"
