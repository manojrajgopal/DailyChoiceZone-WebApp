"""
The segment rule engine without a database: the registry, validation of every
operator against every field type, the SQL it compiles to, and RFM scoring.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from sqlalchemy.dialects import mysql

from app.core.errors import ValidationError
from app.services.segments import metrics, rules

NOW = datetime(2026, 10, 8, 12, 0, 0)

# A field of each type, and a good value for each operator it allows.
SAMPLES = {
    "number": ("totalOrders", {"equals": 2, "not-equals": 2, "gt": 1, "lt": 5, "gte": 2, "lte": 9, "between": [1, 3]}),
    "money": ("totalSpend", {"equals": 1000, "not-equals": 10.5, "gt": 0, "lt": 99.99, "gte": 25000, "lte": 1,
                             "between": [100, 200.5]}),
    "date": ("lastOrderAt", {"equals": "2026-10-01", "before": "2026-10-01", "after": "2026-01-31",
                             "between": ["2026-01-01", "2026-01-31"], "within-last-days": 30,
                             "not-within-last-days": 180}),
    "string": ("city", {"equals": "Bengaluru", "not-equals": "Pune", "contains": "gal", "not-contains": "x",
                        "starts-with": "Ben", "ends-with": "uru", "in": ["Pune", "Goa"], "not-in": ["Goa"]}),
    "enum": ("rfmLabel", {"equals": "loyal", "not-equals": "lost", "in": ["at-risk", "lost"], "not-in": ["new"]}),
    "list": ("purchasedProducts", {"contains": "PRD001", "not-contains": "PRD002", "in": ["PRD001", "PRD003"],
                                   "not-in": ["PRD004"]}),
    "boolean": ("hasAbandonedCart", {"equals": True}),
}


def sql(condition) -> str:
    return str(condition.compile(dialect=mysql.dialect(), compile_kwargs={"literal_binds": False}))


def one(field, operator, value, match="all"):
    return rules.clean(match, [{"field": field, "operator": operator, "value": value}])[1]


class TestRegistry:
    def test_every_field_has_a_known_group_type_and_unique_key(self):
        groups = {k for k, _ in rules.GROUPS}
        assert len(rules.REGISTRY) == len(rules.FIELDS)
        for field in rules.FIELDS:
            assert field.group in groups and field.type in rules.BY_TYPE
            assert (field.column is not None) or field.list_sql is not None

    def test_every_type_operator_is_a_known_operator(self):
        for operators in rules.BY_TYPE.values():
            assert set(operators) <= set(rules.OPERATORS)

    def test_the_groups_are_the_six_the_builder_shows(self):
        assert [k for k, _ in rules.GROUPS] == ["profile", "shopping", "products", "marketing", "membership", "loyalty"]
        assert {f.group for f in rules.FIELDS} == {k for k, _ in rules.GROUPS}


class TestOperatorsByType:
    @pytest.mark.parametrize("kind", sorted(SAMPLES))
    def test_every_allowed_operator_validates_and_compiles(self, kind):
        field, values = SAMPLES[kind]
        assert set(values) == set(rules.BY_TYPE[kind])
        for operator, value in values.items():
            cleaned = one(field, operator, value)
            assert cleaned[0]["operator"] == operator
            assert sql(rules.compile_rules("all", cleaned, NOW))

    @pytest.mark.parametrize("kind", sorted(SAMPLES))
    def test_every_other_operator_is_refused(self, kind):
        field, values = SAMPLES[kind]
        for operator in set(rules.OPERATORS) - set(values):
            with pytest.raises(ValidationError) as error:
                one(field, operator, 1)
            assert error.value.error_code == "INVALID_SEGMENT_RULE"
            assert "can't be used" in error.value.message
            assert error.value.details == {"path": "rules.0", "field": field, "operator": operator}


class TestValues:
    @pytest.mark.parametrize("field,operator,value,words", [
        ("totalOrders", "gte", "lots", "needs a number"),
        ("totalOrders", "gte", 1.5, "whole number"),
        ("totalOrders", "gte", -1, "between"),
        ("totalOrders", "gte", True, "needs a number"),
        ("recencyScore", "gte", 6, "between 0 and 5"),
        ("totalOrders", "between", [5, 1], "lower value first"),
        ("totalOrders", "between", 3, "two values"),
        ("totalSpend", "gte", "abc", "rupees"),
        ("totalSpend", "gte", 10.555, "two decimals"),
        ("totalSpend", "gte", 10_000_001, "between ₹0"),
        ("totalSpend", "between", [200, 100], "lower value first"),
        ("lastOrderAt", "before", "2026-02-30", "isn't a real date"),
        ("lastOrderAt", "before", "yesterday", "YYYY-MM-DD"),
        ("lastOrderAt", "between", ["2026-02-01", "2026-01-01"], "earlier date first"),
        ("lastOrderAt", "within-last-days", 0, "1 to 3,650"),
        ("lastOrderAt", "within-last-days", 4000, "1 to 3,650"),
        ("lastOrderAt", "within-last-days", "x", "days"),
        ("city", "equals", "", "needs some text"),
        ("city", "equals", "x" * 121, "at most 120"),
        ("city", "in", [], "at least one value"),
        ("city", "in", ["a"] * 101, "at most 100 values"),
        ("rfmLabel", "equals", "vip", "listed choices"),
        ("rfmLabel", "in", ["loyal", "nope"], "listed choices"),
        ("hasAbandonedCart", "equals", "yes", "yes or no"),
        ("purchasedProducts", "in", "PRD001", "at least one value"),
    ])
    def test_bad_values_are_refused_with_the_field_named(self, field, operator, value, words):
        with pytest.raises(ValidationError) as error:
            one(field, operator, value)
        assert words in error.value.message
        assert error.value.message.startswith(rules.REGISTRY[field].label)

    def test_money_is_stored_in_rupees_and_compiled_in_paise(self):
        cleaned = one("totalSpend", "gte", 249.5)
        assert cleaned[0]["value"] == 249.5
        compiled = rules.compile_rules("all", cleaned, NOW).compile(dialect=mysql.dialect())
        assert 24950 in compiled.params.values()

    def test_list_values_are_deduplicated(self):
        assert one("city", "in", ["Pune", "Pune", "Goa"])[0]["value"] == ["Pune", "Goa"]


class TestStructure:
    def test_unknown_field_and_operator(self):
        with pytest.raises(ValidationError, match="Choose a field"):
            one("salary", "gte", 1)
        with pytest.raises(ValidationError, match="choose a condition"):
            one("totalOrders", "approximately", 1)

    def test_match_must_be_all_or_any(self):
        with pytest.raises(ValidationError) as error:
            rules.clean("most", [])
        assert error.value.details["path"] == "match"

    def test_groups_one_level_only_and_never_empty(self):
        with pytest.raises(ValidationError, match="Groups can't contain groups"):
            rules.clean("all", [{"match": "any", "rules": [{"match": "all", "rules": []}]}])
        with pytest.raises(ValidationError, match="at least one condition"):
            rules.clean("all", [{"match": "any", "rules": []}])
        with pytest.raises(ValidationError, match="all or any"):
            rules.clean("all", [{"match": "x", "rules": [{"field": "totalOrders", "operator": "gte", "value": 1}]}])

    def test_the_path_points_into_the_group(self):
        with pytest.raises(ValidationError) as error:
            rules.clean("all", [{"field": "totalOrders", "operator": "gte", "value": 1},
                                {"match": "any", "rules": [{"field": "city", "operator": "equals", "value": "A"},
                                                           {"field": "city", "operator": "gt", "value": 1}]}])
        assert error.value.details["path"] == "rules.1.rules.1"

    def test_at_most_thirty_conditions(self):
        rule = {"field": "totalOrders", "operator": "gte", "value": 1}
        assert len(rules.clean("all", [rule] * 30)[1]) == 30
        with pytest.raises(ValidationError, match="at most 30"):
            rules.clean("all", [rule] * 31)

    def test_rules_must_be_a_list_of_objects(self):
        with pytest.raises(ValidationError):
            rules.clean("all", "everyone")
        with pytest.raises(ValidationError):
            rules.clean("all", ["totalOrders"])

    def test_empty_rules_match_everyone(self):
        assert rules.clean("all", None) == ("all", [])
        assert sql(rules.compile_rules("all", [], NOW)) == "true"


class TestCompile:
    def test_all_is_and_any_is_or_and_a_group_nests(self):
        cleaned = rules.clean("any", [
            {"field": "totalOrders", "operator": "gte", "value": 2},
            {"match": "all", "rules": [{"field": "city", "operator": "equals", "value": "Pune"},
                                       {"field": "couponUses", "operator": "equals", "value": 0}]},
        ])[1]
        text = sql(rules.compile_rules("any", cleaned, NOW))
        assert text == ("customer_metrics.total_orders >= %s OR customer_metrics.city = %s "
                        "AND customer_metrics.coupon_uses = %s")  # AND binds tighter: the group holds
        anyof = rules.clean("all", [{"field": "totalOrders", "operator": "gte", "value": 2},
                                    {"match": "any", "rules": [{"field": "city", "operator": "equals", "value": "A"},
                                                               {"field": "city", "operator": "equals", "value": "B"}]}])[1]
        assert sql(rules.compile_rules("all", anyof, NOW)) == (
            "customer_metrics.total_orders >= %s AND (customer_metrics.city = %s OR customer_metrics.city = %s)")

    def test_values_are_bound_never_inlined(self):
        cleaned = one("name", "contains", "x'; DROP TABLE customers; --")
        compiled = rules.compile_rules("all", cleaned, NOW).compile(dialect=mysql.dialect())
        assert "DROP" not in str(compiled)
        assert any("DROP TABLE" in str(v) for v in compiled.params.values())

    def test_dates_are_utc_days(self):
        compiled = rules.compile_rules("all", one("lastOrderAt", "between", ["2026-01-01", "2026-01-31"]), NOW
                                       ).compile(dialect=mysql.dialect())
        values = sorted(v for v in compiled.params.values() if isinstance(v, datetime))
        assert values == [datetime(2026, 1, 1), datetime(2026, 2, 1)]
        after = rules.compile_rules("all", one("lastOrderAt", "after", "2026-01-31"), NOW).compile(dialect=mysql.dialect())
        assert datetime(2026, 2, 1) in after.params.values()

    def test_within_last_days_counts_back_from_now_and_its_negation_includes_never(self):
        within = rules.compile_rules("all", one("lastOrderAt", "within-last-days", 30), NOW).compile(dialect=mysql.dialect())
        assert NOW - timedelta(days=30) in within.params.values()
        text = sql(rules.compile_rules("all", one("lastOrderAt", "not-within-last-days", 30), NOW))
        assert "IS NULL" in text

    def test_list_fields_use_exists_or_json(self):
        assert "EXISTS" in sql(rules.compile_rules("all", one("purchasedProducts", "in", ["PRD001"]), NOW))
        assert "NOT (EXISTS" in sql(rules.compile_rules("all", one("purchasedProducts", "not-contains", "PRD001"), NOW))
        rule = [{"field": "purchasedCategories", "operator": "contains", "value": "CAT001"}]
        assert "json_contains" in sql(rules.compile_rules("all", rule, NOW)).lower()


class TestRfm:
    conf = metrics.clean_settings(metrics.DEFAULT_SETTINGS)

    @pytest.mark.parametrize("days,score", [(0, 5), (30, 5), (31, 4), (60, 4), (90, 3), (180, 2), (181, 1), (900, 1)])
    def test_recency_bands(self, days, score):
        assert metrics.score_recency(self.conf, days) == score

    @pytest.mark.parametrize("orders,score", [(0, 0), (1, 1), (2, 2), (3, 3), (4, 3), (5, 4), (8, 5), (40, 5)])
    def test_frequency_bands(self, orders, score):
        assert metrics.score_frequency(self.conf, orders) == score

    @pytest.mark.parametrize("rupees,score", [(0, 1), (999.99, 1), (1000, 2), (2999, 2), (3000, 3), (7500, 4),
                                              (15000, 5), (99999, 5)])
    def test_monetary_bands(self, rupees, score):
        assert metrics.score_monetary(self.conf, int(rupees * 100), 1) == score

    @pytest.mark.parametrize("r,f,m,label", [
        (5, 5, 5, "champions"), (4, 4, 4, "champions"), (5, 4, 3, "loyal"), (3, 3, 1, "loyal"),
        (5, 1, 1, "new"), (3, 1, 2, "potential"), (4, 2, 5, "potential"), (2, 4, 4, "at-risk"),
        (1, 5, 5, "at-risk"), (2, 1, 1, "hibernating"), (1, 2, 3, "lost"), (1, 1, 1, "lost"),
    ])
    def test_labels(self, r, f, m, label):
        assert metrics.label_for(self.conf, r, f, m) == label

    def test_the_default_map_covers_every_combination(self):
        for r in range(1, 6):
            for f in range(1, 6):
                for m in range(1, 6):
                    assert metrics.label_for(self.conf, r, f, m) in metrics.LABEL_KEYS

    def test_no_orders(self):
        assert metrics.rfm(self.conf, None, 0, 0, NOW)["rfm_label"] == "no-orders"
        assert metrics.label_for(self.conf, 0, 0, 0) == "no-orders"

    def test_whole_customer(self):
        scores = metrics.rfm(self.conf, NOW - timedelta(days=10), 6, 2_000_000, NOW)
        assert scores == {"recency_score": 5, "frequency_score": 4, "monetary_score": 5, "rfm_label": "champions"}

    def test_changed_bands_change_the_scores(self):
        conf = metrics.clean_settings({**metrics.DEFAULT_SETTINGS, "recencyDays": [7, 14, 21, 28],
                                       "frequencyOrders": [10, 20, 30, 40]})
        assert metrics.score_recency(conf, 10) == 4
        assert metrics.score_frequency(conf, 9) == 1

    def test_a_gap_in_an_edited_map_falls_back(self):
        conf = metrics.clean_settings({**metrics.DEFAULT_SETTINGS, "labels": [
            {"key": "champions", "label": "Best", "r": [5, 5], "f": [5, 5], "m": [5, 5]}]})
        assert metrics.label_for(conf, 1, 3, 3) == "lost"
        assert metrics.label_for(conf, 3, 3, 3) == "potential"
        assert metrics.label_names(conf)["champions"] == "Best"


class TestSettingsValidation:
    @pytest.mark.parametrize("patch,words", [
        ({"recencyDays": [30, 60, 90]}, "exactly four"),
        ({"recencyDays": [30, 30, 90, 180]}, "must go up"),
        ({"frequencyOrders": [1.5, 2, 3, 4]}, "whole numbers"),
        ({"monetaryRupees": [0, 1, 2, 3]}, "positive"),
        ({"monetaryRupees": ["a", 1, 2, 3]}, "numbers"),
        ({"refreshHours": 0}, "1 to 48"),
        ({"labels": [{"key": "vip", "label": "V", "r": [1, 5], "f": [1, 5], "m": [1, 5]}]}, "must be one of"),
        ({"labels": [{"key": "lost", "label": "L", "r": [1, 5], "f": [1, 5], "m": [1, 5]}] * 2}, "listed twice"),
        ({"labels": [{"key": "lost", "label": "", "r": [1, 5], "f": [1, 5], "m": [1, 5]}]}, "name"),
        ({"labels": [{"key": "lost", "label": "L", "r": [3, 1], "f": [1, 5], "m": [1, 5]}]}, "range from 1 to 5"),
        ({"labels": []}, "List the RFM groups"),
    ])
    def test_refused(self, patch, words):
        with pytest.raises(ValidationError) as error:
            metrics.clean_settings({**metrics.DEFAULT_SETTINGS, **patch})
        assert error.value.error_code == "INVALID_SEGMENT_SETTINGS"
        assert words in error.value.message

    def test_not_an_object(self):
        with pytest.raises(ValidationError):
            metrics.clean_settings([])
