"""The store's emails beyond order stages: payments, refunds, returns, membership, invoices."""

from __future__ import annotations

import html as html_lib

from sqlalchemy.orm import Session

from app.services.email import _brand, _order_link, _order_rows, layout, notify, order_variables


def notify_payment(db: Session, order, amount_minor: int) -> None:
    esc = html_lib.escape
    intro = (
        f"We've received your payment of <strong>₹{amount_minor / 100:,.2f}</strong> for order "
        f"<strong>{esc(order.order_number)}</strong>."
    )
    html = layout("Payment received", intro, _order_rows(order), ("View your order", _order_link(order)))
    notify(
        db, "payment_received", to=order.customer_email, customer_id=order.customer_id,
        subject=f"Payment received — {order.order_number}", html=html,
        text=f"We've received your payment for order {order.order_number}.", reference=order.order_number,
        inbox={"href": f"/account/order?number={order.order_number}"},
        event="payment_received", variables={**order_variables(order), "amount": f"₹{amount_minor / 100:,.2f}"},
        extra_html=_order_rows(order), idempotency_key=f"payment:{order.order_number}:received",
    )


def notify_payment_failed(db: Session, order, payment) -> None:
    esc = html_lib.escape
    intro = (
        f"Your payment for order <strong>{esc(order.order_number)}</strong> didn't go through, "
        "and you haven't been charged. Your items are still held for you — you can try again "
        "with the same or another payment method."
    )
    link = f"{_brand()['url']}/checkout/payment?payment={payment.id}"
    notify(
        db, "payment_failed", to=order.customer_email, customer_id=order.customer_id,
        subject=f"Payment didn't go through — {order.order_number}",
        html=layout("Your payment didn't go through", intro, _order_rows(order), ("Try again", link)),
        text=f"Your payment for order {order.order_number} didn't go through. Try again: {link}",
        reference=order.order_number,
        event="payment_failed", variables={**order_variables(order), "payment_url": link},
        extra_html=_order_rows(order), idempotency_key=f"payment:{payment.id}:failed",
    )


def notify_payment_request(db: Session, order, payment, link: str, *, attempt: int = 1) -> None:
    """
    "Pay online for your order" — the store's own message and the store's own
    payment page, in place of a Razorpay Payment Link.
    """
    esc = html_lib.escape
    intro = (
        f"You can pay <strong>₹{payment.amount / 100:,.2f}</strong> for order "
        f"<strong>{esc(order.order_number)}</strong> online now, instead of in cash when it arrives — "
        "on our secure payment page, by UPI, card, net banking or wallet."
    )
    notify(
        db, "payment_failed", to=order.customer_email, customer_id=order.customer_id,
        subject=f"Pay online for order {order.order_number}",
        html=layout("Pay for your order online", intro, _order_rows(order), ("Pay online", link)),
        text=f"Pay for order {order.order_number} online: {link}",
        reference=order.order_number,
        event="payment_request", variables={**order_variables(order), "payment_url": link},
        extra_html=_order_rows(order), idempotency_key=f"payment:{payment.id}:request:{attempt}",
    )


def notify_refund(db: Session, refund, email: str) -> None:
    """
    "Refund of ₹X initiated" while the gateway works on it, "refund completed"
    once it is done — each sent once per refund (the key carries the status).
    A refund of part of an order says so. Nothing internal is ever included.
    """
    esc = html_lib.escape
    amount = f"₹{refund.amount / 100:,.2f}"
    from app.models import Invoice

    invoice = db.get(Invoice, refund.invoice_id) if getattr(refund, "invoice_id", None) else None
    kind = "partial refund" if invoice is not None and refund.amount < invoice.grand_total else "refund"
    done = refund.status == "completed"
    store_credit = getattr(refund, "method", "") == "store-credit"
    where = ("It has been added to your store credit." if store_credit
             else "Online payments usually reach your account within 5–7 working days.")
    intro = (
        f"We've {'issued' if done else 'started'} a {kind} of <strong>{amount}</strong> for order "
        f"<strong>{esc(refund.order_number)}</strong>. {where}"
    )
    notify(
        db, "refund_updates", to=email, customer_id=refund.customer_id,
        subject=f"{kind.capitalize()} of {amount} {'' if done else 'initiated '}— {refund.order_number}",
        html=layout("Your refund is on its way" if done else "We've started your refund", intro),
        text=f"We've {'issued' if done else 'started'} a {kind} of {amount} for order {refund.order_number}.",
        reference=refund.refund_number or "",
        inbox={"href": f"/account/order?number={refund.order_number}"},
        event="refund_completed" if refund.status == "completed" else "refund_initiated",
        variables={"order_number": refund.order_number, "refund_amount": amount,
                   "order_url": f"{_brand()['url']}/account/order?number={refund.order_number}"},
        idempotency_key=f"refund:{refund.refund_number or refund.id}:{refund.status}",
    )


from app.services.messaging.catalogue import RETURN_STATUS_EVENTS  # noqa: E402

RETURN_COPY = {
    "requested": "We've received your request and will review it shortly.",
    "approved": "Your request is approved. We'll collect the item from your delivery address.",
    "rejected": "We're unable to accept this request.",
    "picked-up": "We've collected the item.",
    "received": "The item has reached us.",
    "refunded": "Your refund has been issued.",
    "replacement-shipped": "Your replacement is on its way.",
    "completed": "Your replacement has been completed.",
    "cancelled": "Your request has been cancelled.",
}


def notify_return(db: Session, request, email: str) -> None:
    esc = html_lib.escape
    kind = "return" if request.kind == "return" else "replacement"
    title = f"Update on your {kind}"
    intro = (
        f"{esc(RETURN_COPY.get(request.status, 'There is an update on your request.'))} "
        f"Order <strong>{esc(request.order_number)}</strong>."
    )
    if request.resolution_note:
        intro += f"<br><br><em>{esc(request.resolution_note)}</em>"
    html = layout(
        title, intro,
        cta=("View your order", f"{_brand()['url']}/account/order?number={request.order_number}"),
    )
    notify(
        db, "return_updates", to=email, customer_id=request.customer_id,
        subject=f"{title} — {request.order_number}", html=html,
        text=f"{RETURN_COPY.get(request.status, '')} Order {request.order_number}.", reference=request.id,
        inbox={"href": f"/account/order?number={request.order_number}"},
        event=RETURN_STATUS_EVENTS.get((kind, request.status)),
        variables={"order_number": request.order_number, "return_kind": kind,
                   "return_status": request.status.replace("-", " "),
                   "resolution_note": request.resolution_note or "",
                   "order_url": f"{_brand()['url']}/account/order?number={request.order_number}"},
        idempotency_key=f"return:{request.id}:{request.status}",
    )


def notify_membership(db: Session, membership, email: str, programme_name: str) -> None:
    esc = html_lib.escape
    ends = membership.ends_at.strftime("%d %b %Y") if membership.ends_at else ""
    intro = (
        f"Welcome to <strong>{esc(programme_name)}</strong>. Your {esc(membership.plan_name)} membership "
        f"is active{f' until {ends}' if ends else ''}. Your benefits apply automatically at checkout."
    )
    notify(
        db, "membership", to=email, customer_id=membership.customer_id,
        subject=f"Welcome to {programme_name}",
        html=layout(f"Welcome to {programme_name}", intro, cta=("Start shopping", _brand()["url"])),
        text=f"Welcome to {programme_name}. Your membership is active until {ends}.", reference=membership.id,
        inbox={"href": "/account/membership"},
        event="membership_activated",
        variables={"membership_plan": membership.plan_name, "membership_expiry": ends,
                   "membership_url": f"{_brand()['url']}/account/membership"},
        idempotency_key=f"membership:{membership.id}:activated",
    )


SHIPMENT_COPY = {
    "shipment_created": ("Packed and ready to ship",
                         "Your order is packed and booked with {courier}. Tracking number: {awb}."),
    "delivery_attempted": ("We tried to deliver your order",
                           "{courier} tried to deliver your order but couldn't. They'll usually try again on "
                           "the next working day."),
    "delivery_failed": ("We couldn't deliver your order",
                        "{courier} couldn't deliver your order. Our team will be in touch to arrange what "
                        "happens next."),
    "shipment_returned": ("Your parcel is coming back to us",
                          "The parcel couldn't be delivered and is on its way back to us. We'll contact you "
                          "about a refund or a new delivery."),
}


def notify_shipment(db: Session, shipment, order, event_key: str, *, suffix: str = "") -> bool:
    """
    A courier moment with no order stage of its own (see `messaging.catalogue`):
    booked, delivery attempted, delivery failed, returned. Sent once per
    shipment per event (per attempt, for delivery attempts).
    """
    if event_key not in SHIPMENT_COPY or order is None:
        return False
    esc = html_lib.escape
    courier = shipment.courier_name or "the courier"
    title, body = SHIPMENT_COPY[event_key]
    sentence = body.format(courier=courier, awb=shipment.awb or "")
    intro = f"{esc(sentence)} Order <strong>{esc(order.order_number)}</strong>."
    html = layout(title, intro, _order_rows(order), ("Track your order", _order_link(order)))
    variables = {**order_variables(order), "courier_name": courier, "tracking_number": shipment.awb or ""}
    key = f"shipment:{shipment.shipment_number}:{event_key}"
    if suffix:
        key = f"{key}:{suffix}"
    return notify(
        db, "order_updates", to=order.customer_email, customer_id=order.customer_id,
        subject=f"{title} — {order.order_number}", html=html,
        text=f"{sentence} Order {order.order_number}. {_order_link(order)}", reference=order.order_number,
        inbox={"href": f"/account/order?number={order.order_number}"},
        event=event_key, variables=variables, extra_html=_order_rows(order), idempotency_key=key[:140],
    )


def notify_invoice(db: Session, invoice) -> bool:
    esc = html_lib.escape
    link = f"{_brand()['url']}/account/invoice?id={invoice.id}"
    intro = (
        f"Here is invoice <strong>{esc(invoice.invoice_number)}</strong> for order "
        f"<strong>{esc(invoice.order_number)}</strong>, totalling "
        f"<strong>₹{invoice.grand_total / 100:,.2f}</strong>. You can view, print or download it from your account."
    )
    return notify(
        db, "invoice", to=invoice.customer_email, customer_id=invoice.customer_id,
        subject=f"Your invoice {invoice.invoice_number}",
        html=layout(f"Invoice {invoice.invoice_number}", intro, cta=("View invoice", link)),
        text=f"Your invoice {invoice.invoice_number}: {link}", reference=invoice.invoice_number,
        event="invoice_issued",
        variables={"invoice_number": invoice.invoice_number, "order_number": invoice.order_number,
                   "amount": f"₹{invoice.grand_total / 100:,.2f}", "invoice_url": link},
    )
