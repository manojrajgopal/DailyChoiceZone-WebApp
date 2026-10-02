"""
Goods receiving against a purchase order: partial and full receipts, damaged
and rejected units, stock added through the ledger (accepted units only, once
per idempotency key), over-receipt, every refusal, the statuses a PO can be
received from, and the receipts themselves.

The `sent_po` fixture is 50 x PRD001 (stock 10, active) at 450 and 10 x PRD003
(stock 0, out of stock) at 2000, submitted and sent.

Dates sent to the API are UTC (`datetime.utcnow().date()`): the server checks
"not in the future" against UTC, and a local date can be a day ahead of it.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from sqlalchemy import select

from tests.integration.test_suppliers_helpers import (  # noqa: F401
    advance,
    item_for,
    link,
    make_po,
    receive,
    role_headers,
    sent_po,
    supplier,
)

pytestmark = pytest.mark.integration

BASE = "/api/admin/purchase-orders"


def year() -> int:
    return datetime.utcnow().year


def utc_today():
    return datetime.utcnow().date()


def stock(db, product_id: str) -> int:
    from app.models import Product

    product = db.get(Product, product_id)
    db.refresh(product)
    return product.stock


def ledger(db, product_id: str):
    from app.models import StockAdjustment

    return db.execute(select(StockAdjustment).where(StockAdjustment.product_id == product_id,
                                                    StockAdjustment.reason == "purchase-receipt")
                      .order_by(StockAdjustment.id)).scalars().all()


def line(po: dict, product_id: str, received: int, damaged: int = 0, rejected: int = 0, **extra) -> dict:
    return {"poItemId": item_for(po, product_id)["id"], "receivedQty": received, "damagedQty": damaged,
            "rejectedQty": rejected, **extra}


def everything(po: dict) -> list:
    return [{"poItemId": item["id"], "receivedQty": item["quantity"]} for item in po["items"]]


# ----------------------------------------------------------------- receive


class TestReceive:
    def test_a_partial_receipt(self, client, admin_auth, sent_po):
        response = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 20, damaged=1)], "grn-1",
                           notes="First truck")
        assert response.status_code == 201, response.text
        po = response.json()["data"]
        assert po["status"] == "partially-received" and po["statusLabel"] == "Partially received"
        kurta = item_for(po, "PRD001")
        assert (kurta["receivedQty"], kurta["damagedQty"], kurta["rejectedQty"]) == (20, 1, 0)
        assert kurta["acceptedQty"] == 19 and kurta["outstandingQty"] == 30
        assert item_for(po, "PRD003")["outstandingQty"] == 10
        assert po["receivedAt"] is None
        (receipt,) = po["receipts"]
        assert receipt["receiptNumber"] == f"DCZ-GRN-{year()}-000001" and receipt["notes"] == "First truck"
        assert receipt["createdBy"] == "ADM001" and receipt["receivedAt"]
        assert receipt["items"] == [{"poItemId": kurta["id"], "productId": "PRD001", "name": "Cotton Kurta",
                                     "receivedQty": 20, "damagedQty": 1, "rejectedQty": 0, "acceptedQty": 19,
                                     "note": ""}]

    def test_everything_received_makes_it_received(self, client, admin_auth, sent_po):
        po = receive(client, admin_auth, sent_po["id"], everything(sent_po), "grn-all").json()["data"]
        assert po["status"] == "received" and po["statusLabel"] == "Received" and po["receivedAt"]
        assert all(item["outstandingQty"] == 0 for item in po["items"])

    def test_two_partials_make_it_received(self, client, admin_auth, sent_po):
        first = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 30)], "p1").json()["data"]
        assert first["status"] == "partially-received"
        second = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 20), line(sent_po, "PRD003", 10)],
                         "p2").json()["data"]
        assert second["status"] == "received" and item_for(second, "PRD001")["receivedQty"] == 50
        assert [r["receiptNumber"] for r in second["receipts"]] == [f"DCZ-GRN-{year()}-000001",
                                                                     f"DCZ-GRN-{year()}-000002"]

    def test_damaged_and_rejected_units_count_as_received_but_not_accepted(self, client, admin_auth, sent_po, db):
        po = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 50, damaged=3, rejected=2)],
                     "dmg").json()["data"]
        kurta = item_for(po, "PRD001")
        assert kurta["acceptedQty"] == 45 and kurta["outstandingQty"] == 0
        assert po["receipts"][0]["items"][0]["acceptedQty"] == 45
        assert stock(db, "PRD001") == 10 + 45

    def test_a_line_with_nothing_received_is_left_off_the_receipt(self, client, admin_auth, sent_po):
        po = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 5), line(sent_po, "PRD003", 0)],
                     "skip-zero").json()["data"]
        assert [i["productId"] for i in po["receipts"][0]["items"]] == ["PRD001"]

    def test_a_line_note_is_kept(self, client, admin_auth, sent_po):
        po = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 5, damaged=1, note="Box torn")],
                     "note").json()["data"]
        assert po["receipts"][0]["items"][0]["note"] == "Box torn"

    def test_missing_damaged_and_rejected_default_to_zero(self, client, admin_auth, sent_po):
        lines = [{"poItemId": item_for(sent_po, "PRD001")["id"], "receivedQty": 4}]
        po = receive(client, admin_auth, sent_po["id"], lines, "defaults").json()["data"]
        assert item_for(po, "PRD001")["acceptedQty"] == 4

    def test_a_receipt_is_evented_and_audited(self, client, admin_auth, sent_po, db):
        from app.models import AuditLog

        po = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 20, damaged=1, rejected=1)],
                     "audited").json()["data"]
        event = po["timeline"][-1]
        assert event["status"] == "partially-received" and event["actor"] == "ADM001"
        assert "20 received" in event["note"] and "18 accepted" in event["note"]
        entry = db.execute(select(AuditLog).where(AuditLog.action == "goods-receipt.create")).scalar_one()
        assert entry.resource_id == f"DCZ-GRN-{year()}-000001" and entry.actor_id == "ADM001"
        assert entry.changes == {"status": {"from": "sent", "to": "partially-received"}}
        assert entry.details["purchaseOrderId"] == sent_po["id"] and entry.details["accepted"] == 18
        assert (entry.details["damaged"], entry.details["rejected"]) == (1, 1)

    def test_get_receipts(self, client, admin_auth, sent_po):
        receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 10)], "r1")
        receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD003", 4, rejected=1)], "r2")
        response = client.get(f"{BASE}/{sent_po['id']}/receipts", headers=admin_auth)
        assert response.status_code == 200
        receipts = response.json()["data"]
        assert [r["receiptNumber"] for r in receipts] == [f"DCZ-GRN-{year()}-000001", f"DCZ-GRN-{year()}-000002"]
        assert receipts[1]["items"][0]["productId"] == "PRD003" and receipts[1]["items"][0]["acceptedQty"] == 3
        assert receipts[1]["items"][0]["name"] == "Wireless Earbuds"

    def test_receipts_of_a_po_with_none_is_an_empty_list(self, client, admin_auth, sent_po):
        assert client.get(f"{BASE}/{sent_po['id']}/receipts", headers=admin_auth).json()["data"] == []

    def test_grn_numbers_run_across_purchase_orders(self, client, admin_auth, sent_po, supplier):
        other = make_po(client, admin_auth, supplier["id"], [{"productId": "PRD001", "quantity": 5}])
        other = advance(client, admin_auth, other["id"], "submit", "send")
        receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 1)], "n1")
        po = receive(client, admin_auth, other["id"], [line(other, "PRD001", 1)], "n2").json()["data"]
        assert po["receipts"][0]["receiptNumber"] == f"DCZ-GRN-{year()}-000002"


# ------------------------------------------------------------------- stock


class TestStock:
    def test_stock_rises_by_the_accepted_units_only(self, client, admin_auth, sent_po, db):
        receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 20, damaged=1, rejected=2),
                                                    line(sent_po, "PRD003", 6, damaged=6)], "stock-1")
        assert stock(db, "PRD001") == 10 + 17
        # Six received, all damaged: nothing goes into stock and no ledger row is written.
        assert stock(db, "PRD003") == 0 and ledger(db, "PRD003") == []

    def test_the_ledger_records_the_receipt(self, client, admin_auth, sent_po, db):
        po = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 20, damaged=1)],
                     "ledger").json()["data"]
        (row,) = ledger(db, "PRD001")
        assert (row.quantity_before, row.quantity_after, row.delta) == (10, 29, 19)
        assert row.actor == "ADM001"
        # The note names the PO and the receipt.
        assert po["poNumber"] in row.note and po["receipts"][0]["receiptNumber"] in row.note

    def test_each_receipt_writes_its_own_ledger_row(self, client, admin_auth, sent_po, db):
        receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 5)], "l1")
        receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 7)], "l2")
        rows = ledger(db, "PRD001")
        assert [(r.quantity_before, r.quantity_after) for r in rows] == [(10, 15), (15, 22)]
        assert stock(db, "PRD001") == 22

    def test_an_out_of_stock_product_becomes_active(self, client, admin_auth, sent_po, db):
        from app.models import Product

        receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD003", 4)], "restock")
        product = db.get(Product, "PRD003")
        db.refresh(product)
        assert product.stock == 4 and product.status == "active"

    def test_a_receipt_of_only_damaged_units_leaves_it_out_of_stock(self, client, admin_auth, sent_po, db):
        from app.models import Product

        receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD003", 2, rejected=2)], "all-rejected")
        product = db.get(Product, "PRD003")
        db.refresh(product)
        assert product.stock == 0 and product.status == "out-of-stock"

    def test_a_draft_product_takes_stock_but_stays_a_draft(self, client, admin_auth, supplier, db):
        from app.models import Product

        po = make_po(client, admin_auth, supplier["id"], [{"productId": "PRD004", "quantity": 3, "unitCost": 100}])
        po = advance(client, admin_auth, po["id"], "submit", "send")
        receive(client, admin_auth, po["id"], [line(po, "PRD004", 3)], "draft-product")
        product = db.get(Product, "PRD004")
        db.refresh(product)
        assert product.stock == 8 and product.status == "draft"

    def test_a_refused_receipt_changes_no_stock(self, client, admin_auth, sent_po, db):
        from app.models import GoodsReceipt

        response = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 5),
                                                               line(sent_po, "PRD003", 11)], "too-many")
        assert response.status_code == 422
        assert stock(db, "PRD001") == 10 and ledger(db, "PRD001") == []
        assert db.execute(select(GoodsReceipt)).first() is None


# ------------------------------------------------------------- idempotency


class TestIdempotency:
    def test_the_same_key_twice_returns_the_po_unchanged(self, client, admin_auth, sent_po, db):
        from app.models import GoodsReceipt

        lines = [line(sent_po, "PRD001", 20)]
        first = receive(client, admin_auth, sent_po["id"], lines, "same-key")
        second = receive(client, admin_auth, sent_po["id"], lines, "same-key")
        assert first.status_code == 201 and second.status_code == 201, second.text
        assert second.json()["data"]["receipts"] == first.json()["data"]["receipts"]
        assert item_for(second.json()["data"], "PRD001")["receivedQty"] == 20
        assert stock(db, "PRD001") == 30 and len(ledger(db, "PRD001")) == 1
        assert len(db.execute(select(GoodsReceipt)).scalars().all()) == 1

    def test_the_same_key_with_a_different_body_still_adds_nothing(self, client, admin_auth, sent_po, db):
        receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 20)], "k")
        again = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 25)], "k").json()["data"]
        assert item_for(again, "PRD001")["receivedQty"] == 20 and stock(db, "PRD001") == 30

    def test_the_same_key_after_the_po_is_received_returns_it(self, client, admin_auth, sent_po):
        receive(client, admin_auth, sent_po["id"], everything(sent_po), "done")
        again = receive(client, admin_auth, sent_po["id"], everything(sent_po), "done")
        assert again.status_code == 201 and again.json()["data"]["status"] == "received"

    def test_a_key_used_for_another_po_is_refused(self, client, admin_auth, sent_po, supplier, db):
        other = make_po(client, admin_auth, supplier["id"], [{"productId": "PRD001", "quantity": 5}])
        other = advance(client, admin_auth, other["id"], "submit", "send")
        receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 1)], "shared")
        response = receive(client, admin_auth, other["id"], [line(other, "PRD001", 1)], "shared")
        assert response.status_code == 409 and response.json()["error_code"] == "IDEMPOTENCY_KEY_REUSED"
        assert stock(db, "PRD001") == 11

    @pytest.mark.parametrize("key", [None, "", "   "])
    def test_a_key_is_required(self, client, admin_auth, sent_po, key):
        response = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 1)], key)
        assert response.status_code == 422 and response.json()["error_code"] == "IDEMPOTENCY_KEY_REQUIRED"

    def test_different_keys_are_different_receipts(self, client, admin_auth, sent_po, db):
        receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 5)], "a")
        receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 5)], "b")
        assert stock(db, "PRD001") == 20


# ------------------------------------------------------------ over-receipt


class TestOverReceipt:
    def test_more_than_outstanding_is_refused(self, client, admin_auth, sent_po, db):
        response = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 51)], "over")
        assert response.status_code == 422
        body = response.json()
        assert body["error_code"] == "OVER_RECEIPT"
        assert body["details"]["lines"] == [{"poItemId": item_for(sent_po, "PRD001")["id"], "productId": "PRD001",
                                             "outstanding": 50, "received": 51}]
        assert stock(db, "PRD001") == 10

    def test_outstanding_shrinks_with_each_receipt(self, client, admin_auth, sent_po):
        receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 40, damaged=5)], "first")
        # 10 outstanding (damaged units were physically received).
        response = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 11)], "second")
        assert response.status_code == 422 and response.json()["error_code"] == "OVER_RECEIPT"
        assert receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 10)], "third").status_code == 201

    def test_allowing_it_still_needs_a_reason(self, client, admin_auth, sent_po):
        for reason in (None, "", "  "):
            response = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 55)], "over-r",
                               allowOverReceipt=True, overReceiptReason=reason)
            assert response.status_code == 422, reason
            body = response.json()
            assert body["error_code"] == "OVER_RECEIPT" and body["details"]["field"] == "overReceiptReason"

    def test_allowed_with_a_reason(self, client, admin_auth, sent_po, db):
        response = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 55)], "over-ok",
                           allowOverReceipt=True, overReceiptReason="Supplier sent a bonus 5")
        assert response.status_code == 201, response.text
        po = response.json()["data"]
        kurta = item_for(po, "PRD001")
        assert kurta["receivedQty"] == 55 and kurta["acceptedQty"] == 55 and kurta["outstandingQty"] == 0
        assert po["receipts"][0]["overReceiptReason"] == "Supplier sent a bonus 5"
        assert stock(db, "PRD001") == 65
        # PRD003 is still outstanding.
        assert po["status"] == "partially-received"

    def test_the_reason_is_not_kept_when_nothing_was_over(self, client, admin_auth, sent_po):
        po = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 5)], "not-over",
                     allowOverReceipt=True, overReceiptReason="Just in case").json()["data"]
        assert po["receipts"][0]["overReceiptReason"] == ""

    def test_allow_over_receipt_must_be_a_boolean(self, client, admin_auth, sent_po):
        response = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 5)], "flag",
                           allowOverReceipt="yes")
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_FIELD"


# --------------------------------------------------------------- refusals


class TestRefusals:
    def test_damaged_plus_rejected_above_received_is_refused(self, client, admin_auth, sent_po, db):
        response = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 5, damaged=3, rejected=3)],
                           "bad-split")
        assert response.status_code == 422
        body = response.json()
        assert body["error_code"] == "INVALID_RECEIPT_QUANTITIES" and body["details"]["field"] == "items[0].damagedQty"
        assert stock(db, "PRD001") == 10

    def test_damaged_on_a_line_with_nothing_received_is_refused(self, client, admin_auth, sent_po):
        response = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 5),
                                                               line(sent_po, "PRD003", 0, damaged=1)], "dmg-zero")
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_RECEIPT_QUANTITIES"

    @pytest.mark.parametrize("field", ["receivedQty", "damagedQty", "rejectedQty"])
    def test_negative_quantities_are_refused(self, client, admin_auth, sent_po, field):
        body = line(sent_po, "PRD001", 5)
        body[field] = -1
        response = receive(client, admin_auth, sent_po["id"], [body], f"neg-{field}")
        assert response.status_code == 422
        assert response.json()["error_code"] == "INVALID_QUANTITY"
        assert response.json()["details"]["field"] == f"items[0].{field}"

    @pytest.mark.parametrize("value", [1.5, "five", True])
    def test_non_whole_quantities_are_refused(self, client, admin_auth, sent_po, value):
        body = line(sent_po, "PRD001", 5)
        body["receivedQty"] = value
        response = receive(client, admin_auth, sent_po["id"], [body], "not-whole")
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_QUANTITY"

    def test_all_zero_is_refused(self, client, admin_auth, sent_po):
        response = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 0),
                                                               line(sent_po, "PRD003", 0)], "zeros")
        assert response.status_code == 422 and response.json()["error_code"] == "NOTHING_RECEIVED"

    @pytest.mark.parametrize("items", [[], None])
    def test_no_lines_is_refused(self, client, admin_auth, sent_po, items):
        response = receive(client, admin_auth, sent_po["id"], items, "empty")
        assert response.status_code == 422 and response.json()["error_code"] == "NO_ITEMS"

    def test_the_same_line_twice_is_refused(self, client, admin_auth, sent_po):
        response = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 1),
                                                               line(sent_po, "PRD001", 1)], "twice")
        assert response.status_code == 422 and response.json()["error_code"] == "DUPLICATE_ITEM"

    def test_a_line_from_another_po_is_refused(self, client, admin_auth, sent_po, supplier, db):
        other = make_po(client, admin_auth, supplier["id"], [{"productId": "PRD001", "quantity": 5}])
        other = advance(client, admin_auth, other["id"], "submit", "send")
        response = receive(client, admin_auth, sent_po["id"], [line(other, "PRD001", 1)], "foreign")
        assert response.status_code == 422 and response.json()["error_code"] == "UNKNOWN_PO_ITEM"
        assert stock(db, "PRD001") == 10

    def test_a_future_receiving_date_is_refused(self, client, admin_auth, sent_po, db):
        tomorrow = (utc_today() + timedelta(days=1)).isoformat()
        response = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 5)], "future",
                           receivedAt=tomorrow)
        assert response.status_code == 422
        body = response.json()
        assert body["error_code"] == "RECEIVED_AT_IN_FUTURE" and body["details"]["field"] == "receivedAt"
        assert stock(db, "PRD001") == 10

    def test_a_nonsense_receiving_date_is_refused(self, client, admin_auth, sent_po):
        response = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 5)], "nonsense",
                           receivedAt="yesterday")
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_DATE"

    def test_today_and_past_receiving_dates_are_accepted(self, client, admin_auth, sent_po):
        today = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 5)], "today",
                        receivedAt=utc_today().isoformat())
        assert today.status_code == 201, today.text
        past = (utc_today() - timedelta(days=3)).isoformat()
        po = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 5)], "past",
                     receivedAt=past).json()["data"]
        assert str(po["receipts"][1]["receivedAt"]).startswith(past)

    def test_receiving_into_an_archived_product_is_refused(self, client, admin_auth, sent_po, db):
        from app.models import GoodsReceipt, Product

        db.get(Product, "PRD003").status = "archived"
        db.flush()
        response = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 5),
                                                               line(sent_po, "PRD003", 2)], "archived")
        assert response.status_code == 422
        body = response.json()
        assert body["error_code"] == "PRODUCT_ARCHIVED" and body["details"]["productId"] == "PRD003"
        # All or nothing: the other line's stock didn't land either.
        assert stock(db, "PRD001") == 10 and db.execute(select(GoodsReceipt)).first() is None


# ------------------------------------------------------- receivable states


class TestReceivableStates:
    @pytest.fixture()
    def draft(self, client, admin_auth, supplier):
        link(client, admin_auth, supplier["id"], "PRD001", cost=450.0)
        return make_po(client, admin_auth, supplier["id"], [{"productId": "PRD001", "quantity": 10}])

    @pytest.mark.parametrize("steps", [(), ("submit",)])
    def test_a_draft_or_submitted_po_cannot_be_received(self, client, admin_auth, draft, db, steps):
        advance(client, admin_auth, draft["id"], *steps)
        response = receive(client, admin_auth, draft["id"], [line(draft, "PRD001", 5)], "early")
        assert response.status_code == 409 and response.json()["error_code"] == "INVALID_PO_TRANSITION"
        assert stock(db, "PRD001") == 10

    def test_a_sent_po_can_be_received_without_an_acknowledgement(self, client, admin_auth, draft):
        advance(client, admin_auth, draft["id"], "submit", "send")
        po = receive(client, admin_auth, draft["id"], [line(draft, "PRD001", 5)], "sent").json()["data"]
        assert po["status"] == "partially-received"
        assert [e["status"] for e in po["timeline"]] == ["draft", "submitted", "sent", "partially-received"]

    def test_an_acknowledged_po_can_be_received(self, client, admin_auth, draft):
        advance(client, admin_auth, draft["id"], "submit", "send", "acknowledge")
        po = receive(client, admin_auth, draft["id"], [line(draft, "PRD001", 10)], "ack").json()["data"]
        assert po["status"] == "received"

    def test_a_cancelled_po_cannot_be_received(self, client, admin_auth, draft):
        advance(client, admin_auth, draft["id"], "submit", "send")
        client.post(f"{BASE}/{draft['id']}/cancel", json={"reason": "Not coming"}, headers=admin_auth)
        response = receive(client, admin_auth, draft["id"], [line(draft, "PRD001", 5)], "cancelled")
        assert response.status_code == 409 and response.json()["error_code"] == "INVALID_PO_TRANSITION"

    def test_a_received_po_cannot_be_received_again(self, client, admin_auth, draft):
        advance(client, admin_auth, draft["id"], "submit", "send")
        receive(client, admin_auth, draft["id"], [line(draft, "PRD001", 10)], "all")
        response = receive(client, admin_auth, draft["id"], [line(draft, "PRD001", 1)], "more",
                           allowOverReceipt=True, overReceiptReason="Extra")
        assert response.status_code == 409 and response.json()["error_code"] == "INVALID_PO_TRANSITION"

    def test_receiving_needs_purchasing(self, client, admin_auth, draft, db):
        advance(client, admin_auth, draft["id"], "submit", "send")
        headers = role_headers(db, "ADM080", "staff", ["products", "orders", "suppliers"])
        response = receive(client, headers, draft["id"], [line(draft, "PRD001", 5)], "no-perm")
        assert response.status_code == 403 and response.json()["error_code"] == "PERMISSION_DENIED"
        assert stock(db, "PRD001") == 10


# ------------------------------------------------------------- dates on PO


class TestReceivedDates:
    def test_a_backdated_final_receipt_dates_the_po(self, client, admin_auth, sent_po):
        # Goods that arrived three days ago and were entered today: the PO was
        # received three days ago, which is what lead time and on-time rate use.
        past = (utc_today() - timedelta(days=3)).isoformat()
        po = receive(client, admin_auth, sent_po["id"], everything(sent_po), "backdated",
                     receivedAt=past).json()["data"]
        assert po["status"] == "received"
        assert str(po["receivedAt"]).startswith(past)

    def test_the_po_is_dated_by_its_latest_receipt(self, client, admin_auth, sent_po):
        early = (utc_today() - timedelta(days=5)).isoformat()
        late = (utc_today() - timedelta(days=2)).isoformat()
        receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD001", 50)], "late-first", receivedAt=late)
        # Entered afterwards, but delivered earlier: the PO was complete on the later date.
        po = receive(client, admin_auth, sent_po["id"], [line(sent_po, "PRD003", 10)], "early-second",
                     receivedAt=early).json()["data"]
        assert str(po["receivedAt"]).startswith(late)

    def test_on_time_rate_uses_the_receiving_date(self, client, admin_auth, supplier):
        # Expected two days ago, delivered three days ago (entered today): on time.
        link(client, admin_auth, supplier["id"], "PRD001", cost=100)
        expected = (utc_today() - timedelta(days=2)).isoformat()
        delivered = (utc_today() - timedelta(days=3)).isoformat()
        for number in range(3):
            po = make_po(client, admin_auth, supplier["id"], [{"productId": "PRD001", "quantity": 1}],
                         expectedAt=expected)
            po = advance(client, admin_auth, po["id"], "submit", "send")
            assert receive(client, admin_auth, po["id"], [line(po, "PRD001", 1)], f"ot-{number}",
                           receivedAt=delivered).status_code == 201
        stats = client.get(f"/api/admin/suppliers/{supplier['id']}", headers=admin_auth).json()["data"]["stats"]
        assert stats["onTimeRate"] == 100.0
        # Delivered before the PO was marked sent: a lead time of zero, never negative.
        assert stats["averageLeadTimeDays"] == 0.0
