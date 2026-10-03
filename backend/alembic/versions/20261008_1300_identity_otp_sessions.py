"""Customer identity: social sign-in, one-time codes and signed-in sessions

New tables:

- `customer_identities`: the ways into an account other than its password: a
  Google, Apple or Microsoft subject, or a verified phone number. Unique per
  (provider, provider_user_id).
- `otp_challenges`: one-time codes sent by SMS or email. Only an HMAC of the
  code is stored, never the code.
- `oauth_states`: one sign-in round trip to a provider (hashed state, hashed
  nonce, sealed PKCE verifier, browser binding, then the one-time handoff code).
- `customer_sessions`: signed-in devices; new tokens carry the session id.

Changes to `customers`:

- `password_hash` becomes NULLABLE. An account created with Google, Apple,
  Microsoft or a one-time code has no password until it sets one. Existing rows
  all have a hash and keep it; nothing is rewritten.
- New nullable columns `phone_verified_at` and `sessions_revoked_at`.

No existing data is altered or removed. Safe to run again after an
interruption: every table, column and index is created only if missing.

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-10-08 13:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e5f6a7b8c9d0"
down_revision: Union[str, None] = "d4e5f6a7b8c9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ID = sa.String(20)


def _inspector():
    return sa.inspect(op.get_bind())


def _has_table(name: str) -> bool:
    return _inspector().has_table(name)


def _columns(table: str) -> dict:
    return {c["name"]: c for c in _inspector().get_columns(table)}


def _indexes(table: str) -> set:
    inspector = _inspector()
    names = {i["name"] for i in inspector.get_indexes(table)}
    names |= {u["name"] for u in inspector.get_unique_constraints(table)}
    return names


def _create_index(name: str, table: str, columns: list, unique: bool = False) -> None:
    if name not in _indexes(table):
        op.create_index(name, table, columns, unique=unique)


def _create_table(name: str, *columns) -> None:
    if not _has_table(name):
        op.create_table(name, *columns)


def upgrade() -> None:
    # ---------------------------------------------------------------- customers
    columns = _columns("customers")
    if columns.get("password_hash", {}).get("nullable") is False:
        # Social-only and code-only accounts have no password until they set one.
        op.alter_column("customers", "password_hash", existing_type=sa.String(255), nullable=True)
    if "phone_verified_at" not in columns:
        op.add_column("customers", sa.Column("phone_verified_at", sa.DateTime, nullable=True))
    if "sessions_revoked_at" not in columns:
        op.add_column("customers", sa.Column("sessions_revoked_at", sa.DateTime, nullable=True))

    # --------------------------------------------------------------- identities
    _create_table(
        "customer_identities",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("provider", sa.String(20), nullable=False),
        sa.Column("provider_user_id", sa.String(255), nullable=False),
        sa.Column("provider_email", sa.String(255), nullable=False, server_default=""),
        sa.Column("email_verified", sa.Boolean, nullable=False, server_default="0"),
        sa.Column("display_name", sa.String(160), nullable=False, server_default=""),
        sa.Column("verified_at", sa.DateTime, nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("last_login_at", sa.DateTime, nullable=True),
        sa.UniqueConstraint("provider", "provider_user_id", name="uq_customer_identities_subject"),
    )
    _create_index("ix_customer_identities_customer_id", "customer_identities", ["customer_id"])

    # ------------------------------------------------------------- one-time codes
    _create_table(
        "otp_challenges",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("purpose", sa.String(20), nullable=False),
        sa.Column("channel", sa.String(8), nullable=False),
        sa.Column("destination_hash", sa.String(64), nullable=False),
        sa.Column("destination_masked", sa.String(80), nullable=False, server_default=""),
        sa.Column("destination_sealed", sa.Text, nullable=False),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=True),
        sa.Column("code_hash", sa.String(64), nullable=False),
        sa.Column("status", sa.String(12), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("max_attempts", sa.Integer, nullable=False, server_default="5"),
        sa.Column("provider", sa.String(20), nullable=False, server_default=""),
        sa.Column("ip_hash", sa.String(64), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("expires_at", sa.DateTime, nullable=False),
        sa.Column("resend_available_at", sa.DateTime, nullable=False),
        sa.Column("consumed_at", sa.DateTime, nullable=True),
    )
    _create_index("ix_otp_challenges_customer_id", "otp_challenges", ["customer_id"])
    _create_index("ix_otp_challenges_destination", "otp_challenges", ["destination_hash", "created_at"])
    _create_index("ix_otp_challenges_ip", "otp_challenges", ["ip_hash", "created_at"])
    _create_index("ix_otp_challenges_expires", "otp_challenges", ["expires_at"])

    # --------------------------------------------------------------- OAuth trips
    _create_table(
        "oauth_states",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("provider", sa.String(20), nullable=False),
        sa.Column("mode", sa.String(8), nullable=False, server_default="login"),
        sa.Column("state_hash", sa.String(64), nullable=True, unique=True),
        sa.Column("ticket_hash", sa.String(64), nullable=True, unique=True),
        sa.Column("nonce_hash", sa.String(64), nullable=False, server_default=""),
        sa.Column("verifier_sealed", sa.Text, nullable=False),
        sa.Column("browser_hash", sa.String(64), nullable=False, server_default=""),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=True),
        sa.Column("next_path", sa.String(300), nullable=False, server_default=""),
        sa.Column("ip_hash", sa.String(64), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("expires_at", sa.DateTime, nullable=False),
        sa.Column("started_at", sa.DateTime, nullable=True),
        sa.Column("consumed_at", sa.DateTime, nullable=True),
        sa.Column("outcome", sa.String(20), nullable=False, server_default=""),
        sa.Column("error_code", sa.String(40), nullable=False, server_default=""),
        sa.Column("handoff_hash", sa.String(64), nullable=True, unique=True),
        sa.Column("handoff_customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=True),
        sa.Column("handoff_expires_at", sa.DateTime, nullable=True),
        sa.Column("handoff_used_at", sa.DateTime, nullable=True),
        sa.Column("created_account", sa.Boolean, nullable=False, server_default="0"),
    )
    _create_index("ix_oauth_states_customer_id", "oauth_states", ["customer_id"])
    _create_index("ix_oauth_states_expires", "oauth_states", ["expires_at"])

    # ------------------------------------------------------------------ sessions
    _create_table(
        "customer_sessions",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("method", sa.String(20), nullable=False, server_default="password"),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("last_seen_at", sa.DateTime, nullable=False),
        sa.Column("expires_at", sa.DateTime, nullable=False),
        sa.Column("revoked_at", sa.DateTime, nullable=True),
        sa.Column("revoked_reason", sa.String(30), nullable=False, server_default=""),
        sa.Column("ip_hash", sa.String(64), nullable=False, server_default=""),
        sa.Column("ip_masked", sa.String(64), nullable=False, server_default=""),
        sa.Column("device", sa.String(80), nullable=False, server_default=""),
    )
    _create_index("ix_customer_sessions_customer_id", "customer_sessions", ["customer_id"])
    _create_index("ix_customer_sessions_expires", "customer_sessions", ["expires_at"])


def downgrade() -> None:
    # Only for a deliberate rollback by a person; startup only ever upgrades.
    for table in ("customer_sessions", "oauth_states", "otp_challenges", "customer_identities"):
        if _has_table(table):
            op.drop_table(table)
    columns = _columns("customers")
    for column in ("sessions_revoked_at", "phone_verified_at"):
        if column in columns:
            op.drop_column("customers", column)
    # `password_hash` goes back to NOT NULL only when every account has one:
    # tightening it over social-only accounts would fail (or need their rows
    # changed), and a rollback must not touch customer data.
    missing = op.get_bind().execute(sa.text("SELECT COUNT(*) FROM customers WHERE password_hash IS NULL")).scalar()
    if not missing:
        op.alter_column("customers", "password_hash", existing_type=sa.String(255), nullable=False)
