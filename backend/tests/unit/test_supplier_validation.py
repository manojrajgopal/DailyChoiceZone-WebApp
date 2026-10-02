"""
Supplier field validation, without the API: GSTIN format and checksum, PAN,
phone, email, pincode, code, credit days, and the money / quantity helpers
shared with purchase orders.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.core.errors import ValidationError
from app.services import purchasing
from app.services import suppliers as s

CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def _check(first14: str) -> str:
    total = 0
    for i, ch in enumerate(first14):
        v = CHARS.index(ch) * (2 if i % 2 else 1)
        total += v // 36 + v % 36
    return CHARS[(36 - total % 36) % 36]


def _gstin(state="29", pan="ABCDE1234F", entity="1"):
    head = f"{state}{pan}{entity}Z"
    return head + _check(head)


def _base(**overrides):
    data = {"code": "ANVI-TEX", "name": "Anvi Textiles", "gstin": _gstin(), "pan": "ABCDE1234F",
            "taxTreatment": "registered",
            "billingAddress": {"line1": "1 Road", "city": "Bengaluru", "state": "Karnataka", "country": "India",
                               "pincode": "560001"}}
    data.update(overrides)
    return data


def _code_of(callable_, *args, **kwargs):
    with pytest.raises(ValidationError) as caught:
        callable_(*args, **kwargs)
    return caught.value.error_code, caught.value.details


# ------------------------------------------------------------------- GSTIN


class TestGstin:
    def test_a_published_gstin_has_the_check_character_it_should(self):
        # A widely published sample GSTIN; its check character is V.
        assert s.gstin_check_character("27AAPFU0939F1Z") == "V"
        assert s.is_valid_gstin("27AAPFU0939F1ZV")

    @pytest.mark.parametrize("state,pan,entity", [("29", "ABCDE1234F", "1"), ("07", "AAACR5055K", "2"),
                                                  ("33", "ZZZZZ9999Z", "9"), ("01", "AAAAA0000A", "A"),
                                                  ("38", "PQRST4321L", "Z"), ("97", "AAAPL1234C", "1")])
    def test_computed_gstins_are_valid(self, state, pan, entity):
        assert s.is_valid_gstin(_gstin(state, pan, entity))

    def test_every_wrong_check_character_is_refused(self):
        good = _gstin()
        for char in CHARS:
            if char != good[-1]:
                assert not s.is_valid_gstin(good[:-1] + char), char

    def test_a_single_changed_character_is_caught(self):
        good = _gstin()
        tampered = good[:5] + ("X" if good[5] != "X" else "Y") + good[6:]
        assert not s.is_valid_gstin(tampered)

    @pytest.mark.parametrize("value", ["", "29ABCDE1234F1Z", "29ABCDE1234F1Z55", "29abcde1234f1z5",
                                       "AAABCDE1234F1Z5", "29ABCDE1234F0Z5", "29ABCDE1234F1X5", "00ABCDE1234F1Z5",
                                       "29ABCD11234F1Z5", "39ABCDE1234F1Z5"])
    def test_malformed_gstins_are_refused(self, value):
        assert not s.is_valid_gstin(value)

    def test_validation_reports_the_gstin_field(self):
        code, details = _code_of(s.validate_supplier, _base(gstin=_gstin()[:-1] + "0"
                                                           if _gstin()[-1] != "0" else _gstin()[:-1] + "1"))
        assert code == "INVALID_GSTIN" and details == {"field": "gstin"}

    def test_lower_case_and_spaces_are_normalised(self):
        good = _gstin()
        clean = s.validate_supplier(_base(gstin=" " + good.lower() + " "))
        assert clean["gstin"] == good

    def test_registered_needs_a_gstin(self):
        code, details = _code_of(s.validate_supplier, _base(gstin="", pan=""))
        assert code == "GSTIN_REQUIRED" and details["field"] == "gstin"

    @pytest.mark.parametrize("treatment", ["unregistered", "overseas"])
    def test_without_gst_registration_no_gstin_is_fine(self, treatment):
        clean = s.validate_supplier(_base(gstin=None, pan=None, taxTreatment=treatment))
        assert clean["gstin"] is None and clean["tax_treatment"] == treatment

    def test_the_treatment_defaults_from_whether_a_gstin_is_given(self):
        assert s.validate_supplier(_base(taxTreatment=""))["tax_treatment"] == "registered"
        assert s.validate_supplier(_base(taxTreatment="", gstin="", pan=""))["tax_treatment"] == "unregistered"

    def test_an_unknown_treatment_is_refused(self):
        assert _code_of(s.validate_supplier, _base(taxTreatment="exempt"))[0] == "INVALID_TAX_TREATMENT"


# --------------------------------------------------------------------- PAN


class TestPan:
    @pytest.mark.parametrize("value", ["ABCDE1234", "ABCD12345F", "abcde1234f1", "12345ABCDE", "ABCDE12345"])
    def test_malformed_pans_are_refused(self, value):
        assert _code_of(s.validate_supplier, _base(gstin="", taxTreatment="unregistered", pan=value))[0] \
            == "INVALID_PAN"

    def test_a_pan_alone_is_fine(self):
        clean = s.validate_supplier(_base(gstin="", taxTreatment="unregistered", pan="abcde1234f"))
        assert clean["pan"] == "ABCDE1234F"

    def test_the_pan_must_match_the_gstin(self):
        code, details = _code_of(s.validate_supplier, _base(pan="ZZZZZ9999Z"))
        assert code == "PAN_GSTIN_MISMATCH" and details["field"] == "pan"

    def test_a_matching_pan_is_accepted(self):
        clean = s.validate_supplier(_base(gstin=_gstin("27", "AAACR5055K"), pan="AAACR5055K"))
        assert clean["pan"] == "AAACR5055K"


# ----------------------------------------------------------- contact fields


class TestContact:
    @pytest.mark.parametrize("phone,stored", [("9876543210", "9876543210"), ("98765 43210", "9876543210"),
                                              ("+91 98765-43210", "+919876543210"), ("+14155550123", "+14155550123"),
                                              ("", "")])
    def test_valid_phones(self, phone, stored):
        assert s.validate_supplier(_base(phone=phone))["phone"] == stored

    @pytest.mark.parametrize("phone", ["12345", "5876543210", "98765432101", "+0123456789", "phone", "+1234"])
    def test_invalid_phones(self, phone):
        code, details = _code_of(s.validate_supplier, _base(phone=phone))
        assert code == "INVALID_PHONE" and details == {"field": "phone"}

    @pytest.mark.parametrize("email", ["a@b", "plain", "a b@c.com", "@x.com", "a@@x.com"])
    def test_invalid_emails(self, email):
        assert _code_of(s.validate_supplier, _base(email=email))[0] == "INVALID_EMAIL"

    def test_email_is_lower_cased(self):
        assert s.validate_supplier(_base(email="Sales@Anvi.Example.com"))["email"] == "sales@anvi.example.com"

    def test_a_website_without_a_scheme_gets_one(self):
        assert s.validate_supplier(_base(website="anvi.example.com"))["website"] == "https://anvi.example.com"

    def test_a_nonsense_website_is_refused(self):
        assert _code_of(s.validate_supplier, _base(website="not a site"))[0] == "INVALID_WEBSITE"


# --------------------------------------------------------- code, name, terms


class TestCodeAndTerms:
    @pytest.mark.parametrize("code", ["AB", "ANVI-TEX", "A1-B2-C3", "X" * 30])
    def test_valid_codes(self, code):
        assert s.validate_supplier(_base(code=code))["code"] == code

    def test_codes_are_upper_cased(self):
        assert s.validate_supplier(_base(code="anvi-tex"))["code"] == "ANVI-TEX"

    @pytest.mark.parametrize("code", ["A", "X" * 31, "ANVI TEX", "ANVI_TEX", "ANVI.TEX", "ANVI/1"])
    def test_invalid_codes(self, code):
        code_, details = _code_of(s.validate_supplier, _base(code=code))
        assert code_ == "INVALID_SUPPLIER_CODE" and details["field"] == "code"

    def test_a_blank_code_is_left_to_be_generated(self):
        assert s.validate_supplier(_base(code=""))["code"] == ""

    @pytest.mark.parametrize("name", ["", "   ", None])
    def test_the_name_is_required(self, name):
        assert _code_of(s.validate_supplier, _base(name=name))[0] == "NAME_REQUIRED"

    def test_a_name_of_the_wrong_type_is_refused(self):
        assert _code_of(s.validate_supplier, _base(name=["x"]))[0] == "NAME_REQUIRED"

    @pytest.mark.parametrize("days", [0, 365, None, "30"])
    def test_credit_days_in_range(self, days):
        s.validate_supplier(_base(creditDays=days))

    @pytest.mark.parametrize("days", [-1, 366, 1.5, "lots", True])
    def test_credit_days_out_of_range(self, days):
        assert _code_of(s.validate_supplier, _base(creditDays=days))[0] == "INVALID_CREDIT_DAYS"

    @pytest.mark.parametrize("currency", ["RUPEES", "1NR", "IN"])
    def test_invalid_currency(self, currency):
        assert _code_of(s.validate_supplier, _base(currency=currency))[0] == "INVALID_CURRENCY"


# ---------------------------------------------------------------- addresses


class TestAddress:
    @pytest.mark.parametrize("pincode", ["56001", "5600011", "056001", "ABCDEF"])
    def test_an_indian_pincode_is_six_digits(self, pincode):
        code, details = _code_of(s.validate_supplier, _base(billingAddress={"country": "India", "pincode": pincode}))
        assert code == "INVALID_PINCODE" and details["field"] == "billingAddress.pincode"

    def test_a_foreign_postcode_is_not_checked(self):
        clean = s.validate_supplier(_base(gstin="", pan="", taxTreatment="overseas",
                                          billingAddress={"country": "United Kingdom", "pincode": "SW1A 1AA"}))
        assert clean["billing_address"]["pincode"] == "SW1A 1AA"

    def test_the_country_defaults_to_india_and_a_missing_address_is_blank(self):
        clean = s.validate_supplier(_base(billingAddress=None))
        assert clean["billing_address"]["country"] == "India" and clean["billing_address"]["line1"] == ""

    def test_the_warehouse_pincode_is_checked_too(self):
        code, details = _code_of(s.validate_supplier, _base(warehouseAddress={"line1": "x", "pincode": "12"}))
        assert code == "INVALID_PINCODE" and details["field"] == "warehouseAddress.pincode"

    def test_an_empty_warehouse_address_is_stored_as_none(self):
        assert s.validate_supplier(_base(warehouseAddress={"country": "India"}))["warehouse_address"] is None

    def test_an_address_that_is_not_an_object_is_refused(self):
        assert _code_of(s.validate_supplier, _base(billingAddress="Bengaluru"))[0] == "INVALID_ADDRESS"


# --------------------------------------------------------- shared number checks


class TestNumbers:
    @pytest.mark.parametrize("value,paise", [(450, 45000), ("450.50", 45050), (0.01, 1), (10_000_000, 1_000_000_000),
                                             (333.335, 33334)])
    def test_money_in_range(self, value, paise):
        assert s.money(value, field="purchaseCost", label="Cost", code="INVALID_PURCHASE_COST") == paise

    @pytest.mark.parametrize("value", [0, -1, 10_000_000.01, "abc", None, True, float("nan"), float("inf"), 0.001,
                                       [1]])
    def test_money_out_of_range(self, value):
        code, details = _code_of(s.money, value, field="purchaseCost", label="Cost", code="INVALID_PURCHASE_COST")
        assert code == "INVALID_PURCHASE_COST" and details["field"] == "purchaseCost"

    @pytest.mark.parametrize("value", [1, 1_000_000, "5", 5.0])
    def test_quantities_in_range(self, value):
        assert s.integer(value, field="q", label="Q", minimum=1, maximum=1_000_000, code="INVALID_QUANTITY") >= 1

    @pytest.mark.parametrize("value", [0, 1_000_001, -3, 2.5, "two", True, None])
    def test_quantities_out_of_range(self, value):
        assert _code_of(s.integer, value, field="q", label="Q", minimum=1, maximum=1_000_000,
                        code="INVALID_QUANTITY")[0] == "INVALID_QUANTITY"


# ------------------------------------------------------------------ PO tax


class TestLineTax:
    def test_intra_state_halves_sum_exactly(self):
        line = purchasing.line_amounts(1, 10021, Decimal("5"), "intra-state")
        assert line["tax"] == 501 and line["cgst"] == 251 and line["sgst"] == 250 and line["igst"] == 0
        assert line["total"] == 10522

    def test_inter_state_is_all_igst(self):
        line = purchasing.line_amounts(3, 33333, Decimal("18"), "inter-state")
        assert line["subtotal"] == 99999 and line["tax"] == 18000 and line["igst"] == 18000
        assert line["cgst"] == line["sgst"] == 0

    def test_no_gst_mode_charges_nothing(self):
        line = purchasing.line_amounts(2, 50000, Decimal("18"), "none")
        assert line["tax"] == 0 and line["total"] == 100000

    def test_default_rate_prefers_the_product_then_the_category(self):
        config = {"rates": {"cgst": 2.5, "sgst": 2.5, "igst": 5},
                  "categoryRates": {"electronics": {"cgst": 9, "sgst": 9, "igst": 18}}}
        assert purchasing.default_rate(Decimal("12"), "electronics", config, "intra-state") == Decimal("12")
        assert purchasing.default_rate(None, "electronics", config, "intra-state") == Decimal("18")
        assert purchasing.default_rate(None, "electronics", config, "inter-state") == Decimal("18")
        assert purchasing.default_rate(None, "women", config, "inter-state") == Decimal("5")
        assert purchasing.default_rate(Decimal("12"), "women", config, "none") == Decimal("0")
