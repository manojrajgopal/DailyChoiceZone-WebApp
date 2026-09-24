"""
Who is allowed to do what.

The portal hides buttons a role cannot use. That is a courtesy to the person
using it, not a boundary — this is the boundary, and these are the tests of it.
"""

from __future__ import annotations

import pytest

from tests.conftest import ADMIN_PASSWORD, PASSWORD

pytestmark = pytest.mark.integration


READ_ENDPOINTS = [
    "/api/admin/dashboard",
    "/api/admin/products",
    "/api/admin/orders",
    "/api/admin/customers",
    "/api/admin/inventory",
    "/api/admin/coupons",
    "/api/admin/reviews",
    "/api/admin/users",
    "/api/admin/billing/invoices",
    "/api/admin/billing/payments",
    "/api/admin/billing/refunds",
    "/api/admin/billing/credit-notes",
    "/api/admin/billing/stats",
    "/api/admin/billing/tax-report",
    "/api/admin/settings/store",
]


class TestNoToken:
    @pytest.mark.parametrize("path", READ_ENDPOINTS)
    def test_every_admin_endpoint_needs_a_token(self, client, path):
        assert client.get(path).status_code == 401

    def test_a_forged_token_is_refused(self, client):
        response = client.get("/api/admin/products",
                              headers={"Authorization": "Bearer made.up.token"})
        assert response.status_code == 401


class TestWrongActor:
    @pytest.mark.parametrize("path", READ_ENDPOINTS)
    def test_a_customer_token_opens_nothing_in_the_portal(self, client, auth, path):
        """
        A customer's token is perfectly valid — and must not be enough.

        Without the `actor` claim, signing in as any customer would be a way
        into every administrator's screen. That is the whole reason the claim
        exists, so every endpoint is checked rather than a representative one.
        """
        assert client.get(path, headers=auth).status_code == 403

    def test_an_admin_token_opens_nothing_of_a_customers(self, client, admin_auth):
        """It cuts both ways: an administrator is not a shopper either."""
        for path in ("/api/cart", "/api/wishlist", "/api/orders", "/api/auth/me"):
            assert client.get(path, headers=admin_auth).status_code == 403


class TestSuspendedAdmin:
    def test_a_disabled_administrator_cannot_sign_in(self, client, db, admin):
        admin.status = "disabled"
        db.flush()

        response = client.post("/api/admin/auth/login",
                               json={"email": admin.email, "password": ADMIN_PASSWORD})
        assert response.status_code == 403
        assert response.json()["error_code"] == "ACCOUNT_BLOCKED"

    def test_disabling_takes_effect_on_the_next_request(self, client, db, admin, admin_auth):
        assert client.get("/api/admin/dashboard", headers=admin_auth).status_code == 200

        admin.status = "disabled"
        db.flush()

        assert client.get("/api/admin/dashboard", headers=admin_auth).status_code == 403

    def test_a_wrong_admin_password_is_refused(self, client, admin):
        response = client.post("/api/admin/auth/login",
                               json={"email": admin.email, "password": "Wrong@123"})
        assert response.status_code == 401

    def test_a_customer_password_does_not_open_the_portal(self, client, customer):
        """The two account tables are separate, and so are the two sign-ins."""
        response = client.post("/api/admin/auth/login",
                               json={"email": customer.email, "password": PASSWORD})
        assert response.status_code == 401


class TestPermissions:
    @pytest.fixture()
    def editor_auth(self, client, editor):
        response = client.post("/api/admin/auth/login",
                               json={"email": editor.email, "password": ADMIN_PASSWORD})
        token = response.json()["data"]["token"]["accessToken"]
        return {"Authorization": f"Bearer {token}"}

    def test_the_login_reports_what_the_role_may_do(self, client, editor):
        response = client.post("/api/admin/auth/login",
                               json={"email": editor.email, "password": ADMIN_PASSWORD})
        assert set(response.json()["data"]["admin"]["permissions"]) == {"products", "content"}

    def test_an_editor_can_read(self, client, editor_auth):
        assert client.get("/api/admin/dashboard", headers=editor_auth).status_code == 200

    def test_an_editor_cannot_change_settings(self, client, editor_auth):
        response = client.put("/api/admin/settings/store", headers=editor_auth, json={"a": 1})
        assert response.status_code == 403
        assert response.json()["error_code"] == "PERMISSION_DENIED"

    def test_an_editor_cannot_add_an_administrator(self, client, editor_auth):
        response = client.post("/api/admin/users", headers=editor_auth, json={
            "name": "Sneaky", "email": "sneaky@dailychoicezone.com",
            "role": "super-admin", "password": "Sneaky@123",
        })
        assert response.status_code == 403

    def test_a_super_admin_can_do_both(self, client, admin_auth):
        assert client.put("/api/admin/settings/store", headers=admin_auth,
                          json={"shipping": {"standardFee": 99}}).status_code == 200

    def test_a_super_admin_is_not_enumerated_in_every_list(self, client, admin_auth, admin):
        """
        The role carries every permission rather than listing them.

        Checked because the alternative — a super admin whose list is missing
        one entry — locks the only account that can fix it.
        """
        admin.permissions = []
        assert client.put("/api/admin/settings/store", headers=admin_auth,
                          json={"shipping": {}}).status_code == 200


class TestSettingsDocuments:
    def test_only_the_known_documents_are_reachable(self, client, admin_auth):
        """
        An allowlist, so a crafted key cannot read something that was never
        meant to be configuration.
        """
        for key in ("store", "billing", "tax", "site"):
            assert client.get(f"/api/admin/settings/{key}", headers=admin_auth).status_code == 200

        for key in ("secrets", "credentials", "../etc/passwd"):
            assert client.get(f"/api/admin/settings/{key}",
                              headers=admin_auth).status_code == 404


class TestErrorShape:
    def test_a_refusal_uses_the_same_envelope_as_a_success(self, client, auth):
        body = client.get("/api/admin/products", headers=auth).json()
        assert body["success"] is False
        assert body["message"]
        assert body["error_code"]

    def test_no_stack_trace_reaches_the_client(self, client):
        """A driver message or a traceback describes the schema to an attacker."""
        body = client.get("/api/products/PRD999").text.lower()
        for leak in ("traceback", "sqlalchemy", "pymysql", "select ", "file \""):
            assert leak not in body
