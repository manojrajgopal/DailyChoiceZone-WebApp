"""
Virtual try-on (docs/virtual-try-on.md).

The feature is built from capabilities, not from clothing:

- a **capability** is one kind of try-on (`garment.upper_body`,
  `eyewear.frames`, `wrist.watch`…) with its own photo requirements;
- catalogue categories (and subcategories) are **mapped** to a capability;
  a product can override or opt out;
- a **model** is one AI endpoint, run by a provider **adapter** in code, that
  supports some capabilities;
- a **credential** is an encrypted provider secret, usable for some models,
  shared by eligible customers or dedicated to one;
- a **request** is one generation, queued and run by the worker, with each
  provider call recorded as an **attempt** and its quota in the **usage**
  ledger.

Images are never stored here: rows hold object keys and retention only.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import BusinessId, TimestampMixin


class VtoCapability(Base, TimestampMixin):
    """One kind of try-on, and what its photos must look like."""

    __tablename__ = "vto_capabilities"

    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    # garment | eyewear | wrist | bag | footwear | jewellery | … (free text, for grouping)
    family: Mapped[str] = mapped_column(String(30), nullable=False, default="")
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    description: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    # What the customer's photo shows: half_body | full_body | face | wrist | foot | hand
    subject_kind: Mapped[str] = mapped_column(String(20), nullable=False, default="half_body")
    # minWidth, minHeight, maxMegapixels, aspect hints… checked on upload.
    input_rules: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    # Short tips shown beside the photo picker.
    guidance: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    # enabled | disabled | coming_soon
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="disabled", index=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class VtoCategoryMapping(Base, TimestampMixin):
    """A catalogue category (or one of its subcategories) and the try-on it uses."""

    __tablename__ = "vto_category_mappings"
    __table_args__ = (UniqueConstraint("category_id", "subcategory", name="uq_vto_mapping_category"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    category_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("categories.id", ondelete="CASCADE"), nullable=False
    )
    # "" = the whole category; otherwise one subcategory slug, which wins.
    subcategory: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    capability_key: Mapped[str] = mapped_column(
        String(60), ForeignKey("vto_capabilities.key", ondelete="CASCADE"), nullable=False, index=True
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class VtoProductSetting(Base, TimestampMixin):
    """A product's own try-on choice: a different capability, opting out, or a better garment photo."""

    __tablename__ = "vto_product_settings"

    product_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="CASCADE"), primary_key=True
    )
    capability_key: Mapped[Optional[str]] = mapped_column(
        String(60), ForeignKey("vto_capabilities.key", ondelete="SET NULL"), nullable=True
    )
    opt_out: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # A flat, front-on photo of the item works best; empty uses the product's own photos.
    garment_image_url: Mapped[str] = mapped_column(String(500), nullable=False, default="")


class VtoProvider(Base, TimestampMixin):
    """An AI platform: Hugging Face today, others later."""

    __tablename__ = "vto_providers"

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    # The adapter family in code: huggingface | mock | …
    kind: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    timeout_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=120)
    # Further attempts after a failure that is worth retrying, across credentials.
    max_retries: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    # How long a rate-limited credential rests before it is tried again.
    cooldown_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=900)
    # unknown | healthy | degraded | down
    health: Mapped[str] = mapped_column(String(12), nullable=False, default="unknown")
    health_detail: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    last_checked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    config: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)


class VtoModel(Base, TimestampMixin):
    """One AI endpoint and the capabilities it is known to handle."""

    __tablename__ = "vto_models"

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    provider_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("vto_providers.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    # The adapter in code that knows how to call it (app/services/try_on/adapters).
    adapter_key: Mapped[str] = mapped_column(String(60), nullable=False)
    # Endpoint and parameters: space, apiName, steps, scale…
    config: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    capabilities: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    # standard | hd | … — what a plan's `qualityTiers` names.
    quality_tier: Mapped[str] = mapped_column(String(20), nullable=False, default="standard")
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Tested with real credentials and real products. Unverified models are never routed to.
    verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    avg_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=45)
    cost_per_call: Mapped[Optional[float]] = mapped_column(Numeric(10, 4), nullable=True)
    cost_currency: Mapped[str] = mapped_column(String(3), nullable=False, default="USD")


class VtoCredential(Base, TimestampMixin):
    """
    A provider secret, sealed. The secret never leaves the server once saved;
    a deleted credential keeps its row (and the history pointing at it) and
    loses the secret.
    """

    __tablename__ = "vto_credentials"
    __table_args__ = (UniqueConstraint("fingerprint", name="uq_vto_credential_fingerprint"),)

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    provider_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("vto_providers.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    label: Mapped[str] = mapped_column(String(80), nullable=False)
    secret_sealed: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # A keyed hash of the secret: spots the same token added twice. NULL once deleted.
    fingerprint: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    last4: Mapped[str] = mapped_column(String(8), nullable=False, default="")
    # active | disabled | invalid | rate_limited — `deleted_at` marks deletion.
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active", index=True)
    # Left out of ordinary listings. Still used, unless disabled.
    hidden: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Picked automatically for eligible customers' requests (shared credentials only).
    auto_select: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    # shared | dedicated
    scope: Mapped[str] = mapped_column(String(12), nullable=False, default="shared")
    dedicated_customer_id: Mapped[Optional[str]] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Empty lists mean "any": every model of the provider, every capability, every category.
    model_ids: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    capability_keys: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    category_ids: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    daily_limit: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    monthly_limit: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # Health: unvalidated | valid | invalid | error
    validation_status: Mapped[str] = mapped_column(String(16), nullable=False, default="unvalidated")
    last_validated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    cooldown_until: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    consecutive_failures: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_error_code: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    last_error_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # What the provider said about limits, when it says anything (sanitised).
    rate_limit_info: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    success_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failure_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_used_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    rotated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, index=True)
    created_by: Mapped[str] = mapped_column(String(20), nullable=False, default="")


class VtoPhoto(Base):
    """A customer's photo, stored privately for as long as it is needed."""

    __tablename__ = "vto_photos"
    __table_args__ = (Index("ix_vto_photos_customer", "customer_id", "created_at"),)

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False
    )
    # s3 | ephemeral
    storage: Mapped[str] = mapped_column(String(12), nullable=False)
    object_key: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(40), nullable=False, default="image/jpeg")
    width: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    height: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Kept for reuse ("My photos") rather than only for one try-on.
    saved: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, index=True)
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class VtoRequest(Base):
    """One try-on: what was asked, what ran it, how it ended, and where the result is."""

    __tablename__ = "vto_requests"
    __table_args__ = (
        UniqueConstraint("customer_id", "idempotency_key", name="uq_vto_request_idempotency"),
        Index("ix_vto_requests_status", "status", "created_at"),
        Index("ix_vto_requests_customer", "customer_id", "created_at"),
        Index("ix_vto_requests_model", "model_id", "created_at"),
        Index("ix_vto_requests_credential", "credential_id", "created_at"),
        Index("ix_vto_requests_result_expiry", "result_expires_at"),
    )

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False
    )
    product_id: Mapped[Optional[str]] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="SET NULL"), nullable=True, index=True
    )
    product_name: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    color: Mapped[str] = mapped_column(String(60), nullable=False, default="")
    size: Mapped[str] = mapped_column(String(30), nullable=False, default="")
    capability_key: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
    category_id: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    photo_id: Mapped[Optional[str]] = mapped_column(
        BusinessId, ForeignKey("vto_photos.id", ondelete="SET NULL"), nullable=True
    )

    # What ran it — kept as plain ids so history outlives a deleted record.
    provider_id: Mapped[Optional[str]] = mapped_column(String(20), nullable=True, index=True)
    model_id: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    requested_model_id: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    credential_id: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    credential_label: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    allocation_id: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    # Whose allowance paid for it: plan | trial | allocation
    source: Mapped[str] = mapped_column(String(12), nullable=False, default="plan")
    membership_id: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    plan_id: Mapped[Optional[str]] = mapped_column(String(20), nullable=True, index=True)
    plan_name: Mapped[str] = mapped_column(String(80), nullable=False, default="")

    # queued | processing | retrying | succeeded | failed | cancelled | expired
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="queued")
    error_code: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    error_badge: Mapped[str] = mapped_column(String(30), nullable=False, default="")
    error_message: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    technical_detail: Mapped[str] = mapped_column(String(600), nullable=False, default="")
    retryable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    retries_used: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    lease_until: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    idempotency_key: Mapped[str] = mapped_column(String(64), nullable=False)

    queued_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    duration_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # permanent | temporary | ephemeral — decided by the plan and the storage in use.
    storage_mode: Mapped[str] = mapped_column(String(12), nullable=False, default="temporary")
    result_storage: Mapped[str] = mapped_column(String(12), nullable=False, default="")
    result_key: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    result_content_type: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    result_expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    result_deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    favourite: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    feedback_rating: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    feedback_comment: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    # Notices already sent (usage warning, retention reminder), so each goes once.
    notices: Mapped[list] = mapped_column(JSON, nullable=False, default=list)

    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class VtoAttempt(Base):
    """One call to a provider for a request — a request that fell back has several."""

    __tablename__ = "vto_attempts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    request_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("vto_requests.id", ondelete="CASCADE"), nullable=False, index=True
    )
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    provider_id: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    model_id: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    credential_id: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    credential_label: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    # succeeded | failed
    outcome: Mapped[str] = mapped_column(String(12), nullable=False)
    error_code: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    technical_detail: Mapped[str] = mapped_column(String(600), nullable=False, default="")
    latency_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    started_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    finished_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class VtoUsage(Base):
    """
    The quota ledger: one row per request. `reserved` while it runs,
    `consumed` when it succeeds, `released` when it fails or is cancelled —
    only successes count against an allowance.
    """

    __tablename__ = "vto_usage"
    __table_args__ = (
        UniqueConstraint("request_id", name="uq_vto_usage_request"),
        Index("ix_vto_usage_customer", "customer_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False
    )
    request_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("vto_requests.id", ondelete="CASCADE"), nullable=False
    )
    source: Mapped[str] = mapped_column(String(12), nullable=False)
    membership_id: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    allocation_id: Mapped[Optional[str]] = mapped_column(String(20), nullable=True, index=True)
    # reserved | consumed | released
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="reserved")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class VtoAllocationRequest(Base):
    """A customer asking for more try-ons, or for capacity of their own."""

    __tablename__ = "vto_allocation_requests"
    __table_args__ = (Index("ix_vto_allocation_requests_status", "status", "created_at"),)

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # more_usage | dedicated
    kind: Mapped[str] = mapped_column(String(16), nullable=False, default="more_usage")
    reason: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    capability_keys: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    expected_usage: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    requested_model_id: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    starts_on: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    ends_on: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    message: Mapped[str] = mapped_column(String(1000), nullable=False, default="")
    # pending | approved | rejected | withdrawn
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="pending")
    decided_by: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    decided_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    decision_note: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    allocation_id: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class VtoAllocation(Base):
    """
    Extra try-on access for one customer: more generations, and optionally a
    credential nobody else's requests may use.
    """

    __tablename__ = "vto_allocations"

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    request_id: Mapped[Optional[str]] = mapped_column(
        BusinessId, ForeignKey("vto_allocation_requests.id", ondelete="SET NULL"), nullable=True
    )
    # allowance | dedicated_credential
    kind: Mapped[str] = mapped_column(String(24), nullable=False, default="allowance")
    credential_id: Mapped[Optional[str]] = mapped_column(
        BusinessId, ForeignKey("vto_credentials.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Generations granted for the whole allocation; None = no cap of its own.
    generations: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    per_day: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    capability_keys: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    starts_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    ends_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # active | disabled | revoked | expired
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="active", index=True)
    note: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    created_by: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class VtoCleanupTask(Base):
    """An object that must be deleted from storage and hasn't been yet — retried until it is."""

    __tablename__ = "vto_cleanup_tasks"
    __table_args__ = (Index("ix_vto_cleanup_due", "done_at", "next_attempt_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    storage: Mapped[str] = mapped_column(String(12), nullable=False)
    object_key: Mapped[str] = mapped_column(String(255), nullable=False)
    # customer_deleted | expired | abandoned | failed_request | …
    reason: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    last_error: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    done_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class VtoHealthCheck(Base):
    """One health probe of a credential or provider, for the dashboard's history."""

    __tablename__ = "vto_health_checks"
    __table_args__ = (Index("ix_vto_health_target", "target_type", "target_id", "checked_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # credential | provider
    target_type: Mapped[str] = mapped_column(String(12), nullable=False)
    target_id: Mapped[str] = mapped_column(String(20), nullable=False)
    ok: Mapped[bool] = mapped_column(Boolean, nullable=False)
    latency_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error_code: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    detail: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    checked_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
