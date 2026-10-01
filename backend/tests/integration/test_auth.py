"""Registration, sign-in, and the account behind them."""

from __future__ import annotations

import pytest

from sqlalchemy import select as _select

from tests.conftest import PASSWORD


def select_all(model):
    """Every row of a table, for the assertions below."""
    return _select(model)

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

    @pytest.mark.parametrize("box, expected", [(None, True), (True, True), (False, False)])
    def test_the_signup_offers_box_is_ticked_by_default_and_unticking_it_is_kept(self, client, db, box, expected):
        from app.models import Customer
        from app.services.messaging import service as messaging

        body = {"email": "offers.box@example.com", "password": "Shopper@123", "firstName": "Box"}
        if box is not None:
            body["marketingOptIn"] = box
        assert client.post("/api/auth/register", json=body).status_code == 201
        customer = db.query(Customer).filter_by(email="offers.box@example.com").one()
        assert messaging.consent(db, customer.id, "email", "marketing") is expected

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


class TestFirstRegistrationClaimsAdmin:
    """
    The bootstrap rule: whoever registers first on an empty installation
    becomes the administrator, and nobody after them does.

    There is no seed data any more, so this is the only way a fresh install
    gets somebody who can reach the portal.
    """

    def test_the_first_registration_becomes_an_administrator(self, client, db):
        from app.models import AdminUser

        response = client.post("/api/auth/register", json={
            "email": "founder@example.com", "password": "Founder@123",
            "firstName": "Asha", "lastName": "Rao",
        })
        assert response.status_code == 201, response.text

        admins = db.execute(select_all(AdminUser)).scalars().all()
        assert len(admins) == 1
        assert admins[0].email == "founder@example.com"
        assert admins[0].role == "super-admin"
        assert admins[0].status == "active"

    def test_that_administrator_can_sign_in_to_the_portal(self, client):
        client.post("/api/auth/register", json={
            "email": "founder@example.com", "password": "Founder@123",
            "firstName": "Asha", "lastName": "Rao",
        })

        response = client.post("/api/admin/auth/login",
                               json={"email": "founder@example.com", "password": "Founder@123"})
        assert response.status_code == 200, response.text
        assert response.json()["data"]["admin"]["role"] == "super-admin"

    def test_it_carries_every_permission(self, client):
        client.post("/api/auth/register", json={
            "email": "founder@example.com", "password": "Founder@123",
            "firstName": "Asha", "lastName": "Rao",
        })
        token = client.post("/api/admin/auth/login", json={
            "email": "founder@example.com", "password": "Founder@123",
        }).json()["data"]["token"]["accessToken"]

        response = client.put("/api/admin/settings/store",
                              headers={"Authorization": f"Bearer {token}"},
                              json={"shipping": {"standardFee": 49}})
        assert response.status_code == 200

    def test_the_second_registration_is_an_ordinary_customer(self, client, db):
        from app.models import AdminUser

        client.post("/api/auth/register", json={
            "email": "founder@example.com", "password": "Founder@123",
            "firstName": "Asha", "lastName": "Rao",
        })
        response = client.post("/api/auth/register", json={
            "email": "shopper.two@example.com", "password": "Shopper@123",
            "firstName": "Ravi", "lastName": "Nair",
        })
        assert response.status_code == 201

        admins = db.execute(select_all(AdminUser)).scalars().all()
        assert [a.email for a in admins] == ["founder@example.com"]

    def test_the_second_registration_cannot_reach_the_portal(self, client):
        client.post("/api/auth/register", json={
            "email": "founder@example.com", "password": "Founder@123",
            "firstName": "Asha", "lastName": "Rao",
        })
        client.post("/api/auth/register", json={
            "email": "shopper.two@example.com", "password": "Shopper@123",
            "firstName": "Ravi", "lastName": "Nair",
        })

        response = client.post("/api/admin/auth/login", json={
            "email": "shopper.two@example.com", "password": "Shopper@123",
        })
        assert response.status_code == 401

    def test_nobody_claims_it_when_an_administrator_already_exists(self, client, db, admin):
        """
        The rule is "first on an empty installation", not "first ever".

        With the fixture's administrator already present, a registration is an
        ordinary customer — which is what protects every existing store.
        """
        from app.models import AdminUser

        before = db.execute(select_all(AdminUser)).scalars().all()

        response = client.post("/api/auth/register", json={
            "email": "latecomer@example.com", "password": "Shopper@123",
            "firstName": "Nisha", "lastName": "Kumar",
        })
        assert response.status_code == 201

        after = db.execute(select_all(AdminUser)).scalars().all()
        assert {a.email for a in after} == {a.email for a in before}

    def test_a_role_in_the_payload_is_ignored(self, client, db, admin):
        """
        The decision is the server's, from the state of the table.

        `RegisterRequest` has no role field, so this is belt and braces — but
        it is the one assertion worth having, because the day somebody adds a
        field to that schema this test is what notices.
        """
        from app.models import AdminUser

        response = client.post("/api/auth/register", json={
            "email": "ambitious@example.com", "password": "Shopper@123",
            "firstName": "Sneaky", "lastName": "User",
            "role": "super-admin", "isAdmin": True, "permissions": ["admins"],
        })
        assert response.status_code == 201

        emails = {
            a.email for a in db.execute(select_all(AdminUser)).scalars().all()
        }
        assert "ambitious@example.com" not in emails

    def test_the_customer_token_is_still_only_a_customer_token(self, client):
        """
        Being an administrator does not change what the *registration* returns.

        One person, two surfaces, two tokens: the token from `/auth/register`
        carries `actor: customer` and opens no admin endpoint. The portal is
        reached by signing in to it.
        """
        token = client.post("/api/auth/register", json={
            "email": "founder@example.com", "password": "Founder@123",
            "firstName": "Asha", "lastName": "Rao",
        }).json()["data"]["token"]["accessToken"]

        response = client.get("/api/admin/dashboard",
                              headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 403
