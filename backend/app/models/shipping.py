"""
Shipments, their tracking events, courier providers and courier webhooks.

See docs/shipping-and-suppliers.md. A shipment belongs to one order; an order
has at most one *active* shipment at a time (`active_key`, the order id while
active and NULL once cancelled), so a double click, a retried request or a
restart can never open a second parcel for the same order.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import BusinessId

# Paise, as in billing.
Money = BigInteger


class ShippingProvider(Base):
    """One configured courier integration, keyed by its adapter `code` (`shiprocket`, `manual`)."""

    __tablename__ = "shipping_providers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(30), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    # production | sandbox, where the courier offers both.
    environment: Mapped[str] = mapped_column(String(12), nullable=False, default="production")
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Sealed with `services.email.crypto` (Fernet). Never returned to any client.
    credentials: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # Non-secret: services, pickup location, origin address, checkout switch, default package.
    settings: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    last_tested_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_test_ok: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    last_error: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now(),
                                                 onupdate=func.now())


class Shipment(Base):
    __tablename__ = "shipments"
    __table_args__ = (
        UniqueConstraint("provider_id", "provider_shipment_id", name="uq_shipments_provider_shipment"),
        UniqueConstraint("provider_id", "awb", name="uq_shipments_provider_awb"),
        Index("ix_shipments_status_sync", "status", "next_sync_at"),
        Index("ix_shipments_retry", "request_status", "next_retry_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # The public identifier: DCZ-SH-2026-000001 (core.numbering).
    shipment_number: Mapped[str] = mapped_column(String(30), nullable=False, unique=True)
    order_id: Mapped[str] = mapped_column(BusinessId, ForeignKey("orders.id", ondelete="RESTRICT"),
                                          nullable=False, index=True)
    provider_id: Mapped[int] = mapped_column(Integer, ForeignKey("shipping_providers.id", ondelete="RESTRICT"),
                                             nullable=False, index=True)
    provider_code: Mapped[str] = mapped_column(String(30), nullable=False)
    # The order id while this shipment is active, NULL once cancelled: at most
    # one active shipment per order, enforced by the database.
    active_key: Mapped[Optional[str]] = mapped_column(String(20), nullable=True, unique=True)
    # The client's key for the create request: the same key again returns this shipment.
    idempotency_key: Mapped[Optional[str]] = mapped_column(String(80), nullable=True, unique=True)

    courier_name: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    courier_code: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    service: Mapped[str] = mapped_column(String(60), nullable=False, default="")
    provider_order_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    provider_shipment_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    awb: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    # pending | ready-for-pickup | pickup-scheduled | picked-up | in-transit | at-destination-hub |
    # out-for-delivery | delivered | delivery-attempted | delivery-failed | returned-to-origin | cancelled
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="pending", index=True)

    # Package. Entered by the team; nothing is invented when products carry no weights.
    weight_grams: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    length_cm: Mapped[Optional[float]] = mapped_column(Numeric(8, 2), nullable=True)
    width_cm: Mapped[Optional[float]] = mapped_column(Numeric(8, 2), nullable=True)
    height_cm: Mapped[Optional[float]] = mapped_column(Numeric(8, 2), nullable=True)
    package_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    package_type: Mapped[str] = mapped_column(String(30), nullable=False, default="box")
    cod: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    cod_amount: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    declared_value: Mapped[int] = mapped_column(Money, nullable=False, default=0)

    # Snapshots: the pickup address used, and the order's delivery address at the time.
    origin: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    destination: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    expected_delivery_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    label_url: Mapped[str] = mapped_column(String(1000), nullable=False, default="")
    # "" | scheduled | failed
    pickup_status: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    pickup_scheduled_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    pickup_token: Mapped[str] = mapped_column(String(64), nullable=False, default="")

    # The courier side of things: what was last asked of it and how it went.
    # ok | pending | failed
    request_status: Mapped[str] = mapped_column(String(12), nullable=False, default="pending")
    last_operation: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    last_error: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    last_error_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # Whether the last failure is worth retrying (a timeout) or not (a bad address).
    last_error_transient: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_retry_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    next_sync_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_webhook_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # Kinds of staff alert already sent for this shipment, so each goes once.
    alerts_sent: Mapped[list] = mapped_column(JSON, nullable=False, default=list)

    delivered_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    cancelled_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    cancel_reason: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    created_by: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now(),
                                                 onupdate=func.now())

    events: Mapped[List["ShipmentEvent"]] = relationship(
        back_populates="shipment", cascade="all, delete-orphan", order_by="ShipmentEvent.occurred_at",
    )
    provider: Mapped["ShippingProvider"] = relationship()


class ShipmentEvent(Base):
    """One tracking update. Unique per shipment by `dedupe_key`, so a repeated webhook or poll adds nothing."""

    __tablename__ = "shipment_events"
    __table_args__ = (UniqueConstraint("shipment_id", "dedupe_key", name="uq_shipment_events_dedupe"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    shipment_id: Mapped[int] = mapped_column(Integer, ForeignKey("shipments.id", ondelete="CASCADE"),
                                             nullable=False, index=True)
    # The normalised status, or "" when the courier sent something we don't recognise.
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="")
    provider_status: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    description: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    location: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    # webhook | poll | admin | system
    source: Mapped[str] = mapped_column(String(12), nullable=False, default="system")
    actor: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    # Shown to the customer. Internal entries (a failed label request) are not.
    visible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    dedupe_key: Mapped[str] = mapped_column(String(80), nullable=False)

    shipment: Mapped["Shipment"] = relationship(back_populates="events")


class ShippingWebhookEvent(Base):
    """Every courier webhook delivery: for de-duplication, safe retries and debugging."""

    __tablename__ = "shipping_webhook_events"
    __table_args__ = (UniqueConstraint("provider_code", "event_key", name="uq_shipping_webhook_events_key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    provider_code: Mapped[str] = mapped_column(String(30), nullable=False)
    event_key: Mapped[str] = mapped_column(String(80), nullable=False)
    shipment_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("shipments.id", ondelete="SET NULL"),
                                                       nullable=True, index=True)
    # processed | ignored | failed | duplicate
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="processed", index=True)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    last_error: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    # Courier fields only (AWB, status, scans), never the customer's contact details.
    payload: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    received_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    processed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
