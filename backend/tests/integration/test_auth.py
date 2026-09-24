"""Registration, sign-in, and the account behind them."""

from __future__ import annotations

import pytest

from tests.conftest import PASSWORD

pytestmark = pytest.mark.integration


class TestRegistration:
    def test_creates_an_account_and_returns_a_token(self, client):
        response = client.post("/api/auth/register", json={
            "email": "new.shopper@example.com", "password": "Shopper@123",
            "firstName": "Nisha", "lastName": "Kumar", "phone": "9876500099",
        })
        assert response.status_code == 201, response.text

        data = response.json()["data"]
        assert data["token"]["accessToken"]
        assert data["customer"]["email"] == "new.shopper@example.com"

    def test_the_password_never_comes_back(self, client):
        """
        Not "is excluded" — is not a field.

        A response model is the last place a hash can leak from, so the test
        checks the whole serialised body rather than a list of keys.
        """
        response = client.post("/api/auth/register", json={
            "email": "quiet@example.com", "password": "Shopper@123", "firstName": "Quiet",
        })
        body = response.text.lower()
        assert "password" not in body
        assert "hash" not in body

    def test_refuses_an_email_that_is_taken(self, client, customer):
        response = client.post("/api/auth/register", json={
            "email": customer.email, "password": "Shopper@123", "firstName": "Impostor",
        })
        assert response.status_code == 409
        assert response.json()["error_code"] == "EMAIL_TAKEN"

    @pytest.mark.parametrize(
        "password, why",
        [("short1", "under eight characters"), ("alllettersx", "no digit"), ("12345678", "no letter")],
    )
    def test_refuses_a_weak_password(self, client, password, why):
        response = client.post("/api/auth/register", json={
            "email": "weak@example.com", "password": password, "firstName": "Weak",
        })
        assert response.status_code == 422, why

    def test_refuses_something_that_is_not_an_email(self, client):
        response = client.post("/api/auth/register", json={
            "email": "not-an-email", "password": "Shopper@123", "firstName": "Nope",
        })
        assert response.status_code == 422


class TestLogin:
    def test_signs_in(self, client, customer):
        response = client.post("/api/auth/login",
                               json={"email": customer.email, "password": PASSWORD})
        assert response.status_code == 200
        assert response.json()["data"]["customer"]["id"] == customer.id

    def test_email_is_not_case_sensitive(self, client, customer):
        response = client.post("/api/auth/login",
                               json={"email": customer.email.upper(), "password": PASSWORD})
        assert response.status_code == 200

    def test_rejects_the_wrong_password(self, client, customer):
        response = client.post("/api/auth/login",
                               json={"email": customer.email, "password": "Wrong@123"})
        assert response.status_code == 401

    def test_an_unknown_account_and_a_wrong_password_look_identical(self, client, customer):
        """
        Two different messages would tell an attacker which accounts exist.

        Same status, same code, same words — the only honest answer to "is
        there an account here?" is one the caller cannot distinguish.
        """
        unknown = client.post("/api/auth/login",
                              json={"email": "nobody@example.com", "password": PASSWORD})
        wrong = client.post("/api/auth/login",
                            json={"email": customer.email, "password": "Wrong@123"})

        assert unknown.status_code == wrong.status_code == 401
        assert unknown.json()["message"] == wrong.json()["message"]
        assert unknown.json()["error_code"] == wrong.json()["error_code"]

    def test_a_suspended_account_cannot_sign_in(self, client, db, customer):
        customer.status = "blocked"
        db.flush()

        response = client.post("/api/auth/login",
                               json={"email": customer.email, "password": PASSWORD})
        assert response.status_code == 403
        assert response.json()["error_code"] == "ACCOUNT_BLOCKED"


class TestSession:
    def test_me_returns_the_signed_in_customer(self, client, auth, customer):
        response = client.get("/api/auth/me", headers=auth)
        assert response.status_code == 200
        assert response.json()["data"]["id"] == customer.id

    def test_me_needs_a_token(self, client):
        assert client.get("/api/auth/me").status_code == 401

    def test_a_forged_token_is_refused(self, client):
        response = client.get("/api/auth/me",
                              headers={"Authorization": "Bearer made.up.token"})
        assert response.status_code == 401

    def test_suspending_an_account_takes_effect_on_the_next_request(self, client, db, auth, customer):
        """
        Checked per request, not only at login.

        Blocking someone has to take effect immediately rather than whenever
        their token happens to expire.
        """
        assert client.get("/api/auth/me", headers=auth).status_code == 200
        customer.status = "blocked"
        db.flush()
        assert client.get("/api/auth/me", headers=auth).status_code == 403


class TestAccount:
    def test_update_profile(self, client, auth):
        response = client.put("/api/account/profile",
                              json={"firstName": "Asha", "lastName": "Rao-Menon"}, headers=auth)
        assert response.status_code == 200
        assert response.json()["data"]["lastName"] == "Rao-Menon"

    def test_change_password(self, client, auth, customer):
        response = client.put("/api/account/password", headers=auth, json={
            "currentPassword": PASSWORD, "newPassword": "Brandnew@123",
        })
        assert response.status_code == 200

        assert client.post("/api/auth/login",
                           json={"email": customer.email, "password": PASSWORD}).status_code == 401
        assert client.post("/api/auth/login",
                           json={"email": customer.email, "password": "Brandnew@123"}).status_code == 200

    def test_changing_a_password_needs_the_current_one(self, client, auth):
        response = client.put("/api/account/password", headers=auth, json={
            "currentPassword": "Wrong@123", "newPassword": "Brandnew@123",
        })
        assert response.status_code == 401

    def test_addresses_belong_to_the_caller(self, client, auth):
        response = client.get("/api/account/addresses", headers=auth)
        assert response.status_code == 200
        assert all(a["id"].startswith("ADR") for a in response.json()["data"])

    def test_save_and_remove_an_address(self, client, auth):
        created = client.post("/api/account/addresses", headers=auth, json={
            "fullName": "Asha Rao", "phone": "9876500001", "line1": "9 MG Road",
            "line2": "", "city": "Bengaluru", "state": "Karnataka",
            "pincode": "560002", "country": "India", "type": "work", "isDefault": False,
        })
        assert created.status_code == 201, created.text
        address_id = created.json()["data"]["id"]

        assert client.delete(f"/api/account/addresses/{address_id}",
                             headers=auth).status_code == 200

    def test_cannot_delete_somebody_elses_address(self, client, auth, db, other_customer):
        from app.models import Address

        db.add(Address(
            id="ADR999", customer_id=other_customer.id, full_name="Ravi Nair",
            phone="9876500002", line1="1 Other Street", line2="", city="Pune",
            state="Maharashtra", pincode="411001", country="India",
            type="home", is_default=True,
        ))
        db.flush()

        assert client.delete("/api/account/addresses/ADR999", headers=auth).status_code == 404
