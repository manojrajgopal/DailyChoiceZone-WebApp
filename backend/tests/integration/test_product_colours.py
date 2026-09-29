"""
Photographs per colour, and uploading them.

A colour can carry its own images. The storefront shows them when that colour
is chosen, an order keeps the photograph of the colour bought, and replacing
one set of images never disturbs the other.
"""

from __future__ import annotations

import io

import pytest

pytestmark = pytest.mark.integration

RED = ["https://images.example.test/red-1.jpg", "https://images.example.test/red-2.jpg"]
BLUE = ["https://images.example.test/blue-1.jpg"]
SHARED = ["https://images.example.test/shared.jpg"]


def colours(client, admin_auth, **payload):
    return client.put("/api/products/PRD001", headers=admin_auth, json=payload)


def read(client):
    return client.get("/api/products/PRD001").json()["data"]


class TestColourImages:
    def test_each_colour_keeps_its_own_images(self, client, admin_auth, catalogue):
        response = colours(
            client,
            admin_auth,
            colors=[
                {"name": "Red", "hex": "#cc0000", "images": RED},
                {"name": "Blue", "hex": "#0033cc", "images": BLUE},
            ],
        )
        assert response.status_code == 200, response.text

        product = read(client)
        by_name = {colour["name"]: colour for colour in product["colors"]}
        assert by_name["Red"]["images"] == RED
        assert by_name["Blue"]["images"] == BLUE
        # No shared images: `images` falls back to the first colour's, so a
        # card or a wishlist row still has a picture.
        assert product["images"] == RED

    def test_shared_images_are_kept_apart_from_colour_images(self, client, admin_auth, catalogue):
        colours(client, admin_auth, colors=[{"name": "Red", "images": RED}])
        colours(client, admin_auth, images=SHARED)

        product = read(client)
        assert product["images"] == SHARED
        assert product["colors"][0]["images"] == RED

    def test_replacing_the_colours_replaces_their_images(self, client, admin_auth, catalogue):
        colours(client, admin_auth, images=SHARED, colors=[{"name": "Red", "images": RED}])
        colours(client, admin_auth, colors=[{"name": "Blue", "images": BLUE}])

        product = read(client)
        assert [colour["name"] for colour in product["colors"]] == ["Blue"]
        assert product["colors"][0]["images"] == BLUE
        assert product["images"] == SHARED

    def test_an_image_must_be_a_web_address_or_an_upload(self, client, admin_auth, catalogue):
        response = colours(
            client, admin_auth, colors=[{"name": "Red", "images": ["javascript:alert(1)"]}]
        )
        assert response.status_code == 422

    def test_the_order_keeps_the_photograph_of_the_colour_bought(
        self, client, admin_auth, auth, catalogue, settings_documents
    ):
        colours(
            client,
            admin_auth,
            colors=[{"name": "Red", "images": RED}, {"name": "Blue", "images": BLUE}],
        )
        client.post(
            "/api/cart/items",
            headers=auth,
            json={"productId": "PRD001", "quantity": 1, "color": "Blue"},
        )
        placed = client.post(
            "/api/orders",
            headers=auth,
            json={
                "shippingAddress": {
                    "fullName": "Asha Rao", "phone": "9876500001", "line1": "4 Brigade Road",
                    "line2": "", "city": "Bengaluru", "state": "Karnataka",
                    "pincode": "560001", "country": "India", "email": "shopper@example.com",
                },
                "deliveryMethod": "standard",
                "paymentMethod": "cod",
                "email": "shopper@example.com",
            },
        )
        assert placed.status_code == 201, placed.text
        line = placed.json()["data"]["order"]["items"][0]
        assert line["color"] == "Blue"
        assert line["image"] == BLUE[0]


def png_bytes(size=(40, 30)) -> bytes:
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", size, (200, 40, 40)).save(out, format="PNG")
    return out.getvalue()


class FakeBucket:
    """Stands in for the S3 client: records what would have been stored."""

    def __init__(self):
        self.objects = {}

    def put_object(self, *, Bucket, Key, Body, ContentType, CacheControl):
        self.objects[Key] = {"bucket": Bucket, "body": Body, "type": ContentType}


@pytest.fixture()
def bucket(monkeypatch):
    from app.core.config import settings
    from app.services import storage

    monkeypatch.setattr(settings, "AWS_ACCESS_KEY_ID", "AKIATEST")
    monkeypatch.setattr(settings, "AWS_SECRET_ACCESS_KEY", "secret")
    monkeypatch.setattr(settings, "AWS_S3_BUCKET", "dcz-media")
    monkeypatch.setattr(settings, "AWS_REGION", "ap-south-1")
    monkeypatch.setattr(settings, "AWS_S3_PUBLIC_URL", "")
    monkeypatch.setattr(settings, "AWS_S3_ENDPOINT_URL", "")
    fake = FakeBucket()
    monkeypatch.setattr(storage, "_client", lambda *args: fake)
    return fake


@pytest.fixture()
def no_bucket(monkeypatch):
    from app.core.config import settings

    for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_S3_BUCKET"):
        monkeypatch.setattr(settings, name, "")


class TestUploads:
    def test_without_credentials_uploading_is_off(self, client, admin_auth, no_bucket):
        config = client.get("/api/admin/uploads/config", headers=admin_auth)
        assert config.json()["data"]["enabled"] is False

        response = client.post(
            "/api/admin/uploads/images",
            headers=admin_auth,
            files={"file": ("photo.png", png_bytes(), "image/png")},
        )
        assert response.status_code == 503
        assert response.json()["error_code"] == "UPLOADS_DISABLED"

    def test_with_credentials_the_photo_goes_to_the_bucket(self, client, admin_auth, bucket, tmp_path, monkeypatch):
        from PIL import Image

        monkeypatch.chdir(tmp_path)  # anything written locally would land here
        assert client.get("/api/admin/uploads/config", headers=admin_auth).json()["data"]["enabled"]

        response = client.post(
            "/api/admin/uploads/images",
            headers=admin_auth,
            files={"file": ("photo.png", png_bytes(), "image/png")},
        )
        assert response.status_code == 201, response.text
        url = response.json()["data"]["url"]

        [(key, stored)] = bucket.objects.items()
        assert key.startswith("products/") and key.endswith(".webp")
        assert url == f"https://dcz-media.s3.ap-south-1.amazonaws.com/{key}"
        assert stored["type"] == "image/webp"
        with Image.open(io.BytesIO(stored["body"])) as image:
            assert image.format == "WEBP" and image.size == (40, 30)
        # Nothing on this server's disk.
        assert not list(tmp_path.rglob("*"))

    def test_a_public_address_can_be_configured(self, client, admin_auth, bucket, monkeypatch):
        from app.core.config import settings

        monkeypatch.setattr(settings, "AWS_S3_PUBLIC_URL", "https://media.example.test/")
        response = client.post(
            "/api/admin/uploads/images",
            headers=admin_auth,
            files={"file": ("photo.png", png_bytes(), "image/png")},
        )
        assert response.json()["data"]["url"].startswith("https://media.example.test/products/")

    def test_a_file_that_is_not_an_image_is_refused(self, client, admin_auth, bucket):
        response = client.post(
            "/api/admin/uploads/images",
            headers=admin_auth,
            # A script with an image's name and type is still a script.
            files={"file": ("photo.png", b"<script>alert(1)</script>", "image/png")},
        )
        assert response.status_code == 422
        assert not bucket.objects

    def test_only_administrators_may_upload(self, client, auth, bucket):
        anonymous = client.post(
            "/api/admin/uploads/images", files={"file": ("a.png", png_bytes(), "image/png")}
        )
        customer = client.post(
            "/api/admin/uploads/images",
            headers=auth,
            files={"file": ("a.png", png_bytes(), "image/png")},
        )
        assert anonymous.status_code == 401
        assert customer.status_code in (401, 403)
        assert not bucket.objects
