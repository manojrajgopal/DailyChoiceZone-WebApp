"""The store's emails beyond order stages: payments, refunds, returns, membership, invoices."""

from __future__ import annotations

import html as html_lib
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.services.email import (
    _brand, _money, _order_link, _order_rows, after_greeting, layout, link, notify, order_banner, order_cards,
    order_lines,
    order_secondary, order_text, order_variables, payment_label, product_link,
)
from app.services.email import templates as T


def _find_order(db: Session, order_number: str):
    """The order a refund, return or invoice belongs to — or None, and the email goes without its lines."""
    if not order_number:
        return None
    try:
        from app.models import Order

        return db.execute(select(Order).where(Order.order_number == order_number)).scalars().first()
    except Exception:  # noqa: BLE001 — the details are a nicety; the email still goes
        return None


def _first_name(name: str) -> str:
    return html_lib.escape((name or "").split(" ")[0])


def _hello(name: str) -> str:
    first = _first_name(name)
    return f"Hello {first}, " if first else ""


# ---------------------------------------------------------------- payments


def notify_payment(db: Session, order, amount_minor: int) -> None:
    esc = html_lib.escape
    amount = f"₹{amount_minor / 100:,.2f}"
    intro = (
        f"{_hello(order.customer_name)}we've received your payment of <strong>{amount}</strong> for order "
        f"<strong>{esc(order.order_number)}</strong>. Thank you — your order is confirmed and on its way to being packed."
    )
    body = (T.stats([("Amount paid", amount, payment_label(order)),
                     ("Order total", _money(order.total), f"{order.item_count or len(order.items)} items")],
                    tone="success")
            + _order_rows(order) + order_cards(order))
    html = layout("Payment received", intro, body, ("View your order", _order_link(order)), tone="success",
                  icon="card", eyebrow="Payment successful", banner=order_banner(order),
                  secondary=[("Download invoice", link("/account/invoices"))] + order_secondary(order)[:1])
    notify(
        db, "payment_received", to=order.customer_email, customer_id=order.customer_id,
        subject=f"Payment received — {order.order_number}", html=html,
        text=order_text(order, "Payment received", f"We've received your payment of {amount} for order {order.order_number}."),
        reference=order.order_number,
        inbox={"href": f"/account/order?number={order.order_number}"},
        event="payment_received", variables={**order_variables(order), "amount": amount},
        extra_html=_order_rows(order), idempotency_key=f"payment:{order.order_number}:received",
    )


def notify_payment_failed(db: Session, order, payment) -> None:
    esc = html_lib.escape
    intro = (
        f"{_hello(order.customer_name)}your payment for order <strong>{esc(order.order_number)}</strong> didn't go through, "
        "and you haven't been charged. Your items are still held for you — you can try again "
        "with the same or another payment method."
    )
    link_url = f"{_brand()['url']}/checkout/payment?payment={payment.id}"
    hold = "We hold your items for a short while. If the payment isn't completed in time, the order is released."
    body = (T.note(hold, tone="warning", title="Complete your payment soon")
            + _order_rows(order)
            + T.steps(["Try the same method again — a bank or UPI hiccup is often temporary.",
                       "Or choose another: UPI, card, net banking or wallet.",
                       "If money left your account, it's returned automatically by your bank within 5–7 working days."],
                      title="What you can do"))
    notify(
        db, "payment_failed", to=order.customer_email, customer_id=order.customer_id,
        subject=f"Payment didn't go through — {order.order_number}",
        html=layout("Your payment didn't go through", intro, body, ("Try payment again", link_url), tone="danger",
                    icon="warning", eyebrow="Payment unsuccessful", banner=order_banner(order),
                    secondary=[("View order", _order_link(order)), ("Help", link("/faq"))]),
        text=f"Your payment for order {order.order_number} didn't go through. You haven't been charged. Try again: {link_url}",
        reference=order.order_number,
        event="payment_failed", variables={**order_variables(order), "payment_url": link_url},
        extra_html=_order_rows(order), idempotency_key=f"payment:{payment.id}:failed",
    )


def notify_payment_request(db: Session, order, payment, link_url: str, *, attempt: int = 1) -> None:
    """
    "Pay online for your order" — the store's own message and the store's own
    payment page, in place of a Razorpay Payment Link.
    """
    esc = html_lib.escape
    amount = f"₹{payment.amount / 100:,.2f}"
    intro = (
        f"{_hello(order.customer_name)}you can pay <strong>{amount}</strong> for order "
        f"<strong>{esc(order.order_number)}</strong> online now, instead of in cash when it arrives."
    )
    body = (T.stats([("Amount to pay", amount, "Secure online payment")])
            + T.steps([("Contactless delivery", "No need to keep change ready when the courier arrives."),
                       ("Any method you like", "UPI, card, net banking or wallet — on our secure payment page.")],
                      title="Why pay online")
            + _order_rows(order))
    notify(
        db, "payment_failed", to=order.customer_email, customer_id=order.customer_id,
        subject=f"Pay online for order {order.order_number}",
        html=layout("Pay for your order online", intro, body, ("Pay online now", link_url), icon="card",
                    eyebrow="Payment link", banner=order_banner(order),
                    secondary=[("View order", _order_link(order))]),
        text=f"Pay {amount} for order {order.order_number} online: {link_url}",
        reference=order.order_number,
        event="payment_request", variables={**order_variables(order), "payment_url": link_url},
        extra_html=_order_rows(order), idempotency_key=f"payment:{payment.id}:request:{attempt}",
    )


# ------------------------------------------------------------------ refunds


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
    where = ("It has been added to your store credit, ready to spend." if store_credit
             else "Online payments usually reach your account within 5–7 working days.")
    intro = (
        f"{_hello(getattr(refund, 'customer_name', ''))}we've {'issued' if done else 'started'} a {kind} of "
        f"<strong>{amount}</strong> for order <strong>{esc(refund.order_number)}</strong>. {where}"
    )
    order_url = f"{_brand()['url']}/account/order?number={refund.order_number}"
    destination = "Store credit" if store_credit else "Original payment method"
    rows = [("Refund number", refund.refund_number or ""), ("Order", refund.order_number),
            ("Refunded to", destination), ("Status", "Completed" if done else "In progress")]
    if getattr(refund, "reason", ""):
        rows.append(("Reason", refund.reason))
    body = (T.stats([("Refund amount", amount, destination)], tone="success" if done else "brand")
            + T.progress(["Requested", "Processing", "Refunded"], 2 if done else 1, tone="success" if done else "brand")
            + T.details(rows, title="Refund details"))
    order = _find_order(db, refund.order_number)
    if order is not None:
        body += _order_rows(order, title="Your order")
    if not done:
        body += T.steps(["Your bank or card provider credits the amount — usually in 5–7 working days.",
                         "We'll email you again when the refund is complete."])
    secondary = [("Store credit", link("/account/wallet"))] if store_credit else []
    notify(
        db, "refund_updates", to=email, customer_id=refund.customer_id,
        subject=f"{kind.capitalize()} of {amount} {'' if done else 'initiated '}— {refund.order_number}",
        html=layout("Your refund is on its way" if done else "We've started your refund", intro, body,
                    ("View your order", order_url), tone="success" if done else "brand", icon="refund",
                    eyebrow=f"{kind.capitalize()} {'issued' if done else 'initiated'}",
                    secondary=secondary + [("Returns policy", link("/returns")), ("Help", link("/faq"))]),
        text=f"We've {'issued' if done else 'started'} a {kind} of {amount} for order {refund.order_number}. {where}\n\n{order_url}",
        reference=refund.refund_number or "",
        inbox={"href": f"/account/order?number={refund.order_number}"},
        event="refund_completed" if refund.status == "completed" else "refund_initiated",
        variables={"order_number": refund.order_number, "refund_amount": amount, "order_url": order_url},
        idempotency_key=f"refund:{refund.refund_number or refund.id}:{refund.status}",
    )


# ------------------------------------------------------------------ returns

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

# status → (title, tone, icon, what happens next)
RETURN_STYLE = {
    "requested": ("We've received your {kind} request", "brand", "return",
                  ["Our team reviews your request — usually within 1–2 working days.",
                   "Once approved, we arrange a pickup from your delivery address."]),
    "approved": ("Your {kind} is approved", "success", "check",
                 ["Keep the item packed with its tags and original packaging.",
                  "Our courier partner will collect it — they may call before arriving."]),
    "rejected": ("We couldn't accept your {kind}", "danger", "cross", []),
    "picked-up": ("We've collected your item", "brand", "truck",
                  ["We inspect the item as soon as it reaches our warehouse."]),
    "received": ("Your item has reached us", "brand", "box",
                 ["We're checking the item now — your {next} follows shortly."]),
    "refunded": ("Your refund has been issued", "success", "refund",
                 ["Online payments usually reach your account within 5–7 working days."]),
    "replacement-shipped": ("Your replacement is on its way", "success", "truck",
                            ["Track it from your order page — the courier may call before delivering."]),
    "completed": ("Your replacement is complete", "success", "check", []),
    "cancelled": ("Your {kind} request was cancelled", "info", "cross", []),
}
RETURN_STEPS = {"return": ["Requested", "Approved", "Picked up", "Received", "Refunded"],
                "replacement": ["Requested", "Approved", "Picked up", "Received", "Shipped"]}
RETURN_AT = {"requested": 0, "approved": 1, "picked-up": 2, "received": 3, "refunded": 4,
             "replacement-shipped": 4, "completed": 4}


def _return_lines(request) -> list:
    lines = []
    for item in getattr(request, "items", None) or []:
        lines.append({
            "name": item.name, "image": item.image, "quantity": item.quantity, "url": product_link(item.product_id),
            "detail": " · ".join(p for p in (f"Size {item.size}" if item.size else "", item.color or "") if p),
            "amount": f"₹{(item.amount or 0) / 100:,.2f}" if item.amount else "",
        })
    return lines


def notify_return(db: Session, request, email: str) -> None:
    esc = html_lib.escape
    kind = "return" if request.kind == "return" else "replacement"
    title_tpl, tone, icon, upcoming = RETURN_STYLE.get(
        request.status, ("Update on your {kind}", "brand", "return", []))
    title = title_tpl.format(kind=kind)
    order_url = f"{_brand()['url']}/account/order?number={request.order_number}"
    intro = (
        f"{_hello(getattr(request, 'customer_name', ''))}"
        f"{esc(after_greeting(RETURN_COPY.get(request.status, 'There is an update on your request.')))} "
        f"Order <strong>{esc(request.order_number)}</strong>."
    )
    body = ""
    if request.status in RETURN_AT:
        body += T.progress(RETURN_STEPS[kind], RETURN_AT[request.status], tone=tone)
    if request.resolution_note:
        body += T.note(request.resolution_note, tone="danger" if request.status == "rejected" else "brand",
                       title="A note from our team")
    lines = _return_lines(request)
    if lines:
        body += T.items(lines, title=f"Item{'s' if len(lines) != 1 else ''} in this {kind}")
    body += T.details([("Request type", kind.capitalize()), ("Order", request.order_number),
                       ("Reason", getattr(request, "reason", "")),
                       ("Refund amount", f"₹{request.amount / 100:,.2f}" if kind == "return" and getattr(request, "amount", 0) else "")],
                      title="Request details")
    body += T.steps([s.format(next="refund" if kind == "return" else "replacement") for s in upcoming])
    html = layout(title, intro, body, ("View your order", order_url), tone=tone, icon=icon,
                  eyebrow=f"{kind.capitalize()} update",
                  secondary=[("Returns policy", link("/returns")), ("Help", link("/faq"))])
    notify(
        db, "return_updates", to=email, customer_id=request.customer_id,
        subject=f"{title} — {request.order_number}", html=html,
        text=f"{title}. {RETURN_COPY.get(request.status, '')} Order {request.order_number}."
             + (f"\n\nNote from our team: {request.resolution_note}" if request.resolution_note else "")
             + f"\n\n{order_url}",
        reference=request.id,
        inbox={"href": f"/account/order?number={request.order_number}"},
        event=RETURN_STATUS_EVENTS.get((kind, request.status)),
        variables={"order_number": request.order_number, "return_kind": kind,
                   "return_status": request.status.replace("-", " "),
                   "resolution_note": request.resolution_note or "",
                   "order_url": order_url},
        idempotency_key=f"return:{request.id}:{request.status}",
    )


# --------------------------------------------------------------- membership


def membership_benefits(benefits: Optional[dict]) -> list:
    """A membership's benefits as sentences — never the stored dictionary."""
    b = benefits or {}
    lines = []
    if float(b.get("memberDiscountPercent") or 0):
        lines.append(("Member price", f"{float(b['memberDiscountPercent']):g}% off every order, applied at checkout."))
    if b.get("freeDelivery"):
        per = b.get("freeDeliveriesPerMonth")
        lines.append(("Free delivery", f"{per} free deliveries every month." if per else "Free delivery on every order."))
    if int(b.get("extraReturnDays") or 0):
        lines.append(("Longer returns", f"{int(b['extraReturnDays'])} extra days to return or replace."))
    if b.get("earlyAccess"):
        lines.append(("Early access", "Shop sales and new arrivals before everyone else."))
    if b.get("prioritySupport"):
        lines.append(("Priority support", "Your requests go to the front of the queue."))
    return lines


def notify_membership(db: Session, membership, email: str, programme_name: str) -> None:
    esc = html_lib.escape
    ends = membership.ends_at.strftime("%d %b %Y") if membership.ends_at else ""
    starts = membership.starts_at.strftime("%d %b %Y") if getattr(membership, "starts_at", None) else ""
    intro = (
        f"Welcome to <strong>{esc(programme_name)}</strong>. Your {esc(membership.plan_name)} membership "
        f"is active{f' until {ends}' if ends else ''}. Your benefits apply automatically at checkout."
    )
    perks = membership_benefits(getattr(membership, "benefits", None))
    body = T.stats([("Plan", membership.plan_name), ("Valid until", ends)], tone="celebrate")
    if perks:
        body += T.steps(perks, title="Your benefits", tone="celebrate")
    body += T.details([("Started", starts), ("Renews / ends", ends),
                       ("Paid", f"₹{membership.amount / 100:,.2f}" if getattr(membership, "amount", 0) else "")],
                      title="Membership details")
    notify(
        db, "membership", to=email, customer_id=membership.customer_id,
        subject=f"Welcome to {programme_name}",
        html=layout(f"Welcome to {programme_name}", intro, body, ("Start shopping", _brand()["url"]),
                    tone="celebrate", icon="crown", eyebrow="Membership active",
                    secondary=[("Your membership", link("/account/membership")), ("Member FAQ", link("/membership"))]),
        text=f"Welcome to {programme_name}. Your {membership.plan_name} membership is active until {ends}.\n"
             + "\n".join(f"- {a}: {b}" for a, b in perks),
        reference=membership.id,
        inbox={"href": "/account/membership"},
        event="membership_activated",
        variables={"membership_plan": membership.plan_name, "membership_expiry": ends,
                   "membership_url": f"{_brand()['url']}/account/membership"},
        idempotency_key=f"membership:{membership.id}:activated",
    )


# ---------------------------------------------------------------- shipments

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

# event → (tone, icon, eyebrow, progress step or None, what happens next)
SHIPMENT_STYLE = {
    "shipment_created": ("brand", "box", "Ready to ship", 1, [
        "The courier collects your parcel — usually within a day.",
        "Use the tracking number with the courier, or follow it from your order page."]),
    "delivery_attempted": ("warning", "clock", "Delivery attempted", 3, [
        "Keep your phone reachable — the courier may call before the next attempt.",
        "Need to change something? Reply to this email and we'll help."]),
    "delivery_failed": ("danger", "warning", "Delivery unsuccessful", None, [
        "Our team will contact you to arrange a new delivery or a refund."]),
    "shipment_returned": ("info", "return", "Returning to us", None, [
        "Once it reaches us, we'll contact you about a refund or a new delivery."]),
}


def notify_shipment(db: Session, shipment, order, event_key: str, *, suffix: str = "") -> bool:
    """
    A courier moment with no order stage of its own (see `messaging.catalogue`):
    booked, delivery attempted, delivery failed, returned. Sent once per
    shipment per event (per attempt, for delivery attempts).
    """
    if event_key not in SHIPMENT_COPY or order is None:
        return False
    from app.services.email import ORDER_STEPS

    esc = html_lib.escape
    courier = shipment.courier_name or "the courier"
    title, body_copy = SHIPMENT_COPY[event_key]
    tone, icon, eyebrow, step, upcoming = SHIPMENT_STYLE[event_key]
    sentence = body_copy.format(courier=courier, awb=shipment.awb or "")
    intro = f"{_hello(order.customer_name)}{esc(after_greeting(sentence))}"
    body = (T.progress(ORDER_STEPS, step) if step is not None else "")
    body += T.details([("Courier", shipment.courier_name or ""), ("Tracking number", shipment.awb or ""),
                       ("Shipment", shipment.shipment_number),
                       ("Cash to pay on delivery", f"₹{shipment.cod_amount / 100:,.2f}" if getattr(shipment, "cod", False) and shipment.cod_amount else "")],
                      title="Shipment details")
    body += _order_rows(order) + order_cards(order, payment=False, tracking=shipment.awb or "",
                                             courier=shipment.courier_name or "")
    body += T.steps(upcoming)
    html = layout(title, intro, body, ("Track your order", _order_link(order)), tone=tone, icon=icon,
                  eyebrow=eyebrow, banner=order_banner(order), secondary=order_secondary(order))
    variables = {**order_variables(order), "courier_name": courier, "tracking_number": shipment.awb or ""}
    key = f"shipment:{shipment.shipment_number}:{event_key}"
    if suffix:
        key = f"{key}:{suffix}"
    return notify(
        db, "order_updates", to=order.customer_email, customer_id=order.customer_id,
        subject=f"{title} — {order.order_number}", html=html,
        text=order_text(order, title, sentence), reference=order.order_number,
        inbox={"href": f"/account/order?number={order.order_number}"},
        event=event_key, variables=variables, extra_html=_order_rows(order), idempotency_key=key[:140],
    )


# ----------------------------------------------------------------- invoices


def notify_invoice(db: Session, invoice) -> bool:
    esc = html_lib.escape
    url = f"{_brand()['url']}/account/invoice?id={invoice.id}"
    total = f"₹{invoice.grand_total / 100:,.2f}"
    intro = (
        f"{_hello(invoice.customer_name)}here is invoice <strong>{esc(invoice.invoice_number)}</strong> for order "
        f"<strong>{esc(invoice.order_number)}</strong>. You can view, print or download it from your account."
    )
    m = lambda v: f"₹{(v or 0) / 100:,.2f}"  # noqa: E731
    issued = invoice.issued_at.strftime("%d %b %Y") if getattr(invoice, "issued_at", None) else ""
    rows = [("Invoice number", invoice.invoice_number), ("Order", invoice.order_number), ("Issued", issued),
            ("Subtotal", m(invoice.subtotal))]
    if getattr(invoice, "coupon_discount", 0):
        rows.append((f"Coupon{f' ({invoice.coupon_code})' if invoice.coupon_code else ''}", f"−{m(invoice.coupon_discount)}"))
    if getattr(invoice, "member_discount", 0):
        rows.append(("Member discount", f"−{m(invoice.member_discount)}"))
    rows.append(("Delivery", m(invoice.shipping) if getattr(invoice, "shipping", 0) else "Free"))
    if getattr(invoice, "total_tax", 0):
        rows.append((f"GST{' (included)' if getattr(invoice, 'prices_include_tax', True) else ''}", m(invoice.total_tax)))
    rows.append(("Amount paid", m(invoice.amount_paid) if getattr(invoice, "amount_paid", 0) else ""))
    body = (T.stats([("Invoice total", total, f"{invoice.item_count} item{'s' if invoice.item_count != 1 else ''}")])
            + T.details(rows, title="Invoice summary"))
    order = _find_order(db, invoice.order_number)
    if order is not None:
        body += T.items(order_lines(order), title="Items")
    return notify(
        db, "invoice", to=invoice.customer_email, customer_id=invoice.customer_id,
        subject=f"Your invoice {invoice.invoice_number}",
        html=layout(f"Invoice {invoice.invoice_number}", intro, body, ("View & download invoice", url),
                    icon="receipt", eyebrow="Tax invoice",
                    secondary=[("All invoices", link("/account/invoices")),
                               ("View order", f"{_brand()['url']}/account/order?number={invoice.order_number}")]),
        text=f"Your invoice {invoice.invoice_number} for order {invoice.order_number}, totalling {total}: {url}",
        reference=invoice.invoice_number,
        event="invoice_issued",
        variables={"invoice_number": invoice.invoice_number, "order_number": invoice.order_number,
                   "amount": total, "invoice_url": url},
    )
