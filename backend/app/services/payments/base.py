"""The payment gateway boundary.

No route, service or schema outside this package may name a provider. Which
company processes a payment is a deployment decision, and the day Razorpay is
swapped for Stripe should touch one file.

The four operations every gateway converges on, however differently they spell
them:

    create   — open an order/intent, return what the client must present
    verify   — confirm an outcome, having been told about it
    fetch    — read current state, for reconciliation
    refund   — return money against a captured payment

**Where the real work belongs.** `verify` exists here so the call site reads
correctly, but a client saying "this succeeded" is a claim, not a fact. The
signature check and the webhook that confirms it must run on the server, with
the secret key, and an order may only be marked paid on the strength of that.
Never on the strength of a redirect the browser was sent to.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Optional, Protocol


@dataclass
class PaymentRequest:
    order_id: str
    invoice_id: str
    customer_id: str
    customer_name: str
    customer_email: str
    amount: int  # minor units
    currency: str
    method: str
    notes: Dict[str, str] = field(default_factory=dict)


@dataclass
class PaymentResult:
    ok: bool
    transaction_id: str
    # pending | authorized | paid | failed
    status: str
    # A non-identifying remnant only — "•••• 4242", "•••••@okhdfc". Never a PAN,
    # never an expiry, never a CVV. This is the only payment detail that is
    # allowed to be stored anywhere in this system.
    instrument_hint: str = ""
    provider_reference: Optional[str] = None
    failure_reason: Optional[str] = None


@dataclass
class RefundResult:
    ok: bool
    reference: str
    # processing | completed | rejected
    status: str
    failure_reason: Optional[str] = None


class PaymentProvider(Protocol):
    """What every provider implementation must offer."""

    name: str

    def create(self, request: PaymentRequest) -> PaymentResult: ...

    def verify(self, transaction_id: str, payload: Dict[str, str]) -> PaymentResult: ...

    def fetch(self, transaction_id: str) -> Optional[PaymentResult]: ...

    def refund(self, transaction_id: str, amount: int, reason: str) -> RefundResult: ...
