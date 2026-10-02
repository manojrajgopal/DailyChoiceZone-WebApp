"""
Uploaded files: product photographs and support-ticket attachments.

`test_product_colours.py` covers the basic photo upload (on/off, stored in the
bucket, a non-image refused, customers refused). This file covers the edges:
empty, oversized and unsupported files, metadata stripping, resizing, random
names, storage failures, and the attachment validator, which decides by file
contents what a support ticket may carry.

The bucket is a fake that records what it was given. Nothing reaches S3.
"""

from __future__ import annotations

import io

import pytest
from PIL import Image

from app.api.routes.admin import uploads
from app.core.config import settings
from app.core.errors import ValidationError
from app.services import storage
from app.services.support import attachments

pytestmark = pytest.mark.integration

URL = "/api/admin/uploads/images"


def image_bytes(fmt="PNG", size=(40, 30), mode="RGB", exif=False) -> bytes:
    buffer = io.BytesIO()
    image = Image.new(mode, size, "red" if mode != "L" else 128)
    kwargs = {}
    if exif:
        data = Image.Exif()
        data[0x010F] = "SecretCamera"  # Make
        kwargs["exif"] = data
    image.save(buffer, format=fmt, **kwargs)
    return buffer.getvalue()


class Bucket:
    def __init__(self):
        self.files = []
        self.fail = False

    def put_object(self, **kwargs):
        if self.fail:
            raise RuntimeError("SlowDown")
        self.files.append(kwargs)

    def generate_presigned_url(self, operation, Params, ExpiresIn):
        return f"https://signed.test/{Params['Key']}?exp={ExpiresIn}"


@pytest.fixture()
def bucket(monkeypatch):
    for key, value in {"AWS_ACCESS_KEY_ID": "AKIA", "AWS_SECRET_ACCESS_KEY": "s", "AWS_S3_BUCKET": "dcz",
                       "AWS_S3_PREFIX": "products", "AWS_S3_PUBLIC_URL": "", "AWS_S3_ENDPOINT_URL": ""}.items():
        monkeypatch.setattr(settings, key, value)
    fake = Bucket()
    monkeypatch.setattr(storage, "_client", lambda *a: fake)
    return fake


def _upload(client, headers, data, name="photo.png", content_type="image/png"):
    return client.post(URL, headers=headers, files={"file": (name, data, content_type)})


class TestProductPhotoUpload:
    def test_success_reencodes_to_webp_under_a_random_name(self, client, admin_auth, bucket):
        response = _upload(client, admin_auth, image_bytes("PNG"), name="../../etc/passwd.png")
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["message"] == "Photo uploaded."
        stored = bucket.files[0]
        assert stored["ContentType"] == "image/webp"
        assert stored["Key"].startswith("products/") and stored["Key"].endswith(".webp")
        assert "passwd" not in stored["Key"] and ".." not in stored["Key"]
        assert len(stored["Key"].split("/")[-1]) == 32 + len(".webp")
        assert body["data"]["url"].endswith(stored["Key"])
        assert Image.open(io.BytesIO(stored["Body"])).format == "WEBP"

    def test_two_uploads_of_the_same_file_get_different_names(self, client, admin_auth, bucket):
        data = image_bytes()
        _upload(client, admin_auth, data)
        _upload(client, admin_auth, data)
        assert bucket.files[0]["Key"] != bucket.files[1]["Key"]

    @pytest.mark.parametrize("fmt, mode", [("JPEG", "RGB"), ("PNG", "RGBA"), ("GIF", "P"), ("WEBP", "RGB"),
                                           ("PNG", "L")])
    def test_each_accepted_format(self, client, admin_auth, bucket, fmt, mode):
        assert _upload(client, admin_auth, image_bytes(fmt, mode=mode)).status_code == 201

    def test_metadata_is_stripped(self, client, admin_auth, bucket):
        data = image_bytes("JPEG", exif=True)
        assert b"SecretCamera" in data
        assert _upload(client, admin_auth, data, "p.jpg", "image/jpeg").status_code == 201
        assert b"SecretCamera" not in bucket.files[0]["Body"]

    def test_large_photos_are_scaled_down(self, client, admin_auth, bucket):
        assert _upload(client, admin_auth, image_bytes("PNG", size=(3000, 1500))).status_code == 201
        stored = Image.open(io.BytesIO(bucket.files[0]["Body"]))
        assert max(stored.size) == uploads.MAX_EDGE
        assert stored.size == (2400, 1200)  # aspect ratio kept

    def test_empty_file(self, client, admin_auth, bucket):
        response = _upload(client, admin_auth, b"")
        assert response.status_code == 422
        assert response.json()["error_code"] == "IMAGE_INVALID"

    def test_file_over_the_limit_is_refused_before_decoding(self, client, admin_auth, bucket, monkeypatch):
        monkeypatch.setattr(uploads, "MAX_BYTES", 100)
        response = _upload(client, admin_auth, image_bytes(size=(200, 200)))
        assert response.status_code == 422
        assert response.json()["error_code"] == "IMAGE_TOO_LARGE"
        assert bucket.files == []

    def test_a_real_image_in_an_unsupported_format(self, client, admin_auth, bucket):
        response = _upload(client, admin_auth, image_bytes("BMP"), "a.bmp", "image/bmp")
        assert response.status_code == 422
        assert response.json()["error_code"] == "IMAGE_TYPE"

    def test_a_script_named_like_an_image(self, client, admin_auth, bucket):
        response = _upload(client, admin_auth, b"<script>alert(1)</script>", "x.png", "image/png")
        assert response.status_code == 422
        assert response.json()["error_code"] == "IMAGE_INVALID"

    def test_a_truncated_image(self, client, admin_auth, bucket):
        response = _upload(client, admin_auth, image_bytes("PNG", size=(300, 300))[:200])
        assert response.status_code == 422
        assert response.json()["error_code"] == "IMAGE_INVALID"

    def test_decompression_bomb_is_refused(self, client, admin_auth, bucket, monkeypatch):
        monkeypatch.setattr(uploads, "MAX_PIXELS", 100)
        # The route sets Pillow's global limit; have monkeypatch restore it afterwards.
        monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", Image.MAX_IMAGE_PIXELS)
        response = _upload(client, admin_auth, image_bytes(size=(200, 200)))
        assert response.status_code == 422
        assert bucket.files == []

    def test_missing_file_field(self, client, admin_auth, bucket):
        response = client.post(URL, headers=admin_auth)
        assert response.status_code == 422
        assert any(d["field"].endswith("file") for d in response.json()["details"])

    def test_storage_failure_is_a_502_and_says_nothing_of_the_bucket(self, client, admin_auth, bucket):
        bucket.fail = True
        response = _upload(client, admin_auth, image_bytes())
        assert response.status_code == 502
        assert response.json()["error_code"] == "UPLOAD_FAILED"
        assert "SlowDown" not in response.text

    def test_unconfigured_storage_refuses_before_reading(self, client, admin_auth, monkeypatch):
        monkeypatch.setattr(settings, "AWS_S3_BUCKET", "")
        response = _upload(client, admin_auth, image_bytes())
        assert response.status_code == 503
        assert response.json()["error_code"] == "UPLOADS_DISABLED"

    def test_an_editor_with_products_may_upload(self, client, editor, bucket):
        token = client.post("/api/admin/auth/login",
                            json={"email": editor.email, "password": "Admin@123"}).json()["data"]["token"]
        response = _upload(client, {"Authorization": f"Bearer {token['accessToken']}"}, image_bytes())
        assert response.status_code == 201

    def test_without_a_token(self, client, bucket):
        assert _upload(client, {}, image_bytes()).status_code == 401

    def test_config_reports_the_limit(self, client, admin_auth, bucket):
        data = client.get("/api/admin/uploads/config", headers=admin_auth).json()["data"]
        assert data == {"enabled": True, "maxBytes": uploads.MAX_BYTES}


# ---------------------------------------------------------------- attachments


PNG = image_bytes("PNG")
JPEG = image_bytes("JPEG", exif=True)
LIMITS = {"maxFiles": 3, "maxSizeMb": 1, "maxVideoSizeMb": 2}


class TestSniff:
    @pytest.mark.parametrize("data, name, kind", [
        (PNG, "x.bin", "image/png"),
        (JPEG, "x.bin", "image/jpeg"),
        (b"GIF89a" + b"\x00" * 10, "x", "image/gif"),
        (b"GIF87a" + b"\x00" * 10, "x", "image/gif"),
        (b"RIFF\x00\x00\x00\x00WEBPVP8 ", "x", "image/webp"),
        (b"%PDF-1.7\n", "x", "application/pdf"),
        (b"\x1a\x45\xdf\xa3rest", "x", "video/webm"),
        (b"\x00\x00\x00\x18ftypmp42", "x", "video/mp4"),
        (b"\x00\x00\x00\x14ftypqt  ", "x", "video/quicktime"),
        (b"hello, world", "notes.txt", "text/plain"),
        (b"hello", "server.LOG", "text/plain"),
        (b"a,b\n1,2", "data.csv", "text/csv"),
    ])
    def test_recognised_by_contents(self, data, name, kind):
        assert attachments.sniff(data, name) == kind

    @pytest.mark.parametrize("data, name", [
        (b"MZ\x90\x00 executable", "setup.exe"),
        (b"<svg onload='x'>", "a.svg"),
        (b"PK\x03\x04", "report.docx"),
        (b"text\x00with nul", "a.txt"),
        (b"\xff\xfe\xfa invalid utf8", "a.txt"),
        (b"plain text", "a.html"),
        (b"MZ...", "trojan.png"),  # the name does not make it an image
    ])
    def test_refused(self, data, name):
        assert attachments.sniff(data, name) is None


class TestCleanName:
    @pytest.mark.parametrize("raw, clean", [
        ("photo.png", "photo.png"),
        ("../../etc/passwd", "passwd"),
        ("C:\\Users\\me\\Desktop\\bill (1).pdf", "bill (1).pdf"),
        ("<script>.txt", "script.txt"),
        ("", "file"),
        (None, "file"),
        ("////", "file"),
    ])
    def test_cleaning(self, raw, clean):
        assert attachments.clean_name(raw) == clean

    def test_long_names_are_cut(self):
        assert len(attachments.clean_name("a" * 300 + ".txt")) == 120


class TestValidate:
    def test_nothing_attached_needs_no_storage(self, monkeypatch):
        monkeypatch.setattr(settings, "AWS_S3_BUCKET", "")
        assert attachments.validate([], LIMITS) == []

    def test_disabled_without_storage(self, monkeypatch):
        monkeypatch.setattr(settings, "AWS_S3_BUCKET", "")
        with pytest.raises(ValidationError) as caught:
            attachments.validate([("a.png", PNG)], LIMITS)
        assert caught.value.error_code == "ATTACHMENTS_DISABLED"

    def test_too_many_files(self, bucket):
        with pytest.raises(ValidationError) as caught:
            attachments.validate([("a.png", PNG)] * 4, LIMITS)
        assert caught.value.error_code == "TOO_MANY_FILES"

    def test_default_file_limit_is_five(self, bucket):
        assert len(attachments.validate([("a.txt", b"x")] * 5, {})) == 5
        with pytest.raises(ValidationError):
            attachments.validate([("a.txt", b"x")] * 6, {})

    def test_empty_file(self, bucket):
        with pytest.raises(ValidationError) as caught:
            attachments.validate([("a.png", b"")], LIMITS)
        assert caught.value.error_code == "EMPTY_FILE"

    def test_unsupported_type(self, bucket):
        with pytest.raises(ValidationError) as caught:
            attachments.validate([("setup.exe", b"MZ")], LIMITS)
        assert caught.value.error_code == "FILE_TYPE"

    def test_size_limits_differ_for_video(self, bucket):
        big = b"%PDF-" + b"0" * (1024 * 1024)
        with pytest.raises(ValidationError) as caught:
            attachments.validate([("a.pdf", big)], LIMITS)
        assert caught.value.error_code == "FILE_TOO_LARGE"
        video = b"\x00\x00\x00\x18ftypmp42" + b"0" * (1024 * 1024)
        assert attachments.validate([("v.mp4", video)], LIMITS)[0][2] == "video/mp4"

    def test_photos_are_reencoded_without_metadata(self, bucket):
        (name, data, kind), = attachments.validate([("photo.jpg", JPEG)], LIMITS)
        assert kind == "image/jpeg" and b"SecretCamera" not in data

    def test_rgba_png_and_jpeg_conversion(self, bucket):
        rgba = image_bytes("PNG", mode="RGBA")
        assert attachments.validate([("a.png", rgba)], LIMITS)[0][2] == "image/png"
        cmyk = image_bytes("JPEG", mode="CMYK")
        assert attachments.validate([("a.jpg", cmyk)], LIMITS)[0][2] == "image/jpeg"

    def test_an_image_header_on_garbage_is_refused(self, bucket):
        with pytest.raises(ValidationError) as caught:
            attachments.validate([("a.png", b"\x89PNG\r\n\x1a\n" + b"garbage")], LIMITS)
        assert caught.value.error_code == "FILE_TYPE"

    def test_one_bad_file_refuses_the_lot(self, bucket):
        with pytest.raises(ValidationError):
            attachments.validate([("a.txt", b"ok"), ("b.exe", b"MZ")], LIMITS)


class TestStoreAndLink:
    def test_store_writes_privately_under_the_ticket(self, bucket):
        checked = attachments.validate([("notes.txt", b"hello"), ("p.png", PNG)], LIMITS)
        rows = attachments.store("TKT001", checked, message_id=7, uploaded_by="customer", internal=False)
        assert [f["Key"].split("/")[1] for f in bucket.files] == ["TKT001", "TKT001"]
        assert bucket.files[0]["Key"].endswith(".txt") and bucket.files[1]["Key"].endswith(".png")
        assert all(f["CacheControl"] == "private, no-store" for f in bucket.files)
        assert rows[0].file_name == "notes.txt" and rows[0].size == 5 and rows[0].message_id == 7
        assert rows[0].storage_key == bucket.files[0]["Key"]

    @pytest.mark.parametrize("kind, inline", [("image/png", True), ("video/mp4", True), ("application/pdf", True),
                                              ("text/plain", False), ("text/csv", False)])
    def test_link_is_signed_and_inline_only_for_viewable_types(self, bucket, monkeypatch, kind, inline):
        seen = {}
        monkeypatch.setattr(storage, "signed_url", lambda key, name, inline: seen.update(inline=inline) or "u")
        from app.models import TicketAttachment

        attachments.link(TicketAttachment(storage_key="k", file_name="f", content_type=kind))
        assert seen["inline"] is inline

    def test_view_hides_the_storage_key(self):
        from datetime import datetime

        from app.models import TicketAttachment

        row = TicketAttachment(id=1, message_id=2, file_name="a.png", content_type="image/png", size=10,
                               storage_key="support/T/secret", internal=False, uploaded_by="agent",
                               created_at=datetime(2026, 1, 1))
        view = attachments.view(row)
        assert view["isImage"] is True and view["name"] == "a.png"
        assert "secret" not in str(view)
