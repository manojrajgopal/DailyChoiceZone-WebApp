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
    # What the gateway says was paid, in minor units, when it says anything.
    #
    # Checked against the amount owed before a payment is settled. A signature
    # that verifies proves the payment belongs to the order; it says nothing
    # about how much of it was paid, and a gateway order can be paid partially
    # or, if it was opened with the wrong figure, for the wrong amount entirely.
    # `None` means the provider did not report one, and the check is skipped.
    amount: Optional[int] = None
    # The currency the gateway says it was paid in. Checked alongside the
    # amount: 40900 of the wrong currency is not ₹409.
    currency: Optional[str] = None


@dataclass
class RefundResult:
    ok: bool
    reference: str
    # processing | completed | rejected | unknown
    #
    # `unknown` is the answer that matters for money: the request may or may
    # not have reached the gateway (a timeout, a 5xx, an unreadable answer).
    # It must never be read as "refused" — retrying it blindly is how a
    # customer is refunded twice. See `invoices._send_refund`.
    status: str
    failure_reason: Optional[str] = None
    amount: Optional[int] = None


class PaymentProvider(Protocol):
    """What every provider implementation must offer."""

    name: str

    def create(self, request: PaymentRequest) -> PaymentResult: ...

    def verify(self, transaction_id: str, payload: Dict[str, str]) -> PaymentResult: ...

    def fetch(self, transaction_id: str) -> Optional[PaymentResult]: ...

    def refund(self, transaction_id: str, amount: int, reason: str, *, receipt: Optional[str] = None,
               notes: Optional[Dict[str, str]] = None) -> RefundResult: ...

    # Optional, for providers whose refunds are asynchronous (see razorpay.py):
    #   find_refund(transaction_id, receipt) -> Optional[RefundResult]
    #       our refund, looked up by our own reference — before any retry
    #   fetch_refund(transaction_id, reference) -> Optional[RefundResult]
    #       its current state, for the refunds job
