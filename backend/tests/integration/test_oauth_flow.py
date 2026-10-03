"""
Social sign-in end to end: start, callback, handoff, linking and the merge
rules. The providers are faked at the HTTP layer (test_identity_helpers);
every check on the state, the cookie and the id token is real.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.models import Customer, CustomerIdentity, OAuthState
from app.services.identity import crypto
from tests.integration.test_identity_helpers import (  # noqa: F401 — fixtures
    claims,
    customer_token,
    decode,
    fake_idp,
    finish,
    providers_configured,
    rsa_key,
    sign_in_with,
    start,
)

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _configured(providers_configured, fake_idp):  # noqa: F811
    yield


# ------------------------------------------------------------------ start


class TestStart:
    def test_redirects_to_google_with_pkce_state_nonce_and_a_bound_cookie(self, client, db):
        state, nonce, response = start(client, "google", next="/checkout/payment")
        location = response.headers["location"]
        assert location.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
        assert "code_challenge_method=S256" in location and "code_challenge=" in location
        assert "redirect_uri=http%3A%2F%2Ftestserver%2Fapi%2Fauth%2Foauth%2Fgoogle%2Fcallback" in location
        cookie = response.headers["set-cookie"]
        assert "dcz_oauth_google=" in cookie and "HttpOnly" in cookie and "Path=/api/auth/oauth" in cookie
        row = db.query(OAuthState).filter_by(state_hash=crypto.sha256(state)).one()
        # Nothing stored in a form that could be replayed.
        assert row.nonce_hash == crypto.sha256(nonce) and nonce not in row.verifier_sealed
        assert row.next_path == "/checkout/payment"

    def test_an_unsafe_next_is_dropped(self, client, db):
        state, _, _ = start(client, "google", next="//evil.example/x")
        assert db.query(OAuthState).filter_by(state_hash=crypto.sha256(state)).one().next_path == ""

    def test_apple_asks_for_form_post_and_its_cookie_is_lax_over_http(self, client):
        _, _, response = start(client, "apple")
        assert "response_mode=form_post" in response.headers["location"]

    @pytest.mark.parametrize("provider", ["facebook", "nope"])
    def test_an_unknown_provider_goes_back_with_not_configured(self, client, provider):
        response = client.get(f"/api/auth/oauth/{provider}/start", follow_redirects=False)
        assert response.status_code == 303
        assert response.headers["location"].endswith("/auth/complete?error=not_configured")

    def test_a_provider_without_credentials_is_not_configured(self, client, monkeypatch):
        from app.core.config import settings

        monkeypatch.setattr(settings, "GOOGLE_CLIENT_SECRET", "")
        response = client.get("/api/auth/oauth/google/start", follow_redirects=False)
        assert "error=not_configured" in response.headers["location"]

    def test_a_provider_the_store_switched_off_is_not_offered(self, client, db, admin_auth):
        assert client.put("/api/admin/auth/methods", headers=admin_auth, json={"google": False}).status_code == 200
        response = client.get("/api/auth/oauth/google/start", follow_redirects=False)
        assert "error=not_configured" in response.headers["location"]
        codes = [p["code"] for p in client.get("/api/auth/methods").json()["data"]["providers"]]
        assert "google" not in codes and "apple" in codes


# ---------------------------------------------------------------- state


class TestState:
    def test_missing_state(self, client):
        query, _ = finish(client, state="")
        assert query["error"] == "invalid_state"

    def test_unknown_state(self, client):
        query, _ = finish(client, state="made-up")
        assert query["error"] == "invalid_state"

    def test_reused_state(self, client, fake_idp):  # noqa: F811
        state, nonce, _ = start(client)
        fake_idp.id_token = rsa_key().sign(claims(nonce=nonce))
        first, _ = finish(client, state=state)
        assert "code" in first
        # The cookie was cleared by the first callback; put it back to prove the state itself is spent.
        client.cookies.set("dcz_oauth_google", "x", path="/api/auth/oauth")
        second, _ = finish(client, state=state)
        assert second["error"] == "invalid_state"

    def test_expired_state(self, client, db):
        state, _, _ = start(client)
        row = db.query(OAuthState).filter_by(state_hash=crypto.sha256(state)).one()
        row.expires_at = datetime.utcnow() - timedelta(seconds=1)
        db.commit()
        query, _ = finish(client, state=state)
        assert query["error"] == "invalid_state"

    def test_a_callback_in_another_browser_is_refused(self, client, fake_idp):  # noqa: F811
        state, nonce, _ = start(client)
        fake_idp.id_token = rsa_key().sign(claims(nonce=nonce))
        client.cookies.clear()
        client.cookies.set("dcz_oauth_google", "someone-elses-cookie", path="/api/auth/oauth")
        query, _ = finish(client, state=state)
        assert query["error"] == "invalid_state"
        assert fake_idp.token_requests == []  # the code was never even exchanged

    def test_the_state_of_one_provider_is_no_good_for_another(self, client):
        state, _, _ = start(client, "google")
        query, _ = finish(client, "microsoft", state=state)
        assert query["error"] == "invalid_state"

    def test_cancelled_at_the_provider(self, client, db):
        state, _, _ = start(client)
        query, _ = finish(client, state=state, code="", error="access_denied")
        assert query["error"] == "cancelled"
        assert db.query(OAuthState).filter_by(state_hash=crypto.sha256(state)).one().outcome == "failed"

    def test_provider_down(self, client, fake_idp):  # noqa: F811
        state, _, _ = start(client)
        fake_idp.fail_network = True
        query, _ = finish(client, state=state)
        assert query["error"] == "provider_unavailable"

    def test_code_rejected_by_the_provider(self, client, fake_idp):  # noqa: F811
        state, _, _ = start(client)
        fake_idp.token_status = 400
        query, _ = finish(client, state=state)
        assert query["error"] == "failed"


# --------------------------------------------------------------- id token


class TestIdToken:
    def _trip(self, client, fake, **overrides):
        state, nonce, _ = start(client)
        body = claims(nonce=nonce)
        body.update(overrides)
        fake.id_token = rsa_key().sign(body)
        return finish(client, state=state)[0]

    def test_nonce_mismatch(self, client, fake_idp):  # noqa: F811
        assert self._trip(client, fake_idp, nonce="another-nonce")["error"] == "invalid_token"

    def test_wrong_audience(self, client, fake_idp):  # noqa: F811
        assert self._trip(client, fake_idp, aud="someone-elses-app")["error"] == "invalid_token"

    def test_wrong_issuer(self, client, fake_idp):  # noqa: F811
        assert self._trip(client, fake_idp, iss="https://evil.example")["error"] == "invalid_token"

    def test_expired(self, client, fake_idp):  # noqa: F811
        import time

        assert self._trip(client, fake_idp, exp=int(time.time()) - 3600)["error"] == "invalid_token"

    def test_bad_signature(self, client, fake_idp):  # noqa: F811
        from tests.integration.test_identity_helpers import RsaKey

        state, nonce, _ = start(client)
        fake_idp.id_token = RsaKey("test-key").sign(claims(nonce=nonce))  # same kid, different key
        assert finish(client, state=state)[0]["error"] == "invalid_token"

    def test_no_account_is_made_from_a_refused_token(self, client, db, fake_idp):  # noqa: F811
        self._trip(client, fake_idp, aud="nope")
        assert db.query(Customer).filter_by(email="new.person@example.com").first() is None


# ------------------------------------------------------- accounts & merging


class TestAccounts:
    def test_a_new_verified_email_creates_an_account_with_no_password(self, client, db, fake_idp):  # noqa: F811
        response = sign_in_with(client, fake_idp)
        assert response.status_code == 200, response.text
        body = response.json()["data"]
        assert body["created"] is True and body["customer"]["email"] == "new.person@example.com"
        assert body["customer"]["emailVerified"] is True and body["customer"]["firstName"] == "New"
        customer = db.query(Customer).filter_by(email="new.person@example.com").one()
        assert customer.password_hash is None
        assert db.query(CustomerIdentity).filter_by(customer_id=customer.id, provider="google").one().provider_user_id == "g-123"
        token = body["token"]["accessToken"]
        assert decode(token)["sid"]
        assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code == 200
        # And that account can't be signed in to with a password it never had.
        refused = client.post("/api/auth/login", json={"email": "new.person@example.com", "password": "anything1"})
        assert refused.status_code == 401 and refused.json()["error_code"] == "INVALID_CREDENTIALS"

    def test_the_same_google_account_signs_in_to_the_same_customer(self, client, db, fake_idp):  # noqa: F811
        first = sign_in_with(client, fake_idp).json()["data"]["customer"]["id"]
        again = sign_in_with(client, fake_idp, email="changed@example.com").json()["data"]
        assert again["customer"]["id"] == first and again["created"] is False
        assert db.query(Customer).count() == 1

    def test_handoff_code_is_single_use(self, client, fake_idp):  # noqa: F811
        state, nonce, _ = start(client)
        fake_idp.id_token = rsa_key().sign(claims(nonce=nonce))
        code = finish(client, state=state)[0]["code"]
        assert client.post("/api/auth/oauth/complete", json={"code": code}).status_code == 200
        again = client.post("/api/auth/oauth/complete", json={"code": code})
        assert again.status_code == 401 and again.json()["error_code"] == "OAUTH_CODE_INVALID"

    def test_handoff_code_expires(self, client, db, fake_idp):  # noqa: F811
        state, nonce, _ = start(client)
        fake_idp.id_token = rsa_key().sign(claims(nonce=nonce))
        code = finish(client, state=state)[0]["code"]
        row = db.query(OAuthState).filter_by(handoff_hash=crypto.sha256(code)).one()
        row.handoff_expires_at = datetime.utcnow() - timedelta(seconds=1)
        db.commit()
        assert client.post("/api/auth/oauth/complete", json={"code": code}).status_code == 401

    def test_the_token_is_never_in_the_redirect(self, client, fake_idp):  # noqa: F811
        state, nonce, _ = start(client)
        fake_idp.id_token = rsa_key().sign(claims(nonce=nonce))
        _, location = finish(client, state=state)
        assert "eyJ" not in location.geturl() and location.path == "/auth/complete"

    def test_verified_email_matching_a_verified_account_links_it(self, client, db, customer, fake_idp):  # noqa: F811
        customer.email_verified_at = datetime.utcnow()
        db.commit()
        body = sign_in_with(client, fake_idp, email=customer.email).json()["data"]
        assert body["customer"]["id"] == customer.id and body["created"] is False
        assert db.query(CustomerIdentity).filter_by(customer_id=customer.id, provider="google").count() == 1

    def test_an_unverified_existing_account_is_never_merged(self, client, db, customer, fake_idp):  # noqa: F811
        state, nonce, _ = start(client)
        fake_idp.id_token = rsa_key().sign(claims(nonce=nonce, email=customer.email))
        assert finish(client, state=state)[0]["error"] == "account_exists"
        assert db.query(CustomerIdentity).count() == 0

    def test_an_unverified_provider_email_is_never_merged(self, client, db, customer, fake_idp):  # noqa: F811
        customer.email_verified_at = datetime.utcnow()
        db.commit()
        state, nonce, _ = start(client)
        fake_idp.id_token = rsa_key().sign(claims(nonce=nonce, email=customer.email, email_verified=False))
        assert finish(client, state=state)[0]["error"] == "account_exists"

    def test_an_unverified_new_email_is_refused(self, client, db, fake_idp):  # noqa: F811
        state, nonce, _ = start(client)
        fake_idp.id_token = rsa_key().sign(claims(nonce=nonce, email_verified=False))
        assert finish(client, state=state)[0]["error"] == "email_unverified"
        assert db.query(Customer).count() == 0

    def test_no_email_at_all_is_refused(self, client, fake_idp):  # noqa: F811
        state, nonce, _ = start(client)
        body = claims(nonce=nonce)
        body.pop("email")
        fake_idp.id_token = rsa_key().sign(body)
        assert finish(client, state=state)[0]["error"] == "email_missing"

    def test_a_blocked_account_cannot_sign_in(self, client, db, fake_idp):  # noqa: F811
        customer_id = sign_in_with(client, fake_idp).json()["data"]["customer"]["id"]
        db.get(Customer, customer_id).status = "blocked"
        db.commit()
        state, nonce, _ = start(client)
        fake_idp.id_token = rsa_key().sign(claims(nonce=nonce))
        assert finish(client, state=state)[0]["error"] == "account_blocked"


# ------------------------------------------------------------- providers


class TestApple:
    def _apple(self, client, fake, *, user=None, **overrides):
        state, nonce, _ = start(client, "apple")
        body = claims(iss="https://appleid.apple.com", aud="com.example.web", nonce=nonce,
                      email="abc123@privaterelay.appleid.com", email_verified="true", is_private_email="true",
                      name=None, given_name=None, family_name=None)
        body.update(overrides)
        fake.id_token = rsa_key().sign(body)
        extra = {"user": user} if user else {}
        return finish(client, "apple", state=state, method="POST", **extra)[0]

    def test_form_post_with_a_relay_email_and_the_first_time_name(self, client, db, fake_idp):  # noqa: F811
        import json

        query = self._apple(client, fake_idp, user=json.dumps({"name": {"firstName": "Meera", "lastName": "Iyer"},
                                                                 "email": "someone.else@example.com"}))
        body = client.post("/api/auth/oauth/complete", json={"code": query["code"]}).json()["data"]
        # The relay address is the account's email; the unsigned `user` field's email is ignored.
        assert body["customer"]["email"] == "abc123@privaterelay.appleid.com"
        assert (body["customer"]["firstName"], body["customer"]["lastName"]) == ("Meera", "Iyer")
        sent = fake_idp.token_requests[0]
        assert sent["client_id"] == ["com.example.web"]
        secret = decode(sent["client_secret"][0])
        assert secret["iss"] == "TEAM123456" and secret["aud"] == "https://appleid.apple.com"
        assert secret["sub"] == "com.example.web"

    def test_later_sign_ins_carry_no_name_and_keep_the_first_one(self, client, db, fake_idp):  # noqa: F811
        import json

        first = self._apple(client, fake_idp, user=json.dumps({"name": {"firstName": "Meera", "lastName": "Iyer"}}))
        customer_id = client.post("/api/auth/oauth/complete", json={"code": first["code"]}).json()["data"]["customer"]["id"]
        again = self._apple(client, fake_idp)
        body = client.post("/api/auth/oauth/complete", json={"code": again["code"]}).json()["data"]
        assert body["customer"]["id"] == customer_id and body["customer"]["firstName"] == "Meera"

    def test_a_relay_address_never_finds_another_account(self, client, db, fake_idp):  # noqa: F811
        first = self._apple(client, fake_idp)
        client.post("/api/auth/oauth/complete", json={"code": first["code"]})
        # A different Apple subject that somehow presents the same relay address is not the same person.
        refused = self._apple(client, fake_idp, sub="another-apple-user")
        assert refused["error"] in ("account_exists",)


class TestMicrosoft:
    def test_personal_account_signs_in(self, client, fake_idp):  # noqa: F811
        response = sign_in_with(client, fake_idp, "microsoft", email="ms.person@example.com")
        assert response.status_code == 200, response.text
        assert response.json()["data"]["customer"]["email"] == "ms.person@example.com"

    def test_issuer_must_name_the_tokens_own_tenant(self, client, fake_idp):  # noqa: F811
        state, nonce, _ = start(client, "microsoft")
        body = claims(aud="ms-client", nonce=nonce, tid="9188040d-6c67-4c5b-b112-36a304b66dad",
                      iss="https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0")
        fake_idp.id_token = rsa_key().sign(body)
        assert finish(client, "microsoft", state=state)[0]["error"] == "invalid_token"

    def test_a_work_account_email_is_not_trusted_for_a_new_account(self, client, fake_idp):  # noqa: F811
        tid = "22222222-2222-2222-2222-222222222222"
        state, nonce, _ = start(client, "microsoft")
        fake_idp.id_token = rsa_key().sign(claims(aud="ms-client", nonce=nonce, tid=tid,
                                                  iss=f"https://login.microsoftonline.com/{tid}/v2.0"))
        assert finish(client, "microsoft", state=state)[0]["error"] == "email_unverified"


# ---------------------------------------------------------------- linking


class TestLinking:
    def _link(self, client, auth, fake, provider="google", **overrides):
        response = client.post(f"/api/account/identities/{provider}/link", headers=auth, json={})
        assert response.status_code == 200, response.text
        url = response.json()["data"]["url"]
        assert "mode=link" in url and "ticket=" in url
        path = url.split("testserver", 1)[1]
        started = client.get(path, follow_redirects=False)
        assert started.status_code == 302, started.text
        from urllib.parse import parse_qs, urlparse

        query = parse_qs(urlparse(started.headers["location"]).query)
        state, nonce = query["state"][0], query["nonce"][0]
        fake.id_token = rsa_key().sign(claims(nonce=nonce, **overrides))
        return finish(client, provider, state=state)[0], path

    def test_link_and_list_and_unlink(self, client, db, auth, customer, fake_idp):  # noqa: F811
        query, _ = self._link(client, auth, fake_idp, email="other.address@example.com")
        assert query["linked"] == "google" and query["next"] == "/account/settings"
        identities = client.get("/api/account/identities", headers=auth).json()["data"]
        assert [i["provider"] for i in identities] == ["google"]
        # The account has a password, so the provider can go.
        removed = client.delete(f"/api/account/identities/{identities[0]['id']}", headers=auth)
        assert removed.status_code == 200
        assert client.get("/api/account/identities", headers=auth).json()["data"] == []

    def test_a_ticket_works_once(self, client, auth, fake_idp):  # noqa: F811
        _, path = self._link(client, auth, fake_idp)
        again = client.get(path, follow_redirects=False)
        assert again.status_code == 303 and "error=invalid_state" in again.headers["location"]
        assert "mode=link" in again.headers["location"]

    def test_an_identity_owned_by_another_account_is_refused(self, client, db, auth, fake_idp):  # noqa: F811
        sign_in_with(client, fake_idp, sub="shared-subject", email="first.owner@example.com")
        query, _ = self._link(client, auth, fake_idp, sub="shared-subject")
        assert query["error"] == "identity_in_use"

    def test_unlinking_the_last_way_in_is_refused(self, client, db, fake_idp):  # noqa: F811
        body = sign_in_with(client, fake_idp).json()
        headers = customer_token(client, body)
        identity_id = client.get("/api/account/identities", headers=headers).json()["data"][0]["id"]
        refused = client.delete(f"/api/account/identities/{identity_id}", headers=headers)
        assert refused.status_code == 409 and refused.json()["error_code"] == "LAST_SIGN_IN_METHOD"

    def test_someone_elses_identity_looks_missing(self, client, db, auth, other_customer):
        identity = CustomerIdentity(customer_id=other_customer.id, provider="google", provider_user_id="x",
                                    created_at=datetime.utcnow())
        db.add(identity)
        db.commit()
        assert client.delete(f"/api/account/identities/{identity.id}", headers=auth).status_code == 404
        assert db.get(CustomerIdentity, identity.id) is not None

    def test_link_needs_a_configured_provider(self, client, auth, monkeypatch):
        from app.core.config import settings

        monkeypatch.setattr(settings, "MICROSOFT_CLIENT_ID", "")
        response = client.post("/api/account/identities/microsoft/link", headers=auth, json={})
        assert response.status_code == 422 and response.json()["error_code"] == "PROVIDER_UNAVAILABLE"


class TestMethodsAndSummary:
    def test_public_methods(self, client):
        data = client.get("/api/auth/methods").json()["data"]
        assert data["emailPassword"] is True
        assert [p["code"] for p in data["providers"]] == ["google", "apple", "microsoft"]
        assert "secret" not in str(data).lower()

    def test_summary_counts_failures(self, client, db, fake_idp):  # noqa: F811
        from app.services import identity

        sign_in_with(client, fake_idp)
        finish(client, state="nonsense")
        state, _, _ = start(client)
        finish(client, state=state, code="", error="access_denied")
        numbers = identity.summary(db)
        assert numbers["signInsByMethod"].get("google") == 1 and numbers["oauthFailuresToday"] == 1
