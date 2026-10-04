"""
What can be looked up, by which identifiers, and by whom.

One entry per entity. Adding an entity is one `Entity(...)` here and a preview
in `previews.py`; the routes, the global search and the portal's selector pick
it up from this table.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Dict, FrozenSet, Optional, Tuple

from app.core.errors import ValidationError
from app.core.numbering import (
    GOODS_RECEIPT,
    INVOICE,
    PACKAGE,
    PURCHASE_ORDER,
    REFUND,
    SHIPMENT,
    TICKET,
    CREDIT_NOTE,
    ORDER_PREFIX,
)
from app.models import (
    Address,
    AdminUser,
    Banner,
    Category,
    Collection,
    Coupon,
    CreditNote,
    Customer,
    CustomerMembership,
    Invoice,
    MembershipPlan,
    Order,
    Payment,
    Product,
    Refund,
    ReturnRequest,
    Review,
    SupportTicket,
)
from app.models.delivery import DeliveryPincode
from app.models.discovery import SizeGuide
from app.models.engagement import ProductQuestion
from app.models.fulfilment import PackingPackage
from app.models.growth import Bundle, FlashSale
from app.models.messaging import DatabaseBackup, MarketingCampaign
from app.models.billing import WebhookEvent
from app.models.catalogue import StockAdjustment
from app.models.fulfilment import PackingJob
from app.models.growth import ReferralCode
from app.models.reconciliation import PaymentReconciliation
from app.models.support import SupportAgent
from app.models.segments import Segment
from app.models.shipping import Shipment, ShippingProvider
from app.models.suppliers import GoodsReceipt, PurchaseOrder, Supplier
from app.models.wallet import GiftCard
from app.services.lookup import previews
from app.utils.ids import PREFIXES

#: The most suggestions one request may ask for. An autocomplete shows ten.
MAX_LIMIT = 20
DEFAULT_LIMIT = 10
#: Longer than any identifier the store issues (the longest are gateway ids).
MAX_ID_LENGTH = 64

# Letters, digits and the separators identifiers really contain. Anything else
# (spaces are removed first) cannot be part of an ID, so it is refused rather
# than searched for.
_ID_TEXT = re.compile(r"^[A-Z0-9][A-Z0-9_.-]*$")


def normalise(raw: Optional[str], *, label: str = "ID") -> str:
    """
    What was typed, as an identifier: no spaces, upper case, no leading `#`.

    Raises a 422 for text no identifier could contain. Identifier columns use
    MySQL's case-insensitive collation, so upper-casing never loses a match —
    it only makes `prd001` and `PRD001` the same request.
    """
    text = re.sub(r"\s+", "", raw or "").upper().lstrip("#")
    if len(text) > MAX_ID_LENGTH:
        raise ValidationError(f"That is longer than any {label}.", error_code="LOOKUP_INVALID_ID")
    if text and not _ID_TEXT.match(text):
        raise ValidationError(
            f"Invalid {label}. IDs contain only letters, numbers and dashes.",
            error_code="LOOKUP_INVALID_ID",
        )
    return text


@dataclass(frozen=True)
class IdColumn:
    """
    One identifier column.

    kind:
      - "business": a `PRD001`-style id. Dashes are ignored (`PRD-001` is
        `PRD001`) and bare digits are tried after the prefix.
      - "text": a document number or code, matched as typed.
      - "int": an integer key, shown with `display_prefix` (`GC12`).

    `starts` is what every value begins with, when that is known. A query that
    cannot begin that way skips the column without asking the database.

    `contains`: digits may match anywhere — for yearly numbers such as
    `DCZ-SH-2026-000123`, where the running number is at the end.
    """

    attr: str
    kind: str = "text"
    starts: str = ""
    contains: bool = False
    display_prefix: str = ""


@dataclass(frozen=True)
class Entity:
    key: str
    label: str  # "Product" → "Product ID"
    model: type
    #: The first column is the ID people see; the rest also find the record.
    columns: Tuple[IdColumn, ...]
    preview: Callable
    example: str
    #: Admin permissions, any one of which opens it. None: every administrator
    #: (the area's own read endpoints ask for nothing more).
    access: Optional[FrozenSet[str]] = None
    #: Row-level limits beyond the permission: `scope(db, admin)` returns the
    #: extra WHERE conditions (support agents see their team's tickets), or
    #: raises AuthorizationError when this administrator may see none.
    scope: Optional[Callable] = None
    #: Customer lookups: the column that must equal the signed-in customer.
    owner: Optional[str] = None
    #: Values that change minute to minute (stock, status, money): a client
    #: must not cache the preview.
    volatile: bool = True

    @property
    def id_label(self) -> str:
        return f"{self.label} ID"

    def describe(self) -> dict:
        return {
            "entity": self.key,
            "label": self.label,
            "idLabel": self.id_label,
            "example": self.example,
            "volatile": self.volatile,
        }


def _business(entity: str) -> IdColumn:
    prefix = PREFIXES[entity]
    return IdColumn("id", kind="business", starts=prefix)


def _yearly(attr: str, prefix: str) -> IdColumn:
    return IdColumn(attr, starts=prefix + "-", contains=True)


def _any(*permissions: str) -> FrozenSet[str]:
    return frozenset(permissions)


_ADMIN = [
    # --- catalogue
    Entity("product", "Product", Product, (_business("product"), IdColumn("sku")),
           previews.product, "PRD001", volatile=True),
    Entity("category", "Category", Category, (_business("category"),),
           previews.category, "CAT001", volatile=False),
    Entity("collection", "Collection", Collection, (_business("collection"),),
           previews.collection, "COL001", volatile=False),
    Entity("size_guide", "Size guide", SizeGuide, (_business("size_guide"),),
           previews.size_guide, "SZG001", access=_any("products"), volatile=False),
    Entity("review", "Review", Review, (_business("review"),), previews.review, "REV001"),
    Entity("question", "Question", ProductQuestion, (IdColumn("id", kind="int"),),
           previews.question, "12", access=_any("questions")),
    Entity("stock_adjustment", "Stock adjustment", StockAdjustment, (IdColumn("id", kind="int"),),
           previews.stock_adjustment, "41", access=_any("products"), volatile=False),
    # --- people
    Entity("customer", "Customer", Customer, (_business("customer"),), previews.customer, "CUS001",
           # Mirrors GET /admin/customers/{id}: staff working an order may open its customer.
           access=_any("customers", "orders")),
    Entity("address", "Address", Address, (_business("address"),), previews.address, "ADR001",
           access=_any("customers", "orders")),
    Entity("admin_user", "Admin user", AdminUser, (_business("admin_user"),), previews.admin_user,
           "ADM001", volatile=False),
    # --- orders and money
    Entity("order", "Order", Order,
           (IdColumn("order_number", starts=ORDER_PREFIX, contains=True), _business("order")),
           previews.order, f"{ORDER_PREFIX}10001"),
    Entity("invoice", "Invoice", Invoice,
           (_yearly("invoice_number", INVOICE.prefix), _business("invoice")),
           previews.invoice, INVOICE.yearly(2026, 1)),
    Entity("payment", "Payment", Payment, (_business("payment"), IdColumn("transaction_id")),
           previews.payment, "PAY001"),
    Entity("refund", "Refund", Refund,
           (_yearly("refund_number", REFUND.prefix), _business("refund"), IdColumn("gateway_reference")),
           previews.refund, REFUND.yearly(2026, 1)),
    Entity("credit_note", "Credit note", CreditNote,
           (_yearly("credit_note_number", CREDIT_NOTE.prefix), _business("credit_note")),
           previews.credit_note, CREDIT_NOTE.yearly(2026, 1)),
    Entity("return", "Return", ReturnRequest, (_business("return_request"),), previews.return_request,
           "RET001", access=_any("orders")),
    Entity("coupon", "Coupon", Coupon, (_business("coupon"), IdColumn("code")), previews.coupon, "CPN001"),
    Entity("gift_card", "Gift card", GiftCard, (IdColumn("id", kind="int", display_prefix="GC"),),
           previews.gift_card, "GC12", access=_any("gift-cards")),
    Entity("webhook_event", "Webhook event", WebhookEvent, (IdColumn("event_id"),),
           previews.webhook_event, "evt_…", access=_any("payments")),
    Entity("reconciliation", "Reconciliation", PaymentReconciliation,
           (IdColumn("id", kind="int"), IdColumn("gateway_payment_id")),
           previews.reconciliation, "15", access=_any("payments")),
    # --- fulfilment
    Entity("shipment", "Shipment", Shipment,
           (_yearly("shipment_number", SHIPMENT.prefix), IdColumn("awb")),
           previews.shipment, SHIPMENT.yearly(2026, 1), access=_any("shipments")),
    Entity("packing_job", "Packing job", PackingJob, (IdColumn("id", kind="int"),),
           previews.packing_job, "8", access=_any("packing")),
    Entity("package", "Package", PackingPackage, (_yearly("package_number", PACKAGE.prefix),),
           previews.package, PACKAGE.yearly(2026, 1), access=_any("packing")),
    Entity("courier", "Courier", ShippingProvider, (IdColumn("code"),), previews.courier, "shiprocket",
           access=_any("shipments", "shipping-config"), volatile=False),
    Entity("pincode", "Pincode", DeliveryPincode, (IdColumn("pincode", contains=False),),
           previews.pincode, "560001", access=_any("shipping"), volatile=False),
    # --- purchasing
    Entity("supplier", "Supplier", Supplier, (_business("supplier"), IdColumn("code")),
           previews.supplier, "SUP001", access=_any("suppliers", "purchasing"), volatile=False),
    Entity("purchase_order", "Purchase order", PurchaseOrder,
           (_yearly("po_number", PURCHASE_ORDER.prefix), _business("purchase_order")),
           previews.purchase_order, PURCHASE_ORDER.yearly(2026, 1), access=_any("purchasing")),
    Entity("goods_receipt", "Goods receipt", GoodsReceipt,
           (_yearly("receipt_number", GOODS_RECEIPT.prefix),),
           previews.goods_receipt, GOODS_RECEIPT.yearly(2026, 1), access=_any("purchasing")),
    # --- support
    Entity("ticket", "Support ticket", SupportTicket,
           (_yearly("number", TICKET.prefix), _business("support_ticket")),
           # Not a permission: the support desk's own rule (`tickets.can_work`).
           previews.ticket, TICKET.yearly(2026, 1), scope=previews.ticket_scope),
    # Desk staff pick an agent to assign or filter by: the desk's own read permission.
    Entity("support_agent", "Support agent", SupportAgent, (IdColumn("id", kind="int"),),
           previews.support_agent, "5", access=_any("support", "support-config"), volatile=False),
    # --- marketing and membership
    Entity("banner", "Banner", Banner, (_business("banner"),), previews.banner, "BNR001", volatile=False),
    Entity("membership_plan", "Membership plan", MembershipPlan, (_business("membership_plan"),),
           previews.membership_plan, "MBP001", access=_any("customers"), volatile=False),
    Entity("membership", "Membership", CustomerMembership, (_business("membership"),),
           previews.membership, "MEM001", access=_any("customers")),
    Entity("referral_code", "Referral code", ReferralCode, (IdColumn("code"),), previews.referral_code,
           "ASHA2026", access=_any("referrals")),
    Entity("segment", "Segment", Segment, (IdColumn("id", kind="int"),), previews.segment, "3",
           access=_any("segments")),
    Entity("campaign", "Campaign", MarketingCampaign, (IdColumn("id", kind="int"),), previews.campaign,
           "7", access=_any("campaigns")),
    Entity("flash_sale", "Flash sale", FlashSale, (IdColumn("id", kind="int"),), previews.flash_sale, "4",
           access=_any("flash-sales")),
    Entity("bundle", "Bundle", Bundle, (IdColumn("id", kind="int"),), previews.bundle, "2",
           access=_any("bundles")),
    # --- operations
    Entity("backup", "Backup", DatabaseBackup, (IdColumn("reference", starts="BKP-", contains=True),),
           previews.backup, "BKP-20261003-020000-AB12", access=_any("backups")),
]

ADMIN_ENTITIES: Dict[str, Entity] = {entity.key: entity for entity in _ADMIN}


# A customer finds only their own records, and sees the customer-facing
# preview — never an internal note, an agent, or another customer's details.
_CUSTOMER = [
    Entity("order", "Order", Order,
           (IdColumn("order_number", starts=ORDER_PREFIX, contains=True), _business("order")),
           previews.my_order, f"{ORDER_PREFIX}10001", owner="customer_id"),
    Entity("invoice", "Invoice", Invoice,
           (_yearly("invoice_number", INVOICE.prefix), _business("invoice")),
           previews.my_invoice, INVOICE.yearly(2026, 1), owner="customer_id"),
    Entity("refund", "Refund", Refund,
           (_yearly("refund_number", REFUND.prefix), _business("refund")),
           previews.my_refund, REFUND.yearly(2026, 1), owner="customer_id"),
    Entity("return", "Return", ReturnRequest, (_business("return_request"),),
           previews.my_return, "RET001", owner="customer_id"),
    Entity("ticket", "Support request", SupportTicket,
           (_yearly("number", TICKET.prefix), _business("support_ticket")),
           previews.my_ticket, TICKET.yearly(2026, 1), owner="customer_id"),
    Entity("address", "Address", Address, (_business("address"),), previews.my_address, "ADR001",
           owner="customer_id", volatile=False),
]

CUSTOMER_ENTITIES: Dict[str, Entity] = {entity.key: entity for entity in _CUSTOMER}

__all__ = ["ADMIN_ENTITIES", "CUSTOMER_ENTITIES", "Entity", "IdColumn", "MAX_LIMIT", "DEFAULT_LIMIT", "normalise"]
