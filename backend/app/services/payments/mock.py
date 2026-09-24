"""A provider that moves no money.

It exists so checkout has something to call and the transaction records look
like the real thing — a reference, a method, a timeline. Nothing here contacts
a network and nothing here is a transaction.

**What it deliberately does not do:** accept or return a card number, expiry,
CVV, UPI PIN or bank credential. `instrument_hint` is a fabricated remnant of
the kind a real gateway hands back *after* processing. When this is replaced by
a real provider that stays true — card entry belongs in the gateway's own
hosted fields, which never touch this application.
"""

from __future__ import annotations

import hashlib
from datetime import datetime
from typing import Dict, Optional

from app.services.payments.base import (
    PaymentProvider,
    PaymentRequest,
    PaymentResult,
    RefundResult,
)

_SUFFIXES = ["4242", "1881", "9006", "3310", "7712"]
_UPI = ["okhdfc", "okaxis", "ybl", "paytm"]
_BANKS = ["HDFC Bank", "ICICI Bank", "State Bank of India", "Axis Bank"]
_WALLETS = ["Paytm Wallet", "PhonePe Wallet", "Amazon Pay"]


def _seed(value: str) -> int:
    """Deterministic, so a retry produces the same reference rather than a new one."""
    return int(hashlib.sha256(value.encode("utf-8")).hexdigest()[:8], 16)


class MockPaymentProvider:
    """The development provider."""

    name = "mock"

    def create(self, request: PaymentRequest) -> PaymentResult:
        seed = _seed(request.order_id)
        transaction_id = f"TXN{datetime.utcnow():%Y%m%d}{seed % 100000:05d}"
        hint = self._hint(request.method, seed)

        # Cash on delivery is genuinely unsettled until the courier collects —
        # reporting it as paid would overstate revenue by every COD order.
        if request.method == "cod":
            return PaymentResult(
                ok=True, transaction_id=transaction_id, status="pending", instrument_hint=hint
            )

        return PaymentResult(
            ok=True, transaction_id=transaction_id, status="paid", instrument_hint=hint
        )

    def verify(self, transaction_id: str, payload: Dict[str, str]) -> PaymentResult:
        # A real implementation checks an HMAC over the provider's fields using
        # the secret key. There is nothing to verify against here.
        return PaymentResult(ok=True, transaction_id=transaction_id, status="paid")

    def fetch(self, transaction_id: str) -> Optional[PaymentResult]:
        return PaymentResult(ok=True, transaction_id=transaction_id, status="paid")

    def refund(self, transaction_id: str, amount: int, reason: str) -> RefundResult:
        return RefundResult(
            ok=True, reference=f"RFND{transaction_id[3:]}", status="completed"
        )

    @staticmethod
    def _hint(method: str, seed: int) -> str:
        if method in ("card", "debit-card"):
            return f"•••• {_SUFFIXES[seed % len(_SUFFIXES)]}"
        if method == "upi":
            return f"•••••@{_UPI[seed % len(_UPI)]}"
        if method == "netbanking":
            return _BANKS[seed % len(_BANKS)]
        if method == "wallet":
            return _WALLETS[seed % len(_WALLETS)]
        if method == "cod":
            return "Collect on delivery"
        return ""
