"""
Money arithmetic.

These are the sums that decide what somebody is charged, so they are tested
against worked examples rather than against a reimplementation of themselves.
"""

from __future__ import annotations

import pytest

from app.services.billing import allocate, percent_of, tax_included_in, to_major, to_minor


class TestConversion:
    @pytest.mark.parametrize(
        "major, minor",
        [(0, 0), (1, 100), (1299, 129900), (0.01, 1), (19.99, 1999), (1234.56, 123456)],
    )
    def test_rupees_to_paise(self, major, minor):
        assert to_minor(major) == minor

    def test_the_float_that_breaks_naive_conversion(self):
        """
        `int(1.15 * 100)` is 114 — binary floating point has no exact 1.15.

        This is the entire reason the conversion goes through `Decimal`, and
        the reason it is tested at all.
        """
        assert to_minor(1.15) == 115
        assert to_minor(2.675) == 268  # half-up, not banker's rounding

    def test_round_trip(self):
        assert to_major(to_minor(4999.5)) == 4999.5


class TestPercentOf:
    def test_whole_percentages(self):
        assert percent_of(100_000, 18) == 18_000

    def test_fractional_rate(self):
        assert percent_of(100_000, 2.5) == 2_500

    def test_rounds_half_up_rather_than_truncating(self):
        # 5% of 1 paisa is 0.05 paise — nothing. 5% of 11 paise is 0.55.
        assert percent_of(1, 5) == 0
        assert percent_of(11, 5) == 1


class TestAllocate:
    """
    Splitting an amount across lines.

    The property that matters is that the parts sum to the whole, exactly, with
    no stray paisa — because an invoice whose lines do not add up to its total
    is the error an auditor finds first.
    """

    def test_parts_sum_to_the_whole(self):
        parts = allocate(100, [1, 1, 1])
        assert sum(parts) == 100
        assert len(parts) == 3

    def test_indivisible_amount_is_distributed_not_dropped(self):
        # 100 across three equal lines is 33.33 each; someone gets the extra.
        assert sorted(allocate(100, [1, 1, 1])) == [33, 33, 34]

    def test_proportional_to_the_weights(self):
        assert allocate(1000, [300, 700]) == [300, 700]

    @pytest.mark.parametrize(
        "amount, weights",
        [
            (997, [1, 1, 1]),
            (1, [5, 5]),
            (12345, [1000, 3000, 7]),
            (50, [0, 100]),
        ],
    )
    def test_sums_exactly_for_awkward_splits(self, amount, weights):
        assert sum(allocate(amount, weights)) == amount

    def test_nothing_to_allocate(self):
        assert allocate(0, [1, 2, 3]) == [0, 0, 0]

    def test_no_weight_anywhere(self):
        """All-zero weights cannot be divided proportionally; nothing is invented."""
        assert sum(allocate(100, [0, 0])) in (0, 100)


class TestTaxIncludedIn:
    """Extracting tax from a price that already contains it."""

    def test_five_percent_inclusive(self):
        # 105 gross at 5% is 100 net + 5 tax.
        net, tax = tax_included_in(10_500, 5)
        assert (net, tax) == (10_000, 500)

    def test_eighteen_percent_inclusive(self):
        net, tax = tax_included_in(11_800, 18)
        assert (net, tax) == (10_000, 1_800)

    def test_net_plus_tax_always_equals_the_gross(self):
        for gross in (1, 99, 12_345, 999_999):
            net, tax = tax_included_in(gross, 18)
            assert net + tax == gross

    def test_zero_rate_extracts_nothing(self):
        assert tax_included_in(10_000, 0) == (10_000, 0)
