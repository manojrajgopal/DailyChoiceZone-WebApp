"""
The pure parts of packing and labels: PDF text and money, Code 39 input, the
label format registry and renderer (one page per package, the same bytes
from the same snapshot), the package aggregation and volumetric weight.
"""

from __future__ import annotations

import re
from types import SimpleNamespace

import pytest

from app.services.fulfilment import label_pdf, packing
from app.services.fulfilment import pdf as P


def pages(data: bytes) -> int:
    return len(re.findall(rb"/Type\s*/Page(?!s)", data))


def snapshot(**overrides) -> dict:
    data = {
        "format": "thermal-4x6", "version": 1, "generatedAt": "2026-10-02T10:00:00",
        "seller": {"name": "Daily Choice Zone", "line1": "12 Industrial Area", "line2": "", "city": "Bengaluru",
                   "state": "Karnataka", "pincode": "560058", "phone": "9876500099", "gstin": "29AABCD1234E1Z5"},
        "buyer": {"name": "Asha Rao", "phone": "9876500001", "line1": "4 Brigade Road", "line2": "",
                  "city": "Bengaluru", "state": "Karnataka", "pincode": "560001", "country": "India"},
        "shipment": {"number": "DCZ-SH-2026-000001", "awb": "LX-100200", "courierName": "Local Express",
                     "service": "Surface", "providerCode": "manual", "orderNumber": "DCZ10001",
                     "orderDate": "2026-10-01T09:00:00"},
        "cod": True, "codAmount": 123450, "declaredValue": 123450,
        "packages": [{"number": "DCZ-PKG-2026-000001", "weightGrams": 800, "lengthCm": 30, "widthCm": 20,
                      "heightCm": 5, "type": "box",
                      "items": [{"sku": "DCZ-WO0001", "name": "Cotton Kurta", "size": "M", "color": "Red",
                                 "quantity": 2}]}],
    }
    data.update(overrides)
    return data


class TestText:
    def test_typography_and_non_latin(self):
        assert P.text("Asha — “Rao” ₹500") == 'Asha - "Rao" Rs.500'
        assert P.text("अशा") == "???"
        assert P.text("  two   spaces ") == "two spaces"
        assert P.text(None) == ""
        assert P.text("abcdefghij", 6) == "abc..."

    @pytest.mark.parametrize("paise, text", [
        (0, "Rs. 0.00"), (99, "Rs. 0.99"), (123450, "Rs. 1,234.50"), (12345678900, "Rs. 12,34,56,789.00"),
        (-50000, "-Rs. 500.00"), (100000000, "Rs. 10,00,000.00"),
    ])
    def test_indian_money(self, paise, text):
        assert P.money(paise) == text

    def test_code39(self):
        assert P.code39_text("ab-12_x/9") == "AB-12X/9"
        assert P.code39_text("") == ""

    def test_day(self):
        assert P.day("2026-10-02T10:00:00") == "2 Oct 2026"
        assert P.day("nonsense") == "" and P.day(None) == ""


class TestLabelPdf:
    @pytest.mark.parametrize("key", sorted(label_pdf.FORMATS))
    def test_every_format_renders(self, key):
        data = label_pdf.render(snapshot(), key)
        assert data.startswith(b"%PDF") and pages(data) == 1

    def test_a_page_per_package(self):
        package = snapshot()["packages"][0]
        data = label_pdf.render(snapshot(packages=[package, dict(package, number="B"), dict(package, number="C")]))
        assert pages(data) == 3

    def test_deterministic(self):
        assert label_pdf.render(snapshot()) == label_pdf.render(snapshot())
        assert label_pdf.render(snapshot()) != label_pdf.render(snapshot(version=2))

    def test_void_stamp_and_prepaid(self):
        assert label_pdf.render(snapshot(void="SUPERSEDED")) != label_pdf.render(snapshot())
        assert label_pdf.render(snapshot(cod=False)).startswith(b"%PDF")

    def test_long_contents_and_odd_text(self):
        item = {"sku": "S", "name": "क" * 200, "size": "", "color": "", "quantity": 1}
        package = dict(snapshot()["packages"][0], items=[item] * 9, lengthCm=None)
        assert label_pdf.render(snapshot(packages=[package], buyer={"name": "x" * 300})).startswith(b"%PDF")

    def test_no_packages_is_refused(self):
        with pytest.raises(ValueError):
            label_pdf.render(snapshot(packages=[]))

    def test_unknown_format_falls_back(self):
        assert label_pdf.render(snapshot(format="poster")).startswith(b"%PDF")

    def test_many_in_one(self):
        data = label_pdf.render_many([snapshot(), snapshot(format="a4")])
        assert pages(data) == 2

    def test_registry(self):
        keys = [f["key"] for f in label_pdf.formats()]
        assert keys == ["thermal-4x6", "standard", "a4"]


def box(weight, length, width, height, kind="box"):
    return SimpleNamespace(weight_grams=weight, length_cm=length, width_cm=width, height_cm=height,
                           package_type=kind)


class TestAggregation:
    def test_total_weight_count_and_largest_box(self):
        result = packing.aggregate([box(800, 30, 20, 5), box(1200, 40, 30, 20, "crate"), box(300, 10, 10, 10)])
        assert result == {"weightGrams": 2300, "lengthCm": 40.0, "widthCm": 30.0, "heightCm": 20.0, "count": 3,
                          "type": "crate"}

    def test_missing_weight_means_unknown_total(self):
        assert packing.aggregate([box(800, 30, 20, 5), box(None, 10, 10, 10)])["weightGrams"] is None

    def test_none(self):
        assert packing.aggregate([]) is None

    def test_volumetric(self):
        assert packing.volumetric_kg(box(1, 30, 20, 5), 5000) == 0.6
        assert packing.volumetric_kg(box(1, 33.3, 21.7, 9.9), 4000) == 1.79
        assert packing.volumetric_kg(box(1, None, 20, 5), 5000) is None
