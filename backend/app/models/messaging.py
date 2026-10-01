"""
Notifications on every channel, marketing campaigns, reorders and database
backups.

## Notifications

A `NotificationDelivery` is one message to one recipient on one channel —
an email, an SMS, a WhatsApp message or an in-app note. Each carries an
idempotency key, unique in the database, so the same event can never queue
the same message twice, and a retry updates the row rather than adding one.
Emails keep their own detailed `email_log` as before; a delivery row records
them alongside the other channels for the unified history and for retries.

`NotificationTemplate` holds the store's own wording for an event, per
channel, overriding the built-in default. `ChannelPreference` is a customer's
consent per channel and category — marketing is opt-in, and transactional
messages never depend on it.

## Campaigns

A `MarketingCampaign` is launched once (`launch_key`), and its recipients are
`CampaignRecipient` rows unique per campaign, customer and channel — so a
restart halfway through a send resumes it without sending anyone a message
twice.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import BusinessId

# ------------------------------------------------------------ notifications


class NotificationDelivery(Base):
    """
    channel: email | sms | whatsapp | in_app
    category: transactional | marketing
    status: queued | sending | sent | delivered | read | failed (will retry) |
            dead (gave up) | skipped (not sent, with the reason)
    """

    __tablename__ = "notification_deliveries"
    __table_args__ = (
        Index("ix_notification_deliveries_due", "status", "next_attempt_at"),
        Index("ix_notification_deliveries_created", "created_at"),
        Index("ix_notification_deliveries_customer", "customer_id", "created_at"),
        Index("ix_notification_deliveries_event", "event", "created_at"),
        Index("ix_notification_deliveries_provider_ref", "provider_message_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    idempotency_key: Mapped[str] = mapped_column(String(160), nullable=False, unique=True)
    event: Mapped[str] = mapped_column(String(60), nullable=False)
    channel: Mapped[str] = mapped_column(String(12), nullable=False)
    category: Mapped[str] = mapped_column(String(15), nullable=False, default="transactional")
    customer_id: Mapped[Optional[str]] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="SET NULL"), nullable=True
    )
    # An email address or a phone number in E.164 form.
    recipient: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    template_key: Mapped[str] = mapped_column(String(60), nullable=False, default="")
    provider: Mapped[str] = mapped_column(String(30), nullable=False, default="")
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="queued")
    # What is sent: the rendered text, a WhatsApp template and its variables.
    # Never credentials. Cleared once sent, for messages carrying a sign-in link.
    payload: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=5)
    next_attempt_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_error: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    provider_message_id: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    campaign_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("marketing_campaigns.id", ondelete="SET NULL"), nullable=True, index=True
    )
    reference: Mapped[str] = mapped_column(String(60), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    sent_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    delivered_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    failed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class NotificationTemplate(Base):
    """The store's own wording for one event. Empty fields fall back to the built-in default."""

    __tablename__ = "notification_templates"

    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="1")
    email_subject: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    email_heading: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    email_body: Mapped[str] = mapped_column(Text, nullable=False)
    email_cta_label: Mapped[str] = mapped_column(String(60), nullable=False, default="")
    sms_text: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    whatsapp_template: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    whatsapp_language: Mapped[str] = mapped_column(String(12), nullable=False, default="en")
    # Variable names, in the order the approved WhatsApp template expects them.
    whatsapp_variables: Mapped[list] = mapped_column(JSON, nullable=False)
    in_app_title: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    in_app_body: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    updated_by: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class ChannelPreference(Base):
    """A customer's consent for one channel and category. No row: the default for that pair."""

    __tablename__ = "channel_preferences"

    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), primary_key=True
    )
    channel: Mapped[str] = mapped_column(String(12), primary_key=True)
    category: Mapped[str] = mapped_column(String(15), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    # account | signup | unsubscribe-link | admin
    source: Mapped[str] = mapped_column(String(20), nullable=False, default="account")
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


# -------------------------------------------------------------- campaigns


class MarketingCampaign(Base):
    """
    status: draft | scheduled | sending | sent | cancelled | failed
    channels: ["email", "sms", "whatsapp", "in_app"]
    """

    __tablename__ = "marketing_campaigns"
    __table_args__ = (Index("ix_marketing_campaigns_due", "status", "scheduled_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    kind: Mapped[str] = mapped_column(String(30), nullable=False, default="promotional")
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="draft")
    channels: Mapped[list] = mapped_column(JSON, nullable=False)
    audience: Mapped[dict] = mapped_column(JSON, nullable=False)
    content: Mapped[dict] = mapped_column(JSON, nullable=False)
    # Orders using this code count towards the campaign's revenue.
    coupon_code: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    starts_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    ends_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    scheduled_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # Set once, on launch: a second launch of the same campaign is refused.
    launch_key: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, unique=True)
    launched_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    launched_by: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    content_updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    tested_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    recipients_total: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_error: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    created_by: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class CampaignRecipient(Base):
    """One customer on one channel of a campaign. status mirrors its delivery."""

    __tablename__ = "campaign_recipients"
    __table_args__ = (
        UniqueConstraint("campaign_id", "customer_id", "channel", name="uq_campaign_recipient"),
        Index("ix_campaign_recipients_status", "campaign_id", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    campaign_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("marketing_campaigns.id", ondelete="CASCADE"), nullable=False
    )
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    channel: Mapped[str] = mapped_column(String(12), nullable=False)
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="queued")
    # Random, for open and click tracking links. Says nothing about the customer.
    token: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    delivery_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True, index=True)
    opened_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    clicked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    unsubscribed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    replied_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


# ---------------------------------------------------------------- reorders


class ReorderEvent(Base):
    """A customer putting a past order's items back in their bag."""

    __tablename__ = "reorder_events"
    __table_args__ = (Index("ix_reorder_events_customer", "customer_id", "created_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False
    )
    order_id: Mapped[str] = mapped_column(BusinessId, ForeignKey("orders.id", ondelete="CASCADE"), nullable=False,
                                          index=True)
    items_requested: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    items_added: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # [{"productId", "quantity", "added", "reason"}]
    items: Mapped[list] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)


# ----------------------------------------------------------------- backups


class DatabaseBackup(Base):
    """
    status: running | succeeded | failed | deleted
    tier: daily | weekly | manual — which retention rule keeps it
    """

    __tablename__ = "database_backups"
    __table_args__ = (Index("ix_database_backups_status", "status", "started_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    reference: Mapped[str] = mapped_column(String(40), nullable=False, unique=True)
    trigger: Mapped[str] = mapped_column(String(12), nullable=False, default="scheduled")
    tier: Mapped[str] = mapped_column(String(10), nullable=False, default="daily")
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="running")
    database_name: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    storage: Mapped[str] = mapped_column(String(10), nullable=False, default="local")
    # A key within the storage (never a public URL).
    location: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    checksum_sha256: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    encrypted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    tables: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rows: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    verified_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    error: Mapped[str] = mapped_column(String(1000), nullable=False, default="")
    started_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_by: Mapped[Optional[str]] = mapped_column(BusinessId, nullable=True)
