"""
What can be tried on: capabilities, the catalogue categories mapped to them,
products' own choices, and the models that can run each capability.

A product's capability is decided in this order:

1. the product's own setting — opted out, or a capability of its own;
2. a mapping for its category *and* subcategory;
3. a mapping for its whole category;
4. otherwise none: the product has no try-on.

Whether a capability is *available* is decided separately: it must be
enabled, and at least one enabled, verified model of an enabled provider must
support it (with an adapter that can). A capability with no such model says
"not available yet", never a wrong result.
"""

from __future__ import annotations

from datetime import datetime
from typing import Dict, List, Optional, Tuple

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import (
    Category,
    Product,
    VtoCapability,
    VtoCategoryMapping,
    VtoModel,
    VtoProductSetting,
    VtoProvider,
)
from app.services.try_on import adapters

CAPABILITY_STATUSES = ("enabled", "disabled", "coming_soon")
SUBJECT_KINDS = ("half_body", "full_body", "face", "wrist", "foot", "hand")


# ------------------------------------------------------------- capabilities


def capabilities(db: Session) -> List[VtoCapability]:
    return list(db.execute(select(VtoCapability).order_by(VtoCapability.sort_order, VtoCapability.key)).scalars())


def get_capability(db: Session, key: str) -> VtoCapability:
    row = db.get(VtoCapability, (key or "")[:60])
    if row is None:
        raise NotFoundError("We couldn't find that try-on type.", error_code="CAPABILITY_NOT_FOUND")
    return row


def save_capability(db: Session, payload: dict, key: Optional[str] = None) -> VtoCapability:
    now = datetime.utcnow()
    if key:
        row = get_capability(db, key)
    else:
        new_key = str(payload.get("key") or "").strip().lower()[:60]
        if not new_key or not all(c.isalnum() or c in "._-" for c in new_key):
            raise ValidationError("Give the try-on type a key like 'eyewear.frames'.", error_code="INVALID_KEY")
        if db.get(VtoCapability, new_key) is not None:
            raise ConflictError("A try-on type with that key exists.", error_code="CAPABILITY_EXISTS")
        row = VtoCapability(key=new_key, family=new_key.split(".")[0], name=new_key, description="",
                            subject_kind="half_body", input_rules={}, guidance=[], status="disabled",
                            sort_order=100, created_at=now, updated_at=now)
    if "name" in payload:
        row.name = str(payload["name"] or "").strip()[:80] or row.name
    if "family" in payload:
        row.family = str(payload["family"] or "").strip()[:30]
    if "description" in payload:
        row.description = str(payload["description"] or "").strip()[:300]
    if "subjectKind" in payload:
        if payload["subjectKind"] not in SUBJECT_KINDS:
            raise ValidationError("Choose what the customer's photo shows.", error_code="INVALID_SUBJECT")
        row.subject_kind = payload["subjectKind"]
    if "status" in payload:
        if payload["status"] not in CAPABILITY_STATUSES:
            raise ValidationError("Status is enabled, disabled or coming soon.", error_code="INVALID_STATUS")
        row.status = payload["status"]
    if "inputRules" in payload:
        rules = payload["inputRules"] if isinstance(payload["inputRules"], dict) else {}
        clean = {}
        for name in ("minWidth", "minHeight", "maxMegapixels"):
            if rules.get(name) not in (None, ""):
                try:
                    clean[name] = max(0, min(int(rules[name]), 10000))
                except (TypeError, ValueError):
                    raise ValidationError(f"Check {name}.", error_code="INVALID_RULES") from None
        clean["portrait"] = rules.get("portrait") is True
        row.input_rules = clean
    if "guidance" in payload:
        tips = payload["guidance"] if isinstance(payload["guidance"], list) else []
        row.guidance = [str(t).strip()[:200] for t in tips if str(t).strip()][:8]
    if "sortOrder" in payload:
        try:
            row.sort_order = int(payload["sortOrder"])
        except (TypeError, ValueError):
            raise ValidationError("Check the sort order.", error_code="INVALID_SORT") from None
    row.updated_at = now
    if row not in db:
        db.add(row)
    db.flush()
    return row


# ------------------------------------------------------------------- models


def runnable_models(db: Session, capability: str, *, include_unverified: bool = False) -> List[VtoModel]:
    """Enabled (and verified) models of enabled providers whose adapter can run `capability`, best first."""
    rows = db.execute(
        select(VtoModel).join(VtoProvider, VtoProvider.id == VtoModel.provider_id)
        .where(VtoModel.enabled.is_(True), VtoProvider.enabled.is_(True))
        .order_by(VtoModel.priority, VtoModel.id)
    ).scalars().all()
    out = []
    for model in rows:
        if not include_unverified and not model.verified:
            continue
        if capability not in (model.capabilities or []):
            continue
        if not adapters.supports(model.adapter_key, capability):
            continue
        try:
            adapters.get(model.adapter_key)
        except KeyError:
            continue
        out.append(model)
    return out


def capability_states(db: Session) -> Dict[str, str]:
    """
    Each capability's state for customers:
    available | unavailable (enabled, but no model can run it now) | coming_soon | unsupported.
    """
    states = {}
    for cap in capabilities(db):
        if cap.status == "coming_soon":
            states[cap.key] = "coming_soon"
        elif cap.status != "enabled":
            states[cap.key] = "unsupported"
        else:
            models = runnable_models(db, cap.key)
            states[cap.key] = "available" if any(_has_capacity(db, m, cap.key) for m in models) else "unavailable"
    return states


def _has_capacity(db: Session, model: VtoModel, capability: str) -> bool:
    """
    Whether any credential could run this model for this capability — so a
    customer is never offered a try-on that would only fail with "no
    capacity". A model whose adapter needs no secret always can.
    """
    from datetime import datetime

    from app.models import VtoCredential

    adapter = adapters.REGISTRY.get(model.adapter_key)
    if adapter is not None and not adapter.needs_secret:
        return True
    now = datetime.utcnow()
    for credential in db.execute(select(VtoCredential).where(
            VtoCredential.provider_id == model.provider_id, VtoCredential.deleted_at.is_(None),
            VtoCredential.secret_sealed.is_not(None), VtoCredential.status.not_in(("disabled", "invalid")),
            VtoCredential.validation_status != "invalid")).scalars():
        if credential.model_ids and model.id not in credential.model_ids:
            continue
        if credential.capability_keys and capability not in credential.capability_keys:
            continue
        # Resting after a rate limit is temporary: it still counts as capacity.
        return True
    return False


# ----------------------------------------------------------------- mappings


def mappings(db: Session) -> List[VtoCategoryMapping]:
    return list(db.execute(
        select(VtoCategoryMapping).order_by(VtoCategoryMapping.category_id, VtoCategoryMapping.subcategory)
    ).scalars())


def save_mapping(db: Session, payload: dict, mapping_id: Optional[int] = None) -> VtoCategoryMapping:
    now = datetime.utcnow()
    category_id = str(payload.get("categoryId") or "").strip()[:20]
    subcategory = str(payload.get("subcategory") or "").strip().lower()[:80]
    capability = str(payload.get("capabilityKey") or "").strip()[:60]
    if mapping_id is not None:
        row = db.get(VtoCategoryMapping, mapping_id)
        if row is None:
            raise NotFoundError("We couldn't find that mapping.", error_code="MAPPING_NOT_FOUND")
        category_id = category_id or row.category_id
        if "subcategory" not in payload:
            subcategory = row.subcategory
        capability = capability or row.capability_key
    else:
        row = None
    category = db.get(Category, category_id) if category_id else None
    if category is None:
        raise ValidationError("Choose a category.", error_code="CATEGORY_REQUIRED")
    if subcategory:
        slugs = {item.get("slug") for group in (category.groups or []) if isinstance(group, dict)
                 for item in (group.get("items") or []) if isinstance(item, dict)}
        if subcategory not in slugs:
            raise ValidationError("That subcategory isn't part of the category.", error_code="SUBCATEGORY_UNKNOWN")
    get_capability(db, capability)
    clash = db.execute(select(VtoCategoryMapping).where(
        VtoCategoryMapping.category_id == category_id, VtoCategoryMapping.subcategory == subcategory)).scalar_one_or_none()
    if clash is not None and (row is None or clash.id != row.id):
        raise ConflictError("That category already has a try-on type.", error_code="MAPPING_EXISTS")
    if row is None:
        row = VtoCategoryMapping(category_id=category_id, subcategory=subcategory, capability_key=capability,
                                 enabled=True, created_at=now, updated_at=now)
        db.add(row)
    row.category_id, row.subcategory, row.capability_key = category_id, subcategory, capability
    if "enabled" in payload:
        row.enabled = payload["enabled"] is True
    row.updated_at = now
    db.flush()
    return row


def delete_mapping(db: Session, mapping_id: int) -> None:
    row = db.get(VtoCategoryMapping, mapping_id)
    if row is None:
        raise NotFoundError("We couldn't find that mapping.", error_code="MAPPING_NOT_FOUND")
    db.delete(row)
    db.flush()


# ------------------------------------------------------------ per product


def product_setting(db: Session, product_id: str) -> Optional[VtoProductSetting]:
    return db.get(VtoProductSetting, product_id)


def save_product_setting(db: Session, product_id: str, payload: dict) -> VtoProductSetting:
    if db.get(Product, product_id) is None:
        raise NotFoundError("We couldn't find that product.", error_code="PRODUCT_NOT_FOUND")
    now = datetime.utcnow()
    row = db.get(VtoProductSetting, product_id)
    if row is None:
        row = VtoProductSetting(product_id=product_id, opt_out=False, garment_image_url="", created_at=now,
                                updated_at=now)
    if "capabilityKey" in payload:
        key = payload["capabilityKey"] or None
        if key is not None:
            get_capability(db, str(key))
        row.capability_key = key
    if "optOut" in payload:
        row.opt_out = payload["optOut"] is True
    if "garmentImageUrl" in payload:
        url = str(payload["garmentImageUrl"] or "").strip()[:500]
        if url and not (url.startswith("https://") or url.startswith("http://") or url.startswith("/")):
            raise ValidationError("Use an image address starting with https://.", error_code="INVALID_URL")
        row.garment_image_url = url
    row.updated_at = now
    if row not in db:
        db.add(row)
    db.flush()
    return row


def capability_for(db: Session, product: Product) -> Tuple[Optional[str], str]:
    """(capability key or None, why) for one product."""
    setting = db.get(VtoProductSetting, product.id)
    if setting is not None:
        if setting.opt_out:
            return None, "opted_out"
        if setting.capability_key:
            return setting.capability_key, "product"
    rows = db.execute(select(VtoCategoryMapping).where(
        VtoCategoryMapping.category_id == product.category_id, VtoCategoryMapping.enabled.is_(True),
        VtoCategoryMapping.subcategory.in_([product.subcategory or "", ""]),
    )).scalars().all()
    exact = next((r for r in rows if r.subcategory and r.subcategory == (product.subcategory or "")), None)
    whole = next((r for r in rows if r.subcategory == ""), None)
    chosen = exact or whole
    return (chosen.capability_key, "subcategory" if exact else "category") if chosen else (None, "unmapped")


def garment_urls(db: Session, product: Product, color: str = "") -> List[str]:
    """The photos to try on, best first: the dedicated try-on photo, then the colour's, then any."""
    from app.models import ProductImage

    setting = db.get(VtoProductSetting, product.id)
    urls = [setting.garment_image_url] if setting and setting.garment_image_url else []
    images = db.execute(select(ProductImage).where(ProductImage.product_id == product.id)
                        .order_by(ProductImage.position, ProductImage.id)).scalars().all()
    coloured = [i.url for i in images if color and (i.color or "").lower() == color.lower()]
    plain = [i.url for i in images if not i.color]
    rest = [i.url for i in images]
    for url in coloured + plain + rest:
        if url and url not in urls:
            urls.append(url)
    return urls


def storefront_map(db: Session) -> dict:
    """What the storefront needs to badge products and offer the button, in one small document."""
    states = capability_states(db)
    caps = capabilities(db)
    slugs = dict(db.execute(select(Category.id, Category.slug)).all())
    overrides = {}
    for setting in db.execute(select(VtoProductSetting)).scalars():
        overrides[setting.product_id] = None if setting.opt_out else setting.capability_key
    return {
        "capabilities": [
            {"key": c.key, "name": c.name, "family": c.family, "description": c.description,
             "subjectKind": c.subject_kind, "state": states.get(c.key, "unsupported")}
            for c in caps
        ],
        "mappings": [
            {"category": slugs.get(m.category_id, ""), "subcategory": m.subcategory, "capability": m.capability_key}
            for m in mappings(db) if m.enabled and slugs.get(m.category_id)
        ],
        "productOverrides": {k: v for k, v in overrides.items() if v is not None or k},
    }


def eligible_products(db: Session, *, capability: str = "", category_slug: str = "", page: int = 1,
                      page_size: int = 24) -> Tuple[list, int]:
    """Published products a customer can try on now — through a mapping or their own setting."""
    from sqlalchemy import and_, false, or_

    from app.models import ProductImage
    from app.repositories.products import PUBLISHED_STATUSES

    states = capability_states(db)
    usable = {k for k, s in states.items() if s == "available" and (not capability or k == capability)}
    if not usable:
        return [], 0
    rules = []
    for m in mappings(db):
        if m.enabled and m.capability_key in usable:
            rules.append(and_(Product.category_id == m.category_id,
                              Product.subcategory == m.subcategory) if m.subcategory
                         else Product.category_id == m.category_id)
    settings = list(db.execute(select(VtoProductSetting)).scalars())
    opted_in = [s.product_id for s in settings if not s.opt_out and s.capability_key in usable]
    excluded = [s.product_id for s in settings if s.opt_out or (s.capability_key and s.capability_key not in usable)]
    condition = or_(*rules, Product.id.in_(opted_in)) if (rules or opted_in) else false()
    conditions = [Product.status.in_(PUBLISHED_STATUSES), condition]
    if excluded:
        conditions.append(Product.id.not_in(excluded))
    if category_slug:
        category = db.execute(select(Category).where(Category.slug == category_slug[:80])).scalar_one_or_none()
        if category is None:
            return [], 0
        conditions.append(Product.category_id == category.id)
    total = db.execute(select(func.count()).select_from(Product).where(*conditions)).scalar_one()
    rows = db.execute(select(Product).where(*conditions).order_by(Product.is_featured.desc(), Product.name)
                      .offset((max(page, 1) - 1) * page_size).limit(page_size)).scalars().all()
    slugs = dict(db.execute(select(Category.id, Category.slug)).all())
    out = []
    for product in rows:
        image = db.execute(select(ProductImage.url).where(ProductImage.product_id == product.id)
                           .order_by(ProductImage.position, ProductImage.id).limit(1)).scalar()
        key, _ = capability_for(db, product)
        out.append({"id": product.id, "slug": product.slug, "name": product.name, "brand": product.brand,
                    "price": float(product.price), "originalPrice": float(product.original_price),
                    "image": image, "category": slugs.get(product.category_id, ""),
                    "subcategory": product.subcategory, "capability": key})
    return out, total
