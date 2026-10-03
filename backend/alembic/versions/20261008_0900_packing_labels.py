"""Order packing (jobs, lines, packages, events) and shipping labels

New tables:

- `packing_jobs`: one per order in the warehouse; at most one active per
  order (`active_key`).
- `packing_lines`: the order's lines as picked, with any problem found.
- `packing_packages`: the boxes an order leaves in (DCZ-PKG-2026-000001),
  never deleted (`removed_at`), linked to the shipment they went with.
- `packing_package_items`: how many of each line are in each package.
- `packing_events`: every packing action, who and why.
- `shipping_labels`: each version of a shipment's label, with the frozen
  snapshot it is drawn from; at most one current per shipment (`current_key`).

Purely additive: no existing table or column changes. Safe to run again after
an interruption: every table and index is created only if it is missing.

Revision ID: a1b2c3d4e5f6
Revises: 7c1f4e2a9b35
Create Date: 2026-10-08 09:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, None] = "7c1f4e2a9b35"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ID = sa.String(20)


def _inspector():
    return sa.inspect(op.get_bind())


def _has_table(name: str) -> bool:
    return _inspector().has_table(name)


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


def _now():
    return sa.text("CURRENT_TIMESTAMP")


def upgrade() -> None:
    _create_table(
        "packing_jobs",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("order_id", ID, sa.ForeignKey("orders.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("active_key", sa.String(20), nullable=True, unique=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("priority", sa.String(10), nullable=False, server_default="normal"),
        sa.Column("assigned_to", ID, sa.ForeignKey("admin_users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("assigned_at", sa.DateTime, nullable=True),
        sa.Column("shipment_id", sa.Integer, sa.ForeignKey("shipments.id", ondelete="SET NULL"), nullable=True),
        sa.Column("picking_started_at", sa.DateTime, nullable=True),
        sa.Column("picked_at", sa.DateTime, nullable=True),
        sa.Column("packing_started_at", sa.DateTime, nullable=True),
        sa.Column("packed_at", sa.DateTime, nullable=True),
        sa.Column("packed_by", sa.String(40), nullable=False, server_default=""),
        sa.Column("ready_at", sa.DateTime, nullable=True),
        sa.Column("cancelled_at", sa.DateTime, nullable=True),
        sa.Column("pick_override_reason", sa.String(300), nullable=False, server_default=""),
        sa.Column("pack_override_reason", sa.String(300), nullable=False, server_default=""),
        sa.Column("notes", sa.String(500), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=_now()),
        sa.Column("updated_at", sa.DateTime, nullable=False, server_default=_now()),
    )
    for name, columns in (
        ("ix_packing_jobs_order_id", ["order_id"]),
        ("ix_packing_jobs_status", ["status"]),
        ("ix_packing_jobs_assigned_to", ["assigned_to"]),
        ("ix_packing_jobs_shipment_id", ["shipment_id"]),
        ("ix_packing_jobs_status_priority", ["status", "priority"]),
    ):
        _create_index(name, "packing_jobs", columns)

    _create_table(
        "packing_lines",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("job_id", sa.Integer, sa.ForeignKey("packing_jobs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("order_item_id", sa.Integer, sa.ForeignKey("order_items.id", ondelete="CASCADE"), nullable=False),
        sa.Column("quantity", sa.Integer, nullable=False, server_default="1"),
        sa.Column("picked_qty", sa.Integer, nullable=False, server_default="0"),
        sa.Column("picked_by", sa.String(40), nullable=False, server_default=""),
        sa.Column("picked_at", sa.DateTime, nullable=True),
        sa.Column("exception", sa.String(20), nullable=False, server_default=""),
        sa.Column("exception_qty", sa.Integer, nullable=False, server_default="0"),
        sa.Column("exception_note", sa.String(300), nullable=False, server_default=""),
        sa.Column("exception_by", sa.String(40), nullable=False, server_default=""),
        sa.Column("exception_at", sa.DateTime, nullable=True),
        sa.Column("damaged_recorded_qty", sa.Integer, nullable=False, server_default="0"),
        sa.UniqueConstraint("job_id", "order_item_id", name="uq_packing_lines_item"),
    )
    _create_index("ix_packing_lines_job_id", "packing_lines", ["job_id"])
    _create_index("ix_packing_lines_order_item_id", "packing_lines", ["order_item_id"])

    _create_table(
        "packing_packages",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("job_id", sa.Integer, sa.ForeignKey("packing_jobs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("package_number", sa.String(30), nullable=False, unique=True),
        sa.Column("weight_grams", sa.Integer, nullable=True),
        sa.Column("length_cm", sa.Numeric(8, 2), nullable=True),
        sa.Column("width_cm", sa.Numeric(8, 2), nullable=True),
        sa.Column("height_cm", sa.Numeric(8, 2), nullable=True),
        sa.Column("package_type", sa.String(30), nullable=False, server_default="box"),
        sa.Column("notes", sa.String(300), nullable=False, server_default=""),
        sa.Column("packed_by", sa.String(40), nullable=False, server_default=""),
        sa.Column("packed_at", sa.DateTime, nullable=True),
        sa.Column("shipment_id", sa.Integer, sa.ForeignKey("shipments.id", ondelete="SET NULL"), nullable=True),
        sa.Column("removed_at", sa.DateTime, nullable=True),
        sa.Column("created_by", sa.String(40), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=_now()),
        sa.Column("updated_at", sa.DateTime, nullable=False, server_default=_now()),
    )
    _create_index("ix_packing_packages_job_id", "packing_packages", ["job_id"])
    _create_index("ix_packing_packages_shipment_id", "packing_packages", ["shipment_id"])

    _create_table(
        "packing_package_items",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("package_id", sa.Integer, sa.ForeignKey("packing_packages.id", ondelete="CASCADE"), nullable=False),
        sa.Column("line_id", sa.Integer, sa.ForeignKey("packing_lines.id", ondelete="CASCADE"), nullable=False),
        sa.Column("quantity", sa.Integer, nullable=False, server_default="1"),
        sa.UniqueConstraint("package_id", "line_id", name="uq_packing_package_items_line"),
    )
    _create_index("ix_packing_package_items_package_id", "packing_package_items", ["package_id"])
    _create_index("ix_packing_package_items_line_id", "packing_package_items", ["line_id"])

    _create_table(
        "packing_events",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("job_id", sa.Integer, sa.ForeignKey("packing_jobs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("action", sa.String(30), nullable=False),
        sa.Column("from_status", sa.String(20), nullable=False, server_default=""),
        sa.Column("to_status", sa.String(20), nullable=False, server_default=""),
        sa.Column("note", sa.String(500), nullable=False, server_default=""),
        sa.Column("details", sa.JSON, nullable=False),
        sa.Column("actor", sa.String(40), nullable=False, server_default=""),
        sa.Column("occurred_at", sa.DateTime, nullable=False),
    )
    _create_index("ix_packing_events_job_id", "packing_events", ["job_id"])

    _create_table(
        "shipping_labels",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("shipment_id", sa.Integer, sa.ForeignKey("shipments.id", ondelete="CASCADE"), nullable=False),
        sa.Column("version", sa.Integer, nullable=False, server_default="1"),
        sa.Column("current_key", sa.Integer, nullable=True, unique=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="generating"),
        sa.Column("format", sa.String(20), nullable=False, server_default="thermal-4x6"),
        sa.Column("snapshot", sa.JSON, nullable=False),
        sa.Column("page_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("generated_by", sa.String(40), nullable=False, server_default=""),
        sa.Column("generated_at", sa.DateTime, nullable=True),
        sa.Column("reason", sa.String(300), nullable=False, server_default=""),
        sa.Column("provider_reference", sa.String(64), nullable=False, server_default=""),
        sa.Column("external_url", sa.String(1000), nullable=False, server_default=""),
        sa.Column("error_message", sa.String(500), nullable=False, server_default=""),
        sa.Column("error_code", sa.String(40), nullable=False, server_default=""),
        sa.Column("superseded_at", sa.DateTime, nullable=True),
        sa.Column("cancelled_at", sa.DateTime, nullable=True),
        sa.Column("cancel_reason", sa.String(300), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=_now()),
        sa.Column("updated_at", sa.DateTime, nullable=False, server_default=_now()),
        sa.UniqueConstraint("shipment_id", "version", name="uq_shipping_labels_version"),
    )
    _create_index("ix_shipping_labels_shipment_id", "shipping_labels", ["shipment_id"])
    _create_index("ix_shipping_labels_status_generated", "shipping_labels", ["status", "generated_at"])


def downgrade() -> None:
    # Children before parents. Only for a deliberate rollback by a person;
    # startup only ever upgrades.
    for table in ("shipping_labels", "packing_events", "packing_package_items", "packing_packages",
                  "packing_lines", "packing_jobs"):
        if _has_table(table):
            op.drop_table(table)
