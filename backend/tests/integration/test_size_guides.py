"""
Size guides: the portal's validation, reuse across products, the product →
category → default chain, the match with a product's own sizes, and exact
unit conversion.
"""

from __future__ import annotations

from datetime import datetime

import pytest

pytestmark = pytest.mark.integration


def shirt_guide(**overrides):
    body = {
        "name": "Men's T-Shirt",
        "kind": "clothing",
        "unit": "cm",
        "description": "Body measurements.",
        "columns": [
            {"key": "chest", "label": "Chest", "type": "measurement"},
            {"key": "length", "label": "Length", "type": "measurement"},
        ],
        "rows": [
            {"size": "S", "values": {"chest": "86-91", "length": 68}},
            {"size": "M", "values": {"chest": {"min": 92, "max": 97}, "length": 70}},
            {"size": "L", "values": {"chest": "98–103", "length": 72.5}},
        ],
        "instructions": [{"title": "Chest", "body": "Around the fullest part.", "column": "chest"}],
        "notes": "Between sizes? Size up.",
    }
    body.update(overrides)
    return body


def create(client, admin_auth, **overrides):
    response = client.post("/api/admin/size-guides", headers=admin_auth, json=shirt_guide(**overrides))
    assert response.status_code == 201, response.text
    return response.json()["data"]


def public(client, pid="PRD001", **params):
    response = client.get(f"/api/products/{pid}/size-guide", params=params)
    assert response.status_code == 200, response.text
    return response.json()["data"]


@pytest.fixture()
def sized(db, catalogue):
    """PRD001 and PRD002 come in S, M, L; PRD001 also in XXL."""
    from app.models import ProductSize

    for pid, labels in (("PRD001", ["S", "M", "L", "XXL"]), ("PRD002", ["S", "M", "L"])):
        for n, label in enumerate(labels):
            db.add(ProductSize(product_id=pid, label=label, position=n))
    db.flush()


class TestCreating:
    def test_create_and_read(self, client, admin_auth):
        guide = create(client, admin_auth)
        assert guide["id"].startswith("SZG")
        assert guide["rows"][0]["values"]["chest"] == {"min": 86.0, "max": 91.0}
        assert guide["rows"][2]["values"]["length"] == {"min": 72.5}
        got = client.get(f"/api/admin/size-guides/{guide['id']}", headers=admin_auth).json()["data"]
        assert got["name"] == "Men's T-Shirt" and got["products"] == 0

    def test_footwear_and_ring_guides(self, client, admin_auth):
        shoes = create(client, admin_auth, name="Shoes", kind="footwear", columns=[
            {"key": "uk", "label": "UK", "type": "text"}, {"key": "eu", "label": "EU", "type": "text"},
            {"key": "foot", "label": "Foot length", "type": "measurement"}],
            rows=[{"size": "UK 7", "values": {"uk": "7", "eu": "41", "foot": 25.4}}], instructions=[])
        assert shoes["rows"][0]["values"]["eu"] == "41"
        rings = create(client, admin_auth, name="Rings", kind="ring", unit="mm", columns=[
            {"key": "circumference", "label": "Circumference", "type": "measurement"},
            {"key": "diameter", "label": "Diameter", "type": "measurement"}],
            rows=[{"size": "12", "values": {"circumference": 51.9, "diameter": 16.5}}], instructions=[])
        assert rings["unit"] == "mm"

    @pytest.mark.parametrize("bad, code", [
        ({"name": ""}, "SIZE_GUIDE_INVALID"),
        ({"unit": ""}, "SIZE_GUIDE_MISSING_UNIT"),
        ({"unit": "furlong"}, "SIZE_GUIDE_MISSING_UNIT"),
        ({"columns": []}, "SIZE_GUIDE_MISSING_COLUMNS"),
        ({"rows": []}, "SIZE_GUIDE_MISSING_ROWS"),
        ({"rows": [{"size": "M", "values": {"chest": 90, "length": 70}},
                   {"size": " m ", "values": {"chest": 92, "length": 71}}]}, "SIZE_GUIDE_DUPLICATE_SIZE"),
        ({"rows": [{"size": "M", "values": {"chest": 90}}]}, "SIZE_GUIDE_MISSING_VALUE"),
        ({"rows": [{"size": "M", "values": {"chest": "ninety", "length": 70}}]}, "SIZE_GUIDE_INVALID_VALUE"),
        ({"rows": [{"size": "M", "values": {"chest": -4, "length": 70}}]}, "SIZE_GUIDE_INVALID_VALUE"),
        ({"rows": [{"size": "M", "values": {"chest": 0, "length": 70}}]}, "SIZE_GUIDE_INVALID_VALUE"),
        ({"rows": [{"size": "M", "values": {"chest": "97-92", "length": 70}}]}, "SIZE_GUIDE_INVALID_VALUE"),
        ({"rows": [{"size": "M", "values": {"chest": 9200, "length": 70}}]}, "SIZE_GUIDE_INVALID_VALUE"),
        ({"rows": [{"size": "M", "values": {"chest": 92.123, "length": 70}}]}, "SIZE_GUIDE_INVALID_VALUE"),
        ({"rows": [{"size": "", "values": {"chest": 92, "length": 70}}]}, "SIZE_GUIDE_MISSING_SIZE"),
        ({"rows": [{"size": "M", "values": {"chest": 92, "length": 70, "hip": 99}}]}, "SIZE_GUIDE_INVALID"),
        ({"columns": [{"key": "chest", "label": "Chest"}, {"key": "chest2", "label": "chest"}]},
         "SIZE_GUIDE_DUPLICATE_COLUMN"),
        ({"columns": [{"key": "Bad Key!", "label": "Chest"}]}, "SIZE_GUIDE_INVALID"),
        ({"instructions": [{"title": "Hip", "body": "x", "column": "hip"}]}, "SIZE_GUIDE_INVALID"),
        ({"kind": "hats"}, "SIZE_GUIDE_INVALID"),
        ({"status": "maybe"}, "SIZE_GUIDE_INVALID"),
    ])
    def test_invalid_guides_are_refused(self, client, admin_auth, bad, code):
        response = client.post("/api/admin/size-guides", headers=admin_auth, json=shirt_guide(**bad))
        assert response.status_code == 422, response.text
        assert response.json()["error_code"] == code

    def test_an_optional_column_may_be_empty(self, client, admin_auth):
        guide = create(client, admin_auth, columns=[
            {"key": "chest", "label": "Chest", "type": "measurement"},
            {"key": "hip", "label": "Hip", "type": "measurement", "required": False}],
            rows=[{"size": "M", "values": {"chest": 92}}], instructions=[])
        assert guide["rows"][0]["values"] == {"chest": {"min": 92.0}}

    def test_names_are_unique(self, client, admin_auth):
        create(client, admin_auth)
        again = client.post("/api/admin/size-guides", headers=admin_auth, json=shirt_guide(name="men's t-shirt"))
        assert again.status_code == 409

    def test_only_one_default(self, client, admin_auth):
        first = create(client, admin_auth, name="A", isDefault=True)
        create(client, admin_auth, name="B", isDefault=True)
        assert client.get(f"/api/admin/size-guides/{first['id']}",
                          headers=admin_auth).json()["data"]["isDefault"] is False

    def test_update_keeps_what_is_not_sent(self, client, admin_auth):
        guide = create(client, admin_auth)
        response = client.put(f"/api/admin/size-guides/{guide['id']}", headers=admin_auth,
                              json={"status": "inactive"})
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["status"] == "inactive" and len(data["rows"]) == 3


class TestWhichGuide:
    def test_none_until_one_applies(self, client, sized):
        assert public(client) is None

    def test_the_category_guide(self, client, admin_auth, sized):
        guide = create(client, admin_auth)
        client.put(f"/api/admin/size-guides/{guide['id']}/categories", headers=admin_auth,
                   json={"categoryIds": ["CAT001"]})
        data = public(client)
        assert data["id"] == guide["id"] and data["source"] == "category"

    def test_the_product_guide_overrides_the_category(self, client, admin_auth, sized):
        category = create(client, admin_auth, name="Category guide")
        own = create(client, admin_auth, name="Kurta guide")
        client.put(f"/api/admin/size-guides/{category['id']}/categories", headers=admin_auth,
                   json={"categoryIds": ["CAT001"]})
        client.put("/api/admin/products/PRD001/size-guide", headers=admin_auth, json={"sizeGuideId": own["id"]})
        assert public(client)["id"] == own["id"] and public(client)["source"] == "product"
        assert public(client, "PRD002")["id"] == category["id"]

    def test_the_default_when_nothing_else(self, client, admin_auth, sized):
        guide = create(client, admin_auth, isDefault=True)
        assert public(client)["source"] == "default" and public(client)["id"] == guide["id"]

    def test_a_product_without_sizes_gets_no_default(self, client, admin_auth, catalogue):
        create(client, admin_auth, isDefault=True)
        assert public(client, "PRD003") is None

    def test_but_its_own_guide_is_shown(self, client, admin_auth, catalogue):
        guide = create(client, admin_auth, name="Ring sizes")
        client.put("/api/admin/products/PRD003/size-guide", headers=admin_auth, json={"sizeGuideId": guide["id"]})
        assert public(client, "PRD003")["id"] == guide["id"]

    def test_an_inactive_guide_falls_through(self, client, admin_auth, sized):
        own = create(client, admin_auth, name="Own")
        default = create(client, admin_auth, name="Default", isDefault=True)
        client.put("/api/admin/products/PRD001/size-guide", headers=admin_auth, json={"sizeGuideId": own["id"]})
        client.put(f"/api/admin/size-guides/{own['id']}", headers=admin_auth, json={"status": "inactive"})
        assert public(client)["id"] == default["id"]
        client.put(f"/api/admin/size-guides/{default['id']}", headers=admin_auth, json={"status": "inactive"})
        assert public(client) is None

    def test_a_deleted_guide_falls_through(self, client, admin_auth, sized):
        own = create(client, admin_auth, name="Own")
        category = create(client, admin_auth, name="Category")
        client.put("/api/admin/products/PRD001/size-guide", headers=admin_auth, json={"sizeGuideId": own["id"]})
        client.put(f"/api/admin/size-guides/{category['id']}/categories", headers=admin_auth,
                   json={"categoryIds": ["CAT001"]})
        response = client.delete(f"/api/admin/size-guides/{own['id']}", headers=admin_auth)
        assert response.json()["data"] == {"products": 1, "categories": 0}
        assert public(client)["id"] == category["id"]

    def test_clearing_a_products_guide(self, client, admin_auth, sized):
        own = create(client, admin_auth, name="Own")
        client.put("/api/admin/products/PRD001/size-guide", headers=admin_auth, json={"sizeGuideId": own["id"]})
        client.put("/api/admin/products/PRD001/size-guide", headers=admin_auth, json={"sizeGuideId": None})
        assert public(client) is None

    def test_a_draft_products_guide_is_not_public(self, client, admin_auth, catalogue):
        guide = create(client, admin_auth)
        client.put("/api/admin/products/PRD004/size-guide", headers=admin_auth, json={"sizeGuideId": guide["id"]})
        assert client.get("/api/products/PRD004/size-guide").status_code == 404


class TestReuse:
    def test_one_guide_many_products(self, client, admin_auth, sized):
        guide = create(client, admin_auth)
        response = client.put(f"/api/admin/size-guides/{guide['id']}/products", headers=admin_auth,
                              json={"productIds": ["PRD001", "PRD002"]})
        assert response.json()["data"]["products"] == 2
        assert public(client)["id"] == public(client, "PRD002")["id"] == guide["id"]
        client.put(f"/api/admin/size-guides/{guide['id']}/products", headers=admin_auth,
                   json={"productIds": ["PRD002"], "mode": "remove"})
        assert public(client, "PRD002") is None

    def test_a_category_moves_between_guides(self, client, admin_auth, sized):
        a = create(client, admin_auth, name="A")
        b = create(client, admin_auth, name="B")
        client.put(f"/api/admin/size-guides/{a['id']}/categories", headers=admin_auth, json={"categoryIds": ["CAT001"]})
        moved = client.put(f"/api/admin/size-guides/{b['id']}/categories", headers=admin_auth,
                           json={"categoryIds": ["CAT001"]}).json()["data"]
        assert moved["movedFromOtherGuides"] == 1
        assert public(client)["id"] == b["id"]

    def test_unknown_ids_are_refused(self, client, admin_auth, catalogue):
        guide = create(client, admin_auth)
        assert client.put(f"/api/admin/size-guides/{guide['id']}/products", headers=admin_auth,
                          json={"productIds": ["PRD777"]}).status_code == 422
        assert client.put(f"/api/admin/size-guides/{guide['id']}/categories", headers=admin_auth,
                          json={"categoryIds": ["CAT777"]}).status_code == 422
        assert client.put("/api/admin/products/PRD001/size-guide", headers=admin_auth,
                          json={"sizeGuideId": "SZG999"}).status_code == 404


class TestVariants:
    def test_sizes_are_matched_to_the_product(self, client, admin_auth, sized):
        guide = create(client, admin_auth)
        client.put("/api/admin/products/PRD001/size-guide", headers=admin_auth, json={"sizeGuideId": guide["id"]})
        data = public(client)
        assert data["sizeMatch"]["missingFromGuide"] == ["XXL"]
        assert data["sizeMatch"]["consistent"] is False
        assert all(row["offered"] for row in data["rows"])
        portal = client.get("/api/admin/products/PRD001/size-guide", headers=admin_auth).json()["data"]
        assert portal["assignedGuideId"] == guide["id"]
        assert portal["guide"]["sizeMatch"]["missingFromGuide"] == ["XXL"]

    def test_rows_the_product_isnt_sold_in(self, client, admin_auth, db, catalogue):
        from app.models import ProductSize

        db.add(ProductSize(product_id="PRD002", label="M", position=0))
        db.flush()
        guide = create(client, admin_auth)
        client.put("/api/admin/products/PRD002/size-guide", headers=admin_auth, json={"sizeGuideId": guide["id"]})
        data = public(client, "PRD002")
        assert [r["size"] for r in data["rows"] if r["offered"]] == ["M"]
        assert data["sizeMatch"]["notOffered"] == ["S", "L"]
        assert data["sizeMatch"]["consistent"] is True


class TestUnits:
    def test_inches_converted_exactly_and_rounded_once(self, client, admin_auth, sized):
        guide = create(client, admin_auth)
        client.put("/api/admin/products/PRD001/size-guide", headers=admin_auth, json={"sizeGuideId": guide["id"]})
        data = public(client, unit="in")
        m = next(r for r in data["rows"] if r["size"] == "M")
        assert data["unit"] == "in" and data["storedUnit"] == "cm"
        assert m["values"]["chest"] == {"min": 36.2, "max": 38.2}  # 92 / 2.54 = 36.22…, 97 / 2.54 = 38.18…
        assert m["stored"]["chest"] == {"min": 92.0, "max": 97.0}
        assert m["values"]["length"] == {"min": 27.6}               # 70 / 2.54 = 27.559…

    def test_a_guide_in_inches_converts_to_cm(self, client, admin_auth, sized):
        guide = create(client, admin_auth, unit="in", rows=[{"size": "M", "values": {"chest": 36, "length": 28}}])
        client.put("/api/admin/products/PRD001/size-guide", headers=admin_auth, json={"sizeGuideId": guide["id"]})
        m = public(client, unit="cm")["rows"][0]
        assert m["values"]["chest"] == {"min": 91.4}  # 36 × 2.54 = 91.44

    def test_an_unknown_unit_is_refused(self, client, sized):
        assert client.get("/api/products/PRD001/size-guide?unit=furlong").status_code == 422


class TestPermissions:
    def test_a_customer_cannot_manage_guides(self, client, auth):
        assert client.get("/api/admin/size-guides", headers=auth).status_code in (401, 403)
        assert client.post("/api/admin/size-guides", headers=auth, json=shirt_guide()).status_code in (401, 403)

    def test_signed_out_cannot(self, client):
        assert client.post("/api/admin/size-guides", json=shirt_guide()).status_code == 401

    def test_a_role_without_products_cannot(self, client, db):
        from app.core.security import hash_password
        from app.models import AdminUser

        db.add(AdminUser(id="ADM008", email="finance@dailychoicezone.com", password_hash=hash_password("Admin@123"),
                         name="Finance", role="custom", permissions=["reports"], status="active",
                         created_at=datetime(2026, 1, 1)))
        db.flush()
        token = client.post("/api/admin/auth/login", json={"email": "finance@dailychoicezone.com",
                                                           "password": "Admin@123"}).json()["data"]["token"]
        auth = {"Authorization": f"Bearer {token['accessToken']}"}
        assert client.post("/api/admin/size-guides", headers=auth, json=shirt_guide()).status_code == 403
        assert client.put("/api/admin/products/PRD001/size-guide", headers=auth,
                          json={"sizeGuideId": None}).status_code == 403

    def test_changes_are_audited(self, client, db, admin_auth):
        from app.models import AuditLog

        guide = create(client, admin_auth)
        assert db.query(AuditLog).filter_by(action="size-guides.create", resource_id=guide["id"]).count() == 1
