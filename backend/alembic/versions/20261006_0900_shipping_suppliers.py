"""Shipment tracking, courier providers, suppliers, purchase orders and goods receiving

New tables:

- `shipping_providers`: one configured courier integration per adapter code,
  with sealed credentials.
- `shipments`: one parcel for an order. At most one active per order
  (`active_key`). AWBs and provider shipment ids are unique per provider.
- `shipment_events`: the tracking timeline, unique per shipment by `dedupe_key`.
- `shipping_webhook_events`: courier webhook deliveries, unique per provider
  by `event_key`.
- `suppliers`, `supplier_products`: who the store buys from, and what each supplies.
- `purchase_orders`, `purchase_order_items`, `purchase_order_events`.
- `goods_receipts`, `goods_receipt_items`: deliveries received against a PO.

Purely additive: no existing table or column changes. Safe to run again after
an interruption: every table and index is created only if it is missing.

Revision ID: d7f9b1c3e5a7
Revises: c4e6a8b0d2f1
Create Date: 2026-10-06 09:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d7f9b1c3e5a7"
down_revision: Union[str, None] = "c4e6a8b0d2f1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ID = sa.String(20)
MONEY = sa.BigInteger


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
        "shipping_providers",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("code", sa.String(30), nullable=False, unique=True),
        sa.Column("name", sa.String(80), nullable=False, server_default=""),
        sa.Column("environment", sa.String(12), nullable=False, server_default="production"),
        sa.Column("active", sa.Boolean, nullable=False, server_default="0"),
        sa.Column("is_default", sa.Boolean, nullable=False, server_default="0"),
        sa.Column("credentials", sa.Text, nullable=False),
        sa.Column("settings", sa.JSON, nullable=False),
        sa.Column("last_tested_at", sa.DateTime, nullable=True),
        sa.Column("last_test_ok", sa.Boolean, nullable=True),
        sa.Column("last_error", sa.String(500), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=_now()),
        sa.Column("updated_at", sa.DateTime, nullable=False, server_default=_now()),
    )

    _create_table(
        "shipments",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("shipment_number", sa.String(30), nullable=False, unique=True),
        sa.Column("order_id", ID, sa.ForeignKey("orders.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("provider_id", sa.Integer, sa.ForeignKey("shipping_providers.id", ondelete="RESTRICT"),
                  nullable=False),
        sa.Column("provider_code", sa.String(30), nullable=False),
        sa.Column("active_key", sa.String(20), nullable=True, unique=True),
        sa.Column("idempotency_key", sa.String(80), nullable=True, unique=True),
        sa.Column("courier_name", sa.String(120), nullable=False, server_default=""),
        sa.Column("courier_code", sa.String(40), nullable=False, server_default=""),
        sa.Column("service", sa.String(60), nullable=False, server_default=""),
        sa.Column("provider_order_id", sa.String(64), nullable=True),
        sa.Column("provider_shipment_id", sa.String(64), nullable=True),
        sa.Column("awb", sa.String(64), nullable=True),
        sa.Column("status", sa.String(30), nullable=False, server_default="pending"),
        sa.Column("weight_grams", sa.Integer, nullable=True),
        sa.Column("length_cm", sa.Numeric(8, 2), nullable=True),
        sa.Column("width_cm", sa.Numeric(8, 2), nullable=True),
        sa.Column("height_cm", sa.Numeric(8, 2), nullable=True),
        sa.Column("package_count", sa.Integer, nullable=False, server_default="1"),
        sa.Column("package_type", sa.String(30), nullable=False, server_default="box"),
        sa.Column("cod", sa.Boolean, nullable=False, server_default="0"),
        sa.Column("cod_amount", MONEY, nullable=False, server_default="0"),
        sa.Column("declared_value", MONEY, nullable=False, server_default="0"),
        sa.Column("origin", sa.JSON, nullable=False),
        sa.Column("destination", sa.JSON, nullable=False),
        sa.Column("expected_delivery_at", sa.DateTime, nullable=True),
        sa.Column("label_url", sa.String(1000), nullable=False, server_default=""),
        sa.Column("pickup_status", sa.String(20), nullable=False, server_default=""),
        sa.Column("pickup_scheduled_at", sa.DateTime, nullable=True),
        sa.Column("pickup_token", sa.String(64), nullable=False, server_default=""),
        sa.Column("request_status", sa.String(12), nullable=False, server_default="pending"),
        sa.Column("last_operation", sa.String(20), nullable=False, server_default=""),
        sa.Column("last_error", sa.String(500), nullable=False, server_default=""),
        sa.Column("last_error_at", sa.DateTime, nullable=True),
        sa.Column("last_error_transient", sa.Boolean, nullable=False, server_default="0"),
        sa.Column("retry_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("next_retry_at", sa.DateTime, nullable=True),
        sa.Column("last_synced_at", sa.DateTime, nullable=True),
        sa.Column("next_sync_at", sa.DateTime, nullable=True),
        sa.Column("last_webhook_at", sa.DateTime, nullable=True),
        sa.Column("alerts_sent", sa.JSON, nullable=False),
        sa.Column("delivered_at", sa.DateTime, nullable=True),
        sa.Column("cancelled_at", sa.DateTime, nullable=True),
        sa.Column("cancel_reason", sa.String(300), nullable=False, server_default=""),
        sa.Column("created_by", sa.String(40), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=_now()),
        sa.Column("updated_at", sa.DateTime, nullable=False, server_default=_now()),
        sa.UniqueConstraint("provider_id", "provider_shipment_id", name="uq_shipments_provider_shipment"),
        sa.UniqueConstraint("provider_id", "awb", name="uq_shipments_provider_awb"),
    )
    for name, columns in (
        ("ix_shipments_order_id", ["order_id"]),
        ("ix_shipments_provider_id", ["provider_id"]),
        ("ix_shipments_awb", ["awb"]),
        ("ix_shipments_status", ["status"]),
        ("ix_shipments_status_sync", ["status", "next_sync_at"]),
        ("ix_shipments_retry", ["request_status", "next_retry_at"]),
    ):
        _create_index(name, "shipments", columns)

    _create_table(
        "shipment_events",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("shipment_id", sa.Integer, sa.ForeignKey("shipments.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(30), nullable=False, server_default=""),
        sa.Column("provider_status", sa.String(120), nullable=False, server_default=""),
        sa.Column("description", sa.String(500), nullable=False, server_default=""),
        sa.Column("location", sa.String(160), nullable=False, server_default=""),
        sa.Column("occurred_at", sa.DateTime, nullable=False),
        sa.Column("received_at", sa.DateTime, nullable=False),
        sa.Column("source", sa.String(12), nullable=False, server_default="system"),
        sa.Column("actor", sa.String(40), nullable=False, server_default=""),
        sa.Column("visible", sa.Boolean, nullable=False, server_default="1"),
        sa.Column("dedupe_key", sa.String(80), nullable=False),
        sa.UniqueConstraint("shipment_id", "dedupe_key", name="uq_shipment_events_dedupe"),
    )
    _create_index("ix_shipment_events_shipment_id", "shipment_events", ["shipment_id"])

    _create_table(
        "shipping_webhook_events",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("provider_code", sa.String(30), nullable=False),
        sa.Column("event_key", sa.String(80), nullable=False),
        sa.Column("shipment_id", sa.Integer, sa.ForeignKey("shipments.id", ondelete="SET NULL"), nullable=True),
        sa.Column("status", sa.String(12), nullable=False, server_default="processed"),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="1"),
        sa.Column("last_error", sa.String(500), nullable=False, server_default=""),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.Column("received_at", sa.DateTime, nullable=False),
        sa.Column("processed_at", sa.DateTime, nullable=True),
        sa.UniqueConstraint("provider_code", "event_key", name="uq_shipping_webhook_events_key"),
    )
    _create_index("ix_shipping_webhook_events_shipment_id", "shipping_webhook_events", ["shipment_id"])
    _create_index("ix_shipping_webhook_events_status", "shipping_webhook_events", ["status"])

    _create_table(
        "suppliers",
        sa.Column("id", ID, primary_key=True),
        sa.Column("code", sa.String(30), nullable=False, unique=True),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("legal_name", sa.String(200), nullable=False, server_default=""),
        sa.Column("contact_person", sa.String(120), nullable=False, server_default=""),
        sa.Column("phone", sa.String(20), nullable=False, server_default=""),
        sa.Column("email", sa.String(255), nullable=False, server_default=""),
        sa.Column("website", sa.String(255), nullable=False, server_default=""),
        sa.Column("status", sa.String(12), nullable=False, server_default="active"),
        sa.Column("gstin", sa.String(15), nullable=True),
        sa.Column("pan", sa.String(10), nullable=True),
        sa.Column("business_type", sa.String(40), nullable=False, server_default=""),
        sa.Column("tax_treatment", sa.String(20), nullable=False, server_default="registered"),
        sa.Column("billing_address", sa.JSON, nullable=False),
        sa.Column("warehouse_address", sa.JSON, nullable=True),
        sa.Column("payment_terms", sa.String(120), nullable=False, server_default=""),
        sa.Column("credit_days", sa.Integer, nullable=True),
        sa.Column("currency", sa.String(3), nullable=False, server_default="INR"),
        sa.Column("notes", sa.Text, nullable=False),
        sa.Column("created_by", sa.String(40), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=_now()),
        sa.Column("updated_at", sa.DateTime, nullable=False, server_default=_now()),
    )
    _create_index("ix_suppliers_status", "suppliers", ["status"])

    _create_table(
        "supplier_products",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("supplier_id", ID, sa.ForeignKey("suppliers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("product_id", ID, sa.ForeignKey("products.id", ondelete="CASCADE"), nullable=False),
        sa.Column("supplier_sku", sa.String(60), nullable=False, server_default=""),
        sa.Column("purchase_cost", MONEY, nullable=False, server_default="0"),
        sa.Column("moq", sa.Integer, nullable=False, server_default="1"),
        sa.Column("lead_time_days", sa.Integer, nullable=True),
        sa.Column("status", sa.String(12), nullable=False, server_default="active"),
        sa.Column("preferred", sa.Boolean, nullable=False, server_default="0"),
        sa.Column("notes", sa.String(1000), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=_now()),
        sa.Column("updated_at", sa.DateTime, nullable=False, server_default=_now()),
        sa.UniqueConstraint("supplier_id", "product_id", name="uq_supplier_products_pair"),
    )
    _create_index("ix_supplier_products_supplier_id", "supplier_products", ["supplier_id"])
    _create_index("ix_supplier_products_product_id", "supplier_products", ["product_id"])

    _create_table(
        "purchase_orders",
        sa.Column("id", ID, primary_key=True),
        sa.Column("po_number", sa.String(30), nullable=False, unique=True),
        sa.Column("supplier_id", ID, sa.ForeignKey("suppliers.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="draft"),
        sa.Column("currency", sa.String(3), nullable=False, server_default="INR"),
        sa.Column("tax_mode", sa.String(12), nullable=False, server_default="intra-state"),
        sa.Column("subtotal", MONEY, nullable=False, server_default="0"),
        sa.Column("cgst", MONEY, nullable=False, server_default="0"),
        sa.Column("sgst", MONEY, nullable=False, server_default="0"),
        sa.Column("igst", MONEY, nullable=False, server_default="0"),
        sa.Column("tax_total", MONEY, nullable=False, server_default="0"),
        sa.Column("total", MONEY, nullable=False, server_default="0"),
        sa.Column("expected_at", sa.DateTime, nullable=True),
        sa.Column("supplier_reference", sa.String(60), nullable=False, server_default=""),
        sa.Column("notes", sa.Text, nullable=False),
        sa.Column("submitted_at", sa.DateTime, nullable=True),
        sa.Column("sent_at", sa.DateTime, nullable=True),
        sa.Column("acknowledged_at", sa.DateTime, nullable=True),
        sa.Column("received_at", sa.DateTime, nullable=True),
        sa.Column("cancelled_at", sa.DateTime, nullable=True),
        sa.Column("cancel_reason", sa.String(300), nullable=False, server_default=""),
        sa.Column("created_by", sa.String(40), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=_now()),
        sa.Column("updated_at", sa.DateTime, nullable=False, server_default=_now()),
    )
    _create_index("ix_purchase_orders_supplier_id", "purchase_orders", ["supplier_id"])
    _create_index("ix_purchase_orders_status", "purchase_orders", ["status"])

    _create_table(
        "purchase_order_items",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("purchase_order_id", ID, sa.ForeignKey("purchase_orders.id", ondelete="CASCADE"), nullable=False),
        sa.Column("product_id", ID, sa.ForeignKey("products.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False, server_default=""),
        sa.Column("sku", sa.String(60), nullable=False, server_default=""),
        sa.Column("supplier_sku", sa.String(60), nullable=False, server_default=""),
        sa.Column("quantity", sa.Integer, nullable=False),
        sa.Column("unit_cost", MONEY, nullable=False),
        sa.Column("tax_rate", sa.Numeric(5, 2), nullable=False, server_default="0"),
        sa.Column("line_subtotal", MONEY, nullable=False, server_default="0"),
        sa.Column("line_tax", MONEY, nullable=False, server_default="0"),
        sa.Column("line_total", MONEY, nullable=False, server_default="0"),
        sa.Column("received_qty", sa.Integer, nullable=False, server_default="0"),
        sa.Column("damaged_qty", sa.Integer, nullable=False, server_default="0"),
        sa.Column("rejected_qty", sa.Integer, nullable=False, server_default="0"),
        sa.UniqueConstraint("purchase_order_id", "product_id", name="uq_purchase_order_items_product"),
    )
    _create_index("ix_purchase_order_items_purchase_order_id", "purchase_order_items", ["purchase_order_id"])
    _create_index("ix_purchase_order_items_product_id", "purchase_order_items", ["product_id"])

    _create_table(
        "purchase_order_events",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("purchase_order_id", ID, sa.ForeignKey("purchase_orders.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("note", sa.String(500), nullable=False, server_default=""),
        sa.Column("actor", sa.String(40), nullable=False, server_default=""),
        sa.Column("occurred_at", sa.DateTime, nullable=False),
    )
    _create_index("ix_purchase_order_events_purchase_order_id", "purchase_order_events", ["purchase_order_id"])

    _create_table(
        "goods_receipts",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("receipt_number", sa.String(30), nullable=False, unique=True),
        sa.Column("purchase_order_id", ID, sa.ForeignKey("purchase_orders.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("received_at", sa.DateTime, nullable=False),
        sa.Column("notes", sa.String(1000), nullable=False, server_default=""),
        sa.Column("idempotency_key", sa.String(80), nullable=True, unique=True),
        sa.Column("over_receipt_reason", sa.String(300), nullable=False, server_default=""),
        sa.Column("created_by", sa.String(40), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=_now()),
    )
    _create_index("ix_goods_receipts_purchase_order_id", "goods_receipts", ["purchase_order_id"])

    _create_table(
        "goods_receipt_items",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("receipt_id", sa.Integer, sa.ForeignKey("goods_receipts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("purchase_order_item_id", sa.Integer,
                  sa.ForeignKey("purchase_order_items.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("product_id", ID, nullable=False),
        sa.Column("received_qty", sa.Integer, nullable=False, server_default="0"),
        sa.Column("damaged_qty", sa.Integer, nullable=False, server_default="0"),
        sa.Column("rejected_qty", sa.Integer, nullable=False, server_default="0"),
        sa.Column("accepted_qty", sa.Integer, nullable=False, server_default="0"),
        sa.Column("note", sa.String(300), nullable=False, server_default=""),
    )
    _create_index("ix_goods_receipt_items_receipt_id", "goods_receipt_items", ["receipt_id"])
    _create_index("ix_goods_receipt_items_purchase_order_item_id", "goods_receipt_items", ["purchase_order_item_id"])


def downgrade() -> None:
    # Children before parents. Only for a deliberate rollback by a person;
    # startup only ever upgrades.
    for table in (
        "goods_receipt_items", "goods_receipts", "purchase_order_events", "purchase_order_items",
        "purchase_orders", "supplier_products", "suppliers", "shipping_webhook_events", "shipment_events",
        "shipments", "shipping_providers",
    ):
        if _has_table(table):
            op.drop_table(table)
