"""
The arithmetic of partial refunds (docs/refunds.md): cumulative shares, so
any sequence of partial refunds of a line adds up to the line exactly.
"""

from __future__ import annotations

import types
from itertools import combinations

import pytest

from app.services.refunds import share_of_units


def line(**overrides):
    base = dict(quantity=3, line_subtotal=300000, discount=25000, line_total=275000, tax=13095, cgst=6548,
                sgst=6547, igst=0, tax_rate_percent=5)
    base.update(overrides)
    return types.SimpleNamespace(**base)


class TestShares:
    def test_one_unit_at_a_time_adds_up_exactly(self):
        item = line()
        parts = [share_of_units(item, n, 1) for n in range(3)]
        assert [p["amount"] for p in parts] == [91666, 91667, 91667]
        for key, total in (("amount", 275000), ("tax", 13095), ("cgst", 6548), ("sgst", 6547), ("discount", 25000),
                           ("gross", 300000)):
            assert sum(p[key] for p in parts) == total, key

    @pytest.mark.parametrize("split", [(1, 2), (2, 1), (1, 1, 1), (3,)])
    def test_any_split_adds_up_and_never_goes_negative(self, split):
        item = line()
        before, parts = 0, []
        for units in split:
            parts.append(share_of_units(item, before, units))
            before += units
        assert sum(p["amount"] for p in parts) == 275000
        assert sum(p["taxable"] for p in parts) == 275000 - 13095
        for p in parts:
            assert min(p.values()) >= 0
            assert p["taxable"] + p["tax"] == p["amount"]
            assert p["cgst"] + p["sgst"] + p["igst"] == p["tax"]

    def test_inter_state_lines_carry_igst_only(self):
        item = line(cgst=0, sgst=0, igst=13095)
        part = share_of_units(item, 0, 2)
        assert part["cgst"] == part["sgst"] == 0 and part["igst"] == part["tax"] == 8730

    def test_nothing_chosen_is_nothing(self):
        assert share_of_units(line(), 1, 0)["amount"] == 0

    @pytest.mark.parametrize("quantity,total", [(7, 100001), (13, 99999), (2, 1)])
    def test_odd_totals_lose_no_paisa(self, quantity, total):
        item = line(quantity=quantity, line_total=total, line_subtotal=total, discount=0, tax=0, cgst=0, sgst=0)
        assert sum(share_of_units(item, n, 1)["amount"] for n in range(quantity)) == total
        for cut in combinations(range(1, quantity), 1):
            first = share_of_units(item, 0, cut[0])["amount"]
            rest = share_of_units(item, cut[0], quantity - cut[0])["amount"]
            assert first + rest == total
