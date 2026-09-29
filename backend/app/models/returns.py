"""Returns and replacements, requested by a customer after delivery."""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import BusinessId


class ReturnRequest(Base):
    """
    One request to send items back — for a refund (`kind="return"`) or for the
    same item again (`kind="replacement"`).

    Its own record rather than a status on the order: one order can have a
    returned shirt, a replaced pair of shoes and a kept jacket, each moving at
    its own pace. `events` is the append-only history the customer and the
    store both read.
    """

    __tablename__ = "return_requests"

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    order_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("orders.id", ondelete="CASCADE"), nullable=False, index=True
    )
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    order_number: Mapped[str] = mapped_column(String(30), nullable=False, default="")
    customer_name: Mapped[str] = mapped_column(String(160), nullable=False, default="")

    kind: Mapped[str] = mapped_column(String(12), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="requested", index=True)
    reason: Mapped[str] = mapped_column(String(120), nullable=False)
    comment: Mapped[str] = mapped_column(String(1000), nullable=False, default="")
    # The store's note to the customer — why it was rejected, pickup details.
    resolution_note: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    refund_id: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    # Refund value of the items, in minor units, fixed when the request is made.
    amount: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    items: Mapped[List["ReturnRequestItem"]] = relationship(
        back_populates="request", cascade="all, delete-orphan", lazy="selectin"
    )
    events: Mapped[List["ReturnEvent"]] = relationship(
        back_populates="request",
        cascade="all, delete-orphan",
        order_by="ReturnEvent.occurred_at",
        lazy="selectin",
    )


class ReturnRequestItem(Base):
    __tablename__ = "return_request_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    request_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("return_requests.id", ondelete="CASCADE"), nullable=False, index=True
    )
    order_item_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("order_items.id", ondelete="CASCADE"), nullable=False, index=True
    )
    product_id: Mapped[str] = mapped_column(BusinessId, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    image: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    size: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)
    color: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    # What these units were actually paid for, in minor units.
    amount: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    request: Mapped[ReturnRequest] = relationship(back_populates="items")


class ReturnEvent(Base):
    __tablename__ = "return_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    request_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("return_requests.id", ondelete="CASCADE"), nullable=False, index=True
    )
    status: Mapped[str] = mapped_column(String(24), nullable=False)
    note: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    # "customer", an admin id, or "system".
    actor: Mapped[str] = mapped_column(String(40), nullable=False, default="system")
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    request: Mapped[ReturnRequest] = relationship(back_populates="events")
