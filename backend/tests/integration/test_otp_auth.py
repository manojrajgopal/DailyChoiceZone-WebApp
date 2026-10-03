"""
Signing in and signing up with a one-time code: POST /api/auth/otp/request,
/otp/verify and /otp/signup (app.api.routes.identity, app.services.otp,
app.services.otp_providers, app.services.identity.accounts).

The real providers run (the development console for SMS, the console fallback
for email when no email account is set up); the code is captured by wrapping
`otp_providers.send_sms` / `send_email`, which is the only place the plaintext
code ever exists outside the request.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.core.config import settings
from app.models import Customer, CustomerIdentity, CustomerSession, OtpChallenge, SettingDocument
from app.services import otp, otp_providers
from app.services.identity import accounts, crypto
from tests.integration.test_identity_helpers import customer_token, decode

pytestmark = pytest.mark.integration

PHONE = "98765 43210"
E164 = "+919876543210"
NEW_EMAIL = "new.person@example.com"


@pytest.fixture()
def sent(monkeypatch):
    """Every code handed to a provider, newest last: [(channel, destination, code, purpose)]."""
    outbox: list = []
    real_sms, real_email = otp_providers.send_sms, otp_providers.send_email

    def send_sms(to, code, purpose, minutes):
        outbox.append(("sms", to, code, purpose))
        return real_sms(to, code, purpose, minutes)

    def send_email(db, to, code, purpose, minutes):
        outbox.append(("email", to, code, purpose))
        return real_email(db, to, code, purpose, minutes)

    monkeypatch.setattr(otp_providers, "send_sms", send_sms)
    monkeypatch.setattr(otp_providers, "send_email", send_email)
    monkeypatch.setattr(settings, "OTP_SMS_PROVIDER", "console")
    return outbox


@pytest.fixture()
def no_resend_wait(monkeypatch):
    monkeypatch.setattr(settings, "OTP_RESEND_SECONDS", 0)


def ask(client, destination=PHONE, channel="sms", purpose="login", ip=None):
    headers = {"X-Forwarded-For": ip} if ip else {}
    return client.post("/api/auth/otp/request", headers=headers,
                       json={"channel": channel, "destination": destination, "purpose": purpose})


def issue(client, sent, destination=PHONE, channel="sms") -> tuple:
    response = ask(client, destination, channel)
    assert response.status_code == 200, response.text
    return response.json()["data"]["challengeId"], sent[-1][2]


def verify(client, challenge_id, code):
    return client.post("/api/auth/otp/verify", json={"challengeId": challenge_id, "code": code})


def signup(client, token, **fields):
    return client.post("/api/auth/otp/signup", json={"signupToken": token, "firstName": "Nisha", **fields})


def err(response) -> str:
    return response.json()["error_code"]


def wrong(code: str) -> str:
    return "".join(str((int(c) + 1) % 10) for c in code)


@pytest.fixture()
def phone_owner(db, customer):
    """The fixture customer with E164 as a verified sign-in phone."""
    db.add(CustomerIdentity(customer_id=customer.id, provider="phone", provider_user_id=E164,
                            verified_at=datetime.utcnow().replace(microsecond=0),
                            created_at=datetime.utcnow().replace(microsecond=0)))
    db.flush()
    return customer


# ------------------------------------------------------------------ request


class TestRequest:
    def test_sms_code_is_sent_with_a_masked_destination(self, client, db, sent):
        response = ask(client)
        assert response.status_code == 200, response.text
        body = response.json()
        data = body["data"]
        assert body["message"] == "If that's yours, a code is on its way."
        assert data["channel"] == "sms"
        assert data["destination"] == "+91•••••43210"
        assert E164 not in response.text
        assert data["expiresIn"] == 300 and data["resendIn"] == 45 and data["length"] == 6
        assert sent == [("sms", E164, sent[0][2], "login")]
        assert len(sent[0][2]) == 6 and sent[0][2].isdigit()
        row = db.get(OtpChallenge, data["challengeId"])
        assert row.purpose == "login" and row.channel == "sms" and row.status == "pending"
        assert row.provider == "console" and row.attempts == 0 and row.max_attempts == 5
        assert row.destination_hash == otp.destination_hash("sms", E164)
        assert row.customer_id is None

    def test_email_code_is_sent_with_a_masked_address(self, client, db, sent):
        response = ask(client, "New.Person@Example.com", "email")
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["channel"] == "email"
        assert data["destination"] == "n••••••@example.com"
        assert sent[-1][:2] == ("email", NEW_EMAIL)
        assert sent[-1][3] == "login-email"
        assert db.get(OtpChallenge, data["challengeId"]).purpose == "login-email"

    def test_signup_purpose_is_accepted_and_issues_a_login_code(self, client, db, sent):
        response = ask(client, purpose="signup")
        assert response.status_code == 200, response.text
        assert db.get(OtpChallenge, response.json()["data"]["challengeId"]).purpose == "login"

    def test_other_purposes_are_refused(self, client, sent):
        response = ask(client, purpose="verify-phone")
        assert response.status_code == 422
        assert err(response) == "OTP_PURPOSE_INVALID"
        assert sent == []

    def test_unknown_channel_is_refused(self, client, sent):
        response = ask(client, channel="fax")
        assert response.status_code == 422 and err(response) == "OTP_CHANNEL_INVALID"

    def test_known_and_unknown_destinations_answer_alike(self, client, phone_owner, sent, no_resend_wait):
        known = ask(client, PHONE).json()
        unknown = ask(client, "91234 56789").json()
        assert known["message"] == unknown["message"]
        assert set(known["data"]) == set(unknown["data"])
        assert {k: v for k, v in known["data"].items() if k not in ("challengeId", "destination")} == \
            {k: v for k, v in unknown["data"].items() if k not in ("challengeId", "destination")}
        # A code goes out to both: the code is how a new customer signs up.
        assert [s[1] for s in sent] == [E164, "+919123456789"]

    def test_known_email_and_unknown_email_answer_alike(self, client, customer, sent, no_resend_wait):
        known = ask(client, customer.email, "email")
        unknown = ask(client, "nobody.here@example.com", "email")
        assert known.status_code == unknown.status_code == 200
        assert known.json()["message"] == unknown.json()["message"]

    @pytest.mark.parametrize("bad", ["12345", "phone-number", "+1 23"])
    def test_invalid_phone(self, client, db, sent, bad):
        response = ask(client, bad)
        assert response.status_code == 422 and err(response) == "PHONE_INVALID"
        assert sent == [] and db.query(OtpChallenge).count() == 0

    @pytest.mark.parametrize("bad", ["not-an-email", "a@b", "two@@example.com"])
    def test_invalid_email(self, client, sent, bad):
        response = ask(client, bad, "email")
        assert response.status_code == 422 and err(response) == "EMAIL_INVALID"
        assert sent == []

    @pytest.mark.parametrize("channel,key,destination", [("sms", "mobileOtp", PHONE),
                                                          ("email", "emailOtp", NEW_EMAIL)])
    def test_switched_off_in_auth_methods(self, client, db, sent, channel, key, destination):
        db.add(SettingDocument(key="auth_methods", value={key: False}))
        db.flush()
        response = ask(client, destination, channel)
        assert response.status_code == 403 and err(response) == "AUTH_METHOD_DISABLED"
        assert sent == [] and db.query(OtpChallenge).count() == 0

    def test_the_other_method_stays_on(self, client, db, sent):
        db.add(SettingDocument(key="auth_methods", value={"mobileOtp": False}))
        db.flush()
        assert ask(client, NEW_EMAIL, "email").status_code == 200

    def test_admin_switch_turns_sms_off(self, client, admin_auth, sent):
        assert client.put("/api/admin/auth/methods", headers=admin_auth,
                          json={"mobileOtp": False}).status_code == 200
        assert err(ask(client)) == "AUTH_METHOD_DISABLED"

    def test_no_sms_provider_means_disabled(self, client, sent, monkeypatch):
        monkeypatch.setattr(settings, "OTP_SMS_PROVIDER", "none")
        response = ask(client)
        assert response.status_code == 403 and err(response) == "AUTH_METHOD_DISABLED"

    def test_resend_waits(self, client, db, sent):
        assert ask(client).status_code == 200
        again = ask(client)
        assert again.status_code == 429
        assert err(again) == "OTP_RESEND_WAIT"
        assert 40 <= again.json()["details"]["retryAfter"] <= 45
        assert len(sent) == 1 and db.query(OtpChallenge).count() == 1

    def test_resend_allowed_once_the_wait_is_over(self, client, db, sent):
        first = ask(client).json()["data"]["challengeId"]
        row = db.get(OtpChallenge, first)
        row.resend_available_at = datetime.utcnow() - timedelta(seconds=1)
        db.flush()
        assert ask(client).status_code == 200
        assert db.get(OtpChallenge, first).status == "superseded"

    def test_too_many_per_destination(self, client, db, sent, no_resend_wait):
        for n in range(settings.OTP_PER_DESTINATION_HOURLY):
            assert ask(client, ip=f"203.0.113.{n}").status_code == 200
        response = ask(client, ip="203.0.113.99")
        assert response.status_code == 429 and err(response) == "OTP_TOO_MANY"
        assert len(sent) == settings.OTP_PER_DESTINATION_HOURLY

    def test_daily_per_destination_counts_older_rows(self, client, db, sent, no_resend_wait):
        dest = otp.destination_hash("sms", E164)
        then = datetime.utcnow() - timedelta(hours=3)
        for n in range(settings.OTP_PER_DESTINATION_DAILY):
            db.add(OtpChallenge(id=f"old{n}", purpose="login", channel="sms", destination_hash=dest,
                                destination_sealed="x", code_hash="x", status="superseded", created_at=then,
                                expires_at=then + timedelta(minutes=5), resend_available_at=then))
        db.flush()
        response = ask(client)
        assert response.status_code == 429 and err(response) == "OTP_TOO_MANY"

    def test_too_many_per_ip(self, client, db, sent):
        ip = "198.51.100.7"
        for n in range(settings.OTP_PER_IP_HOURLY):
            assert ask(client, f"9123400{n:03d}", ip=ip).status_code == 200
        response = ask(client, "9123499999", ip=ip)
        assert response.status_code == 429 and err(response) == "OTP_TOO_MANY"
        # Another caller is unaffected.
        assert ask(client, "9123499999", ip="198.51.100.8").status_code == 200

    def test_send_failure_is_reported_and_does_not_hold_the_resend(self, client, db, sent, monkeypatch):
        from app.services.messaging.providers import ProviderError

        working = otp_providers.send_sms

        def broken(to, code, purpose, minutes):
            raise ProviderError("down", transient=True)

        monkeypatch.setattr(otp_providers, "send_sms", broken)
        response = ask(client)
        assert response.status_code == 503 and err(response) == "OTP_SEND_FAILED"
        row = db.query(OtpChallenge).one()
        assert row.status == "failed"
        monkeypatch.setattr(otp_providers, "send_sms", working)
        assert ask(client).status_code == 200


class TestStorage:
    def test_code_is_stored_only_as_a_keyed_hash(self, client, db, sent):
        challenge_id, code = issue(client, sent)
        row = db.get(OtpChallenge, challenge_id)
        assert row.code_hash != code and code not in row.code_hash
        assert len(row.code_hash) == 64
        assert row.code_hash == crypto.keyed_hash("otp-code", f"{challenge_id}:{code}")
        for column in (row.destination_hash, row.destination_masked, row.destination_sealed, row.ip_hash,
                       row.provider):
            assert code not in (column or "")
        # The number is never readable in the row, only sealed.
        assert E164 not in row.destination_sealed and E164 not in row.destination_hash
        assert crypto.unseal(row.destination_sealed) == {"d": E164}

    def test_same_code_hashes_differently_per_challenge(self):
        assert otp._code_hash("a" * 24, "123456") != otp._code_hash("b" * 24, "123456")

    def test_expiry_and_resend_timestamps(self, client, db, sent):
        challenge_id, _ = issue(client, sent)
        row = db.get(OtpChallenge, challenge_id)
        assert row.expires_at - row.created_at == timedelta(seconds=300)
        assert row.resend_available_at - row.created_at == timedelta(seconds=45)


# ------------------------------------------------------------------- verify


class TestVerify:
    def test_existing_verified_phone_signs_in(self, client, db, phone_owner, sent):
        challenge_id, code = issue(client, sent)
        response = verify(client, challenge_id, code)
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["status"] == "signed-in"
        assert data["customer"]["id"] == phone_owner.id
        assert decode(data["token"]["accessToken"])["sub"] == phone_owner.id
        row = db.get(OtpChallenge, challenge_id)
        assert row.status == "verified" and row.consumed_at is not None
        assert db.query(CustomerSession).filter_by(customer_id=phone_owner.id).count() == 1
        identity = db.query(CustomerIdentity).filter_by(provider="phone", provider_user_id=E164).one()
        assert identity.last_login_at is not None
        # The token works.
        me = client.get("/api/account/security", headers=customer_token(client, response.json()))
        assert me.status_code == 200

    def test_existing_email_signs_in_and_marks_the_address_verified(self, client, db, customer, sent):
        assert customer.email_verified_at is None
        challenge_id, code = issue(client, sent, "SHOPPER@example.com", "email")
        response = verify(client, challenge_id, code)
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["status"] == "signed-in" and data["customer"]["id"] == customer.id
        assert data["customer"]["emailVerified"] is True
        db.refresh(customer)
        assert customer.email_verified_at is not None

    def test_a_contact_phone_without_a_verified_identity_is_not_a_sign_in(self, client, db, customer, sent):
        # customer.phone is 9876500001 but there is no phone identity: that's a sign-up, not a takeover.
        challenge_id, code = issue(client, sent, customer.phone)
        data = verify(client, challenge_id, code).json()["data"]
        assert data["status"] == "signup-required"

    def test_new_phone_needs_signup(self, client, db, sent):
        challenge_id, code = issue(client, sent)
        response = verify(client, challenge_id, code)
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["status"] == "signup-required"
        assert data["channel"] == "sms" and data["destination"] == "+91•••••43210"
        assert "token" not in data and data["signupToken"]
        claims = decode(data["signupToken"])
        assert claims["purpose"] == "otp-signup" and claims["jti"] == challenge_id
        assert E164 not in data["signupToken"]
        assert db.query(Customer).count() == 0

    def test_incorrect_code_counts_attempts(self, client, db, sent):
        challenge_id, code = issue(client, sent)
        response = verify(client, challenge_id, wrong(code))
        assert response.status_code == 422
        assert err(response) == "OTP_INCORRECT"
        assert response.json()["details"] == {"attemptsLeft": 4}
        assert verify(client, challenge_id, wrong(code)).json()["details"] == {"attemptsLeft": 3}
        row = db.get(OtpChallenge, challenge_id)
        assert row.attempts == 2 and row.status == "pending"
        # Still usable with the right code.
        assert verify(client, challenge_id, code).json()["data"]["status"] == "signup-required"

    def test_locked_after_max_attempts(self, client, db, sent):
        challenge_id, code = issue(client, sent)
        for left in (4, 3, 2, 1):
            assert verify(client, challenge_id, wrong(code)).json()["details"] == {"attemptsLeft": left}
        last = verify(client, challenge_id, wrong(code))
        assert last.status_code == 422 and err(last) == "OTP_LOCKED"
        assert last.json()["details"] == {"attemptsLeft": 0}
        assert db.get(OtpChallenge, challenge_id).status == "locked"
        # Even the right code no longer works.
        right = verify(client, challenge_id, code)
        assert right.status_code == 422 and err(right) == "OTP_LOCKED"

    def test_expired(self, client, db, sent):
        challenge_id, code = issue(client, sent)
        row = db.get(OtpChallenge, challenge_id)
        row.expires_at = datetime.utcnow() - timedelta(seconds=1)
        db.flush()
        response = verify(client, challenge_id, code)
        assert response.status_code == 422 and err(response) == "OTP_EXPIRED"
        assert db.get(OtpChallenge, challenge_id).status == "expired"
        assert err(verify(client, challenge_id, code)) == "OTP_INVALID"

    def test_single_use(self, client, db, phone_owner, sent):
        challenge_id, code = issue(client, sent)
        assert verify(client, challenge_id, code).status_code == 200
        again = verify(client, challenge_id, code)
        assert again.status_code == 422 and err(again) == "OTP_USED"

    def test_superseded_by_a_newer_code(self, client, db, sent, no_resend_wait):
        first_id, first_code = issue(client, sent)
        second_id, second_code = issue(client, sent)
        assert db.get(OtpChallenge, first_id).status == "superseded"
        response = verify(client, first_id, first_code)
        assert response.status_code == 422 and err(response) == "OTP_SUPERSEDED"
        assert verify(client, second_id, second_code).status_code == 200

    def test_an_email_code_does_not_supersede_an_sms_code(self, client, db, sent):
        sms_id, _ = issue(client, sent)
        issue(client, sent, NEW_EMAIL, "email")
        assert db.get(OtpChallenge, sms_id).status == "pending"

    @pytest.mark.parametrize("challenge_id", ["does-not-exist", "x" * 32])
    def test_unknown_challenge(self, client, sent, challenge_id):
        response = verify(client, challenge_id, "123456")
        assert response.status_code == 422 and err(response) == "OTP_INVALID"

    def test_a_signed_in_purpose_code_cannot_sign_in(self, client, db, customer, sent):
        issued = otp.request(db, channel="sms", destination=PHONE, purpose="verify-phone", customer=customer)
        response = verify(client, issued["challengeId"], sent[-1][2])
        assert err(response) == "OTP_INVALID"

    def test_blocked_account(self, client, db, phone_owner, sent):
        phone_owner.status = "blocked"
        db.flush()
        challenge_id, code = issue(client, sent)
        response = verify(client, challenge_id, code)
        assert response.status_code == 403 and err(response) == "ACCOUNT_BLOCKED"
        # The code is spent either way, and no session was issued.
        assert db.get(OtpChallenge, challenge_id).status == "verified"
        assert err(verify(client, challenge_id, code)) == "OTP_USED"
        assert db.query(CustomerSession).filter_by(customer_id=phone_owner.id).count() == 0

    def test_blocked_account_by_email(self, client, db, customer, sent):
        customer.status = "blocked"
        db.flush()
        challenge_id, code = issue(client, sent, customer.email, "email")
        response = verify(client, challenge_id, code)
        assert response.status_code == 403 and err(response) == "ACCOUNT_BLOCKED"


# ------------------------------------------------------------------- signup


def signup_token(client, sent, destination=PHONE, channel="sms") -> str:
    challenge_id, code = issue(client, sent, destination, channel)
    data = verify(client, challenge_id, code).json()["data"]
    assert data["status"] == "signup-required", data
    return data["signupToken"]


class TestSignup:
    def test_sms_signup_creates_an_account_with_a_verified_phone(self, client, db, sent):
        token = signup_token(client, sent)
        response = signup(client, token, lastName="Iyer", email="Nisha.Iyer@example.com")
        assert response.status_code == 201, response.text
        data = response.json()["data"]
        assert data["token"]["accessToken"]
        person = data["customer"]
        assert person["email"] == "nisha.iyer@example.com"
        assert person["firstName"] == "Nisha" and person["lastName"] == "Iyer"
        assert person["phone"] == E164
        assert person["phoneVerified"] is True and person["emailVerified"] is False
        row = db.get(Customer, person["id"])
        assert row.phone_verified_at is not None and row.password_hash is None and row.status == "active"
        identity = db.query(CustomerIdentity).filter_by(provider="phone", provider_user_id=E164).one()
        assert identity.customer_id == row.id and identity.verified_at is not None
        assert decode(data["token"]["accessToken"])["sub"] == row.id
        # And the number now signs in.
        monkey_wait_over(db)
        challenge_id, code = issue(client, sent)
        signed = verify(client, challenge_id, code).json()["data"]
        assert signed["status"] == "signed-in" and signed["customer"]["id"] == row.id

    def test_email_signup_creates_a_verified_account(self, client, db, sent):
        token = signup_token(client, sent, NEW_EMAIL, "email")
        response = signup(client, token, email="ignored@example.com")
        assert response.status_code == 201, response.text
        person = response.json()["data"]["customer"]
        assert person["email"] == NEW_EMAIL and person["emailVerified"] is True
        assert db.query(Customer).filter_by(email="ignored@example.com").count() == 0

    def test_sms_signup_requires_an_email(self, client, db, sent):
        token = signup_token(client, sent)
        response = signup(client, token)
        assert response.status_code == 422 and err(response) == "EMAIL_REQUIRED"
        assert db.query(Customer).count() == 0

    def test_sms_signup_with_an_email_that_has_an_account(self, client, db, customer, sent):
        token = signup_token(client, sent)
        response = signup(client, token, email="SHOPPER@example.com")
        assert response.status_code == 409 and err(response) == "EMAIL_TAKEN"
        assert db.query(CustomerIdentity).filter_by(provider_user_id=E164).count() == 0

    def test_email_signup_for_an_address_that_has_an_account(self, client, db, customer, sent):
        # Signed up in the meantime (between verify and signup).
        token = signup_token(client, sent, NEW_EMAIL, "email")
        db.add(Customer(id="CUS009", email=NEW_EMAIL, first_name="X", status="active",
                        joined_at=datetime(2026, 1, 1)))
        db.flush()
        response = signup(client, token)
        assert response.status_code == 409 and err(response) == "EMAIL_TAKEN"

    def test_phone_already_in_use(self, client, db, customer, sent):
        token = signup_token(client, sent)
        db.add(CustomerIdentity(customer_id=customer.id, provider="phone", provider_user_id=E164,
                                verified_at=datetime(2026, 1, 1), created_at=datetime(2026, 1, 1)))
        db.flush()
        response = signup(client, token, email="nisha@example.com")
        assert response.status_code == 409 and err(response) == "PHONE_IN_USE"

    def test_the_token_cannot_create_a_second_account(self, client, db, sent):
        token = signup_token(client, sent)
        assert signup(client, token, email="first@example.com").status_code == 201
        again = signup(client, token, email="second@example.com")
        assert again.status_code == 409 and err(again) == "PHONE_IN_USE"
        assert db.query(Customer).count() == 1

    def test_expired_signup_token(self, client, db, sent, monkeypatch):
        monkeypatch.setattr(accounts, "SIGNUP_MINUTES", -1)
        token = signup_token(client, sent)
        response = signup(client, token, email="nisha@example.com")
        assert response.status_code == 401 and err(response) == "SIGNUP_EXPIRED"
        assert db.query(Customer).count() == 0

    @pytest.mark.parametrize("token", ["not-a-token-at-all", "eyJhbGciOiJIUzI1NiJ9.e30.x"])
    def test_garbage_signup_token(self, client, token):
        response = signup(client, token, email="nisha@example.com")
        assert response.status_code == 401 and err(response) == "SIGNUP_EXPIRED"

    def test_an_access_token_is_not_a_signup_token(self, client, token):
        response = signup(client, token, email="nisha@example.com")
        assert response.status_code == 401 and err(response) == "SIGNUP_EXPIRED"

    def test_first_name_is_required(self, client, sent):
        token = signup_token(client, sent)
        response = client.post("/api/auth/otp/signup", json={"signupToken": token, "email": "n@example.com"})
        assert response.status_code == 422 and err(response) == "VALIDATION_ERROR"


def monkey_wait_over(db) -> None:
    """Let the next code for any destination go out at once (as if the resend wait had passed)."""
    for row in db.query(OtpChallenge).all():
        row.resend_available_at = datetime.utcnow() - timedelta(seconds=1)
    db.flush()
