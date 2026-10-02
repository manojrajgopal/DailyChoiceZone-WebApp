"""
The first configuration a fresh installation is given, and the document
number formats that no setting may change.

`initial_documents()` is read once, by a migration, on an empty database, so
a mistake in it shows up only on a brand-new install. These tests check now
that the documents parse, are complete enough for the code that reads them, and
agree with the numbering rules in `core.numbering`.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from app.config_defaults import initial_documents
from app.core import numbering
from app.core.errors import ValidationError
from app.services import billing

DOCS = initial_documents()


class TestInitialDocuments:
    def test_every_document_the_code_reads_is_present(self):
        assert {"store", "billing", "tax", "site", "content", "navigation", "admin_navigation"} <= set(DOCS)

    def test_each_call_returns_a_fresh_copy(self):
        first = initial_documents()
        first["tax"]["enabled"] = False
        assert initial_documents()["tax"]["enabled"] is True

    def test_tax_rates_are_consistent(self):
        tax = DOCS["tax"]
        for rates in [tax["rates"], *tax["categoryRates"].values()]:
            # Intra-state CGST + SGST must equal the inter-state IGST.
            assert rates["cgst"] + rates["sgst"] == rates["igst"]
            assert all(0 <= value <= 100 for value in rates.values())

    def test_the_tax_document_works_with_the_calculator(self):
        tax = billing.calculate_tax(10_500, DOCS["tax"]["originState"], None, DOCS["tax"])
        assert tax["mode"] == "intra-state" and tax["totalTax"] == 500

    def test_billing_numbering_matches_the_fixed_formats(self):
        """A fresh install must not start with numbers the settings guard would refuse."""
        assert numbering.with_locked(DOCS["billing"])["invoice"]["prefix"] == numbering.INVOICE.prefix
        numbering.strip_locked(DOCS["billing"])  # raises if any locked value disagrees

    def test_store_shipping_figures(self):
        shipping = DOCS["store"]["shipping"]
        assert shipping["freeDeliveryThreshold"] >= 0
        assert shipping["standardFee"] >= 0 and shipping["expressFee"] >= shipping["standardFee"]

    def test_delivery_and_payment_methods_are_known_to_the_order_service(self):
        from app.services import orders

        assert {m["id"] for m in DOCS["content"]["deliveryMethods"]} <= orders.DELIVERY_METHODS
        assert {m["id"] for m in DOCS["content"]["paymentMethods"]} <= orders.KNOWN_PAYMENT_METHODS
        assert set(DOCS["billing"]["payment"]["enabledMethods"]) <= orders.KNOWN_PAYMENT_METHODS

    def test_sort_options_are_ones_the_catalogue_accepts(self):
        from typing import get_args

        from app.schemas.catalogue import SortOption

        values = {option.get("value", option.get("id")) for option in DOCS["content"]["sortOptions"]}
        assert values <= set(get_args(SortOption))

    def test_admin_sidebar_links_are_unique(self):
        hrefs = [item["href"] for group in DOCS["admin_navigation"]["groups"] for item in group["items"]]
        assert len(hrefs) == len(set(hrefs))


class TestNumbering:
    def test_yearly_format_grows_past_its_padding(self):
        assert numbering.INVOICE.yearly(2026, 214) == "DCZ-INV-2026-000214"
        assert numbering.INVOICE.yearly(2026, 1_000_000) == "DCZ-INV-2026-1000000"

    def test_with_locked_overwrites_whatever_was_saved(self):
        out = numbering.with_locked({"invoice": {"prefix": "HACKED", "notes": "n"}})
        assert out["invoice"]["prefix"] == "DCZ-INV" and out["invoice"]["notes"] == "n"
        assert out["order"]["startNumber"] == numbering.ORDER_START

    def test_strip_locked_drops_unchanged_values(self):
        payload = {"invoice": {"prefix": "DCZ-INV", "dueDays": 7}, "currency": {"code": "INR"}}
        assert numbering.strip_locked(payload) == {"invoice": {"dueDays": 7}, "currency": {"code": "INR"}}

    def test_strip_locked_removes_sections_that_are_only_numbering(self):
        assert numbering.strip_locked({"order": {"prefix": "DCZ"}, "sku": {}}) == {}

    @pytest.mark.parametrize("section, field, value", [
        ("invoice", "prefix", ""), ("invoice", "padding", 2), ("order", "startNumber", 1), ("refund", "prefix", "X"),
    ])
    def test_strip_locked_refuses_a_changed_value(self, section, field, value):
        with pytest.raises(ValidationError) as caught:
            numbering.strip_locked({section: {field: value}})
        assert caught.value.error_code == "NUMBERING_LOCKED"
        assert caught.value.details == {"section": section, "field": field}

    def test_strip_locked_of_nothing(self):
        assert numbering.strip_locked(None) == {}

    def test_describe_lists_every_series(self):
        keys = [row["key"] for row in numbering.describe()]
        assert keys == ["order", "invoice", "creditNote", "refund", "ticket", "shipment", "purchaseOrder",
                        "goodsReceipt", "sku"]
        year = datetime.utcnow().year
        assert numbering.describe()[1]["example"] == f"DCZ-INV-{year}-000001"
