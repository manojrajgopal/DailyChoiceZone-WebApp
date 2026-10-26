"""
Shared set-up for the virtual try-on tests.

Nothing here reaches a provider, a bucket or the internet: the try-on runs on
the offline mock adapter (or a fake gradio client), product photos are served
by a stand-in for `images.fetch_garment`, S3 is an in-memory fake, and
ephemeral files go to the test's own temporary folder.
"""

from __future__ import annotations

import io
import uuid
from datetime import datetime, timedelta

import pytest
from PIL import Image

from app.core.config import settings


def photo_bytes(size=(600, 800), fmt="JPEG", color=(200, 160, 140)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, color).save(out, format=fmt)
    return out.getvalue()


GARMENT = photo_bytes((400, 400), color=(20, 60, 200))


class FakeBucket:
    """S3, in memory: put, get, delete and signed links — with switchable failures."""

    def __init__(self):
        self.objects = {}
        self.puts = []
        self.deleted = []
        self.fail_delete = False
        self.fail_put = False

    def put_object(self, **kwargs):
        if self.fail_put:
            raise RuntimeError("bucket refused the write")
        self.puts.append(kwargs)
        self.objects[kwargs["Key"]] = kwargs["Body"]

    def get_object(self, **kwargs):
        if kwargs["Key"] not in self.objects:
            error = RuntimeError("missing")
            error.response = {"Error": {"Code": "NoSuchKey"}}
            raise error
        return {"Body": io.BytesIO(self.objects[kwargs["Key"]])}

    def delete_object(self, **kwargs):
        if self.fail_delete:
            raise RuntimeError("bucket refused the delete")
        self.deleted.append(kwargs["Key"])
        self.objects.pop(kwargs["Key"], None)

    def generate_presigned_url(self, method, Params, ExpiresIn):  # noqa: N803 — boto3's names
        return f"https://signed.example/{Params['Key']}?X-Amz-Signature=abc&X-Amz-Expires={ExpiresIn}"


@pytest.fixture()
def ephemeral(monkeypatch, tmp_path):
    """No S3: the ephemeral backend, in this test's folder."""
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_S3_BUCKET", "VTO_S3_BUCKET"):
        monkeypatch.setattr(settings, key, "")
    monkeypatch.setattr(settings, "AWS_USE_DEFAULT_CREDENTIALS", False)
    monkeypatch.setattr(settings, "VTO_STORAGE", "auto")
    monkeypatch.setattr(settings, "VTO_TEMP_DIR", str(tmp_path / "vto"))
    return tmp_path / "vto"


@pytest.fixture()
def s3(monkeypatch, tmp_path):
    from app.services import storage

    for key, value in {"AWS_ACCESS_KEY_ID": "AKIA", "AWS_SECRET_ACCESS_KEY": "s", "AWS_S3_BUCKET": "dcz",
                       "AWS_S3_PREFIX": "products", "VTO_S3_BUCKET": "", "VTO_S3_PREFIX": "try-on",
                       "VTO_STORAGE": "auto", "VTO_S3_SSE": "AES256", "VTO_TEMP_DIR": str(tmp_path / "vto")}.items():
        monkeypatch.setattr(settings, key, value)
    fake = FakeBucket()
    monkeypatch.setattr(storage, "_client", lambda *a: fake)
    return fake


@pytest.fixture()
def garments(monkeypatch):
    """Product photos without the internet."""
    from app.services.try_on import images

    fetched = []

    def fetch(url, timeout=20.0):
        fetched.append(url)
        return images.normalise(GARMENT, max_bytes=images.GARMENT_MAX_BYTES).data

    monkeypatch.setattr(images, "fetch_garment", fetch)
    return fetched


@pytest.fixture()
def vto(db, catalogue, garments, monkeypatch):
    """
    The defaults, plus an offline provider and model that run upper-body
    try-ons, the Women category mapped to it, and photos on its products.
    """
    from app.models import ProductImage, VtoCategoryMapping, VtoModel, VtoProvider
    from app.services.try_on import defaults

    monkeypatch.setattr(settings, "VTO_ALLOW_MOCK_PROVIDER", True)
    defaults.ensure(db)
    now = datetime.utcnow()
    db.add(VtoProvider(id="VPR900", kind="mock", name="Offline", enabled=True, timeout_seconds=30, max_retries=2,
                       cooldown_seconds=600, health="unknown", health_detail="", config={}, created_at=now,
                       updated_at=now))
    db.flush()
    db.add(VtoModel(id="VMD900", provider_id="VPR900", name="Mock overlay", description="", adapter_key="mock.overlay",
                    config={}, capabilities=["garment.upper_body"], quality_tier="standard", enabled=True,
                    verified=True, priority=1, avg_seconds=5, cost_per_call=0.01, cost_currency="USD",
                    created_at=now, updated_at=now))
    db.add(VtoCategoryMapping(category_id="CAT001", subcategory="", capability_key="garment.upper_body",
                              enabled=True, created_at=now, updated_at=now))
    for product_id in ("PRD001", "PRD002", "PRD003"):
        db.add(ProductImage(product_id=product_id, url=f"https://images.example.com/{product_id}.jpg", position=0,
                            color=""))
    db.commit()
    return db


def make_plan(db, plan_id="MBP900", **rules):
    from app.models import MembershipPlan

    now = datetime.utcnow()
    try_on = {"enabled": True, "perPeriod": 3, "concurrent": 1, "retention": "permanent", "retentionDays": 7,
              "download": True, "retriesPerRequest": 2, **rules}
    plan = MembershipPlan(id=plan_id, name="Prime", description="", duration_months=12, price=999,
                          free_delivery=True, member_discount_percent=0, extra_return_days=0, early_access=False,
                          priority_support=False, badge="", active=True, sort_order=0, try_on=try_on,
                          created_at=now, updated_at=now)
    db.add(plan)
    db.flush()
    return plan


def make_member(db, customer_id="CUS001", plan_id="MBP900", membership_id="MEM900", *, snapshot=True):
    from app.models import CustomerMembership, MembershipPlan
    from app.services import membership

    plan = db.get(MembershipPlan, plan_id)
    now = datetime.utcnow().replace(microsecond=0)
    benefits = membership.benefits_of(plan)
    if not snapshot:
        benefits.pop("tryOn", None)
    row = CustomerMembership(id=membership_id, customer_id=customer_id, plan_id=plan_id, plan_name=plan.name,
                             duration_months=12, status="active", starts_at=now - timedelta(days=1),
                             ends_at=now + timedelta(days=300), amount=99900, currency="INR", benefits=benefits,
                             paid_at=now, created_at=now, updated_at=now)
    db.add(row)
    db.commit()
    return row


def upload(client, headers, data=None, **form):
    return client.post("/api/try-on/photos", headers=headers,
                       files={"file": ("me.jpg", data or photo_bytes(), "image/jpeg")},
                       data={k: str(v).lower() if isinstance(v, bool) else v for k, v in form.items()})


def start(client, headers, photo_id, product_id="PRD002", key=None, **extra):
    return client.post("/api/try-on/requests",
                       headers={**headers, "Idempotency-Key": key or uuid.uuid4().hex},
                       json={"productId": product_id, "photoId": photo_id, **extra})


def run_queue(db):
    from app.services.try_on import worker

    return worker.drain(db)
