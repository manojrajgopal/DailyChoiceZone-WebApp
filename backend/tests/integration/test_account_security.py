"""
The Security section of the account: what it reports, linking and unlinking
sign-in accounts, the sign-in mobile number, confirming the email address with
a code, setting a first password and changing it.

Codes are caught at the provider boundary (`otp_providers.send_sms` /
`send_email`), so everything from the challenge row to the hash check is real.
"""

from __future__ import annotations

from datetime import datetime
from urllib.parse import parse_qs, urlparse

import pytest

from app.core.config import settings
from app.models import CustomerIdentity, CustomerSession, OAuthState, OtpChallenge
from app.services import sessions
from app.services.identity import accounts as identity_accounts
from app.services.identity import crypto
from tests.conftest import PASSWORD
from tests.integration.test_identity_helpers import decode, providers_configured  # noqa: F401 — fixture

pytestmark = pytest.mark.integration

NEW_PASSWORD = "Fresh@Pass2026"


# ---------------------------------------------------------------- fixtures


class Outbox:
    """Every code the app tried to send, newest last."""

    def __init__(self):
        self.sent: list = []

    def last(self, channel: str | None = None) -> dict:
        rows = [row for row in self.sent if channel is None or row["channel"] == channel]
        assert rows, f"no {channel or ''} code was sent"
        return rows[-1]


@pytest.fixture()
def codes(monkeypatch):
    from app.services import otp_providers

    box = Outbox()

    def fake_sms(to, code, purpose, minutes):
        box.sent.append({"channel": "sms", "to": to, "code": code, "purpose": purpose})
        return "console"

    def fake_email(db, to, code, purpose, minutes):
        box.sent.append({"channel": "email", "to": to, "code": code, "purpose": purpose})
        return "email"

    monkeypatch.setattr(otp_providers, "send_sms", fake_sms)
    monkeypatch.setattr(otp_providers, "send_email", fake_email)
    monkeypatch.setattr(settings, "OTP_RESEND_SECONDS", 0)
    return box


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def login(client, email="shopper@example.com", password=PASSWORD, agent="pytest-a") -> str:
    response = client.post("/api/auth/login", json={"email": email, "password": password},
                           headers={"user-agent": agent})
    assert response.status_code == 200, response.text
    return response.json()["data"]["token"]["accessToken"]


def passwordless(db, *, email="social.only@example.com", provider="google", subject="g-social-1"):
    """A customer whose only way in is one linked account, signed in with it."""
    person = identity_accounts.create_customer(db, email=email, first_name="Mira", last_name="Das")
    identity = identity_accounts.add_identity(db, person, provider, subject, email=email, email_verified=True)
    token = sessions.issue(db, person, provider)
    db.commit()
    return person, identity, bearer(token.access_token)


def add_phone(db, person, number="+919876511111"):
    identity = identity_accounts.add_identity(db, person, identity_accounts.PHONE, number)
    person.phone = number
    person.phone_verified_at = datetime.utcnow()
    db.commit()
    return identity


def error(response) -> str:
    return response.json()["error_code"]


# ---------------------------------------------------------------- security


class TestSecurityView:
    def test_a_password_customer(self, client, auth, customer):
        response = client.get("/api/account/security", headers=auth)
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["email"] == "shopper@example.com"
        assert data["emailVerified"] is False
        assert data["hasPassword"] is True
        assert data["phone"] == "" and data["phoneVerified"] is False
        assert data["contactPhone"] == "9876500001"
        assert data["identities"] == []
        assert data["waysIn"] == 1
        assert isinstance(data["providers"], list) and isinstance(data["mobileOtp"], bool)

    def test_linked_accounts_and_phone_are_counted(self, client, db):
        person, identity, headers = passwordless(db)
        add_phone(db, person)
        data = client.get("/api/account/security", headers=headers).json()["data"]
        assert data["hasPassword"] is False
        assert data["phone"] == "+919876511111" and data["phoneVerified"] is True
        assert [row["provider"] for row in data["identities"]] == ["google"]  # the phone is not listed here
        assert data["identities"][0]["id"] == identity.id
        assert data["identities"][0]["email"] == "social.only@example.com"
        assert data["waysIn"] == 2

    def test_providers_are_flagged_linked(self, client, db, providers_configured):  # noqa: F811
        _, _, headers = passwordless(db)
        providers = {p["code"]: p["linked"] for p in
                     client.get("/api/account/security", headers=headers).json()["data"]["providers"]}
        assert providers.get("google") is True
        assert providers.get("microsoft") is False

    def test_signed_out_is_401(self, client):
        assert client.get("/api/account/security").status_code == 401


# --------------------------------------------------------- linked accounts


class TestLinkAndUnlink:
    def test_link_returns_a_start_url_with_a_one_time_ticket(self, client, db, auth, customer,
                                                             providers_configured):  # noqa: F811
        response = client.post("/api/account/identities/google/link", headers=auth,
                               json={"next": "/account/orders"})
        assert response.status_code == 200, response.text
        url = urlparse(response.json()["data"]["url"])
        assert url.path == "/api/auth/oauth/google/start"
        query = parse_qs(url.query)
        assert query["mode"] == ["link"]
        ticket = query["ticket"][0]
        row = db.query(OAuthState).filter_by(ticket_hash=crypto.sha256(ticket)).one()
        assert row.mode == "link" and row.customer_id == customer.id and row.provider == "google"
        assert row.next_path == "/account/orders"

    def test_link_without_a_body_goes_back_to_settings(self, client, db, auth, providers_configured):  # noqa: F811
        response = client.post("/api/account/identities/microsoft/link", headers=auth)
        assert response.status_code == 200, response.text
        ticket = parse_qs(urlparse(response.json()["data"]["url"]).query)["ticket"][0]
        assert db.query(OAuthState).filter_by(ticket_hash=crypto.sha256(ticket)).one().next_path == "/account/settings"

    def test_link_to_an_unknown_provider(self, client, auth, providers_configured):  # noqa: F811
        response = client.post("/api/account/identities/facebook/link", headers=auth)
        assert response.status_code == 422
        assert error(response) == "PROVIDER_UNAVAILABLE"

    def test_identities_list(self, client, db):
        person, identity, headers = passwordless(db)
        add_phone(db, person)
        rows = client.get("/api/account/identities", headers=headers).json()["data"]
        assert [(row["id"], row["provider"]) for row in rows] == [(identity.id, "google")]

    def test_unlink_with_a_password_left(self, client, db, auth, customer):
        identity = identity_accounts.add_identity(db, customer, "google", "g-shopper", email=customer.email)
        db.commit()
        response = client.delete(f"/api/account/identities/{identity.id}", headers=auth)
        assert response.status_code == 200, response.text
        assert response.json()["data"]["identities"] == []
        assert db.get(CustomerIdentity, identity.id) is None

    def test_the_last_way_in_cannot_be_unlinked(self, client, db):
        _, identity, headers = passwordless(db)
        response = client.delete(f"/api/account/identities/{identity.id}", headers=headers)
        assert response.status_code == 409
        assert error(response) == "LAST_SIGN_IN_METHOD"
        assert db.get(CustomerIdentity, identity.id) is not None

    def test_a_verified_phone_counts_as_another_way_in(self, client, db):
        person, identity, headers = passwordless(db)
        add_phone(db, person)
        assert client.delete(f"/api/account/identities/{identity.id}", headers=headers).status_code == 200

    def test_someone_elses_identity_looks_missing(self, client, db, auth):
        _, theirs, _ = passwordless(db)
        response = client.delete(f"/api/account/identities/{theirs.id}", headers=auth)
        assert response.status_code == 404
        assert error(response) == "IDENTITY_NOT_FOUND"
        assert db.get(CustomerIdentity, theirs.id) is not None

    def test_an_unknown_identity(self, client, auth):
        response = client.delete("/api/account/identities/999999", headers=auth)
        assert response.status_code == 404 and error(response) == "IDENTITY_NOT_FOUND"

    def test_the_phone_identity_is_not_unlinked_here(self, client, db, auth, customer):
        phone = add_phone(db, customer)
        response = client.delete(f"/api/account/identities/{phone.id}", headers=auth)
        assert response.status_code == 404 and error(response) == "IDENTITY_NOT_FOUND"


# ------------------------------------------------------------------- phone


class TestPhone:
    def test_add_a_number(self, client, db, auth, customer, codes):
        response = client.post("/api/account/phone/otp", headers=auth, json={"phone": "98765 22222"})
        assert response.status_code == 200, response.text
        issued = response.json()["data"]
        assert issued["channel"] == "sms" and issued["length"] == 6
        assert issued["destination"] and issued["destination"] != "+919876522222"  # masked
        sent = codes.last("sms")
        assert sent["to"] == "+919876522222" and sent["purpose"] == "verify-phone"
        row = db.get(OtpChallenge, issued["challengeId"])
        assert row.purpose == "verify-phone" and row.customer_id == customer.id
        assert sent["code"] not in row.code_hash

        verified = client.post("/api/account/phone/verify", headers=auth,
                               json={"challengeId": issued["challengeId"], "code": sent["code"]})
        assert verified.status_code == 200, verified.text
        data = verified.json()["data"]
        assert data["phone"] == "+919876522222" and data["phoneVerified"] is True
        assert data["waysIn"] == 2
        db.refresh(customer)
        assert customer.phone == "+919876522222" and customer.phone_verified_at is not None

    def test_a_second_number_is_a_change(self, client, db, auth, customer, codes):
        add_phone(db, customer, "+919876533333")
        response = client.post("/api/account/phone/otp", headers=auth, json={"phone": "9876544444"})
        assert response.status_code == 200, response.text
        assert codes.last("sms")["purpose"] == "change-phone"
        challenge = response.json()["data"]["challengeId"]
        assert db.get(OtpChallenge, challenge).purpose == "change-phone"
        verified = client.post("/api/account/phone/verify", headers=auth,
                               json={"challengeId": challenge, "code": codes.last("sms")["code"]})
        assert verified.status_code == 200, verified.text
        phones = db.query(CustomerIdentity).filter_by(customer_id=customer.id, provider="phone").all()
        assert [row.provider_user_id for row in phones] == ["+919876544444"]  # replaced, not added

    def test_a_wrong_code(self, client, auth, codes):
        challenge = client.post("/api/account/phone/otp", headers=auth,
                                json={"phone": "9876522222"}).json()["data"]["challengeId"]
        wrong = "000000" if codes.last()["code"] != "000000" else "111111"
        response = client.post("/api/account/phone/verify", headers=auth,
                               json={"challengeId": challenge, "code": wrong})
        assert response.status_code == 422
        assert error(response) == "OTP_INCORRECT"
        assert response.json()["details"]["attemptsLeft"] == 4

    def test_someone_elses_code_is_no_good(self, client, db, auth, codes):
        _, _, theirs = passwordless(db)
        challenge = client.post("/api/account/phone/otp", headers=theirs,
                                json={"phone": "9876522222"}).json()["data"]["challengeId"]
        response = client.post("/api/account/phone/verify", headers=auth,
                               json={"challengeId": challenge, "code": codes.last()["code"]})
        assert response.status_code == 422 and error(response) == "OTP_INVALID"

    def test_a_number_used_by_another_account(self, client, db, auth, customer, codes):
        other, _, _ = passwordless(db)
        add_phone(db, other, "+919876555555")
        challenge = client.post("/api/account/phone/otp", headers=auth,
                                json={"phone": "9876555555"}).json()["data"]["challengeId"]
        response = client.post("/api/account/phone/verify", headers=auth,
                               json={"challengeId": challenge, "code": codes.last()["code"]})
        assert response.status_code == 409
        assert error(response) == "PHONE_IN_USE"
        owner = db.query(CustomerIdentity).filter_by(provider="phone", provider_user_id="+919876555555").one()
        assert owner.customer_id == other.id  # never moved
        # The code is spent either way.
        assert db.get(OtpChallenge, challenge).status == "verified"

    def test_an_invalid_number(self, client, auth, codes):
        response = client.post("/api/account/phone/otp", headers=auth, json={"phone": "123456"})
        assert response.status_code == 422 and error(response) == "PHONE_INVALID"
        assert codes.sent == []

    def test_remove_the_number(self, client, db, auth, customer):
        add_phone(db, customer)
        response = client.delete("/api/account/phone", headers=auth)
        assert response.status_code == 200, response.text
        assert response.json()["data"]["phone"] == "" and response.json()["data"]["phoneVerified"] is False
        db.refresh(customer)
        assert customer.phone_verified_at is None

    def test_remove_when_there_is_none(self, client, auth):
        response = client.delete("/api/account/phone", headers=auth)
        assert response.status_code == 404 and error(response) == "PHONE_NOT_FOUND"

    def test_the_only_way_in_cannot_be_removed(self, client, db):
        person = identity_accounts.create_customer(db, email="phone.only@example.com", first_name="Kiran")
        add_phone(db, person, "+919876566666")
        headers = bearer(sessions.issue(db, person, "otp-sms").access_token)
        db.commit()
        response = client.delete("/api/account/phone", headers=headers)
        assert response.status_code == 409 and error(response) == "LAST_SIGN_IN_METHOD"
        assert identity_accounts.phone_identity(db, person) is not None


# ------------------------------------------------------- confirming email


class TestEmailCode:
    def test_confirm_with_a_code(self, client, db, auth, customer, codes):
        response = client.post("/api/account/email/code", headers=auth)
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["alreadyVerified"] is False and data["channel"] == "email"
        sent = codes.last("email")
        assert sent["to"] == "shopper@example.com" and sent["purpose"] == "verify-email"

        verified = client.post("/api/account/email/verify-code", headers=auth,
                               json={"challengeId": data["challengeId"], "code": sent["code"]})
        assert verified.status_code == 200, verified.text
        assert verified.json()["data"]["emailVerified"] is True
        assert verified.json()["data"]["email"] == "shopper@example.com"
        db.refresh(customer)
        assert customer.email_verified_at is not None

    def test_already_confirmed(self, client, db, auth, customer, codes):
        customer.email_verified_at = datetime.utcnow()
        db.commit()
        response = client.post("/api/account/email/code", headers=auth)
        assert response.status_code == 200
        assert response.json()["data"] == {"alreadyVerified": True}
        assert codes.sent == []

    def test_a_code_is_used_once(self, client, auth, codes):
        challenge = client.post("/api/account/email/code", headers=auth).json()["data"]["challengeId"]
        body = {"challengeId": challenge, "code": codes.last()["code"]}
        assert client.post("/api/account/email/verify-code", headers=auth, json=body).status_code == 200
        again = client.post("/api/account/email/verify-code", headers=auth, json=body)
        assert again.status_code == 422 and error(again) == "OTP_USED"

    def test_a_phone_code_is_not_an_email_code(self, client, auth, codes):
        challenge = client.post("/api/account/phone/otp", headers=auth,
                                json={"phone": "9876522222"}).json()["data"]["challengeId"]
        response = client.post("/api/account/email/verify-code", headers=auth,
                               json={"challengeId": challenge, "code": codes.last()["code"]})
        assert response.status_code == 422 and error(response) == "OTP_INVALID"

    def test_a_newer_code_supersedes(self, client, auth, codes):
        first = client.post("/api/account/email/code", headers=auth).json()["data"]["challengeId"]
        first_code = codes.last()["code"]
        assert client.post("/api/account/email/code", headers=auth).status_code == 200
        response = client.post("/api/account/email/verify-code", headers=auth,
                               json={"challengeId": first, "code": first_code})
        assert response.status_code == 422 and error(response) == "OTP_SUPERSEDED"


# --------------------------------------------------------------- passwords


class TestFirstPassword:
    def test_set_a_first_password(self, client, db, codes):
        person, _, headers = passwordless(db)
        # Another device, signed in the same way.
        other = sessions.issue(db, person, "google", user_agent="Other device")
        db.commit()
        current_sid = decode(headers["Authorization"].split()[1])["sid"]

        issued = client.post("/api/account/password/otp", headers=headers)
        assert issued.status_code == 200, issued.text
        sent = codes.last("email")
        assert sent["to"] == "social.only@example.com" and sent["purpose"] == "sensitive-action"

        response = client.post("/api/account/password/set", headers=headers, json={
            "challengeId": issued.json()["data"]["challengeId"], "code": sent["code"], "newPassword": NEW_PASSWORD})
        assert response.status_code == 200, response.text
        token = response.json()["data"]["token"]["accessToken"]
        assert decode(token)["sid"] == current_sid  # the same device carries on

        db.refresh(person)
        assert person.password_hash and person.password_changed_at is not None
        assert person.email_verified_at is not None  # the email code proved the address
        assert client.get("/api/account/security", headers=bearer(token)).json()["data"]["hasPassword"] is True

        # The other device is signed out.
        row = db.get(CustomerSession, decode(other.access_token)["sid"])
        db.refresh(row)
        assert row.revoked_at is not None and row.revoked_reason == "password-changed"
        refused = client.get("/api/account/security", headers=bearer(other.access_token))
        assert refused.status_code == 401
        assert error(refused) in ("SESSION_REVOKED", "TOKEN_INVALID")

        # And the new password signs in.
        assert login(client, email="social.only@example.com", password=NEW_PASSWORD)

    def test_already_has_one(self, client, auth, codes):
        response = client.post("/api/account/password/otp", headers=auth)
        assert response.status_code == 409 and error(response) == "PASSWORD_ALREADY_SET"
        assert codes.sent == []
        set_ = client.post("/api/account/password/set", headers=auth,
                           json={"challengeId": "x", "code": "123456", "newPassword": NEW_PASSWORD})
        assert set_.status_code == 409 and error(set_) == "PASSWORD_ALREADY_SET"

    def test_a_wrong_code_sets_nothing(self, client, db, codes):
        person, _, headers = passwordless(db)
        challenge = client.post("/api/account/password/otp", headers=headers).json()["data"]["challengeId"]
        wrong = "000000" if codes.last()["code"] != "000000" else "111111"
        response = client.post("/api/account/password/set", headers=headers,
                               json={"challengeId": challenge, "code": wrong, "newPassword": NEW_PASSWORD})
        assert response.status_code == 422 and error(response) == "OTP_INCORRECT"
        db.refresh(person)
        assert person.password_hash is None

    def test_a_weak_password_is_refused(self, client, db, codes):
        _, _, headers = passwordless(db)
        challenge = client.post("/api/account/password/otp", headers=headers).json()["data"]["challengeId"]
        response = client.post("/api/account/password/set", headers=headers,
                               json={"challengeId": challenge, "code": codes.last()["code"], "newPassword": "short"})
        assert response.status_code == 422


class TestChangePassword:
    def test_change_returns_a_token_and_signs_out_other_devices(self, client, db, customer):
        mine = login(client, agent="device-one")
        other = login(client, agent="device-two")
        response = client.put("/api/account/password", headers=bearer(mine),
                              json={"currentPassword": PASSWORD, "newPassword": NEW_PASSWORD})
        assert response.status_code == 200, response.text
        token = response.json()["data"]["token"]["accessToken"]
        assert decode(token)["sid"] == decode(mine)["sid"]
        assert client.get("/api/auth/me", headers=bearer(token)).status_code == 200
        assert client.get("/api/auth/me", headers=bearer(other)).status_code == 401
        row = db.get(CustomerSession, decode(other)["sid"])
        db.refresh(row)
        assert row.revoked_reason == "password-changed"

    def test_the_current_password_is_required(self, client, auth):
        response = client.put("/api/account/password", headers=auth,
                              json={"currentPassword": "Wrong@Pass1", "newPassword": NEW_PASSWORD})
        assert response.status_code == 401 and error(response) == "INVALID_CREDENTIALS"

    def test_no_password_yet(self, client, db):
        _, _, headers = passwordless(db)
        response = client.put("/api/account/password", headers=headers,
                              json={"currentPassword": "anything1", "newPassword": NEW_PASSWORD})
        assert response.status_code == 409 and error(response) == "PASSWORD_NOT_SET"


# ----------------------------------------------------------------- profile


class TestProfilePhone:
    def test_changing_the_phone_clears_phone_verified(self, client, db, auth, customer):
        add_phone(db, customer, "+919876577777")
        assert client.get("/api/auth/me", headers=auth).json()["data"]["phoneVerified"] is True
        response = client.put("/api/account/profile", headers=auth, json={"phone": "9876588888"})
        assert response.status_code == 200, response.text
        assert response.json()["data"]["phone"] == "9876588888"
        assert response.json()["data"]["phoneVerified"] is False
        db.refresh(customer)
        assert customer.phone_verified_at is None
        # The sign-in phone itself is untouched until a code confirms the new one.
        assert identity_accounts.phone_identity(db, customer).provider_user_id == "+919876577777"

    def test_the_same_number_written_differently_stays_verified(self, client, db, auth, customer):
        add_phone(db, customer, "+919876577777")
        response = client.put("/api/account/profile", headers=auth, json={"phone": "98765 77777"})
        assert response.status_code == 200, response.text
        assert response.json()["data"]["phoneVerified"] is True

    def test_a_name_change_leaves_the_phone_alone(self, client, db, auth, customer):
        add_phone(db, customer, "+919876577777")
        response = client.put("/api/account/profile", headers=auth, json={"firstName": "Asha M"})
        assert response.status_code == 200
        assert response.json()["data"]["firstName"] == "Asha M"
        assert response.json()["data"]["phoneVerified"] is True
