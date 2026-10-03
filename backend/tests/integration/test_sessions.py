"""
Signed-in devices: every token names its session (`sid`), and ending the
session ends the token at once — sign out, sign out one device, sign out
everywhere else, expiry and the sliding refresh.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta

import pytest
from jose import jwt

from app.core.config import settings
from app.core.security import create_access_token
from app.models import CustomerSession
from tests.conftest import PASSWORD
from tests.integration.test_identity_helpers import decode

pytestmark = pytest.mark.integration


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def login(client, agent="pytest-device", email="shopper@example.com", ip="203.0.113.7") -> str:
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD},
                           headers={"user-agent": agent, "x-forwarded-for": ip})
    assert response.status_code == 200, response.text
    return response.json()["data"]["token"]["accessToken"]


def error(response) -> str:
    return response.json()["error_code"]


def sid_less_token(customer_id: str, *, age_seconds: int = 0) -> str:
    """A customer token from before sessions existed: no `sid`."""
    now = int(time.time()) - age_seconds
    return jwt.encode({"sub": customer_id, "actor": "customer", "role": None, "iat": now, "exp": now + 3600},
                      settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def session_of(db, token: str) -> CustomerSession:
    row = db.get(CustomerSession, decode(token)["sid"])
    db.refresh(row)
    return row


# ------------------------------------------------------------------ tokens


class TestTokens:
    def test_a_sign_in_token_carries_its_session(self, client, db, customer):
        token = login(client)
        claims = decode(token)
        assert claims["actor"] == "customer" and claims["sub"] == customer.id
        row = session_of(db, token)
        assert row.customer_id == customer.id and row.method == "password"
        assert row.revoked_at is None and row.expires_at > datetime.utcnow() + timedelta(days=29)
        assert row.ip_masked and "203.0.113.7" not in row.ip_masked

    def test_each_sign_in_is_its_own_session(self, client, customer):
        assert decode(login(client))["sid"] != decode(login(client))["sid"]

    def test_register_starts_a_session_too(self, client, db):
        response = client.post("/api/auth/register", json={
            "email": "new.shopper@example.com", "password": "Welcome@2026", "firstName": "Nia", "lastName": "Sen"})
        assert response.status_code == 201, response.text
        token = response.json()["data"]["token"]["accessToken"]
        assert session_of(db, token).customer_id == response.json()["data"]["customer"]["id"]


# ------------------------------------------------------------------- list


class TestList:
    def test_current_device_first_and_flagged(self, client, db, customer):
        first = login(client, agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36")
        second = login(client, agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1")
        # Make the *other* session the more recently seen one, so "current first" isn't just the order.
        session_of(db, second).last_seen_at = datetime.utcnow().replace(microsecond=0) - timedelta(minutes=1)
        session_of(db, first).last_seen_at = datetime.utcnow().replace(microsecond=0) - timedelta(minutes=2)
        db.commit()

        response = client.get("/api/account/sessions", headers=bearer(first))
        assert response.status_code == 200, response.text
        rows = response.json()["data"]
        assert [row["id"] for row in rows] == [decode(first)["sid"], decode(second)["sid"]]
        assert [row["current"] for row in rows] == [True, False]
        assert rows[0]["method"] == "password" and rows[0]["methodLabel"] == "Email and password"
        assert rows[0]["device"] and rows[0]["device"] != "Unknown device"
        assert {"createdAt", "lastSeenAt", "expiresAt", "location"} <= set(rows[0])

    def test_ended_sessions_are_not_listed(self, client, db, customer):
        mine = login(client)
        revoked = login(client)
        expired = login(client)
        session_of(db, revoked).revoked_at = datetime.utcnow()
        session_of(db, expired).expires_at = datetime.utcnow() - timedelta(minutes=1)
        db.commit()
        rows = client.get("/api/account/sessions", headers=bearer(mine)).json()["data"]
        assert [row["id"] for row in rows] == [decode(mine)["sid"]]

    def test_only_your_own(self, client, customer, other_customer):
        mine = login(client)
        login(client, email=other_customer.email)
        rows = client.get("/api/account/sessions", headers=bearer(mine)).json()["data"]
        assert len(rows) == 1

    def test_signed_out_is_401(self, client):
        assert client.get("/api/account/sessions").status_code == 401


# ---------------------------------------------------------------- revoke one


class TestRevokeOne:
    def test_another_device(self, client, db, customer):
        mine, other = login(client), login(client)
        response = client.delete(f"/api/account/sessions/{decode(other)['sid']}", headers=bearer(mine))
        assert response.status_code == 200, response.text
        assert response.json()["data"] == {"signedOut": False}
        row = session_of(db, other)
        assert row.revoked_at is not None and row.revoked_reason == "revoked"
        refused = client.get("/api/auth/me", headers=bearer(other))
        assert refused.status_code == 401 and error(refused) == "SESSION_REVOKED"
        assert client.get("/api/auth/me", headers=bearer(mine)).status_code == 200

    def test_this_device(self, client, db, customer):
        mine = login(client)
        response = client.delete(f"/api/account/sessions/{decode(mine)['sid']}", headers=bearer(mine))
        assert response.status_code == 200
        assert response.json()["data"] == {"signedOut": True}
        refused = client.get("/api/account/sessions", headers=bearer(mine))
        assert refused.status_code == 401 and error(refused) == "SESSION_REVOKED"

    def test_someone_elses_session_looks_missing(self, client, db, customer, other_customer):
        mine = login(client)
        theirs = login(client, email=other_customer.email)
        response = client.delete(f"/api/account/sessions/{decode(theirs)['sid']}", headers=bearer(mine))
        assert response.status_code == 404 and error(response) == "SESSION_NOT_FOUND"
        assert session_of(db, theirs).revoked_at is None

    def test_unknown_and_already_revoked(self, client, customer):
        mine, other = login(client), login(client)
        assert error(client.delete("/api/account/sessions/nope", headers=bearer(mine))) == "SESSION_NOT_FOUND"
        path = f"/api/account/sessions/{decode(other)['sid']}"
        assert client.delete(path, headers=bearer(mine)).status_code == 200
        again = client.delete(path, headers=bearer(mine))
        assert again.status_code == 404 and error(again) == "SESSION_NOT_FOUND"


# -------------------------------------------------------- refused tokens


class TestRefused:
    def test_an_expired_session(self, client, db, customer):
        token = login(client)
        session_of(db, token).expires_at = datetime.utcnow() - timedelta(seconds=5)
        db.commit()
        response = client.get("/api/auth/me", headers=bearer(token))
        assert response.status_code == 401 and error(response) == "SESSION_EXPIRED"

    def test_a_session_that_no_longer_exists(self, client, db, customer):
        token = login(client)
        db.delete(session_of(db, token))
        db.commit()
        response = client.get("/api/auth/me", headers=bearer(token))
        assert response.status_code == 401 and error(response) == "SESSION_REVOKED"

    def test_a_sid_for_another_customer(self, client, db, customer, other_customer):
        theirs = login(client, email=other_customer.email)
        forged = create_access_token(customer.id, "customer", sid=decode(theirs)["sid"])
        response = client.get("/api/auth/me", headers=bearer(forged))
        assert response.status_code == 401 and error(response) == "SESSION_REVOKED"

    def test_last_seen_is_touched_only_now_and_then(self, client, db, customer):
        token = login(client)
        stale = datetime.utcnow().replace(microsecond=0) - timedelta(minutes=10)
        session_of(db, token).last_seen_at = stale
        db.commit()
        assert client.get("/api/auth/me", headers=bearer(token)).status_code == 200
        touched = session_of(db, token).last_seen_at
        assert touched > stale + timedelta(minutes=9)
        assert client.get("/api/auth/me", headers=bearer(token)).status_code == 200
        assert session_of(db, token).last_seen_at == touched


# ------------------------------------------------------ everywhere else


class TestRevokeOthers:
    def test_signs_out_the_rest_and_keeps_this_device(self, client, db, customer):
        mine, second, third = login(client), login(client), login(client)
        response = client.post("/api/account/sessions/revoke-others", headers=bearer(mine))
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["revoked"] == 2
        token = data["token"]["accessToken"]
        assert decode(token)["sid"] == decode(mine)["sid"]
        assert data["token"]["tokenType"] == "bearer" and data["token"]["expiresIn"] > 0

        for old in (second, third):
            refused = client.get("/api/auth/me", headers=bearer(old))
            assert refused.status_code == 401 and error(refused) == "SESSION_REVOKED"
            assert session_of(db, old).revoked_reason == "signed-out-everywhere"
        assert client.get("/api/auth/me", headers=bearer(token)).status_code == 200
        assert client.get("/api/auth/me", headers=bearer(mine)).status_code == 200
        rows = client.get("/api/account/sessions", headers=bearer(token)).json()["data"]
        assert [row["id"] for row in rows] == [decode(mine)["sid"]]
        db.refresh(customer)
        assert customer.sessions_revoked_at is not None

    def test_nothing_else_to_sign_out(self, client, customer):
        mine = login(client)
        data = client.post("/api/account/sessions/revoke-others", headers=bearer(mine)).json()["data"]
        assert data["revoked"] == 0

    def test_a_sid_less_token_gets_a_new_session(self, client, db, customer):
        other = login(client)
        legacy = sid_less_token(customer.id, age_seconds=10)
        assert client.get("/api/auth/me", headers=bearer(legacy)).status_code == 200
        response = client.post("/api/account/sessions/revoke-others", headers=bearer(legacy))
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["revoked"] == 1
        fresh = data["token"]["accessToken"]
        assert decode(fresh)["sid"] not in (None, decode(other)["sid"])
        assert client.get("/api/auth/me", headers=bearer(fresh)).status_code == 200
        # The old sid-less token (issued before the stamp) and the other device are both out.
        assert error(client.get("/api/auth/me", headers=bearer(legacy))) == "SESSION_REVOKED"
        assert error(client.get("/api/auth/me", headers=bearer(other))) == "SESSION_REVOKED"


# ------------------------------------------------------------- refresh


class TestRefresh:
    def test_a_fresh_token_for_the_same_session(self, client, db, customer):
        token = login(client)
        session_of(db, token).last_seen_at = datetime.utcnow().replace(microsecond=0) - timedelta(minutes=1)
        db.commit()
        response = client.post("/api/auth/session/refresh", headers=bearer(token))
        assert response.status_code == 200, response.text
        fresh = response.json()["data"]["token"]["accessToken"]
        assert decode(fresh)["sid"] == decode(token)["sid"]
        assert decode(fresh)["exp"] >= decode(token)["exp"]
        assert client.get("/api/auth/me", headers=bearer(fresh)).status_code == 200
        assert session_of(db, token).last_seen_at > datetime.utcnow() - timedelta(seconds=30)

    def test_the_token_never_outlives_its_session(self, client, db, customer):
        token = login(client)
        session_of(db, token).expires_at = datetime.utcnow().replace(microsecond=0) + timedelta(minutes=5)
        db.commit()
        data = client.post("/api/auth/session/refresh", headers=bearer(token)).json()["data"]
        assert data["token"]["expiresIn"] <= 5 * 60
        assert decode(data["token"]["accessToken"])["exp"] <= int(time.time()) + 5 * 60 + 1

    def test_a_sid_less_token_cannot_be_refreshed(self, client, customer):
        response = client.post("/api/auth/session/refresh", headers=bearer(sid_less_token(customer.id)))
        assert response.status_code == 401 and error(response) == "SESSION_REFRESH_UNAVAILABLE"

    def test_a_revoked_session_cannot_be_refreshed(self, client, db, customer):
        token = login(client)
        session_of(db, token).revoked_at = datetime.utcnow()
        db.commit()
        response = client.post("/api/auth/session/refresh", headers=bearer(token))
        assert response.status_code == 401 and error(response) == "SESSION_REVOKED"

    def test_signed_out_is_401(self, client):
        assert client.post("/api/auth/session/refresh").status_code == 401


# --------------------------------------------------------------- logout


class TestLogout:
    def test_logout_revokes_this_session(self, client, db, customer):
        mine, other = login(client), login(client)
        response = client.post("/api/auth/logout", headers=bearer(mine))
        assert response.status_code == 200
        row = session_of(db, mine)
        assert row.revoked_at is not None and row.revoked_reason == "signed-out"
        refused = client.get("/api/auth/me", headers=bearer(mine))
        assert refused.status_code == 401 and error(refused) == "SESSION_REVOKED"
        assert client.get("/api/auth/me", headers=bearer(other)).status_code == 200  # only this device

    @pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer not-a-token"}])
    def test_logout_always_succeeds(self, client, headers):
        assert client.post("/api/auth/logout", headers=headers).status_code == 200

    def test_an_admin_token_revokes_nothing(self, client, db, customer, admin_auth):
        mine = login(client)
        assert client.post("/api/auth/logout", headers=admin_auth).status_code == 200
        assert session_of(db, mine).revoked_at is None
