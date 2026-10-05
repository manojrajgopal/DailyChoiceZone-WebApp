"""
Shipping labels through the API: our own PDF for any shipment, generated
once (idempotent), regenerated with a reason (the old version superseded),
validated with clear messages, recorded when it fails, cancelled with its
shipment, bulk generation with mixed results, bulk download (ZIP and merged
PDF), the shipments list's label column, and who may do what.

Nothing reaches a courier: Shiprocket is `FakeShiprocket` on a mock transport.
"""

from __future__ import annotations

import io
import re
import zipfile

import pytest
from sqlalchemy import select

from app.models import Order
from app.models.fulfilment import ShippingLabel
from app.models.monitoring import AuditLog
from app.models.shipping import Shipment
from tests.integration.test_packing_helpers import BOX, job_for, packed, packing_order  # noqa: F401
from tests.integration.test_shipping_helpers import (  # noqa: F401
    created,
    manual_on,
    order,
    packed_order,
    place_order,
    shiprocket,
    shiprocket_on,
)
from tests.integration.test_suppliers_helpers import role_headers

pytestmark = pytest.mark.integration

LABELS = "/api/admin/shipping-labels"


def pages(pdf: bytes) -> int:
    return len(re.findall(rb"/Type\s*/Page(?!s)", pdf))


def generate(client, headers, shipment_id: int, expect: int = 201, **body):
    response = client.post(f"/api/admin/shipments/{shipment_id}/labels", headers=headers, json=body or None)
    assert response.status_code == expect, response.text
    return response.json()


def legacy(client, auth, db) -> dict:
    """
    An order moved to "shipped" by hand before packing and shipments were
    enforced: no packing job, no shipment. Its missing shipment can still be
    recorded, and that is the one kind of shipment with no packed packages.
    """
    from app.models import Order

    placed = place_order(client, auth)
    db.get(Order, placed["id"]).status = "shipped"
    db.flush()
    return placed


@pytest.fixture()
def legacy_order(client, auth, db, catalogue, settings_documents) -> dict:
    return legacy(client, auth, db)


@pytest.fixture()
def shipment(client, admin_auth, order, manual_on) -> dict:
    return created(client, admin_auth, order["id"])


class TestGenerating:
    def test_generate_preview_download(self, client, admin_auth, shipment):
        data = generate(client, admin_auth, shipment["id"])["data"]
        label = data["current"]
        assert data["status"] == "generated" and label["version"] == 1 and label["format"] == "thermal-4x6"
        assert label["pageCount"] == 1 and label["printable"] is True and label["generatedBy"] == "ADM001"
        preview = client.get(f"{LABELS}/{label['id']}/preview", headers=admin_auth)
        assert preview.status_code == 200 and preview.headers["content-type"] == "application/pdf"
        assert preview.content.startswith(b"%PDF") and pages(preview.content) == 1
        assert preview.headers["content-disposition"] == 'inline; filename="label-LX-100200-v1.pdf"'
        download = client.get(f"{LABELS}/{label['id']}/download", headers=admin_auth)
        assert download.headers["content-disposition"].startswith("attachment;")
        # Drawn from the snapshot: the same bytes every time.
        assert download.content == preview.content

    def test_generating_again_is_idempotent(self, client, admin_auth, shipment, db):
        first = generate(client, admin_auth, shipment["id"])["data"]["current"]
        again = generate(client, admin_auth, shipment["id"], expect=200)
        assert again["data"]["current"]["id"] == first["id"]
        assert again["message"] == "The label was already generated."
        assert len(db.execute(select(ShippingLabel)).scalars().all()) == 1

    def test_formats(self, client, admin_auth, shipment):
        label = generate(client, admin_auth, shipment["id"], format="a4")["data"]["current"]
        assert label["format"] == "a4" and label["formatName"].startswith("A4")
        bad = client.post(f"/api/admin/shipments/{shipment['id']}/labels/regenerate", headers=admin_auth,
                          json={"reason": "Bigger", "format": "poster"})
        assert bad.status_code == 422 and bad.json()["error_code"] == "INVALID_FORMAT"

    def test_the_snapshot_is_frozen(self, client, admin_auth, shipment, db):
        label = generate(client, admin_auth, shipment["id"])["data"]["current"]
        before = client.get(f"{LABELS}/{label['id']}/preview", headers=admin_auth).content
        row = db.get(Shipment, shipment["id"])
        row.destination = {**row.destination, "line1": "Somewhere else entirely"}
        db.flush()
        after = client.get(f"{LABELS}/{label['id']}/preview", headers=admin_auth).content
        assert after == before
        assert db.get(ShippingLabel, label["id"]).snapshot["buyer"]["line1"] == "4 Brigade Road"

    def test_one_page_per_package(self, client, admin_auth, packing_order, manual_on):
        job = job_for(client, admin_auth, packing_order["id"])
        kurta = next(line for line in job["lines"] if line["sku"] == "DCZ-WO0001")
        packed(client, admin_auth, job, [{**BOX, "items": [{"lineId": kurta["id"], "quantity": 1}]},
                                         {**BOX, "items": [{"lineId": kurta["id"], "quantity": 1}]}, dict(BOX)])
        shipment = created(client, admin_auth, packing_order["id"], package=None)
        assert shipment["package"]["count"] == 3
        label = generate(client, admin_auth, shipment["id"])["data"]["current"]
        assert label["pageCount"] == 3
        pdf = client.get(f"{LABELS}/{label['id']}/preview", headers=admin_auth).content
        assert pages(pdf) == 3

    def test_an_unpacked_multi_box_shipment_gets_a_page_per_box(self, client, admin_auth, legacy_order, manual_on):
        shipment = created(client, admin_auth, legacy_order["id"], package={**BOX, "count": 2})
        label = generate(client, admin_auth, shipment["id"])["data"]["current"]
        assert label["pageCount"] == 2


class TestRegenerating:
    def test_regenerate_needs_a_reason_and_supersedes(self, client, admin_auth, shipment, db):
        first = generate(client, admin_auth, shipment["id"])["data"]["current"]
        no_reason = client.post(f"/api/admin/shipments/{shipment['id']}/labels/regenerate", headers=admin_auth,
                                json={})
        assert no_reason.status_code == 422 and no_reason.json()["error_code"] == "REASON_REQUIRED"
        response = client.post(f"/api/admin/shipments/{shipment['id']}/labels/regenerate", headers=admin_auth,
                               json={"reason": "Printer jammed"})
        assert response.status_code == 201, response.text
        data = response.json()["data"]
        assert data["current"]["version"] == 2 and data["current"]["reason"] == "Printer jammed"
        assert [(h["version"], h["status"]) for h in data["history"]] == [(2, "generated"), (1, "regenerated")]
        # The old version still prints, stamped as superseded.
        old = client.get(f"{LABELS}/{first['id']}/preview", headers=admin_auth)
        assert old.status_code == 200 and old.content.startswith(b"%PDF")
        assert db.execute(select(AuditLog).where(AuditLog.action == "label.regenerate")).scalars().first()

    def test_cancel_a_label(self, client, admin_auth, shipment):
        none = client.post(f"/api/admin/shipments/{shipment['id']}/labels/cancel", headers=admin_auth, json={})
        assert none.status_code == 409 and none.json()["error_code"] == "NO_LABEL"
        generate(client, admin_auth, shipment["id"])
        data = client.post(f"/api/admin/shipments/{shipment['id']}/labels/cancel", headers=admin_auth,
                           json={"reason": "Wrong box"}).json()["data"]
        assert data["current"] is None and data["history"][0]["status"] == "cancelled"
        # A new one can be made afterwards.
        assert generate(client, admin_auth, shipment["id"])["data"]["current"]["version"] == 2


class TestValidation:
    def test_missing_dimensions_is_recorded_as_a_failure(self, client, admin_auth, legacy_order, manual_on, db):
        shipment = created(client, admin_auth, legacy_order["id"], package={"weightGrams": 500})
        response = client.post(f"/api/admin/shipments/{shipment['id']}/labels", headers=admin_auth)
        assert response.status_code == 422
        body = response.json()
        assert body["error_code"] == "DIMENSIONS_MISSING"
        assert body["message"] == "Enter the package's length, width and height."
        overview = client.get(f"/api/admin/shipments/{shipment['id']}/labels", headers=admin_auth).json()["data"]
        assert overview["status"] == "failed" and overview["canGenerate"] is False
        assert overview["history"][0]["errorCode"] == "DIMENSIONS_MISSING"
        assert overview["history"][0]["printable"] is False
        unprintable = client.get(f"{LABELS}/{overview['history'][0]['id']}/preview", headers=admin_auth)
        assert unprintable.status_code == 409
        summary = client.get("/api/admin/packing/summary", headers=admin_auth).json()["data"]
        assert summary["labelFailures"] == 1

    def test_address_phone_pincode_and_sku(self, client, admin_auth, shipment, db):
        row = db.get(Shipment, shipment["id"])
        row.destination = {**row.destination, "phone": "", "pincode": "1234", "city": ""}
        order_row = db.get(Order, row.order_id)
        order_row.items[0].sku = ""
        db.flush()
        response = client.post(f"/api/admin/shipments/{shipment['id']}/labels", headers=admin_auth)
        assert response.status_code == 422
        codes = [p["code"] for p in response.json()["details"]["problems"]]
        assert codes == ["ADDRESS_INCOMPLETE", "PINCODE_MISSING", "PHONE_MISSING", "SKU_MISSING"]

    def test_a_courier_shipment_without_its_awb(self, client, admin_auth, order, shiprocket_on, shiprocket):
        import httpx

        shiprocket.answer("POST /orders/create/adhoc", httpx.Response(422, json={"message": "Bad address"}))
        shipment = created(client, admin_auth, order["id"], provider="shiprocket")
        response = client.post(f"/api/admin/shipments/{shipment['id']}/labels", headers=admin_auth)
        assert response.status_code == 422 and response.json()["error_code"] == "AWB_REQUIRED"
        assert "hasn't assigned an AWB" in response.json()["message"]

    def test_the_courier_label_link_is_kept(self, client, admin_auth, order, shiprocket_on):
        shipment = created(client, admin_auth, order["id"], provider="shiprocket")
        courier = client.post(f"/api/admin/shipments/{shipment['id']}/label", headers=admin_auth)
        assert courier.status_code == 200, courier.text
        label = generate(client, admin_auth, shipment["id"])["data"]["current"]
        assert label["externalUrl"] == "https://labels.example.com/l.pdf"
        assert label["providerReference"] == "9871"

    def test_a_cancelled_shipment_cancels_its_label(self, client, admin_auth, shipment):
        generate(client, admin_auth, shipment["id"])
        client.post(f"/api/admin/shipments/{shipment['id']}/cancel", headers=admin_auth, json={"reason": "No"})
        data = client.get(f"/api/admin/shipments/{shipment['id']}/labels", headers=admin_auth).json()["data"]
        assert data["current"] is None and data["history"][0]["status"] == "cancelled"
        refused = client.post(f"/api/admin/shipments/{shipment['id']}/labels", headers=admin_auth)
        assert refused.status_code == 422 and refused.json()["error_code"] == "SHIPMENT_CANCELLED"

    def test_unknown_shipment_and_label(self, client, admin_auth, catalogue):
        assert client.post("/api/admin/shipments/99999/labels", headers=admin_auth).status_code == 404
        assert client.get(f"{LABELS}/99999/preview", headers=admin_auth).status_code == 404


class TestBulk:
    def test_mixed_results_never_fail_the_batch(self, client, auth, admin_auth, order, manual_on, db):
        good = created(client, admin_auth, order["id"])
        other = legacy(client, auth, db)
        bad = created(client, admin_auth, other["id"], key="key-00000002", awb="LX-100201",
                      package={"weightGrams": 300})
        response = client.post(f"{LABELS}/bulk", headers=admin_auth,
                               json={"shipmentIds": [good["id"], bad["id"], 99999, good["id"]]})
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["succeeded"] == 1 and data["failed"] == 2
        by_id = {r["shipmentId"]: r for r in data["results"]}
        assert by_id[good["id"]]["ok"] is True
        assert by_id[bad["id"]]["error"]["code"] == "DIMENSIONS_MISSING"
        assert by_id[99999]["error"]["code"] == "SHIPMENT_NOT_FOUND"
        # Running it again changes nothing for the one that worked.
        again = client.post(f"{LABELS}/bulk", headers=admin_auth, json={"shipmentIds": [good["id"]]}).json()["data"]
        assert again["results"][0]["created"] is False

    def test_limits(self, client, admin_auth, catalogue):
        too_many = client.post(f"{LABELS}/bulk", headers=admin_auth, json={"shipmentIds": list(range(1, 102))})
        assert too_many.status_code == 422 and too_many.json()["error_code"] == "TOO_MANY"
        empty = client.post(f"{LABELS}/bulk", headers=admin_auth, json={"shipmentIds": []})
        assert empty.status_code == 422
        junk = client.post(f"{LABELS}/bulk", headers=admin_auth, json={"shipmentIds": ["x"]})
        assert junk.status_code == 422

    def test_zip_and_merged_download(self, client, auth, admin_auth, order, manual_on):
        first = created(client, admin_auth, order["id"])
        other = packed_order(client, auth, admin_auth)
        second = created(client, admin_auth, other["id"], key="key-00000002", awb="LX-100201")
        third = packed_order(client, auth, admin_auth)
        unlabelled = created(client, admin_auth, third["id"], key="key-00000003", awb="LX-100202")
        client.post(f"{LABELS}/bulk", headers=admin_auth, json={"shipmentIds": [first["id"], second["id"]]})
        ids = f"{first['id']},{second['id']},{unlabelled['id']}"
        response = client.get(f"{LABELS}/bulk-download?ids={ids}", headers=admin_auth)
        assert response.status_code == 200 and response.headers["content-type"] == "application/zip"
        assert response.headers["x-labels-skipped"] == str(unlabelled["id"])
        archive = zipfile.ZipFile(io.BytesIO(response.content))
        assert sorted(archive.namelist()) == ["label-LX-100200-v1.pdf", "label-LX-100201-v1.pdf",
                                              "not-included.txt"]
        assert archive.read("label-LX-100200-v1.pdf").startswith(b"%PDF")
        merged = client.get(f"{LABELS}/bulk-download?ids={ids}&mode=merged", headers=admin_auth)
        assert merged.headers["content-type"] == "application/pdf" and pages(merged.content) == 2
        none = client.get(f"{LABELS}/bulk-download?ids={unlabelled['id']}", headers=admin_auth)
        assert none.status_code == 409 and none.json()["error_code"] == "NO_LABELS"

    def test_the_shipments_list_shows_label_status(self, client, auth, admin_auth, order, manual_on):
        first = created(client, admin_auth, order["id"])
        other = packed_order(client, auth, admin_auth)
        created(client, admin_auth, other["id"], key="key-00000002", awb="LX-100201")
        generate(client, admin_auth, first["id"])
        items = client.get("/api/admin/shipments", headers=admin_auth).json()["data"]["items"]
        assert {i["id"]: i["labelStatus"] for i in items}[first["id"]] == "generated"
        assert sorted(i["labelStatus"] for i in items) == ["generated", "not-generated"]
        summary = client.get("/api/admin/packing/summary", headers=admin_auth).json()["data"]
        assert summary["labelsPending"] == 1 and summary["labelsGeneratedToday"] == 1


class TestPermissions:
    def test_who_may_make_labels(self, client, auth, admin_auth, shipment, db):
        label = generate(client, admin_auth, shipment["id"])["data"]["current"]
        editor = role_headers(db, "ADM060", "editor")
        for method, path in (("GET", f"/api/admin/shipments/{shipment['id']}/labels"),
                             ("POST", f"/api/admin/shipments/{shipment['id']}/labels"),
                             ("GET", f"{LABELS}/{label['id']}/preview"),
                             ("POST", f"{LABELS}/bulk"),
                             ("GET", f"{LABELS}/bulk-download?ids={shipment['id']}")):
            assert client.request(method, path, headers=editor, json={}).status_code == 403, path
            assert client.request(method, path, headers=auth, json={}).status_code in (401, 403), path
        staff = role_headers(db, "ADM061", "staff")
        assert client.get(f"{LABELS}/{label['id']}/preview", headers=staff).status_code == 200
