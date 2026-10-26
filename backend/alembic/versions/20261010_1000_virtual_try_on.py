"""Virtual try-on (docs/virtual-try-on.md)

- `membership_plans.try_on`: a plan's try-on entitlement (NULL = not included).
- `vto_capabilities`, `vto_category_mappings`, `vto_product_settings`: what can
  be tried on, and which catalogue categories and products use it.
- `vto_providers`, `vto_models`, `vto_credentials`: the AI platforms, their
  endpoints, and encrypted credentials.
- `vto_photos`, `vto_requests`, `vto_attempts`, `vto_usage`: customers'
  photos (keys only, never image data), generations, provider calls, quota.
- `vto_allocation_requests`, `vto_allocations`: extra or dedicated access.
- `vto_cleanup_tasks`, `vto_health_checks`: deletions to retry, health history.

Seeds the capability catalogue, the Hugging Face provider and the two
OOTDiffusion endpoints (only the proven upper-body one enabled), from
`app/services/try_on/defaults.py`.

Additive only. Safe to run again: each table, column and row is added only if
missing. The downgrade drops the try-on tables and the plan column.

Revision ID: d0e1f2a3b4c5
Revises: c9d0e1f2a3b4
Create Date: 2026-10-10 10:00:00.000000
"""

from datetime import datetime
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d0e1f2a3b4c5"
down_revision: Union[str, None] = "c9d0e1f2a3b4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ID = sa.String(20)


def _timestamps():
    return [
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    ]


def _tables():
    """(name, columns + constraints, [(index name, columns, unique)]) in creation order."""
    return [
        ("vto_capabilities", [
            sa.Column("key", sa.String(60), primary_key=True),
            sa.Column("family", sa.String(30), nullable=False),
            sa.Column("name", sa.String(80), nullable=False),
            sa.Column("description", sa.String(300), nullable=False),
            sa.Column("subject_kind", sa.String(20), nullable=False),
            sa.Column("input_rules", sa.JSON(), nullable=False),
            sa.Column("guidance", sa.JSON(), nullable=False),
            sa.Column("status", sa.String(12), nullable=False),
            sa.Column("sort_order", sa.Integer(), nullable=False),
            *_timestamps(),
        ], [("ix_vto_capabilities_status", ["status"], False)]),
        ("vto_category_mappings", [
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("category_id", ID, sa.ForeignKey("categories.id", ondelete="CASCADE"), nullable=False),
            sa.Column("subcategory", sa.String(80), nullable=False),
            sa.Column("capability_key", sa.String(60), sa.ForeignKey("vto_capabilities.key", ondelete="CASCADE"),
                      nullable=False),
            sa.Column("enabled", sa.Boolean(), nullable=False),
            *_timestamps(),
            sa.UniqueConstraint("category_id", "subcategory", name="uq_vto_mapping_category"),
        ], [("ix_vto_category_mappings_capability_key", ["capability_key"], False)]),
        ("vto_product_settings", [
            sa.Column("product_id", ID, sa.ForeignKey("products.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("capability_key", sa.String(60), sa.ForeignKey("vto_capabilities.key", ondelete="SET NULL"),
                      nullable=True),
            sa.Column("opt_out", sa.Boolean(), nullable=False),
            sa.Column("garment_image_url", sa.String(500), nullable=False),
            *_timestamps(),
        ], []),
        ("vto_providers", [
            sa.Column("id", ID, primary_key=True),
            sa.Column("kind", sa.String(30), nullable=False),
            sa.Column("name", sa.String(80), nullable=False),
            sa.Column("enabled", sa.Boolean(), nullable=False),
            sa.Column("timeout_seconds", sa.Integer(), nullable=False),
            sa.Column("max_retries", sa.Integer(), nullable=False),
            sa.Column("cooldown_seconds", sa.Integer(), nullable=False),
            sa.Column("health", sa.String(12), nullable=False),
            sa.Column("health_detail", sa.String(255), nullable=False),
            sa.Column("last_checked_at", sa.DateTime(), nullable=True),
            sa.Column("config", sa.JSON(), nullable=False),
            *_timestamps(),
        ], [("ix_vto_providers_kind", ["kind"], False)]),
        ("vto_models", [
            sa.Column("id", ID, primary_key=True),
            sa.Column("provider_id", ID, sa.ForeignKey("vto_providers.id", ondelete="RESTRICT"), nullable=False),
            sa.Column("name", sa.String(120), nullable=False),
            sa.Column("description", sa.String(300), nullable=False),
            sa.Column("adapter_key", sa.String(60), nullable=False),
            sa.Column("config", sa.JSON(), nullable=False),
            sa.Column("capabilities", sa.JSON(), nullable=False),
            sa.Column("quality_tier", sa.String(20), nullable=False),
            sa.Column("enabled", sa.Boolean(), nullable=False),
            sa.Column("verified", sa.Boolean(), nullable=False),
            sa.Column("priority", sa.Integer(), nullable=False),
            sa.Column("avg_seconds", sa.Integer(), nullable=False),
            sa.Column("cost_per_call", sa.Numeric(10, 4), nullable=True),
            sa.Column("cost_currency", sa.String(3), nullable=False),
            *_timestamps(),
        ], [("ix_vto_models_provider_id", ["provider_id"], False)]),
        ("vto_credentials", [
            sa.Column("id", ID, primary_key=True),
            sa.Column("provider_id", ID, sa.ForeignKey("vto_providers.id", ondelete="RESTRICT"), nullable=False),
            sa.Column("label", sa.String(80), nullable=False),
            sa.Column("secret_sealed", sa.Text(), nullable=True),
            sa.Column("fingerprint", sa.String(64), nullable=True),
            sa.Column("last4", sa.String(8), nullable=False),
            sa.Column("status", sa.String(16), nullable=False),
            sa.Column("hidden", sa.Boolean(), nullable=False),
            sa.Column("auto_select", sa.Boolean(), nullable=False),
            sa.Column("priority", sa.Integer(), nullable=False),
            sa.Column("scope", sa.String(12), nullable=False),
            sa.Column("dedicated_customer_id", ID, sa.ForeignKey("customers.id", ondelete="SET NULL"),
                      nullable=True),
            sa.Column("model_ids", sa.JSON(), nullable=False),
            sa.Column("capability_keys", sa.JSON(), nullable=False),
            sa.Column("category_ids", sa.JSON(), nullable=False),
            sa.Column("daily_limit", sa.Integer(), nullable=True),
            sa.Column("monthly_limit", sa.Integer(), nullable=True),
            sa.Column("validation_status", sa.String(16), nullable=False),
            sa.Column("last_validated_at", sa.DateTime(), nullable=True),
            sa.Column("cooldown_until", sa.DateTime(), nullable=True),
            sa.Column("consecutive_failures", sa.Integer(), nullable=False),
            sa.Column("last_error_code", sa.String(40), nullable=False),
            sa.Column("last_error_at", sa.DateTime(), nullable=True),
            sa.Column("rate_limit_info", sa.JSON(), nullable=True),
            sa.Column("success_count", sa.Integer(), nullable=False),
            sa.Column("failure_count", sa.Integer(), nullable=False),
            sa.Column("last_used_at", sa.DateTime(), nullable=True),
            sa.Column("rotated_at", sa.DateTime(), nullable=True),
            sa.Column("deleted_at", sa.DateTime(), nullable=True),
            sa.Column("created_by", sa.String(20), nullable=False),
            *_timestamps(),
            sa.UniqueConstraint("fingerprint", name="uq_vto_credential_fingerprint"),
        ], [
            ("ix_vto_credentials_provider_id", ["provider_id"], False),
            ("ix_vto_credentials_status", ["status"], False),
            ("ix_vto_credentials_dedicated_customer_id", ["dedicated_customer_id"], False),
            ("ix_vto_credentials_deleted_at", ["deleted_at"], False),
        ]),
        ("vto_photos", [
            sa.Column("id", ID, primary_key=True),
            sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
            sa.Column("storage", sa.String(12), nullable=False),
            sa.Column("object_key", sa.String(255), nullable=False),
            sa.Column("content_type", sa.String(40), nullable=False),
            sa.Column("width", sa.Integer(), nullable=False),
            sa.Column("height", sa.Integer(), nullable=False),
            sa.Column("size_bytes", sa.Integer(), nullable=False),
            sa.Column("saved", sa.Boolean(), nullable=False),
            sa.Column("expires_at", sa.DateTime(), nullable=True),
            sa.Column("deleted_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
        ], [
            ("ix_vto_photos_customer", ["customer_id", "created_at"], False),
            ("ix_vto_photos_expires_at", ["expires_at"], False),
        ]),
        ("vto_requests", [
            sa.Column("id", ID, primary_key=True),
            sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
            sa.Column("product_id", ID, sa.ForeignKey("products.id", ondelete="SET NULL"), nullable=True),
            sa.Column("product_name", sa.String(200), nullable=False),
            sa.Column("color", sa.String(60), nullable=False),
            sa.Column("size", sa.String(30), nullable=False),
            sa.Column("capability_key", sa.String(60), nullable=False),
            sa.Column("category_id", sa.String(20), nullable=False),
            sa.Column("photo_id", ID, sa.ForeignKey("vto_photos.id", ondelete="SET NULL"), nullable=True),
            sa.Column("provider_id", sa.String(20), nullable=True),
            sa.Column("model_id", sa.String(20), nullable=True),
            sa.Column("requested_model_id", sa.String(20), nullable=True),
            sa.Column("credential_id", sa.String(20), nullable=True),
            sa.Column("credential_label", sa.String(80), nullable=False),
            sa.Column("allocation_id", sa.String(20), nullable=True),
            sa.Column("source", sa.String(12), nullable=False),
            sa.Column("membership_id", sa.String(20), nullable=True),
            sa.Column("plan_id", sa.String(20), nullable=True),
            sa.Column("plan_name", sa.String(80), nullable=False),
            sa.Column("status", sa.String(12), nullable=False),
            sa.Column("error_code", sa.String(40), nullable=False),
            sa.Column("error_badge", sa.String(30), nullable=False),
            sa.Column("error_message", sa.String(255), nullable=False),
            sa.Column("technical_detail", sa.String(600), nullable=False),
            sa.Column("retryable", sa.Boolean(), nullable=False),
            sa.Column("attempts", sa.Integer(), nullable=False),
            sa.Column("retries_used", sa.Integer(), nullable=False),
            sa.Column("cancel_requested", sa.Boolean(), nullable=False),
            sa.Column("lease_until", sa.DateTime(), nullable=True),
            sa.Column("idempotency_key", sa.String(64), nullable=False),
            sa.Column("queued_at", sa.DateTime(), nullable=True),
            sa.Column("started_at", sa.DateTime(), nullable=True),
            sa.Column("finished_at", sa.DateTime(), nullable=True),
            sa.Column("duration_ms", sa.Integer(), nullable=True),
            sa.Column("storage_mode", sa.String(12), nullable=False),
            sa.Column("result_storage", sa.String(12), nullable=False),
            sa.Column("result_key", sa.String(255), nullable=False),
            sa.Column("result_content_type", sa.String(40), nullable=False),
            sa.Column("result_expires_at", sa.DateTime(), nullable=True),
            sa.Column("result_deleted_at", sa.DateTime(), nullable=True),
            sa.Column("favourite", sa.Boolean(), nullable=False),
            sa.Column("feedback_rating", sa.Integer(), nullable=True),
            sa.Column("feedback_comment", sa.String(500), nullable=False),
            sa.Column("notices", sa.JSON(), nullable=False),
            sa.Column("deleted_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.UniqueConstraint("customer_id", "idempotency_key", name="uq_vto_request_idempotency"),
        ], [
            ("ix_vto_requests_product_id", ["product_id"], False),
            ("ix_vto_requests_capability_key", ["capability_key"], False),
            ("ix_vto_requests_provider_id", ["provider_id"], False),
            ("ix_vto_requests_plan_id", ["plan_id"], False),
            ("ix_vto_requests_status", ["status", "created_at"], False),
            ("ix_vto_requests_customer", ["customer_id", "created_at"], False),
            ("ix_vto_requests_model", ["model_id", "created_at"], False),
            ("ix_vto_requests_credential", ["credential_id", "created_at"], False),
            ("ix_vto_requests_result_expiry", ["result_expires_at"], False),
        ]),
        ("vto_attempts", [
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("request_id", ID, sa.ForeignKey("vto_requests.id", ondelete="CASCADE"), nullable=False),
            sa.Column("number", sa.Integer(), nullable=False),
            sa.Column("provider_id", sa.String(20), nullable=False),
            sa.Column("model_id", sa.String(20), nullable=False),
            sa.Column("credential_id", sa.String(20), nullable=False),
            sa.Column("credential_label", sa.String(80), nullable=False),
            sa.Column("outcome", sa.String(12), nullable=False),
            sa.Column("error_code", sa.String(40), nullable=False),
            sa.Column("technical_detail", sa.String(600), nullable=False),
            sa.Column("latency_ms", sa.Integer(), nullable=False),
            sa.Column("started_at", sa.DateTime(), nullable=False),
            sa.Column("finished_at", sa.DateTime(), nullable=False),
        ], [("ix_vto_attempts_request_id", ["request_id"], False)]),
        ("vto_usage", [
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
            sa.Column("request_id", ID, sa.ForeignKey("vto_requests.id", ondelete="CASCADE"), nullable=False),
            sa.Column("source", sa.String(12), nullable=False),
            sa.Column("membership_id", sa.String(20), nullable=True),
            sa.Column("allocation_id", sa.String(20), nullable=True),
            sa.Column("status", sa.String(10), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.UniqueConstraint("request_id", name="uq_vto_usage_request"),
        ], [
            ("ix_vto_usage_customer", ["customer_id", "created_at"], False),
            ("ix_vto_usage_allocation_id", ["allocation_id"], False),
        ]),
        ("vto_allocation_requests", [
            sa.Column("id", ID, primary_key=True),
            sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
            sa.Column("kind", sa.String(16), nullable=False),
            sa.Column("reason", sa.String(500), nullable=False),
            sa.Column("capability_keys", sa.JSON(), nullable=False),
            sa.Column("expected_usage", sa.Integer(), nullable=False),
            sa.Column("requested_model_id", sa.String(20), nullable=True),
            sa.Column("starts_on", sa.Date(), nullable=True),
            sa.Column("ends_on", sa.Date(), nullable=True),
            sa.Column("message", sa.String(1000), nullable=False),
            sa.Column("status", sa.String(12), nullable=False),
            sa.Column("decided_by", sa.String(20), nullable=False),
            sa.Column("decided_at", sa.DateTime(), nullable=True),
            sa.Column("decision_note", sa.String(500), nullable=False),
            sa.Column("allocation_id", sa.String(20), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
        ], [
            ("ix_vto_allocation_requests_customer_id", ["customer_id"], False),
            ("ix_vto_allocation_requests_status", ["status", "created_at"], False),
        ]),
        ("vto_allocations", [
            sa.Column("id", ID, primary_key=True),
            sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
            sa.Column("request_id", ID, sa.ForeignKey("vto_allocation_requests.id", ondelete="SET NULL"),
                      nullable=True),
            sa.Column("kind", sa.String(24), nullable=False),
            sa.Column("credential_id", ID, sa.ForeignKey("vto_credentials.id", ondelete="SET NULL"), nullable=True),
            sa.Column("generations", sa.Integer(), nullable=True),
            sa.Column("per_day", sa.Integer(), nullable=True),
            sa.Column("capability_keys", sa.JSON(), nullable=False),
            sa.Column("starts_at", sa.DateTime(), nullable=False),
            sa.Column("ends_at", sa.DateTime(), nullable=True),
            sa.Column("status", sa.String(12), nullable=False),
            sa.Column("note", sa.String(500), nullable=False),
            sa.Column("created_by", sa.String(20), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
        ], [
            ("ix_vto_allocations_customer_id", ["customer_id"], False),
            ("ix_vto_allocations_credential_id", ["credential_id"], False),
            ("ix_vto_allocations_status", ["status"], False),
        ]),
        ("vto_cleanup_tasks", [
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("storage", sa.String(12), nullable=False),
            sa.Column("object_key", sa.String(255), nullable=False),
            sa.Column("reason", sa.String(40), nullable=False),
            sa.Column("attempts", sa.Integer(), nullable=False),
            sa.Column("next_attempt_at", sa.DateTime(), nullable=False),
            sa.Column("last_error", sa.String(300), nullable=False),
            sa.Column("done_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
        ], [("ix_vto_cleanup_due", ["done_at", "next_attempt_at"], False)]),
        ("vto_health_checks", [
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("target_type", sa.String(12), nullable=False),
            sa.Column("target_id", sa.String(20), nullable=False),
            sa.Column("ok", sa.Boolean(), nullable=False),
            sa.Column("latency_ms", sa.Integer(), nullable=False),
            sa.Column("error_code", sa.String(40), nullable=False),
            sa.Column("detail", sa.String(300), nullable=False),
            sa.Column("checked_at", sa.DateTime(), nullable=False),
        ], [("ix_vto_health_target", ["target_type", "target_id", "checked_at"], False)]),
    ]


def _seed(bind) -> None:
    from app.services.try_on import defaults

    now = datetime.utcnow()
    meta = sa.MetaData()
    capabilities = sa.Table("vto_capabilities", meta, autoload_with=bind)
    providers = sa.Table("vto_providers", meta, autoload_with=bind)
    models = sa.Table("vto_models", meta, autoload_with=bind)

    have = set(bind.execute(sa.select(capabilities.c.key)).scalars())
    rows = [{**row, "created_at": now, "updated_at": now} for row in defaults.CAPABILITIES if row["key"] not in have]
    if rows:
        op.bulk_insert(capabilities, rows)
    have = set(bind.execute(sa.select(providers.c.id)).scalars())
    rows = [{**row, "health": "unknown", "health_detail": "", "created_at": now, "updated_at": now}
            for row in defaults.PROVIDERS if row["id"] not in have]
    if rows:
        op.bulk_insert(providers, rows)
    have = set(bind.execute(sa.select(models.c.id)).scalars())
    rows = [{"cost_per_call": None, "cost_currency": "USD", **row, "created_at": now, "updated_at": now}
            for row in defaults.MODELS if row["id"] not in have]
    if rows:
        op.bulk_insert(models, rows)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "try_on" not in {c["name"] for c in inspector.get_columns("membership_plans")}:
        op.add_column("membership_plans", sa.Column("try_on", sa.JSON(), nullable=True))

    existing = set(inspector.get_table_names())
    for name, columns, indexes in _tables():
        if name not in existing:
            op.create_table(name, *columns)
            for index_name, index_columns, unique in indexes:
                op.create_index(index_name, name, index_columns, unique=unique)
    _seed(bind)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = set(inspector.get_table_names())
    for name, _, _ in reversed(_tables()):
        if name in existing:
            op.drop_table(name)
    if "try_on" in {c["name"] for c in inspector.get_columns("membership_plans")}:
        op.drop_column("membership_plans", "try_on")
