"""
Admin → Settings → Authentication: GET/PUT /api/admin/auth/methods, the
public GET /api/auth/methods, and what the switches do to password sign-up
and sign-in (`services.identity.methods`, settings document `auth_methods`).
"""

from __future__ import annotations

from datetime import datetime

import pytest

from app.core.config import settings
from app.core.security import hash_password
from app.models import AdminUser, AuditLog, Customer, CustomerToken, SettingDocument
from tests.conftest import ADMIN_PASSWORD, PASSWORD
from tests.integration.test_identity_helpers import providers_configured  # noqa: F401 — fixture

pytestmark = pytest.mark.integration

ADMIN_URL = "/api/admin/auth/methods"
PUBLIC_URL = "/api/auth/methods"
ALL_KEYS = ["emailPassword", "emailOtp", "mobileOtp", "google", "apple", "microsoft"]


@pytest.fixture(autouse=True)
def _baseline(monkeypatch):
    """Whatever `.env` says: development, no social credentials, console SMS, URLs from the request."""
    monkeypatch.setattr(settings, "ENVIRONMENT", "development")
    monkeypatch.setattr(settings, "PUBLIC_API_URL", "")
    monkeypatch.setattr(settings, "OTP_SMS_PROVIDER", "console")
    for name in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET",
                 "APPLE_CLIENT_ID", "APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY"):
        monkeypatch.setattr(settings, name, "")
    monkeypatch.setattr(settings, "MICROSOFT_TENANT", "common")


def _admin_headers(client, db, *, admin_id, email, role, permissions):
    db.add(AdminUser(id=admin_id, email=email, password_hash=hash_password(ADMIN_PASSWORD), name="Limited Admin",
                     role=role, permissions=permissions, status="active", created_at=datetime(2026, 1, 1)))
    db.flush()
    response = client.post("/api/admin/auth/login", json={"email": email, "password": ADMIN_PASSWORD})
    assert response.status_code == 200, response.text
    return {"Authorization": "Bearer " + response.json()["data"]["token"]["accessToken"]}


def _rows(response) -> dict:
    return {row["key"]: row for row in response.json()["data"]["methods"]}


def _register(client, email="new.signup@example.com", **extra):
    body = {"email": email, "password": "Shopper@123", "firstName": "Neha", "lastName": "Iyer", **extra}
    return client.post("/api/auth/register", json=body)


# ------------------------------------------------------------- permission


class TestPermission:
    def test_anonymous_is_refused(self, client):
        assert client.get(ADMIN_URL).status_code == 401
        assert client.put(ADMIN_URL, json={"google": False}).status_code == 401

    def test_customer_token_is_refused(self, client, auth):
        assert client.get(ADMIN_URL, headers=auth).status_code in (401, 403)

    def test_admin_role_without_auth_settings_gets_403(self, client, db, admin):
        headers = _admin_headers(client, db, admin_id="ADM020", email="ops.admin@example.com", role="admin",
                                 permissions=["products", "orders", "settings"])
        for response in (client.get(ADMIN_URL, headers=headers),
                         client.put(ADMIN_URL, headers=headers, json={"google": False})):
            assert response.status_code == 403
            assert response.json()["error_code"] == "PERMISSION_DENIED"
        assert db.get(SettingDocument, "auth_methods") is None

    def test_editor_gets_403(self, client, db, admin, editor):
        response = client.post("/api/admin/auth/login", json={"email": editor.email, "password": ADMIN_PASSWORD})
        headers = {"Authorization": "Bearer " + response.json()["data"]["token"]["accessToken"]}
        assert client.get(ADMIN_URL, headers=headers).status_code == 403

    def test_admin_granted_auth_settings_gets_200(self, client, db, admin):
        headers = _admin_headers(client, db, admin_id="ADM021", email="auth.admin@example.com", role="admin",
                                 permissions=["auth-settings"])
        assert client.get(ADMIN_URL, headers=headers).status_code == 200
        saved = client.put(ADMIN_URL, headers=headers, json={"apple": False})
        assert saved.status_code == 200, saved.text
        assert _rows(saved)["apple"]["enabled"] is False

    def test_super_admin_passes_without_the_permission_stored(self, client, admin, admin_auth):
        assert "auth-settings" not in admin.permissions
        assert client.get(ADMIN_URL, headers=admin_auth).status_code == 200


# ------------------------------------------------------------- admin view


class TestAdminView:
    def test_defaults_every_method_on_with_unconfigured_social(self, client, admin_auth):
        response = client.get(ADMIN_URL, headers=admin_auth)
        assert response.status_code == 200
        data = response.json()["data"]
        assert [row["key"] for row in data["methods"]] == ALL_KEYS
        assert data["signupVerification"] == "both"  # the code on the sign-up page, and the link
        assert set(data["summary"]) >= {"signInsToday", "signInsByMethod", "otpSentToday", "oauthFailuresToday"}
        rows = _rows(response)
        assert all(row["enabled"] is True for row in rows.values())
        assert rows["emailPassword"]["configured"] is True and rows["emailPassword"]["reason"] == ""
        assert rows["emailPassword"]["social"] is False and "redirectUri" not in rows["emailPassword"]
        assert rows["google"]["configured"] is False
        assert rows["google"]["reason"] == "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set."
        assert rows["microsoft"]["reason"] == "MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET are not set."
        assert rows["apple"]["configured"] is False
        assert rows["apple"]["reason"] == ("APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY "
                                           "are not set.")

    def test_redirect_uri_for_each_social_provider(self, client, admin_auth):
        rows = _rows(client.get(ADMIN_URL, headers=admin_auth))
        for key in ("google", "apple", "microsoft"):
            assert rows[key]["social"] is True
            assert rows[key]["redirectUri"] == f"http://testserver/api/auth/oauth/{key}/callback"

    def test_redirect_uri_uses_public_api_url(self, client, admin_auth, monkeypatch):
        monkeypatch.setattr(settings, "PUBLIC_API_URL", "https://api.example.com/")
        rows = _rows(client.get(ADMIN_URL, headers=admin_auth))
        assert rows["google"]["redirectUri"] == "https://api.example.com/api/auth/oauth/google/callback"

    def test_configured_providers_and_no_secret_leaks(self, client, admin_auth, providers_configured):  # noqa: F811
        response = client.get(ADMIN_URL, headers=admin_auth)
        rows = _rows(response)
        for key in ("google", "apple", "microsoft"):
            assert rows[key]["configured"] is True and rows[key]["reason"] == ""
        body = response.text
        for secret in ("google-secret", "ms-secret", "PRIVATE KEY", settings.APPLE_PRIVATE_KEY[40:80]):
            assert secret not in body

    def test_only_the_missing_apple_setting_is_named(self, client, admin_auth, providers_configured,  # noqa: F811
                                                    monkeypatch):
        monkeypatch.setattr(settings, "APPLE_KEY_ID", "")
        assert _rows(client.get(ADMIN_URL, headers=admin_auth))["apple"]["reason"] == "APPLE_KEY_ID is not set."

    def test_bad_microsoft_tenant_is_not_configured(self, client, admin_auth, providers_configured,  # noqa: F811
                                                  monkeypatch):
        monkeypatch.setattr(settings, "MICROSOFT_TENANT", "not a tenant!")
        row = _rows(client.get(ADMIN_URL, headers=admin_auth))["microsoft"]
        assert row["configured"] is False and "MICROSOFT_TENANT" in row["reason"]

    @pytest.mark.parametrize("provider, fragment", [
        ("none", "OTP_SMS_PROVIDER"),
        ("carrier-pigeon", "Unknown OTP_SMS_PROVIDER 'carrier-pigeon'"),
        ("msg91", "MSG91_AUTH_KEY and MSG91_TEMPLATE_ID are not set."),
    ])
    def test_sms_provider_not_configured(self, client, admin_auth, monkeypatch, provider, fragment):
        monkeypatch.setattr(settings, "OTP_SMS_PROVIDER", provider)
        monkeypatch.setattr(settings, "MSG91_AUTH_KEY", "")
        monkeypatch.setattr(settings, "MSG91_TEMPLATE_ID", "")
        row = _rows(client.get(ADMIN_URL, headers=admin_auth))["mobileOtp"]
        assert row["enabled"] is True and row["configured"] is False
        assert fragment in row["reason"]

    def test_sms_console_is_configured_in_development_only(self, client, admin_auth, monkeypatch):
        assert _rows(client.get(ADMIN_URL, headers=admin_auth))["mobileOtp"]["configured"] is True
        monkeypatch.setattr(settings, "ENVIRONMENT", "production")
        row = _rows(client.get(ADMIN_URL, headers=admin_auth))["mobileOtp"]
        assert row["configured"] is False and "development only" in row["reason"]

    def test_msg91_with_credentials_is_configured(self, client, admin_auth, monkeypatch):
        monkeypatch.setattr(settings, "OTP_SMS_PROVIDER", "msg91")
        monkeypatch.setattr(settings, "MSG91_AUTH_KEY", "msg91-secret-key")
        monkeypatch.setattr(settings, "MSG91_TEMPLATE_ID", "tmpl-1")
        response = client.get(ADMIN_URL, headers=admin_auth)
        assert _rows(response)["mobileOtp"]["configured"] is True
        assert "msg91-secret-key" not in response.text

    def test_email_codes_need_an_email_account_in_production(self, client, admin_auth, monkeypatch):
        assert _rows(client.get(ADMIN_URL, headers=admin_auth))["emailOtp"]["configured"] is True
        monkeypatch.setattr(settings, "ENVIRONMENT", "production")
        row = _rows(client.get(ADMIN_URL, headers=admin_auth))["emailOtp"]
        assert row["configured"] is False and "email account" in row["reason"]


# -------------------------------------------------------------------- save


class TestSave:
    def test_put_merges_switches_and_persists(self, client, db, admin_auth):
        response = client.put(ADMIN_URL, headers=admin_auth, json={"google": False, "mobileOtp": False})
        assert response.status_code == 200, response.text
        assert response.json()["message"] == "Sign-in methods saved."
        rows = _rows(response)
        assert rows["google"]["enabled"] is False and rows["mobileOtp"]["enabled"] is False
        assert rows["apple"]["enabled"] is True and rows["emailPassword"]["enabled"] is True
        stored = db.get(SettingDocument, "auth_methods").value
        assert stored == {"emailPassword": True, "emailOtp": True, "mobileOtp": False, "google": False,
                          "apple": True, "microsoft": True, "signupVerification": "both"}
        # A second save merges onto the first.
        again = client.put(ADMIN_URL, headers=admin_auth, json={"google": True})
        assert _rows(again)["mobileOtp"]["enabled"] is False and _rows(again)["google"]["enabled"] is True

    def test_unknown_keys_are_ignored(self, client, db, admin_auth):
        response = client.put(ADMIN_URL, headers=admin_auth, json={"facebook": False, "emailOtp": False})
        assert response.status_code == 200
        assert "facebook" not in db.get(SettingDocument, "auth_methods").value

    @pytest.mark.parametrize("value", ["both", "code", "link"])
    def test_signup_verification_saved(self, client, admin_auth, value):
        response = client.put(ADMIN_URL, headers=admin_auth, json={"signupVerification": value})
        assert response.status_code == 200
        assert response.json()["data"]["signupVerification"] == value
        assert client.get(ADMIN_URL, headers=admin_auth).json()["data"]["signupVerification"] == value

    @pytest.mark.parametrize("payload", [
        {"google": "no"}, {"google": 0}, {"emailPassword": None}, {"signupVerification": "sms"},
        {"signupVerification": ""},
    ])
    def test_invalid_setting(self, client, db, admin_auth, payload):
        response = client.put(ADMIN_URL, headers=admin_auth, json=payload)
        assert response.status_code == 422, response.text
        assert response.json()["error_code"] == "INVALID_SETTING"
        assert db.get(SettingDocument, "auth_methods") is None

    def test_non_object_body_is_refused(self, client, admin_auth):
        response = client.put(ADMIN_URL, headers=admin_auth, json=[{"google": False}])
        assert response.status_code == 422

    def test_every_method_off_is_refused(self, client, db, admin_auth):
        response = client.put(ADMIN_URL, headers=admin_auth, json={key: False for key in ALL_KEYS})
        assert response.status_code == 422
        assert response.json()["error_code"] == "NO_SIGN_IN_METHOD"
        assert db.get(SettingDocument, "auth_methods") is None

    def test_only_unconfigured_methods_left_on_is_refused(self, client, admin_auth):
        # Google, Apple and Microsoft stay on but have no credentials: nobody could sign in.
        response = client.put(ADMIN_URL, headers=admin_auth,
                              json={"emailPassword": False, "emailOtp": False, "mobileOtp": False})
        assert response.status_code == 422
        assert response.json()["error_code"] == "NO_SIGN_IN_METHOD"

    def test_a_configured_provider_alone_is_enough(self, client, admin_auth, providers_configured):  # noqa: F811
        response = client.put(ADMIN_URL, headers=admin_auth,
                              json={"emailPassword": False, "emailOtp": False, "mobileOtp": False,
                                    "apple": False, "microsoft": False})
        assert response.status_code == 200, response.text
        assert [k for k, row in _rows(response).items() if row["enabled"]] == ["google"]

    def test_put_writes_an_audit_row(self, client, db, admin, admin_auth):
        response = client.put(ADMIN_URL, headers=admin_auth, json={"google": False, "signupVerification": "code"})
        assert response.status_code == 200
        row = db.query(AuditLog).filter_by(action="auth_methods.update").one()
        assert row.actor_id == admin.id and row.actor_type == "admin"
        assert row.resource_type == "settings" and row.resource_id == "auth_methods"
        assert row.summary == f"{admin.name} changed the sign-in methods"
        assert row.changes == {"google": {"from": True, "to": False},
                               "signupVerification": {"from": "both", "to": "code"}}

    def test_refused_put_writes_no_audit_row(self, client, db, admin_auth):
        client.put(ADMIN_URL, headers=admin_auth, json={key: False for key in ALL_KEYS})
        assert db.query(AuditLog).filter_by(action="auth_methods.update").count() == 0


# ------------------------------------------------------------ public view


class TestPublicView:
    def test_defaults_without_social_credentials(self, client):
        response = client.get(PUBLIC_URL)
        assert response.status_code == 200
        assert response.json()["data"] == {"emailPassword": True, "emailOtp": True, "mobileOtp": True,
                                           "providers": [], "signupVerification": "both"}

    def test_lists_configured_providers_and_no_reasons_or_secrets(self, client, providers_configured):  # noqa: F811
        response = client.get(PUBLIC_URL)
        data = response.json()["data"]
        assert data["providers"] == [{"code": "google", "label": "Google"}, {"code": "apple", "label": "Apple"},
                                     {"code": "microsoft", "label": "Microsoft"}]
        body = response.text
        for leak in ("google-client", "google-secret", "ms-secret", "TEAM123456", "KEY1234567", "reason",
                     "redirectUri", "configured"):
            assert leak not in body

    def test_hides_switched_off_methods(self, client, admin_auth, providers_configured):  # noqa: F811
        client.put(ADMIN_URL, headers=admin_auth,
                   json={"apple": False, "emailOtp": False, "signupVerification": "code"})
        data = client.get(PUBLIC_URL).json()["data"]
        assert [p["code"] for p in data["providers"]] == ["google", "microsoft"]
        assert data["emailOtp"] is False and data["emailPassword"] is True
        assert data["signupVerification"] == "code"

    def test_hides_switched_on_but_unconfigured_sms(self, client, monkeypatch):
        monkeypatch.setattr(settings, "OTP_SMS_PROVIDER", "none")
        assert client.get(PUBLIC_URL).json()["data"]["mobileOtp"] is False

    def test_a_corrupt_stored_verification_falls_back_to_the_default(self, client, db):
        db.add(SettingDocument(key="auth_methods", value={"signupVerification": "carrier-pigeon"}))
        db.flush()
        assert client.get(PUBLIC_URL).json()["data"]["signupVerification"] == "both"


# --------------------------------------------- password sign-in switched off


class TestPasswordMethodDisabled:
    @pytest.fixture()
    def password_off(self, client, admin_auth):
        response = client.put(ADMIN_URL, headers=admin_auth, json={"emailPassword": False})
        assert response.status_code == 200, response.text

    def test_register_is_refused(self, client, db, password_off):
        response = _register(client)
        assert response.status_code == 403
        assert response.json()["error_code"] == "AUTH_METHOD_DISABLED"
        assert db.query(Customer).filter_by(email="new.signup@example.com").count() == 0

    def test_login_is_refused_even_with_the_right_password(self, client, customer, password_off):
        response = client.post("/api/auth/login", json={"email": customer.email, "password": PASSWORD})
        assert response.status_code == 403
        assert response.json()["error_code"] == "AUTH_METHOD_DISABLED"

    def test_admin_portal_login_is_unaffected(self, client, admin, password_off):
        response = client.post("/api/admin/auth/login", json={"email": admin.email, "password": ADMIN_PASSWORD})
        assert response.status_code == 200

    def test_public_view_hides_it(self, client, password_off):
        assert client.get(PUBLIC_URL).json()["data"]["emailPassword"] is False

    def test_switched_back_on_login_works(self, client, customer, admin_auth, password_off):
        client.put(ADMIN_URL, headers=admin_auth, json={"emailPassword": True})
        response = client.post("/api/auth/login", json={"email": customer.email, "password": PASSWORD})
        assert response.status_code == 200


# ------------------------------------------------------ sign-up verification


class TestSignupVerification:
    def _set(self, client, admin_auth, value):
        assert client.put(ADMIN_URL, headers=admin_auth, json={"signupVerification": value}).status_code == 200

    def _links(self, db, email):
        return db.query(CustomerToken).filter_by(email=email, purpose="email-verification").count()

    def test_link_has_no_verification_keys_and_sends_the_link(self, client, db, admin, admin_auth):
        self._set(client, admin_auth, "link")
        response = _register(client)
        assert response.status_code == 201, response.text
        data = response.json()["data"]
        assert "verification" not in data and "phoneVerification" not in data
        assert data["token"]["accessToken"]
        assert self._links(db, "new.signup@example.com") == 1

    def test_code_returns_an_email_challenge_and_no_link(self, client, db, admin, admin_auth):
        self._set(client, admin_auth, "code")
        response = _register(client)
        assert response.status_code == 201, response.text
        data = response.json()["data"]
        verification = data["verification"]
        assert verification["channel"] == "email" and verification["challengeId"]
        assert verification["destination"] != "new.signup@example.com"  # masked
        assert verification["length"] >= 4 and verification["expiresIn"] > 0
        assert data["phoneVerification"] is None  # no phone given
        assert self._links(db, "new.signup@example.com") == 0

    def test_the_default_asks_for_the_code_and_still_sends_the_link(self, client, db, admin):
        response = _register(client)
        assert response.status_code == 201, response.text
        assert response.json()["data"]["verification"]["channel"] == "email"
        assert self._links(db, "new.signup@example.com") == 1

    def test_both_returns_the_code_and_sends_the_link(self, client, db, admin, admin_auth):
        self._set(client, admin_auth, "both")
        response = _register(client)
        assert response.status_code == 201, response.text
        data = response.json()["data"]
        assert data["verification"]["channel"] == "email"
        assert self._links(db, "new.signup@example.com") == 1

    def test_code_with_a_phone_also_sends_an_sms_code(self, client, admin, admin_auth):
        self._set(client, admin_auth, "code")
        response = _register(client, phone="+919876500077")
        assert response.status_code == 201, response.text
        phone = response.json()["data"]["phoneVerification"]
        assert phone is not None and phone["channel"] == "sms" and phone["challengeId"]

    def test_code_with_a_phone_but_sms_switched_off(self, client, admin, admin_auth):
        assert client.put(ADMIN_URL, headers=admin_auth,
                          json={"signupVerification": "code", "mobileOtp": False}).status_code == 200
        response = _register(client, phone="+919876500078")
        assert response.status_code == 201, response.text
        data = response.json()["data"]
        assert data["verification"]["channel"] == "email" and data["phoneVerification"] is None
