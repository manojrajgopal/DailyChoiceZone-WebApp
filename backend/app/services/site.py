"""Storefront chrome: site config, homepage composition and banners."""

from __future__ import annotations

from datetime import datetime
from typing import List

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Banner, HomepageSection, SettingDocument
from app.services import billing


def _document(db: Session, key: str) -> dict:
    row = db.get(SettingDocument, key)
    return (row.value if row else {}) or {}


def content(db: Session) -> dict:
    """
    Everything the two applications used to hardcode.

    The states a delivery address can name, the topics the contact form
    offers, the delivery and payment methods, the FAQ, the size charts, the
    sort orders, and the vocabularies the portal's dropdowns are built from.

    One document rather than an endpoint each: they are all read once when a
    page loads, none of them is large, and a dozen tiny endpoints would be a
    dozen round trips to render one form.

    The commercial figures inside it are re-pointed at store settings on the
    way out, for the same reason `site_config` does it — a delivery fee quoted
    from one place and charged from another is two numbers that will disagree.
    """
    document = _document(db, "content")
    shipping = (billing.store_settings(db).get("shipping") or {})
    enabled = set((billing.billing_config(db).get("payment") or {}).get("enabledMethods") or [])

    methods = []
    for method in document.get("deliveryMethods", []):
        fee = shipping.get("standardFee") if method.get("id") == "standard" else shipping.get("expressFee")
        estimate = (
            shipping.get("standardEstimate")
            if method.get("id") == "standard"
            else shipping.get("expressEstimate")
        )
        methods.append({
            **method,
            "fee": fee if fee is not None else method.get("fee", 0),
            "estimate": estimate or method.get("estimate", ""),
        })

    return {
        **document,
        "deliveryMethods": methods,
        # Every method the store knows about, so the settings page can offer
        # each as a toggle — and separately, the ids currently switched on, so
        # the checkout can show only those. One list filtered here would leave
        # the portal unable to turn anything back on.
        "enabledPaymentMethods": sorted(enabled) if enabled else
            [method.get("id") for method in document.get("paymentMethods", [])],
    }


def navigation(db: Session) -> list:
    """The storefront's menu, as an ordered tree."""
    return _document(db, "navigation").get("items", [])


# Sections added after the sidebar document was first saved. Each is placed
# after its anchor in what is served, when the saved menu lacks it; the saved
# document itself is left as it is.
ADDED_NAV_ITEMS = [
    ("/admin/orders", {"id": "returns", "label": "Returns", "href": "/admin/returns",
                       "icon": "refunds", "badge": "openReturns"}),
    ("/admin/customers", {"id": "membership", "label": "Membership", "href": "/admin/membership",
                          "icon": "customers"}),
    ("/admin/settings/billing", {"id": "email", "label": "Email", "href": "/admin/settings/email",
                                 "icon": "content"}),
    ("/admin/returns", {"id": "support", "label": "Support", "href": "/admin/support",
                        "icon": "support", "badge": "openTickets"}),
    ("/admin/settings/email", {"id": "support-settings", "label": "Support setup",
                               "href": "/admin/support/settings", "icon": "settings"}),
    ("/admin/membership", {"id": "abandoned-carts", "label": "Abandoned carts", "href": "/admin/carts",
                           "icon": "carts"}),
    ("/admin/inventory", {"id": "pincodes", "label": "Delivery pincodes", "href": "/admin/delivery",
                          "icon": "delivery"}),
    ("/admin/billing", {"id": "reconciliation", "label": "Reconciliation", "href": "/admin/payments/reconciliation",
                        "icon": "reconciliation"}),
    ("/admin/payments/reconciliation", {"id": "webhooks", "label": "Payment webhooks",
                                        "href": "/admin/payments/webhooks", "icon": "webhooks"}),
    ("/admin/delivery", {"id": "alerts", "label": "Stock & price alerts", "href": "/admin/alerts",
                         "icon": "alerts"}),
    ("/admin/reviews", {"id": "questions", "label": "Questions", "href": "/admin/questions",
                        "icon": "questions", "badge": "pendingQuestions"}),
    ("/admin/carts", {"id": "gift-cards", "label": "Gift cards", "href": "/admin/gift-cards",
                                       "icon": "giftCards"}),
    ("/admin/gift-cards", {"id": "store-credit", "label": "Store credit", "href": "/admin/store-credit",
                           "icon": "storeCredit"}),
    ("/admin/store-credit", {"id": "loyalty", "label": "Reward points", "href": "/admin/loyalty",
                             "icon": "loyalty"}),
]


def admin_navigation(db: Session) -> list:
    """The portal's sidebar, grouped, with any newer sections added."""
    groups = _document(db, "admin_navigation").get("groups", [])
    for anchor, entry in ADDED_NAV_ITEMS:
        hrefs = {item.get("href") for group in groups for item in group.get("items", [])}
        if entry["href"] in hrefs:
            continue
        placed = False
        for group in groups:
            items = group.get("items", [])
            at = next((i for i, item in enumerate(items) if item.get("href") == anchor), None)
            if at is not None:
                group["items"] = items[: at + 1] + [dict(entry)] + items[at + 1 :]
                placed = True
                break
        if not placed and groups:
            groups[-1]["items"] = groups[-1].get("items", []) + [dict(entry)]
    return groups


def site_config(db: Session) -> dict:
    """
    What the header, footer and delivery copy read.

    The commercial numbers come from store settings rather than the site
    document, so the delivery threshold a customer is quoted is the one the
    cart actually prices against. Two copies of that number is two numbers that
    disagree.
    """
    site = (db.get(SettingDocument, "site") or SettingDocument(key="site", value={})).value or {}
    settings = billing.store_settings(db)

    general = settings.get("general", {})
    contact = settings.get("contact", {})
    shipping = settings.get("shipping", {})
    returns = settings.get("returns", {})
    social = settings.get("social", {})

    merged = dict(site)
    merged.update(
        {
            "name": general.get("storeName", site.get("name", "")),
            "tagline": general.get("tagline", site.get("tagline", "")),
            "description": general.get("description", site.get("description", "")),
            "support": {
                "email": contact.get("email", ""),
                "phone": contact.get("phone", ""),
                "hours": contact.get("supportHours", ""),
            },
            "freeDeliveryThreshold": shipping.get("freeDeliveryThreshold", 999),
            "standardDeliveryFee": shipping.get("standardFee", 79),
            "returnWindowDays": returns.get("windowDays", 15),
        }
    )

    # Re-point the configured social links, keeping each one's label and icon:
    # settings hold addresses, not presentation.
    by_label = {
        "instagram": social.get("instagram"),
        "facebook": social.get("facebook"),
        "youtube": social.get("youtube"),
    }
    merged["social"] = [
        {**link, "href": by_label.get(link.get("label", "").lower()) or link.get("href", "")}
        for link in site.get("social", [])
        if (by_label.get(link.get("label", "").lower()) or link.get("href"))
    ]

    return merged


def homepage_sections(db: Session, *, active_only: bool = True) -> List[HomepageSection]:
    statement = select(HomepageSection).order_by(HomepageSection.display_order)
    if active_only:
        statement = statement.where(HomepageSection.active.is_(True))
    return list(db.execute(statement).scalars().all())


def section_to_dict(section: HomepageSection) -> dict:
    """The renderer's shape: the definition, flattened, plus its editorial state."""
    payload = {
        "id": section.id,
        "type": section.type,
        "title": section.title,
        "subtitle": section.subtitle,
        "source": section.source,
        "limit": section.item_limit,
        "active": section.active,
        "displayOrder": section.display_order,
    }
    payload.update(section.config or {})
    return payload


def live_banners(db: Session, now: datetime | None = None) -> List[Banner]:
    """
    The promotional strip.

    A banner is live when it is switched on and inside its dates, evaluated at
    read time — so one starts and stops on its own without anyone touching it.
    """
    now = now or datetime.utcnow()
    return list(
        db.execute(
            select(Banner)
            .where(
                Banner.active.is_(True),
                Banner.starts_at <= now,
                (Banner.ends_at.is_(None)) | (Banner.ends_at >= now),
            )
            .order_by(Banner.display_order)
        ).scalars().all()
    )
