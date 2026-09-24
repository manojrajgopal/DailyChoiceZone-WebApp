"""
GST.

Which tax applies, at what rate, and how a tax-inclusive price splits. These
run on a configuration dict rather than through the database, because the rules
are the thing under test and the storage is not.
"""

from __future__ import annotations

import pytest

from app.services.billing import calculate_tax, rates_for, tax_mode_for

CONFIG = {
    "enabled": True,
    "taxType": "GST",
    "pricesIncludeTax": True,
    "originState": "Karnataka",
    "rates": {"cgst": 2.5, "sgst": 2.5, "igst": 5},
    "categoryRates": {"electronics": {"cgst": 9, "sgst": 9, "igst": 18}},
}

EXCLUSIVE = {**CONFIG, "pricesIncludeTax": False}
DISABLED = {**CONFIG, "enabled": False}


class TestTaxMode:
    def test_supply_within_the_sellers_state_is_split(self):
        assert tax_mode_for("Karnataka", CONFIG) == "intra-state"

    def test_supply_across_a_state_line_is_integrated(self):
        assert tax_mode_for("Maharashtra", CONFIG) == "inter-state"

    @pytest.mark.parametrize(
        "typed", ["karnataka", "  Karnataka  ", "KARNATAKA", "Karnataka", "Karnataka  "]
    )
    def test_case_and_stray_spacing_do_not_change_the_charge(self, typed):
        """Addresses are typed by people; "karnataka " is Karnataka."""
        assert tax_mode_for(typed, CONFIG) == "intra-state"

    @pytest.mark.parametrize("typed", ["Karna taka", "Kar nataka", "Karnatak"])
    def test_a_different_word_is_a_different_state(self, typed):
        """Whitespace *inside* a name is not noise — it makes it another name."""
        assert tax_mode_for(typed, CONFIG) == "inter-state"

    def test_tax_can_be_switched_off_entirely(self):
        assert tax_mode_for("Karnataka", DISABLED) == "none"


class TestRates:
    def test_the_default_set(self):
        assert rates_for(None, CONFIG) == {"cgst": 2.5, "sgst": 2.5, "igst": 5}

    def test_a_category_with_its_own_rate(self):
        assert rates_for("electronics", CONFIG)["igst"] == 18

    def test_a_category_without_one_falls_back(self):
        assert rates_for("women", CONFIG) == CONFIG["rates"]


class TestCalculateTax:
    def test_inclusive_pricing_extracts_rather_than_adds(self):
        """The customer pays what the shelf said; the invoice shows the split."""
        result = calculate_tax(10_500, "Karnataka", None, CONFIG)
        assert result["taxableAmount"] == 10_000
        assert result["totalTax"] == 500
        assert result["taxableAmount"] + result["totalTax"] == 10_500

    def test_exclusive_pricing_adds_on_top(self):
        result = calculate_tax(10_000, "Karnataka", None, EXCLUSIVE)
        assert result["taxableAmount"] == 10_000
        assert result["totalTax"] == 500

    def test_intra_state_splits_into_two_halves_that_reconcile(self):
        result = calculate_tax(10_501, "Karnataka", None, CONFIG)
        assert result["mode"] == "intra-state"
        assert result["igst"] == 0
        assert result["cgst"] + result["sgst"] == result["totalTax"]

    def test_inter_state_is_a_single_integrated_tax(self):
        result = calculate_tax(10_500, "Maharashtra", None, CONFIG)
        assert result["mode"] == "inter-state"
        assert (result["cgst"], result["sgst"]) == (0, 0)
        assert result["igst"] == result["totalTax"]

    def test_the_rate_follows_the_category(self):
        cheap = calculate_tax(100_000, "Karnataka", "women", CONFIG)
        dear = calculate_tax(100_000, "Karnataka", "electronics", CONFIG)
        assert dear["totalTax"] > cheap["totalTax"]
        assert dear["ratePercent"] == 18

    def test_nothing_is_taxed_when_tax_is_off(self):
        result = calculate_tax(10_500, "Karnataka", None, DISABLED)
        assert result["totalTax"] == 0
        assert result["taxableAmount"] == 10_500

    @pytest.mark.parametrize("amount", [0, -1, -10_000])
    def test_no_tax_on_a_zero_or_negative_amount(self, amount):
        assert calculate_tax(amount, "Karnataka", None, CONFIG)["totalTax"] == 0

    def test_the_halves_never_leave_a_stray_paisa(self):
        """
        CGST and SGST are half the *total*, not half the rate.

        Halving the rate and rounding twice loses a paisa on odd totals, and an
        invoice whose two tax lines do not add up to its tax total is wrong in
        a way somebody eventually has to explain.
        """
        for gross in range(10_000, 10_050):
            result = calculate_tax(gross, "Karnataka", None, CONFIG)
            assert result["cgst"] + result["sgst"] == result["totalTax"]
