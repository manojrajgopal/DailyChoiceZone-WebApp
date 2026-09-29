"""
Razorpay.

Implements the four operations in `base.py` against Razorpay's REST API. The
API is reached with `httpx` and HTTP basic auth — key id as the username, key
secret as the password — rather than through the `razorpay` SDK, which is a thin
wrapper over these same calls and one more dependency to keep current.

## What is trusted, and what is not

Razorpay Checkout runs in the shopper's browser and hands back three values:
`razorpay_payment_id`, `razorpay_order_id` and `razorpay_signature`. Those come
from a browser, so they are a *claim*. Two things turn the claim into a fact,
and this file does both:

1. **The signature.** `HMAC-SHA256("{order_id}|{payment_id}", key_secret)` must
   equal `razorpay_signature`. Only Razorpay and this server know the secret,
   so a browser cannot forge it.
2. **A read back from the gateway.** Having verified the signature, `verify`
   fetches the payment from Razorpay and takes the *gateway's* word for the
   status, the amount and the currency. A valid signature says "this payment
   belongs to this order"; it does not say the payment succeeded, and it
   certainly does not say for how much.

The amount is checked against what the invoice says is owed, because a payment
that verifies for the wrong amount is not a paid order. Nothing the client says
about money is read at all — it sends three opaque references and nothing else.

## What is never stored

No card number, expiry, CVV, UPI PIN or bank credential reaches this process:
Checkout collects them inside Razorpay's own iframe. What comes back is the
masked remnant that `instrument_hint` is for — "•••• 1111", "•••••@okhdfc".
"""

from __future__ import annotations

import hashlib
import hmac
import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import httpx

from app.core.config import settings
from app.services.payments.base import (
    PaymentRequest,
    PaymentResult,
    RefundResult,
)

logger = logging.getLogger(__name__)

API_ROOT = "https://api.razorpay.com/v1"

# Razorpay's own statuses, mapped onto ours.
#
# `authorized` is money held but not captured, which is a real state this
# system already models; it must not be flattened into `paid`, because an
# authorisation can expire without ever becoming a payment.
_STATUS = {
    "created": "pending",
    "authorized": "authorized",
    "captured": "paid",
    "refunded": "paid",  # still a completed payment; the refund is its own record
    "failed": "failed",
}

_REFUND_STATUS = {
    "pending": "processing",
    "processed": "completed",
    "failed": "rejected",
}

# Cash on delivery is not a gateway payment. It is an arrangement with a
# courier, and sending it to Razorpay would create an order nobody ever pays.
COD_METHODS = {"cod"}


class RazorpayError(RuntimeError):
    """The gateway refused, or could not be reached."""


class RazorpayPaymentProvider:
    """The live provider. Test keys and live keys take the same code path."""

    name = "razorpay"

    def __init__(self) -> None:
        if not settings.razorpay_configured:
            raise RuntimeError(
                "PAYMENT_PROVIDER is 'razorpay' but RAZOR_KEY_ID and RAZOR_KEY_SECRET "
                "are not both set. Refusing to start rather than silently taking no money."
            )

        self._key_id = settings.RAZOR_KEY_ID
        self._key_secret = settings.RAZOR_KEY_SECRET

    # ------------------------------------------------------------- plumbing

    def _request(self, method: str, path: str, **kwargs: Any) -> Dict[str, Any]:
        """
        One call to the gateway.

        Errors are raised as `RazorpayError` carrying *Razorpay's* description,
        which is the only party that knows why a payment was refused. The
        request body is never logged: it carries amounts and references, and on
        the refund path a reason that may name a customer.
        """
        url = f"{API_ROOT}{path}"
        try:
            with httpx.Client(timeout=30.0) as client:
                response = client.request(
                    method, url, auth=(self._key_id, self._key_secret), **kwargs
                )
        except httpx.HTTPError as error:
            logger.error("Razorpay %s %s could not be reached: %s", method, path, error)
            raise RazorpayError("The payment provider could not be reached.") from error

        if response.status_code >= 400:
            detail = ""
            try:
                detail = (response.json().get("error") or {}).get("description", "")
            except ValueError:
                pass

            logger.error(
                "Razorpay %s %s returned %s: %s", method, path, response.status_code, detail
            )
            raise RazorpayError(detail or "The payment provider refused the request.")

        return response.json()

    # --------------------------------------------------------------- create

    def create(self, request: PaymentRequest) -> PaymentResult:
        """
        Open a Razorpay order.

        Returns *pending*, always. A payment does not exist yet — this is the
        object Checkout is opened against, and the money arrives afterwards.
        The order is marked paid by `verify` or by the webhook, never here.

        `transaction_id` carries the Razorpay order id for now. It becomes the
        payment id (`pay_…`) once there is one, which is the reference a refund
        needs; `provider_reference` keeps the order id permanently, because the
        signature is computed over it.
        """
        if request.method in COD_METHODS:
            # Nothing to open. Recorded like any unsettled payment so the
            # courier's collection has something to settle against.
            return PaymentResult(
                ok=True,
                transaction_id=f"COD-{request.order_id}",
                status="pending",
                instrument_hint="Collect on delivery",
            )

        payload = {
            "amount": request.amount,
            "currency": request.currency,
            # Razorpay shows this on its dashboard and in its own emails, so it
            # is the number a customer would quote, not our internal id.
            "receipt": request.notes.get("orderNumber", request.order_id),
            # Capture as soon as the payment is authorised. The alternative is
            # holding an authorisation and capturing later, which this system
            # has no workflow for — an uncaptured authorisation simply expires.
            "payment_capture": 1,
            "notes": {
                "orderId": request.order_id,
                "invoiceId": request.invoice_id,
                "customerId": request.customer_id,
                **request.notes,
            },
        }

        order = self._request("POST", "/orders", json=payload)
        reference = order["id"]

        return PaymentResult(
            ok=True,
            transaction_id=reference,
            status="pending",
            provider_reference=reference,
        )

    # -------------------------------------------------------------- methods

    def methods(self) -> Dict[str, Any]:
        """
        What this account can actually take.

        Razorpay serves this keyed by the publishable key id, so it needs no
        secret — but it goes through the server anyway, because the storefront
        must not be in the business of calling the gateway directly.

        The point of asking at all: a method switched on in our own settings
        but switched off in the Razorpay account fails at the payment screen,
        after the shopper has chosen it. Offering only what the gateway will
        accept is the difference between a checkout that works and one that
        looks like it works.
        """
        try:
            with httpx.Client(timeout=15.0) as client:
                response = client.get(
                    f"{API_ROOT}/methods", params={"key_id": self._key_id}
                )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as error:
            logger.error("Razorpay methods could not be read: %s", error)
            # An empty answer, not a guess. The caller falls back to whatever
            # the store has configured rather than promising something.
            return {}

        raw = payload.get("methods", payload)

        def named(value: Any) -> list:
            """
            Razorpay sends a map keyed by code, but the value is not always a
            label: banks come back as `{"HDFC": "HDFC Bank"}` and wallets as
            `{"mobikwik": true}`. A boolean is not a name, so those fall back
            to a readable form of the code.
            """
            if not isinstance(value, dict):
                return []
            return sorted(
                (code, label if isinstance(label, str) and label else _label(code))
                for code, label in value.items()
            )

        # `upi` covers collect and QR; `upi_intent` is the app handoff. An
        # account can have the second without the first.
        upi = bool(raw.get("upi"))
        upi_intent = bool(raw.get("upi_intent"))

        return {
            "card": bool(raw.get("card")),
            "netbanking": [{"code": code, "name": name} for code, name in named(raw.get("netbanking"))],
            "wallet": [{"code": code, "name": name} for code, name in named(raw.get("wallet"))],
            "upi": upi,
            "upiIntent": upi_intent,
            # A QR code is the collect rail rendered as an image, so it needs
            # `upi` proper — an intent-only account cannot show one.
            "upiQr": upi,
            "emi": bool(raw.get("emi")),
        }

    # ------------------------------------------------------------ qr codes

    def create_qr(
        self,
        *,
        amount: int,
        name: str,
        description: str,
        notes: Dict[str, str],
        close_by: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """
        A real, scannable UPI QR code.

        Razorpay's QR Codes are a **separate product** from the `upi` method on
        Checkout, and they are separately enabled — this account has Checkout
        UPI switched off and QR codes switched on, which is why the payment
        page can offer a scan-to-pay option that Checkout itself cannot.

        The consequence to understand is that a QR payment is **not attached to
        a gateway order**. Scanning produces a payment of its own, so it cannot
        be settled by the order signature the card and net banking flows use.
        It is settled instead by reading the QR's payments back from the
        gateway, and by the `qr_code.credited` webhook — both of which are the
        gateway's own word, which is the standard this system holds every
        payment to.

        `single_use` and `fixed_amount` together are what make it safe: the
        code is worth exactly this invoice, once. A reusable code for a
        variable amount is a code that can be scanned again tomorrow.
        """
        payload = {
            "type": "upi_qr",
            "name": name[:50] or "Payment",
            "usage": "single_use",
            "fixed_amount": True,
            "payment_amount": amount,
            "description": description[:120],
            "notes": notes,
        }

        # Razorpay stops the code accepting payment at this moment. Its bounds
        # are two minutes to two hours from now; the caller keeps inside them.
        if close_by is not None:
            payload["close_by"] = int(close_by.replace(tzinfo=timezone.utc).timestamp())

        qr = self._request("POST", "/payments/qr_codes", json=payload)

        return {
            "id": qr["id"],
            "imageUrl": qr.get("image_url", ""),
            "amount": qr.get("payment_amount", amount),
            "status": qr.get("status", "active"),
            "closeBy": qr.get("close_by"),
        }

    def qr_poster_url(self, qr_id: str) -> str:
        """
        Where Razorpay serves this code's image.

        Read from the QR itself rather than assembled from a URL pattern. The
        pattern the short link resolves to is undocumented, and an image URL
        that quietly stops working would leave a payment page showing a broken
        code.
        """
        return self._request("GET", f"/payments/qr_codes/{qr_id}").get("image_url", "")

    def qr_payments(self, qr_id: str) -> list:
        """Every payment made against a QR code. Used to poll for a scan."""
        try:
            return self._request("GET", f"/payments/qr_codes/{qr_id}/payments").get(
                "items", []
            )
        except RazorpayError:
            return []

    def close_qr(self, qr_id: str) -> None:
        """
        Retire a code the shopper walked away from.

        A single-use code closes itself once paid; this is for the other
        ending, so an abandoned code cannot be scanned later.
        """
        try:
            self._request("POST", f"/payments/qr_codes/{qr_id}/close")
        except RazorpayError:
            # Already closed or already paid. Neither is worth failing over.
            pass

    # --------------------------------------------------------- payment links

    def create_payment_link(
        self,
        *,
        amount: int,
        currency: str,
        reference_id: str,
        description: str,
        customer: Dict[str, str],
        expire_by: datetime,
        callback_url: str,
        notify: bool = True,
    ) -> Dict[str, Any]:
        """
        A Razorpay-hosted payment page, sent to the customer by SMS and email.

        For orders that are already confirmed and not paid — cash on delivery,
        chiefly, where a customer would rather pay now than hand the courier
        cash. Not for the checkout itself: Razorpay requires a link to live at
        least fifteen minutes, and a checkout hold lasts five.

        `reference_id` is our own payment id. Razorpay enforces it unique per
        link, which makes a second link for the same payment fail loudly rather
        than exist quietly, and it is what the callback and the webhook are
        matched on. `accept_partial` is off: a partly-paid order is not a paid
        one, and there is no workflow here for the rest.
        """
        payload = {
            "amount": amount,
            "currency": currency,
            "accept_partial": False,
            "reference_id": reference_id[:40],
            "description": description[:2048],
            "customer": {key: value for key, value in customer.items() if value},
            "notify": {"sms": notify and bool(customer.get("contact")), "email": notify and bool(customer.get("email"))},
            "reminder_enable": notify,
            "expire_by": int(expire_by.replace(tzinfo=timezone.utc).timestamp()),
            "callback_url": callback_url,
            "callback_method": "get",
            "notes": {"paymentId": reference_id},
        }

        link = self._request("POST", "/payment_links", json=payload)
        return {
            "id": link["id"],
            "shortUrl": link.get("short_url", ""),
            "status": link.get("status", "created"),
            "expireBy": link.get("expire_by"),
        }

    def cancel_payment_link(self, link_id: str) -> None:
        """Retire a link, so it cannot be paid after the order is settled or cancelled."""
        try:
            self._request("POST", f"/payment_links/{link_id}/cancel")
        except RazorpayError:
            # Already paid, expired or cancelled. None of those is worth failing over.
            pass

    def verify_payment_link_signature(self, params: Dict[str, str]) -> bool:
        """
        The Payment Link callback's signature.

        The message is `link_id|reference_id|status|payment_id`, keyed with the
        API secret — taken from Razorpay's own SDK
        (`razorpay.utility.verify_payment_link_signature`), since the docs
        describe the fields but hide the order and separator behind it.
        """
        fields = (
            params.get("razorpay_payment_link_id", ""),
            params.get("razorpay_payment_link_reference_id", ""),
            params.get("razorpay_payment_link_status", ""),
            params.get("razorpay_payment_id", ""),
        )
        signature = params.get("razorpay_signature", "")
        if not all(fields) or not signature:
            return False
        return self.verify_signature("|".join(fields), signature)

    # --------------------------------------------------------------- verify

    def verify(self, transaction_id: str, payload: Dict[str, str]) -> PaymentResult:
        """
        Turn Checkout's claim into a fact.

        `transaction_id` is the Razorpay order id this payment was opened
        against — taken from our own record, never from the request, so a
        client cannot point a signature at somebody else's order.
        """
        payment_id = (payload.get("razorpay_payment_id") or "").strip()
        order_id = (payload.get("razorpay_order_id") or "").strip()
        signature = (payload.get("razorpay_signature") or "").strip()

        if not (payment_id and order_id and signature):
            return PaymentResult(
                ok=False,
                transaction_id=transaction_id,
                status="failed",
                failure_reason="The payment response was incomplete.",
            )

        # The order id in the response must be the one we opened. Without this
        # a signature for a genuine payment on a different order would pass.
        if order_id != transaction_id:
            logger.warning(
                "Razorpay verify: order mismatch (expected %s, got %s)",
                transaction_id,
                order_id,
            )
            return PaymentResult(
                ok=False,
                transaction_id=transaction_id,
                status="failed",
                failure_reason="That payment belongs to a different order.",
            )

        if not self.verify_signature(f"{order_id}|{payment_id}", signature):
            logger.warning("Razorpay verify: bad signature for order %s", order_id)
            return PaymentResult(
                ok=False,
                transaction_id=transaction_id,
                status="failed",
                failure_reason="The payment could not be verified.",
            )

        # Signature good. Now ask the gateway what actually happened, because
        # the signature says nothing about the outcome or the amount.
        fetched = self.fetch(payment_id)
        if fetched is None:
            return PaymentResult(
                ok=False,
                transaction_id=payment_id,
                status="failed",
                failure_reason="The payment could not be read back from the provider.",
            )

        return fetched

    def verify_signature(self, body: str, signature: str) -> bool:
        """HMAC-SHA256 with the key secret, compared in constant time."""
        expected = hmac.new(
            self._key_secret.encode("utf-8"), body.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        return hmac.compare_digest(expected, signature)

    def verify_webhook(self, raw_body: bytes, signature: str) -> bool:
        """
        The same check, over the **raw** request body and the webhook secret.

        Raw, not re-serialised: any change in key order or spacing produces a
        different digest, so the bytes that arrived are the bytes that must be
        signed. A separate secret from the key secret because Razorpay issues
        it separately, and one that is unset means no delivery is trusted.
        """
        secret = settings.RAZOR_WEBHOOK_SECRET
        if not secret or not signature:
            return False

        expected = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, signature)

    # ---------------------------------------------------------------- fetch

    def fetch(self, transaction_id: str) -> Optional[PaymentResult]:
        """
        Current state, straight from the gateway. Used for reconciliation.

        Accepts a payment id or an order id: our record holds the order id
        until a payment exists, and reconciling an unpaid order means asking
        what payments that order collected.
        """
        try:
            if transaction_id.startswith("order_"):
                payments = self._request(
                    "GET", f"/orders/{transaction_id}/payments"
                ).get("items", [])
                if not payments:
                    return PaymentResult(
                        ok=True, transaction_id=transaction_id, status="pending"
                    )
                # The one that succeeded, if any; otherwise the latest attempt.
                payment = next(
                    (p for p in payments if p.get("status") == "captured"), payments[-1]
                )
            else:
                payment = self._request("GET", f"/payments/{transaction_id}")
        except RazorpayError:
            return None

        return self._to_result(payment)

    # --------------------------------------------------------------- refund

    def refund(self, transaction_id: str, amount: int, reason: str) -> RefundResult:
        """
        Send money back against a captured payment.

        `amount` is in minor units, which is what Razorpay expects too, so
        there is no conversion to get wrong.
        """
        if transaction_id.startswith(("order_", "COD-")):
            # No gateway payment to refund against. A COD order was settled in
            # cash, and an order id means Checkout never completed.
            return RefundResult(
                ok=False,
                reference="",
                status="rejected",
                failure_reason="There is no gateway payment to refund against.",
            )

        try:
            refund = self._request(
                "POST",
                f"/payments/{transaction_id}/refund",
                json={
                    "amount": amount,
                    # Razorpay's speed setting. "normal" goes through the
                    # regular settlement cycle; "optimum" costs more.
                    "speed": "normal",
                    "notes": {"reason": reason[:255]},
                },
            )
        except RazorpayError as error:
            return RefundResult(
                ok=False, reference="", status="rejected", failure_reason=str(error)
            )

        status = _REFUND_STATUS.get(refund.get("status", ""), "processing")
        return RefundResult(ok=status != "rejected", reference=refund["id"], status=status)

    # -------------------------------------------------------------- mapping

    def _to_result(self, payment: Dict[str, Any]) -> PaymentResult:
        status = _STATUS.get(payment.get("status", ""), "pending")

        return PaymentResult(
            ok=status in ("paid", "authorized", "pending"),
            transaction_id=payment["id"],
            status=status,
            instrument_hint=instrument_hint(payment),
            provider_reference=payment.get("order_id"),
            failure_reason=payment.get("error_description") or None,
            amount=payment.get("amount"),
            currency=payment.get("currency"),
        )


# Wallets Razorpay names only by code. Anything not listed falls back to a
# title-cased code, which reads correctly for most of them.
_WALLET_NAMES = {
    "mobikwik": "MobiKwik",
    "olamoney": "Ola Money",
    "airtelmoney": "Airtel Money",
    "freecharge": "Freecharge",
    "jiomoney": "JioMoney",
    "phonepe": "PhonePe",
    "paytm": "Paytm",
    "amazonpay": "Amazon Pay",
    "payzapp": "PayZapp",
}


def _label(code: str) -> str:
    return _WALLET_NAMES.get(code, code.replace("_", " ").title())


def instrument_hint(payment: Dict[str, Any]) -> str:
    """
    A masked remnant, and only that.

    Razorpay returns the last four digits of a card, a VPA and a bank name; it
    never returns a full card number, and this takes nothing that could
    identify an instrument on its own.
    """
    method = payment.get("method", "")

    if method == "card":
        card = payment.get("card") or {}
        last4 = card.get("last4", "")
        network = card.get("network", "")
        return f"{network} •••• {last4}".strip() if last4 else network

    if method == "upi":
        vpa = payment.get("vpa") or ""
        # "someone@okhdfc" → "•••••@okhdfc". The handle is the bank, not the person.
        return f"•••••@{vpa.split('@', 1)[1]}" if "@" in vpa else "UPI"

    if method == "netbanking":
        return payment.get("bank") or "Net banking"

    if method == "wallet":
        wallet = payment.get("wallet") or ""
        return f"{wallet.title()} Wallet" if wallet else "Wallet"

    if method == "emi":
        return "EMI"

    return method.replace("_", " ").title() if method else ""
