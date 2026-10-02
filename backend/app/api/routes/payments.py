"""
The payment gateway's three endpoints.

    GET  /api/payments/config              what the browser needs to open Checkout
    POST /api/payments/{id}/verify         the browser came back — is it true?
    POST /api/payments/webhook/razorpay    the gateway's own account of events

Only the first is public and only the last is unauthenticated, and the last is
only trusted because every delivery is signature-checked before it is read.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.errors import NotFoundError, ValidationError
from app.dependencies.auth import get_current_customer
from app.models import Customer, Invoice, Order
from app.schemas.base import CamelModel
from app.schemas.billing import PaymentOut
from app.services import billing as billing_service, settlement
from app.services.payments import qr_image
from app.utils.response import ok

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/payments", tags=["Billing"])

# Razorpay's webhook bodies are a few kilobytes. This is generous headroom and a
# firm ceiling on what an unauthenticated endpoint will hash.
MAX_WEBHOOK_BYTES = 256 * 1024


class VerifyPayment(CamelModel):
    """
    What Razorpay Checkout hands the browser, passed straight through.

    Three opaque references and nothing else. Deliberately no amount, no order
    total and no status: the server already knows what is owed, and asking the
    client would be asking the payer how much they paid.
    """

    razorpay_payment_id: str
    razorpay_order_id: str
    razorpay_signature: str


@router.get("/config", summary="What the browser needs to open the gateway")
def payment_config():
    """
    The publishable key, and which gateway is live.

    The key **id** belongs in the browser — Razorpay Checkout cannot open
    without it, and on its own it can only start a payment, not read or move
    money. The key secret is not here and must never be: it signs requests and
    verifies responses, so anything holding it can take money.

    Served rather than baked into the frontend bundle so that rotating a key,
    or switching between test and live, is a restart of this process instead of
    a rebuild and redeploy of the storefront.
    """
    provider = settings.PAYMENT_PROVIDER

    return ok(
        {
            "provider": provider,
            "keyId": settings.RAZOR_KEY_ID if provider == "razorpay" else "",
            # False means checkout completes without a gateway handoff, which
            # is what the mock provider does. The client needs to know which
            # of the two flows it is in.
            "gateway": provider != "mock",
            # "test", "live", or "none" when there is no gateway.
            #
            # Read from the key's own prefix rather than a separate setting,
            # because a separate setting is a second thing to remember to
            # change and the first one to be wrong. The storefront says on its
            # terms page whether real money is taken, and that sentence has to
            # follow the keys automatically — a legal page that still says "no
            # money changes hands" after the live keys go in is the worst kind
            # of stale.
            "mode": _mode(),
        }
    )


def _mode() -> str:
    if settings.PAYMENT_PROVIDER != "razorpay":
        return "none"
    return "test" if settings.RAZOR_KEY_ID.startswith("rzp_test") else "live"


@router.get("/methods", summary="What the gateway will actually accept")
def payment_methods(db: Session = Depends(get_db)):
    """
    The methods the payment page offers, and the banks and wallets behind them.

    Two lists have to agree for a method to work: the ones the store offers in
    its own settings, and the ones the Razorpay account has switched on. A
    method in the first but not the second fails at the payment screen, *after*
    the shopper has picked it — so this intersects them and the page offers the
    result.

    Public, because the payment page needs it before anything is paid, and it
    reveals nothing but which rails a shop accepts.
    """
    from app.services import site as site_service

    # What the store offers, from the billing document.
    configured = set(
        ((billing_service.billing_config(db) or {}).get("payment") or {}).get(
            "enabledMethods"
        )
        or []
    )

    if settings.PAYMENT_PROVIDER != "razorpay":
        # No gateway: offer what the store configured and nothing more.
        return ok(
            {
                "gateway": False,
                "methods": sorted(configured),
                "netbanking": [],
                "wallet": [],
                "upiIntent": False,
                "upiQr": False,
                "qrCodes": False,
            }
        )

    from app.services.payments import get_provider

    available = get_provider().methods()

    # `cod` is ours, not the gateway's — it is an arrangement with a courier.
    offered = []
    if "cod" in configured:
        offered.append("cod")
    if available.get("upi") or available.get("upiIntent"):
        if configured & {"upi"}:
            offered.append("upi")
    # Scan-to-pay is Razorpay's QR Codes product, enabled separately from
    # Checkout's UPI method — an account can have one without the other, and
    # this one does. So it is offered on its own footing rather than behind the
    # `upi` flag, gated only by the store offering UPI at all.
    # Only when the gateway answered at all. `available` is empty when it could
    # not be reached, and a code we cannot mint is worse than one not offered.
    if "upi" in configured and available:
        offered.append("qr")
    if available.get("card") and configured & {"card", "debit-card"}:
        offered.append("card")
    if available.get("netbanking") and "netbanking" in configured:
        offered.append("netbanking")
    if available.get("wallet") and "wallet" in configured:
        offered.append("wallet")

    return ok(
        {
            "gateway": True,
            "methods": offered,
            "netbanking": available.get("netbanking", []),
            "wallet": available.get("wallet", []),
            "upiIntent": bool(available.get("upiIntent")),
            "upiQr": bool(available.get("upiQr")),
            # The QR Codes product. There is no capability flag for it, so it
            # is assumed available when Razorpay is the provider — minting one
            # fails loudly with the gateway's own reason if it is not enabled.
            "qrCodes": "qr" in offered,
        }
    )


@router.post("/{payment_id}/verify", summary="Confirm a payment the browser reports")
def verify_payment(
    payment_id: str,
    payload: VerifyPayment,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    """
    Settle a payment on the strength of a verified signature.

    **This is not where the outcome is decided.** What arrives here is a claim
    from a browser. `settlement.verify_and_settle` checks the signature with
    the key secret and then reads the payment back from the gateway, and only
    the gateway's answer is recorded.

    Scoped to the caller's own payments: the id is theirs or it is a 404.

    It is also not the only path. The webhook below settles the same payment
    independently, which is what covers a shopper who pays and then closes the
    tab before the browser gets back here. Whichever arrives first wins and the
    other becomes a no-op.
    """
    payment = settlement.get_payment(db, payment_id, customer_id=customer.id)
    settled = settlement.verify_and_settle(db, payment, payload.model_dump())

    return ok(
        PaymentOut.from_model(settled).model_dump(by_alias=True),
        message="Payment confirmed." if settled.status == "paid" else "Payment recorded.",
    )


@router.get("/{payment_id}/session", summary="Re-open the gateway for an unpaid payment")
def payment_session(
    payment_id: str,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    """
    A way back to the payment sheet.

    Dismissing Razorpay Checkout leaves a real order with an unpaid invoice
    against it. Without this the order is stranded: the cart has been emptied,
    the stock is committed, and the shopper has no way to finish paying.

    It hands back the **same** gateway order, not a new one. Razorpay accepts
    several payment attempts against one order and refuses two payments for it,
    so reusing the reference is both cheaper and safer than minting another —
    two open gateway orders for one invoice is how a customer gets charged
    twice.

    A settled payment returns no handoff, which is how the caller learns it is
    already paid.
    """
    payment = settlement.get_payment(db, payment_id, customer_id=customer.id)

    order = db.get(Order, payment.order_id)
    invoice = db.get(Invoice, payment.invoice_id)

    # Enforced here as well as by the sweeper. Somebody returning to pay after
    # the hold has lapsed finds it released now, not whenever the sweeper next
    # runs — and is told so, rather than offered a payment that would only be
    # refunded.
    if settlement.hold_lapsed(order):
        settlement.expire_payment(db, payment)
        db.refresh(payment)
        db.refresh(order)

    return ok(
        {
            "status": payment.status,
            # The number, not the id: it is what the confirmation page is
            # addressed by, and the page has no other way to learn it.
            "orderNumber": order.order_number if order else "",
            "gateway": settlement.gateway_handoff(db, order, invoice, payment)
            if order and invoice
            else None,
        }
    )


@router.post("/{payment_id}/qr", summary="Mint a QR code for this payment")
def create_qr(
    payment_id: str,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    """
    A scannable UPI code, worth exactly this invoice, once.

    Razorpay's QR Codes are a different product from Checkout's UPI method and
    are enabled separately, which is why this can work on an account whose
    Checkout UPI is switched off.

    The code's `notes` carry this payment's id. That is the only thing tying an
    otherwise free-standing QR payment back to this order, and both the polling
    endpoint below and the webhook refuse a scan whose notes name a different
    payment.
    """
    payment = settlement.get_payment(db, payment_id, customer_id=customer.id)

    # Settled, expired, or past its window: `open_qr` refuses each of them
    # under the payment's lock, so a code cannot be minted for an order that
    # is being settled or cancelled at the same moment.
    code = settlement.open_qr(db, payment)

    # The page is given our own URL, not Razorpay's. Theirs serves a poster
    # whose code is unscannable once it is sized to fit a payment panel — see
    # `qr_image` — and this one serves the code alone. The poster stays
    # available under its own name, which is what a "save the code" link wants.
    code["posterUrl"] = code.get("imageUrl", "")
    # A path relative to the API, the way every other path this API hands out
    # is. The client prepends its own base, which is the one place that knows
    # where this server lives.
    code["imageUrl"] = f"/payments/qr-image/{code['id']}"

    return ok(code)


@router.get("/qr-image/{qr_id}", summary="The QR code, and nothing else")
def qr_image_only(qr_id: str):
    """
    The scannable code, cut out of Razorpay's poster.

    Razorpay serves one image per code: a portrait poster with the code a third
    of the way down it, under a banner and between two rows of logos. Sized to
    fit a payment panel, the code's modules end up smaller than a camera can
    resolve and **no UPI app can read it**. `qr_image.extract` measures where
    the code is and returns that square alone, bitonal, with a quiet zone.

    ## Why this one is not behind the session

    An `<img src>` cannot carry an `Authorization` header, and this API
    authenticates with bearer tokens rather than cookies — so a guarded route
    here would simply render a broken image. Nothing is given away by that:
    Razorpay serves the very same poster on an unauthenticated URL of its own,
    so the code's id **is** the secret either way, and this route reveals no
    order, customer or payment. It is keyed on the code alone for that reason,
    rather than on a payment id it would have no way to check.

    Proxied rather than linked for two reasons beyond the cropping: it keeps
    the payment page on one origin, and the poster is fetched by this server
    once rather than by every shopper's browser — 396 KB down to about 2 KB.
    """
    url = settlement.qr_poster_url(qr_id)
    poster = qr_image.fetch(url) if url else None
    if poster is None:
        raise NotFoundError("That code could not be read.", error_code="QR_UNAVAILABLE")

    return Response(
        content=qr_image.extract(poster),
        media_type="image/png",
        headers={
            # Private and short: it is one shopper's code for one invoice.
            "Cache-Control": "private, max-age=120",
        },
    )


@router.get("/{payment_id}/qr/{qr_id}", summary="Has the code been scanned?")
def poll_qr(
    payment_id: str,
    qr_id: str,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    """
    Polled by the payment page while the code is on screen.

    Polling **and** the webhook, for the same reason the card flow has both: a
    shopper watching the page wants it to move the moment they pay, and an
    order has to settle even if they close the tab. Either path is the
    gateway's own answer, read with the secret key.
    """
    payment = settlement.get_payment(db, payment_id, customer_id=customer.id)
    settled = settlement.settle_qr(db, payment, qr_id)

    return ok({"status": settled.status, "paid": settled.status in settlement.SETTLED})


@router.delete("/{payment_id}/qr/{qr_id}", summary="Retire an unused code")
def close_qr(
    payment_id: str,
    qr_id: str,
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    """Called when the shopper picks a different method, so the code dies with the choice."""
    settlement.get_payment(db, payment_id, customer_id=customer.id)
    settlement.abandon_qr(qr_id)
    return ok({"closed": True})


@router.get("/link-callback", summary="The customer returned from a payment link")
def payment_link_callback(
    razorpay_payment_id: str = Query("", max_length=40),
    razorpay_payment_link_id: str = Query("", max_length=40),
    razorpay_payment_link_reference_id: str = Query("", max_length=40),
    razorpay_payment_link_status: str = Query("", max_length=20),
    razorpay_signature: str = Query("", max_length=128),
    db: Session = Depends(get_db),
):
    """
    Settle a payment link on the strength of Razorpay's signed redirect.

    No session is required, deliberately: a link is sent by SMS and is often
    paid on a different phone from the one the customer shops on. The
    signature, keyed with the API secret, is what authenticates this — and the
    payment is read back from the gateway before anything is recorded.

    Reveals only the order number and whether it is paid.
    """
    payment = settlement.settle_payment_link_callback(
        db,
        {
            "razorpay_payment_id": razorpay_payment_id,
            "razorpay_payment_link_id": razorpay_payment_link_id,
            "razorpay_payment_link_reference_id": razorpay_payment_link_reference_id,
            "razorpay_payment_link_status": razorpay_payment_link_status,
            "razorpay_signature": razorpay_signature,
        },
    )
    if payment is None:
        raise NotFoundError("No such payment link.", error_code="LINK_NOT_FOUND")

    return ok({"orderNumber": payment.order_number, "paid": payment.status in settlement.SETTLED})


@router.post("/webhook/razorpay", summary="Razorpay's own account of what happened")
async def razorpay_webhook(
    request: Request,
    x_razorpay_signature: str = Header(default=""),
    x_razorpay_event_id: str = Header(default=""),
    db: Session = Depends(get_db),
):
    """
    The authoritative path.

    A browser returning from Checkout is convenient; this is what is reliable.
    Razorpay retries a delivery that does not return 2xx, so an order gets
    settled even if the shopper closed the tab on the payment screen, lost
    connectivity, or never came back at all.

    ## What Razorpay's own guidance requires of it

    - **Duplicates are expected.** Razorpay says so in as many words, and gives
      each event an `x-razorpay-event-id`. Every processed id is recorded in
      `webhook_events`, in the same transaction as what it changed; a second
      delivery is acknowledged and not applied.
    - **Five seconds to answer**, or it is treated as a failure and resent.
      Processing is a lock, a few rows and at most one gateway call.
    - **A day of failures disables the webhook** until someone re-enables it in
      the dashboard. So anything that is not a bad signature is answered 2xx —
      including events this system does not model.
    - **Events arrive out of order.** Handled in settlement: a `failed` for an
      earlier attempt cannot undo a later capture.

    ## Why the raw body

    The signature is an HMAC over the exact bytes Razorpay sent. Re-serialising
    the JSON — a different key order, a space after a colon — produces a
    different digest and every delivery would fail. So the body is read as
    bytes, verified, and only then parsed.
    """
    raw = await request.body()

    if settings.PAYMENT_PROVIDER != "razorpay":
        # Nothing here can be settled by Razorpay, so nothing here should
        # accept its webhooks either.
        raise ValidationError("Razorpay is not the active provider.", error_code="PROVIDER_INACTIVE")

    # A payload this size is not a Razorpay webhook. Refused before any HMAC
    # is computed over it.
    if len(raw) > MAX_WEBHOOK_BYTES:
        raise ValidationError("The webhook body is too large.", error_code="WEBHOOK_TOO_LARGE")

    from app.services.payments import get_provider

    provider = get_provider()

    if not provider.verify_webhook(raw, x_razorpay_signature):
        # Deliberately terse. A caller with a bad signature learns only that.
        logger.warning("Razorpay webhook: signature rejected")
        raise ValidationError("The webhook signature is invalid.", error_code="WEBHOOK_UNVERIFIED")

    import json

    try:
        body = json.loads(raw)
    except ValueError:
        raise ValidationError("The webhook body was not JSON.", error_code="WEBHOOK_MALFORMED")

    if not isinstance(body, dict):
        raise ValidationError("The webhook body was not a JSON object.", error_code="WEBHOOK_MALFORMED")

    # --- seen it before? -----------------------------------------------
    #
    # Checked after the signature, never before: an unsigned request must not
    # be able to learn which event ids have been processed. Claiming the
    # event, applying it, recording the outcome and counting duplicates is
    # `services.webhooks`; a failure there is recorded and raised, so this
    # answers 500 and Razorpay delivers the event again.
    from app.services import webhooks

    outcome = webhooks.process(db, webhooks.event_id_for(x_razorpay_event_id, raw), body)

    # 2xx whatever happened, having verified the sender — see the docstring.
    return ok(outcome)
