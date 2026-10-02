"""
Supplier-product links through the API: what a supplier provides and at what
cost. Create, list (both ways round), update, delete, the validation the
portal's form relies on, the one-preferred-supplier-per-product rule,
permissions, and the figures and history on the supplier's detail page.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from sqlalchemy import select

from tests.integration.test_suppliers_helpers import (  # noqa: F401
    advance,
    gstin,
    item_for,
    link,
    make_po,
    make_supplier,
    receive,
    role_headers,
    supplier,
)

pytestmark = pytest.mark.integration

SUPPLIERS = "/api/admin/suppliers"
LINKS = "/api/admin/supplier-products"


def link_body(product_id: str = "PRD001", **overrides) -> dict:
    body = {"productId": product_id, "supplierSku": "AT-K-01", "purchaseCost": 450.0, "moq": 10,
            "leadTimeDays": 7, "status": "active", "preferred": False, "notes": "Bulk only"}
    body.update(overrides)
    return body


def post_link(client, headers, supplier_id: str, **overrides):
    return client.post(f"{SUPPLIERS}/{supplier_id}/products", json=link_body(**overrides), headers=headers)


@pytest.fixture()
def second(client, admin_auth, supplier):
    """Another active supplier, so 'the product's other links' has something in it."""
    return make_supplier(client, admin_auth, code="MERI-AUD", name="Meridian Audio",
                         gstin=gstin("27", "AAACR5055K"), pan="AAACR5055K")


def _set_product_status(db, product_id: str, status: str) -> None:
    from app.models import Product

    db.get(Product, product_id).status = status
    db.flush()


# ------------------------------------------------------------------- create


class TestCreate:
    def test_links_a_product_with_every_field(self, client, admin_auth, supplier):
        response = post_link(client, admin_auth, supplier["id"])
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["success"] is True
        data = body["data"]
        assert isinstance(data["id"], int)
        assert data["supplierId"] == supplier["id"] and data["supplierName"] == "Anvi Textiles"
        assert data["supplierStatus"] == "active"
        assert data["productId"] == "PRD001" and data["productName"] == "Cotton Kurta"
        assert data["productSku"] == "DCZ-WO0001" and data["productStatus"] == "active"
        assert data["supplierSku"] == "AT-K-01" and data["purchaseCost"] == 450.0
        assert data["moq"] == 10 and data["leadTimeDays"] == 7 and data["status"] == "active"
        assert data["preferred"] is False and data["notes"] == "Bulk only"
        assert data["createdAt"] and data["updatedAt"]

    def test_purchase_cost_is_rupees_on_the_wire_and_paise_in_the_database(self, client, admin_auth, supplier, db):
        from app.models import SupplierProduct

        data = post_link(client, admin_auth, supplier["id"], purchaseCost=450.55).json()["data"]
        assert data["purchaseCost"] == 450.55
        row = db.get(SupplierProduct, data["id"])
        assert row.purchase_cost == 45055

    def test_numeric_text_is_accepted_for_the_cost(self, client, admin_auth, supplier, db):
        from app.models import SupplierProduct

        data = post_link(client, admin_auth, supplier["id"], purchaseCost="99.90").json()["data"]
        assert data["purchaseCost"] == 99.9 and db.get(SupplierProduct, data["id"]).purchase_cost == 9990

    def test_optional_fields_have_defaults(self, client, admin_auth, supplier):
        response = client.post(f"{SUPPLIERS}/{supplier['id']}/products",
                               json={"productId": "PRD002", "purchaseCost": 100}, headers=admin_auth)
        assert response.status_code == 201, response.text
        data = response.json()["data"]
        assert data["moq"] == 1 and data["leadTimeDays"] is None and data["status"] == "active"
        assert data["preferred"] is False and data["supplierSku"] == "" and data["notes"] == ""

    def test_the_selling_price_is_never_touched(self, client, admin_auth, supplier, db):
        from app.models import Product

        post_link(client, admin_auth, supplier["id"], purchaseCost=9999)
        product = db.get(Product, "PRD001")
        db.refresh(product)
        assert float(product.price) == 1000.0

    def test_a_draft_or_out_of_stock_product_can_be_linked(self, client, admin_auth, supplier):
        assert post_link(client, admin_auth, supplier["id"], productId="PRD003").status_code == 201
        assert post_link(client, admin_auth, supplier["id"], productId="PRD004").status_code == 201

    def test_an_inactive_supplier_can_still_be_given_products(self, client, admin_auth, supplier):
        client.post(f"{SUPPLIERS}/{supplier['id']}/status", json={"status": "inactive"}, headers=admin_auth)
        response = post_link(client, admin_auth, supplier["id"])
        assert response.status_code == 201
        assert response.json()["data"]["supplierStatus"] == "inactive"

    def test_the_create_is_audited_against_the_supplier(self, client, admin_auth, supplier, db):
        from app.models import AuditLog

        data = post_link(client, admin_auth, supplier["id"]).json()["data"]
        entry = db.execute(select(AuditLog).where(AuditLog.action == "supplier-product.create")).scalar_one()
        assert entry.resource_type == "supplier-product" and entry.resource_id == str(data["id"])
        assert entry.actor_id == "ADM001" and "Cotton Kurta" in entry.summary
        assert entry.details == {"supplierId": supplier["id"], "productId": "PRD001"}
        assert entry.changes["purchaseCost"] == {"from": None, "to": 450.0}


class TestCreateRefusals:
    def test_the_same_product_twice_is_409(self, client, admin_auth, supplier, db):
        from app.models import SupplierProduct

        post_link(client, admin_auth, supplier["id"])
        response = post_link(client, admin_auth, supplier["id"], purchaseCost=500)
        assert response.status_code == 409
        body = response.json()
        assert body["error_code"] == "SUPPLIER_PRODUCT_EXISTS" and body["details"] == {"field": "productId"}
        assert len(db.execute(select(SupplierProduct)).scalars().all()) == 1

    def test_the_same_product_with_another_supplier_is_fine(self, client, admin_auth, supplier, second):
        post_link(client, admin_auth, supplier["id"])
        assert post_link(client, admin_auth, second["id"]).status_code == 201

    def test_an_unknown_product_is_404(self, client, admin_auth, supplier):
        response = post_link(client, admin_auth, supplier["id"], productId="PRD999")
        assert response.status_code == 404
        assert response.json()["error_code"] == "PRODUCT_NOT_FOUND"

    @pytest.mark.parametrize("product_id", [None, "", "   ", 5])
    def test_a_missing_product_is_refused(self, client, admin_auth, supplier, product_id):
        response = post_link(client, admin_auth, supplier["id"], productId=product_id)
        assert response.status_code == 422
        assert response.json()["error_code"] == "PRODUCT_REQUIRED"

    def test_an_archived_product_is_422(self, client, admin_auth, supplier, db):
        _set_product_status(db, "PRD002", "archived")
        response = post_link(client, admin_auth, supplier["id"], productId="PRD002")
        assert response.status_code == 422
        assert response.json()["error_code"] == "PRODUCT_ARCHIVED"

    def test_an_archived_supplier_is_409(self, client, admin_auth, supplier, db):
        from app.models import SupplierProduct

        client.post(f"{SUPPLIERS}/{supplier['id']}/status", json={"status": "archived"}, headers=admin_auth)
        response = post_link(client, admin_auth, supplier["id"])
        assert response.status_code == 409
        assert response.json()["error_code"] == "SUPPLIER_INACTIVE"
        assert db.execute(select(SupplierProduct)).first() is None


# --------------------------------------------------------------- validation


INVALID = [
    ({"purchaseCost": 0}, "INVALID_PURCHASE_COST", "purchaseCost"),
    ({"purchaseCost": -1}, "INVALID_PURCHASE_COST", "purchaseCost"),
    ({"purchaseCost": 10_000_000.01}, "INVALID_PURCHASE_COST", "purchaseCost"),
    ({"purchaseCost": 0.004}, "INVALID_PURCHASE_COST", "purchaseCost"),  # rounds to 0 paise
    ({"purchaseCost": None}, "INVALID_PURCHASE_COST", "purchaseCost"),
    ({"purchaseCost": "abc"}, "INVALID_PURCHASE_COST", "purchaseCost"),
    ({"purchaseCost": True}, "INVALID_PURCHASE_COST", "purchaseCost"),
    ({"purchaseCost": "NaN"}, "INVALID_PURCHASE_COST", "purchaseCost"),
    ({"moq": 0}, "INVALID_MOQ", "moq"),
    ({"moq": -5}, "INVALID_MOQ", "moq"),
    ({"moq": 1.5}, "INVALID_MOQ", "moq"),
    ({"moq": "ten"}, "INVALID_MOQ", "moq"),
    ({"leadTimeDays": -1}, "INVALID_LEAD_TIME", "leadTimeDays"),
    ({"leadTimeDays": 366}, "INVALID_LEAD_TIME", "leadTimeDays"),
    ({"leadTimeDays": 2.5}, "INVALID_LEAD_TIME", "leadTimeDays"),
    ({"status": "archived"}, "INVALID_STATUS", "status"),
    ({"preferred": "yes"}, "INVALID_FIELD", "preferred"),
    ({"supplierSku": "X" * 61}, "INVALID_FIELD", "supplierSku"),
]


@pytest.mark.parametrize("overrides,code,field", INVALID, ids=[f"{c}-{i}" for i, (_, c, _f) in enumerate(INVALID)])
def test_invalid_link_fields_are_refused(client, admin_auth, supplier, db, overrides, code, field):
    from app.models import SupplierProduct

    response = post_link(client, admin_auth, supplier["id"], **overrides)
    assert response.status_code == 422, response.text
    body = response.json()
    assert body["error_code"] == code and body["details"]["field"] == field
    assert db.execute(select(SupplierProduct)).first() is None


@pytest.mark.parametrize("cost,paise", [(0.01, 1), (10_000_000, 1_000_000_000), (1, 100)])
def test_purchase_cost_boundaries_are_accepted(client, admin_auth, supplier, db, cost, paise):
    from app.models import SupplierProduct

    data = post_link(client, admin_auth, supplier["id"], purchaseCost=cost).json()["data"]
    assert data["purchaseCost"] == cost
    assert db.get(SupplierProduct, data["id"]).purchase_cost == paise


@pytest.mark.parametrize("days", [0, 365, None])
def test_lead_time_boundaries_and_null_are_accepted(client, admin_auth, supplier, days):
    response = post_link(client, admin_auth, supplier["id"], leadTimeDays=days)
    assert response.status_code == 201, response.text
    assert response.json()["data"]["leadTimeDays"] == days


def test_a_moq_of_one_is_accepted(client, admin_auth, supplier):
    assert post_link(client, admin_auth, supplier["id"], moq=1).json()["data"]["moq"] == 1


# --------------------------------------------------------------------- lists


class TestLists:
    def test_a_suppliers_products(self, client, admin_auth, supplier):
        link(client, admin_auth, supplier["id"], "PRD002")
        link(client, admin_auth, supplier["id"], "PRD001")
        response = client.get(f"{SUPPLIERS}/{supplier['id']}/products", headers=admin_auth)
        assert response.status_code == 200
        data = response.json()["data"]
        # By product name: Cotton Kurta before Linen Shirt.
        assert [row["productId"] for row in data] == ["PRD001", "PRD002"]
        assert all(row["supplierId"] == supplier["id"] for row in data)

    def test_the_preferred_link_comes_first(self, client, admin_auth, supplier):
        link(client, admin_auth, supplier["id"], "PRD001")
        link(client, admin_auth, supplier["id"], "PRD002", preferred=True)
        data = client.get(f"{SUPPLIERS}/{supplier['id']}/products", headers=admin_auth).json()["data"]
        assert [row["productId"] for row in data] == ["PRD002", "PRD001"]

    def test_a_supplier_with_nothing_is_an_empty_list(self, client, admin_auth, supplier):
        assert client.get(f"{SUPPLIERS}/{supplier['id']}/products", headers=admin_auth).json()["data"] == []

    def test_a_products_suppliers(self, client, admin_auth, supplier, second):
        link(client, admin_auth, supplier["id"], "PRD001", cost=450)
        link(client, admin_auth, second["id"], "PRD001", cost=430, preferred=True)
        link(client, admin_auth, second["id"], "PRD002")
        response = client.get("/api/admin/products/PRD001/suppliers", headers=admin_auth)
        assert response.status_code == 200
        data = response.json()["data"]
        assert [(row["supplierId"], row["purchaseCost"], row["preferred"]) for row in data] == [
            (second["id"], 430.0, True), (supplier["id"], 450.0, False)]
        assert data[0]["supplierName"] == "Meridian Audio" and data[0]["productName"] == "Cotton Kurta"

    def test_an_unknown_products_suppliers_is_404(self, client, admin_auth, supplier):
        response = client.get("/api/admin/products/PRD999/suppliers", headers=admin_auth)
        assert response.status_code == 404 and response.json()["error_code"] == "PRODUCT_NOT_FOUND"

    def test_the_rows_show_current_statuses(self, client, admin_auth, supplier, db):
        link(client, admin_auth, supplier["id"], "PRD001")
        client.post(f"{SUPPLIERS}/{supplier['id']}/status", json={"status": "inactive"}, headers=admin_auth)
        _set_product_status(db, "PRD001", "archived")
        row = client.get("/api/admin/products/PRD001/suppliers", headers=admin_auth).json()["data"][0]
        assert row["supplierStatus"] == "inactive" and row["productStatus"] == "archived"


# ------------------------------------------------------------ update/delete


class TestUpdate:
    def test_updates_the_terms(self, client, admin_auth, supplier, db):
        from app.models import SupplierProduct

        made = link(client, admin_auth, supplier["id"], "PRD001")
        response = client.put(f"{LINKS}/{made['id']}", json={"purchaseCost": 475.25, "moq": 20, "leadTimeDays": None,
                                                             "status": "inactive", "supplierSku": "NEW-SKU"},
                              headers=admin_auth)
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["purchaseCost"] == 475.25 and data["moq"] == 20 and data["leadTimeDays"] is None
        assert data["status"] == "inactive" and data["supplierSku"] == "NEW-SKU"
        assert db.get(SupplierProduct, made["id"]).purchase_cost == 47525

    def test_a_partial_update_keeps_the_rest(self, client, admin_auth, supplier):
        made = link(client, admin_auth, supplier["id"], "PRD001", cost=450, moq=10, leadTimeDays=7)
        data = client.put(f"{LINKS}/{made['id']}", json={"notes": "Call first"}, headers=admin_auth).json()["data"]
        assert data["notes"] == "Call first" and data["purchaseCost"] == 450.0
        assert data["moq"] == 10 and data["leadTimeDays"] == 7

    def test_the_product_and_supplier_cannot_be_moved(self, client, admin_auth, supplier, second):
        made = link(client, admin_auth, supplier["id"], "PRD001")
        data = client.put(f"{LINKS}/{made['id']}", json={"productId": "PRD002", "supplierId": second["id"]},
                          headers=admin_auth).json()["data"]
        assert data["productId"] == "PRD001" and data["supplierId"] == supplier["id"]

    @pytest.mark.parametrize("overrides,code", [
        ({"purchaseCost": 0}, "INVALID_PURCHASE_COST"),
        ({"purchaseCost": 10_000_001}, "INVALID_PURCHASE_COST"),
        ({"moq": 0}, "INVALID_MOQ"),
        ({"leadTimeDays": 400}, "INVALID_LEAD_TIME"),
        ({"status": "deleted"}, "INVALID_STATUS"),
    ])
    def test_update_validates_like_create(self, client, admin_auth, supplier, db, overrides, code):
        from app.models import SupplierProduct

        made = link(client, admin_auth, supplier["id"], "PRD001", cost=450)
        response = client.put(f"{LINKS}/{made['id']}", json=overrides, headers=admin_auth)
        assert response.status_code == 422 and response.json()["error_code"] == code
        row = db.get(SupplierProduct, made["id"])
        db.refresh(row)
        assert row.purchase_cost == 45000 and row.moq == 1

    def test_an_unknown_link_is_404(self, client, admin_auth, supplier):
        for method in ("PUT", "DELETE"):
            response = client.request(method, f"{LINKS}/99999", json={"notes": "x"}, headers=admin_auth)
            assert response.status_code == 404, method
            assert response.json()["error_code"] == "SUPPLIER_PRODUCT_NOT_FOUND"

    def test_the_update_is_audited_with_what_changed(self, client, admin_auth, supplier, db):
        from app.models import AuditLog

        made = link(client, admin_auth, supplier["id"], "PRD001", cost=450)
        client.put(f"{LINKS}/{made['id']}", json={"purchaseCost": 500}, headers=admin_auth)
        entry = db.execute(select(AuditLog).where(AuditLog.action == "supplier-product.update")).scalar_one()
        assert entry.changes == {"purchaseCost": {"from": 450.0, "to": 500.0}}
        assert entry.details["supplierId"] == supplier["id"]

    def test_an_update_that_changes_nothing_is_not_audited(self, client, admin_auth, supplier, db):
        from app.models import AuditLog

        made = link(client, admin_auth, supplier["id"], "PRD001", cost=450)
        client.put(f"{LINKS}/{made['id']}", json={"purchaseCost": 450}, headers=admin_auth)
        assert db.execute(select(AuditLog).where(AuditLog.action == "supplier-product.update")).first() is None


class TestDelete:
    def test_removes_the_link(self, client, admin_auth, supplier, db):
        from app.models import AuditLog, SupplierProduct

        made = link(client, admin_auth, supplier["id"], "PRD001")
        response = client.delete(f"{LINKS}/{made['id']}", headers=admin_auth)
        assert response.status_code == 200 and response.json()["success"] is True
        assert db.get(SupplierProduct, made["id"]) is None
        assert client.get(f"{SUPPLIERS}/{supplier['id']}/products", headers=admin_auth).json()["data"] == []
        entry = db.execute(select(AuditLog).where(AuditLog.action == "supplier-product.delete")).scalar_one()
        assert entry.details == {"supplierId": supplier["id"], "productId": "PRD001"}

    def test_the_product_can_be_linked_again_afterwards(self, client, admin_auth, supplier):
        made = link(client, admin_auth, supplier["id"], "PRD001")
        client.delete(f"{LINKS}/{made['id']}", headers=admin_auth)
        assert post_link(client, admin_auth, supplier["id"]).status_code == 201

    def test_a_purchase_order_keeps_its_lines_after_the_link_goes(self, client, admin_auth, supplier):
        made = link(client, admin_auth, supplier["id"], "PRD001", cost=450, supplierSku="AT-K-01")
        po = make_po(client, admin_auth, supplier["id"], [{"productId": "PRD001", "quantity": 5}])
        client.delete(f"{LINKS}/{made['id']}", headers=admin_auth)
        again = client.get(f"/api/admin/purchase-orders/{po['id']}", headers=admin_auth).json()["data"]
        assert again["items"][0]["unitCost"] == 450.0 and again["items"][0]["supplierSku"] == "AT-K-01"


# ---------------------------------------------------------------- preferred


class TestPreferred:
    def _preferred(self, client, headers, product_id="PRD001"):
        rows = client.get(f"/api/admin/products/{product_id}/suppliers", headers=headers).json()["data"]
        return {row["supplierId"]: row["preferred"] for row in rows}

    def test_marking_one_preferred_on_create_clears_the_others(self, client, admin_auth, supplier, second):
        link(client, admin_auth, supplier["id"], "PRD001", preferred=True)
        link(client, admin_auth, second["id"], "PRD001", preferred=True)
        assert self._preferred(client, admin_auth) == {supplier["id"]: False, second["id"]: True}

    def test_marking_one_preferred_on_update_clears_the_others(self, client, admin_auth, supplier, second):
        link(client, admin_auth, supplier["id"], "PRD001", preferred=True)
        other = link(client, admin_auth, second["id"], "PRD001")
        client.put(f"{LINKS}/{other['id']}", json={"preferred": True}, headers=admin_auth)
        assert self._preferred(client, admin_auth) == {supplier["id"]: False, second["id"]: True}

    def test_other_products_keep_their_preferred_supplier(self, client, admin_auth, supplier, second):
        link(client, admin_auth, supplier["id"], "PRD002", preferred=True)
        link(client, admin_auth, second["id"], "PRD001", preferred=True)
        assert self._preferred(client, admin_auth, "PRD002") == {supplier["id"]: True}

    def test_a_link_that_is_not_preferred_leaves_the_preferred_one_alone(self, client, admin_auth, supplier,
                                                                         second):
        link(client, admin_auth, supplier["id"], "PRD001", preferred=True)
        link(client, admin_auth, second["id"], "PRD001", preferred=False)
        assert self._preferred(client, admin_auth) == {supplier["id"]: True, second["id"]: False}

    def test_unmarking_leaves_no_preferred_supplier(self, client, admin_auth, supplier):
        made = link(client, admin_auth, supplier["id"], "PRD001", preferred=True)
        client.put(f"{LINKS}/{made['id']}", json={"preferred": False}, headers=admin_auth)
        assert self._preferred(client, admin_auth) == {supplier["id"]: False}


# -------------------------------------------------------------- permissions


class TestPermissions:
    def test_no_token_is_401(self, client, catalogue):
        for method, path in (("GET", f"{SUPPLIERS}/SUP001/products"), ("POST", f"{SUPPLIERS}/SUP001/products"),
                             ("PUT", f"{LINKS}/1"), ("DELETE", f"{LINKS}/1"),
                             ("GET", "/api/admin/products/PRD001/suppliers")):
            assert client.request(method, path, json=link_body()).status_code == 401, (method, path)

    def test_a_customer_is_403(self, client, auth, supplier):
        for method, path in (("GET", f"{SUPPLIERS}/{supplier['id']}/products"),
                             ("POST", f"{SUPPLIERS}/{supplier['id']}/products"),
                             ("PUT", f"{LINKS}/1"), ("DELETE", f"{LINKS}/1"),
                             ("GET", "/api/admin/products/PRD001/suppliers")):
            assert client.request(method, path, json=link_body(), headers=auth).status_code == 403, (method, path)

    @pytest.mark.parametrize("role", ["editor", "staff"])
    def test_roles_without_the_permission_are_refused(self, client, admin_auth, supplier, db, role):
        from app.models import SupplierProduct

        made = link(client, admin_auth, supplier["id"], "PRD001")
        headers = role_headers(db, "ADM060", role, ["products", "orders", "purchasing"])
        for method, path in (("GET", f"{SUPPLIERS}/{supplier['id']}/products"),
                             ("POST", f"{SUPPLIERS}/{supplier['id']}/products"),
                             ("PUT", f"{LINKS}/{made['id']}"), ("DELETE", f"{LINKS}/{made['id']}"),
                             ("GET", "/api/admin/products/PRD001/suppliers")):
            response = client.request(method, path, json=link_body("PRD002"), headers=headers)
            assert response.status_code == 403, (role, method, path)
            assert response.json()["error_code"] == "PERMISSION_DENIED"
        assert db.get(SupplierProduct, made["id"]) is not None

    def test_a_manager_may_manage_links(self, client, supplier, db):
        headers = role_headers(db, "ADM061", "manager", [])
        made = post_link(client, headers, supplier["id"])
        assert made.status_code == 201, made.text
        link_id = made.json()["data"]["id"]
        assert client.put(f"{LINKS}/{link_id}", json={"moq": 3}, headers=headers).status_code == 200
        assert client.delete(f"{LINKS}/{link_id}", headers=headers).status_code == 200


# ----------------------------------------------------- supplier detail page


class TestSupplierDetail:
    def _detail(self, client, headers, supplier_id):
        response = client.get(f"{SUPPLIERS}/{supplier_id}", headers=headers)
        assert response.status_code == 200, response.text
        return response.json()["data"]

    def test_a_new_supplier_has_zero_figures(self, client, admin_auth, supplier):
        stats = self._detail(client, admin_auth, supplier["id"])["stats"]
        assert stats == {"productCount": 0, "activeProductCount": 0, "poCount": 0, "openPoCount": 0,
                         "receivedPoCount": 0, "totalPurchaseValue": 0.0, "outstandingQuantity": 0,
                         "averageLeadTimeDays": None, "onTimeRate": None}

    def test_product_counts_follow_the_links(self, client, admin_auth, supplier):
        link(client, admin_auth, supplier["id"], "PRD001")
        link(client, admin_auth, supplier["id"], "PRD002", status="inactive")
        stats = self._detail(client, admin_auth, supplier["id"])["stats"]
        assert stats["productCount"] == 2 and stats["activeProductCount"] == 1

    def test_po_figures(self, client, admin_auth, supplier):
        link(client, admin_auth, supplier["id"], "PRD001", cost=100)
        link(client, admin_auth, supplier["id"], "PRD002", cost=200)
        # A draft (not yet committed), a cancelled one, and a sent one partly received.
        make_po(client, admin_auth, supplier["id"], [{"productId": "PRD001", "quantity": 1}])
        cancelled = make_po(client, admin_auth, supplier["id"], [{"productId": "PRD001", "quantity": 1}])
        client.post(f"/api/admin/purchase-orders/{cancelled['id']}/cancel", json={"reason": "Dup"},
                    headers=admin_auth)
        po = make_po(client, admin_auth, supplier["id"], [{"productId": "PRD001", "quantity": 10},
                                                          {"productId": "PRD002", "quantity": 5}])
        po = advance(client, admin_auth, po["id"], "submit", "send")
        receive(client, admin_auth, po["id"], [{"poItemId": item_for(po, "PRD001")["id"], "receivedQty": 4}],
                "detail-1")
        stats = self._detail(client, admin_auth, supplier["id"])["stats"]
        assert stats["poCount"] == 3 and stats["openPoCount"] == 2 and stats["receivedPoCount"] == 0
        # 10 x 100 + 5 x 200 = 2000, plus 5% GST: only the committed PO counts.
        assert stats["totalPurchaseValue"] == 2100.0
        assert stats["outstandingQuantity"] == 6 + 5

    def test_performance_figures_need_three_received_pos(self, client, admin_auth, supplier):
        link(client, admin_auth, supplier["id"], "PRD001", cost=100)
        expected = (datetime.utcnow().date() + timedelta(days=10)).isoformat()
        for number in range(3):
            po = make_po(client, admin_auth, supplier["id"], [{"productId": "PRD001", "quantity": 2}],
                         expectedAt=expected)
            po = advance(client, admin_auth, po["id"], "submit", "send")
            response = receive(client, admin_auth, po["id"],
                               [{"poItemId": po["items"][0]["id"], "receivedQty": 2}], f"perf-{number}")
            assert response.status_code == 201, response.text
            stats = self._detail(client, admin_auth, supplier["id"])["stats"]
            if number < 2:
                assert stats["averageLeadTimeDays"] is None and stats["onTimeRate"] is None
        assert stats["receivedPoCount"] == 3
        assert stats["averageLeadTimeDays"] == 0.0 and stats["onTimeRate"] == 100.0

    def test_recent_deliveries_are_the_last_five_receipts(self, client, admin_auth, supplier):
        link(client, admin_auth, supplier["id"], "PRD001", cost=100)
        po = make_po(client, admin_auth, supplier["id"], [{"productId": "PRD001", "quantity": 100}])
        po = advance(client, admin_auth, po["id"], "submit", "send")
        line = po["items"][0]["id"]
        for number in range(6):
            receive(client, admin_auth, po["id"], [{"poItemId": line, "receivedQty": 2, "damagedQty": 1}],
                    f"recent-{number}")
        deliveries = self._detail(client, admin_auth, supplier["id"])["recentDeliveries"]
        assert len(deliveries) == 5
        assert deliveries[0]["receiptNumber"].endswith("000006")
        assert deliveries[0]["poNumber"] == po["poNumber"] and deliveries[0]["purchaseOrderId"] == po["id"]
        assert (deliveries[0]["receivedQty"], deliveries[0]["damagedQty"], deliveries[0]["acceptedQty"]) == (2, 1, 1)

    def test_history_merges_audit_and_po_events_newest_first(self, client, admin_auth, supplier):
        link(client, admin_auth, supplier["id"], "PRD001", cost=100)
        po = make_po(client, admin_auth, supplier["id"], [{"productId": "PRD001", "quantity": 1}])
        advance(client, admin_auth, po["id"], "submit")
        history = self._detail(client, admin_auth, supplier["id"])["history"]
        actions = [entry["action"] for entry in history]
        assert "supplier.create" in actions and "supplier-product.create" in actions
        assert "purchase-order.draft" in actions and "purchase-order.submitted" in actions
        assert all(set(entry) == {"at", "action", "summary", "actor"} for entry in history)
        assert [entry["at"] for entry in history] == sorted((entry["at"] for entry in history), reverse=True)
        submitted = next(entry for entry in history if entry["action"] == "purchase-order.submitted")
        assert po["poNumber"] in submitted["summary"] and submitted["actor"] == "ADM001"

    def test_history_holds_only_this_suppliers_entries(self, client, admin_auth, supplier, second):
        link(client, admin_auth, second["id"], "PRD001")
        history = self._detail(client, admin_auth, supplier["id"])["history"]
        assert [entry["action"] for entry in history] == ["supplier.create"]
