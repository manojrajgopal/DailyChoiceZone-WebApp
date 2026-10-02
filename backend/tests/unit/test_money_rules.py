"""
Rules about money and its equivalents: tax, coupons, invoices, gift cards,
reward points, the payment window, and the masked payment details that are
the only instrument data the system keeps. Then campaigns, webhooks and
bounce notices, which decide what is sent and what is stored.

All pure functions, tested against worked examples. Amounts are paise
throughout, as in the application.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import pytest

from app.core.config import settings
from app.core.errors import ConflictError, ValidationError
from app.services import (
    billing,
    coupons,
    flash_sales,
    gift_cards,
    invoices,
    loyalty,
    membership,
    questions,
    returns,
    settlement,
    tenders,
    webhooks,
)
from app.services.email import bounces
from app.services.messaging import campaigns
from app.services.payments.razorpay import instrument_hint
from app.services.support import tickets

NOW = datetime(2026, 6, 15, 12, 0)

TAX = {"enabled": True, "taxType": "GST", "pricesIncludeTax": True, "originState": "Karnataka",
       "rates": {"cgst": 2.5, "sgst": 2.5, "igst": 5},
       "categoryRates": {"electronics": {"cgst": 9, "sgst": 9, "igst": 18}}}


# --------------------------------------------------------------------- tax


class TestTaxMode:
    @pytest.mark.parametrize("place", ["Karnataka", "  karnataka ", "KARNATAKA"])
    def test_same_state_is_intra(self, place):
        assert billing.tax_mode_for(place, TAX) == "intra-state"

    def test_other_state_is_inter(self):
        assert billing.tax_mode_for("Tamil Nadu", TAX) == "inter-state"

    def test_disabled_or_none(self):
        assert billing.tax_mode_for("Karnataka", {**TAX, "enabled": False}) == "none"
        assert billing.tax_mode_for("Karnataka", {**TAX, "taxType": "NONE"}) == "none"

    def test_rates_for_category(self):
        assert billing.rates_for("electronics", TAX)["igst"] == 18
        assert billing.rates_for("women", TAX) == TAX["rates"]
        assert billing.rates_for(None, TAX) == TAX["rates"]
        assert billing.rates_for(None, {}) == {"cgst": 0, "sgst": 0, "igst": 0}


class TestCalculateTax:
    def test_intra_state_inclusive_split_evenly(self):
        tax = billing.calculate_tax(10_500, "Karnataka", None, TAX)
        assert tax["mode"] == "intra-state" and tax["taxableAmount"] == 10_000
        assert (tax["cgst"], tax["sgst"], tax["igst"], tax["totalTax"]) == (250, 250, 0, 500)
        assert tax["ratePercent"] == 5

    def test_odd_tax_total_halves_still_sum(self):
        tax = billing.calculate_tax(10_501, "Karnataka", None, TAX)
        assert tax["cgst"] + tax["sgst"] == tax["totalTax"]
        assert tax["taxableAmount"] + tax["totalTax"] == 10_501

    def test_inter_state_is_igst_only(self):
        tax = billing.calculate_tax(11_800, "Kerala", "electronics", TAX)
        assert (tax["cgst"], tax["sgst"], tax["igst"]) == (0, 0, 1_800)
        assert tax["taxableAmount"] == 10_000 and tax["ratePercent"] == 18

    def test_exclusive_prices_add_tax_on_top(self):
        tax = billing.calculate_tax(10_000, "Karnataka", None, {**TAX, "pricesIncludeTax": False})
        assert tax["taxableAmount"] == 10_000 and tax["totalTax"] == 500

    @pytest.mark.parametrize("amount", [0, -100])
    def test_nothing_to_tax(self, amount):
        tax = billing.calculate_tax(amount, "Karnataka", None, TAX)
        assert tax["mode"] == "none" and tax["totalTax"] == 0 and tax["taxableAmount"] == 0

    def test_tax_disabled(self):
        tax = billing.calculate_tax(10_000, "Karnataka", None, {**TAX, "enabled": False})
        assert tax == {"mode": "none", "taxableAmount": 10_000, "cgst": 0, "sgst": 0, "igst": 0, "totalTax": 0,
                       "ratePercent": 0}


class TestCouponDiscount:
    def test_no_coupon(self):
        assert billing.calculate_coupon_discount(100_000, None) == 0
        assert billing.calculate_coupon_discount(100_000, {}) == 0

    def test_percent(self):
        assert billing.calculate_coupon_discount(100_000, {"type": "percent", "value": 10}) == 10_000

    def test_percent_capped(self):
        coupon = {"type": "percent", "value": 50, "maxDiscount": 200}
        assert billing.calculate_coupon_discount(100_000, coupon) == 20_000

    def test_below_minimum_subtotal(self):
        coupon = {"type": "percent", "value": 10, "minSubtotal": 500}
        assert billing.calculate_coupon_discount(49_999, coupon) == 0
        assert billing.calculate_coupon_discount(50_000, coupon) == 5_000  # the boundary qualifies

    def test_flat_never_exceeds_the_subtotal(self):
        assert billing.calculate_coupon_discount(30_000, {"type": "flat", "value": 100}) == 10_000
        assert billing.calculate_coupon_discount(5_000, {"type": "flat", "value": 100}) == 5_000

    def test_percent_over_100_is_capped_at_the_subtotal(self):
        assert billing.calculate_coupon_discount(5_000, {"type": "percent", "value": 150}) == 5_000

    def test_negative_values_never_add_money(self):
        assert billing.calculate_coupon_discount(5_000, {"type": "flat", "value": -100}) == 0
        assert billing.calculate_coupon_discount(5_000, {"type": "percent", "value": -10}) == 0

    def test_free_shipping_takes_nothing_off_the_goods(self):
        assert billing.calculate_coupon_discount(100_000, {"type": "free-shipping"}) == 0


class TestCouponStatus:
    def _coupon(self, **overrides):
        values = dict(active=True, starts_at=NOW - timedelta(days=1), ends_at=NOW + timedelta(days=1),
                      usage_limit=10, usage_count=0)
        values.update(overrides)
        return SimpleNamespace(**values)

    def test_active(self):
        assert coupons.effective_status(self._coupon(), NOW) == "active"

    def test_disabled_wins_over_everything(self):
        assert coupons.effective_status(self._coupon(active=False, usage_count=99), NOW) == "disabled"

    def test_scheduled(self):
        assert coupons.effective_status(self._coupon(starts_at=NOW + timedelta(seconds=1)), NOW) == "scheduled"

    def test_expired(self):
        assert coupons.effective_status(self._coupon(ends_at=NOW - timedelta(seconds=1)), NOW) == "expired"

    def test_no_end_never_expires(self):
        assert coupons.effective_status(self._coupon(ends_at=None), NOW) == "active"

    def test_exhausted_at_exactly_the_limit(self):
        assert coupons.effective_status(self._coupon(usage_count=10), NOW) == "exhausted"
        assert coupons.effective_status(self._coupon(usage_count=9), NOW) == "active"

    def test_no_usage_limit(self):
        assert coupons.effective_status(self._coupon(usage_limit=None, usage_count=10**6), NOW) == "active"

    def test_parse(self):
        assert coupons._parse("2026-06-15") == datetime(2026, 6, 15)
        with pytest.raises(ValidationError) as caught:
            coupons._parse("soon")
        assert caught.value.error_code == "INVALID_DATE"


# ---------------------------------------------------------------- invoices


class TestInvoiceRules:
    def _invoice(self, **overrides):
        values = dict(grand_total=10_000, amount_paid=0, amount_refunded=0, status="issued",
                      due_at=NOW - timedelta(days=1), gift_card_amount=0, store_credit_amount=0, points_amount=0)
        values.update(overrides)
        return SimpleNamespace(**values)

    def test_amount_due(self):
        assert invoices.amount_due(self._invoice()) == 10_000
        assert invoices.amount_due(self._invoice(amount_paid=4_000)) == 6_000
        assert invoices.amount_due(self._invoice(amount_paid=10_000, amount_refunded=500)) == 0

    def test_overdue(self):
        assert invoices.is_overdue(self._invoice(), NOW)
        assert not invoices.is_overdue(self._invoice(due_at=NOW + timedelta(days=1)), NOW)

    @pytest.mark.parametrize("overrides", [{"status": "paid"}, {"status": "cancelled"}, {"amount_paid": 10_000}])
    def test_never_overdue_when_settled(self, overrides):
        assert not invoices.is_overdue(self._invoice(**overrides), NOW)

    @pytest.mark.parametrize("status, amount, refunded, refundable", [
        ("paid", 10_000, 0, 10_000), ("partially-refunded", 10_000, 4_000, 6_000), ("refunded", 10_000, 10_000, 0),
        ("failed", 10_000, 0, 0), ("pending", 10_000, 0, 0),
    ])
    def test_refundable(self, status, amount, refunded, refundable):
        payment = SimpleNamespace(status=status, amount=amount, refunded_amount=refunded)
        assert invoices.refundable_amount(payment) == refundable

    def test_tender_total(self):
        assert tenders.tender_total(None) == 0
        assert tenders.tender_total(self._invoice(gift_card_amount=100, store_credit_amount=200,
                                                  points_amount=None)) == 300


# --------------------------------------------------------------- gift cards


class TestGiftCardCodes:
    def test_new_codes_are_prefixed_grouped_and_unambiguous(self):
        code = gift_cards._new_code()
        prefix, *groups = code.split("-")
        assert prefix == "DCZG" and len(groups) == 4 and all(len(g) == 4 for g in groups)
        assert not set("".join(groups)) & set("01IOL")
        assert gift_cards._new_code() != code

    @pytest.mark.parametrize("typed", ["DCZG-ABCD-EFGH-JKMN-PQRS", "dczg abcd efgh jkmn pqrs", "ABCDEFGHJKMNPQRS",
                                       "abcd-efgh-jkmn-pqrs"])
    def test_however_it_is_typed_it_hashes_the_same(self, typed):
        assert gift_cards.normalise(typed) == "ABCDEFGHJKMNPQRS"
        assert gift_cards.hash_code(typed) == gift_cards.hash_code("ABCDEFGHJKMNPQRS")

    def test_hash_is_not_the_code(self):
        assert "ABCD" not in gift_cards.hash_code("ABCDEFGHJKMNPQRS")
        assert gift_cards.hash_code("ABCDEFGHJKMNPQRS") != gift_cards.hash_code("ABCDEFGHJKMNPQRT")

    def test_a_short_code_starting_with_the_prefix_keeps_it(self):
        assert gift_cards.normalise("DCZG1234") == "DCZG1234"
        assert gift_cards.normalise(None) == ""


def _card(**overrides):
    values = dict(status="active", expires_at=NOW + timedelta(days=30), balance=50_000, initial_amount=50_000)
    values.update(overrides)
    return SimpleNamespace(**values)


class TestGiftCardStatus:
    def test_display(self):
        assert gift_cards.display_status(_card(), NOW) == "active"
        assert gift_cards.display_status(_card(balance=100), NOW) == "partially-used"
        assert gift_cards.display_status(_card(expires_at=NOW), NOW) == "expired"
        assert gift_cards.display_status(_card(status="disabled", balance=0), NOW) == "disabled"
        assert gift_cards.display_status(_card(expires_at=None), NOW) == "active"

    def test_usable(self):
        assert gift_cards.usable_reason(_card(), NOW) == ""

    @pytest.mark.parametrize("card, fragment", [
        (None, "isn't valid"),
        (_card(status="pending"), "hasn't been paid"),
        (_card(status="disabled"), "cancelled"),
        (_card(status="cancelled"), "cancelled"),
        (_card(status="refunded"), "cancelled"),
        (_card(status="expired"), "expired"),
        (_card(expires_at=NOW - timedelta(seconds=1)), "expired"),
        (_card(status="used"), "no balance"),
        (_card(balance=0), "no balance"),
    ])
    def test_not_usable(self, card, fragment):
        assert fragment in gift_cards.usable_reason(card, NOW)


# ----------------------------------------------------------- reward points


class TestPoints:
    CONF = {"redeemPoints": 100, "redeemValue": 50}  # 100 points = Rs 50

    @pytest.mark.parametrize("points, paise", [(0, 0), (100, 5_000), (1, 50), (3, 150), (-50, 0)])
    def test_value_of(self, points, paise):
        assert loyalty.value_of(self.CONF, points) == paise

    @pytest.mark.parametrize("paise, points", [(5_000, 100), (5_049, 100), (5_050, 101), (0, 0), (-1, 0)])
    def test_points_for_never_exceeds_the_amount(self, paise, points):
        assert loyalty.points_for(self.CONF, paise) == points
        assert loyalty.value_of(self.CONF, points) <= max(0, paise)

    def test_value_rounds_down(self):
        assert loyalty.value_of({"redeemPoints": 3, "redeemValue": 1}, 1) == 33

    def test_number_settings(self):
        assert loyalty._num("5", "x", low=0, high=10) == 5
        assert loyalty._num(2.555, "x", low=0, high=10, whole=False) == 2.56

    @pytest.mark.parametrize("value, low, high, whole", [
        (True, 0, 10, True), ("lots", 0, 10, True), (None, 0, 10, True), (2.5, 0, 10, True),
        (11, 0, 10, True), (0, 1, 10, True),
    ])
    def test_number_settings_refused(self, value, low, high, whole):
        with pytest.raises(ValidationError) as caught:
            loyalty._num(value, "Setting", low=low, high=high, whole=whole)
        assert caught.value.error_code == "INVALID_SETTING"


# ------------------------------------------------------------- membership


class TestAddMonths:
    @pytest.mark.parametrize("start, months, end", [
        (datetime(2026, 1, 15), 1, datetime(2026, 2, 15)),
        (datetime(2026, 1, 31), 1, datetime(2026, 2, 28)),
        (datetime(2028, 1, 31), 1, datetime(2028, 2, 29)),
        (datetime(2026, 11, 30), 3, datetime(2027, 2, 28)),
        (datetime(2026, 12, 1), 12, datetime(2027, 12, 1)),
        (datetime(2026, 5, 31, 10, 30), 0, datetime(2026, 5, 31, 10, 30)),
    ])
    def test_calendar_months(self, start, months, end):
        assert membership.add_months(start, months) == end

    def test_benefits(self):
        plan = SimpleNamespace(free_delivery=1, free_deliveries_per_month=None, member_discount_percent=None,
                               extra_return_days=None, early_access=0, priority_support=True)
        assert membership.benefits_of(plan) == {"freeDelivery": True, "freeDeliveriesPerMonth": None,
                                                "memberDiscountPercent": 0.0, "extraReturnDays": 0,
                                                "earlyAccess": False, "prioritySupport": True}


# ------------------------------------------------------------ flash sales


class TestFlashSalePhase:
    def _sale(self, status="scheduled"):
        return SimpleNamespace(status=status, starts_at=NOW, ends_at=NOW + timedelta(hours=2))

    @pytest.mark.parametrize("status", ["draft", "cancelled"])
    def test_draft_and_cancelled_are_what_they_say(self, status):
        assert flash_sales.phase(self._sale(status), NOW + timedelta(hours=1)) == status

    def test_timeline(self):
        sale = self._sale()
        assert flash_sales.phase(sale, NOW - timedelta(seconds=1)) == "scheduled"
        assert flash_sales.phase(sale, NOW) == "live"
        assert flash_sales.phase(sale, NOW + timedelta(hours=2) - timedelta(seconds=1)) == "live"
        assert flash_sales.phase(sale, NOW + timedelta(hours=2)) == "ended"

    def test_parse_when(self):
        assert flash_sales._parse_when("2026-06-15T10:00:00.123", "starts") == datetime(2026, 6, 15, 10)
        for bad in (None, "", "soon", 12345):
            with pytest.raises(ValidationError):
                flash_sales._parse_when(bad, "starts")

    def test_int_or_none(self):
        assert flash_sales._int_or_none(None, "x") is None
        assert flash_sales._int_or_none("", "x") is None
        assert flash_sales._int_or_none("5", "x") == 5
        for bad in ("five", 0, 100001):
            with pytest.raises(ValidationError):
                flash_sales._int_or_none(bad, "Limit")


# --------------------------------------------------------- payment window


def _held(expires_at, stock_state="reserved"):
    return SimpleNamespace(stock_state=stock_state, payment_expires_at=expires_at)


class TestPaymentWindow:
    def test_window_closes_at_the_deadline(self):
        assert not settlement.window_closed(_held(NOW), NOW - timedelta(seconds=1))
        assert settlement.window_closed(_held(NOW), NOW)

    def test_hold_lapses_only_after_the_grace(self, monkeypatch):
        monkeypatch.setattr(settings, "PAYMENT_GRACE_SECONDS", 90)
        assert not settlement.hold_lapsed(_held(NOW), NOW + timedelta(seconds=89))
        assert settlement.hold_lapsed(_held(NOW), NOW + timedelta(seconds=90))

    @pytest.mark.parametrize("order", [None, _held(None), _held(NOW - timedelta(days=1), "committed")])
    def test_orders_without_a_hold_have_no_window(self, order):
        assert not settlement.window_closed(order, NOW)
        assert not settlement.hold_lapsed(order, NOW)

    def test_require_open_window(self):
        settlement.require_open_window(_held(datetime.utcnow() + timedelta(minutes=5)))
        with pytest.raises(ConflictError) as caught:
            settlement.require_open_window(_held(datetime.utcnow() - timedelta(seconds=1)))
        assert caught.value.error_code == "PAYMENT_WINDOW_CLOSED"


class TestInstrumentHint:
    @pytest.mark.parametrize("payment, hint", [
        ({"method": "card", "card": {"last4": "4242", "network": "Visa"}}, "Visa •••• 4242"),
        ({"method": "card", "card": {"network": "RuPay"}}, "RuPay"),
        ({"method": "card"}, ""),
        ({"method": "upi", "vpa": "asha.rao@okhdfc"}, "•••••@okhdfc"),
        ({"method": "upi"}, "UPI"),
        ({"method": "netbanking", "bank": "HDFC"}, "HDFC"),
        ({"method": "netbanking"}, "Net banking"),
        ({"method": "wallet", "wallet": "paytm"}, "Paytm Wallet"),
        ({"method": "wallet"}, "Wallet"),
        ({"method": "emi"}, "EMI"),
        ({"method": "pay_later"}, "Pay Later"),
        ({}, ""),
    ])
    def test_masked_remnant_only(self, payment, hint):
        assert instrument_hint(payment) == hint

    def test_the_person_in_a_vpa_is_never_kept(self):
        assert "asha" not in instrument_hint({"method": "upi", "vpa": "asha.rao@okhdfc"})


# ---------------------------------------------------------------- returns


class TestReturnWindow:
    def _order(self, *events):
        return SimpleNamespace(events=[SimpleNamespace(status=s, occurred_at=t) for s, t in events])

    def test_latest_delivery_counts(self):
        order = self._order(("shipped", NOW), ("delivered", NOW + timedelta(days=1)),
                            ("delivered", NOW + timedelta(days=2)))
        assert returns.delivered_at(order) == NOW + timedelta(days=2)
        assert returns.window_ends(order, 15) == NOW + timedelta(days=17)

    def test_undelivered_has_no_window(self):
        order = self._order(("shipped", NOW))
        assert returns.delivered_at(order) is None and returns.window_ends(order, 15) is None

    @pytest.mark.parametrize("kind, status, steps", [
        ("return", "requested", ("approved", "rejected", "cancelled")),
        ("return", "received", ("refunded",)),
        ("return", "refunded", ()),
        ("replacement", "received", ("replacement-shipped",)),
        ("replacement", "replacement-shipped", ("completed",)),
        ("exchange", "requested", ()),
    ])
    def test_next_steps(self, kind, status, steps):
        assert returns.next_steps(SimpleNamespace(kind=kind, status=status)) == steps

    def test_every_flow_ends_somewhere_finished(self):
        for kind, flow in returns.FLOW.items():
            reachable = {target for targets in flow.values() for target in targets}
            assert reachable - set(flow) <= returns.FINISHED, kind


class TestSupportStatuses:
    def test_labels_by_audience(self):
        assert tickets.status_label("waiting-customer") == "Waiting for customer"
        assert tickets.status_label("waiting-customer", "customer") == "Waiting for your reply"
        assert tickets.status_label("triaged", "customer") == "Received"
        assert tickets.status_label("mystery") == "mystery"

    def test_transitions_name_only_real_statuses(self):
        for status, targets in tickets.TRANSITIONS.items():
            assert status in tickets.STATUSES
            assert set(targets) <= set(tickets.STATUSES)
            assert status not in targets
        assert tickets.transitions_for(SimpleNamespace(status="submitted")) == list(tickets.TRANSITIONS["submitted"])
        assert tickets.transitions_for(SimpleNamespace(status="unknown")) == []


# -------------------------------------------------------------- questions


class TestCleanText:
    def test_markup_is_removed(self):
        assert questions.clean_text("<b>Is it</b> <script>x</script>cotton?") == "Is it xcotton?"

    def test_entities_are_decoded_then_tags_removed(self):
        assert questions.clean_text("&lt;img src=x onerror=alert(1)&gt;Size?") == "Size?"

    def test_direction_overrides_and_zero_width_characters_are_removed(self):
        assert questions.clean_text("ab‮cd​ef\x00") == "abcdef"

    def test_whitespace_is_tidied(self):
        assert questions.clean_text("  a \t b  \r\n\r\n\r\n\r\n  c  ") == "a b\n\nc"

    def test_empty(self):
        assert questions.clean_text(None) == ""


# -------------------------------------------------------------- campaigns


class TestCampaignAudience:
    def test_defaults(self):
        audience = campaigns.clean_audience(None)
        assert audience["segment"] == "all" and audience["productIds"] == [] and audience["abandonedCart"] is False

    def test_full(self):
        audience = campaigns.clean_audience({"segment": "repeat", "minSpent": "1000.5", "maxSpent": 5000,
                                             "minOrders": "2", "orderedFrom": "2026-01-01T00:00",
                                             "productIds": [f"PRD{i}" for i in range(80)]})
        assert audience["minSpent"] == 1000.5 and audience["minOrders"] == 2
        assert audience["orderedFrom"] == "2026-01-01"
        assert len(audience["productIds"]) == 50

    @pytest.mark.parametrize("raw", [
        {"segment": "vip"}, {"minSpent": "lots"}, {"minOrders": -1}, {"minSpent": 10, "maxSpent": 5},
        {"minOrders": 5, "maxOrders": 2}, {"orderedFrom": "2026-13-01"},
    ])
    def test_refused(self, raw):
        with pytest.raises(ValidationError) as caught:
            campaigns.clean_audience(raw)
        assert caught.value.error_code == "INVALID_AUDIENCE"

    def test_dates_are_ist_midnight(self):
        assert campaigns._date("2026-06-15", "x") == datetime(2026, 6, 14, 18, 30)
        assert campaigns._date("", "x") is None


class TestCampaignContent:
    def test_email_html_is_sanitised_and_urls_checked(self):
        content = campaigns.clean_content({"email": {"subject": "Hi {{customer_name}}",
                                                     "html": "<p>Sale</p><script>x()</script>",
                                                     "ctaUrl": "/sale"}}, ["email"], strict=True)
        assert "<script>" not in content["email"]["html"] and content["email"]["ctaUrl"] == "/sale"

    def test_unknown_variable_is_named(self):
        with pytest.raises(ValidationError) as caught:
            campaigns.clean_content({"sms": {"text": "Hi {{password}}"}}, ["sms"], strict=False)
        assert caught.value.error_code == "INVALID_TEMPLATE_VARIABLE"
        assert caught.value.details == {"unknown": ["password"]}

    def test_bad_link(self):
        with pytest.raises(ValidationError) as caught:
            campaigns.clean_content({"in_app": {"url": "javascript:alert(1)"}}, [], strict=False)
        assert caught.value.error_code == "INVALID_CONTENT"

    def test_whatsapp_variables_must_be_known(self):
        with pytest.raises(ValidationError):
            campaigns.clean_content({"whatsapp": {"template": "t", "variables": ["secret"]}}, [], strict=False)

    def test_sms_length(self):
        with pytest.raises(ValidationError):
            campaigns.clean_content({"sms": {"text": "x" * 481}}, ["sms"], strict=False)

    @pytest.mark.parametrize("channel", ["email", "sms", "whatsapp", "in_app"])
    def test_strict_requires_content_for_each_chosen_channel(self, channel):
        assert campaigns.clean_content({}, [channel], strict=False)
        with pytest.raises(ValidationError) as caught:
            campaigns.clean_content({}, [channel], strict=True)
        assert caught.value.error_code == "CONTENT_REQUIRED"


class TestTrackedLinks:
    def test_round_trip(self, monkeypatch):
        monkeypatch.setattr(settings, "STOREFRONT_URL", "https://shop.test/")
        url = campaigns.click_url("tok123", "/sale")
        parts = urlsplit(url)
        assert parts.netloc == "shop.test" and parts.path == "/r/tok123"
        query = parse_qs(parts.query)
        assert query["to"] == ["https://shop.test/sale"]
        assert campaigns.safe_target("tok123", query["to"][0], query["s"][0]) == "https://shop.test/sale"

    def test_relative_without_slash_and_absolute_targets(self, monkeypatch):
        monkeypatch.setattr(settings, "STOREFRONT_URL", "https://shop.test")
        assert "to=https%3A%2F%2Fshop.test%2Fnew" in campaigns.click_url("t", "new")
        assert "to=https%3A%2F%2Fother.test%2Fx" in campaigns.click_url("t", "https://other.test/x")

    def test_an_altered_destination_is_refused(self):
        url = campaigns.click_url("tok", "/sale")
        signature = parse_qs(urlsplit(url).query)["s"][0]
        assert campaigns.safe_target("tok", "https://evil.test", signature) is None
        assert campaigns.safe_target("other", parse_qs(urlsplit(url).query)["to"][0], signature) is None
        assert campaigns.safe_target("tok", "", signature) is None
        assert campaigns.safe_target("tok", "/sale", None) is None


# --------------------------------------------------------------- webhooks


class TestWebhookCleaning:
    def test_personal_details_are_removed(self):
        body = {
            "entity": "event", "event": "payment.captured", "contains": ["payment"], "created_at": 1,
            "payload": {"payment": {"entity": {
                "id": "pay_1", "amount": 1000, "status": "captured", "order_id": "order_1",
                "email": "asha@example.com", "contact": "+919876543210",
                "card": {"network": "Visa", "last4": "4242", "name": "Asha"},
                "vpa": "asha@okhdfc",
                "notes": {"orderId": "ORD001", "address": "4 Brigade Road"},
                "acquirer_data": {"rrn": "123"},
            }}, "account": {"entity": {"id": "acc"}}},
        }
        cleaned = webhooks.clean(body)
        entity = cleaned["payload"]["payment"]["entity"]
        assert entity["id"] == "pay_1" and entity["amount"] == 1000
        assert "email" not in entity and "contact" not in entity and "acquirer_data" not in entity
        assert entity["card"] == {"network": "Visa"}
        assert entity["vpa"] == "•••••@okhdfc"
        assert entity["notes"] == {"orderId": "ORD001"}
        assert "account" not in cleaned["payload"]
        assert "asha" not in str(cleaned).lower()

    def test_malformed_bodies(self):
        assert webhooks.clean({})["payload"] == {}
        assert webhooks.clean({"payload": "nope"})["payload"] == {}
        assert webhooks.clean({"payload": {"payment": {"entity": "x"}}})["payload"] == {}
        assert webhooks._clean_entity(None) == {}
        assert webhooks.clean({"event": "x" * 100})["event"] == "x" * 60

    def test_event_id(self):
        assert webhooks.event_id_for(" evt_1 ", b"{}") == "evt_1"
        derived = webhooks.event_id_for("", b'{"a":1}')
        assert derived.startswith("body-") and derived == webhooks.event_id_for(None, b'{"a":1}')
        assert derived != webhooks.event_id_for("", b'{"a":2}')


# ------------------------------------------------------------------ bounces


DSN = b"""From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>
To: shop@dcz.test
Subject: Delivery Status Notification (Failure)
MIME-Version: 1.0
Content-Type: multipart/report; report-type=delivery-status; boundary="B"

--B
Content-Type: text/plain; charset=utf-8

** Address not found **

Your message wasn't delivered to nobody@gone.test because the address couldn't be found.

--B
Content-Type: message/delivery-status

Reporting-MTA: dns; googlemail.com
X-Original-Message-ID: <abc@dcz.test>

Final-Recipient: rfc822; Nobody@Gone.test
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 No such user

--B--
"""


class TestBounceParsing:
    def test_gmail_style_notice(self):
        (bounce,) = bounces.parse(DSN, NOW)
        assert bounce.recipient == "nobody@gone.test"
        assert bounce.reason.startswith("Address not found: Your message wasn't delivered")
        assert bounce.reason.endswith("(status 5.1.1)")
        assert bounce.original_message_id == "<abc@dcz.test>"

    def test_without_a_summary_the_diagnostic_is_used(self):
        raw = DSN.replace(b"** Address not found **", b"").replace(b"Your message wasn't delivered", b"Hello")
        (bounce,) = bounces.parse(raw, NOW)
        assert bounce.reason == "550 5.1.1 No such user (status 5.1.1)"

    def test_delayed_is_not_a_failure(self):
        assert bounces.parse(DSN.replace(b"Action: failed", b"Action: delayed"), NOW) == []

    def test_message_id_from_the_returned_headers(self):
        raw = DSN.replace(b"X-Original-Message-ID: <abc@dcz.test>\n", b"").replace(
            b"--B--", b"--B\nContent-Type: text/rfc822-headers\n\nMessage-ID: <orig@dcz.test>\n\n--B--")
        assert bounces.parse(raw, NOW)[0].original_message_id == "<orig@dcz.test>"

    def test_an_ordinary_email_has_no_bounces(self):
        assert bounces.parse(b"From: a@b.test\nSubject: hi\n\nhello", NOW) == []
