"""
The customer's account, the edges: saved addresses (one default, reused when
the same place is saved again, ownership checked before anything else), the
account-security settings administrators edit, and the one-time links' less
travelled paths — a blank token, an address already confirmed, the clean-up
of long-dead tokens.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta

import pytest
from sqlalchemy import select

from app.core import rate_limit
from app.models import Address, CustomerToken, SettingDocument
from app.services import accounts

pytestmark = pytest.mark.integration

HOME = {"fullName": "Asha Rao", "phone": "9876500001", "line1": "4 Brigade Road", "line2": "",
        "city": "Bengaluru", "state": "Karnataka", "pincode": "560001", "country": "India", "type": "home"}
OFFICE = {"fullName": "Asha Rao", "phone": "9876500001", "line1": "12 MG Road", "line2": "Floor 3",
          "city": "Bengaluru", "state": "Karnataka", "pincode": "560002", "country": "India", "type": "work"}


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def mailbox(monkeypatch):
    from app.services import email as email_service

    sent = []

    def record(db, key, *, to, customer_id, subject, html, text, reference="", **_):
        found = re.search(r"token=([A-Za-z0-9_\-]+)", text)
        sent.append({"key": key, "to": to, "subject": subject, "token": found.group(1) if found else None,
                     "reference": reference})
        return True

    monkeypatch.setattr(email_service, "notify", record)
    return sent


def login(client, email, password):
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}


def addresses(db, customer_id):
    db.expire_all()
    return {a.id: a for a in db.execute(select(Address).where(Address.customer_id == customer_id)).scalars()}


# ---------------------------------------------------------------- addresses


class TestSavingAddresses:
    def test_a_new_default_address_takes_over_from_the_old_one(self, client, db, customer, auth):
        response = client.post("/api/account/addresses", headers=auth, json={**OFFICE, "isDefault": True})
        assert response.status_code == 201, response.text
        created = response.json()["data"]
        assert created["isDefault"] is True and created["type"] == "work"
        saved = addresses(db, "CUS001")
        assert saved["ADR001"].is_default is False and saved[created["id"]].is_default is True
        listed = client.get("/api/account/addresses", headers=auth).json()["data"]
        assert sorted(a["id"] for a in listed) == sorted(saved)

    def test_a_non_default_second_address_leaves_the_default_alone(self, client, db, customer, auth):
        created = client.post("/api/account/addresses", headers=auth, json=OFFICE).json()["data"]
        assert created["isDefault"] is False
        assert addresses(db, "CUS001")["ADR001"].is_default is True

    def test_the_first_address_is_the_default_whatever_the_form_said(self, client, db, other_customer):
        headers = login(client, other_customer.email, "Customer@123")
        created = client.post("/api/account/addresses", headers=headers, json=OFFICE).json()["data"]
        assert created["isDefault"] is True

    def test_the_same_place_saved_again_is_reused(self, client, db, customer, auth):
        same = {**HOME, "fullName": "ASHA  RAO", "line1": "4, Brigade Road.", "phone": "+91 98765 00001"}
        response = client.post("/api/account/addresses", headers=auth, json=same)
        assert response.status_code == 201
        assert response.json()["data"]["id"] == "ADR001"
        assert len(addresses(db, "CUS001")) == 1

    def test_saving_a_known_place_as_default_makes_it_the_default(self, client, db, customer, auth):
        office = client.post("/api/account/addresses", headers=auth, json={**OFFICE, "isDefault": True}).json()["data"]
        again = client.post("/api/account/addresses", headers=auth, json={**HOME, "isDefault": True}).json()["data"]
        assert again["id"] == "ADR001" and again["isDefault"] is True
        saved = addresses(db, "CUS001")
        assert len(saved) == 2 and saved[office["id"]].is_default is False

    @pytest.mark.parametrize("field, value", [("fullName", "A"), ("line1", "ab"), ("pincode", "12"),
                                              ("city", ""), ("phone", "9" * 21)])
    def test_short_or_long_fields_are_refused(self, client, customer, auth, field, value):
        response = client.post("/api/account/addresses", headers=auth, json={**OFFICE, field: value})
        assert response.status_code == 422


class TestChangingAndRemovingAddresses:
    def test_an_address_is_updated_in_place(self, client, db, customer, auth):
        response = client.put("/api/account/addresses/ADR001", headers=auth,
                              json={**HOME, "line2": "Near the metro", "type": "other"})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["message"] == "Address updated."
        assert body["data"]["line2"] == "Near the metro" and body["data"]["type"] == "other"
        assert addresses(db, "CUS001")["ADR001"].line2 == "Near the metro"

    def test_making_another_address_the_default(self, client, db, customer, auth):
        office = client.post("/api/account/addresses", headers=auth, json=OFFICE).json()["data"]
        response = client.put(f"/api/account/addresses/{office['id']}", headers=auth,
                              json={**OFFICE, "isDefault": True})
        assert response.json()["data"]["isDefault"] is True
        saved = addresses(db, "CUS001")
        assert saved["ADR001"].is_default is False and saved[office["id"]].is_default is True

    def test_someone_elses_address_looks_like_no_address(self, client, db, customer, other_customer):
        headers = login(client, other_customer.email, "Customer@123")
        for response in (client.put("/api/account/addresses/ADR001", headers=headers, json=HOME),
                         client.delete("/api/account/addresses/ADR001", headers=headers),
                         client.put("/api/account/addresses/ADR999", headers=headers, json=HOME),
                         client.delete("/api/account/addresses/ADR999", headers=headers)):
            assert response.status_code == 404
            assert response.json()["error_code"] == "ADDRESS_NOT_FOUND"
        assert addresses(db, "CUS001")["ADR001"].line1 == "4 Brigade Road"

    def test_removing_the_default_promotes_another(self, client, db, customer, auth):
        office = client.post("/api/account/addresses", headers=auth, json=OFFICE).json()["data"]
        response = client.delete("/api/account/addresses/ADR001", headers=auth)
        assert response.status_code == 200 and response.json()["message"] == "Address removed."
        saved = addresses(db, "CUS001")
        assert list(saved) == [office["id"]] and saved[office["id"]].is_default is True

    def test_removing_a_non_default_address_changes_no_default(self, client, db, customer, auth):
        office = client.post("/api/account/addresses", headers=auth, json=OFFICE).json()["data"]
        client.delete(f"/api/account/addresses/{office['id']}", headers=auth)
        saved = addresses(db, "CUS001")
        assert list(saved) == ["ADR001"] and saved["ADR001"].is_default is True

    def test_removing_the_only_address_leaves_none(self, client, db, customer, auth):
        assert client.delete("/api/account/addresses/ADR001", headers=auth).status_code == 200
        assert addresses(db, "CUS001") == {}
        assert client.get("/api/account/addresses", headers=auth).json()["data"] == []

    def test_addresses_need_a_customer_token(self, client, customer, admin_auth):
        assert client.get("/api/account/addresses").status_code == 401
        assert client.get("/api/account/addresses", headers=admin_auth).status_code == 403


# ------------------------------------------------------ security settings


class TestAccountSecuritySettings:
    def test_the_defaults_are_shown_until_saved(self, client, admin_auth):
        response = client.get("/api/admin/auth/accounts/settings", headers=admin_auth)
        assert response.status_code == 200
        assert response.json()["data"] == accounts.DEFAULTS

    def test_saving_merges_and_updates_the_one_document(self, client, db, admin_auth):
        first = client.put("/api/admin/auth/accounts/settings", headers=admin_auth, json={"resetMinutes": 30})
        assert first.status_code == 200 and first.json()["message"] == "Account settings saved."
        second = client.put("/api/admin/auth/accounts/settings", headers=admin_auth,
                            json={"verificationHours": 24, "requireVerifiedEmailToOrder": 1, "unknown": "x"})
        assert second.json()["data"] == {"verificationHours": 24, "resetMinutes": 30,
                                         "requireVerifiedEmailToOrder": True}
        db.expire_all()
        stored = db.get(SettingDocument, "accounts").value
        assert stored["resetMinutes"] == 30 and "unknown" not in stored

    @pytest.mark.parametrize("payload", [{"verificationHours": 0}, {"verificationHours": 24 * 14 + 1},
                                         {"resetMinutes": 9}, {"resetMinutes": 24 * 60 + 1},
                                         {"resetMinutes": True}, {"verificationHours": "soon"}])
    def test_out_of_range_lifetimes_are_refused(self, client, db, admin_auth, payload):
        response = client.put("/api/admin/auth/accounts/settings", headers=admin_auth, json=payload)
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_SETTING"
        assert db.get(SettingDocument, "accounts") is None

    def test_the_settings_need_the_settings_permission(self, client, editor):
        token = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"})
        headers = {"Authorization": f"Bearer {token.json()['data']['token']['accessToken']}"}
        assert client.get("/api/admin/auth/accounts/settings", headers=headers).status_code == 403
        assert client.put("/api/admin/auth/accounts/settings", headers=headers,
                          json={"resetMinutes": 30}).status_code == 403

    def test_the_signed_in_administrator(self, client, admin_auth, auth):
        body = client.get("/api/admin/auth/me", headers=admin_auth).json()["data"]
        assert body["id"] == "ADM001" and body["avatarInitials"] == "MR"
        assert "passwordHash" not in body and "password_hash" not in body
        assert client.get("/api/admin/auth/me", headers=auth).status_code == 403


# ----------------------------------------------------------------- tokens


class TestLinks:
    def test_a_blank_token_is_simply_invalid(self, client, customer):
        response = client.post("/api/auth/email/verify", json={"token": "   "})
        assert response.status_code == 422 and response.json()["error_code"] == "TOKEN_INVALID"

    def test_confirming_an_address_already_confirmed_sends_no_second_welcome(self, client, db, customer, mailbox):
        accounts.send_verification(db, customer)
        db.commit()
        token = mailbox[-1]["token"]
        confirmed_at = datetime(2026, 2, 1)
        customer.email_verified_at = confirmed_at
        db.commit()
        response = client.post("/api/auth/email/verify", json={"token": token})
        assert response.status_code == 200 and response.json()["data"]["verified"] is True
        db.expire_all()
        assert customer.email_verified_at == confirmed_at
        assert not any(m["reference"] == "welcome" for m in mailbox)

    def test_a_reset_keeps_an_earlier_confirmation(self, client, db, customer, mailbox):
        confirmed_at = datetime(2026, 2, 1)
        customer.email_verified_at = confirmed_at
        db.commit()
        client.post("/api/auth/password/forgot", json={"email": customer.email})
        token = [m["token"] for m in mailbox if "Reset" in m["subject"]][-1]
        response = client.post("/api/auth/password/reset",
                               json={"token": token, "password": "Another@789", "confirmPassword": "Another@789"})
        assert response.status_code == 200, response.text
        db.expire_all()
        assert customer.email_verified_at == confirmed_at

    def test_the_verification_link_lifetime_is_worded_in_hours_or_days(self, db, customer, mailbox, monkeypatch):
        from app.services import email as email_service

        texts = []
        monkeypatch.setattr(email_service, "notify", lambda db, key, **kw: texts.append(kw["text"]) or True)
        accounts.save_settings(db, {"verificationHours": 6})
        accounts.send_verification(db, customer)
        accounts.save_settings(db, {"verificationHours": 72})
        accounts.send_verification(db, customer)
        assert "6 hours" in texts[0] and "3 days" in texts[1]

    def test_long_dead_tokens_are_cleaned_up(self, db, customer):
        now = datetime.utcnow()
        for days, purpose in ((45, accounts.RESET), (31, accounts.VERIFY), (1, accounts.RESET)):
            db.add(CustomerToken(customer_id="CUS001", purpose=purpose, token_hash=f"{days:064d}",
                                 email=customer.email, created_at=now - timedelta(days=days + 1),
                                 expires_at=now - timedelta(days=days)))
        db.flush()
        assert accounts.cleanup(db) == 2
        db.expire_all()
        left = db.execute(select(CustomerToken)).scalars().all()
        assert [t.token_hash for t in left] == [f"{1:064d}"]
        assert accounts.cleanup(db, older_than_days=0) == 1
