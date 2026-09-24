"""Storefront chrome: site config, homepage composition and banners."""

from __future__ import annotations

from datetime import datetime
from typing import List

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Banner, HomepageSection, SettingDocument
from app.services import billing


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
