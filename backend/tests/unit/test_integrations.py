"""
The edges where the backend talks to somebody else: SMS and WhatsApp
providers, the S3 bucket, and the encryption of stored email credentials.

Nothing here touches the network. The HTTP transport (`urllib.request.urlopen`)
and the boto3 client are replaced with fakes that record what was asked of
them, so each test checks both what was sent and how the answer was read.
"""

from __future__ import annotations

import io
import json
import urllib.error
import urllib.parse

import pytest

from app.core.config import settings
from app.services import storage
from app.services.email import crypto
from app.services.messaging import providers
from app.services.messaging.providers import (
    Message,
    MetaWhatsApp,
    ProviderError,
    TwilioSms,
    TwilioWhatsApp,
    Unconfigured,
)


# ------------------------------------------------------------ transport fake


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class Transport:
    """Stands in for `urlopen`: records requests, replays a scripted outcome."""

    def __init__(self, outcome):
        self.outcome = outcome
        self.requests = []

    def __call__(self, request, timeout=None):
        self.requests.append(request)
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        body = self.outcome if isinstance(self.outcome, (bytes, str)) else json.dumps(self.outcome)
        return _Response(body.encode() if isinstance(body, str) else body)

    @property
    def last(self):
        return self.requests[-1]

    def form(self) -> dict:
        return dict(urllib.parse.parse_qsl(self.last.data.decode()))


def _http_error(code: int, body: dict | None = None) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("https://x", code, "err", {}, io.BytesIO(json.dumps(body or {}).encode()))


@pytest.fixture()
def transport(monkeypatch):
    def install(outcome):
        fake = Transport(outcome)
        monkeypatch.setattr(providers.urllib.request, "urlopen", fake)
        return fake

    return install


# ------------------------------------------------------------------ _http


class TestHttp:
    def test_parses_json(self, transport):
        transport({"ok": 1})
        assert providers._http("GET", "https://x", data=None, headers={}) == {"ok": 1}

    def test_empty_body_is_an_empty_dict(self, transport):
        transport(b"")
        assert providers._http("GET", "https://x", data=None, headers={}) == {}

    @pytest.mark.parametrize("code, transient", [(400, False), (401, False), (404, False), (408, True),
                                                 (425, True), (429, True), (500, True), (503, True)])
    def test_http_errors_are_classified(self, transport, code, transient):
        transport(_http_error(code, {"message": "nope"}))
        with pytest.raises(ProviderError) as caught:
            providers._http("POST", "https://x", data=b"", headers={})
        assert caught.value.transient is transient
        assert f"HTTP {code}" in str(caught.value)
        assert "nope" in str(caught.value)

    def test_nested_error_message_is_read(self, transport):
        transport(_http_error(400, {"error": {"message": "bad template"}}))
        with pytest.raises(ProviderError, match="bad template"):
            providers._http("POST", "https://x", data=b"", headers={})

    def test_unreadable_error_body_still_reports_the_status(self, transport):
        transport(urllib.error.HTTPError("https://x", 502, "err", {}, io.BytesIO(b"<html>")))
        with pytest.raises(ProviderError, match="HTTP 502"):
            providers._http("POST", "https://x", data=b"", headers={})

    @pytest.mark.parametrize("error", [urllib.error.URLError("down"), TimeoutError(), OSError("reset")])
    def test_network_failures_are_transient(self, transport, error):
        transport(error)
        with pytest.raises(ProviderError) as caught:
            providers._http("POST", "https://x", data=b"", headers={})
        assert caught.value.transient is True
        assert "Couldn't reach the provider" in str(caught.value)


# ---------------------------------------------------------------- Twilio


class TestTwilioSms:
    def test_unconfigured_without_credentials(self):
        ready, reason = TwilioSms("", "", "+1").configured()
        assert not ready and "TWILIO_ACCOUNT_SID" in reason

    def test_unconfigured_without_sender(self):
        ready, reason = TwilioSms("AC1", "tok", "").configured()
        assert not ready and "NOTIFICATION_SMS_SENDER" in reason

    def test_send_refuses_when_unconfigured_without_calling_out(self, transport):
        fake = transport({"sid": "SM1"})
        with pytest.raises(ProviderError) as caught:
            TwilioSms("", "", "").send(Message(to="+919876500001", text="hi"))
        assert caught.value.transient is False
        assert fake.requests == []

    def test_send_with_a_phone_number_sender(self, transport, monkeypatch):
        monkeypatch.setattr(settings, "PUBLIC_API_URL", "")
        fake = transport({"sid": "SM123"})
        result = TwilioSms("AC1", "tok", "+14155550100").send(Message(to="+919876500001", text="Hello"))
        assert result.message_id == "SM123" and result.status == "sent"
        form = fake.form()
        assert form == {"To": "+919876500001", "Body": "Hello", "From": "+14155550100"}
        assert "/Accounts/AC1/Messages.json" in fake.last.full_url
        assert fake.last.get_header("Authorization").startswith("Basic ")

    def test_messaging_service_sid_is_sent_as_such(self, transport, monkeypatch):
        monkeypatch.setattr(settings, "PUBLIC_API_URL", "")
        fake = transport({"sid": "SM1"})
        TwilioSms("AC1", "tok", "MG999").send(Message(to="+1", text="x"))
        assert fake.form()["MessagingServiceSid"] == "MG999"
        assert "From" not in fake.form()

    def test_long_text_is_cut_to_twilios_limit(self, transport, monkeypatch):
        monkeypatch.setattr(settings, "PUBLIC_API_URL", "")
        fake = transport({"sid": "SM1"})
        TwilioSms("AC1", "tok", "+1").send(Message(to="+1", text="a" * 2000))
        assert len(fake.form()["Body"]) == 1600

    def test_status_callback_is_attached_when_the_api_is_public(self, transport, monkeypatch):
        monkeypatch.setattr(settings, "PUBLIC_API_URL", "https://api.example.com/")
        fake = transport({"sid": "SM1"})
        TwilioSms("AC1", "tok", "+1").send(Message(to="+1", text="x"))
        assert fake.form()["StatusCallback"] == "https://api.example.com/api/notifications/webhooks/twilio"

    def test_missing_sid_in_the_answer_is_a_transient_failure(self, transport, monkeypatch):
        monkeypatch.setattr(settings, "PUBLIC_API_URL", "")
        transport({})
        with pytest.raises(ProviderError) as caught:
            TwilioSms("AC1", "tok", "+1").send(Message(to="+1", text="x"))
        assert caught.value.transient


class TestTwilioWhatsApp:
    def test_unconfigured_reasons(self):
        assert "TWILIO_ACCOUNT_SID" in TwilioWhatsApp("", "", "x").configured()[1]
        assert "NOTIFICATION_WHATSAPP_SENDER" in TwilioWhatsApp("AC", "t", "").configured()[1]
        assert TwilioWhatsApp("AC", "t", "whatsapp:+1").configured() == (True, "")

    def test_template_message(self, transport, monkeypatch):
        monkeypatch.setattr(settings, "PUBLIC_API_URL", "")
        fake = transport({"sid": "SM1"})
        TwilioWhatsApp("AC", "t", "+14155238886").send(
            Message(to="+919876500001", template="HX1", variables=["Asha", "ORD001"]))
        form = fake.form()
        assert form["From"] == "whatsapp:+14155238886"
        assert form["To"] == "whatsapp:+919876500001"
        assert form["ContentSid"] == "HX1"
        assert json.loads(form["ContentVariables"]) == {"1": "Asha", "2": "ORD001"}
        assert "Body" not in form

    def test_session_text_message_keeps_a_prefixed_sender(self, transport, monkeypatch):
        monkeypatch.setattr(settings, "PUBLIC_API_URL", "")
        fake = transport({"sid": "SM1"})
        TwilioWhatsApp("AC", "t", "whatsapp:+1").send(Message(to="+2", text="hello"))
        assert fake.form()["From"] == "whatsapp:+1"
        assert fake.form()["Body"] == "hello"


# ------------------------------------------------------------------- Meta


class TestMetaWhatsApp:
    def test_unconfigured(self):
        ready, reason = MetaWhatsApp("", "", "").configured()
        assert not ready and "WHATSAPP_ACCESS_TOKEN" in reason

    def test_default_api_version(self):
        assert MetaWhatsApp("t", "p", "").version == "v20.0"

    def test_send_refuses_when_unconfigured(self, transport):
        fake = transport({})
        with pytest.raises(ProviderError):
            MetaWhatsApp("", "", "v20.0").send(Message(to="+1", text="x"))
        assert fake.requests == []

    def test_template_payload(self, transport):
        fake = transport({"messages": [{"id": "wamid.1"}]})
        result = MetaWhatsApp("tok", "123", "v20.0").send(
            Message(to="+919876500001", template="order_shipped", language="en_US", variables=["Asha", 5]))
        assert result.message_id == "wamid.1"
        sent = json.loads(fake.last.data)
        assert sent["to"] == "919876500001"  # no leading +
        assert sent["template"]["name"] == "order_shipped"
        assert sent["template"]["language"] == {"code": "en_US"}
        assert sent["template"]["components"][0]["parameters"] == [
            {"type": "text", "text": "Asha"}, {"type": "text", "text": "5"}]
        assert fake.last.full_url == "https://graph.facebook.com/v20.0/123/messages"
        assert fake.last.get_header("Authorization") == "Bearer tok"

    def test_template_without_variables_has_no_components(self, transport):
        fake = transport({"messages": [{"id": "wamid.1"}]})
        MetaWhatsApp("tok", "123", "v20.0").send(Message(to="1", template="hello"))
        assert json.loads(fake.last.data)["template"]["components"] == []

    def test_text_payload(self, transport):
        fake = transport({"messages": [{"id": "wamid.2"}]})
        MetaWhatsApp("tok", "123", "v20.0").send(Message(to="+1", text="hi there"))
        sent = json.loads(fake.last.data)
        assert sent["type"] == "text" and sent["text"] == {"body": "hi there"}

    @pytest.mark.parametrize("answer", [{}, {"messages": []}, {"messages": [{}]}])
    def test_answer_without_a_message_id_is_transient(self, transport, answer):
        transport(answer)
        with pytest.raises(ProviderError) as caught:
            MetaWhatsApp("tok", "123", "v20.0").send(Message(to="1", text="x"))
        assert caught.value.transient


# --------------------------------------------------------------- factory


class TestFactory:
    def test_unconfigured_refuses_every_send(self):
        provider = Unconfigured("sms", "off")
        assert provider.configured() == (False, "off")
        assert provider.describe() == {"provider": "none", "configured": False, "reason": "off"}
        with pytest.raises(ProviderError) as caught:
            provider.send(Message(to="+1"))
        assert not caught.value.transient

    def test_describe_of_a_ready_provider_has_no_reason(self):
        assert TwilioSms("AC", "t", "+1").describe() == {"provider": "twilio", "configured": True, "reason": ""}

    @pytest.mark.parametrize("name, kind", [("twilio", TwilioSms), ("TWILIO", TwilioSms),
                                            ("none", Unconfigured), ("", Unconfigured), ("nexmo", Unconfigured)])
    def test_sms(self, monkeypatch, name, kind):
        monkeypatch.setattr(settings, "NOTIFICATION_SMS_PROVIDER", name)
        assert isinstance(providers.sms(), kind)

    def test_unknown_sms_provider_says_so(self, monkeypatch):
        monkeypatch.setattr(settings, "NOTIFICATION_SMS_PROVIDER", "nexmo")
        assert "Unknown SMS provider 'nexmo'" in providers.sms().configured()[1]

    @pytest.mark.parametrize("name, kind", [("meta", MetaWhatsApp), ("twilio", TwilioWhatsApp),
                                            ("none", Unconfigured), ("gupshup", Unconfigured)])
    def test_whatsapp(self, monkeypatch, name, kind):
        monkeypatch.setattr(settings, "NOTIFICATION_WHATSAPP_PROVIDER", name)
        assert isinstance(providers.whatsapp(), kind)

    def test_for_channel(self, monkeypatch):
        monkeypatch.setattr(settings, "NOTIFICATION_SMS_PROVIDER", "none")
        monkeypatch.setattr(settings, "NOTIFICATION_WHATSAPP_PROVIDER", "none")
        assert providers.for_channel("sms").channel == "sms"
        assert providers.for_channel("whatsapp").channel == "whatsapp"
        with pytest.raises(ValueError):
            providers.for_channel("pigeon")

    def test_status_callback_needs_a_public_address(self, monkeypatch):
        monkeypatch.setattr(settings, "PUBLIC_API_URL", "")
        assert providers.status_callback_url("twilio") == ""


# ---------------------------------------------------------------- storage


class FakeS3:
    def __init__(self, fail: bool = False):
        self.fail = fail
        self.puts = []
        self.presigned = []

    def put_object(self, **kwargs):
        if self.fail:
            raise RuntimeError("AccessDenied")
        self.puts.append(kwargs)

    def generate_presigned_url(self, operation, Params, ExpiresIn):
        self.presigned.append((operation, Params, ExpiresIn))
        return "https://signed.example/" + Params["Key"]


@pytest.fixture()
def s3(monkeypatch):
    for key, value in {
        "AWS_ACCESS_KEY_ID": "AKIA", "AWS_SECRET_ACCESS_KEY": "secret", "AWS_S3_BUCKET": "dcz",
        "AWS_REGION": "ap-south-1", "AWS_S3_PUBLIC_URL": "", "AWS_S3_ENDPOINT_URL": "", "AWS_S3_PREFIX": "products",
    }.items():
        monkeypatch.setattr(settings, key, value)
    fake = FakeS3()
    monkeypatch.setattr(storage, "_client", lambda *a: fake)
    return fake


class TestStorage:
    def test_configured_needs_all_three(self, monkeypatch, s3):
        assert storage.is_configured()
        monkeypatch.setattr(settings, "AWS_S3_BUCKET", "")
        assert not storage.is_configured()

    def test_public_url_variants(self, monkeypatch, s3):
        assert storage.public_url("products/a.jpg") == "https://dcz.s3.ap-south-1.amazonaws.com/products/a.jpg"
        monkeypatch.setattr(settings, "AWS_S3_ENDPOINT_URL", "https://minio.local/")
        assert storage.public_url("k") == "https://minio.local/dcz/k"
        monkeypatch.setattr(settings, "AWS_S3_PUBLIC_URL", "https://cdn.example.com/")
        assert storage.public_url("k") == "https://cdn.example.com/k"

    def test_put_file_stores_under_the_prefix_and_returns_the_address(self, s3):
        url = storage.put_file(b"img", "abc.jpg", "image/jpeg")
        assert url == "https://dcz.s3.ap-south-1.amazonaws.com/products/abc.jpg"
        put = s3.puts[0]
        assert put["Bucket"] == "dcz" and put["Key"] == "products/abc.jpg"
        assert put["ContentType"] == "image/jpeg" and put["Body"] == b"img"
        assert "immutable" in put["CacheControl"]

    def test_put_file_without_a_prefix(self, monkeypatch, s3):
        monkeypatch.setattr(settings, "AWS_S3_PREFIX", "/")
        storage.put_file(b"x", "a.png", "image/png")
        assert s3.puts[0]["Key"] == "a.png"

    def test_put_file_refuses_when_unconfigured(self, monkeypatch, s3):
        monkeypatch.setattr(settings, "AWS_ACCESS_KEY_ID", "")
        with pytest.raises(storage.StorageUnavailableError) as caught:
            storage.put_file(b"x", "a.png", "image/png")
        assert caught.value.status_code == 503 and caught.value.error_code == "UPLOADS_DISABLED"
        assert s3.puts == []

    def test_put_file_failure_is_a_502_without_the_providers_detail(self, s3):
        s3.fail = True
        with pytest.raises(storage.StorageFailedError) as caught:
            storage.put_file(b"x", "a.png", "image/png")
        assert caught.value.status_code == 502
        assert "AccessDenied" not in caught.value.message

    def test_put_private_is_not_cacheable(self, s3):
        storage.put_private(b"doc", "support/T1/a.pdf", "application/pdf")
        assert s3.puts[0]["Key"] == "support/T1/a.pdf"
        assert s3.puts[0]["CacheControl"] == "private, no-store"

    def test_put_private_failure_and_unconfigured(self, monkeypatch, s3):
        s3.fail = True
        with pytest.raises(storage.StorageFailedError):
            storage.put_private(b"x", "k", "text/plain")
        monkeypatch.setattr(settings, "AWS_S3_BUCKET", "")
        with pytest.raises(storage.StorageUnavailableError):
            storage.put_private(b"x", "k", "text/plain")

    def test_signed_url_sanitises_the_download_name(self, s3):
        url = storage.signed_url("support/k", 'bad"; name<>.pdf', inline=False, expires=60)
        assert url == "https://signed.example/support/k"
        operation, params, expires = s3.presigned[0]
        assert operation == "get_object" and expires == 60
        assert params["ResponseContentDisposition"] == 'attachment; filename="bad name.pdf"'

    def test_signed_url_inline_and_empty_name(self, s3):
        storage.signed_url("k", "<<>>", inline=True)
        assert s3.presigned[0][1]["ResponseContentDisposition"] == 'inline; filename="file"'

    def test_signed_url_refuses_when_unconfigured(self, monkeypatch, s3):
        monkeypatch.setattr(settings, "AWS_SECRET_ACCESS_KEY", "")
        with pytest.raises(storage.StorageUnavailableError):
            storage.signed_url("k", "a", inline=True)


# ----------------------------------------------------------------- crypto


class TestCredentialCrypto:
    def test_round_trip(self):
        sealed = crypto.seal({"password": "hunter2", "port": 587})
        assert "hunter2" not in sealed
        assert crypto.unseal(sealed) == {"password": "hunter2", "port": 587}

    def test_a_different_key_cannot_read_it(self, monkeypatch):
        sealed = crypto.seal({"a": 1})
        monkeypatch.setattr(settings, "EMAIL_ENCRYPTION_KEY", "a-completely-different-key")
        assert crypto.unseal(sealed) == {}

    @pytest.mark.parametrize("token", ["", "garbage", "gAAAAA-not-really"])
    def test_rubbish_unseals_to_nothing(self, token):
        assert crypto.unseal(token) == {}

    def test_mask_keeps_only_the_tail(self):
        masked = crypto.mask("GOCSPX-abcd1234")
        assert masked.endswith("1234")
        assert "GOCSPX" not in masked
        assert crypto.mask("abcdef", keep=2).endswith("ef")

    @pytest.mark.parametrize("value", ["", None])
    def test_mask_of_nothing_is_empty(self, value):
        assert crypto.mask(value) == ""


# ---------------------------------------------------------- network guard


class TestNoInternet:
    """conftest's `_no_internet` guard: a test that reaches out fails instead."""

    def test_an_outside_host_is_refused(self):
        import socket

        with pytest.raises(RuntimeError, match="reach the network"):
            socket.create_connection(("203.0.113.10", 443), timeout=1)

    def test_an_http_client_is_refused_too(self):
        import httpx

        # An IP literal, so not even a DNS lookup leaves the machine.
        with pytest.raises(RuntimeError, match="reach the network"):
            httpx.get("https://203.0.113.10/v1/payments", timeout=1)
