"""Storefront chrome."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.services import billing, site as service
from app.utils.response import ok, ok_list

router = APIRouter(prefix="/site", tags=["Site"])


@router.get("/config", summary="Brand, support details and delivery thresholds")
def get_config(db: Session = Depends(get_db)):
    return ok(service.site_config(db))


@router.get("/homepage", summary="Homepage sections, in order")
def get_homepage(db: Session = Depends(get_db)):
    """
    Only the live ones, already sorted.

    Which sections run and where they sit is editorial state an administrator
    changes; the renderer maps `source` to a merchandising query and needs to
    know nothing else.
    """
    sections = service.homepage_sections(db, active_only=True)
    return ok({"sections": [service.section_to_dict(section) for section in sections]})


@router.get("/banners", summary="The promotional strip")
def get_banners(db: Session = Depends(get_db)):
    banners = service.live_banners(db)
    return ok_list(
        [
            {"id": banner.id, "message": banner.title, "href": banner.button_link or None}
            for banner in banners
        ]
    )


@router.get("/billing-config", summary="Seller details and document wording")
def get_billing_config(db: Session = Depends(get_db)):
    """
    The presentational half of the billing configuration.

    Public because it is printed on every invoice a customer downloads — the
    legal name, the registered address, the payment terms. Nothing here is a
    secret; the amounts, the numbering and the tax are all decided server-side
    regardless of what this says.
    """
    return ok(billing.billing_config(db))


@router.get("/tax-config", summary="GST registration and rates")
def get_tax_config(db: Session = Depends(get_db)):
    """
    The rates and the GSTIN.

    Also public, and for the same reason: a GST invoice has to show the
    supplier's registration number and the rate applied to each line. This
    endpoint is what puts them on the document; it is not what calculates them.
    """
    return ok(billing.tax_config(db))
