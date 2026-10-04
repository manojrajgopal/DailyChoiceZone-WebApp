"""
Purchase orders through the API, short of receiving goods (that is
test_purchase_orders_receiving.py): creating and editing drafts, the numbers,
tax worked out on the server, the status flow and its refusals, cancelling,
the list, the actions each status allows, the timeline, the audit trail and
who may do any of it.
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
    sent_po,
    supplier,
)

pytestmark = pytest.mark.integration

BASE = "/api/admin/purchase-orders"


def year() -> int:
    return datetime.utcnow().year


def create(client, headers, supplier_id, items, **overrides):
    body = {"supplierId": supplier_id, "items": items}
    body.update(overrides)
    return client.post(BASE, json=body, headers=headers)


def act(client, headers, po_id, action, body=None):
    return client.post(f"{BASE}/{po_id}/{action}", json=body if body is not None else {}, headers=headers)


@pytest.fixture()
def linked(client, admin_auth, supplier):
    """The Karnataka supplier with PRD001 at 450 (MOQ 10) and PRD003 at 2000."""
    link(client, admin_auth, supplier["id"], "PRD001", cost=450.0, moq=10, supplierSku="AT-K-01")
    link(client, admin_auth, supplier["id"], "PRD003", cost=2000.0)
    return supplier


@pytest.fixture()
def draft(client, admin_auth, linked):
    return make_po(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 50}])


def _supplier_in(client, headers, state: str, code: str, **overrides) -> dict:
    address = {"line1": "1 Road", "line2": "", "city": "City", "state": state, "country": "India",
               "pincode": "400001"}
    return make_supplier(client, headers, code=code, name=f"{code} Ltd", billingAddress=address, **overrides)


# ------------------------------------------------------------------- create


class TestCreate:
    def test_creates_a_draft_with_costs_from_the_supplier_link(self, client, admin_auth, linked):
        response = create(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 50}],
                          supplierReference="Q-881", notes="Festive stock")
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["success"] is True
        po = body["data"]
        assert po["id"] == "POR001" and po["status"] == "draft" and po["statusLabel"] == "Draft"
        assert po["supplier"]["id"] == linked["id"] and po["supplier"]["code"] == "ANVI-TEX"
        assert po["supplier"]["state"] == "Karnataka" and po["supplier"]["status"] == "active"
        assert po["currency"] == "INR" and po["taxMode"] == "intra-state"
        assert po["supplierReference"] == "Q-881" and po["notes"] == "Festive stock"
        assert po["createdBy"] == "ADM001" and po["createdAt"] and po["updatedAt"]
        assert po["expectedAt"] is None and po["receipts"] == []
        (item,) = po["items"]
        # The spec's own worked example.
        assert item["productId"] == "PRD001" and item["name"] == "Cotton Kurta" and item["sku"] == "DCZ-WO0001"
        assert item["supplierSku"] == "AT-K-01" and item["quantity"] == 50
        assert item["unitCost"] == 450.0 and item["taxRate"] == 5.0
        assert item["lineSubtotal"] == 22500.0 and item["lineTax"] == 1125.0 and item["lineTotal"] == 23625.0
        assert (item["receivedQty"], item["damagedQty"], item["rejectedQty"]) == (0, 0, 0)
        assert item["acceptedQty"] == 0 and item["outstandingQty"] == 50
        assert (po["subtotal"], po["cgst"], po["sgst"], po["igst"]) == (22500.0, 562.5, 562.5, 0)
        assert po["taxTotal"] == 1125.0 and po["total"] == 23625.0

    def test_money_is_stored_in_paise(self, client, admin_auth, draft, db):
        from app.models import PurchaseOrder, PurchaseOrderItem

        po = db.get(PurchaseOrder, draft["id"])
        assert (po.subtotal, po.cgst, po.sgst, po.igst, po.tax_total, po.total) == (
            2250000, 56250, 56250, 0, 112500, 2362500)
        item = db.execute(select(PurchaseOrderItem).where(PurchaseOrderItem.purchase_order_id == po.id)).scalar_one()
        assert (item.unit_cost, item.line_subtotal, item.line_tax, item.line_total) == (45000, 2250000, 112500,
                                                                                       2362500)

    def test_an_explicit_unit_cost_overrides_the_link(self, client, admin_auth, linked):
        po = make_po(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 10, "unitCost": 400}])
        assert po["items"][0]["unitCost"] == 400.0 and po["subtotal"] == 4000.0

    def test_an_unlinked_product_needs_a_unit_cost(self, client, admin_auth, linked, db):
        from app.models import PurchaseOrder

        response = create(client, admin_auth, linked["id"], [{"productId": "PRD002", "quantity": 5}])
        assert response.status_code == 422
        body = response.json()
        assert body["error_code"] == "UNIT_COST_REQUIRED" and body["details"]["field"] == "items[0].unitCost"
        assert db.execute(select(PurchaseOrder)).first() is None

    def test_an_unlinked_product_with_a_unit_cost_is_fine(self, client, admin_auth, linked):
        po = make_po(client, admin_auth, linked["id"], [{"productId": "PRD002", "quantity": 5, "unitCost": 900}])
        assert po["items"][0]["unitCost"] == 900.0 and po["items"][0]["supplierSku"] == ""

    @pytest.mark.parametrize("items", [[], None])
    def test_no_items_is_refused(self, client, admin_auth, linked, items):
        response = create(client, admin_auth, linked["id"], items)
        assert response.status_code == 422 and response.json()["error_code"] == "NO_ITEMS"

    def test_the_same_product_twice_is_refused(self, client, admin_auth, linked):
        response = create(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 10},
                                                             {"productId": "PRD001", "quantity": 5}])
        assert response.status_code == 422
        body = response.json()
        assert body["error_code"] == "DUPLICATE_ITEM" and body["details"]["field"] == "items[1].productId"

    def test_below_the_moq_is_allowed_with_a_warning(self, client, admin_auth, linked):
        response = create(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 4}])
        assert response.status_code == 201, response.text
        (warning,) = response.json()["data"]["warnings"]
        assert warning["code"] == "BELOW_MOQ" and warning["productId"] == "PRD001"
        assert warning["moq"] == 10 and warning["quantity"] == 4

    def test_at_the_moq_there_is_no_warning(self, client, admin_auth, linked):
        assert make_po(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 10}])["warnings"] == []

    @pytest.mark.parametrize("quantity", [0, -1, 1_000_001, 1.5, "ten", None, True])
    def test_quantity_out_of_range_is_refused(self, client, admin_auth, linked, quantity):
        response = create(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": quantity}])
        assert response.status_code == 422, quantity
        body = response.json()
        assert body["error_code"] == "INVALID_QUANTITY" and body["details"]["field"] == "items[0].quantity"

    @pytest.mark.parametrize("quantity", [1, 1_000_000])
    def test_quantity_boundaries_are_accepted(self, client, admin_auth, linked, quantity):
        po = make_po(client, admin_auth, linked["id"], [{"productId": "PRD003", "quantity": quantity}])
        assert po["items"][0]["quantity"] == quantity

    @pytest.mark.parametrize("cost", [0, -5, 10_000_000.5, "abc"])
    def test_an_invalid_unit_cost_is_refused(self, client, admin_auth, linked, cost):
        response = create(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 10,
                                                             "unitCost": cost}])
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_UNIT_COST"

    def test_an_archived_product_is_refused(self, client, admin_auth, linked, db):
        from app.models import Product

        db.get(Product, "PRD001").status = "archived"
        db.flush()
        response = create(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 10}])
        assert response.status_code == 422
        assert response.json()["error_code"] == "PRODUCT_ARCHIVED"

    def test_an_unknown_product_is_404(self, client, admin_auth, linked):
        response = create(client, admin_auth, linked["id"], [{"productId": "PRD999", "quantity": 1,
                                                             "unitCost": 10}])
        assert response.status_code == 404 and response.json()["error_code"] == "PRODUCT_NOT_FOUND"

    @pytest.mark.parametrize("status", ["inactive", "archived"])
    def test_an_inactive_or_archived_supplier_is_refused(self, client, admin_auth, linked, status, db):
        from app.models import PurchaseOrder

        client.post(f"/api/admin/suppliers/{linked['id']}/status", json={"status": status}, headers=admin_auth)
        response = create(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 10}])
        assert response.status_code == 409
        assert response.json()["error_code"] == "SUPPLIER_INACTIVE"
        assert db.execute(select(PurchaseOrder)).first() is None

    def test_an_unknown_or_missing_supplier_is_refused(self, client, admin_auth, linked):
        response = create(client, admin_auth, "SUP999", [{"productId": "PRD001", "quantity": 10}])
        assert response.status_code == 404 and response.json()["error_code"] == "SUPPLIER_NOT_FOUND"
        response = client.post(BASE, json={"items": [{"productId": "PRD001", "quantity": 10}]}, headers=admin_auth)
        assert response.status_code == 422 and response.json()["error_code"] == "SUPPLIER_REQUIRED"

    def test_an_expected_date_is_kept_as_a_date(self, client, admin_auth, linked):
        expected = (datetime.utcnow().date() + timedelta(days=14)).isoformat()
        po = make_po(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 10}],
                     expectedAt=expected)
        assert po["expectedAt"] == expected

    def test_a_nonsense_expected_date_is_refused(self, client, admin_auth, linked):
        response = create(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 10}],
                          expectedAt="next week")
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_DATE"


# ---------------------------------------------------------------- numbering


class TestNumbering:
    def test_po_numbers_and_ids_run_in_sequence(self, client, admin_auth, linked):
        first = make_po(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 10}])
        second = make_po(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 10}])
        assert first["poNumber"] == f"DCZ-PO-{year()}-000001" and first["id"] == "POR001"
        assert second["poNumber"] == f"DCZ-PO-{year()}-000002" and second["id"] == "POR002"

    def test_a_refused_po_uses_no_number(self, client, admin_auth, linked):
        create(client, admin_auth, linked["id"], [{"productId": "PRD002", "quantity": 1}])  # UNIT_COST_REQUIRED
        po = make_po(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 10}])
        assert po["poNumber"].endswith("-000001")


# ---------------------------------------------------------------------- tax


class TestTax:
    def test_two_lines_add_up(self, client, admin_auth, linked):
        po = make_po(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 50},
                                                        {"productId": "PRD003", "quantity": 10}])
        # 50 x 450 + 10 x 2000 = 42500, at 5%.
        assert po["subtotal"] == 42500.0 and po["taxTotal"] == 2125.0 and po["total"] == 44625.0
        assert po["cgst"] == po["sgst"] == 1062.5 and po["igst"] == 0
        assert sum(item["lineTotal"] for item in po["items"]) == po["total"]

    def test_inter_state_is_igst(self, client, admin_auth, supplier):
        other = _supplier_in(client, admin_auth, "Maharashtra", "MAHA", gstin=gstin("27", "AAACR5055K"),
                             pan="AAACR5055K")
        link(client, admin_auth, other["id"], "PRD001", cost=450.0)
        po = make_po(client, admin_auth, other["id"], [{"productId": "PRD001", "quantity": 50}])
        assert po["taxMode"] == "inter-state" and po["supplier"]["state"] == "Maharashtra"
        assert (po["cgst"], po["sgst"], po["igst"]) == (0, 0, 1125.0)
        assert po["taxTotal"] == 1125.0 and po["total"] == 23625.0

    def test_the_state_is_matched_regardless_of_case(self, client, admin_auth, supplier):
        other = _supplier_in(client, admin_auth, "  karnataka ", "KA-LOWER", gstin=gstin("29", "AAACR5055K"),
                             pan="AAACR5055K")
        link(client, admin_auth, other["id"], "PRD001", cost=100.0)
        po = make_po(client, admin_auth, other["id"], [{"productId": "PRD001", "quantity": 1}])
        assert po["taxMode"] == "intra-state"

    # A composition dealer is GST-registered (so has a GSTIN) but issues a bill
    # of supply, so it charges no GST either.
    @pytest.mark.parametrize("treatment,tax_id", [("unregistered", None), ("overseas", None),
                                                  ("composition", gstin("29", "AAACR5055K"))])
    def test_a_supplier_that_cannot_charge_gst_gets_none(self, client, admin_auth, supplier, treatment, tax_id):
        other = make_supplier(client, admin_auth, code=f"NO-{treatment[:4].upper()}", name="No GST",
                              gstin=tax_id, pan=tax_id[2:12] if tax_id else None, taxTreatment=treatment)
        link(client, admin_auth, other["id"], "PRD001", cost=450.0)
        # Even an explicit rate is not charged.
        po = make_po(client, admin_auth, other["id"], [{"productId": "PRD001", "quantity": 50, "taxRate": 18}])
        assert po["taxMode"] == "none"
        assert (po["cgst"], po["sgst"], po["igst"], po["taxTotal"]) == (0, 0, 0, 0)
        assert po["total"] == po["subtotal"] == 22500.0
        assert po["items"][0]["taxRate"] == 0 and po["items"][0]["lineTax"] == 0

    def test_tax_switched_off_in_settings_means_none(self, client, admin_auth, linked, db):
        from app.models import SettingDocument

        document = db.execute(select(SettingDocument).where(SettingDocument.key == "tax")).scalar_one()
        document.value = {**document.value, "enabled": False}
        db.flush()
        po = make_po(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 10}])
        assert po["taxMode"] == "none" and po["taxTotal"] == 0

    def test_the_rate_defaults_to_the_products_own(self, client, admin_auth, linked, db):
        from app.models import Product

        db.get(Product, "PRD003").tax_rate_percent = 18
        db.flush()
        po = make_po(client, admin_auth, linked["id"], [{"productId": "PRD003", "quantity": 10}])
        # 10 x 2000 = 20000 at 18% = 3600, halved.
        assert po["items"][0]["taxRate"] == 18.0 and po["taxTotal"] == 3600.0
        assert po["cgst"] == po["sgst"] == 1800.0

    def test_an_explicit_rate_is_used(self, client, admin_auth, linked):
        po = make_po(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 10, "taxRate": 12}])
        assert po["items"][0]["taxRate"] == 12.0 and po["taxTotal"] == 540.0

    def test_a_zero_rate_is_allowed(self, client, admin_auth, linked):
        po = make_po(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 10, "taxRate": 0}])
        assert po["taxTotal"] == 0 and po["total"] == 4500.0

    @pytest.mark.parametrize("rate", [-1, 100.5, "abc"])
    def test_an_invalid_rate_is_refused(self, client, admin_auth, linked, rate):
        response = create(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 10,
                                                             "taxRate": rate}])
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_TAX_RATE"

    def test_an_odd_paisa_of_tax_still_splits_exactly(self, client, admin_auth, linked):
        # 30.10 at 5% is 150.5 paise -> 151; the halves are 76 + 75.
        po = make_po(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 1, "unitCost": 30.10}])
        assert po["taxTotal"] == 1.51 and po["cgst"] == 0.76 and po["sgst"] == 0.75
        assert round(po["cgst"] + po["sgst"], 2) == po["taxTotal"]

    def test_totals_sent_by_the_client_are_ignored(self, client, admin_auth, linked, db):
        from app.models import PurchaseOrder

        response = create(client, admin_auth, linked["id"],
                          [{"productId": "PRD001", "quantity": 50, "lineSubtotal": 1, "lineTax": 0, "lineTotal": 1,
                            "receivedQty": 50}],
                          subtotal=1, cgst=0, sgst=0, igst=0, taxTotal=0, total=1, taxMode="none",
                          status="received", poNumber="HACKED-1")
        assert response.status_code == 201, response.text
        po = response.json()["data"]
        assert po["subtotal"] == 22500.0 and po["total"] == 23625.0 and po["taxMode"] == "intra-state"
        assert po["status"] == "draft" and po["poNumber"].startswith("DCZ-PO-")
        assert po["items"][0]["receivedQty"] == 0
        assert db.get(PurchaseOrder, po["id"]).total == 2362500


# --------------------------------------------------------------------- edit


class TestEdit:
    def test_a_draft_can_be_edited_and_totals_are_recalculated(self, client, admin_auth, draft):
        response = client.put(f"{BASE}/{draft['id']}", json={
            "items": [{"productId": "PRD001", "quantity": 20}, {"productId": "PRD003", "quantity": 2}],
            "notes": "Revised", "supplierReference": "Q-900",
        }, headers=admin_auth)
        assert response.status_code == 200, response.text
        po = response.json()["data"]
        assert [(i["productId"], i["quantity"]) for i in po["items"]] == [("PRD001", 20), ("PRD003", 2)]
        # 20 x 450 + 2 x 2000 = 13000 at 5%.
        assert po["subtotal"] == 13000.0 and po["taxTotal"] == 650.0 and po["total"] == 13650.0
        assert po["notes"] == "Revised" and po["supplierReference"] == "Q-900"
        assert po["poNumber"] == draft["poNumber"] and po["status"] == "draft"

    def test_a_line_left_out_is_removed(self, client, admin_auth, linked, db):
        from app.models import PurchaseOrderItem

        po = make_po(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 10},
                                                        {"productId": "PRD003", "quantity": 1}])
        edited = client.put(f"{BASE}/{po['id']}", json={"items": [{"productId": "PRD003", "quantity": 3}]},
                            headers=admin_auth).json()["data"]
        assert [i["productId"] for i in edited["items"]] == ["PRD003"] and edited["subtotal"] == 6000.0
        rows = db.execute(select(PurchaseOrderItem).where(PurchaseOrderItem.purchase_order_id == po["id"])).all()
        assert len(rows) == 1

    def test_an_edit_without_items_keeps_the_lines(self, client, admin_auth, draft):
        po = client.put(f"{BASE}/{draft['id']}", json={"notes": "Just a note"}, headers=admin_auth).json()["data"]
        assert po["items"][0]["quantity"] == 50 and po["total"] == 23625.0 and po["notes"] == "Just a note"

    def test_an_edit_keeps_an_explicit_unit_cost(self, client, admin_auth, linked):
        po = make_po(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 10, "unitCost": 400}])
        edited = client.put(f"{BASE}/{po['id']}", json={"notes": "x"}, headers=admin_auth).json()["data"]
        assert edited["items"][0]["unitCost"] == 400.0

    def test_an_edit_validates_like_create(self, client, admin_auth, draft):
        for body, code in (({"items": []}, "NO_ITEMS"),
                           ({"items": [{"productId": "PRD001", "quantity": 0}]}, "INVALID_QUANTITY"),
                           ({"items": [{"productId": "PRD002", "quantity": 1}]}, "UNIT_COST_REQUIRED"),
                           ({"items": [{"productId": "PRD001", "quantity": 1}, {"productId": "PRD001",
                                                                                "quantity": 1}]}, "DUPLICATE_ITEM")):
            response = client.put(f"{BASE}/{draft['id']}", json=body, headers=admin_auth)
            assert response.status_code == 422 and response.json()["error_code"] == code, code
        again = client.get(f"{BASE}/{draft['id']}", headers=admin_auth).json()["data"]
        assert again["items"][0]["quantity"] == 50

    def test_moving_a_draft_to_an_inter_state_supplier_recalculates_the_tax(self, client, admin_auth, draft):
        other = _supplier_in(client, admin_auth, "Maharashtra", "MAHA", gstin=gstin("27", "AAACR5055K"),
                             pan="AAACR5055K")
        po = client.put(f"{BASE}/{draft['id']}", json={"supplierId": other["id"]}, headers=admin_auth).json()["data"]
        assert po["supplier"]["id"] == other["id"] and po["taxMode"] == "inter-state"
        assert po["igst"] == 1125.0 and po["cgst"] == 0

    def test_moving_a_draft_to_an_inactive_supplier_is_refused(self, client, admin_auth, draft):
        other = _supplier_in(client, admin_auth, "Karnataka", "IDLE", gstin=None, pan=None,
                             taxTreatment="unregistered", status="inactive")
        response = client.put(f"{BASE}/{draft['id']}", json={"supplierId": other["id"]}, headers=admin_auth)
        assert response.status_code == 409 and response.json()["error_code"] == "SUPPLIER_INACTIVE"

    @pytest.mark.parametrize("steps", [("submit",), ("submit", "send"), ("submit", "send", "acknowledge")])
    def test_only_a_draft_can_be_edited(self, client, admin_auth, draft, steps):
        advance(client, admin_auth, draft["id"], *steps)
        response = client.put(f"{BASE}/{draft['id']}", json={"notes": "late"}, headers=admin_auth)
        assert response.status_code == 409 and response.json()["error_code"] == "PO_NOT_EDITABLE"

    def test_a_cancelled_po_cannot_be_edited(self, client, admin_auth, draft):
        act(client, admin_auth, draft["id"], "cancel", {"reason": "No longer needed"})
        response = client.put(f"{BASE}/{draft['id']}", json={"notes": "late"}, headers=admin_auth)
        assert response.status_code == 409 and response.json()["error_code"] == "PO_NOT_EDITABLE"

    def test_an_edit_is_audited(self, client, admin_auth, draft, db):
        from app.models import AuditLog

        client.put(f"{BASE}/{draft['id']}", json={"items": [{"productId": "PRD001", "quantity": 60}]},
                   headers=admin_auth)
        entry = db.execute(select(AuditLog).where(AuditLog.action == "purchase-order.update")).scalar_one()
        assert entry.resource_id == draft["id"]
        assert entry.changes["total"] == {"from": 23625.0, "to": 28350.0}


# -------------------------------------------------------------- transitions


class TestTransitions:
    def test_submit_send_acknowledge(self, client, admin_auth, draft):
        po = act(client, admin_auth, draft["id"], "submit", {"note": "Approved by finance"}).json()["data"]
        assert po["status"] == "submitted" and po["statusLabel"] == "Submitted" and po["submittedAt"]
        po = act(client, admin_auth, draft["id"], "send").json()["data"]
        assert po["status"] == "sent" and po["sentAt"]
        po = act(client, admin_auth, draft["id"], "acknowledge").json()["data"]
        assert po["status"] == "acknowledged" and po["acknowledgedAt"]
        assert [e["status"] for e in po["timeline"]] == ["draft", "submitted", "sent", "acknowledged"]
        assert po["timeline"][1]["note"] == "Approved by finance"
        assert all(e["actor"] == "ADM001" and e["at"] for e in po["timeline"])

    def test_a_transition_body_is_optional(self, client, admin_auth, draft):
        response = client.post(f"{BASE}/{draft['id']}/submit", headers=admin_auth)
        assert response.status_code == 200 and response.json()["data"]["status"] == "submitted"

    @pytest.mark.parametrize("steps,action", [
        ((), "send"), ((), "acknowledge"),
        (("submit",), "submit"), (("submit",), "acknowledge"),
        (("submit", "send"), "submit"), (("submit", "send"), "send"),
        (("submit", "send", "acknowledge"), "acknowledge"), (("submit", "send", "acknowledge"), "send"),
    ])
    def test_out_of_order_transitions_are_refused(self, client, admin_auth, draft, steps, action):
        advance(client, admin_auth, draft["id"], *steps)
        response = act(client, admin_auth, draft["id"], action)
        assert response.status_code == 409
        body = response.json()
        expected = {(): "draft", ("submit",): "submitted", ("submit", "send"): "sent"}.get(steps, "acknowledged")
        assert body["error_code"] == "INVALID_PO_TRANSITION" and body["details"]["status"] == expected

    @pytest.mark.parametrize("action", ["submit", "send", "acknowledge"])
    def test_nothing_moves_a_cancelled_po(self, client, admin_auth, draft, action):
        act(client, admin_auth, draft["id"], "cancel", {"reason": "Wrong supplier"})
        response = act(client, admin_auth, draft["id"], action)
        assert response.status_code == 409 and response.json()["error_code"] == "INVALID_PO_TRANSITION"

    @pytest.mark.parametrize("action", ["submit", "send", "acknowledge"])
    def test_nothing_moves_a_received_po(self, client, admin_auth, sent_po, action):
        lines = [{"poItemId": i["id"], "receivedQty": i["quantity"]} for i in sent_po["items"]]
        assert receive(client, admin_auth, sent_po["id"], lines, "all-in").status_code == 201
        response = act(client, admin_auth, sent_po["id"], action)
        assert response.status_code == 409 and response.json()["error_code"] == "INVALID_PO_TRANSITION"

    def test_an_inactive_supplier_blocks_submit_and_send(self, client, admin_auth, linked, draft):
        other = make_po(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 10}])
        advance(client, admin_auth, other["id"], "submit")
        client.post(f"/api/admin/suppliers/{linked['id']}/status", json={"status": "inactive"}, headers=admin_auth)
        for po_id, action in ((draft["id"], "submit"), (other["id"], "send")):
            response = act(client, admin_auth, po_id, action)
            assert response.status_code == 409 and response.json()["error_code"] == "SUPPLIER_INACTIVE"

    def test_an_unknown_po_is_404(self, client, admin_auth, linked):
        for method, path in (("GET", f"{BASE}/POR999"), ("PUT", f"{BASE}/POR999"),
                             ("POST", f"{BASE}/POR999/submit"), ("POST", f"{BASE}/POR999/cancel"),
                             ("GET", f"{BASE}/POR999/receipts"), ("POST", f"{BASE}/POR999/receipts")):
            response = client.request(method, path, json={"reason": "x", "idempotencyKey": "k",
                                                          "items": [{"poItemId": 1, "receivedQty": 1}]},
                                      headers=admin_auth)
            assert response.status_code == 404, (method, path, response.text)
            assert response.json()["error_code"] == "PO_NOT_FOUND"

    def test_transitions_are_audited(self, client, admin_auth, draft, db):
        from app.models import AuditLog

        advance(client, admin_auth, draft["id"], "submit", "send", "acknowledge")
        entries = db.execute(select(AuditLog).where(AuditLog.resource_type == "purchase-order")
                             .order_by(AuditLog.id)).scalars().all()
        assert [e.action for e in entries] == ["purchase-order.create", "purchase-order.submit",
                                               "purchase-order.send", "purchase-order.acknowledge"]
        assert entries[1].changes == {"status": {"from": "draft", "to": "submitted"}}
        assert all(e.actor_id == "ADM001" and e.resource_id == draft["id"] for e in entries)


# ------------------------------------------------------------------- cancel


class TestCancel:
    @pytest.mark.parametrize("steps", [(), ("submit",), ("submit", "send"), ("submit", "send", "acknowledge")])
    def test_can_be_cancelled_before_anything_is_received(self, client, admin_auth, draft, steps):
        advance(client, admin_auth, draft["id"], *steps)
        response = act(client, admin_auth, draft["id"], "cancel", {"reason": "Supplier out of stock"})
        assert response.status_code == 200, response.text
        po = response.json()["data"]
        assert po["status"] == "cancelled" and po["cancelReason"] == "Supplier out of stock" and po["cancelledAt"]
        assert po["timeline"][-1]["status"] == "cancelled" and po["timeline"][-1]["note"] == "Supplier out of stock"

    @pytest.mark.parametrize("body", [{}, {"reason": ""}, {"reason": "   "}, {"reason": None}])
    def test_a_reason_is_required(self, client, admin_auth, draft, body):
        response = act(client, admin_auth, draft["id"], "cancel", body)
        assert response.status_code == 422 and response.json()["error_code"] == "REASON_REQUIRED"
        assert client.get(f"{BASE}/{draft['id']}", headers=admin_auth).json()["data"]["status"] == "draft"

    def test_refused_once_anything_has_been_received(self, client, admin_auth, sent_po):
        line = item_for(sent_po, "PRD001")
        receive(client, admin_auth, sent_po["id"], [{"poItemId": line["id"], "receivedQty": 1}], "one-unit")
        response = act(client, admin_auth, sent_po["id"], "cancel", {"reason": "Changed mind"})
        assert response.status_code == 409 and response.json()["error_code"] == "PO_HAS_RECEIPTS"
        po = client.get(f"{BASE}/{sent_po['id']}", headers=admin_auth).json()["data"]
        assert po["status"] == "partially-received"

    def test_refused_even_if_everything_received_was_damaged(self, client, admin_auth, sent_po):
        line = item_for(sent_po, "PRD001")
        receive(client, admin_auth, sent_po["id"], [{"poItemId": line["id"], "receivedQty": 2, "damagedQty": 2}],
                "all-damaged")
        response = act(client, admin_auth, sent_po["id"], "cancel", {"reason": "All broken"})
        assert response.status_code == 409 and response.json()["error_code"] == "PO_HAS_RECEIPTS"

    def test_refused_when_fully_received(self, client, admin_auth, sent_po):
        lines = [{"poItemId": i["id"], "receivedQty": i["quantity"]} for i in sent_po["items"]]
        receive(client, admin_auth, sent_po["id"], lines, "everything")
        response = act(client, admin_auth, sent_po["id"], "cancel", {"reason": "Too late"})
        assert response.status_code == 409 and response.json()["error_code"] == "PO_HAS_RECEIPTS"

    def test_cancelling_twice_is_refused(self, client, admin_auth, draft):
        act(client, admin_auth, draft["id"], "cancel", {"reason": "Once"})
        response = act(client, admin_auth, draft["id"], "cancel", {"reason": "Twice"})
        assert response.status_code == 409 and response.json()["error_code"] == "INVALID_PO_TRANSITION"

    def test_a_cancel_is_audited_with_its_reason(self, client, admin_auth, draft, db):
        from app.models import AuditLog

        act(client, admin_auth, draft["id"], "cancel", {"reason": "Budget cut"})
        entry = db.execute(select(AuditLog).where(AuditLog.action == "purchase-order.cancel")).scalar_one()
        assert entry.details["reason"] == "Budget cut" and "Budget cut" in entry.summary
        assert entry.changes == {"status": {"from": "draft", "to": "cancelled"}}


# ------------------------------------------------------------------ actions


class TestActions:
    NONE = {"edit": False, "submit": False, "send": False, "acknowledge": False, "receive": False, "cancel": False}

    def _expect(self, **true):
        return {**self.NONE, **{key: True for key in true}}

    def test_actions_follow_the_status(self, client, admin_auth, draft):
        assert draft["actions"] == self._expect(edit=1, submit=1, cancel=1)
        po = advance(client, admin_auth, draft["id"], "submit")
        assert po["actions"] == self._expect(send=1, cancel=1)
        po = advance(client, admin_auth, draft["id"], "send")
        assert po["actions"] == self._expect(acknowledge=1, receive=1, cancel=1)
        po = advance(client, admin_auth, draft["id"], "acknowledge")
        assert po["actions"] == self._expect(receive=1, cancel=1)
        line = po["items"][0]
        po = receive(client, admin_auth, po["id"], [{"poItemId": line["id"], "receivedQty": 10}], "a1").json()["data"]
        assert po["status"] == "partially-received" and po["actions"] == self._expect(receive=1)
        po = receive(client, admin_auth, po["id"], [{"poItemId": line["id"], "receivedQty": 40}], "a2").json()["data"]
        assert po["status"] == "received" and po["actions"] == self.NONE

    def test_a_cancelled_po_has_no_actions(self, client, admin_auth, draft):
        po = act(client, admin_auth, draft["id"], "cancel", {"reason": "x"}).json()["data"]
        assert po["actions"] == self.NONE

    def test_an_inactive_supplier_hides_submit(self, client, admin_auth, linked, draft):
        client.post(f"/api/admin/suppliers/{linked['id']}/status", json={"status": "inactive"}, headers=admin_auth)
        po = client.get(f"{BASE}/{draft['id']}", headers=admin_auth).json()["data"]
        assert po["actions"]["submit"] is False and po["actions"]["edit"] is True

    def test_warnings_are_shown_only_on_a_draft(self, client, admin_auth, linked):
        po = make_po(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 2}])
        assert len(po["warnings"]) == 1
        assert advance(client, admin_auth, po["id"], "submit")["warnings"] == []


# --------------------------------------------------------------------- list


class TestList:
    @pytest.fixture()
    def several(self, client, admin_auth, linked):
        other = _supplier_in(client, admin_auth, "Maharashtra", "MERI-AUD", gstin=gstin("27", "AAACR5055K"),
                             pan="AAACR5055K")
        link(client, admin_auth, other["id"], "PRD002", cost=1000.0)
        first = make_po(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 10}],
                        supplierReference="Q-ALPHA")
        second = make_po(client, admin_auth, linked["id"], [{"productId": "PRD001", "quantity": 10},
                                                            {"productId": "PRD003", "quantity": 1}])
        third = make_po(client, admin_auth, other["id"], [{"productId": "PRD002", "quantity": 3}])
        advance(client, admin_auth, second["id"], "submit", "send")
        act(client, admin_auth, third["id"], "cancel", {"reason": "dup"})
        return {"first": first, "second": second, "third": third, "other": other}

    def _list(self, client, headers, **params):
        response = client.get(BASE, params=params, headers=headers)
        assert response.status_code == 200, response.text
        return response.json()["data"]

    def test_lists_newest_first_with_counts(self, client, admin_auth, several):
        data = self._list(client, admin_auth)
        assert [row["id"] for row in data["items"]] == ["POR003", "POR002", "POR001"]
        assert data["pagination"] == {"page": 1, "page_size": 25, "total": 3, "total_pages": 1}
        assert data["counts"] == {"draft": 1, "submitted": 0, "sent": 1, "acknowledged": 0,
                                  "partially-received": 0, "received": 0, "cancelled": 1}

    def test_a_row_has_the_summary_fields(self, client, admin_auth, several):
        row = next(r for r in self._list(client, admin_auth)["items"] if r["id"] == "POR002")
        assert row["poNumber"] == several["second"]["poNumber"] and row["status"] == "sent"
        assert row["statusLabel"] == "Sent" and row["supplierId"] == "SUP001"
        assert row["supplierName"] == "Anvi Textiles" and row["itemCount"] == 2
        assert row["total"] == several["second"]["total"] and row["expectedAt"] is None and row["createdAt"]

    def test_filter_by_status_keeps_the_counts(self, client, admin_auth, several):
        data = self._list(client, admin_auth, status="sent")
        assert [row["id"] for row in data["items"]] == ["POR002"]
        assert data["pagination"]["total"] == 1 and data["counts"]["draft"] == 1

    def test_filter_by_supplier(self, client, admin_auth, several):
        data = self._list(client, admin_auth, supplier=several["other"]["id"])
        assert [row["id"] for row in data["items"]] == ["POR003"]
        assert data["counts"]["cancelled"] == 1 and data["counts"]["draft"] == 0

    def test_filter_by_supplier_takes_its_id_or_code_never_its_name(self, client, admin_auth, several):
        assert [r["id"] for r in self._list(client, admin_auth, supplier="MERI-AUD")["items"]] == ["POR003"]
        assert [r["id"] for r in self._list(client, admin_auth, supplier="SUP001")["items"]] == ["POR002", "POR001"]
        assert self._list(client, admin_auth, supplier="Anvi Textiles")["items"] == []
        assert self._list(client, admin_auth, supplier="SUP00")["items"] == []

    def test_search_takes_the_po_id_or_the_suppliers_reference_exactly(self, client, admin_auth, several):
        number = several["second"]["poNumber"]
        assert [r["id"] for r in self._list(client, admin_auth, q=number)["items"]] == ["POR002"]
        assert [r["id"] for r in self._list(client, admin_auth, q=number.lower())["items"]] == ["POR002"]
        assert [r["id"] for r in self._list(client, admin_auth, q="POR002")["items"]] == ["POR002"]
        assert [r["id"] for r in self._list(client, admin_auth, q="Q-ALPHA")["items"]] == ["POR001"]
        # Part of a number, the supplier's name or code: not a purchase order ID.
        for text in ("000002", number[:-1], "Q-ALP", "MERI", "MERI-AUD", "Anvi", "Anvi Textiles", "nothing-like-it"):
            assert self._list(client, admin_auth, q=text)["items"] == [], text

    def test_date_range(self, client, admin_auth, several):
        today = datetime.utcnow().date()
        assert len(self._list(client, admin_auth, **{"from": today.isoformat(), "to": today.isoformat()})["items"]) == 3
        past = (today - timedelta(days=30)).isoformat(), (today - timedelta(days=1)).isoformat()
        assert self._list(client, admin_auth, **{"from": past[0], "to": past[1]})["items"] == []
        assert self._list(client, admin_auth, **{"from": (today + timedelta(days=1)).isoformat()})["items"] == []

    @pytest.mark.parametrize("param", ["from", "to"])
    def test_a_bad_date_is_refused(self, client, admin_auth, several, param):
        response = client.get(BASE, params={param: "2026-13-45"}, headers=admin_auth)
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_DATE"

    def test_pagination(self, client, admin_auth, several):
        page = self._list(client, admin_auth, page=2, pageSize=2)
        assert [row["id"] for row in page["items"]] == ["POR001"]
        assert page["pagination"] == {"page": 2, "page_size": 2, "total": 3, "total_pages": 2}

    def test_a_nonsense_status_is_ignored(self, client, admin_auth, several):
        assert len(self._list(client, admin_auth, status="bogus")["items"]) == 3

    def test_an_empty_list(self, client, admin_auth, linked):
        data = self._list(client, admin_auth)
        assert data["items"] == [] and data["pagination"]["total"] == 0 and set(data["counts"].values()) == {0}


# ----------------------------------------------------------------- reading


class TestRead:
    def test_get_returns_the_same_view(self, client, admin_auth, draft):
        response = client.get(f"{BASE}/{draft['id']}", headers=admin_auth)
        assert response.status_code == 200
        data = response.json()["data"]
        for key in ("poNumber", "status", "items", "subtotal", "total", "actions", "timeline", "supplier"):
            assert data[key] == draft[key], key

    def test_the_line_keeps_its_snapshot_after_the_product_is_renamed(self, client, admin_auth, draft, db):
        from app.models import Product

        db.get(Product, "PRD001").name = "Renamed Kurta"
        db.flush()
        data = client.get(f"{BASE}/{draft['id']}", headers=admin_auth).json()["data"]
        assert data["items"][0]["name"] == "Cotton Kurta"

    def test_a_create_is_audited(self, client, admin_auth, draft, db):
        from app.models import AuditLog

        entry = db.execute(select(AuditLog).where(AuditLog.action == "purchase-order.create")).scalar_one()
        assert entry.resource_id == draft["id"] and entry.actor_id == "ADM001"
        assert draft["poNumber"] in entry.summary and entry.details == {"supplierId": "SUP001"}


# -------------------------------------------------------------- permissions


class TestPermissions:
    def test_no_token_is_401(self, client, catalogue):
        for method, path in (("GET", BASE), ("POST", BASE), ("GET", f"{BASE}/POR001"), ("PUT", f"{BASE}/POR001"),
                             ("POST", f"{BASE}/POR001/submit"), ("POST", f"{BASE}/POR001/cancel"),
                             ("GET", f"{BASE}/POR001/receipts"), ("POST", f"{BASE}/POR001/receipts")):
            assert client.request(method, path, json={}).status_code == 401, (method, path)

    def test_a_customer_is_403(self, client, auth, draft):
        for method, path in (("GET", BASE), ("POST", BASE), ("GET", f"{BASE}/{draft['id']}"),
                             ("POST", f"{BASE}/{draft['id']}/submit")):
            assert client.request(method, path, json={}, headers=auth).status_code == 403, (method, path)

    @pytest.mark.parametrize("role", ["editor", "staff"])
    def test_roles_without_purchasing_are_refused(self, client, db, draft, role):
        # Even holding `suppliers`: the directory and purchasing are separate grants.
        headers = role_headers(db, "ADM070", role, ["products", "orders", "suppliers"])
        for method, path, body in (("GET", BASE, None),
                                   ("POST", BASE, {"supplierId": "SUP001",
                                                   "items": [{"productId": "PRD001", "quantity": 10}]}),
                                   ("GET", f"{BASE}/{draft['id']}", None),
                                   ("PUT", f"{BASE}/{draft['id']}", {"notes": "x"}),
                                   ("POST", f"{BASE}/{draft['id']}/submit", {}),
                                   ("POST", f"{BASE}/{draft['id']}/cancel", {"reason": "x"}),
                                   ("GET", f"{BASE}/{draft['id']}/receipts", None)):
            response = client.request(method, path, json=body, headers=headers)
            assert response.status_code == 403, (role, method, path)
            assert response.json()["error_code"] == "PERMISSION_DENIED"
        assert client.get(f"{BASE}/{draft['id']}", headers=role_headers(db, "ADM071", "admin")).json()[
            "data"]["status"] == "draft"

    @pytest.mark.parametrize("role", ["manager", "admin"])
    def test_manager_and_admin_may_purchase(self, client, db, linked, role):
        headers = role_headers(db, "ADM072", role, [])
        po = make_po(client, headers, linked["id"], [{"productId": "PRD001", "quantity": 10}])
        assert po["createdBy"] == "ADM072"
        po = advance(client, headers, po["id"], "submit", "send")
        assert po["timeline"][-1]["actor"] == "ADM072"
        assert client.get(BASE, headers=headers).status_code == 200

    def test_an_explicit_grant_works_for_any_role(self, client, db, draft):
        headers = role_headers(db, "ADM073", "staff", ["purchasing"])
        assert client.get(f"{BASE}/{draft['id']}", headers=headers).status_code == 200
