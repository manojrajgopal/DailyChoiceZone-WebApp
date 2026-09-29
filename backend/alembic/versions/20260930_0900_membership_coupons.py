"""Membership programme and coupon audiences

- `membership_plans`, `customer_memberships`: the paid programme — plans an
  administrator manages, and each customer's purchase of one.
- `coupons.audience` / `coupons.show_in_store` and `coupon_customers`: who may
  use a coupon. Existing coupons become `everyone` / shown — exactly how they
  behave today.
- `orders.membership_id` / `member_discount` / `member_free_delivery` and
  `invoices.member_discount`: what a membership saved on an order. Zero and
  empty for every existing order and invoice.

Additive only: nothing is dropped, renamed or rewritten.

Revision ID: 2a8f5e3c9b14
Revises: 9d4c2b7e1f36
Create Date: 2026-09-30 09:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "2a8f5e3c9b14"
down_revision: Union[str, None] = "9d4c2b7e1f36"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ID = sa.String(length=20)


def upgrade() -> None:
    op.create_table(
        "membership_plans",
        sa.Column("id", ID, primary_key=True),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("description", sa.String(500), nullable=False, server_default=""),
        sa.Column("duration_months", sa.Integer(), nullable=False),
        sa.Column("price", sa.Numeric(12, 2), nullable=False),
        sa.Column("compare_at_price", sa.Numeric(12, 2), nullable=True),
        sa.Column("free_delivery", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("free_deliveries_per_month", sa.Integer(), nullable=True),
        sa.Column("member_discount_percent", sa.Numeric(5, 2), nullable=False, server_default="0"),
        sa.Column("extra_return_days", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("early_access", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("priority_support", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("badge", sa.String(40), nullable=False, server_default=""),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_membership_plans_active", "membership_plans", ["active"])

    op.create_table(
        "customer_memberships",
        sa.Column("id", ID, primary_key=True),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("plan_id", ID, sa.ForeignKey("membership_plans.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("plan_name", sa.String(80), nullable=False),
        sa.Column("duration_months", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(12), nullable=False, server_default="pending"),
        sa.Column("starts_at", sa.DateTime(), nullable=True),
        sa.Column("ends_at", sa.DateTime(), nullable=True),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False, server_default="INR"),
        sa.Column("benefits", sa.JSON(), nullable=False),
        sa.Column("gateway_order_id", sa.String(64), nullable=True),
        sa.Column("gateway_payment_id", sa.String(64), nullable=True),
        sa.Column("paid_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_customer_memberships_customer_id", "customer_memberships", ["customer_id"])
    op.create_index("ix_customer_memberships_status", "customer_memberships", ["status"])
    op.create_index("ix_customer_memberships_ends_at", "customer_memberships", ["ends_at"])
    op.create_index("ix_customer_memberships_gateway_order_id", "customer_memberships", ["gateway_order_id"])

    op.add_column("coupons", sa.Column("audience", sa.String(20), nullable=False, server_default="everyone"))
    op.add_column("coupons", sa.Column("show_in_store", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.create_table(
        "coupon_customers",
        sa.Column("coupon_id", ID, sa.ForeignKey("coupons.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("customer_id", ID, sa.ForeignKey("customers.id", ondelete="CASCADE"), primary_key=True),
    )
    op.create_index("ix_coupon_customers_customer_id", "coupon_customers", ["customer_id"])

    op.add_column("orders", sa.Column("membership_id", sa.String(20), nullable=True))
    op.add_column("orders", sa.Column("member_discount", sa.Numeric(12, 2), nullable=False, server_default="0"))
    op.add_column("orders", sa.Column("member_free_delivery", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.create_index("ix_orders_membership_id", "orders", ["membership_id"])
    op.add_column("invoices", sa.Column("member_discount", sa.BigInteger(), nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("invoices", "member_discount")
    op.drop_index("ix_orders_membership_id", table_name="orders")
    op.drop_column("orders", "member_free_delivery")
    op.drop_column("orders", "member_discount")
    op.drop_column("orders", "membership_id")
    op.drop_table("coupon_customers")
    op.drop_column("coupons", "show_in_store")
    op.drop_column("coupons", "audience")
    op.drop_table("customer_memberships")
    op.drop_table("membership_plans")
