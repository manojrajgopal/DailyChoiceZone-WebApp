"""
Payment reconciliation: what comparing our records with the gateway found.

One row per payment (ours, or one the gateway has that we don't), updated in
place on every check — so re-running a reconciliation never piles up
duplicates. **Nothing here changes a financial record.** A discrepancy is
recorded and reviewed; resolving it is an explicit action with a note, and
every action lands in `PaymentReconciliationEvent`.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import JSON, BigInteger, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import BusinessId


class PaymentReconciliation(Base):
    __tablename__ = "payment_reconciliations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    payment_id: Mapped[Optional[str]] = mapped_column(
        BusinessId, ForeignKey("payments.id", ondelete="SET NULL"), nullable=True, unique=True
    )
    gateway_payment_id: Mapped[Optional[str]] = mapped_column(String(60), nullable=True, unique=True)
    order_id: Mapped[Optional[str]] = mapped_column(
        BusinessId, ForeignKey("orders.id", ondelete="SET NULL"), nullable=True
    )
    order_number: Mapped[str] = mapped_column(String(30), nullable=False, default="")
    # matched | mismatch | missing-locally | missing-externally | requires-review
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    # Machine codes, e.g. ["amount-mismatch", "refund-mismatch"].
    issues: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    summary: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    local: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    gateway: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    amount: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="INR")
    paid_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    checked_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    check_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    check_error: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    # open | resolved
    resolution: Mapped[str] = mapped_column(String(20), nullable=False, default="open")
    resolved_by: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    resolution_note: Mapped[str] = mapped_column(String(1000), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    events: Mapped[List["PaymentReconciliationEvent"]] = relationship(
        back_populates="reconciliation", cascade="all, delete-orphan",
        order_by="PaymentReconciliationEvent.id",
    )


class PaymentReconciliationEvent(Base):
    """The audit trail: every check and every review action."""

    __tablename__ = "payment_reconciliation_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    reconciliation_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("payment_reconciliations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # checked | status | resolved | reopened | note
    action: Mapped[str] = mapped_column(String(20), nullable=False)
    from_value: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    to_value: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    note: Mapped[str] = mapped_column(String(1000), nullable=False, default="")
    admin_id: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    admin_name: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    reconciliation: Mapped[PaymentReconciliation] = relationship(back_populates="events")
