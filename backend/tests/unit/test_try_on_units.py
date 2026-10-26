"""
Virtual try-on's pure parts: error classification and sanitising, photo
checks, the Hugging Face adapter against a fake gradio client, credential
encryption and key rotation, and plan entitlement validation.
"""

from __future__ import annotations

import io
import struct
import zlib
from pathlib import Path

import pytest
from PIL import Image

from app.core.config import settings
from app.core.errors import ValidationError
from app.services.try_on import crypto, entitlements, images
from app.services.try_on.adapters import huggingface
from app.services.try_on.adapters.base import GenerationInput
from app.services.try_on.errors import ProviderFailure, TryOnError, describe, sanitize


def jpeg(size=(600, 800), exif=False) -> bytes:
    out = io.BytesIO()
    image = Image.new("RGB", size, (120, 90, 60))
    if exif:
        data = image.getexif()
        data[0x010F] = "SecretCamera"  # Make
        image.save(out, format="JPEG", exif=data)
    else:
        image.save(out, format="JPEG")
    return out.getvalue()


# ----------------------------------------------------------------- errors


class TestClassification:
    @pytest.mark.parametrize("message, code", [
        ("You have exceeded your GPU quota (60s requested vs. 0s left). Try again in 0:05:00", "rate_limited"),
        ("ZeroGPU worker error", "rate_limited"),
        ("429 Too Many Requests", "rate_limited"),
        ("Invalid user token.", "invalid_credentials"),
        ("HTTP 401 Unauthorized", "invalid_credentials"),
        ("The read operation timed out", "timeout"),
        ("Could not fetch config for https://levihsu-ootdiffusion.hf.space", "provider_unavailable"),
        ("This Space is sleeping", "provider_unavailable"),
        ("503 Service Unavailable", "provider_unavailable"),
        ("Something nobody expected", "unknown"),
    ])
    def test_provider_messages(self, message, code):
        assert huggingface.classify_message(Exception(message)).code == code

    def test_a_timeout_exception(self):
        assert huggingface.classify_message(TimeoutError()).code == "timeout"

    def test_the_quota_wait_is_read(self):
        failure = huggingface.classify_message(Exception("GPU quota exceeded. Try again in 1:02:03"))
        assert failure.retry_after == 3723

    def test_only_credential_failures_blame_the_credential(self):
        assert describe("invalid_credentials").scope == "credential"
        assert describe("rate_limited").scope == "credential"
        assert describe("timeout").scope == "model"
        assert describe("invalid_image").scope == "request"
        assert describe("no-such-code").code == "unknown" and describe("no-such-code").badge == "Failed"

    def test_customers_never_see_the_technical_text(self):
        error = TryOnError("invalid_credentials")
        assert error.message == "The try-on service is unavailable right now. Please try again later."
        assert "credential" not in error.message


class TestSanitize:
    def test_secrets_links_and_paths_are_removed(self):
        text = sanitize("401 for hf_AbCdEf1234567890 at https://x.hf.space/run?token=abc&sig=1 "
                        r"file C:\Users\Manu\AppData\Local\Temp\gradio\x.png and /tmp/gradio/abc/out.png "
                        "Authorization: Bearer eyJhbGciOi.payload.sig")
        assert "hf_AbCdEf" not in text and "token=abc" not in text and "Manu" not in text
        assert "/tmp/gradio" not in text and "eyJhbGciOi" not in text
        assert "https://x.hf.space/run" in text

    def test_it_is_bounded(self):
        assert len(sanitize("x" * 5000)) == 500


# ----------------------------------------------------------------- photos


class TestPhotos:
    def test_a_photo_is_re_encoded_without_metadata(self):
        data = jpeg(exif=True)
        assert b"SecretCamera" in data
        result = images.normalise(data, max_bytes=10 * 1024 * 1024)
        assert b"SecretCamera" not in result.data
        assert (result.width, result.height) == (600, 800)
        assert Image.open(io.BytesIO(result.data)).format == "JPEG"

    def test_large_photos_are_scaled_down(self):
        result = images.normalise(jpeg((3000, 4000)), max_bytes=20 * 1024 * 1024)
        assert max(result.width, result.height) == images.MAX_EDGE

    def test_a_file_that_only_claims_to_be_an_image(self):
        with pytest.raises(TryOnError) as caught:
            images.normalise(b"<?php echo 'hi'; ?>" * 50, max_bytes=1024 * 1024)
        assert caught.value.code == "invalid_image"

    def test_gif_is_not_accepted(self):
        out = io.BytesIO()
        Image.new("P", (500, 600)).save(out, format="GIF")
        with pytest.raises(TryOnError) as caught:
            images.normalise(out.getvalue(), max_bytes=1024 * 1024)
        assert caught.value.code == "invalid_image"

    def test_too_many_bytes(self):
        with pytest.raises(TryOnError) as caught:
            images.normalise(jpeg(), max_bytes=100)
        assert caught.value.code == "image_too_large"

    def test_a_decompression_bomb_is_refused_before_decoding(self):
        # A tiny PNG whose header claims 50 000 × 50 000 pixels.
        def chunk(kind, body):
            return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))

        bomb = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 50000, 50000, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(b"\x00" * 100)) + chunk(b"IEND", b""))
        with pytest.raises(TryOnError) as caught:
            images.normalise(bomb, max_bytes=1024 * 1024)
        assert caught.value.code == "image_too_large"

    def test_too_small_for_the_capability(self):
        with pytest.raises(TryOnError) as caught:
            images.normalise(jpeg((200, 200)), max_bytes=1024 * 1024, rules={"minWidth": 384, "minHeight": 512})
        assert caught.value.code == "image_too_small"

    def test_the_plan_limit_never_exceeds_the_server_limit(self, monkeypatch):
        monkeypatch.setattr(settings, "VTO_MAX_UPLOAD_MB", 10)
        assert images.max_upload_bytes(50) == 10 * 1024 * 1024
        assert images.max_upload_bytes(2) == 2 * 1024 * 1024

    def test_product_photos_from_private_addresses_are_refused_in_production(self, monkeypatch):
        monkeypatch.setattr(settings, "ENVIRONMENT", "production")
        monkeypatch.setattr(images.socket, "getaddrinfo", lambda host, port: [(None, None, None, None, ("10.0.0.5", 0))])
        with pytest.raises(ProviderFailure) as caught:
            images.fetch_garment("https://internal.example/shirt.jpg")
        assert caught.value.code == "garment_unavailable"
        with pytest.raises(ProviderFailure):
            images.fetch_garment("file:///etc/passwd")


# ----------------------------------------------------- the Hugging Face adapter


class FakeJob:
    def __init__(self, result=None, error=None):
        self._result, self._error, self.cancelled = result, error, False

    def result(self, timeout=None):
        if self._error:
            raise self._error
        return self._result

    def cancel(self):
        self.cancelled = True


class FakeClient:
    def __init__(self, job):
        self.job, self.calls = job, []

    def submit(self, **kwargs):
        self.calls.append(kwargs)
        return self.job


@pytest.fixture()
def workdir(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "VTO_TEMP_DIR", str(tmp_path))
    return tmp_path


CONFIG = {"space": "levihsu/OOTDiffusion", "apiName": "/process_hd",
          "params": {"n_samples": 1, "n_steps": 20, "image_scale": 2, "seed": -1}}


class TestHuggingFace:
    def _inputs(self, capability="garment.upper_body"):
        return GenerationInput(capability, jpeg(), jpeg((400, 400)), "VTR001")

    def test_the_proven_call_and_its_answer(self, monkeypatch, workdir):
        download = workdir / "downloads" / "abc123"
        download.mkdir(parents=True)
        result = download / "image.png"
        Image.new("RGB", (768, 1024)).save(result, format="PNG")
        client = FakeClient(FakeJob(result=[{"image": str(result), "caption": None}]))
        seen = {}

        def client_for(space, secret):
            seen.update(space=space, secret=secret)
            return client

        monkeypatch.setattr(huggingface, "_client_for", client_for)
        output = huggingface.OotdHalfBody().generate(self._inputs(), secret="hf_x", config=CONFIG, timeout=30)
        assert seen == {"space": "levihsu/OOTDiffusion", "secret": "hf_x"}
        call = client.calls[0]
        assert call["api_name"] == "/process_hd"
        assert (call["n_samples"], call["n_steps"], call["image_scale"], call["seed"]) == (1, 20, 2, -1)
        assert set(call) == {"vton_img", "garm_img", "n_samples", "n_steps", "image_scale", "seed", "api_name"}
        assert output.content_type == "image/png" and output.data[:4] == b"\x89PNG"
        # Inputs and the downloaded result are gone.
        assert not result.exists() and not download.exists()
        assert not list((workdir / "work").glob("call-*"))

    def test_the_full_body_endpoint_sends_the_category(self, monkeypatch, workdir):
        path = workdir / "r.jpg"
        path.write_bytes(jpeg())
        client = FakeClient(FakeJob(result=[{"image": str(path)}]))
        monkeypatch.setattr(huggingface, "_client_for", lambda space, secret: client)
        huggingface.OotdFullBody().generate(self._inputs("garment.dress"), secret="hf_x",
                                            config={**CONFIG, "apiName": "/process_dc"}, timeout=30)
        assert client.calls[0]["category"] == "Dress"

    def test_a_call_that_runs_out_of_time_is_cancelled(self, monkeypatch, workdir):
        job = FakeJob(error=TimeoutError())
        monkeypatch.setattr(huggingface, "_client_for", lambda space, secret: FakeClient(job))
        with pytest.raises(ProviderFailure) as caught:
            huggingface.OotdHalfBody().generate(self._inputs(), secret="hf_x", config=CONFIG, timeout=1)
        assert caught.value.code == "timeout" and job.cancelled

    def test_quota_errors_are_rate_limits(self, monkeypatch, workdir):
        job = FakeJob(error=Exception("You have exceeded your GPU quota. Try again in 0:10:00"))
        monkeypatch.setattr(huggingface, "_client_for", lambda space, secret: FakeClient(job))
        with pytest.raises(ProviderFailure) as caught:
            huggingface.OotdHalfBody().generate(self._inputs(), secret="hf_x", config=CONFIG, timeout=30)
        assert caught.value.code == "rate_limited" and caught.value.retry_after == 600

    def test_an_answer_without_an_image(self, monkeypatch, workdir):
        monkeypatch.setattr(huggingface, "_client_for", lambda space, secret: FakeClient(FakeJob(result=[])))
        with pytest.raises(ProviderFailure) as caught:
            huggingface.OotdHalfBody().generate(self._inputs(), secret="hf_x", config=CONFIG, timeout=30)
        assert caught.value.code == "bad_provider_response"

    def test_a_failing_space_never_leaks_the_token(self, monkeypatch, workdir):
        def broken(space, secret):
            raise ValueError(f"Could not fetch config for space with token {secret}")

        monkeypatch.setattr(huggingface, "_client_for", broken)
        with pytest.raises(ProviderFailure) as caught:
            huggingface.OotdHalfBody().generate(self._inputs(), secret="hf_RealSecret123456", config=CONFIG, timeout=30)
        assert caught.value.code == "provider_unavailable"
        assert "hf_RealSecret123456" not in caught.value.detail


# --------------------------------------------------------------- encryption


class TestEncryption:
    def test_rotation_keeps_old_secrets_readable_until_resealed(self, monkeypatch):
        monkeypatch.setattr(settings, "VTO_ENCRYPTION_KEY", "first-key-" + "x" * 30)
        monkeypatch.setattr(settings, "VTO_ENCRYPTION_KEY_PREVIOUS", "")
        sealed = crypto.seal("hf_secret_value_1")
        monkeypatch.setattr(settings, "VTO_ENCRYPTION_KEY", "second-key-" + "y" * 30)
        assert crypto.unseal(sealed) is None  # the old key is gone: unreadable, not wrong
        monkeypatch.setattr(settings, "VTO_ENCRYPTION_KEY_PREVIOUS", "first-key-" + "x" * 30)
        assert crypto.unseal(sealed) == "hf_secret_value_1"
        assert not crypto.sealed_with_current_key(sealed)
        resealed = crypto.reseal(sealed)
        assert crypto.sealed_with_current_key(resealed)
        monkeypatch.setattr(settings, "VTO_ENCRYPTION_KEY_PREVIOUS", "")
        assert crypto.unseal(resealed) == "hf_secret_value_1"

    def test_production_without_a_key_refuses(self, monkeypatch):
        monkeypatch.setattr(settings, "ENVIRONMENT", "production")
        monkeypatch.setattr(settings, "VTO_ENCRYPTION_KEY", "")
        with pytest.raises(crypto.EncryptionKeyMissing):
            crypto.seal("hf_anything_12345")
        assert crypto.key_status()["available"] is False

    def test_the_mask_shows_only_the_end(self):
        assert crypto.mask("abcd") == "••••••••abcd"


# ------------------------------------------------------------ entitlements


class TestEntitlementRules:
    def test_defaults_are_filled_in(self):
        rules = entitlements.normalise({"enabled": True})
        assert rules["perPeriod"] == 10 and rules["concurrent"] == 1 and rules["retention"] == "temporary"

    def test_unlimited_is_allowed(self):
        assert entitlements.normalise({"enabled": True, "perPeriod": None})["perPeriod"] is None

    @pytest.mark.parametrize("value", [
        {"enabled": True, "perPeriod": 0}, {"enabled": True, "perPeriod": "lots"}, {"enabled": True, "retention": "forever"},
        {"enabled": True, "capabilities": "garment"}, ["not", "an", "object"],
    ])
    def test_nonsense_is_refused(self, value):
        with pytest.raises(ValidationError):
            entitlements.normalise(value)

    def test_nothing_means_not_included(self):
        assert entitlements.normalise(None) is None and entitlements.normalise({}) is None


def test_no_image_is_written_into_the_repository():
    """Try-on code never writes images next to the code."""
    backend = Path(__file__).resolve().parents[2]
    found = [p for p in (backend / "app").rglob("*") if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")]
    assert found == []


def test_the_ephemeral_lifetime_is_the_configured_minutes(monkeypatch):
    from app.services.try_on import storage

    monkeypatch.setattr(settings, "VTO_EPHEMERAL_TTL_MINUTES", 30)
    assert storage.ephemeral_ttl_seconds() == 30 * 60
    monkeypatch.setattr(settings, "VTO_EPHEMERAL_TTL_MINUTES", 100000)
    assert storage.ephemeral_ttl_seconds() == 24 * 60 * 60


class TestPreferIpv4:
    RESULTS = [(10, 1, 6, "", ("2600::1", 443, 0, 0)), (2, 1, 6, "", ("99.86.182.39", 443))]

    def test_provider_hosts_resolve_to_ipv4_first(self, monkeypatch):
        import socket

        from app.services.try_on import network

        monkeypatch.setattr(network, "_original", lambda host, *a, **k: list(self.RESULTS))
        monkeypatch.setattr(settings, "VTO_PREFER_IPV4", True)
        for host in ("huggingface.co", "levihsu-ootdiffusion.hf.space", b"cdn-lfs.hf.co"):
            assert [r[0] for r in network._prefer_ipv4(host, 443)] == [socket.AF_INET]

    def test_other_hosts_and_the_switch_are_left_alone(self, monkeypatch):
        from app.services.try_on import network

        monkeypatch.setattr(network, "_original", lambda host, *a, **k: list(self.RESULTS))
        monkeypatch.setattr(settings, "VTO_PREFER_IPV4", True)
        assert network._prefer_ipv4("images.unsplash.com", 443) == self.RESULTS
        assert network._prefer_ipv4("nothuggingface.co", 443) == self.RESULTS
        monkeypatch.setattr(settings, "VTO_PREFER_IPV4", False)
        assert network._prefer_ipv4("huggingface.co", 443) == self.RESULTS

    def test_a_host_with_only_ipv6_still_resolves(self, monkeypatch):
        from app.services.try_on import network

        monkeypatch.setattr(network, "_original", lambda host, *a, **k: [self.RESULTS[0]])
        monkeypatch.setattr(settings, "VTO_PREFER_IPV4", True)
        assert network._prefer_ipv4("huggingface.co", 443) == [self.RESULTS[0]]
