"""
The development payment provider and the provider registry.

Razorpay itself is covered in `tests/integration/test_payments_razorpay.py`
against a stubbed transport. These are the things that sit around it: that the
mock behaves like a gateway without being one, that it refuses production, and
that an unknown provider name fails loudly instead of falling back.
"""

from __future__ import annotations

import pytest

from app.core.config import settings
from app.services import payments
from app.services.payments.base import PaymentRequest
from app.services.payments.mock import MockPaymentProvider


def _request(method: str = "upi", order_id: str = "ORD001", amount: int = 10_000) -> PaymentRequest:
    return PaymentRequest(order_id=order_id, invoice_id="INV001", customer_id="CUS001", customer_name="Asha",
                          customer_email="a@b.co", amount=amount, currency="INR", method=method)


class TestMockProvider:
    def test_prepaid_methods_settle_immediately(self):
        result = MockPaymentProvider().create(_request("card"))
        assert result.ok and result.status == "paid"
        assert result.transaction_id.startswith("TXN")

    def test_cash_on_delivery_stays_pending(self):
        """Reporting COD as paid would overstate revenue by every COD order."""
        result = MockPaymentProvider().create(_request("cod"))
        assert result.ok and result.status == "pending"
        assert result.instrument_hint == "Collect on delivery"

    def test_the_reference_is_deterministic_for_an_order(self):
        provider = MockPaymentProvider()
        assert provider.create(_request()).transaction_id == provider.create(_request()).transaction_id
        assert provider.create(_request(order_id="ORD001")).transaction_id != \
            provider.create(_request(order_id="ORD002")).transaction_id

    @pytest.mark.parametrize("method, check", [
        ("card", lambda h: h[-4:].isdigit()),
        ("debit-card", lambda h: h[-4:].isdigit()),
        ("upi", lambda h: "@" in h),
        ("netbanking", lambda h: "Bank" in h or "India" in h),
        ("wallet", lambda h: "Wallet" in h or "Pay" in h),
        ("crypto", lambda h: h == ""),
    ])
    def test_instrument_hint_is_a_masked_remnant(self, method, check):
        hint = MockPaymentProvider().create(_request(method)).instrument_hint
        assert check(hint), hint
        # Never anything that looks like a full card number.
        assert sum(c.isdigit() for c in hint) <= 4

    def test_verify_fetch_and_refund(self):
        provider = MockPaymentProvider()
        assert provider.verify("TXN1", {}).status == "paid"
        assert provider.fetch("TXN1").status == "paid"
        refund = provider.refund("TXN20260101", 500, "damaged")
        assert refund.ok and refund.status == "completed" and refund.reference == "RFND20260101"

    def test_refuses_to_exist_in_production(self, monkeypatch):
        monkeypatch.setattr(settings, "ENVIRONMENT", "production")
        with pytest.raises(RuntimeError, match="cannot run in production"):
            MockPaymentProvider()


class TestRegistry:
    def test_mock_is_selected(self):
        payments.get_provider.cache_clear()
        assert payments.get_provider().name == "mock"

    def test_an_unknown_provider_is_refused_rather_than_defaulted(self, monkeypatch):
        monkeypatch.setattr(settings, "PAYMENT_PROVIDER", "stripe")
        payments.get_provider.cache_clear()
        with pytest.raises(RuntimeError, match="not implemented"):
            payments.get_provider()
        payments.get_provider.cache_clear()
