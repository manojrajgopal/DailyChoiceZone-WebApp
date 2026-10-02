"""
Suppliers (the businesses the store buys from), what each supplies, purchase
orders and the goods received against them.

An internal purchasing module, not a marketplace: suppliers never sign in and
nothing here is visible on the storefront. Money is in paise, as in billing.
See docs/shipping-and-suppliers.md.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import BusinessId

Money = BigInteger


class Supplier(Base):
    __tablename__ = "suppliers"

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)  # SUP001
    # The store's own short code for the supplier (ANVI-TEX). Unique.
    code: Mapped[str] = mapped_column(String(30), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    legal_name: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    contact_person: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    phone: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    email: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    website: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    # active | inactive | archived
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="active", index=True)
    # Optional: not every supplier is GST-registered.
    gstin: Mapped[Optional[str]] = mapped_column(String(15), nullable=True)
    pan: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    business_type: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    # registered | unregistered | composition | overseas
    tax_treatment: Mapped[str] = mapped_column(String(20), nullable=False, default="registered")
    billing_address: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    warehouse_address: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    payment_terms: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    credit_days: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="INR")
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_by: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now(),
                                                 onupdate=func.now())


class SupplierProduct(Base):
    """A product a supplier provides, at what cost. Never changes the storefront price."""

    __tablename__ = "supplier_products"
    __table_args__ = (UniqueConstraint("supplier_id", "product_id", name="uq_supplier_products_pair"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    supplier_id: Mapped[str] = mapped_column(BusinessId, ForeignKey("suppliers.id", ondelete="CASCADE"),
                                             nullable=False, index=True)
    product_id: Mapped[str] = mapped_column(BusinessId, ForeignKey("products.id", ondelete="CASCADE"),
                                            nullable=False, index=True)
    supplier_sku: Mapped[str] = mapped_column(String(60), nullable=False, default="")
    purchase_cost: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    moq: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    lead_time_days: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # active | inactive
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="active")
    preferred: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    notes: Mapped[str] = mapped_column(String(1000), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now(),
                                                 onupdate=func.now())

    supplier: Mapped["Supplier"] = relationship()


class PurchaseOrder(Base):
    __tablename__ = "purchase_orders"

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)  # POR001
    # DCZ-PO-2026-000001 (core.numbering).
    po_number: Mapped[str] = mapped_column(String(30), nullable=False, unique=True)
    supplier_id: Mapped[str] = mapped_column(BusinessId, ForeignKey("suppliers.id", ondelete="RESTRICT"),
                                             nullable=False, index=True)
    # draft | submitted | sent | acknowledged | partially-received | received | cancelled
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft", index=True)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="INR")
    # intra-state | inter-state | none
    tax_mode: Mapped[str] = mapped_column(String(12), nullable=False, default="intra-state")
    subtotal: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    cgst: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    sgst: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    igst: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    tax_total: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    total: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    expected_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    supplier_reference: Mapped[str] = mapped_column(String(60), nullable=False, default="")
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="")
    submitted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    sent_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    acknowledged_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    received_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    cancelled_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    cancel_reason: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    created_by: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now(),
                                                 onupdate=func.now())

    supplier: Mapped["Supplier"] = relationship()
    items: Mapped[List["PurchaseOrderItem"]] = relationship(
        back_populates="purchase_order", cascade="all, delete-orphan", order_by="PurchaseOrderItem.id",
    )
    events: Mapped[List["PurchaseOrderEvent"]] = relationship(
        cascade="all, delete-orphan", order_by="PurchaseOrderEvent.id",
    )
    receipts: Mapped[List["GoodsReceipt"]] = relationship(order_by="GoodsReceipt.id")


class PurchaseOrderItem(Base):
    __tablename__ = "purchase_order_items"
    __table_args__ = (UniqueConstraint("purchase_order_id", "product_id", name="uq_purchase_order_items_product"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    purchase_order_id: Mapped[str] = mapped_column(BusinessId, ForeignKey("purchase_orders.id", ondelete="CASCADE"),
                                                   nullable=False, index=True)
    product_id: Mapped[str] = mapped_column(BusinessId, ForeignKey("products.id", ondelete="RESTRICT"),
                                            nullable=False, index=True)
    # Snapshots, so the PO reads the same after the product is renamed.
    name: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    sku: Mapped[str] = mapped_column(String(60), nullable=False, default="")
    supplier_sku: Mapped[str] = mapped_column(String(60), nullable=False, default="")
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    unit_cost: Mapped[int] = mapped_column(Money, nullable=False)
    tax_rate: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False, default=0)
    line_subtotal: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    line_tax: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    line_total: Mapped[int] = mapped_column(Money, nullable=False, default=0)
    received_qty: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    damaged_qty: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rejected_qty: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    purchase_order: Mapped["PurchaseOrder"] = relationship(back_populates="items")


class PurchaseOrderEvent(Base):
    __tablename__ = "purchase_order_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    purchase_order_id: Mapped[str] = mapped_column(BusinessId, ForeignKey("purchase_orders.id", ondelete="CASCADE"),
                                                   nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    note: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    actor: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class GoodsReceipt(Base):
    """One delivery received against a purchase order."""

    __tablename__ = "goods_receipts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # DCZ-GRN-2026-000001 (core.numbering).
    receipt_number: Mapped[str] = mapped_column(String(30), nullable=False, unique=True)
    purchase_order_id: Mapped[str] = mapped_column(BusinessId, ForeignKey("purchase_orders.id", ondelete="RESTRICT"),
                                                   nullable=False, index=True)
    received_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    notes: Mapped[str] = mapped_column(String(1000), nullable=False, default="")
    # The same key again returns the PO unchanged, so stock is never added twice.
    idempotency_key: Mapped[Optional[str]] = mapped_column(String(80), nullable=True, unique=True)
    over_receipt_reason: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    created_by: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now())

    items: Mapped[List["GoodsReceiptItem"]] = relationship(cascade="all, delete-orphan",
                                                          order_by="GoodsReceiptItem.id")


class GoodsReceiptItem(Base):
    __tablename__ = "goods_receipt_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    receipt_id: Mapped[int] = mapped_column(Integer, ForeignKey("goods_receipts.id", ondelete="CASCADE"),
                                            nullable=False, index=True)
    purchase_order_item_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("purchase_order_items.id", ondelete="RESTRICT"), nullable=False, index=True,
    )
    product_id: Mapped[str] = mapped_column(BusinessId, nullable=False)
    received_qty: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    damaged_qty: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rejected_qty: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # received - damaged - rejected: what went into stock.
    accepted_qty: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    note: Mapped[str] = mapped_column(String(300), nullable=False, default="")
