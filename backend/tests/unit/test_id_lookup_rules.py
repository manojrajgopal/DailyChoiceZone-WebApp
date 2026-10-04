"""The ID lookup's pure rules: what counts as an ID, and which SQL a query becomes."""

from __future__ import annotations

import pytest
from sqlalchemy.dialects import mysql

from app.core.errors import ValidationError
from app.services.lookup import ADMIN_ENTITIES, CUSTOMER_ENTITIES, normalise
from app.services.lookup.service import _conditions, _could_start, _rank


def _sql(condition) -> str:
    return str(condition.compile(dialect=mysql.dialect(), compile_kwargs={"literal_binds": True}))


class TestNormalise:
    @pytest.mark.parametrize("raw, expected", [
        ("prd001", "PRD001"), ("  PRD 001 ", "PRD001"), ("#12", "12"), ("dcz-sh-2026-000001", "DCZ-SH-2026-000001"),
        ("", ""), (None, ""), ("pay_Nx3", "PAY_NX3"),
    ])
    def test_accepts_identifier_text(self, raw, expected):
        assert normalise(raw) == expected

    @pytest.mark.parametrize("raw", ["%", "a@b.com", "x' OR 1=1", "PRD;", "_PRD", "-1", "a/b", "é"])
    def test_refuses_what_no_id_contains(self, raw):
        with pytest.raises(ValidationError) as caught:
            normalise(raw, label="Order ID")
        assert caught.value.error_code == "LOOKUP_INVALID_ID"
        assert "Order ID" in caught.value.message

    def test_refuses_over_long_text(self):
        with pytest.raises(ValidationError):
            normalise("A" * 65)


class TestConditions:
    product = ADMIN_ENTITIES["product"]

    def test_a_prefix_is_an_escaped_like(self):
        sql = [_sql(c) for c in _conditions(self.product, self.product.columns[0], "PRD_1")]
        assert any("LIKE 'PRD!_1%%' ESCAPE '!'" in s or "LIKE 'PRD!_1%' ESCAPE '!'" in s for s in sql)

    def test_digits_add_the_prefix_and_its_padding(self):
        sql = " ".join(_sql(c) for c in _conditions(self.product, self.product.columns[0], "7"))
        assert "PRD7%" in sql and "PRD007%" in sql

    def test_another_prefix_skips_the_column_without_a_query(self):
        assert _conditions(self.product, self.product.columns[0], "ORD1") == []
        assert not _could_start("PRD", "ORD")
        assert _could_start("PRD", "PR") and _could_start("DCZ-", "DCZ-SH-2026")

    def test_integer_keys_become_primary_key_ranges(self):
        segment = ADMIN_ENTITIES["segment"]
        sql = [_sql(c) for c in _conditions(segment, segment.columns[0], "12")]
        assert sql[0].endswith("= 12")
        assert "BETWEEN 120 AND 129" in sql[1] and "BETWEEN 1200 AND 1299" in sql[2]
        assert all("LIKE" not in s for s in sql)

    def test_integer_keys_ignore_text_and_leading_zeros(self):
        segment = ADMIN_ENTITIES["segment"]
        assert _conditions(segment, segment.columns[0], "SEG") == []
        assert _conditions(segment, segment.columns[0], "012") == []

    def test_gift_cards_accept_their_gc_prefix(self):
        gift = ADMIN_ENTITIES["gift_card"]
        assert _sql(_conditions(gift, gift.columns[0], "GC5")[0]).endswith("= 5")

    def test_yearly_numbers_match_their_running_number_anywhere(self):
        shipment = ADMIN_ENTITIES["shipment"]
        sql = " ".join(_sql(c) for c in _conditions(shipment, shipment.columns[0], "000123"))
        assert "'%%000123%%'" in sql or "'%000123%'" in sql

    def test_short_digits_do_not_scan(self):
        shipment = ADMIN_ENTITIES["shipment"]
        assert _conditions(shipment, shipment.columns[0], "12") == []


class TestRank:
    def test_exact_before_prefix_before_shorter(self):
        product = ADMIN_ENTITIES["product"]
        rows = [("PRD0010", "A"), ("PRD001", "B"), ("PRD002", "PRD001X")]
        ranked = sorted(rows, key=lambda r: _rank(product, "PRD001", r))
        assert ranked[0] == ("PRD001", "B")


class TestRegistry:
    def test_every_entity_has_an_example_and_a_preview(self):
        for entity in [*ADMIN_ENTITIES.values(), *CUSTOMER_ENTITIES.values()]:
            assert entity.example and callable(entity.preview)
            assert entity.id_label.endswith(" ID")

    def test_no_name_email_phone_or_slug_column_is_ever_an_identifier(self):
        banned = {"name", "email", "phone", "slug", "first_name", "last_name", "title", "customer_name",
                  "customer_email", "recipient_email", "recipient_name", "description", "subject"}
        for entity in [*ADMIN_ENTITIES.values(), *CUSTOMER_ENTITIES.values()]:
            assert not {c.attr for c in entity.columns} & banned, entity.key

    def test_every_customer_entity_is_owner_scoped(self):
        for entity in CUSTOMER_ENTITIES.values():
            assert entity.owner == "customer_id"
