"""
Every event the store tells customers about, and what it says on each channel.

Each event names the email type it belongs to (`email_type`, from
`services.email.TYPES`) — so the store's existing on/off switch and the
customer's existing email choices keep deciding whether the email goes — its
category (transactional or marketing), the variables its wording may use,
and the built-in wording for email, SMS, WhatsApp and the in-app bell.

The built-in wording is used until the store saves its own in the portal
(`NotificationTemplate`). Most emails are still written by the code that
sends them, with the order lines and details laid out for that email; the
store's own wording, once saved, replaces the heading, message and button
text, and keeps those details.

SMS stays short (it is charged per 160 characters). WhatsApp messages that
the store starts must use a template approved by WhatsApp, so the store gives
that template's name and the variables to fill it with, in order.
"""

from __future__ import annotations

from typing import Dict, List

COMMON = ["customer_name", "store_name", "store_url"]
ORDER = COMMON + ["order_number", "order_date", "order_total", "payment_status", "shipping_address",
                  "tracking_number", "tracking_url", "order_url", "item_count", "first_item", "status_text"]
RETURN = COMMON + ["order_number", "order_url", "return_kind", "return_status", "resolution_note"]
SUPPORT = COMMON + ["support_request_number", "support_subject", "support_url", "message"]
MEMBERSHIP = COMMON + ["membership_plan", "membership_expiry", "membership_url"]

SAMPLE = {
    "customer_name": "Asha", "store_name": "Daily Choice Zone", "store_url": "https://dailychoicezone.com",
    "order_number": "DCZ10042", "order_date": "5 Oct 2026", "order_total": "₹2,498.00", "payment_status": "Paid",
    "shipping_address": "4 Brigade Road, Bengaluru, Karnataka 560001", "tracking_number": "BD123456789IN",
    "tracking_url": "https://dailychoicezone.com/account/order?number=DCZ10042", "order_url":
    "https://dailychoicezone.com/account/order?number=DCZ10042", "item_count": "2", "first_item": "Cotton Kurta",
    "status_text": "shipped", "amount": "₹2,498.00", "refund_amount": "₹1,299.00", "payment_url":
    "https://dailychoicezone.com/checkout/payment", "invoice_number": "DCZ-INV-2026-000042", "invoice_url":
    "https://dailychoicezone.com/account/invoice", "return_kind": "return", "return_status": "approved",
    "resolution_note": "", "membership_plan": "Choice Circle — Yearly", "membership_expiry": "5 Oct 2027",
    "membership_url": "https://dailychoicezone.com/account/membership", "support_request_number": "SR-10012",
    "support_subject": "Where is my parcel?", "support_url": "https://dailychoicezone.com/account/ticket",
    "message": "We've checked with the courier — it arrives tomorrow.", "action_url": "https://dailychoicezone.com",
    "product_name": "Cotton Kurta", "product_image": "", "cart_url": "https://dailychoicezone.com/cart",
    "account_url": "https://dailychoicezone.com/account", "campaign_title": "The festive edit is here",
    # Customer sign-in (docs/authentication.md).
    "provider_name": "Google",
}


def _event(label, group, email_type, variables, *, subject, heading, body, cta="", cta_var="", sms="",
           in_app_title="", in_app_body="", whatsapp_variables=None, category="transactional", locked=False,
           default_on=True, sms_default=False, whatsapp_default=False):
    return {
        "label": label, "group": group, "emailType": email_type, "category": category, "variables": variables,
        "locked": locked, "defaultOn": default_on,
        "default": {
            "subject": subject, "heading": heading, "body": body, "cta": cta, "ctaVariable": cta_var, "sms": sms,
            "inAppTitle": in_app_title or heading, "inAppBody": in_app_body,
            "whatsappVariables": whatsapp_variables or [v for v in ("customer_name", "order_number") if v in variables],
        },
        "channels": {"sms": sms_default, "whatsapp": whatsapp_default},
    }


def _stage(stage_label, title, body, sms, *, sms_default=False, whatsapp_default=False, email_type="order_updates"):
    return _event(
        f"Order {stage_label}", "Orders", email_type, ORDER,
        subject=f"{title} — {{{{order_number}}}}", heading=title, body=body, cta="View your order",
        cta_var="order_url", sms=sms, in_app_body="Order {{order_number}}", sms_default=sms_default,
        whatsapp_default=whatsapp_default,
        whatsapp_variables=["customer_name", "order_number", "status_text"],
    )


EVENTS: Dict[str, dict] = {
    # ------------------------------------------------------------- orders
    "order_confirmed": _stage(
        "placed & confirmed", "Your order is confirmed",
        "Hello {{customer_name}}, thank you for shopping with us. We're getting order **{{order_number}}** ready.",
        "{{store_name}}: Thank you! Order {{order_number}} ({{order_total}}) is confirmed. {{order_url}}",
        email_type="order_confirmation", whatsapp_default=True),
    "order_processing": _stage(
        "processing", "We're preparing your order",
        "Hello {{customer_name}}, we've started getting order **{{order_number}}** ready.",
        "{{store_name}}: We're preparing order {{order_number}}."),
    "order_packed": _stage(
        "packed", "Your order is packed",
        "Hello {{customer_name}}, order **{{order_number}}** is packed and will be handed to the courier soon.",
        "{{store_name}}: Order {{order_number}} is packed."),
    "order_shipped": _stage(
        "shipped", "Your order is on its way",
        "Hello {{customer_name}}, order **{{order_number}}** has left our warehouse and is with the courier.",
        "{{store_name}}: Order {{order_number}} has shipped. Track it: {{tracking_url}}", sms_default=True,
        whatsapp_default=True),
    "order_in_transit": _stage(
        "in transit", "Your order is in transit",
        "Hello {{customer_name}}, order **{{order_number}}** is moving through the courier's network towards you.",
        "{{store_name}}: Order {{order_number}} is in transit."),
    "order_out_for_delivery": _stage(
        "out for delivery", "Arriving today",
        "Hello {{customer_name}}, order **{{order_number}}** is out for delivery and will reach you today.",
        "{{store_name}}: Order {{order_number}} is out for delivery today.", sms_default=True,
        whatsapp_default=True),
    "order_delivered": _stage(
        "delivered", "Your order has been delivered",
        "Hello {{customer_name}}, order **{{order_number}}** has been delivered. We hope you love it — if anything "
        "isn't right, you can request a return or replacement from your account.",
        "{{store_name}}: Order {{order_number}} was delivered. Need help? {{order_url}}", sms_default=True),
    "order_cancelled": _stage(
        "cancelled", "Your order has been cancelled",
        "Hello {{customer_name}}, order **{{order_number}}** has been cancelled. If you paid online, your refund is "
        "on its way.",
        "{{store_name}}: Order {{order_number}} has been cancelled.", email_type="order_cancelled",
        sms_default=True),
    "order_returned": _stage(
        "returned", "Your order has been returned",
        "Hello {{customer_name}}, order **{{order_number}}** has been returned to us. Any refund due will follow "
        "shortly.",
        "{{store_name}}: Order {{order_number}} has been returned to us."),

    # ----------------------------------------------------------- shipments
    # The order-stage events above already cover shipped, in transit, out for
    # delivery and delivered (a shipment moves the order through them). These
    # are the courier moments that have no order stage of their own.
    "shipment_created": _event(
        "Shipment created", "Shipping", "order_updates", ORDER + ["courier_name"],
        subject="Your order is packed and ready to ship — {{order_number}}",
        heading="Packed and ready to ship",
        body="Hello {{customer_name}}, order **{{order_number}}** is packed and booked with {{courier_name}}. "
             "Tracking number: **{{tracking_number}}**.",
        cta="Track your order", cta_var="tracking_url",
        sms="{{store_name}}: Order {{order_number}} is booked with {{courier_name}}. Tracking {{tracking_number}}.",
        in_app_body="Order {{order_number}}"),
    "delivery_attempted": _event(
        "Delivery attempted", "Shipping", "order_updates", ORDER + ["courier_name"],
        subject="We tried to deliver your order — {{order_number}}", heading="We tried to deliver your order",
        body="Hello {{customer_name}}, {{courier_name}} tried to deliver order **{{order_number}}** but couldn't. "
             "They'll usually try again on the next working day.",
        cta="Track your order", cta_var="tracking_url",
        sms="{{store_name}}: A delivery attempt for order {{order_number}} didn't succeed. The courier will retry.",
        in_app_body="Order {{order_number}}", sms_default=True),
    "delivery_failed": _event(
        "Delivery failed", "Shipping", "order_updates", ORDER + ["courier_name"],
        subject="We couldn't deliver your order — {{order_number}}", heading="We couldn't deliver your order",
        body="Hello {{customer_name}}, {{courier_name}} couldn't deliver order **{{order_number}}**. "
             "Our team will be in touch to arrange what happens next.",
        cta="View your order", cta_var="order_url",
        sms="{{store_name}}: We couldn't deliver order {{order_number}}. We'll be in touch.",
        in_app_body="Order {{order_number}}", sms_default=True),
    "shipment_returned": _event(
        "Shipment returned to us", "Shipping", "order_updates", ORDER + ["courier_name"],
        subject="Your parcel is coming back to us — {{order_number}}", heading="Your parcel is coming back to us",
        body="Hello {{customer_name}}, the parcel for order **{{order_number}}** couldn't be delivered and is "
             "on its way back to us. We'll contact you about a refund or a new delivery.",
        cta="View your order", cta_var="order_url",
        sms="{{store_name}}: The parcel for order {{order_number}} is returning to us. We'll be in touch.",
        in_app_body="Order {{order_number}}"),

    # ------------------------------------------------------------ payments
    "payment_received": _event(
        "Payment received", "Payments", "payment_received", ORDER + ["amount"],
        subject="Payment received — {{order_number}}", heading="Payment received",
        body="Hello {{customer_name}}, we've received your payment of **{{amount}}** for order **{{order_number}}**.",
        cta="View your order", cta_var="order_url",
        sms="{{store_name}}: Payment of {{amount}} received for order {{order_number}}."),
    "payment_failed": _event(
        "Payment failed", "Payments", "payment_failed", ORDER + ["payment_url"],
        subject="Payment didn't go through — {{order_number}}", heading="Your payment didn't go through",
        body="Hello {{customer_name}}, your payment for order **{{order_number}}** didn't go through and you "
             "haven't been charged. Your items are still held for you — you can try again.",
        cta="Try again", cta_var="payment_url",
        sms="{{store_name}}: Payment for order {{order_number}} didn't go through. Try again: {{payment_url}}",
        sms_default=True),
    "payment_request": _event(
        "Pay online", "Payments", "payment_failed", ORDER + ["payment_url"],
        subject="Pay online for order {{order_number}}", heading="Pay for your order online",
        body="Hello {{customer_name}}, you can pay **{{order_total}}** for order **{{order_number}}** online now "
             "instead of in cash on delivery — on our secure payment page, by UPI, card, net banking or wallet.",
        cta="Pay online", cta_var="payment_url",
        sms="{{store_name}}: Pay {{order_total}} for order {{order_number}} online: {{payment_url}}",
        sms_default=True),
    "refund_initiated": _event(
        "Refund initiated", "Payments", "refund_updates", ORDER + ["refund_amount"],
        subject="Refund of {{refund_amount}} started — {{order_number}}", heading="We've started your refund",
        body="Hello {{customer_name}}, we've started a refund of **{{refund_amount}}** for order "
             "**{{order_number}}**. We'll tell you when it's on its way.",
        cta="View your order", cta_var="order_url",
        sms="{{store_name}}: Refund of {{refund_amount}} started for order {{order_number}}."),
    "refund_completed": _event(
        "Refund completed", "Payments", "refund_updates", ORDER + ["refund_amount"],
        subject="Refund of {{refund_amount}} — {{order_number}}", heading="Your refund is on its way",
        body="Hello {{customer_name}}, we've issued a refund of **{{refund_amount}}** for order **{{order_number}}**. "
             "Online payments usually reach your account within 5–7 working days.",
        cta="View your order", cta_var="order_url",
        sms="{{store_name}}: Refund of {{refund_amount}} issued for order {{order_number}}. Allow 5-7 working days.",
        sms_default=True),
    "invoice_issued": _event(
        "Invoice", "Payments", "invoice", ORDER + ["invoice_number", "invoice_url", "amount"],
        subject="Your invoice {{invoice_number}}", heading="Invoice {{invoice_number}}",
        body="Hello {{customer_name}}, here is invoice **{{invoice_number}}** for order **{{order_number}}**, "
             "totalling **{{amount}}**. You can view, print or download it from your account.",
        cta="View invoice", cta_var="invoice_url"),

    # ------------------------------------------------- returns & replacements
    **{
        f"return_{status}": _event(
            label, "Returns", "return_updates", RETURN,
            subject="Update on your {{return_kind}} — {{order_number}}", heading=heading, body=body,
            cta="View your order", cta_var="order_url", sms=sms, sms_default=status in ("approved", "rejected"))
        for status, label, heading, body, sms in (
            ("requested", "Return requested", "We've received your request",
             "Hello {{customer_name}}, we've received your {{return_kind}} request for order **{{order_number}}** "
             "and will review it shortly.", "{{store_name}}: We've received your {{return_kind}} request for "
             "{{order_number}}."),
            ("approved", "Return approved", "Your request is approved",
             "Hello {{customer_name}}, your {{return_kind}} request for order **{{order_number}}** is approved. "
             "We'll collect the item from your delivery address.", "{{store_name}}: Your {{return_kind}} for "
             "{{order_number}} is approved. We'll collect it soon."),
            ("rejected", "Return rejected", "We couldn't accept your request",
             "Hello {{customer_name}}, we're unable to accept your {{return_kind}} request for order "
             "**{{order_number}}**. {{resolution_note}}", "{{store_name}}: We couldn't accept your {{return_kind}} "
             "request for {{order_number}}. Details: {{order_url}}"),
            ("received", "Return received", "Your item has reached us",
             "Hello {{customer_name}}, the item from order **{{order_number}}** has reached us.",
             "{{store_name}}: Your returned item for {{order_number}} has reached us."),
        )
    },
    "replacement_initiated": _event(
        "Replacement initiated", "Returns", "return_updates", RETURN,
        subject="Your replacement is being arranged — {{order_number}}", heading="We're arranging your replacement",
        body="Hello {{customer_name}}, we're arranging a replacement for order **{{order_number}}**.",
        cta="View your order", cta_var="order_url",
        sms="{{store_name}}: We're arranging a replacement for order {{order_number}}."),
    "replacement_shipped": _event(
        "Replacement shipped", "Returns", "return_updates", RETURN,
        subject="Your replacement is on its way — {{order_number}}", heading="Your replacement is on its way",
        body="Hello {{customer_name}}, the replacement for order **{{order_number}}** is on its way to you.",
        cta="View your order", cta_var="order_url",
        sms="{{store_name}}: Your replacement for order {{order_number}} has shipped.", sms_default=True),
    "replacement_delivered": _event(
        "Replacement delivered", "Returns", "return_updates", RETURN,
        subject="Your replacement is complete — {{order_number}}", heading="Your replacement has been delivered",
        body="Hello {{customer_name}}, your replacement for order **{{order_number}}** is complete.",
        cta="View your order", cta_var="order_url",
        sms="{{store_name}}: Your replacement for order {{order_number}} is complete."),

    # ------------------------------------------------------------- account
    "welcome": _event(
        "Welcome", "Account", "account_security", COMMON + ["account_url"],
        subject="Welcome to {{store_name}}", heading="Welcome, {{customer_name}}",
        body="Your email is confirmed and your account is ready. Save favourites to your wishlist, track orders "
             "and manage returns from your account.",
        cta="Start shopping", cta_var="store_url", sms="Welcome to {{store_name}}, {{customer_name}}!"),
    "email_verification": _event(
        "Email verification", "Account", "account_security", COMMON + ["action_url"],
        subject="Confirm your email address", heading="Confirm your email address",
        body="Hello {{customer_name}}, confirm this is your email address to finish setting up your account. The "
             "link works once and expires soon.",
        cta="Confirm email address", cta_var="action_url", locked=True),
    "password_reset": _event(
        "Password reset", "Account", "account_security", COMMON + ["action_url"],
        subject="Reset your {{store_name}} password", heading="Reset your password",
        body="Hello {{customer_name}}, we received a request to reset your password. The link works once and "
             "expires soon. If this wasn't you, ignore this email — your password stays the same.",
        cta="Choose a new password", cta_var="action_url", locked=True),
    "password_changed": _event(
        "Password changed", "Account", "account_security", COMMON + ["account_url"],
        subject="Your password was changed", heading="Your password was changed",
        body="Hello {{customer_name}}, the password for your account was just changed and you've been signed out "
             "everywhere else. If this wasn't you, reset your password now and contact us.",
        cta="Go to your account", cta_var="account_url",
        sms="{{store_name}}: Your password was changed. Not you? Reset it now: {{account_url}}", locked=True,
        sms_default=True),
    "login_alert": _event(
        "Sign-in alert", "Account", "account_security", COMMON + ["account_url"],
        subject="New sign-in to your {{store_name}} account", heading="A new sign-in to your account",
        body="Hello {{customer_name}}, your account was just signed in to. If this was you, there's nothing to do. "
             "If not, reset your password now.",
        cta="Go to your account", cta_var="account_url", default_on=False),
    # Customer sign-in (docs/authentication.md): linked accounts and the sign-in phone.
    "identity_linked": _event(
        "Sign-in account connected", "Account", "account_security", COMMON + ["account_url", "provider_name"],
        subject="{{provider_name}} is now connected to your account", heading="{{provider_name}} connected",
        body="Hello {{customer_name}}, your {{provider_name}} account was connected, so you can now sign in with "
             "it. If this wasn't you, disconnect it from your security settings and change your password.",
        cta="Review your security settings", cta_var="account_url", locked=True),
    "identity_unlinked": _event(
        "Sign-in account disconnected", "Account", "account_security", COMMON + ["account_url", "provider_name"],
        subject="{{provider_name}} was disconnected from your account", heading="{{provider_name}} disconnected",
        body="Hello {{customer_name}}, your {{provider_name}} account can no longer be used to sign in. If this "
             "wasn't you, change your password straight away.",
        cta="Review your security settings", cta_var="account_url", locked=True),
    "phone_verified": _event(
        "Mobile number confirmed", "Account", "account_security", COMMON + ["account_url"],
        subject="Your mobile number is confirmed", heading="Your mobile number is confirmed",
        body="Hello {{customer_name}}, your mobile number is now confirmed on your account and can be used to "
             "sign in. If this wasn't you, contact us straight away.",
        cta="Review your security settings", cta_var="account_url", locked=True),

    # ---------------------------------------------------------- membership
    "membership_activated": _event(
        "Membership activated", "Membership", "membership", MEMBERSHIP,
        subject="Welcome to {{membership_plan}}", heading="Your membership is active",
        body="Hello {{customer_name}}, your **{{membership_plan}}** membership is active until "
             "**{{membership_expiry}}**. Your benefits apply automatically at checkout.",
        cta="See your benefits", cta_var="membership_url",
        sms="{{store_name}}: Your {{membership_plan}} membership is active until {{membership_expiry}}."),
    "membership_expiring": _event(
        "Membership expiring", "Membership", "membership", MEMBERSHIP,
        subject="Your membership ends on {{membership_expiry}}", heading="Your membership ends soon",
        body="Hello {{customer_name}}, your **{{membership_plan}}** membership ends on **{{membership_expiry}}**. "
             "Renew to keep your benefits.",
        cta="Renew membership", cta_var="membership_url",
        sms="{{store_name}}: Your membership ends on {{membership_expiry}}. Renew: {{membership_url}}"),
    "membership_expired": _event(
        "Membership expired", "Membership", "membership", MEMBERSHIP,
        subject="Your membership has ended", heading="Your membership has ended",
        body="Hello {{customer_name}}, your **{{membership_plan}}** membership ended on **{{membership_expiry}}**. "
             "You can rejoin any time.",
        cta="Rejoin", cta_var="membership_url"),

    # -------------------------------------------------------------- support
    "support_created": _event(
        "Support request created", "Support", "support_updates", SUPPORT,
        subject="We've received {{support_request_number}}", heading="We've received your request",
        body="Hello {{customer_name}}, we've received your request **{{support_request_number}}** — "
             "{{support_subject}}. We'll reply as soon as we can.",
        cta="View your request", cta_var="support_url",
        sms="{{store_name}}: We've received {{support_request_number}}. We'll reply soon."),
    "support_reply": _event(
        "Support reply", "Support", "support_updates", SUPPORT,
        subject="New reply on {{support_request_number}}", heading="We've replied to your request",
        body="Hello {{customer_name}}, there's a new reply on **{{support_request_number}}**:\n\n{{message}}",
        cta="View your request", cta_var="support_url",
        sms="{{store_name}}: New reply on {{support_request_number}}: {{support_url}}"),
    "support_status": _event(
        "Support status changed", "Support", "support_updates", SUPPORT,
        subject="Update on {{support_request_number}}", heading="Update on your request",
        body="Hello {{customer_name}}, there's an update on **{{support_request_number}}**. {{message}}",
        cta="View your request", cta_var="support_url"),
    "support_resolved": _event(
        "Support request resolved", "Support", "support_updates", SUPPORT,
        subject="{{support_request_number}} has been resolved", heading="Your request is resolved",
        body="Hello {{customer_name}}, we've resolved **{{support_request_number}}**. If anything's still not "
             "right, reply and we'll reopen it.",
        cta="View your request", cta_var="support_url",
        sms="{{store_name}}: {{support_request_number}} has been resolved."),

    # ----------------------------------------------------- marketing & bags
    "abandoned_cart": _event(
        "Abandoned bag reminder", "Marketing", "cart_reminders", COMMON + ["cart_url", "first_item", "item_count"],
        subject="You left something in your bag", heading="Still thinking it over?",
        body="Hello {{customer_name}}, the items you picked are still in your bag.",
        cta="Return to your bag", cta_var="cart_url",
        sms="{{store_name}}: Your bag is waiting — {{cart_url}}"),
    "campaign_message": _event(
        "Marketing campaign", "Marketing", "offers", COMMON + ["action_url", "campaign_title"],
        subject="{{campaign_title}}", heading="{{campaign_title}}", body="Hello {{customer_name}},",
        cta="Shop now", cta_var="action_url", category="marketing"),
}

SHIPMENT_EVENTS = {
    "ready-for-pickup": "shipment_created", "delivery-attempted": "delivery_attempted",
    "delivery-failed": "delivery_failed", "returned-to-origin": "shipment_returned",
}

ORDER_STAGE_EVENTS = {
    "confirmed": "order_confirmed", "processing": "order_processing", "packed": "order_packed",
    "shipped": "order_shipped", "in-transit": "order_in_transit", "out-for-delivery": "order_out_for_delivery",
    "delivered": "order_delivered", "cancelled": "order_cancelled", "returned": "order_returned",
}

RETURN_STATUS_EVENTS = {
    ("return", "requested"): "return_requested", ("replacement", "requested"): "return_requested",
    ("return", "approved"): "return_approved", ("replacement", "approved"): "replacement_initiated",
    ("return", "rejected"): "return_rejected", ("replacement", "rejected"): "return_rejected",
    ("return", "received"): "return_received", ("replacement", "received"): "return_received",
    ("replacement", "replacement-shipped"): "replacement_shipped",
    ("replacement", "completed"): "replacement_delivered",
}

SUPPORT_EVENTS = {
    "ticket_created": "support_created", "agent_replied": "support_reply", "status_changed": "support_status",
    "ticket_resolved": "support_resolved", "ticket_closed": "support_status", "ticket_reopened": "support_status",
    "ticket_assigned": "support_status",
}

CHANNELS = ("email", "sms", "whatsapp", "in_app")
GROUPS: List[str] = ["Orders", "Shipping", "Payments", "Returns", "Account", "Membership", "Support", "Marketing"]


def event(key: str) -> dict:
    return EVENTS[key]


def is_marketing(key: str) -> bool:
    return EVENTS.get(key, {}).get("category") == "marketing"
