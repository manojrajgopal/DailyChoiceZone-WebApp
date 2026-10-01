"""
The audit trail, storefront analytics events, background-job heartbeats and
health-check history.

`AuditLog` rows are written only by the server, in `services.audit`, and are
never changed or removed: there is no endpoint that edits them, and the
session refuses to flush an update or a delete of one (see `services.audit`).
Nothing secret is stored — values are redacted before they are written.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import JSON, BigInteger, DateTime, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import BusinessId


class AuditLog(Base):
    """
    One thing someone did. actor_type: admin | customer | system | anonymous.
    outcome: success | failure | denied.
    """

    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("ix_audit_logs_occurred", "occurred_at"),
        Index("ix_audit_logs_actor", "actor_id", "occurred_at"),
        Index("ix_audit_logs_resource", "resource_type", "resource_id"),
        Index("ix_audit_logs_action", "action", "occurred_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True,
                                    autoincrement=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    actor_type: Mapped[str] = mapped_column(String(20), nullable=False, default="admin")
    actor_id: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True)
    actor_name: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    actor_email: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    actor_role: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    action: Mapped[str] = mapped_column(String(80), nullable=False)
    resource_type: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    resource_id: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    summary: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    outcome: Mapped[str] = mapped_column(String(20), nullable=False, default="success")
    status_code: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    error_code: Mapped[str] = mapped_column(String(60), nullable=False, default="")
    # {"field": {"from": ..., "to": ...}}, redacted.
    changes: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    # Method, route and other context, redacted.
    details: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    ip_address: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    user_agent: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    request_id: Mapped[str] = mapped_column(String(40), nullable=False, default="", index=True)


class AnalyticsEvent(Base):
    """
    A storefront event the order tables can't tell us: a visit, a product
    viewed, a bag added to, checkout opened. Sales, payments and customers are
    read from their own tables, never from here.

    `visitor_id` is a hash of the browser's random visitor id (or of the
    customer id when signed in), never anything that identifies a person.
    """

    __tablename__ = "analytics_events"
    __table_args__ = (
        Index("ix_analytics_events_kind_time", "event", "occurred_at"),
        Index("ix_analytics_events_product", "product_id", "event", "occurred_at"),
        Index("ix_analytics_events_visitor", "visitor_id", "event", "occurred_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True,
                                    autoincrement=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    # visit | product_view | add_to_cart | checkout_start
    event: Mapped[str] = mapped_column(String(30), nullable=False)
    visitor_id: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    customer_id: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True, index=True)
    product_id: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Where the visit came from: a utm_source, or the referring site's host.
    source: Mapped[str] = mapped_column(String(60), nullable=False, default="")
    # mobile | tablet | desktop
    device: Mapped[str] = mapped_column(String(10), nullable=False, default="")


class JobHeartbeat(Base):
    """The last run of one background job, so health checks can tell a stalled one."""

    __tablename__ = "job_heartbeats"

    name: Mapped[str] = mapped_column(String(60), primary_key=True)
    interval_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=60)
    last_started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_success_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_error: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    last_error_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_duration_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    runs: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failures: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    consecutive_failures: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class HealthSnapshot(Base):
    """A full health check, kept for the history chart. status: healthy | degraded | unhealthy | unknown."""

    __tablename__ = "health_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    checked_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    # {component: {"status", "message", "latencyMs"}} — no secrets.
    checks: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    duration_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
