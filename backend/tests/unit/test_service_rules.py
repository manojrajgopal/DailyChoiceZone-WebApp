"""
Business rules that are pure functions: audit
redaction, phone numbers and unsubscribe links, webhook signatures, visitor
attribution and pincode validation.

No database. Each rule is checked against worked examples, including the
inputs it must refuse.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
from datetime import date, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.core.config import settings
from app.core.errors import ValidationError
from app.services import analytics_events, audit, serviceability
from app.services.messaging import service as messaging


# Order states: see tests/unit/test_fulfilment_workflow.py.


# -------------------------------------------------------------- audit trail


class TestSecretKeys:
    @pytest.mark.parametrize("key", ["password", "newPassword", "password_hash", "clientSecret", "client_secret",
                                     "refreshToken", "accessToken", "apiKey", "api_key", "cardNumber", "cvv",
                                     "Authorization", "razorpay_signature", "giftCode", "private-key", "otp"])
    def test_secret(self, key):
        assert audit.is_secret_key(key)

    @pytest.mark.parametrize("key", ["name", "email", "status", "price", "clientId", "cardholder", "giftMessage",
                                     "keyword", "phone"])
    def test_not_secret(self, key):
        assert not audit.is_secret_key(key)


class TestRedact:
    def test_secret_fields_are_blanked_but_empty_ones_stay_empty(self):
        assert audit.redact({"password": "hunter2", "token": "", "secret": None}) == {
            "password": "[redacted]", "token": "", "secret": None}

    @pytest.mark.parametrize("value", ["Bearer abc.def", "rzp_live_ABC123", "sk_test_xyz",
                                       "$2b$12$abcdefghijklmnopqrstuv",
                                       "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"])
    def test_secret_looking_values_are_blanked_wherever_they_are(self, value):
        assert audit.redact({"note": value}) == {"note": "[redacted]"}
        assert audit.redact([value]) == ["[redacted]"]

    def test_nested_structures(self):
        value = {"account": {"credentials": {"user": "u"}, "name": "n"}, "items": [{"apiKey": "k"}]}
        assert audit.redact(value) == {"account": {"credentials": "[redacted]", "name": "n"},
                                       "items": [{"apiKey": "[redacted]"}]}

    def test_bounds(self):
        assert audit.redact("x" * 600) == "x" * 500 + "…"
        assert len(audit.redact(list(range(80)))) == 50
        assert len(audit.redact({str(i): i for i in range(80)})) == 60
        deep = current = {}
        for _ in range(10):
            current["a"] = {}
            current = current["a"]
        assert "…" in str(audit.redact(deep))

    def test_types(self):
        assert audit.redact(Decimal("12.50")) == 12.5
        assert audit.redact(datetime(2026, 1, 2, 3, 4)) == "2026-01-02T03:04:00"
        assert audit.redact(date(2026, 1, 2)) == "2026-01-02"
        assert audit.redact((1, 2)) == [1, 2]
        assert audit.redact(True) is True and audit.redact(None) is None
        assert audit.redact(object()).startswith("<object")


class TestDiff:
    def test_only_changed_fields(self):
        assert audit.diff({"a": 1, "b": 2}, {"a": 1, "b": 3}) == {"b": {"from": 2, "to": 3}}

    def test_added_and_removed_fields(self):
        assert audit.diff({"a": 1}, {"b": 2}) == {"a": {"from": 1, "to": None}, "b": {"from": None, "to": 2}}

    def test_decimal_and_float_are_compared_by_value(self):
        assert audit.diff({"price": Decimal("10")}, {"price": 10.0}) == {}

    def test_secret_fields_hide_both_sides(self):
        assert audit.diff({"password": "a"}, {"password": "b"}) == {"password": {"from": "[redacted]",
                                                                               "to": "[redacted]"}}

    def test_restricted_to_keys(self):
        assert audit.diff({"a": 1, "b": 1}, {"a": 2, "b": 2}, keys=["a"]) == {"a": {"from": 1, "to": 2}}

    def test_none_snapshots(self):
        assert audit.diff(None, None) == {}
        assert audit.diff(None, {"a": 1}) == {"a": {"from": None, "to": 1}}

    def test_snapshot(self):
        assert audit.snapshot(SimpleNamespace(a=1), ["a", "missing"]) == {"a": 1, "missing": None}


# ------------------------------------------------------------- messaging


class TestNormalisePhone:
    @pytest.mark.parametrize("raw, number", [
        ("9876543210", "+919876543210"),
        ("98765 43210", "+919876543210"),
        ("(987) 654-3210", "+919876543210"),
        ("09876543210", "+919876543210"),
        ("919876543210", "+919876543210"),
        ("+91 98765-43210", "+919876543210"),
        ("+1 415 555 0100", "+14155550100"),
    ])
    def test_valid(self, raw, number):
        assert messaging.normalise_phone(raw) == number

    @pytest.mark.parametrize("raw", [None, "", "abc", "12345", "+1", "+1234567890123456", "98765432109"])
    def test_invalid(self, raw):
        assert messaging.normalise_phone(raw) is None


class TestMask:
    def test_email(self):
        assert messaging.mask("asha@example.com") == "a•••@example.com"
        assert messaging.mask("a@x.co").startswith("a••@")
        assert messaging.mask("averyverylongname@x.co").count("•") == 6

    def test_phone(self):
        masked = messaging.mask("+919876543210")
        assert masked.startswith("+91") and masked.endswith("43210") and "98765" not in masked

    def test_empty(self):
        assert messaging.mask("") == ""


class TestUnsubscribeToken:
    def test_round_trip(self):
        token = messaging.unsubscribe_token("CUS001", "sms", 7)
        assert messaging.read_unsubscribe_token(token) == ("CUS001", "sms", 7)
        assert messaging.read_unsubscribe_token(messaging.unsubscribe_token("CUS001")) == ("CUS001", "email", None)

    def test_a_tampered_token_is_refused(self):
        token = messaging.unsubscribe_token("CUS001")
        raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)).decode()
        forged = base64.urlsafe_b64encode(raw.replace("CUS001", "CUS002").encode()).decode().rstrip("=")
        assert messaging.read_unsubscribe_token(forged) is None

    def test_a_token_from_another_secret_is_refused(self, monkeypatch):
        token = messaging.unsubscribe_token("CUS001")
        monkeypatch.setattr(settings, "JWT_SECRET_KEY", "a-different-secret")
        assert messaging.read_unsubscribe_token(token) is None

    def test_unknown_channel_is_refused_even_if_signed(self):
        assert messaging.read_unsubscribe_token(messaging.unsubscribe_token("CUS001", "pigeon")) is None

    @pytest.mark.parametrize("token", ["", "garbage", "!!!", base64.urlsafe_b64encode(b"a:b").decode()])
    def test_rubbish(self, token):
        assert messaging.read_unsubscribe_token(token) is None


class TestRetryRules:
    @pytest.mark.parametrize("attempts, seconds", [(0, 60), (1, 60), (2, 120), (3, 240), (6, 1920), (20, 21600)])
    def test_backoff_doubles_up_to_a_cap(self, attempts, seconds):
        assert messaging._backoff(attempts) == timedelta(seconds=seconds)

    @pytest.mark.parametrize("message", ["Recipient address rejected", "550 No such user", "User unknown",
                                         "Mailbox unavailable", "The SMTP server couldn't send (SMTPRecipientsRefused)"])
    def test_permanent_email_failures(self, message):
        assert not messaging.email_transient(message)

    @pytest.mark.parametrize("message", ["Connection timed out", "Couldn't reach Gmail", "", None])
    def test_transient_email_failures(self, message):
        assert messaging.email_transient(message)

    def test_new_token_is_random_hex(self):
        first, second = messaging.new_token(), messaging.new_token()
        assert first != second and len(first) == 32 and int(first, 16) >= 0


class TestWebhookSignatures:
    def test_twilio(self, monkeypatch):
        monkeypatch.setattr(settings, "TWILIO_AUTH_TOKEN", "tok")
        url, params = "https://api.test/hook", {"MessageSid": "SM1", "MessageStatus": "delivered"}
        data = url + "MessageSidSM1MessageStatusdelivered"
        good = base64.b64encode(hmac.new(b"tok", data.encode(), hashlib.sha1).digest()).decode()
        assert messaging.twilio_signature_valid(url, params, good)
        assert not messaging.twilio_signature_valid(url, {**params, "MessageStatus": "failed"}, good)
        assert not messaging.twilio_signature_valid(url, params, "")

    def test_twilio_without_a_token_trusts_nothing(self, monkeypatch):
        monkeypatch.setattr(settings, "TWILIO_AUTH_TOKEN", "")
        assert not messaging.twilio_signature_valid("u", {}, "anything")

    def test_whatsapp(self, monkeypatch):
        monkeypatch.setattr(settings, "WHATSAPP_APP_SECRET", "app-secret")
        body = b'{"entry":[]}'
        good = "sha256=" + hmac.new(b"app-secret", body, hashlib.sha256).hexdigest()
        assert messaging.whatsapp_signature_valid(body, good)
        assert not messaging.whatsapp_signature_valid(body + b" ", good)
        assert not messaging.whatsapp_signature_valid(body, good[7:])  # missing prefix

    def test_whatsapp_without_a_secret_trusts_nothing(self, monkeypatch):
        monkeypatch.setattr(settings, "WHATSAPP_APP_SECRET", "")
        assert not messaging.whatsapp_signature_valid(b"x", "sha256=abc")


# ------------------------------------------------------------- analytics


class TestAttribution:
    @pytest.mark.parametrize("agent, device", [
        ("Mozilla/5.0 (iPad; CPU OS 17_0)", "tablet"),
        ("Mozilla/5.0 (Linux; Android 14; Tablet)", "tablet"),
        ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)", "mobile"),
        ("Mozilla/5.0 (Linux; Android 14) Mobile", "mobile"),
        ("Mozilla/5.0 (Windows NT 10.0; Win64)", "desktop"),
        ("", ""),
        (None, ""),
    ])
    def test_device(self, agent, device):
        assert analytics_events.device_of(agent) == device

    def test_utm_source_wins_and_is_cleaned(self):
        assert analytics_events.source_of("https://google.com", "News Letter!") == "newsletter"

    def test_referrer_host(self):
        assert analytics_events.source_of("https://www.google.com/search?q=x") == "google.com"

    def test_no_referrer_is_direct(self):
        assert analytics_events.source_of("") == "direct"

    def test_own_site_is_not_a_source(self, monkeypatch):
        monkeypatch.setattr(settings, "STOREFRONT_URL", "https://shop.test")
        assert analytics_events.source_of("https://shop.test/products") == ""

    def test_visitor_key_is_hashed_and_prefers_the_customer(self):
        anonymous = analytics_events.visitor_key("browser-123")
        signed_in = analytics_events.visitor_key("browser-123", "CUS001")
        assert anonymous != signed_in
        assert "browser-123" not in anonymous and "CUS001" not in signed_in
        assert signed_in == analytics_events.visitor_key("another-browser", "CUS001")
        assert len(anonymous) == 40


# --------------------------------------------------------- serviceability


class TestPincodes:
    @pytest.mark.parametrize("value", ["560001", " 560 001 ", 110001, "999999"])
    def test_valid(self, value):
        assert serviceability.valid(value)

    @pytest.mark.parametrize("value", ["060001", "56000", "5600011", "56A001", "", None])
    def test_invalid(self, value):
        assert not serviceability.valid(value)

    def test_business_days_skip_weekends(self):
        friday = datetime(2026, 10, 2)  # a Friday
        assert serviceability._business_days_from(1, friday) == datetime(2026, 10, 5)  # Monday
        assert serviceability._business_days_from(0, friday) == friday
        assert serviceability._business_days_from(-3, friday) == friday
        assert serviceability._business_days_from(5, friday) == datetime(2026, 10, 9)

    def test_estimate_label_format(self):
        label = serviceability.estimate_label(2)
        weekday, rest = label.split(", ")
        assert weekday in ("Mon", "Tue", "Wed", "Thu", "Fri")
        assert len(rest.split()) == 2


class TestPincodeEntryValidation:
    def test_full_entry(self):
        entry = serviceability._clean({
            "pincode": "560 001", "city": " Bengaluru ", "state": "Karnataka", "minDays": "2", "maxDays": 4,
            "deliveryFee": "49.50", "codAvailable": "no", "expressAvailable": "YES", "serviceable": 1,
            "courier": "Delhivery", "active": "true",
        })
        assert entry["pincode"] == "560001" and entry["city"] == "Bengaluru"
        assert (entry["min_days"], entry["max_days"]) == (2, 4)
        assert entry["delivery_fee"] == 4950
        assert entry["cod_available"] is False and entry["express_available"] is True
        assert entry["serviceable"] is True and entry["active"] is True

    def test_defaults(self):
        entry = serviceability._clean({"pincode": "110001"})
        assert entry["min_days"] is None and entry["delivery_fee"] is None
        assert entry["serviceable"] and entry["cod_available"] and entry["active"]

    @pytest.mark.parametrize("payload, code", [
        ({"pincode": "012345"}, "PINCODE_INVALID"),
        ({"pincode": "560001", "minDays": "two"}, "INVALID_DAYS"),
        ({"pincode": "560001", "minDays": -1}, "INVALID_DAYS"),
        ({"pincode": "560001", "maxDays": 61}, "INVALID_DAYS"),
        ({"pincode": "560001", "minDays": 5, "maxDays": 3}, "INVALID_DAYS"),
        ({"pincode": "560001", "deliveryFee": "free"}, "INVALID_FEE"),
        ({"pincode": "560001", "deliveryFee": -1}, "INVALID_FEE"),
        ({"pincode": "560001", "deliveryFee": 100001}, "INVALID_FEE"),
    ])
    def test_refused(self, payload, code):
        with pytest.raises(ValidationError) as caught:
            serviceability._clean(payload)
        assert caught.value.error_code == code

    def test_boundaries_accepted(self):
        entry = serviceability._clean({"pincode": "560001", "minDays": 0, "maxDays": 60, "deliveryFee": 0})
        assert (entry["min_days"], entry["max_days"], entry["delivery_fee"]) == (0, 60, 0)

    def test_long_text_is_cut(self):
        entry = serviceability._clean({"pincode": "560001", "city": "c" * 200, "notes": "n" * 300})
        assert len(entry["city"]) == 120 and len(entry["notes"]) == 255
