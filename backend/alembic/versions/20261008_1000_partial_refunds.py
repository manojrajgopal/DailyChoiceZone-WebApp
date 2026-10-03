"""Partial refunds: line-level refund items, refund methods, approval, retries, credit-note tax split

Adds columns to existing tables (no table is created or dropped):

- `refunds`: `method`, `reason_code`, `internal_note`, `idempotency_key`
  (UNIQUE), `shipping_amount`, `tax_amount`, `discount_amount`,
  `requires_approval`, `approved_by`, `approved_at`, `manual_reference`,
  `failure_reason`, `attempts`, `last_attempt_at`, `next_check_at` (indexed),
  `gateway_settled`, `tenders_settled`, `completed_effects`.
- `refund_items`: `order_item_id` (FK order_items SET NULL, indexed),
  `invoice_item_id` (FK invoice_items SET NULL), `discount`,
  `taxable_amount`, `tax_rate_percent`, `cgst`, `sgst`, `igst`, `tax`.
- `credit_notes`: `tax_mode`, `cgst`, `sgst`, `igst`.

Existing data is not altered. The three new booleans on `refunds` record
whether a refund's money has already been booked against the payment, the
tenders and the order's side effects; refunds raised before this migration
that were `processing` or `completed` had all of that applied at the time,
so the new columns are *filled in* for those rows (a new column being given
its true value, not an existing value changed) — otherwise a legacy refund the
gateway later fails could not be unwound. Statuses are left as they are:
`rejected` stays valid, and the never-official `pending` written by some old
clients is read as `requested` by the service.

Safe to run again after an interruption: every column, index and FK is added
only if it is missing.

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-10-08 10:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b2c3d4e5f6a7"
down_revision: Union[str, None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ID = sa.String(20)
MONEY = sa.BigInteger


def _inspector():
    return sa.inspect(op.get_bind())


def _columns(table: str) -> set:
    return {c["name"] for c in _inspector().get_columns(table)}


def _indexes(table: str) -> set:
    inspector = _inspector()
    names = {i["name"] for i in inspector.get_indexes(table)}
    names |= {u["name"] for u in inspector.get_unique_constraints(table)}
    return names


def _foreign_keys(table: str) -> set:
    return {fk["name"] for fk in _inspector().get_foreign_keys(table)}


def _add_column(table: str, column: sa.Column) -> None:
    if column.name not in _columns(table):
        op.add_column(table, column)


def _create_index(name: str, table: str, columns: list, unique: bool = False) -> None:
    if name not in _indexes(table):
        op.create_index(name, table, columns, unique=unique)


def _drop_index(name: str, table: str) -> None:
    if name in _indexes(table):
        op.drop_index(name, table_name=table)


def _drop_column(table: str, name: str) -> None:
    if name in _columns(table):
        op.drop_column(table, name)


REFUND_COLUMNS = [
    lambda: sa.Column("method", sa.String(20), nullable=False, server_default="original"),
    lambda: sa.Column("reason_code", sa.String(30), nullable=False, server_default="other"),
    lambda: sa.Column("internal_note", sa.String(1000), nullable=False, server_default=""),
    lambda: sa.Column("idempotency_key", sa.String(80), nullable=True),
    lambda: sa.Column("shipping_amount", MONEY, nullable=False, server_default="0"),
    lambda: sa.Column("tax_amount", MONEY, nullable=False, server_default="0"),
    lambda: sa.Column("discount_amount", MONEY, nullable=False, server_default="0"),
    lambda: sa.Column("requires_approval", sa.Boolean, nullable=False, server_default="0"),
    lambda: sa.Column("approved_by", sa.String(40), nullable=True),
    lambda: sa.Column("approved_at", sa.DateTime, nullable=True),
    lambda: sa.Column("manual_reference", sa.String(120), nullable=False, server_default=""),
    lambda: sa.Column("failure_reason", sa.String(255), nullable=False, server_default=""),
    lambda: sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
    lambda: sa.Column("last_attempt_at", sa.DateTime, nullable=True),
    lambda: sa.Column("next_check_at", sa.DateTime, nullable=True),
    lambda: sa.Column("gateway_settled", sa.Boolean, nullable=False, server_default="0"),
    lambda: sa.Column("tenders_settled", sa.Boolean, nullable=False, server_default="0"),
    lambda: sa.Column("completed_effects", sa.Boolean, nullable=False, server_default="0"),
]

ITEM_COLUMNS = [
    lambda: sa.Column("order_item_id", sa.Integer, nullable=True),
    lambda: sa.Column("invoice_item_id", sa.Integer, nullable=True),
    lambda: sa.Column("discount", MONEY, nullable=False, server_default="0"),
    lambda: sa.Column("taxable_amount", MONEY, nullable=False, server_default="0"),
    lambda: sa.Column("tax_rate_percent", sa.Numeric(5, 2), nullable=False, server_default="0"),
    lambda: sa.Column("cgst", MONEY, nullable=False, server_default="0"),
    lambda: sa.Column("sgst", MONEY, nullable=False, server_default="0"),
    lambda: sa.Column("igst", MONEY, nullable=False, server_default="0"),
    lambda: sa.Column("tax", MONEY, nullable=False, server_default="0"),
]

NOTE_COLUMNS = [
    lambda: sa.Column("tax_mode", sa.String(20), nullable=False, server_default="none"),
    lambda: sa.Column("cgst", MONEY, nullable=False, server_default="0"),
    lambda: sa.Column("sgst", MONEY, nullable=False, server_default="0"),
    lambda: sa.Column("igst", MONEY, nullable=False, server_default="0"),
]


def upgrade() -> None:
    new_refund_columns = "gateway_settled" not in _columns("refunds")
    for make in REFUND_COLUMNS:
        _add_column("refunds", make())
    _create_index("ix_refunds_idempotency_key", "refunds", ["idempotency_key"], unique=True)
    _create_index("ix_refunds_next_check_at", "refunds", ["next_check_at"])
    if new_refund_columns:
        # See the docstring: legacy processing/completed refunds were booked when raised.
        op.execute(
            "UPDATE refunds SET gateway_settled = 1, tenders_settled = 1, "
            "completed_effects = CASE WHEN status = 'completed' THEN 1 ELSE 0 END "
            "WHERE status IN ('processing', 'completed')"
        )

    for make in ITEM_COLUMNS:
        _add_column("refund_items", make())
    _create_index("ix_refund_items_order_item_id", "refund_items", ["order_item_id"])
    fks = _foreign_keys("refund_items")
    if "fk_refund_items_order_item_id" not in fks:
        op.create_foreign_key("fk_refund_items_order_item_id", "refund_items", "order_items",
                              ["order_item_id"], ["id"], ondelete="SET NULL")
    if "fk_refund_items_invoice_item_id" not in fks:
        op.create_foreign_key("fk_refund_items_invoice_item_id", "refund_items", "invoice_items",
                              ["invoice_item_id"], ["id"], ondelete="SET NULL")

    for make in NOTE_COLUMNS:
        _add_column("credit_notes", make())


def downgrade() -> None:
    for make in NOTE_COLUMNS:
        _drop_column("credit_notes", make().name)

    fks = _foreign_keys("refund_items")
    for name in ("fk_refund_items_invoice_item_id", "fk_refund_items_order_item_id"):
        if name in fks:
            op.drop_constraint(name, "refund_items", type_="foreignkey")
    _drop_index("ix_refund_items_order_item_id", "refund_items")
    for make in ITEM_COLUMNS:
        _drop_column("refund_items", make().name)

    _drop_index("ix_refunds_next_check_at", "refunds")
    _drop_index("ix_refunds_idempotency_key", "refunds")
    for make in REFUND_COLUMNS:
        _drop_column("refunds", make().name)
