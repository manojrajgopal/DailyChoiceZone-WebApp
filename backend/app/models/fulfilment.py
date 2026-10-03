"""
Packing (picking and packing an order in the warehouse) and shipping labels.

See docs/packing-and-labels.md.

- A **packing job** belongs to one order; an order has at most one *active*
  job (`active_key`, the order id until the job is cancelled), the same
  pattern as shipments. Its lines are the order's lines, with what has been
  picked and any problem found on the shelf.
- A job's **packages** are the boxes the order leaves in, each with its own
  number (DCZ-PKG-2026-000001), measurements and contents. A package is never
  deleted: removing one stamps `removed_at`, so its number is never reused and
  the record of it stays.
- A **shipping label** is one version of a shipment's label. The data it
  prints is frozen in `snapshot` when it is generated, and the PDF is drawn
  from that snapshot on request, so an old version reads exactly as it was
  printed and no file is stored anywhere.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import (
    JSON,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import BusinessId


class PackingJob(Base):
    __tablename__ = "packing_jobs"
    __table_args__ = (Index("ix_packing_jobs_status_priority", "status", "priority"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_id: Mapped[str] = mapped_column(BusinessId, ForeignKey("orders.id", ondelete="RESTRICT"),
                                          nullable=False, index=True)
    # The order id while this job is open, NULL once cancelled: at most one
    # active job per order, enforced by the database.
    active_key: Mapped[Optional[str]] = mapped_column(String(20), nullable=True, unique=True)
    # pending | picking | picked | packing | packed | ready-to-ship | cancelled
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending", index=True)
    # normal | high | urgent
    priority: Mapped[str] = mapped_column(String(10), nullable=False, default="normal")
    assigned_to: Mapped[Optional[str]] = mapped_column(BusinessId, ForeignKey("admin_users.id", ondelete="SET NULL"),
                                                       nullable=True, index=True)
    assigned_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # The shipment the packages were handed to (ready to ship).
    shipment_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("shipments.id", ondelete="SET NULL"),
                                                       nullable=True, index=True)

    picking_started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    picked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    packing_started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    packed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    packed_by: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    ready_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    cancelled_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # Why picking was completed, or the order packed, despite a recorded problem.
    pick_override_reason: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    pack_override_reason: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    notes: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now(),
                                                 onupdate=func.now())

    lines: Mapped[List["PackingLine"]] = relationship(
        back_populates="job", cascade="all, delete-orphan", order_by="PackingLine.id",
    )
    packages: Mapped[List["PackingPackage"]] = relationship(
        back_populates="job", cascade="all, delete-orphan", order_by="PackingPackage.id",
    )


class PackingLine(Base):
    """One order line as the picker sees it. Picking never changes stock: it was taken at the sale."""

    __tablename__ = "packing_lines"
    __table_args__ = (UniqueConstraint("job_id", "order_item_id", name="uq_packing_lines_item"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[int] = mapped_column(Integer, ForeignKey("packing_jobs.id", ondelete="CASCADE"),
                                        nullable=False, index=True)
    order_item_id: Mapped[int] = mapped_column(Integer, ForeignKey("order_items.id", ondelete="CASCADE"),
                                               nullable=False, index=True)
    # Copied from the order line when the job is made.
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    picked_qty: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    picked_by: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    picked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # "" | missing-stock | damaged | wrong-item
    exception: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    exception_qty: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    exception_note: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    exception_by: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    exception_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # Units written off through the stock ledger (reason "damaged") from this line.
    damaged_recorded_qty: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    job: Mapped["PackingJob"] = relationship(back_populates="lines")


class PackingPackage(Base):
    __tablename__ = "packing_packages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[int] = mapped_column(Integer, ForeignKey("packing_jobs.id", ondelete="CASCADE"),
                                        nullable=False, index=True)
    # DCZ-PKG-2026-000001 (core.numbering).
    package_number: Mapped[str] = mapped_column(String(30), nullable=False, unique=True)
    weight_grams: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    length_cm: Mapped[Optional[float]] = mapped_column(Numeric(8, 2), nullable=True)
    width_cm: Mapped[Optional[float]] = mapped_column(Numeric(8, 2), nullable=True)
    height_cm: Mapped[Optional[float]] = mapped_column(Numeric(8, 2), nullable=True)
    package_type: Mapped[str] = mapped_column(String(30), nullable=False, default="box")
    notes: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    packed_by: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    packed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    shipment_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("shipments.id", ondelete="SET NULL"),
                                                       nullable=True, index=True)
    # Set instead of deleting, so a number is never reused and the history stays.
    removed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_by: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now(),
                                                 onupdate=func.now())

    job: Mapped["PackingJob"] = relationship(back_populates="packages")
    items: Mapped[List["PackingPackageItem"]] = relationship(
        back_populates="package", cascade="all, delete-orphan", order_by="PackingPackageItem.id",
    )


class PackingPackageItem(Base):
    """How many of one line are in one package."""

    __tablename__ = "packing_package_items"
    __table_args__ = (UniqueConstraint("package_id", "line_id", name="uq_packing_package_items_line"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    package_id: Mapped[int] = mapped_column(Integer, ForeignKey("packing_packages.id", ondelete="CASCADE"),
                                            nullable=False, index=True)
    line_id: Mapped[int] = mapped_column(Integer, ForeignKey("packing_lines.id", ondelete="CASCADE"),
                                         nullable=False, index=True)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    package: Mapped["PackingPackage"] = relationship(back_populates="items")


class PackingEvent(Base):
    """Every action on a job, in order: who, what, from which status to which, and why."""

    __tablename__ = "packing_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[int] = mapped_column(Integer, ForeignKey("packing_jobs.id", ondelete="CASCADE"),
                                        nullable=False, index=True)
    action: Mapped[str] = mapped_column(String(30), nullable=False)
    from_status: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    to_status: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    note: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    details: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    actor: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class ShippingLabel(Base):
    """
    One version of a shipment's label. A shipment has at most one *current*
    label (`current_key`, the shipment id while generated); regenerating marks
    the old one `regenerated` and adds the next version.
    """

    __tablename__ = "shipping_labels"
    __table_args__ = (
        UniqueConstraint("shipment_id", "version", name="uq_shipping_labels_version"),
        Index("ix_shipping_labels_status_generated", "status", "generated_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    shipment_id: Mapped[int] = mapped_column(Integer, ForeignKey("shipments.id", ondelete="CASCADE"),
                                             nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    current_key: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, unique=True)
    # generating | generated | failed | regenerated | cancelled
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="generating")
    # A key of `label_pdf.FORMATS`: a4 | thermal-4x6 | standard
    format: Mapped[str] = mapped_column(String(20), nullable=False, default="thermal-4x6")
    # Everything the label prints, frozen at generation: seller, buyer,
    # shipment, packages, items, COD. Never edited afterwards.
    snapshot: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    page_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    generated_by: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    generated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # Why this version replaced the one before it.
    reason: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    # The courier's own label, when it has one: its reference and link.
    provider_reference: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    external_url: Mapped[str] = mapped_column(String(1000), nullable=False, default="")
    error_message: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    error_code: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    superseded_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    cancelled_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    cancel_reason: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now(),
                                                 onupdate=func.now())
