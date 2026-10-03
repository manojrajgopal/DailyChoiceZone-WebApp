"""Customer segmentation: per-customer metrics, segments, members, history; coupons restricted to a segment

New tables:

- `customer_metrics`: one row per customer (FK customers CASCADE), the
  precomputed figures segments filter on, with RFM scores and refresh
  bookkeeping. Indexed on the columns segments filter on most.
- `segments`: saved rule-based segments (`slug` UNIQUE, `status` indexed).
- `segment_members`: the materialised membership, PK (segment_id, customer_id),
  both FKs CASCADE, indexed on customer_id.
- `segment_events`: each segment's history, indexed (segment_id, occurred_at).

Existing table changed: `coupons` gains `segment_id` (nullable, FK segments
SET NULL, indexed) for the new coupon audience `segment`. Nothing existing is
altered or dropped, and no rows are written: the default segments are seeded
by the application on first read (docs/customer-segmentation.md).

Safe to run again after an interruption: every table, column, index and FK is
created only if it is missing.

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-10-08 11:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c3d4e5f6a7b8"
down_revision: Union[str, None] = "b2c3d4e5f6a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ID = sa.String(20)
MONEY = sa.BigInteger


def _inspector():
    return sa.inspect(op.get_bind())


def _has_table(name: str) -> bool:
    return _inspector().has_table(name)


def _columns(table: str) -> set:
    return {c["name"] for c in _inspector().get_columns(table)}


def _indexes(table: str) -> set:
    inspector = _inspector()
    names = {i["name"] for i in inspector.get_indexes(table)}
    names |= {u["name"] for u in inspector.get_unique_constraints(table)}
    return names


def _foreign_keys(table: str) -> set:
    return {fk["name"] for fk in _inspector().get_foreign_keys(table)}


def _create_index(name: str, table: str, columns: list, unique: bool = False) -> None:
    if name not in _indexes(table):
        op.create_index(name, table, columns, unique=unique)


def _create_table(name: str, *columns) -> None:
    if not _has_table(name):
        op.create_table(name, *columns)


def _count(name: str) -> sa.Column:
    return sa.Column(name, sa.Integer, nullable=False, server_default="0")


def _money(name: str) -> sa.Column:
    return sa.Column(name, MONEY, nullable=False, server_default="0")


def _flag(name: str) -> sa.Column:
    return sa.Column(name, sa.Boolean, nullable=False, server_default="0")


def upgrade() -> None:
    _create_table(
        "customer_metrics",
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), primary_key=True),
        _count("total_orders"), _count("kept_orders"), _money("total_spend"), _money("average_order_value"),
        sa.Column("first_order_at", sa.DateTime, nullable=True),
        sa.Column("last_order_at", sa.DateTime, nullable=True),
        _count("cancelled_orders"), _count("returned_orders"), _count("refunded_orders"), _count("return_requests"),
        _count("coupon_uses"), _flag("has_active_cart"), _flag("has_abandoned_cart"), _count("abandoned_carts"),
        _count("wishlist_items"), _count("products_viewed_90d"), _count("categories_viewed_90d"),
        sa.Column("purchased_category_ids", sa.JSON, nullable=True),
        sa.Column("membership_status", sa.String(12), nullable=False, server_default="none"),
        sa.Column("membership_plan_id", ID, nullable=True),
        sa.Column("membership_ends_at", sa.DateTime, nullable=True),
        _count("points_balance"), _money("store_credit_balance"), _count("gift_card_orders"),
        _money("gift_card_spend"),
        _flag("was_referred"), _count("referral_count"),
        _flag("email_opt_in"), _flag("sms_opt_in"), _flag("whatsapp_opt_in"),
        _count("campaigns_received"), _count("campaign_opens"), _count("campaign_clicks"),
        sa.Column("last_engaged_at", sa.DateTime, nullable=True),
        sa.Column("city", sa.String(120), nullable=False, server_default=""),
        sa.Column("state", sa.String(120), nullable=False, server_default=""),
        sa.Column("pincode", sa.String(12), nullable=False, server_default=""),
        _count("recency_score"), _count("frequency_score"), _count("monetary_score"),
        sa.Column("rfm_label", sa.String(20), nullable=False, server_default="no-orders"),
        sa.Column("dirty", sa.Boolean, nullable=False, server_default="1"),
        sa.Column("marked_at", sa.DateTime, nullable=True),
        sa.Column("refreshed_at", sa.DateTime, nullable=True),
    )
    for name, column in (("refreshed", "refreshed_at"), ("dirty", "dirty"), ("orders", "total_orders"),
                         ("spend", "total_spend"), ("last_order", "last_order_at"), ("rfm", "rfm_label"),
                         ("city", "city"), ("membership", "membership_status")):
        _create_index(f"ix_customer_metrics_{name}", "customer_metrics", [column])

    _create_table(
        "segments",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("slug", sa.String(140), nullable=False, unique=True),
        sa.Column("description", sa.String(500), nullable=False, server_default=""),
        sa.Column("match", sa.String(3), nullable=False, server_default="all"),
        sa.Column("rules", sa.JSON, nullable=False),
        sa.Column("kind", sa.String(10), nullable=False, server_default="custom"),
        sa.Column("status", sa.String(10), nullable=False, server_default="active"),
        sa.Column("member_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("last_calculated_at", sa.DateTime, nullable=True),
        sa.Column("created_by", sa.String(40), nullable=False, server_default="system"),
        sa.Column("updated_by", sa.String(40), nullable=False, server_default="system"),
        sa.Column("archived_at", sa.DateTime, nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("updated_at", sa.DateTime, nullable=False),
    )
    _create_index("ix_segments_status", "segments", ["status"])

    _create_table(
        "segment_members",
        sa.Column("segment_id", sa.Integer, sa.ForeignKey("segments.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("added_at", sa.DateTime, nullable=False),
    )
    _create_index("ix_segment_members_customer_id", "segment_members", ["customer_id"])

    _create_table(
        "segment_events",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("segment_id", sa.Integer, sa.ForeignKey("segments.id", ondelete="CASCADE"), nullable=False),
        sa.Column("action", sa.String(20), nullable=False),
        sa.Column("actor", sa.String(40), nullable=False, server_default="system"),
        sa.Column("actor_name", sa.String(120), nullable=False, server_default=""),
        sa.Column("details", sa.JSON, nullable=True),
        sa.Column("occurred_at", sa.DateTime, nullable=False),
    )
    _create_index("ix_segment_events_segment_time", "segment_events", ["segment_id", "occurred_at"])

    if "segment_id" not in _columns("coupons"):
        op.add_column("coupons", sa.Column("segment_id", sa.Integer, nullable=True))
    _create_index("ix_coupons_segment_id", "coupons", ["segment_id"])
    if "fk_coupons_segment_id" not in _foreign_keys("coupons"):
        op.create_foreign_key("fk_coupons_segment_id", "coupons", "segments", ["segment_id"], ["id"],
                              ondelete="SET NULL")


def downgrade() -> None:
    # Only for a deliberate rollback by a person; startup only ever upgrades.
    if "fk_coupons_segment_id" in _foreign_keys("coupons"):
        op.drop_constraint("fk_coupons_segment_id", "coupons", type_="foreignkey")
    if "ix_coupons_segment_id" in _indexes("coupons"):
        op.drop_index("ix_coupons_segment_id", table_name="coupons")
    if "segment_id" in _columns("coupons"):
        op.drop_column("coupons", "segment_id")
    for table in ("segment_events", "segment_members", "segments", "customer_metrics"):
        if _has_table(table):
            op.drop_table(table)
