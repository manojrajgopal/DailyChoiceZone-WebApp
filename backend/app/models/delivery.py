"""
Where the store delivers.

A row per pincode the store has decided about, managed in the portal — never a
bundled list of real-world coverage, which the store doesn't have. Whether an
unlisted pincode is deliverable is a setting (`serviceability` document), so a
store can start with an empty table and restrict delivery later.

`courier` is kept for a future courier integration: the table already says
whose network covers each pincode, so plugging one in won't need a new model.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, Boolean, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class DeliveryPincode(Base):
    __tablename__ = "delivery_pincodes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    pincode: Mapped[str] = mapped_column(String(6), nullable=False, unique=True)
    city: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    district: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    state: Mapped[str] = mapped_column(String(120), nullable=False, default="", index=True)
    serviceable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    cod_available: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    express_available: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    min_days: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    max_days: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # Minor units. NULL means the store's standard fee applies.
    delivery_fee: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    courier: Mapped[str] = mapped_column(String(60), nullable=False, default="")
    notes: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
