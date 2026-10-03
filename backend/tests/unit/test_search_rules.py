"""
The pure rules of search & filters: term normalisation and LIKE escaping, the
optimal-string-alignment (Damerau–Levenshtein) distance behind "did you mean",
synonym and popular-search validation, attribute code / option / value rules,
and the small analytics helpers. See docs/search-and-filters.md.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.core.errors import ValidationError
from app.schemas.catalogue import AttributeFilter, ProductQuery
from app.services.search import analytics, dictionary, registry
from app.services.search import attributes as A
from app.services.search import settings as S
from app.services.search.base import MAX_TERM_LENGTH, MAX_WORDS, escape_like, normalise, tokens, words


def code_of(call) -> str:
    with pytest.raises(ValidationError) as caught:
        call()
    return caught.value.error_code


# ================================================================== normalisation


class TestNormalise:
    @pytest.mark.parametrize("raw, expected", [
        (None, ""),
        ("", ""),
        ("   ", ""),
        ("  Steel   Bottle  ", "steel bottle"),
        ("STEEL BOTTLE", "steel bottle"),
        ("ＳＴＥＥＬ", "steel"),          # full-width letters fold (NFKC)
        ("ﬁne", "fine"),             # the "fi" ligature
        ("lamp\x00shade", "lampshade"),   # NUL dropped
        ("‮abc", "abc"),             # a right-to-left override dropped
    ])
    def test_normalise(self, raw, expected):
        assert normalise(raw) == expected

    def test_it_is_bounded(self):
        assert len(normalise("x" * 500)) == MAX_TERM_LENGTH == 200

    @pytest.mark.parametrize("raw", ["steel\tbottle", "steel\nbottle", "steel\r\nbottle"])
    def test_tabs_and_newlines_separate_words(self, raw):
        """A pasted 'steel<TAB>bottle' is two words, like 'steel bottle' (docs: inner whitespace collapsed)."""
        assert normalise(raw) == "steel bottle"

    def test_idempotent(self):
        once = normalise("  Ｓｔｅｅｌ   BOTTLE ")
        assert normalise(once) == once == "steel bottle"


class TestWordsAndTokens:
    def test_words_keep_order_and_drop_repeats(self):
        assert words("tee shirt tee top") == ["tee", "shirt", "top"]

    def test_words_are_bounded(self):
        assert words(" ".join(f"w{i}" for i in range(20))) == [f"w{i}" for i in range(MAX_WORDS)]

    def test_words_of_blank(self):
        assert words("") == []

    def test_tokens_keep_hyphenated_and_apostrophe_words_whole(self):
        assert tokens("Steel-Bottle's 2-in-1 (500ml), Kids'") == ["steel-bottle's", "2-in-1", "500ml", "kids"]

    def test_tokens_drop_punctuation(self):
        assert tokens("--- !!! ...") == []


class TestEscapeLike:
    @pytest.mark.parametrize("raw, expected", [
        ("50%", "50!%"),
        ("a_b", "a!_b"),
        ("!", "!!"),
        ("!%_", "!!!%!_"),
        ("plain", "plain"),
    ])
    def test_escape(self, raw, expected):
        assert escape_like(raw) == expected


class TestParse:
    def test_without_a_session_there_are_no_synonyms(self):
        terms = registry.parse(None, "  Tee  tee SHIRT ")
        assert terms.phrase == "tee tee shirt"
        assert terms.groups == [["tee"], ["shirt"]]
        assert not terms.empty

    def test_blank_is_empty(self):
        assert registry.parse(None, "   ").empty
        assert registry.parse(None, None).groups == []

    def test_the_default_backend_is_mysql(self):
        assert registry.backend().name == "mysql"
        assert registry.backend() is registry.backend()


# ================================================================== the edit distance


class TestDistance:
    @pytest.mark.parametrize("a, b, expected", [
        ("steel", "steel", 0),
        ("ceramic", "cearmic", 1),   # a swap of neighbours is one edit
        ("bottle", "botle", 1),      # a deletion
        ("botle", "bottle", 1),      # an insertion
        ("shirt", "shirk", 1),       # a substitution
        ("bottle", "bottel", 1),     # swap at the end
        ("kitten", "sitting", 3),
        ("", "abc", 3),
        ("abc", "", 3),
    ])
    def test_distance(self, a, b, expected):
        assert dictionary.distance(a, b) == expected

    def test_it_is_symmetric(self):
        for a, b in [("ceramic", "cearmic"), ("kitchen", "kichten"), ("vase", "vsae")]:
            assert dictionary.distance(a, b) == dictionary.distance(b, a)

    def test_it_is_optimal_string_alignment_not_unrestricted(self):
        """OSA can't edit a swapped pair again: 'ca' → 'abc' is 3 (unrestricted Damerau–Levenshtein says 2)."""
        assert dictionary.distance("ca", "abc") == 3

    def test_a_length_gap_beyond_the_limit_short_circuits(self):
        assert dictionary.distance("a", "abcdef", limit=2) == 3

    def test_it_is_capped_at_limit_plus_one(self):
        assert dictionary.distance("abcdef", "uvwxyz", limit=2) == 3
        assert dictionary.distance("abcdef", "uvwxyz", limit=10) == 6

    @pytest.mark.parametrize("word, allowed", [("tee", 1), ("shoe", 1), ("shirt", 2), ("ceramic", 2)])
    def test_allowed_distance(self, word, allowed):
        assert dictionary.allowed_distance(word) == allowed

    @pytest.mark.parametrize("word, kept", [("ab", False), ("abc", True), ("2024", False), ("a" * 80, True),
                                            ("a" * 81, False), ("500ml", True)])
    def test_which_words_the_dictionary_keeps(self, word, kept):
        assert dictionary._keep(word) is kept


# ================================================================== search settings


class TestSynonymValidation:
    def test_groups_are_normalised(self):
        assert S.clean_synonyms([["Tee", " T-Shirt ", "TSHIRT"]]) == [["tee", "t-shirt", "tshirt"]]

    def test_a_group_may_be_a_comma_or_equals_string(self):
        assert S.clean_synonyms(["tee, t-shirt = tshirt"]) == [["tee", "t-shirt", "tshirt"]]

    def test_repeats_and_blanks_go_and_a_lone_word_is_no_group(self):
        assert S.clean_synonyms([["tee", "TEE", "", "  "], ["sofa", "couch", "sofa"]]) == [["sofa", "couch"]]

    def test_bounds_that_pass(self):
        assert len(S.clean_synonyms([["a" * 40, "b"]])[0][0]) == 40
        assert len(S.clean_synonyms([[f"w{i}" for i in range(10)]])[0]) == 10
        assert len(S.clean_synonyms([[f"a{i}", f"b{i}"] for i in range(200)])) == 200

    @pytest.mark.parametrize("groups", [
        "tee,shirt",                                       # not a list of groups
        [["two words", "pair"]],                           # a synonym is one word
        [["a" * 41, "b"]],                                 # too long
        [[f"w{i}" for i in range(11)]],                    # too many in a group
        [[f"a{i}", f"b{i}"] for i in range(201)],          # too many groups
        [42],                                              # a group that isn't a list
        [["tee", 7]],                                      # a term that isn't text
    ])
    def test_refused(self, groups):
        assert code_of(lambda: S.clean_synonyms(groups)) == "INVALID_SYNONYMS"

    def test_the_map_links_every_member_both_ways(self, monkeypatch):
        monkeypatch.setattr(S, "synonym_groups", lambda db: [["tee", "t-shirt"], ["tee", "top"]])
        mapping = S.synonym_map(None)
        assert mapping == {"tee": ["t-shirt", "top"], "t-shirt": ["tee"], "top": ["tee"]}

    def test_parse_applies_the_map(self, monkeypatch):
        monkeypatch.setattr(S, "synonym_groups", lambda db: [["flask", "thermos"]])
        assert registry.parse(object(), "thermos steel").groups == [["thermos", "flask"], ["steel"]]


class TestPopularValidation:
    def test_cleaned(self):
        assert S.clean_popular(["  steel   bottle ", "Steel Bottle", "", "lunch box"]) == ["steel bottle", "lunch box"]

    def test_duplicates_do_not_count_toward_the_limit(self):
        assert len(S.clean_popular([f"term {i % 20}" for i in range(40)])) == 20

    @pytest.mark.parametrize("values", ["steel", [1], ["x" * 61], [f"term {i}" for i in range(21)]])
    def test_refused(self, values):
        assert code_of(lambda: S.clean_popular(values)) == "INVALID_POPULAR_SEARCHES"

    def test_sixty_characters_is_fine(self):
        assert S.clean_popular(["x" * 60]) == ["x" * 60]

    def test_an_unknown_popular_mode_is_refused_before_anything_is_written(self):
        assert code_of(lambda: S.save(None, popular_mode="sometimes")) == "INVALID_POPULAR_MODE"


# ================================================================== attributes


def attribute(kind, options=(), label="Material"):
    return SimpleNamespace(type=kind, label=label,
                           options=[SimpleNamespace(value=v, label=v.title()) for v in options])


class TestAttributeCode:
    @pytest.mark.parametrize("code, ok", [
        ("material", True), ("dishwasher_safe", True), ("a1", True), ("a" * 40, True),
        ("m", False), ("a" * 41, False), ("1abc", False), ("_abc", False), ("Material", False),
        ("dish-washer", False), ("dish washer", False), ("", False),
    ])
    def test_code_rule(self, code, ok):
        assert bool(A.CODE.match(code)) is ok


class TestCleanOptions:
    def test_the_value_defaults_to_the_slug_of_the_label(self):
        cleaned = A._clean_options([{"label": "  Stainless   Steel "}, {"label": "Glass", "value": "Clear Glass"}])
        assert cleaned == [
            {"id": None, "value": "stainless-steel", "label": "Stainless Steel", "position": 0},
            {"id": None, "value": "clear-glass", "label": "Glass", "position": 1},
        ]

    def test_a_rename_keeps_the_existing_value(self):
        existing = [SimpleNamespace(id=7, value="steel")]
        assert A._clean_options([{"id": 7, "label": "Stainless"}], existing)[0]["value"] == "steel"

    @pytest.mark.parametrize("options, error", [
        ("steel", "INVALID_OPTIONS"),
        ([{"label": ""}], "INVALID_OPTIONS"),
        ([{"label": "!!!"}], "INVALID_OPTIONS"),               # no letters or digits to slug
        ([{"id": 99, "label": "Ghost"}], "INVALID_OPTIONS"),   # not this attribute's option
        ([{"label": "Steel"}, {"label": "STEEL"}], "DUPLICATE_OPTION"),
        ([{"label": f"o{i}"} for i in range(201)], "INVALID_OPTIONS"),
    ])
    def test_refused(self, options, error):
        assert code_of(lambda: A._clean_options(options)) == error


class TestAttributeValues:
    @pytest.mark.parametrize("raw, text, number", [
        (750, "750", Decimal("750.0000")),
        ("12.50", "12.5", Decimal("12.5000")),
        (0, "0", Decimal("0")),
        (-5, "-5", Decimal("-5")),
        ("1e3", "1000", Decimal("1000")),
        (1_000_000_000, "1000000000", Decimal("1000000000")),
    ])
    def test_numbers(self, raw, text, number):
        [row] = A._rows_for(attribute("number"), raw)
        assert row["value"] == row["value_normalized"] == text
        assert row["value_number"] == number

    @pytest.mark.parametrize("raw", [True, "lots", float("nan"), "inf", 1_000_000_001, [1], {"n": 1}])
    def test_bad_numbers(self, raw):
        assert code_of(lambda: A._rows_for(attribute("number"), raw)) == "INVALID_ATTRIBUTE_VALUE"

    @pytest.mark.parametrize("raw", [None, [], ""])
    def test_blank_clears(self, raw):
        assert A._rows_for(attribute("multi", ["steel"]), raw) == []

    def test_booleans(self):
        assert A._rows_for(attribute("boolean"), True) == [
            {"value": "Yes", "value_normalized": "true", "value_number": None}]
        assert A._rows_for(attribute("boolean"), False)[0]["value_normalized"] == "false"
        assert code_of(lambda: A._rows_for(attribute("boolean"), "true")) == "INVALID_ATTRIBUTE_VALUE"

    def test_select_takes_one_known_option(self):
        assert A._rows_for(attribute("select", ["steel", "glass"]), "glass") == [
            {"value": "Glass", "value_normalized": "glass", "value_number": None}]
        assert code_of(lambda: A._rows_for(attribute("select", ["steel"]), ["steel"])) == "INVALID_ATTRIBUTE_VALUE"
        assert code_of(lambda: A._rows_for(attribute("select", ["steel"]), "wood")) == "INVALID_ATTRIBUTE_VALUE"

    def test_multi_takes_known_options_without_repeats(self):
        rows = A._rows_for(attribute("multi", ["steel", "glass"]), ["glass", "steel", "glass"])
        assert [r["value_normalized"] for r in rows] == ["glass", "steel"]
        assert [r["value_normalized"] for r in A._rows_for(attribute("multi", ["steel"]), "steel")] == ["steel"]

    def test_multi_refusals(self):
        many = [f"o{i}" for i in range(31)]
        assert code_of(lambda: A._rows_for(attribute("multi", many), many)) == "INVALID_ATTRIBUTE_VALUE"
        assert code_of(lambda: A._rows_for(attribute("multi", ["steel"]), ["steel", 3])) == "INVALID_ATTRIBUTE_VALUE"
        assert code_of(lambda: A._rows_for(attribute("multi", ["steel"]), ["wood"])) == "INVALID_ATTRIBUTE_VALUE"


# ================================================================== analytics helpers


class TestAnalyticsHelpers:
    def test_percentages(self):
        assert analytics._pct(1, 3) == 33.3
        assert analytics._pct(5, 0) == 0.0

    @pytest.mark.parametrize("key, days, start", [
        ("7d", 7, date(2026, 9, 26)), ("30d", 30, date(2026, 9, 3)), ("90d", 90, date(2026, 7, 5)),
        ("1y", 30, date(2026, 9, 3)),
    ])
    def test_the_window_includes_today(self, key, days, start):
        assert analytics._window(key, date(2026, 10, 2)) == (days, start, date(2026, 10, 2))

    def test_the_visitor_hash(self):
        from app.services.analytics_events import visitor_key

        assert analytics.visitor_hash("abcd1234", "CUS001") == visitor_key(customer_id="CUS001")
        assert analytics.visitor_hash("abcd1234", None) == visitor_key("abcd1234")
        assert analytics.visitor_hash("short", None) == ""
        assert analytics.visitor_hash("has spaces in it", None) == ""
        assert analytics.visitor_hash(None, None) == ""
        assert "abcd1234" not in analytics.visitor_hash("abcd1234", None)

    def test_filters_summary_names_the_dimensions_in_use(self):
        query = ProductQuery(brands=["Terra"], min_price=1, availability="in-stock",
                             attributes=[AttributeFilter(code="material", values=["steel"])])
        assert analytics.filters_summary(query) == "brand,price,availability,attributes"
        assert analytics.filters_summary(ProductQuery()) == ""
