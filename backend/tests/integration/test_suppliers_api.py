"""
The supplier directory through the API: create, read, update, status and
archive rules, validation as the portal sees it, permissions, and the list.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from tests.integration.test_suppliers_helpers import (  # noqa: F401
    advance,
    gstin,
    link,
    make_po,
    make_supplier,
    role_headers,
    supplier,
    supplier_payload,
    wrong_check,
)

pytestmark = pytest.mark.integration

BASE = "/api/admin/suppliers"


@pytest.fixture()
def setup(catalogue, settings_documents):
    return None


# ------------------------------------------------------------------- create


class TestCreate:
    def test_creates_a_supplier_with_every_field(self, client, admin_auth, setup):
        response = client.post(BASE, json=supplier_payload(), headers=admin_auth)
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["success"] is True
        data = body["data"]
        assert data["id"] == "SUP001" and data["code"] == "ANVI-TEX" and data["name"] == "Anvi Textiles"
        assert data["legalName"] == "Anvi Textiles Pvt Ltd" and data["contactPerson"] == "R. Kumar"
        assert data["status"] == "active" and data["gstin"] == gstin() and data["pan"] == "ABCDE1234F"
        assert data["taxTreatment"] == "registered" and data["businessType"] == "manufacturer"
        assert data["billingAddress"] == {"line1": "12 Mill Road", "line2": "", "city": "Bengaluru",
                                          "state": "Karnataka", "country": "India", "pincode": "560001"}
        assert data["warehouseAddress"] is None
        assert data["paymentTerms"] == "Net 30" and data["creditDays"] == 30 and data["currency"] == "INR"
        assert data["createdBy"] == "ADM001" and data["createdAt"] and data["updatedAt"]

    def test_ids_run_in_sequence(self, client, admin_auth, setup):
        first = make_supplier(client, admin_auth)
        second = make_supplier(client, admin_auth, code="MERI-AUD", name="Meridian Audio",
                               gstin=gstin("27", "AAACR5055K"), pan="AAACR5055K")
        assert (first["id"], second["id"]) == ("SUP001", "SUP002")

    def test_a_missing_code_is_generated_from_the_id(self, client, admin_auth, setup):
        data = make_supplier(client, admin_auth, code=None)
        assert data["code"] == data["id"] == "SUP001"

    def test_a_generated_code_steps_round_one_already_taken(self, client, admin_auth, setup):
        make_supplier(client, admin_auth, code="SUP002")
        second = make_supplier(client, admin_auth, code="", gstin=None, pan=None, taxTreatment="unregistered")
        assert second["id"] == "SUP002" and second["code"] == "SUP002-2"

    def test_a_lower_case_code_is_stored_upper_case(self, client, admin_auth, setup):
        assert make_supplier(client, admin_auth, code="anvi-tex")["code"] == "ANVI-TEX"

    @pytest.mark.parametrize("again", ["ANVI-TEX", "anvi-tex", "Anvi-Tex", " ANVI-TEX "])
    def test_a_duplicate_code_is_refused_whatever_its_case(self, client, admin_auth, setup, again):
        make_supplier(client, admin_auth)
        response = client.post(BASE, json=supplier_payload(code=again, name="Other"), headers=admin_auth)
        assert response.status_code == 409
        body = response.json()
        assert body["error_code"] == "SUPPLIER_CODE_TAKEN" and body["details"] == {"field": "code"}

    def test_an_unregistered_supplier_needs_no_gstin(self, client, admin_auth, setup):
        data = make_supplier(client, admin_auth, gstin=None, pan=None, taxTreatment="unregistered")
        assert data["gstin"] is None and data["pan"] is None and data["taxTreatment"] == "unregistered"

    def test_can_be_created_inactive_but_not_archived(self, client, admin_auth, setup):
        assert make_supplier(client, admin_auth, status="inactive")["status"] == "inactive"
        response = client.post(BASE, json=supplier_payload(code="OTHER", status="archived"), headers=admin_auth)
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_STATUS"

    def test_the_create_is_audited(self, client, admin_auth, setup, db):
        from app.models import AuditLog

        data = make_supplier(client, admin_auth)
        entry = db.execute(select(AuditLog).where(AuditLog.action == "supplier.create")).scalar_one()
        assert entry.resource_type == "supplier" and entry.resource_id == data["id"]
        assert entry.actor_id == "ADM001" and "Anvi Textiles" in entry.summary
        assert entry.changes["code"] == {"from": None, "to": "ANVI-TEX"}


# --------------------------------------------------------------- validation


INVALID = [
    ({"name": ""}, "NAME_REQUIRED", "name"),
    ({"name": "   "}, "NAME_REQUIRED", "name"),
    ({"code": "A"}, "INVALID_SUPPLIER_CODE", "code"),
    ({"code": "X" * 31}, "INVALID_SUPPLIER_CODE", "code"),
    ({"code": "ANVI TEX"}, "INVALID_SUPPLIER_CODE", "code"),
    ({"gstin": "29ABCDE1234F1Z"}, "INVALID_GSTIN", "gstin"),
    ({"gstin": wrong_check(gstin())}, "INVALID_GSTIN", "gstin"),
    ({"gstin": None, "pan": None}, "GSTIN_REQUIRED", "gstin"),
    ({"gstin": "", "pan": None, "taxTreatment": "registered"}, "GSTIN_REQUIRED", "gstin"),
    ({"pan": "ABCDE1234"}, "INVALID_PAN", "pan"),
    ({"pan": "ZZZZZ9999Z"}, "PAN_GSTIN_MISMATCH", "pan"),
    ({"email": "not-an-email"}, "INVALID_EMAIL", "email"),
    ({"phone": "12345"}, "INVALID_PHONE", "phone"),
    ({"creditDays": -1}, "INVALID_CREDIT_DAYS", "creditDays"),
    ({"creditDays": 366}, "INVALID_CREDIT_DAYS", "creditDays"),
    ({"billingAddress": {"country": "India", "pincode": "5600"}}, "INVALID_PINCODE", "billingAddress.pincode"),
    ({"taxTreatment": "exempt"}, "INVALID_TAX_TREATMENT", "taxTreatment"),
    ({"currency": "RUPEE"}, "INVALID_CURRENCY", "currency"),
]


@pytest.mark.parametrize("overrides,code,field", INVALID, ids=[f"{c}-{i}" for i, (_, c, _f) in enumerate(INVALID)])
def test_invalid_fields_are_refused_with_a_code_and_field(client, admin_auth, setup, overrides, code, field):
    response = client.post(BASE, json=supplier_payload(**overrides), headers=admin_auth)
    assert response.status_code == 422, response.text
    body = response.json()
    assert body["success"] is False and body["error_code"] == code and body["details"]["field"] == field


@pytest.mark.parametrize("days", [0, 365])
def test_credit_day_boundaries_are_accepted(client, admin_auth, setup, days):
    assert make_supplier(client, admin_auth, creditDays=days)["creditDays"] == days


def test_a_body_that_is_not_an_object_is_refused(client, admin_auth, setup):
    response = client.post(BASE, json=["Anvi"], headers=admin_auth)
    assert response.status_code == 422


def test_nothing_is_saved_when_validation_fails(client, admin_auth, setup, db):
    from app.models import Supplier

    client.post(BASE, json=supplier_payload(gstin=wrong_check(gstin())), headers=admin_auth)
    assert db.execute(select(Supplier)).first() is None


# ------------------------------------------------------------- read/update


class TestReadAndUpdate:
    def test_reads_one_supplier(self, client, admin_auth, supplier):
        response = client.get(f"{BASE}/{supplier['id']}", headers=admin_auth)
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["code"] == "ANVI-TEX" and "stats" in data and "history" in data
        assert data["recentDeliveries"] == []

    def test_an_unknown_supplier_is_404(self, client, admin_auth, setup):
        for method, path in (("GET", f"{BASE}/SUP999"), ("PUT", f"{BASE}/SUP999"),
                             ("POST", f"{BASE}/SUP999/status"), ("GET", f"{BASE}/SUP999/products"),
                             ("POST", f"{BASE}/SUP999/products")):
            response = client.request(method, path, json={"status": "inactive", "productId": "PRD001",
                                                          "purchaseCost": 1}, headers=admin_auth)
            assert response.status_code == 404, (method, path, response.text)
            assert response.json()["error_code"] == "SUPPLIER_NOT_FOUND"

    def test_a_partial_update_keeps_the_other_fields(self, client, admin_auth, supplier):
        response = client.put(f"{BASE}/{supplier['id']}", json={"contactPerson": "S. Iyer", "creditDays": 45},
                              headers=admin_auth)
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["contactPerson"] == "S. Iyer" and data["creditDays"] == 45
        assert data["gstin"] == supplier["gstin"] and data["name"] == supplier["name"]

    def test_update_validates_like_create(self, client, admin_auth, supplier):
        response = client.put(f"{BASE}/{supplier['id']}", json={"gstin": wrong_check(gstin())}, headers=admin_auth)
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_GSTIN"

    def test_update_can_switch_to_unregistered_and_drop_the_gstin(self, client, admin_auth, supplier):
        response = client.put(f"{BASE}/{supplier['id']}", json={"taxTreatment": "unregistered", "gstin": None,
                                                               "pan": None}, headers=admin_auth)
        assert response.status_code == 200
        assert response.json()["data"]["gstin"] is None

    def test_changing_the_code_to_one_taken_is_refused(self, client, admin_auth, supplier):
        make_supplier(client, admin_auth, code="MERI-AUD", name="Meridian")
        response = client.put(f"{BASE}/{supplier['id']}", json={"code": "meri-aud"}, headers=admin_auth)
        assert response.status_code == 409 and response.json()["error_code"] == "SUPPLIER_CODE_TAKEN"

    def test_keeping_its_own_code_is_fine(self, client, admin_auth, supplier):
        response = client.put(f"{BASE}/{supplier['id']}", json={"code": "anvi-tex", "name": "Anvi"},
                              headers=admin_auth)
        assert response.status_code == 200 and response.json()["data"]["code"] == "ANVI-TEX"

    def test_status_is_not_changed_by_put(self, client, admin_auth, supplier):
        response = client.put(f"{BASE}/{supplier['id']}", json={"status": "archived"}, headers=admin_auth)
        assert response.status_code == 200 and response.json()["data"]["status"] == "active"

    def test_the_update_is_audited_with_what_changed(self, client, admin_auth, supplier, db):
        from app.models import AuditLog

        client.put(f"{BASE}/{supplier['id']}", json={"creditDays": 60}, headers=admin_auth)
        entry = db.execute(select(AuditLog).where(AuditLog.action == "supplier.update")).scalar_one()
        assert entry.changes == {"creditDays": {"from": 30, "to": 60}}


# ------------------------------------------------------------------- status


class TestStatus:
    def _status(self, client, headers, supplier_id, status):
        return client.post(f"{BASE}/{supplier_id}/status", json={"status": status}, headers=headers)

    def test_active_inactive_archived_and_back(self, client, admin_auth, supplier):
        for status in ("inactive", "active", "archived", "inactive", "archived", "active"):
            response = self._status(client, admin_auth, supplier["id"], status)
            assert response.status_code == 200, response.text
            assert response.json()["data"]["status"] == status

    def test_an_unknown_status_is_refused(self, client, admin_auth, supplier):
        for status in ("deleted", "", None, 5):
            response = self._status(client, admin_auth, supplier["id"], status)
            assert response.status_code == 422, status
            assert response.json()["error_code"] == "INVALID_STATUS"

    @pytest.mark.parametrize("steps", [(), ("submit",), ("submit", "send"), ("submit", "send", "acknowledge")])
    def test_archiving_is_refused_with_an_open_po(self, client, admin_auth, supplier, steps):
        link(client, admin_auth, supplier["id"], "PRD001")
        po = make_po(client, admin_auth, supplier["id"], [{"productId": "PRD001", "quantity": 5}])
        advance(client, admin_auth, po["id"], *steps)
        response = self._status(client, admin_auth, supplier["id"], "archived")
        assert response.status_code == 409
        body = response.json()
        assert body["error_code"] == "SUPPLIER_HAS_OPEN_POS" and body["details"]["openPoCount"] == 1

    def test_archiving_is_allowed_once_the_po_is_cancelled(self, client, admin_auth, supplier):
        link(client, admin_auth, supplier["id"], "PRD001")
        po = make_po(client, admin_auth, supplier["id"], [{"productId": "PRD001", "quantity": 5}])
        client.post(f"/api/admin/purchase-orders/{po['id']}/cancel", json={"reason": "Not needed"},
                    headers=admin_auth)
        assert self._status(client, admin_auth, supplier["id"], "archived").status_code == 200

    def test_a_status_change_is_audited(self, client, admin_auth, supplier, db):
        from app.models import AuditLog

        self._status(client, admin_auth, supplier["id"], "inactive")
        entry = db.execute(select(AuditLog).where(AuditLog.action == "supplier.inactive")).scalar_one()
        assert entry.changes == {"status": {"from": "active", "to": "inactive"}}


# -------------------------------------------------------------- permissions


class TestPermissions:
    def test_no_token_is_401(self, client, setup):
        for method, path in (("GET", BASE), ("POST", BASE), ("GET", f"{BASE}/SUP001"),
                             ("GET", "/api/admin/products/PRD001/suppliers"),
                             ("PUT", "/api/admin/supplier-products/1")):
            assert client.request(method, path, json={}).status_code == 401

    def test_a_customer_is_403(self, client, auth, setup):
        assert client.get(BASE, headers=auth).status_code == 403
        assert client.post(BASE, json=supplier_payload(), headers=auth).status_code == 403

    @pytest.mark.parametrize("role", ["editor", "staff"])
    def test_roles_without_the_permission_are_refused(self, client, db, setup, role):
        headers = role_headers(db, "ADM050", role, ["products", "orders", "content"])
        for method, path in (("GET", BASE), ("POST", BASE), ("GET", "/api/admin/products/PRD001/suppliers")):
            response = client.request(method, path, json=supplier_payload(), headers=headers)
            assert response.status_code == 403, (role, method, path)
            assert response.json()["error_code"] == "PERMISSION_DENIED"

    def test_the_editor_fixture_is_refused(self, client, editor, setup):
        token = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"})
        headers = {"Authorization": f"Bearer {token.json()['data']['token']['accessToken']}"}
        assert client.get(BASE, headers=headers).status_code == 403

    @pytest.mark.parametrize("role", ["manager", "admin"])
    def test_manager_and_admin_may_manage_suppliers(self, client, db, setup, role):
        headers = role_headers(db, "ADM051", role, [])
        response = client.post(BASE, json=supplier_payload(), headers=headers)
        assert response.status_code == 201, response.text
        assert response.json()["data"]["createdBy"] == "ADM051"
        assert client.get(BASE, headers=headers).status_code == 200

    def test_an_explicit_grant_works_for_any_role(self, client, db, setup):
        headers = role_headers(db, "ADM052", "staff", ["suppliers"])
        assert client.get(BASE, headers=headers).status_code == 200

    def test_suppliers_are_not_on_any_customer_route(self):
        from app.main import app

        paths = [route.path for route in app.routes if "supplier" in getattr(route, "path", "")
                 or "purchase-order" in getattr(route, "path", "")]
        assert paths and all(path.startswith("/api/admin/") for path in paths)


# --------------------------------------------------------------------- list


class TestList:
    @pytest.fixture()
    def several(self, client, admin_auth, setup):
        made = [
            make_supplier(client, admin_auth, code="ZETA", name="Zeta Fabrics", email="z@zeta.example.com"),
            make_supplier(client, admin_auth, code="ALPHA", name="Alpha Audio", gstin=None, pan=None,
                          taxTreatment="unregistered", contactPerson="Meena"),
            make_supplier(client, admin_auth, code="MID", name="Mid Mills", gstin=None, pan=None,
                          taxTreatment="unregistered", status="inactive"),
            make_supplier(client, admin_auth, code="OLD", name="Old Traders", gstin=None, pan=None,
                          taxTreatment="unregistered"),
        ]
        client.post(f"{BASE}/{made[3]['id']}/status", json={"status": "archived"}, headers=admin_auth)
        return made

    def _list(self, client, headers, **params):
        response = client.get(BASE, params=params, headers=headers)
        assert response.status_code == 200, response.text
        return response.json()["data"]

    def test_default_hides_archived_and_sorts_by_name(self, client, admin_auth, several):
        data = self._list(client, admin_auth)
        assert [s["code"] for s in data["items"]] == ["ALPHA", "MID", "ZETA"]
        assert data["pagination"] == {"page": 1, "page_size": 25, "total": 3, "total_pages": 1}
        assert data["counts"] == {"active": 2, "inactive": 1, "archived": 1}

    def test_status_archived_shows_only_those(self, client, admin_auth, several):
        assert [s["code"] for s in self._list(client, admin_auth, status="archived")["items"]] == ["OLD"]
        assert [s["code"] for s in self._list(client, admin_auth, status="inactive")["items"]] == ["MID"]

    def test_search_matches_name_code_email_and_contact(self, client, admin_auth, several):
        assert [s["code"] for s in self._list(client, admin_auth, q="audio")["items"]] == ["ALPHA"]
        assert [s["code"] for s in self._list(client, admin_auth, q="zeta.example")["items"]] == ["ZETA"]
        assert [s["code"] for s in self._list(client, admin_auth, q="meena")["items"]] == ["ALPHA"]
        assert [s["code"] for s in self._list(client, admin_auth, q="mid")["items"]] == ["MID"]
        counted = self._list(client, admin_auth, q="old")
        assert counted["items"] == [] and counted["counts"]["archived"] == 1

    def test_sorts(self, client, admin_auth, several):
        assert [s["code"] for s in self._list(client, admin_auth, sort="code")["items"]] == ["ALPHA", "MID", "ZETA"]
        newest_first = [s["code"] for s in self._list(client, admin_auth, sort="createdAt")["items"]]
        assert newest_first == ["MID", "ALPHA", "ZETA"]

    def test_pagination(self, client, admin_auth, several):
        page = self._list(client, admin_auth, page=2, pageSize=2)
        assert [s["code"] for s in page["items"]] == ["ZETA"]
        assert page["pagination"]["total"] == 3 and page["pagination"]["total_pages"] == 2

    def test_rows_carry_product_and_open_po_counts(self, client, admin_auth, several):
        zeta = several[0]
        link(client, admin_auth, zeta["id"], "PRD001")
        link(client, admin_auth, zeta["id"], "PRD002")
        make_po(client, admin_auth, zeta["id"], [{"productId": "PRD001", "quantity": 1}])
        row = next(s for s in self._list(client, admin_auth)["items"] if s["code"] == "ZETA")
        assert row["productCount"] == 2 and row["openPoCount"] == 1

    def test_nonsense_filters_are_ignored(self, client, admin_auth, several):
        data = self._list(client, admin_auth, status="<script>", sort="nonsense;DROP")
        assert len(data["items"]) == 3
