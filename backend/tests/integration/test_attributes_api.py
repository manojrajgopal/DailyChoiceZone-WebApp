"""
Product attributes through the admin API: definitions with their options
(`/api/admin/attributes`) and each product's values
(`/api/admin/products/{id}/attributes`). The rules: a code is unique and fixed
once used, as is the type; an option a product uses can't be removed; an
attribute in use can't be deleted (archive it). See docs/search-and-filters.md §6.
"""

from __future__ import annotations

from datetime import datetime

import pytest
from sqlalchemy import select

from app.core.security import hash_password
from app.models import AdminUser, AuditLog, ProductAttribute, ProductAttributeValue
from app.services.search import dictionary
from tests.conftest import ADMIN_PASSWORD
from tests.integration.test_search_listing import ids, material, shop  # noqa: F401 - fixtures

pytestmark = pytest.mark.integration

BASE = "/api/admin/attributes"


def data(response, status=200):
    assert response.status_code == status, response.text
    return response.json()["data"]


def error(response, status, code):
    assert response.status_code == status, response.text
    assert response.json()["error_code"] == code, response.text


def audited(db, action):
    return list(db.execute(select(AuditLog).where(AuditLog.action == action)).scalars())


def login(client, db, *, admin_id, email, role, permissions):
    db.add(AdminUser(id=admin_id, email=email, password_hash=hash_password(ADMIN_PASSWORD), name="Limited Admin",
                     role=role, permissions=permissions, status="active", created_at=datetime(2026, 1, 1)))
    db.flush()
    response = client.post("/api/admin/auth/login", json={"email": email, "password": ADMIN_PASSWORD})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}


@pytest.fixture()
def editor_auth(client, editor):
    response = client.post("/api/admin/auth/login", json={"email": editor.email, "password": ADMIN_PASSWORD})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}


# ================================================================== create


class TestCreate:
    def test_a_multi_attribute_with_options(self, client, db, admin_auth, shop):
        body = data(client.post(BASE, headers=admin_auth, json={
            "code": " Finish ", "label": "  Surface   finish ", "type": "multi", "position": 5,
            "options": [{"label": "Matte Black"}, {"label": "Gloss", "value": "High Gloss"}]}), 201)
        assert body["code"] == "finish" and body["label"] == "Surface finish" and body["type"] == "multi"
        assert body["filterable"] is True and body["searchable"] is True and body["status"] == "active"
        assert body["unit"] == "" and body["position"] == 5 and body["productCount"] == 0
        assert [(o["value"], o["label"], o["position"]) for o in body["options"]] == [
            ("matte-black", "Matte Black", 0), ("high-gloss", "Gloss", 1)]
        assert all(isinstance(o["id"], int) for o in body["options"])
        assert body["createdAt"] and body["updatedAt"]
        assert [a.resource_id for a in audited(db, "attributes.create")] == [str(body["id"])]

    def test_a_number_attribute_keeps_its_unit_and_flags(self, client, admin_auth, shop):
        body = data(client.post(BASE, headers=admin_auth, json={
            "code": "weight", "label": "Weight", "type": "number", "unit": " g ",
            "filterable": False, "searchable": False}), 201)
        assert body["unit"] == "g" and body["filterable"] is False and body["searchable"] is False
        assert body["options"] == []

    def test_option_words_join_the_dictionary(self, client, db, admin_auth, shop):
        data(client.post(BASE, headers=admin_auth, json={
            "code": "finish", "label": "Finish", "type": "select", "options": [{"label": "Terracotta"}]}), 201)
        assert dictionary.correct(db, "terracota") == "terracotta"

    def test_the_code_is_unique(self, client, admin_auth, material):
        error(client.post(BASE, headers=admin_auth, json={"code": "MATERIAL", "label": "Again", "type": "multi"}),
              409, "ATTRIBUTE_CODE_TAKEN")

    @pytest.mark.parametrize("payload, code", [
        ({"code": "9lives", "label": "X", "type": "select"}, "INVALID_ATTRIBUTE_CODE"),
        ({"code": "m", "label": "X", "type": "select"}, "INVALID_ATTRIBUTE_CODE"),
        ({"code": "dish-washer", "label": "X", "type": "boolean"}, "INVALID_ATTRIBUTE_CODE"),
        ({"label": "X", "type": "select"}, "INVALID_ATTRIBUTE_CODE"),
        ({"code": "finish", "label": "Finish"}, "INVALID_ATTRIBUTE_TYPE"),
        ({"code": "finish", "label": "   ", "type": "select"}, "ATTRIBUTE_LABEL_REQUIRED"),
        ({"code": "finish", "label": "Finish", "type": "number", "options": [{"label": "A"}]}, "OPTIONS_NOT_ALLOWED"),
        ({"code": "finish", "label": "Finish", "type": "boolean", "options": [{"label": "A"}]}, "OPTIONS_NOT_ALLOWED"),
        ({"code": "finish", "label": "Finish", "type": "select",
          "options": [{"label": "Matte"}, {"label": "MATTE"}]}, "DUPLICATE_OPTION"),
        ({"code": "finish", "label": "Finish", "type": "select", "options": [{"label": "***"}]}, "INVALID_OPTIONS"),
        ({"code": "finish", "label": "Finish", "type": "colour"}, "VALIDATION_ERROR"),
        ({"code": "finish", "label": "Finish", "type": "select", "status": "hidden"}, "VALIDATION_ERROR"),
        ({"code": "f" * 41, "label": "Finish", "type": "select"}, "VALIDATION_ERROR"),
    ])
    def test_refused(self, client, db, admin_auth, shop, payload, code):
        error(client.post(BASE, headers=admin_auth, json=payload), 422, code)
        assert db.execute(select(ProductAttribute)).first() is None


# ================================================================== read


class TestRead:
    def test_the_list_is_ordered_and_counts_products(self, client, admin_auth, material):
        body = data(client.get(BASE, headers=admin_auth))
        assert [(a["code"], a["productCount"]) for a in body] == [
            ("material", 4), ("capacity", 3), ("dishwasher_safe", 3), ("internal", 1)]
        assert [o["value"] for o in body[0]["options"]] == ["steel", "glass", "ceramic"]

    def test_the_status_filter(self, client, db, admin_auth, material):
        material["capacity"].status = "archived"
        db.flush()
        assert [a["code"] for a in data(client.get(f"{BASE}?status=archived", headers=admin_auth))] == ["capacity"]
        assert "capacity" not in [a["code"] for a in data(client.get(f"{BASE}?status=active", headers=admin_auth))]
        assert len(data(client.get(f"{BASE}?status=all", headers=admin_auth))) == 4

    def test_one(self, client, admin_auth, material):
        body = data(client.get(f"{BASE}/{material['material'].id}", headers=admin_auth))
        assert body["code"] == "material" and body["productCount"] == 4

    def test_a_missing_one(self, client, admin_auth, shop):
        error(client.get(f"{BASE}/999999", headers=admin_auth), 404, "ATTRIBUTE_NOT_FOUND")
        error(client.put(f"{BASE}/999999", headers=admin_auth, json={"label": "X"}), 404, "ATTRIBUTE_NOT_FOUND")
        error(client.delete(f"{BASE}/999999", headers=admin_auth), 404, "ATTRIBUTE_NOT_FOUND")


# ================================================================== update


class TestUpdate:
    def test_label_unit_flags_position_and_status_change_while_in_use(self, client, db, admin_auth, material):
        attribute_id = material["capacity"].id
        body = data(client.put(f"{BASE}/{attribute_id}", headers=admin_auth, json={
            "label": "Volume", "unit": "L", "filterable": False, "position": 9, "status": "archived"}))
        assert (body["label"], body["unit"], body["filterable"], body["position"], body["status"]) == (
            "Volume", "L", False, 9, "archived")
        [entry] = audited(db, "attributes.update")
        assert entry.changes == {"fields": ["filterable", "label", "position", "status", "unit"]}

    @pytest.mark.parametrize("change", [{"code": "fabric"}, {"type": "select"}])
    def test_code_and_type_are_fixed_once_used(self, client, admin_auth, material, change):
        error(client.put(f"{BASE}/{material['material'].id}", headers=admin_auth, json=change), 409,
              "ATTRIBUTE_IN_USE")

    def test_sending_the_same_code_and_type_is_not_a_change(self, client, admin_auth, material):
        body = data(client.put(f"{BASE}/{material['material'].id}", headers=admin_auth,
                               json={"code": "material", "type": "multi", "label": "Materials"}))
        assert body["label"] == "Materials"

    def test_an_unused_attribute_may_change_code_and_type(self, client, admin_auth, shop):
        created = data(client.post(BASE, headers=admin_auth, json={
            "code": "finish", "label": "Finish", "type": "select", "options": [{"label": "Matte"}]}), 201)
        body = data(client.put(f"{BASE}/{created['id']}", headers=admin_auth, json={"code": "Coating",
                                                                                   "type": "number"}))
        assert body["code"] == "coating" and body["type"] == "number"
        assert body["options"] == []  # a number has no options

    def test_renaming_to_a_taken_code(self, client, admin_auth, material):
        created = data(client.post(BASE, headers=admin_auth, json={"code": "finish", "label": "F", "type": "boolean"}),
                       201)
        error(client.put(f"{BASE}/{created['id']}", headers=admin_auth, json={"code": "capacity"}), 409,
              "ATTRIBUTE_CODE_TAKEN")
        error(client.put(f"{BASE}/{created['id']}", headers=admin_auth, json={"code": "1bad"}), 422,
              "INVALID_ATTRIBUTE_CODE")

    def test_an_empty_label_is_refused(self, client, admin_auth, material):
        error(client.put(f"{BASE}/{material['material'].id}", headers=admin_auth, json={"label": "  "}), 422,
              "ATTRIBUTE_LABEL_REQUIRED")

    def test_options_are_renamed_added_and_removed(self, client, db, admin_auth, material):
        attribute = material["material"]
        by_value = {o.value: o.id for o in attribute.options}
        body = data(client.put(f"{BASE}/{attribute.id}", headers=admin_auth, json={"options": [
            {"id": by_value["glass"], "label": "Borosilicate glass"},
            {"id": by_value["steel"], "label": "Stainless steel"},
            {"id": by_value["ceramic"], "label": "Ceramic"},
            {"label": "Bamboo"},
        ]}))
        assert [(o["value"], o["label"], o["position"]) for o in body["options"]] == [
            ("glass", "Borosilicate glass", 0), ("steel", "Stainless steel", 1), ("ceramic", "Ceramic", 2),
            ("bamboo", "Bamboo", 3)]
        # The renamed option's label follows onto the products using it; its value (in URLs) does not move.
        labels = set(db.execute(select(ProductAttributeValue.value).where(
            ProductAttributeValue.attribute_id == attribute.id,
            ProductAttributeValue.value_normalized == "steel")).scalars())
        assert labels == {"Stainless steel"}
        assert set(ids(client.get("/api/products?attr.material=steel"))) == {"PRD101", "PRD102"}

        # Bamboo is unused, so it can go again.
        body = data(client.put(f"{BASE}/{attribute.id}", headers=admin_auth, json={"options": [
            {"id": o["id"], "label": o["label"]} for o in body["options"] if o["value"] != "bamboo"]}))
        assert [o["value"] for o in body["options"]] == ["glass", "steel", "ceramic"]

    def test_an_option_in_use_cannot_be_removed(self, client, db, admin_auth, material):
        attribute = material["material"]
        keep = [{"id": o.id, "label": o.label} for o in attribute.options if o.value != "ceramic"]
        response = client.put(f"{BASE}/{attribute.id}", headers=admin_auth, json={"options": keep})
        error(response, 409, "OPTION_IN_USE")
        assert "Ceramic" in response.json()["message"]
        db.expire_all()
        assert {o.value for o in db.get(ProductAttribute, attribute.id).options} == {"steel", "glass", "ceramic"}

    def test_an_option_of_another_attribute_is_refused(self, client, db, admin_auth, material):
        foreign = db.execute(select(ProductAttribute).where(ProductAttribute.code == "internal")).scalar_one()
        error(client.put(f"{BASE}/{material['material'].id}", headers=admin_auth,
                         json={"options": [{"id": foreign.options[0].id, "label": "X"}]}), 422, "INVALID_OPTIONS")

    def test_options_on_a_number_are_refused(self, client, admin_auth, material):
        error(client.put(f"{BASE}/{material['capacity'].id}", headers=admin_auth, json={"options": [{"label": "A"}]}),
              422, "OPTIONS_NOT_ALLOWED")

    def test_archiving_hides_it_from_products_but_keeps_the_values(self, client, db, admin_auth, material):
        attribute_id = material["material"].id
        data(client.put(f"{BASE}/{attribute_id}", headers=admin_auth, json={"status": "archived"}))
        codes = [a["code"] for a in data(client.get("/api/admin/products/PRD101/attributes",
                                                    headers=admin_auth))["attributes"]]
        assert "material" not in codes
        assert "material" not in [a["code"] for a in data(client.get("/api/products/facets"))["attributes"]]
        assert db.execute(select(ProductAttributeValue).where(
            ProductAttributeValue.attribute_id == attribute_id)).first() is not None
        # ...and restoring it brings everything back.
        data(client.put(f"{BASE}/{attribute_id}", headers=admin_auth, json={"status": "active"}))
        assert set(ids(client.get("/api/products?attr.material=ceramic"))) == {"PRD105"}


# ================================================================== delete


class TestDelete:
    def test_an_attribute_in_use_cannot_be_deleted(self, client, db, admin_auth, material):
        error(client.delete(f"{BASE}/{material['material'].id}", headers=admin_auth), 409, "ATTRIBUTE_IN_USE")
        assert db.get(ProductAttribute, material["material"].id) is not None

    def test_an_unused_one_can(self, client, db, admin_auth, shop):
        created = data(client.post(BASE, headers=admin_auth, json={
            "code": "finish", "label": "Finish", "type": "select", "options": [{"label": "Matte"}]}), 201)
        response = client.delete(f"{BASE}/{created['id']}", headers=admin_auth)
        assert response.status_code == 200, response.text
        error(client.get(f"{BASE}/{created['id']}", headers=admin_auth), 404, "ATTRIBUTE_NOT_FOUND")
        [entry] = audited(db, "attributes.delete")
        assert entry.resource_id == str(created["id"]) and "finish" in entry.summary

    def test_once_its_values_are_cleared_it_can_go(self, client, admin_auth, material):
        attribute_id = material["dishwasher"].id
        for pid in ("PRD101", "PRD102", "PRD103"):
            data(client.put(f"/api/admin/products/{pid}/attributes", headers=admin_auth,
                            json={"values": {"dishwasher_safe": None}}))
        assert client.delete(f"{BASE}/{attribute_id}", headers=admin_auth).status_code == 200


# ================================================================== product values


def values_of(body):
    return {a["code"]: a["value"] for a in body["attributes"]}


class TestProductValues:
    def test_every_active_attribute_is_listed_with_its_value(self, client, admin_auth, material):
        body = data(client.get("/api/admin/products/PRD101/attributes", headers=admin_auth))
        assert body["productId"] == "PRD101"
        assert values_of(body) == {"material": ["steel"], "capacity": 750, "dishwasher_safe": True, "internal": "x"}
        capacity = next(a for a in body["attributes"] if a["code"] == "capacity")
        assert capacity["unit"] == "ml" and capacity["options"] == [] and capacity["type"] == "number"

    def test_unset_values(self, client, admin_auth, material):
        assert values_of(data(client.get("/api/admin/products/PRD109/attributes", headers=admin_auth))) == {
            "material": [], "capacity": 500, "dishwasher_safe": None, "internal": None}

    def test_multi_values_follow_the_option_order(self, client, admin_auth, material):
        body = data(client.put("/api/admin/products/PRD106/attributes", headers=admin_auth,
                               json={"values": {"material": ["ceramic", "steel"]}}))
        assert values_of(body)["material"] == ["steel", "ceramic"]

    def test_setting_values_changes_only_the_codes_sent(self, client, db, admin_auth, material):
        body = data(client.put("/api/admin/products/PRD101/attributes", headers=admin_auth,
                               json={"values": {"material": ["steel", "glass"], "capacity": 1200.5,
                                                "dishwasher_safe": None}}))
        assert values_of(body) == {"material": ["steel", "glass"], "capacity": 1200.5, "dishwasher_safe": None,
                                   "internal": "x"}
        [entry] = audited(db, "products.attributes")
        assert entry.resource_id == "PRD101"
        assert entry.changes == {"attributes": ["material", "capacity", "dishwasher_safe"]}
        assert set(ids(client.get("/api/products?attr.capacity.min=1200"))) == {"PRD101"}
        assert "PRD101" not in ids(client.get("/api/products?attr.dishwasher_safe=true"))

    def test_an_unchanged_save_is_not_audited(self, client, db, admin_auth, material):
        data(client.put("/api/admin/products/PRD101/attributes", headers=admin_auth,
                        json={"values": {"material": ["steel"], "capacity": "750"}}))
        # Only the generic request trail, not a "Changed attributes of …" entry with a diff.
        assert [e.changes for e in audited(db, "products.attributes")] in ([], [None])

    def test_saving_refreshes_the_search_text(self, client, admin_auth, material):
        assert "PRD109" not in ids(client.get("/api/products?search=ceramic"))
        data(client.put("/api/admin/products/PRD109/attributes", headers=admin_auth,
                        json={"values": {"material": ["ceramic"]}}))
        assert "PRD109" in ids(client.get("/api/products?search=ceramic"))

    def test_a_non_searchable_attribute_stays_out_of_the_search_text(self, client, db, admin_auth, material):
        material["material"].searchable = False
        db.flush()
        data(client.put("/api/admin/products/PRD109/attributes", headers=admin_auth,
                        json={"values": {"material": ["ceramic"]}}))
        assert "PRD109" not in ids(client.get("/api/products?search=ceramic"))

    def test_a_missing_product(self, client, admin_auth, material):
        error(client.get("/api/admin/products/PRD999/attributes", headers=admin_auth), 404, "PRODUCT_NOT_FOUND")
        error(client.put("/api/admin/products/PRD999/attributes", headers=admin_auth,
                         json={"values": {"capacity": 1}}), 404, "PRODUCT_NOT_FOUND")

    @pytest.mark.parametrize("values, code", [
        ({"colour_family": "red"}, "UNKNOWN_ATTRIBUTE"),
        ({"material": ["wood"]}, "INVALID_ATTRIBUTE_VALUE"),
        ({"material": [f"v{i}" for i in range(31)]}, "INVALID_ATTRIBUTE_VALUE"),
        ({"internal": ["x"]}, "INVALID_ATTRIBUTE_VALUE"),
        ({"capacity": "lots"}, "INVALID_ATTRIBUTE_VALUE"),
        ({"capacity": 2_000_000_000}, "INVALID_ATTRIBUTE_VALUE"),
        ({"capacity": True}, "INVALID_ATTRIBUTE_VALUE"),
        ({"dishwasher_safe": "yes"}, "INVALID_ATTRIBUTE_VALUE"),
    ])
    def test_refused(self, client, admin_auth, material, values, code):
        error(client.put("/api/admin/products/PRD101/attributes", headers=admin_auth, json={"values": values}),
              422, code)

    def test_one_bad_value_changes_nothing(self, client, db, admin_auth, material):
        error(client.put("/api/admin/products/PRD101/attributes", headers=admin_auth,
                         json={"values": {"capacity": 900, "material": ["wood"]}}), 422, "INVALID_ATTRIBUTE_VALUE")
        db.expire_all()
        assert values_of(data(client.get("/api/admin/products/PRD101/attributes", headers=admin_auth)))[
            "capacity"] == 750


# ================================================================== who may


class TestPermissions:
    def test_the_editor_role_has_products(self, client, editor_auth, material):
        assert client.get(BASE, headers=editor_auth).status_code == 200
        data(client.post(BASE, headers=editor_auth, json={"code": "finish", "label": "Finish", "type": "boolean"}),
             201)
        assert client.get("/api/admin/products/PRD101/attributes", headers=editor_auth).status_code == 200

    def test_an_admin_without_products_is_refused(self, client, db, material):
        headers = login(client, db, admin_id="ADM010", email="orders.only@example.com", role="support-desk",
                        permissions=["orders"])
        attribute_id = material["material"].id
        for response in (
            client.get(BASE, headers=headers),
            client.post(BASE, headers=headers, json={"code": "finish", "label": "F", "type": "boolean"}),
            client.get(f"{BASE}/{attribute_id}", headers=headers),
            client.put(f"{BASE}/{attribute_id}", headers=headers, json={"label": "X"}),
            client.delete(f"{BASE}/{attribute_id}", headers=headers),
            client.get("/api/admin/products/PRD101/attributes", headers=headers),
            client.put("/api/admin/products/PRD101/attributes", headers=headers, json={"values": {"capacity": 1}}),
        ):
            error(response, 403, "PERMISSION_DENIED")
        assert db.get(ProductAttribute, attribute_id).label == "Material"

    def test_customers_and_strangers_are_refused(self, client, auth, material):
        assert client.get(BASE, headers=auth).status_code in (401, 403)
        assert client.get(BASE).status_code == 401
        assert client.get("/api/admin/products/PRD101/attributes").status_code == 401
