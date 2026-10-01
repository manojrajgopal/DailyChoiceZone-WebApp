"""
Password reset and email verification.

The links are read from the email the service asked to send (`notify` is
recorded rather than sent), because that is the only place a raw token ever
exists — the database holds only its hash.
"""

from __future__ import annotations

import re
import time
from datetime import datetime, timedelta

import pytest
from sqlalchemy import select

from app.core import rate_limit
from tests.conftest import PASSWORD

pytestmark = pytest.mark.integration

NEW_PASSWORD = "Brand-New@456"


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def mailbox(monkeypatch):
    """Every account email the service queued: key, recipient, subject, and the link in it."""
    from app.services import email as email_service

    sent = []

    def record(db, key, *, to, customer_id, subject, html, text, reference="", **_):
        found = re.search(r"token=([A-Za-z0-9_\-]+)", text)
        sent.append({"key": key, "to": to, "subject": subject, "text": text, "html": html,
                     "token": found.group(1) if found else None})
        return True

    monkeypatch.setattr(email_service, "notify", record)
    return sent


def _links(mailbox, subject_part):
    return [m["token"] for m in mailbox if subject_part in m["subject"] and m["token"]]


def forgot(client, email="shopper@example.com"):
    return client.post("/api/auth/password/forgot", json={"email": email})


def reset(client, token, password=NEW_PASSWORD, confirm=None):
    return client.post("/api/auth/password/reset",
                       json={"token": token, "password": password, "confirmPassword": confirm or password})


def login(client, password):
    return client.post("/api/auth/login", json={"email": "shopper@example.com", "password": password})


class TestRequestingAReset:
    def test_a_known_address_gets_a_link(self, client, customer, mailbox):
        response = forgot(client)
        assert response.status_code == 200
        assert len(_links(mailbox, "Reset your")) == 1
        assert mailbox[0]["to"] == "shopper@example.com"
        assert mailbox[0]["key"] == "account_security"

    def test_an_unknown_address_gets_the_same_answer_and_no_email(self, client, customer, mailbox):
        known = forgot(client).json()
        unknown = forgot(client, "nobody@example.com").json()
        assert known["message"] == unknown["message"]
        assert known["data"] == unknown["data"]
        assert len(mailbox) == 1  # only the real account's email

    def test_the_raw_token_is_never_stored(self, client, db, customer, mailbox):
        from app.models import CustomerToken

        forgot(client)
        raw = _links(mailbox, "Reset your")[0]
        stored = db.execute(select(CustomerToken)).scalars().all()
        assert len(stored) == 1
        assert stored[0].token_hash != raw and raw not in stored[0].token_hash
        assert len(stored[0].token_hash) == 64

    def test_requests_are_rate_limited_per_address(self, client, customer, mailbox):
        for _ in range(3):
            assert forgot(client).status_code == 200
        assert forgot(client).status_code == 429

    def test_a_suspended_account_gets_no_link(self, client, db, customer, mailbox):
        customer.status = "blocked"
        db.flush()
        assert forgot(client).status_code == 200
        assert mailbox == []


class TestUsingTheLink:
    def test_a_good_link_changes_the_password(self, client, customer, mailbox):
        forgot(client)
        token = _links(mailbox, "Reset your")[0]
        assert client.post("/api/auth/password/reset/check", json={"token": token}).status_code == 200

        response = reset(client, token)
        assert response.status_code == 200, response.text
        assert login(client, NEW_PASSWORD).status_code == 200
        assert login(client, PASSWORD).status_code == 401
        # And they're told it happened.
        assert any("password was changed" in m["subject"] for m in mailbox)

    def test_a_link_works_once(self, client, customer, mailbox):
        forgot(client)
        token = _links(mailbox, "Reset your")[0]
        assert reset(client, token).status_code == 200
        again = reset(client, token, "Another-One@789")
        assert again.status_code == 422
        assert again.json()["error_code"] == "TOKEN_USED"

    def test_an_expired_link_is_refused(self, client, db, customer, mailbox):
        from app.models import CustomerToken

        forgot(client)
        token = _links(mailbox, "Reset your")[0]
        row = db.execute(select(CustomerToken)).scalar_one()
        row.expires_at = datetime.utcnow() - timedelta(seconds=1)
        db.flush()
        response = reset(client, token)
        assert response.status_code == 422
        assert response.json()["error_code"] == "TOKEN_EXPIRED"
        assert login(client, PASSWORD).status_code == 200

    def test_an_invented_link_is_refused(self, client, customer):
        for token in ("not-a-real-token", "x" * 300):
            response = reset(client, token)
            assert response.status_code == 422
            assert response.json()["error_code"] in ("TOKEN_INVALID", "VALIDATION_ERROR")

    def test_an_earlier_link_stops_working_when_a_new_one_is_sent(self, client, customer, mailbox):
        forgot(client)
        forgot(client)
        first, second = _links(mailbox, "Reset your")
        assert reset(client, first).json()["error_code"] == "TOKEN_SUPERSEDED"
        assert reset(client, second).status_code == 200

    def test_a_link_for_a_changed_address_is_refused(self, client, db, customer, mailbox):
        forgot(client)
        token = _links(mailbox, "Reset your")[0]
        customer.email = "new.address@example.com"
        db.flush()
        assert reset(client, token).json()["error_code"] == "TOKEN_INVALID"

    def test_the_passwords_must_match(self, client, customer, mailbox):
        forgot(client)
        token = _links(mailbox, "Reset your")[0]
        response = reset(client, token, NEW_PASSWORD, "Different@456")
        assert response.status_code == 422
        assert response.json()["error_code"] == "PASSWORD_MISMATCH"
        # The link survives a typo.
        assert reset(client, token).status_code == 200

    @pytest.mark.parametrize("weak", ["short1A", "abcdefghij", "NoDigitsHere!", "12345678"])
    def test_a_weak_password_is_refused(self, client, customer, mailbox, weak):
        forgot(client)
        token = _links(mailbox, "Reset your")[0]
        assert reset(client, token, weak).status_code == 422
        assert login(client, PASSWORD).status_code == 200

    def test_attempts_are_rate_limited(self, client, customer):
        codes = [reset(client, f"guess-{i}").status_code for i in range(11)]
        assert codes[-1] == 429

    def test_sessions_from_before_the_reset_are_signed_out(self, client, customer, mailbox):
        old = login(client, PASSWORD).json()["data"]["token"]["accessToken"]
        headers = {"Authorization": f"Bearer {old}"}
        assert client.get("/api/auth/me", headers=headers).status_code == 200

        forgot(client)
        token = _links(mailbox, "Reset your")[0]
        time.sleep(1.1)  # token times are whole seconds
        assert reset(client, token).status_code == 200

        stale = client.get("/api/auth/me", headers=headers)
        assert stale.status_code == 401
        assert stale.json()["error_code"] == "TOKEN_INVALID"

        fresh = login(client, NEW_PASSWORD).json()["data"]["token"]["accessToken"]
        assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {fresh}"}).status_code == 200

    def test_nothing_secret_is_logged(self, client, customer, mailbox, caplog):
        caplog.set_level("DEBUG")
        forgot(client)
        token = _links(mailbox, "Reset your")[0]
        reset(client, token)
        assert token not in caplog.text
        assert NEW_PASSWORD not in caplog.text


class TestEmailVerification:
    def register(self, client, email="new.person@example.com"):
        return client.post("/api/auth/register", json={
            "firstName": "Neha", "lastName": "Iyer", "email": email, "password": PASSWORD,
            "confirmPassword": PASSWORD, "phone": "9876500009", "acceptTerms": True,
        })

    def test_a_new_account_is_unverified_and_gets_a_link(self, client, mailbox):
        response = self.register(client)
        assert response.status_code == 201, response.text
        assert response.json()["data"]["customer"]["emailVerified"] is False
        assert len(_links(mailbox, "Confirm your email")) == 1

    def test_the_link_verifies_the_address(self, client, mailbox):
        token = self.register(client).json()["data"]["token"]["accessToken"]
        link = _links(mailbox, "Confirm your email")[0]
        response = client.post("/api/auth/email/verify", json={"token": link})
        assert response.status_code == 200
        me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).json()["data"]
        assert me["emailVerified"] is True

    def test_a_bad_link_is_refused(self, client, mailbox):
        self.register(client)
        response = client.post("/api/auth/email/verify", json={"token": "made-up"})
        assert response.status_code == 422
        assert response.json()["error_code"] == "TOKEN_INVALID"

    def test_an_expired_link_is_refused(self, client, db, mailbox):
        from app.models import CustomerToken

        self.register(client)
        link = _links(mailbox, "Confirm your email")[0]
        row = db.execute(select(CustomerToken)).scalar_one()
        row.expires_at = datetime.utcnow() - timedelta(minutes=1)
        db.flush()
        assert client.post("/api/auth/email/verify", json={"token": link}).json()["error_code"] == "TOKEN_EXPIRED"

    def test_a_used_link_is_refused(self, client, mailbox):
        self.register(client)
        link = _links(mailbox, "Confirm your email")[0]
        assert client.post("/api/auth/email/verify", json={"token": link}).status_code == 200
        again = client.post("/api/auth/email/verify", json={"token": link})
        assert again.json()["error_code"] == "TOKEN_USED"

    def test_resending_sends_a_new_link_and_retires_the_old(self, client, mailbox):
        token = self.register(client).json()["data"]["token"]["accessToken"]
        headers = {"Authorization": f"Bearer {token}"}
        response = client.post("/api/account/email/verification", headers=headers)
        assert response.status_code == 200
        assert response.json()["data"]["alreadyVerified"] is False
        first, second = _links(mailbox, "Confirm your email")
        assert client.post("/api/auth/email/verify", json={"token": first}).json()["error_code"] == \
            "TOKEN_SUPERSEDED"
        assert client.post("/api/auth/email/verify", json={"token": second}).status_code == 200

    def test_resending_is_rate_limited(self, client, mailbox):
        token = self.register(client).json()["data"]["token"]["accessToken"]
        headers = {"Authorization": f"Bearer {token}"}
        assert client.post("/api/account/email/verification", headers=headers).status_code == 200
        assert client.post("/api/account/email/verification", headers=headers).status_code == 429

    def test_an_already_verified_address_needs_no_link(self, client, db, customer, auth, mailbox):
        customer.email_verified_at = datetime.utcnow()
        db.flush()
        response = client.post("/api/account/email/verification", headers=auth)
        assert response.json()["data"]["alreadyVerified"] is True
        assert mailbox == []

    def test_resending_needs_an_account(self, client):
        assert client.post("/api/account/email/verification").status_code == 401

    def test_a_duplicate_registration_is_still_refused(self, client, customer, mailbox):
        response = self.register(client, "shopper@example.com")
        assert response.status_code == 409
        assert mailbox == []

    def test_a_reset_link_also_confirms_the_address(self, client, customer, auth, mailbox):
        forgot(client)
        reset(client, _links(mailbox, "Reset your")[0])
        fresh = login(client, NEW_PASSWORD).json()["data"]["token"]["accessToken"]
        me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {fresh}"}).json()["data"]
        assert me["emailVerified"] is True


class TestVerifiedToOrder:
    def test_the_store_can_require_a_verified_address(self, client, db, customer, auth, admin_auth,
                                                      catalogue, settings_documents):
        saved = client.put("/api/admin/auth/accounts/settings", headers=admin_auth,
                           json={"requireVerifiedEmailToOrder": True})
        assert saved.status_code == 200, saved.text
        client.post("/api/cart/items", headers=auth, json={"productId": "PRD001", "quantity": 1})
        order = {
            "shippingAddress": {"fullName": "Asha Rao", "phone": "9876500001", "line1": "4 Brigade Road",
                                "line2": "", "city": "Bengaluru", "state": "Karnataka", "pincode": "560001",
                                "country": "India", "email": "shopper@example.com"},
            "billingAddress": None, "deliveryMethod": "standard", "paymentMethod": "cod",
            "couponCode": None, "email": "shopper@example.com", "saveAddress": False,
        }
        refused = client.post("/api/orders", headers=auth, json=order)
        assert refused.status_code == 409
        assert refused.json()["error_code"] == "EMAIL_NOT_VERIFIED"

        customer.email_verified_at = datetime.utcnow()
        db.flush()
        assert client.post("/api/orders", headers=auth, json=order).status_code == 201

    def test_the_settings_need_the_settings_permission(self, client, editor):
        token = client.post("/api/admin/auth/login",
                            json={"email": editor.email, "password": "Admin@123"}).json()["data"]["token"]["accessToken"]
        response = client.put("/api/admin/auth/accounts/settings", headers={"Authorization": f"Bearer {token}"},
                              json={"requireVerifiedEmailToOrder": True})
        assert response.status_code == 403


class TestSettings:
    @pytest.mark.parametrize("bad", [{"resetMinutes": 5}, {"resetMinutes": "soon"}, {"verificationHours": 0},
                                     {"verificationHours": True}])
    def test_bad_values_are_refused(self, client, admin_auth, bad):
        response = client.put("/api/admin/auth/accounts/settings", headers=admin_auth, json=bad)
        assert response.status_code == 422

    def test_the_reset_lifetime_is_what_links_get(self, client, db, admin_auth, customer, mailbox):
        from app.models import CustomerToken

        client.put("/api/admin/auth/accounts/settings", headers=admin_auth, json={"resetMinutes": 15})
        forgot(client)
        row = db.execute(select(CustomerToken)).scalar_one()
        assert timedelta(minutes=14) < row.expires_at - row.created_at <= timedelta(minutes=15)
