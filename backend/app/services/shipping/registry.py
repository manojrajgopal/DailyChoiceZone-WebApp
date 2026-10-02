"""
Which couriers exist, and building an adapter from a saved configuration.

Adding a courier is one module implementing `ShippingProvider` and one entry
in `ADAPTERS`. Nothing else changes.
"""

from __future__ import annotations

from typing import Dict, Optional, Tuple, Type

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import AppError, NotFoundError
from app.models.shipping import ShippingProvider as ProviderRow
from app.services.email import crypto
from app.services.shipping.base import ShippingProvider
from app.services.shipping.manual import ManualProvider
from app.services.shipping.shiprocket import ShiprocketProvider

ADAPTERS: Dict[str, Type[ShippingProvider]] = {
    ShiprocketProvider.code: ShiprocketProvider,
    ManualProvider.code: ManualProvider,
}


class ProviderInactive(AppError):
    status_code = 400
    error_code = "PROVIDER_INACTIVE"


def adapter_class(code: str) -> Optional[Type[ShippingProvider]]:
    return ADAPTERS.get((code or "").strip().lower())


def credentials_of(row: Optional[ProviderRow]) -> dict:
    if row is None or not row.credentials:
        return {}
    values = crypto.unseal(row.credentials)
    return values if isinstance(values, dict) else {}


def adapter_for(code: str, row: Optional[ProviderRow] = None, *, timeout: Optional[float] = None) -> ShippingProvider:
    """The adapter for `code`, configured from its saved row (or unconfigured when there is none)."""
    cls = adapter_class(code)
    if cls is None:
        raise NotFoundError(f"There is no courier integration called '{code}'.", error_code="PROVIDER_NOT_FOUND")
    return cls(config=dict((row.settings if row is not None else None) or {}), credentials=credentials_of(row),
               environment=(row.environment if row is not None else "production") or "production", timeout=timeout)


def row_for(db: Session, code: str) -> Optional[ProviderRow]:
    return db.execute(select(ProviderRow).where(ProviderRow.code == (code or "").strip().lower())).scalar_one_or_none()


def active_provider(db: Session, code: str) -> Tuple[ProviderRow, ShippingProvider]:
    """The saved, active provider `code` and its adapter. 400 PROVIDER_INACTIVE otherwise."""
    cls = adapter_class(code)
    row = row_for(db, code) if cls is not None else None
    if cls is None or row is None or not row.active:
        raise ProviderInactive("That courier isn't switched on. Activate it in Settings, Couriers.")
    return row, adapter_for(code, row)


def default_row(db: Session) -> Optional[ProviderRow]:
    return db.execute(
        select(ProviderRow).where(ProviderRow.is_default.is_(True), ProviderRow.active.is_(True))
    ).scalars().first()


def active_rows(db: Session) -> list:
    rows = db.execute(select(ProviderRow).where(ProviderRow.active.is_(True)).order_by(ProviderRow.id)).scalars()
    return [row for row in rows if adapter_class(row.code) is not None]
