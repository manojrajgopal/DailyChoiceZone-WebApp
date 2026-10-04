"""
The short card shown once an ID has been picked.

Each builder takes the row and returns the main facts — what someone checking
"is this the right one?" needs — not every column. Nothing secret is ever
here: no password hashes, tokens, credentials, gateway payloads or internal
keys, and the customer-facing builders (`my_*`) leave out anything internal
(notes, agents, other people).

Money is always in minor units (paise), whatever the table stores, so the
client formats every amount the same way. `related` lists the IDs this record
points at, so the card can link onward by ID.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Iterable, List, Optional

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models import Order, OrderItem, ProductImage


# ----------------------------------------------------------------- helpers


def _paise(value: Any) -> int:
    """Numeric(12, 2) rupees → paise. (BIGINT money columns are paise already.)"""
    if value is None:
        return 0
    return int((Decimal(str(value)) * 100).quantize(Decimal("1")))


def _when(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def field(label: str, value: Any, kind: str = "text") -> Optional[dict]:
    """One row of the card. Empty values are dropped rather than shown as blanks."""
    if value is None or value == "":
        return None
    if kind == "date":
        value = _when(value)
    return {"label": label, "value": value, "format": kind}


def related(entity: str, identifier: Any, label: str) -> Optional[dict]:
    if identifier in (None, ""):
        return None
    return {"entity": entity, "id": str(identifier), "label": label}


def card(*, title: str, subtitle: str = "", status: str = "", image: Optional[str] = None,
         fields: Iterable[Optional[dict]] = (), links: Iterable[Optional[dict]] = ()) -> dict:
    return {
        "title": title or "",
        "subtitle": subtitle or "",
        "status": status or "",
        "image": image,
        "fields": [f for f in fields if f],
        "related": [r for r in links if r],
    }


def _first_image(db: Session, product_id: str) -> Optional[str]:
    return db.execute(
        select(ProductImage.url).where(ProductImage.product_id == product_id)
        .order_by(ProductImage.position, ProductImage.id).limit(1)
    ).scalar_one_or_none()


def _count(db: Session, statement) -> int:
    return int(db.execute(statement).scalar() or 0)


# --------------------------------------------------------------- catalogue


def product(db: Session, row) -> dict:
    available = max(int(row.stock or 0) - int(row.reserved_stock or 0), 0)
    return card(
        title=row.name, subtitle=row.brand, status=row.status, image=_first_image(db, row.id),
        fields=[
            field("SKU", row.sku),
            field("Price", _paise(row.price), "money"),
            field("MRP", _paise(row.original_price), "money") if row.original_price != row.price else None,
            field("Stock", int(row.stock or 0), "number"),
            field("Available", available, "number"),
            field("Subcategory", row.subcategory),
        ],
        links=[related("category", row.category_id, "Category")],
    )


def stock_adjustment(db: Session, row) -> dict:
    # `actor` is an admin id or "system"; only an admin id links onward.
    return card(
        title=f"Stock adjustment {row.id}", subtitle=row.reason,
        fields=[field("Change", row.delta, "number"), field("Before", row.quantity_before, "number"),
                field("After", row.quantity_after, "number"), field("Note", row.note), field("When", row.created_at, "date")],
        links=[related("product", row.product_id, "Product"),
               related("admin_user", row.actor if row.actor.startswith("ADM") else None, "By")],
    )


def category(db: Session, row) -> dict:
    from app.models import Product

    return card(
        title=row.name, image=row.image,
        fields=[
            field("Products", _count(db, select(func.count()).where(Product.category_id == row.id)), "number"),
            field("Featured", "Yes" if row.featured else "No"),
        ],
    )


def collection(db: Session, row) -> dict:
    from app.models.catalogue import CollectionProduct

    return card(
        title=row.name, subtitle=row.tagline or "", image=row.image,
        fields=[
            field("Products", _count(db, select(func.count()).where(CollectionProduct.collection_id == row.id)),
                  "number"),
            field("Featured", "Yes" if row.featured else "No"),
        ],
    )


def size_guide(db: Session, row) -> dict:
    return card(title=row.name, status=row.status,
                fields=[field("Kind", row.kind), field("Unit", row.unit), field("Updated", row.updated_at, "date")])


def review(db: Session, row) -> dict:
    return card(
        title=row.title, subtitle=f"{row.rating}★ by {row.author}", status=row.status,
        fields=[field("Rating", row.rating, "number"), field("Verified purchase", "Yes" if row.verified_purchase else "No"),
                field("Submitted", row.submitted_at, "date")],
        links=[related("product", row.product_id, "Product"), related("customer", row.customer_id, "Customer")],
    )


def question(db: Session, row) -> dict:
    return card(
        title=(row.body or "")[:120], subtitle=row.author_name, status=row.status,
        fields=[field("Asked", row.created_at, "date")],
        links=[related("product", row.product_id, "Product"), related("customer", row.customer_id, "Customer")],
    )


# ------------------------------------------------------------------ people


def _order_summary(db: Session, customer_id: str) -> tuple:
    count, spent, last = db.execute(
        select(func.count(Order.id), func.coalesce(func.sum(Order.total), 0), func.max(Order.placed_at))
        .where(Order.customer_id == customer_id, Order.status != "cancelled")
    ).one()
    return int(count or 0), spent, last


def customer(db: Session, row) -> dict:
    count, spent, last = _order_summary(db, row.id)
    return card(
        title=row.full_name, subtitle=row.email, status=row.status,
        fields=[
            field("Email", row.email),
            field("Phone", row.phone),
            field("Joined", row.joined_at, "date"),
            field("Orders", count, "number"),
            field("Total spent", _paise(spent), "money"),
            field("Last order", last, "date"),
        ],
    )


def address(db: Session, row) -> dict:
    return card(
        title=row.full_name, subtitle=f"{row.city}, {row.state} {row.pincode}",
        fields=[field("Line 1", row.line1), field("Line 2", row.line2), field("City", row.city),
                field("State", row.state), field("Pincode", row.pincode), field("Phone", row.phone),
                field("Type", row.type), field("Default", "Yes" if row.is_default else "No")],
        links=[related("customer", row.customer_id, "Customer")],
    )


def admin_user(db: Session, row) -> dict:
    # No permissions list and no sign-in history: who it is and whether it works.
    return card(title=row.name, subtitle=row.role, status=row.status,
                fields=[field("Role", row.role), field("Email", row.email)])


# -------------------------------------------------------- orders and money


def _items(db: Session, order_id: str) -> int:
    return _count(db, select(func.coalesce(func.sum(OrderItem.quantity), 0)).where(OrderItem.order_id == order_id))


def order(db: Session, row) -> dict:
    from app.models.shipping import Shipment

    shipment = db.execute(
        select(Shipment.shipment_number, Shipment.status, Shipment.awb, Shipment.courier_name)
        .where(Shipment.order_id == row.id).order_by(Shipment.id.desc()).limit(1)
    ).first()
    return card(
        title=f"Order {row.order_number}", subtitle=row.customer_name, status=row.status,
        fields=[
            field("Order number", row.order_number),
            field("Placed", row.placed_at, "date"),
            field("Items", _items(db, row.id), "number"),
            field("Total", _paise(row.total), "money"),
            field("Payment", f"{row.payment_status} · {row.payment_method}"),
            field("Shipping", shipment.status if shipment else "not shipped"),
            field("Tracking", (shipment.awb if shipment else None) or row.tracking_number),
            field("Courier", shipment.courier_name if shipment else None),
        ],
        links=[
            related("customer", row.customer_id, "Customer"),
            related("shipment", shipment.shipment_number if shipment else None, "Shipment"),
        ],
    )


def invoice(db: Session, row) -> dict:
    return card(
        title=f"Invoice {row.invoice_number}", subtitle=row.customer_name, status=row.status,
        fields=[field("Issued", row.issued_at, "date"), field("Grand total", row.grand_total, "money"),
                field("Paid", row.amount_paid, "money"), field("Refunded", row.amount_refunded, "money"),
                field("Payment status", row.payment_status)],
        links=[related("order", row.order_number, "Order"), related("customer", row.customer_id, "Customer"),
               related("payment", row.payment_id, "Payment")],
    )


def payment(db: Session, row) -> dict:
    return card(
        title=f"Payment {row.id}", subtitle=row.customer_name, status=row.status,
        fields=[field("Amount", row.amount, "money"), field("Refunded", row.refunded_amount, "money"),
                field("Method", row.method), field("Provider", row.provider),
                field("Transaction ID", row.transaction_id), field("Captured", row.captured_at, "date")],
        links=[related("order", row.order_number, "Order"), related("invoice", row.invoice_number, "Invoice"),
               related("customer", row.customer_id, "Customer")],
    )


def refund(db: Session, row) -> dict:
    return card(
        title=f"Refund {row.refund_number}", subtitle=row.customer_name, status=row.status,
        fields=[field("Amount", row.amount, "money"), field("Method", row.method),
                field("Reason", row.reason), field("Requested", row.requested_at, "date"),
                field("Processed", row.processed_at, "date"), field("Gateway reference", row.gateway_reference)],
        links=[related("order", row.order_number, "Order"), related("invoice", row.invoice_number, "Invoice"),
               related("payment", row.payment_id, "Payment"), related("customer", row.customer_id, "Customer")],
    )


def credit_note(db: Session, row) -> dict:
    return card(
        title=f"Credit note {row.credit_note_number}", subtitle=row.customer_name, status=row.status,
        fields=[field("Total", row.total, "money"), field("Reason", row.reason), field("Issued", row.issued_at, "date")],
        links=[related("invoice", row.invoice_number, "Invoice"), related("order", row.order_number, "Order"),
               related("refund", row.refund_id, "Refund")],
    )


def return_request(db: Session, row) -> dict:
    return card(
        title=f"Return {row.id}", subtitle=row.customer_name, status=row.status,
        fields=[field("Kind", row.kind), field("Reason", row.reason), field("Amount", row.amount, "money"),
                field("Requested", row.created_at, "date")],
        links=[related("order", row.order_number, "Order"), related("customer", row.customer_id, "Customer"),
               related("refund", row.refund_id, "Refund")],
    )


def coupon(db: Session, row) -> dict:
    value = f"{row.value:g}%" if row.type == "percentage" else _paise(row.value)
    return card(
        title=row.code, subtitle=row.description, status="active" if row.active else "inactive",
        fields=[field("Code", row.code), field("Type", row.type),
                field("Value", value, "text" if isinstance(value, str) else "money"),
                field("Minimum order", _paise(row.min_subtotal), "money") if row.min_subtotal else None,
                field("Used", f"{row.usage_count} / {row.usage_limit or '∞'}"),
                field("Starts", row.starts_at, "date"), field("Ends", row.ends_at, "date")],
    )


def gift_card(db: Session, row) -> dict:
    # Never the code — only its last four, as the gift card screens show it.
    return card(
        title=f"Gift card GC{row.id}", subtitle=f"•••• {row.code_last4}", status=row.status,
        fields=[field("Balance", row.balance, "money"), field("Initial amount", row.initial_amount, "money"),
                field("Source", row.source), field("Expires", row.expires_at, "date")],
        links=[related("customer", row.purchaser_id, "Purchaser")],
    )


def webhook_event(db: Session, row) -> dict:
    # The payload stays out: it is the gateway's raw body.
    return card(
        title=row.event, subtitle=row.result or "", status=row.status,
        fields=[field("Received", row.received_at, "date"), field("Attempts", row.attempts, "number"),
                field("Duplicates", row.duplicates, "number"), field("Gateway payment", row.gateway_payment_id)],
        links=[related("order", row.order_id, "Order"), related("payment", row.payment_id, "Payment"),
               related("refund", row.refund_id, "Refund")],
    )


def reconciliation(db: Session, row) -> dict:
    # The local and gateway snapshots stay out: they are raw payment records.
    return card(
        title=f"Reconciliation {row.id}", subtitle=row.summary, status=row.status,
        fields=[field("Resolution", row.resolution), field("Amount", row.amount, "money") if row.amount is not None else None,
                field("Gateway payment", row.gateway_payment_id), field("Checked", row.checked_at, "date"),
                field("Checks", row.check_count, "number"), field("Resolved", row.resolved_at, "date")],
        links=[related("payment", row.payment_id, "Payment"), related("order", row.order_number or None, "Order")],
    )


# ----------------------------------------------------------------- fulfilment


def shipment(db: Session, row) -> dict:
    number = db.execute(select(Order.order_number).where(Order.id == row.order_id)).scalar_one_or_none()
    return card(
        title=f"Shipment {row.shipment_number}", subtitle=row.courier_name or row.provider_code, status=row.status,
        fields=[field("AWB / tracking", row.awb), field("Courier", row.courier_name), field("Packages", row.package_count, "number"),
                field("COD", row.cod_amount, "money") if row.cod else None,
                field("Expected delivery", row.expected_delivery_at, "date"),
                field("Delivered", row.delivered_at, "date")],
        links=[related("order", number, "Order"), related("courier", row.provider_code, "Courier")],
    )


def package(db: Session, row) -> dict:
    from app.models.fulfilment import PackingJob
    from app.models.shipping import Shipment

    order_id = db.execute(select(PackingJob.order_id).where(PackingJob.id == row.job_id)).scalar_one_or_none()
    number = db.execute(select(Order.order_number).where(Order.id == order_id)).scalar_one_or_none() if order_id else None
    shipment_number = db.execute(
        select(Shipment.shipment_number).where(Shipment.id == row.shipment_id)).scalar_one_or_none() if row.shipment_id else None
    return {**card(
        title=f"Package {row.package_number}", subtitle=row.package_type,
        status="removed" if row.removed_at else ("shipped" if row.shipment_id else "packed"),
        fields=[field("Weight (g)", row.weight_grams, "number"),
                field("Dimensions (cm)", f"{row.length_cm} × {row.width_cm} × {row.height_cm}"),
                field("Packed", row.packed_at, "date")],
        links=[related("order", number, "Order"), related("shipment", shipment_number, "Shipment")],
    ), "key": str(row.job_id)}  # a package is worked on its packing job's screen


def packing_job(db: Session, row) -> dict:
    from app.models.shipping import Shipment

    number = db.execute(select(Order.order_number).where(Order.id == row.order_id)).scalar_one_or_none()
    shipment_number = db.execute(
        select(Shipment.shipment_number).where(Shipment.id == row.shipment_id)).scalar_one_or_none() if row.shipment_id else None
    return card(
        title=f"Packing job {row.id}", subtitle=row.priority, status=row.status,
        fields=[field("Assigned", row.assigned_at, "date"), field("Packed", row.packed_at, "date"),
                field("Ready", row.ready_at, "date")],
        links=[related("order", number, "Order"), related("admin_user", row.assigned_to, "Assigned to"),
               related("shipment", shipment_number, "Shipment")],
    )


def courier(db: Session, row) -> dict:
    # Credentials and settings are secrets; only the facts about the integration.
    return card(
        title=row.name, subtitle=row.code, status="active" if row.active else "inactive",
        fields=[field("Code", row.code), field("Environment", row.environment),
                field("Default", "Yes" if row.is_default else "No"), field("Last tested", row.last_tested_at, "date")],
    )


def pincode(db: Session, row) -> dict:
    return card(
        title=row.pincode, subtitle=f"{row.city}, {row.state}", status="active" if row.active else "inactive",
        fields=[field("Serviceable", "Yes" if row.serviceable else "No"), field("COD", "Yes" if row.cod_available else "No"),
                field("Express", "Yes" if row.express_available else "No"),
                field("Delivery days", f"{row.min_days}–{row.max_days}" if row.min_days is not None else None),
                field("Delivery fee", row.delivery_fee, "money") if row.delivery_fee is not None else None,
                field("Courier", row.courier)],
    )


# ---------------------------------------------------------------- purchasing


def supplier(db: Session, row) -> dict:
    from app.models.suppliers import SupplierProduct

    return card(
        title=row.name, subtitle=row.code, status=row.status,
        fields=[field("Code", row.code), field("Contact", row.contact_person), field("Phone", row.phone),
                field("Email", row.email), field("GSTIN", row.gstin), field("Payment terms", row.payment_terms),
                field("Products", _count(db, select(func.count()).where(SupplierProduct.supplier_id == row.id)), "number")],
    )


def purchase_order(db: Session, row) -> dict:
    return card(
        title=f"Purchase order {row.po_number}", status=row.status,
        fields=[field("Total", row.total, "money"), field("Expected", row.expected_at, "date"),
                field("Supplier reference", row.supplier_reference), field("Sent", row.sent_at, "date"),
                field("Received", row.received_at, "date")],
        links=[related("supplier", row.supplier_id, "Supplier")],
    )


def goods_receipt(db: Session, row) -> dict:
    from app.models.suppliers import PurchaseOrder

    po_number = db.execute(select(PurchaseOrder.po_number).where(PurchaseOrder.id == row.purchase_order_id)).scalar_one_or_none()
    return card(
        title=f"Goods receipt {row.receipt_number}",
        fields=[field("Received", row.received_at, "date"), field("Notes", row.notes)],
        links=[related("purchase_order", po_number, "Purchase order")],
    )


# ------------------------------------------------------------------- support


def support_agent(db: Session, row) -> dict:
    from app.models.support import SupportRole, SupportTeam

    team = db.execute(select(SupportTeam.name).where(SupportTeam.id == row.team_id)).scalar_one_or_none() if row.team_id else None
    role = db.execute(select(SupportRole.name).where(SupportRole.id == row.role_id)).scalar_one_or_none() if row.role_id else None
    return card(
        title=row.name, subtitle=row.specialization, status="active" if row.active else "inactive",
        fields=[field("Team", team), field("Role", role), field("Email", row.email)],
        links=[related("admin_user", row.admin_user_id, "Portal account")],
    )


def ticket_scope(db: Session, admin) -> list:
    """The desk's own visibility rule (`support.tickets.can_work`) as WHERE conditions."""
    from app.models import SupportTicket
    from app.services.support import tickets

    agent = tickets.can_work(db, admin)  # raises when this admin works no tickets
    if tickets.sees_everything(admin):
        return []
    options = [SupportTicket.agent_id == agent.id]
    if agent.team_id:
        options.append(SupportTicket.team_id == agent.team_id)
    return [or_(*options)]


def ticket(db: Session, row) -> dict:
    number = db.execute(select(Order.order_number).where(Order.id == row.order_id)).scalar_one_or_none() if row.order_id else None
    return card(
        title=row.subject, subtitle=row.number, status=row.status,
        fields=[field("Number", row.number), field("Priority", row.priority), field("Topic", row.issue_label or row.category_label),
                field("Opened", row.created_at, "date"), field("Last message", row.last_message_at, "date")],
        links=[related("customer", row.customer_id, "Customer"), related("order", number, "Order"),
               related("product", row.product_id, "Product")],
    )


# ---------------------------------------------------- marketing and membership


def banner(db: Session, row) -> dict:
    return card(title=row.title, subtitle=row.subtitle, image=row.image, status="active" if row.active else "inactive",
                fields=[field("Starts", row.starts_at, "date"), field("Ends", row.ends_at, "date"),
                        field("Order", row.display_order, "number")])


def membership_plan(db: Session, row) -> dict:
    return card(title=row.name, status="active" if row.active else "inactive",
                fields=[field("Price", _paise(row.price), "money"), field("Duration (months)", row.duration_months, "number"),
                        field("Member discount %", row.member_discount_percent, "number")])


def membership(db: Session, row) -> dict:
    return card(title=row.plan_name, subtitle=row.customer_id, status=row.status,
                fields=[field("Amount", row.amount, "money"), field("Starts", row.starts_at, "date"),
                        field("Ends", row.ends_at, "date")],
                links=[related("customer", row.customer_id, "Customer"), related("membership_plan", row.plan_id, "Plan")])


def referral_code(db: Session, row) -> dict:
    from app.models.growth import Referral

    return card(
        title=row.code, status="disabled" if row.disabled else "active",
        fields=[field("Referrals", _count(db, select(func.count()).where(Referral.code == row.code)), "number"),
                field("Created", row.created_at, "date")],
        links=[related("customer", row.customer_id, "Customer")],
    )


def segment(db: Session, row) -> dict:
    return card(title=row.name, subtitle=row.kind, status=row.status,
                fields=[field("Members", row.member_count, "number"), field("Last calculated", row.last_calculated_at, "date")])


def campaign(db: Session, row) -> dict:
    return card(title=row.name, subtitle=row.kind, status=row.status,
                fields=[field("Recipients", row.recipients_total, "number"), field("Scheduled", row.scheduled_at, "date"),
                        field("Launched", row.launched_at, "date"), field("Coupon", row.coupon_code)])


def flash_sale(db: Session, row) -> dict:
    return card(title=row.name, status=row.status,
                fields=[field("Starts", row.starts_at, "date"), field("Ends", row.ends_at, "date")])


def bundle(db: Session, row) -> dict:
    return card(title=row.name, image=row.image, status=row.status,
                fields=[field("Pricing", row.pricing), field("Price", _paise(row.price), "money") if row.price is not None else None,
                        field("Discount %", row.discount_percent, "number")])


def backup(db: Session, row) -> dict:
    # Never the location: where the encrypted dump is stored stays with the backups screen.
    return card(title=row.reference, subtitle=row.tier, status=row.status,
                fields=[field("Trigger", row.trigger), field("Size (bytes)", row.size_bytes, "number"),
                        field("Started", row.started_at, "date"), field("Completed", row.completed_at, "date"),
                        field("Verified", row.verified_at, "date")])


# --------------------------------------------------------- customer-facing


def my_order(db: Session, row) -> dict:
    preview = order(db, row)
    # The customer's own order: the same facts, without links into records a
    # customer cannot open (their customer record, the shipment's portal page).
    preview["subtitle"] = ""
    preview["related"] = []
    return preview


def my_invoice(db: Session, row) -> dict:
    return card(title=f"Invoice {row.invoice_number}", status=row.status,
                fields=[field("Issued", row.issued_at, "date"), field("Grand total", row.grand_total, "money"),
                        field("Paid", row.amount_paid, "money")],
                links=[related("order", row.order_number, "Order")])


def my_refund(db: Session, row) -> dict:
    return card(title=f"Refund {row.refund_number}", status=row.status,
                fields=[field("Amount", row.amount, "money"), field("Method", row.method),
                        field("Requested", row.requested_at, "date"), field("Processed", row.processed_at, "date")],
                links=[related("order", row.order_number, "Order")])


def my_return(db: Session, row) -> dict:
    return card(title=f"Return {row.id}", status=row.status,
                fields=[field("Kind", row.kind), field("Reason", row.reason), field("Requested", row.created_at, "date")],
                links=[related("order", row.order_number, "Order")])


def my_ticket(db: Session, row) -> dict:
    number = db.execute(select(Order.order_number).where(Order.id == row.order_id)).scalar_one_or_none() if row.order_id else None
    return card(title=row.subject, subtitle=row.number, status=row.status,
                fields=[field("Opened", row.created_at, "date"), field("Last message", row.last_message_at, "date")],
                links=[related("order", number, "Order")])


def my_address(db: Session, row) -> dict:
    preview = address(db, row)
    preview["related"] = []
    return preview


__all__: List[str] = []
