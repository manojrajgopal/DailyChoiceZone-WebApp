"""
Shared pieces for the sign-in tests: signing keys made on the spot, id tokens
signed with them, and a fake identity provider behind `httpx.MockTransport`.

Nothing reaches Google, Apple or Microsoft: the token endpoint and the
signing-key endpoint are answered here, but the signature, issuer, audience,
expiry and nonce checks are the real ones.
"""

from __future__ import annotations

import base64
import json
import time
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from jose import jwt

from app.core.config import settings


def _b64(number: int) -> str:
    raw = number.to_bytes((number.bit_length() + 7) // 8, "big")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


class RsaKey:
    def __init__(self, kid: str = "test-key"):
        self.kid = kid
        self.private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.pem = self.private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                              serialization.NoEncryption()).decode()
        numbers = self.private.public_key().public_numbers()
        self.jwk = {"kty": "RSA", "kid": kid, "use": "sig", "alg": "RS256", "n": _b64(numbers.n), "e": _b64(numbers.e)}

    def sign(self, claims: dict, *, alg: str = "RS256", kid: str = "") -> str:
        return jwt.encode(claims, self.pem, algorithm=alg, headers={"kid": kid or self.kid})


_KEY = None


def rsa_key() -> RsaKey:
    """One RSA key per test run: generating them is slow."""
    global _KEY
    if _KEY is None:
        _KEY = RsaKey()
    return _KEY


def ec_private_pem() -> str:
    key = ec.generate_private_key(ec.SECP256R1())
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption()).decode()


def claims(*, iss="https://accounts.google.com", aud="google-client", sub="g-123", email="new.person@example.com",
           email_verified=True, nonce="", exp_in=600, **extra) -> dict:
    now = int(time.time())
    body = {"iss": iss, "aud": aud, "sub": sub, "iat": now, "exp": now + exp_in, "email": email,
            "email_verified": email_verified, "nonce": nonce, "name": "New Person", "given_name": "New",
            "family_name": "Person"}
    body.update(extra)
    return {k: v for k, v in body.items() if v is not None}


class FakeProvider:
    """Answers the token endpoint with `id_token` and the key endpoint with the test key."""

    def __init__(self):
        self.id_token = ""
        self.token_status = 200
        self.token_requests: list = []
        self.key_requests = 0
        self.keys = [rsa_key().jwk]
        self.fail_network = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        if self.fail_network:
            raise httpx.ConnectError("down", request=request)
        url = str(request.url)
        if url.endswith(("/certs", "/keys")):
            self.key_requests += 1
            return httpx.Response(200, json={"keys": self.keys})
        if "token" in url:
            self.token_requests.append(dict(parse_qs(request.content.decode())))
            if self.token_status != 200:
                return httpx.Response(self.token_status, json={"error": "invalid_grant"})
            return httpx.Response(200, json={"id_token": self.id_token, "access_token": "at", "token_type": "Bearer"})
        return httpx.Response(404, json={})


@pytest.fixture()
def fake_idp(monkeypatch):
    from app.services.identity import http as identity_http
    from app.services.identity import jwks

    fake = FakeProvider()
    jwks.reset()
    monkeypatch.setattr(identity_http, "TRANSPORT", httpx.MockTransport(fake.handler))
    yield fake
    jwks.reset()


@pytest.fixture()
def providers_configured(monkeypatch):
    monkeypatch.setattr(settings, "GOOGLE_CLIENT_ID", "google-client")
    monkeypatch.setattr(settings, "GOOGLE_CLIENT_SECRET", "google-secret")
    monkeypatch.setattr(settings, "MICROSOFT_CLIENT_ID", "ms-client")
    monkeypatch.setattr(settings, "MICROSOFT_CLIENT_SECRET", "ms-secret")
    monkeypatch.setattr(settings, "MICROSOFT_TENANT", "common")
    monkeypatch.setattr(settings, "APPLE_CLIENT_ID", "com.example.web")
    monkeypatch.setattr(settings, "APPLE_TEAM_ID", "TEAM123456")
    monkeypatch.setattr(settings, "APPLE_KEY_ID", "KEY1234567")
    monkeypatch.setattr(settings, "APPLE_PRIVATE_KEY", ec_private_pem())


def start(client, provider="google", **params):
    """Begin a trip; returns (state, nonce) from the provider URL. The cookie stays in the client."""
    response = client.get(f"/api/auth/oauth/{provider}/start", params=params, follow_redirects=False)
    assert response.status_code == 302, response.text
    query = parse_qs(urlparse(response.headers["location"]).query)
    return query["state"][0], query["nonce"][0], response


def finish(client, provider="google", *, state, code="auth-code", method="GET", **extra):
    path = f"/api/auth/oauth/{provider}/callback"
    if method == "POST":
        response = client.post(path, data={"state": state, "code": code, **extra}, follow_redirects=False)
    else:
        response = client.get(path, params={"state": state, "code": code, **extra}, follow_redirects=False)
    assert response.status_code == 303, response.text
    location = urlparse(response.headers["location"])
    return {k: v[0] for k, v in parse_qs(location.query).items()}, location


def sign_in_with(client, fake, provider="google", **claim_overrides):
    """A whole successful trip: returns the /oauth/complete response."""
    state, nonce, _ = start(client, provider)
    issuer = {"google": "https://accounts.google.com", "apple": "https://appleid.apple.com"}.get(provider)
    aud = {"google": "google-client", "apple": "com.example.web", "microsoft": "ms-client"}[provider]
    body = claims(iss=issuer, aud=aud, nonce=nonce, **claim_overrides)
    if provider == "microsoft":
        tid = claim_overrides.get("tid", "9188040d-6c67-4c5b-b112-36a304b66dad")
        body.update(iss=f"https://login.microsoftonline.com/{tid}/v2.0", tid=tid)
    fake.id_token = rsa_key().sign(body)
    query, _ = finish(client, provider, state=state, method="POST" if provider == "apple" else "GET")
    assert "code" in query, query
    return client.post("/api/auth/oauth/complete", json={"code": query["code"]})


def customer_token(client, payload) -> dict:
    return {"Authorization": "Bearer " + payload["data"]["token"]["accessToken"]}


def decode(token: str) -> dict:
    return jwt.get_unverified_claims(token)


__all__ = ["RsaKey", "rsa_key", "claims", "FakeProvider", "fake_idp", "providers_configured", "start", "finish",
           "sign_in_with", "customer_token", "decode", "json"]
