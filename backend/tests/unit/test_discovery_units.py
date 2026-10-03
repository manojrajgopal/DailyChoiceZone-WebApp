"""
The pure pieces of product discovery: the delivery window, exact unit
conversion and size-guide cell parsing, the scoring helpers, and the cache.
No database.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

import pytest

from app.core import cache
from app.core.errors import ValidationError
from app.services import recommendations, serviceability, size_guides

RULES = dict(serviceability.DEFAULTS)


class TestDeliveryWindow:
    # 2026-10-02 is a Friday. `now` is UTC; the store clock is IST (+5:30).
    FRIDAY_MORNING = datetime(2026, 10, 2, 4, 0)    # 09:30 IST
    FRIDAY_EVENING = datetime(2026, 10, 2, 12, 0)   # 17:30 IST

    def test_the_default_matches_the_old_business_day_estimate(self):
        out = serviceability.delivery_window(RULES, min_days=3, max_days=5, now=self.FRIDAY_MORNING)
        assert out["dispatchBy"] == "2026-10-02"
        assert (out["from"], out["to"]) == ("2026-10-07", "2026-10-09")  # Wed, Fri — weekends skipped
        assert out["label"] == "7–9 Oct" and out["latestLabel"] == "Fri, 9 Oct"

    def test_past_the_cutoff_it_goes_out_next_working_day(self):
        rules = {**RULES, "dispatchCutoffHour": 14}
        before = serviceability.delivery_window(rules, min_days=1, max_days=1, now=self.FRIDAY_MORNING)
        after = serviceability.delivery_window(rules, min_days=1, max_days=1, now=self.FRIDAY_EVENING)
        assert before["dispatchBy"] == "2026-10-02" and after["dispatchBy"] == "2026-10-05"  # Monday

    def test_processing_and_handling_days(self):
        rules = {**RULES, "processingDays": 1}
        out = serviceability.delivery_window(rules, min_days=1, max_days=2, extra_dispatch_days=2,
                                             now=self.FRIDAY_MORNING)
        assert out["dispatchBy"] == "2026-10-07"  # Mon, Tue, Wed

    def test_holidays_are_skipped(self):
        rules = {**RULES, "holidays": ["2026-10-05", "2026-10-06"]}
        out = serviceability.delivery_window(rules, min_days=1, max_days=1, now=self.FRIDAY_MORNING)
        assert out["to"] == "2026-10-07"

    def test_saturday_deliveries(self):
        rules = {**RULES, "workingDays": [0, 1, 2, 3, 4, 5]}
        out = serviceability.delivery_window(rules, min_days=1, max_days=1, now=self.FRIDAY_MORNING)
        assert out["to"] == "2026-10-03"

    def test_the_store_clock_decides_the_day(self):
        # 20:00 UTC Friday is already Saturday 01:30 in India.
        late = datetime(2026, 10, 2, 20, 0)
        rules = {**RULES, "dispatchCutoffHour": 14}
        assert serviceability.delivery_window(rules, min_days=0, max_days=0, now=late)["dispatchBy"] == "2026-10-05"

    def test_a_reversed_range_is_put_right(self):
        out = serviceability.delivery_window(RULES, min_days=5, max_days=3, now=self.FRIDAY_MORNING)
        assert out["from"] <= out["to"]

    @pytest.mark.parametrize("first, last, label", [
        (date(2026, 10, 9), date(2026, 10, 9), "Fri, 9 Oct"),
        (date(2026, 10, 9), date(2026, 10, 12), "9–12 Oct"),
        (date(2026, 9, 30), date(2026, 10, 2), "30 Sep – 2 Oct"),
    ])
    def test_labels(self, first, last, label):
        assert serviceability.range_label(first, last) == label


class TestTransitDays:
    def result(self, **kw):
        base = dict(pincode="560001", valid=True, serviceable=True, listed=False)
        base.update(kw)
        return serviceability.Serviceability(**base)

    def test_unlisted_uses_the_store_days(self):
        assert serviceability.transit_days(self.result(), RULES, "standard") == (3, 5)
        assert serviceability.transit_days(self.result(), RULES, "express") == (1, 2)

    def test_a_listed_pincode_uses_its_own(self):
        listed = self.result(listed=True, min_days=2, max_days=4)
        assert serviceability.transit_days(listed, RULES, "standard") == (2, 4)
        assert serviceability.transit_days(listed, RULES, "express") == (2, 2)


class TestUnits:
    def test_exact_factors(self):
        assert size_guides.convert(Decimal("2.54"), "cm", "in") == Decimal("1")
        assert size_guides.convert(1, "in", "mm") == Decimal("25.4")
        assert size_guides.convert(92, "cm", "cm") == Decimal("92")

    @pytest.mark.parametrize("cm, inches", [(92, 36.2), (97, 38.2), (70, 27.6), (100, 39.4), (2.54, 1.0)])
    def test_cm_to_inches_rounded_once(self, cm, inches):
        assert size_guides.rounded(size_guides.convert(cm, "cm", "in"), "in") == inches

    def test_round_trip_does_not_drift(self):
        """Converting the stored value each time, not the rounded one, keeps it exact."""
        stored = Decimal("92")
        there = size_guides.convert(stored, "cm", "in")
        back = size_guides.convert(there, "in", "cm")
        # Exact to Decimal's 28 significant digits — far below what is shown.
        assert abs(back - stored) < Decimal("1e-20")
        assert size_guides.rounded(back, "cm") == 92.0

    def test_millimetres_round_to_whole(self):
        assert size_guides.rounded(size_guides.convert(1.27, "cm", "mm"), "mm") == 13.0

    def test_an_unknown_unit(self):
        with pytest.raises(ValidationError):
            size_guides.convert(1, "cm", "furlong")


class TestCells:
    @pytest.mark.parametrize("raw, cell", [
        (92, {"min": 92.0}), ("92", {"min": 92.0}), ("92-96", {"min": 92.0, "max": 96.0}),
        ("92 – 96", {"min": 92.0, "max": 96.0}), ("92 to 96", {"min": 92.0, "max": 96.0}),
        ({"min": 92, "max": 92}, {"min": 92.0}), ({"min": "88.5", "max": "90"}, {"min": 88.5, "max": 90.0}),
        ("", None), (None, None),
    ])
    def test_parsing(self, raw, cell):
        assert size_guides._measurement(raw, where="x", unit="cm") == cell

    @pytest.mark.parametrize("raw", ["abc", "-3", "0", "96-92", True, [1], {"max": 3}, "1e9", "NaN"])
    def test_refused(self, raw):
        with pytest.raises(ValidationError):
            size_guides._measurement(raw, where="x", unit="cm")


class TestScoring:
    def test_price_similarity(self):
        assert recommendations._price_similarity(100, 100) == pytest.approx(10.0)
        assert recommendations._price_similarity(100, 75) == pytest.approx(5.0)
        assert recommendations._price_similarity(100, 40) == 0.0
        assert recommendations._price_similarity(0, 40) == 0.0

    def test_popularity_is_capped(self):
        class Row:
            rating, review_count, is_best_seller = 5.0, 100000, True

        assert recommendations._popularity(Row()) == recommendations.WEIGHTS["popularity"]

    def test_every_type_has_its_manual_sources(self):
        assert set(recommendations.MANUAL_TYPES) == set(recommendations.TYPES)


class TestCache:
    def setup_method(self):
        cache.clear()

    def test_computed_once_within_the_ttl(self):
        calls = []
        for _ in range(3):
            assert cache.get_or_set("t", "k", 60, lambda: calls.append(1) or "value") == "value"
        assert len(calls) == 1

    def test_invalidate_forgets_the_namespace_only(self):
        cache.get_or_set("a", "k", 60, lambda: 1)
        cache.get_or_set("b", "k", 60, lambda: 1)
        cache.invalidate("a")
        assert cache.get_or_set("a", "k", 60, lambda: 2) == 2
        assert cache.get_or_set("b", "k", 60, lambda: 2) == 1

    def test_a_ttl_of_zero_never_caches(self):
        values = iter([1, 2])
        assert cache.get_or_set("t", "k", 0, lambda: next(values)) == 1
        assert cache.get_or_set("t", "k", 0, lambda: next(values)) == 2

    def test_a_value_computed_across_an_invalidation_is_not_kept(self):
        def compute():
            cache.invalidate("t")
            return "stale"

        assert cache.get_or_set("t", "k", 60, compute) == "stale"
        assert cache.get_or_set("t", "k", 60, lambda: "fresh") == "fresh"

    def test_bounded(self, monkeypatch):
        monkeypatch.setattr(cache, "MAX_ENTRIES", 10)
        for n in range(50):
            cache.get_or_set("t", n, 60, lambda: n)
        assert len(cache._entries) <= 10
