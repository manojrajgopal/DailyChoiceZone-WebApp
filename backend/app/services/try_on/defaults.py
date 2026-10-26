"""
What a new installation starts with: the try-on capabilities, the Hugging
Face provider, and the two OOTDiffusion endpoints.

Only the upper-body endpoint is enabled: it is the one proven in production
(the earlier stand-alone try-on service called `/process_hd` with exactly
these parameters). The full-body endpoint is registered for lower-body and
dress try-ons but stays disabled and unverified until someone has tested it
with real credentials. Eyewear, watches, bags, shoes and jewellery are listed
as "coming soon" with no model at all.

The migration that creates the tables inserts the same rows
(`20261010_1000_virtual_try_on.py`); `ensure(db)` adds any that are missing
— for the test database, which is built from the models.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Session

_HALF_BODY_RULES = {"minWidth": 384, "minHeight": 512, "maxMegapixels": 40, "portrait": True}
_FULL_BODY_RULES = {"minWidth": 384, "minHeight": 640, "maxMegapixels": 40, "portrait": True}

CAPABILITIES = [
    {
        "key": "garment.upper_body", "family": "garment", "name": "Tops, shirts and jackets",
        "description": "T-shirts, shirts, tops, hoodies, sweaters and jackets on a half-body photo.",
        "subject_kind": "half_body", "input_rules": _HALF_BODY_RULES, "status": "enabled", "sort_order": 10,
        "guidance": [
            "Stand facing the camera, arms slightly away from your body.",
            "Show yourself from the head to at least the hips.",
            "Plain background and even light work best.",
            "Wear fitted clothes; avoid bags, scarves and crossed arms.",
        ],
    },
    {
        "key": "garment.lower_body", "family": "garment", "name": "Trousers, jeans and skirts",
        "description": "Bottom-wear on a full-length photo.",
        "subject_kind": "full_body", "input_rules": _FULL_BODY_RULES, "status": "disabled", "sort_order": 20,
        "guidance": ["Stand facing the camera with your whole body in the photo, feet included."],
    },
    {
        "key": "garment.dress", "family": "garment", "name": "Dresses",
        "description": "Dresses and one-piece outfits on a full-length photo.",
        "subject_kind": "full_body", "input_rules": _FULL_BODY_RULES, "status": "disabled", "sort_order": 30,
        "guidance": ["Stand facing the camera with your whole body in the photo, feet included."],
    },
    {
        "key": "eyewear.frames", "family": "eyewear", "name": "Spectacles",
        "description": "Frames aligned to your face and eyes.", "subject_kind": "face",
        "input_rules": {"minWidth": 400, "minHeight": 400, "maxMegapixels": 40}, "status": "coming_soon",
        "sort_order": 40, "guidance": ["Face the camera directly, eyes open, hair away from your face."],
    },
    {
        "key": "eyewear.sunglasses", "family": "eyewear", "name": "Sunglasses",
        "description": "Sunglasses aligned to your face.", "subject_kind": "face",
        "input_rules": {"minWidth": 400, "minHeight": 400, "maxMegapixels": 40}, "status": "coming_soon",
        "sort_order": 50, "guidance": ["Face the camera directly, eyes open, hair away from your face."],
    },
    {
        "key": "wrist.watch", "family": "wrist", "name": "Watches",
        "description": "A watch placed on your wrist.", "subject_kind": "wrist",
        "input_rules": {"minWidth": 400, "minHeight": 400, "maxMegapixels": 40}, "status": "coming_soon",
        "sort_order": 60, "guidance": ["Photograph the back of your wrist, flat and well lit."],
    },
    {
        "key": "bag.carry", "family": "bag", "name": "Bags",
        "description": "A bag placed on your shoulder or in your hand.", "subject_kind": "full_body",
        "input_rules": _FULL_BODY_RULES, "status": "coming_soon", "sort_order": 70,
        "guidance": ["Stand facing the camera with your arms visible."],
    },
    {
        "key": "footwear.shoes", "family": "footwear", "name": "Shoes",
        "description": "Shoes on your feet.", "subject_kind": "foot",
        "input_rules": {"minWidth": 400, "minHeight": 400, "maxMegapixels": 40}, "status": "coming_soon",
        "sort_order": 80, "guidance": ["Photograph your feet from the side, on a plain floor."],
    },
    {
        "key": "jewellery.general", "family": "jewellery", "name": "Jewellery",
        "description": "Necklaces, earrings and rings.", "subject_kind": "face",
        "input_rules": {"minWidth": 400, "minHeight": 400, "maxMegapixels": 40}, "status": "coming_soon",
        "sort_order": 90, "guidance": [],
    },
]

PROVIDERS = [
    {
        "id": "VPR001", "kind": "huggingface", "name": "Hugging Face", "enabled": True,
        "timeout_seconds": 120, "max_retries": 2, "cooldown_seconds": 900, "config": {},
    },
]

OOTD_SPACE = "levihsu/OOTDiffusion"

MODELS = [
    {
        "id": "VMD001", "provider_id": "VPR001", "name": "OOTDiffusion · half body",
        "description": "Upper-body garments on a half-body photo (OOTDiffusion /process_hd).",
        "adapter_key": "huggingface.ootd_half_body",
        "config": {"space": OOTD_SPACE, "apiName": "/process_hd",
                   "params": {"n_samples": 1, "n_steps": 20, "image_scale": 2, "seed": -1}},
        "capabilities": ["garment.upper_body"], "quality_tier": "standard",
        "enabled": True, "verified": True, "priority": 10, "avg_seconds": 40,
    },
    {
        "id": "VMD002", "provider_id": "VPR001", "name": "OOTDiffusion · full body",
        "description": "Upper, lower and dress garments on a full-body photo (OOTDiffusion /process_dc). "
                       "Not yet verified: test it before enabling.",
        "adapter_key": "huggingface.ootd_full_body",
        "config": {"space": OOTD_SPACE, "apiName": "/process_dc",
                   "params": {"n_samples": 1, "n_steps": 20, "image_scale": 2, "seed": -1}},
        "capabilities": ["garment.lower_body", "garment.dress"], "quality_tier": "standard",
        "enabled": False, "verified": False, "priority": 20, "avg_seconds": 50,
    },
]


def ensure(db: Session) -> None:
    """Add any default row that is missing. Never changes an existing one."""
    from app.models import VtoCapability, VtoModel, VtoProvider

    now = datetime.utcnow()
    for row in CAPABILITIES:
        if db.get(VtoCapability, row["key"]) is None:
            db.add(VtoCapability(**row, created_at=now, updated_at=now))
    db.flush()
    for row in PROVIDERS:
        if db.get(VtoProvider, row["id"]) is None:
            db.add(VtoProvider(**row, health="unknown", health_detail="", created_at=now, updated_at=now))
    db.flush()
    for row in MODELS:
        if db.get(VtoModel, row["id"]) is None:
            db.add(VtoModel(**row, created_at=now, updated_at=now))
    db.flush()
