"""
The membership programme.

Plans are managed by the store: a price, a length (one month, three, twelve,
twenty-four…), and benefits — free standard delivery (unlimited or so many a
month), an extra percentage off every order, a longer return window, early
access to sales, priority support. A customer buys a plan through the payment
gateway; the membership starts the moment the payment is confirmed and runs
for the plan's length. Buying again while a membership is live extends it from
its end date, so no paid day is lost.

What a member receives is **copied** onto the membership when it is bought
(`benefits`), so a later change to the plan never alters a member's deal.
"""

from __future__ import annotations

import calendar
import logging
from datetime import datetime
from typing import List, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import Customer, CustomerMembership, MembershipPlan, Order, SettingDocument
from app.services import billing
from app.utils.ids import next_id

logger = logging.getLogger(__name__)

PROGRAMME_DEFAULTS = {
    "name": "Choice Circle",
    "tagline": "Free delivery, member-only prices and first look at every sale.",
    "enabled": True,
}


# ---------------------------------------------------------------- programme


def programme(db: Session) -> dict:
    """The programme's name and on/off switch, from settings."""
    document = db.get(SettingDocument, "membership_programme")
    value = dict(PROGRAMME_DEFAULTS)
    if document and isinstance(document.value, dict):
        value.update({k: v for k, v in document.value.items() if k in PROGRAMME_DEFAULTS})
    return value


def save_programme(db: Session, payload: dict) -> dict:
    current = programme(db)
    name = str(payload.get("name", current["name"])).strip()[:40]
    if not name:
        raise ValidationError("Give the membership a name.", error_code="NAME_REQUIRED")
    value = {
        "name": name,
        "tagline": str(payload.get("tagline", current["tagline"])).strip()[:160],
        "enabled": bool(payload.get("enabled", current["enabled"])),
    }
    document = db.get(SettingDocument, "membership_programme")
    if document is None:
        db.add(SettingDocument(key="membership_programme", value=value))
    else:
        document.value = value
    db.commit()
    return value


# -------------------------------------------------------------------- plans


def list_plans(db: Session, *, include_inactive: bool = False) -> List[MembershipPlan]:
    query = select(MembershipPlan).order_by(MembershipPlan.sort_order, MembershipPlan.duration_months)
    if not include_inactive:
        query = query.where(MembershipPlan.active.is_(True))
    return list(db.execute(query).scalars())


def get_plan(db: Session, plan_id: str) -> MembershipPlan:
    plan = db.get(MembershipPlan, plan_id)
    if plan is None:
        raise NotFoundError("We couldn't find that plan.", error_code="PLAN_NOT_FOUND")
    return plan


PLAN_FIELDS = {
    "name": ("name", str),
    "description": ("description", str),
    "durationMonths": ("duration_months", int),
    "price": ("price", float),
    "compareAtPrice": ("compare_at_price", lambda v: None if v in (None, "") else float(v)),
    "freeDelivery": ("free_delivery", bool),
    "freeDeliveriesPerMonth": ("free_deliveries_per_month", lambda v: None if v in (None, "") else int(v)),
    "memberDiscountPercent": ("member_discount_percent", float),
    "extraReturnDays": ("extra_return_days", int),
    "earlyAccess": ("early_access", bool),
    "prioritySupport": ("priority_support", bool),
    "badge": ("badge", str),
    "active": ("active", bool),
    "sortOrder": ("sort_order", int),
}


def save_plan(db: Session, payload: dict, plan_id: Optional[str] = None) -> MembershipPlan:
    now = datetime.utcnow()
    if plan_id:
        plan = get_plan(db, plan_id)
    else:
        plan = MembershipPlan(id=next_id(db, MembershipPlan, "membership_plan"), created_at=now)
        db.add(plan)

    for key, (attribute, cast) in PLAN_FIELDS.items():
        if key in payload:
            try:
                setattr(plan, attribute, cast(payload[key]))
            except (TypeError, ValueError):
                raise ValidationError(f"Check the value for {key}.", error_code="INVALID_PLAN") from None

    plan.name = (plan.name or "").strip()[:80]
    if not plan.name:
        raise ValidationError("Give the plan a name.", error_code="PLAN_INCOMPLETE")
    if not plan.duration_months or not 1 <= plan.duration_months <= 60:
        raise ValidationError("A plan lasts between 1 and 60 months.", error_code="INVALID_DURATION")
    if plan.price is None or float(plan.price) < 1:
        raise ValidationError("Set a price of at least ₹1.", error_code="INVALID_PRICE")
    if not 0 <= float(plan.member_discount_percent or 0) <= 50:
        raise ValidationError("The member discount must be between 0% and 50%.", error_code="INVALID_DISCOUNT")
    if plan.free_deliveries_per_month is not None and plan.free_deliveries_per_month < 1:
        plan.free_deliveries_per_month = None
    if not 0 <= int(plan.extra_return_days or 0) <= 60:
        raise ValidationError("Extra return days must be between 0 and 60.", error_code="INVALID_RETURN_DAYS")

    plan.updated_at = now
    db.commit()
    db.refresh(plan)
    return plan


def delete_plan(db: Session, plan_id: str) -> str:
    """Delete a plan nobody has bought; otherwise retire it. Returns which."""
    plan = get_plan(db, plan_id)
    bought = db.execute(
        select(func.count()).select_from(CustomerMembership).where(CustomerMembership.plan_id == plan.id)
    ).scalar_one()
    if bought:
        plan.active = False
        plan.updated_at = datetime.utcnow()
        db.commit()
        return "retired"
    db.delete(plan)
    db.commit()
    return "deleted"


def benefits_of(plan: MembershipPlan) -> dict:
    return {
        "freeDelivery": bool(plan.free_delivery),
        "freeDeliveriesPerMonth": plan.free_deliveries_per_month,
        "memberDiscountPercent": float(plan.member_discount_percent or 0),
        "extraReturnDays": int(plan.extra_return_days or 0),
        "earlyAccess": bool(plan.early_access),
        "prioritySupport": bool(plan.priority_support),
    }


# -------------------------------------------------------------- memberships


def add_months(moment: datetime, months: int) -> datetime:
    month = moment.month - 1 + months
    year = moment.year + month // 12
    month = month % 12 + 1
    day = min(moment.day, calendar.monthrange(year, month)[1])
    return moment.replace(year=year, month=month, day=day)


def expire_lapsed(db: Session, now: Optional[datetime] = None) -> int:
    """Mark memberships past their end as expired. Returns how many."""
    now = now or datetime.utcnow()
    rows = db.execute(
        select(CustomerMembership).where(
            CustomerMembership.status == "active", CustomerMembership.ends_at <= now
        )
    ).scalars().all()
    for row in rows:
        row.status = "expired"
        row.updated_at = now
    if rows:
        db.commit()
    return len(rows)


def active_membership(db: Session, customer_id: Optional[str], now: Optional[datetime] = None) -> Optional[CustomerMembership]:
    if not customer_id:
        return None
    now = now or datetime.utcnow()
    return db.execute(
        select(CustomerMembership)
        .where(
            CustomerMembership.customer_id == customer_id,
            CustomerMembership.status == "active",
            CustomerMembership.starts_at <= now,
            CustomerMembership.ends_at > now,
        )
        .order_by(CustomerMembership.ends_at.desc())
    ).scalars().first()


def is_member(db: Session, customer_id: Optional[str]) -> bool:
    return active_membership(db, customer_id) is not None


def _period_start(membership: CustomerMembership, now: datetime) -> datetime:
    """The start of the current membership month — where the monthly quota resets."""
    start = membership.starts_at
    months = (now.year - start.year) * 12 + (now.month - start.month)
    candidate = add_months(start, max(months, 0))
    if candidate > now:
        candidate = add_months(start, max(months - 1, 0))
    return candidate


def free_deliveries_used(db: Session, membership: CustomerMembership, now: Optional[datetime] = None) -> int:
    now = now or datetime.utcnow()
    return db.execute(
        select(func.count())
        .select_from(Order)
        .where(
            Order.membership_id == membership.id,
            Order.member_free_delivery.is_(True),
            Order.status != "cancelled",
            Order.placed_at >= _period_start(membership, now),
        )
    ).scalar_one()


def order_benefits(db: Session, customer_id: Optional[str], *, delivery_method: str = "standard") -> dict:
    """
    What a membership gives this order: `discountPercent`, whether standard
    delivery is waived, and the membership to record against the order.
    """
    membership = active_membership(db, customer_id)
    if membership is None or not programme(db)["enabled"]:
        return {"membership": None, "discountPercent": 0.0, "freeDelivery": False, "freeDeliveriesLeft": None}

    benefits = membership.benefits or {}
    free = bool(benefits.get("freeDelivery")) and delivery_method == "standard"
    left = None
    limit = benefits.get("freeDeliveriesPerMonth")
    if free and limit:
        left = max(int(limit) - free_deliveries_used(db, membership), 0)
        free = left > 0

    return {
        "membership": membership,
        "discountPercent": float(benefits.get("memberDiscountPercent") or 0),
        "freeDelivery": free,
        "freeDeliveriesLeft": left,
    }


def membership_summary(db: Session, membership: Optional[CustomerMembership]) -> Optional[dict]:
    if membership is None:
        return None
    benefits = membership.benefits or {}
    left = None
    if membership.status == "active" and benefits.get("freeDelivery") and benefits.get("freeDeliveriesPerMonth"):
        left = max(int(benefits["freeDeliveriesPerMonth"]) - free_deliveries_used(db, membership), 0)
    saved = db.execute(
        select(func.coalesce(func.sum(Order.member_discount), 0)).where(
            Order.membership_id == membership.id, Order.status != "cancelled"
        )
    ).scalar_one()
    free_orders = db.execute(
        select(func.count()).select_from(Order).where(
            Order.membership_id == membership.id,
            Order.member_free_delivery.is_(True),
            Order.status != "cancelled",
        )
    ).scalar_one()
    return {
        "id": membership.id,
        "planId": membership.plan_id,
        "planName": membership.plan_name,
        "status": membership.status,
        "startsAt": membership.starts_at,
        "endsAt": membership.ends_at,
        "amount": membership.amount,
        "benefits": benefits,
        "freeDeliveriesLeftThisMonth": left,
        "savedOnOrders": float(saved or 0),
        "freeDeliveryOrders": int(free_orders or 0),
    }


def history(db: Session, customer: Customer) -> List[CustomerMembership]:
    return list(
        db.execute(
            select(CustomerMembership)
            .where(CustomerMembership.customer_id == customer.id, CustomerMembership.status != "pending")
            .order_by(CustomerMembership.created_at.desc())
        ).scalars()
    )


# ---------------------------------------------------------------- buying


def start_purchase(db: Session, customer: Customer, plan_id: str) -> tuple[CustomerMembership, dict]:
    """
    Open a payment for a plan. Returns the pending membership and what the
    browser needs to open the payment window.
    """
    from app.services.payments import PaymentRequest, get_provider

    if not programme(db)["enabled"]:
        raise ConflictError("Memberships aren't available right now.", error_code="PROGRAMME_OFF")
    plan = get_plan(db, plan_id)
    if not plan.active:
        raise ConflictError("That plan is no longer offered.", error_code="PLAN_RETIRED")

    now = datetime.utcnow()
    amount = billing.to_minor(float(plan.price))
    membership = CustomerMembership(
        id=next_id(db, CustomerMembership, "membership"),
        customer_id=customer.id,
        plan_id=plan.id,
        plan_name=plan.name,
        duration_months=plan.duration_months,
        status="pending",
        amount=amount,
        currency="INR",
        benefits=benefits_of(plan),
        created_at=now,
        updated_at=now,
    )
    db.add(membership)
    db.flush()

    provider = get_provider()
    result = provider.create(
        PaymentRequest(
            order_id=membership.id,
            invoice_id="",
            customer_id=customer.id,
            customer_name=customer.full_name,
            customer_email=customer.email,
            amount=amount,
            currency="INR",
            method="upi",
            notes={"membershipId": membership.id, "orderNumber": f"Membership {membership.id}"},
        )
    )
    if not result.ok:
        db.rollback()
        raise ConflictError("We couldn't start the payment. Please try again.", error_code="PAYMENT_FAILED")

    membership.gateway_order_id = result.provider_reference or result.transaction_id
    db.commit()

    # A provider that settles on the spot (development) activates at once.
    if result.status == "paid":
        activate(db, membership, payment_id=result.transaction_id, amount=amount)
        return membership, {}

    business = (billing.billing_config(db) or {}).get("business") or {}
    name = programme(db)["name"]
    handoff = {
        "provider": "razorpay",
        "keyId": settings.RAZOR_KEY_ID,
        "merchantName": business.get("storeName") or "Daily Choice Zone",
        "orderReference": membership.gateway_order_id,
        "paymentId": membership.id,
        "amount": amount,
        "currency": "INR",
        "name": customer.full_name,
        "email": customer.email,
        "phone": customer.phone or "",
        "description": f"{name} · {plan.name}",
    }
    return membership, handoff


def _own(db: Session, customer: Customer, membership_id: str) -> CustomerMembership:
    membership = db.get(CustomerMembership, membership_id)
    if membership is None or membership.customer_id != customer.id:
        raise NotFoundError("We couldn't find that membership.", error_code="MEMBERSHIP_NOT_FOUND")
    return membership


def confirm_purchase(db: Session, customer: Customer, membership_id: str, response: dict) -> CustomerMembership:
    """Check the payment the browser reports — signature, then the gateway's own record."""
    from app.services.payments import get_provider

    membership = _own(db, customer, membership_id)
    if membership.status == "active":
        return membership
    if membership.status != "pending":
        raise ConflictError("This membership purchase has closed.", error_code="MEMBERSHIP_CLOSED")

    result = get_provider().verify(membership.gateway_order_id or "", response)
    if not result.ok or result.status not in ("paid", "captured"):
        raise ConflictError(
            result.failure_reason or "We couldn't confirm the payment. If money left your account, it will be refunded.",
            error_code="PAYMENT_UNVERIFIED",
        )
    if result.amount is not None and result.amount != membership.amount:
        raise ConflictError("The payment amount didn't match the plan.", error_code="AMOUNT_MISMATCH")

    return activate(db, membership, payment_id=result.transaction_id, amount=membership.amount)


def settle_from_gateway(db: Session, membership_id: str, entity: dict) -> str:
    """The webhook's path: a captured payment whose notes name a membership."""
    membership = db.get(CustomerMembership, membership_id)
    if membership is None:
        return "ignored: unknown membership"
    if membership.status == "active":
        return "duplicate: already active"
    if entity.get("status") not in ("captured",):
        return f"ignored: payment {entity.get('status')}"
    if int(entity.get("amount") or 0) != membership.amount or entity.get("order_id") != membership.gateway_order_id:
        logger.warning("Membership %s: webhook payment does not match", membership.id)
        return "ignored: mismatch"
    activate(db, membership, payment_id=entity.get("id") or "", amount=membership.amount)
    return "activated membership"


def activate(db: Session, membership: CustomerMembership, *, payment_id: str, amount: int) -> CustomerMembership:
    """
    Start the membership. A live membership of the same customer is extended
    rather than overlapped: the new term begins when the current one ends.
    """
    locked = db.execute(
        select(CustomerMembership).where(CustomerMembership.id == membership.id).with_for_update()
    ).scalar_one()
    if locked.status == "active":
        return locked

    # Whole seconds: MySQL DATETIME rounds fractions *up*, which would start a
    # membership up to a second in the future and leave a new member briefly
    # not a member.
    now = datetime.utcnow().replace(microsecond=0)
    current = active_membership(db, locked.customer_id, now)
    start = current.ends_at if current and current.id != locked.id else now

    locked.status = "active"
    locked.starts_at = start
    locked.ends_at = add_months(start, locked.duration_months)
    locked.gateway_payment_id = payment_id or locked.gateway_payment_id
    locked.paid_at = now
    locked.updated_at = now

    from app.services.email.notifications import notify_membership

    customer = db.get(Customer, locked.customer_id)
    if customer is not None:
        notify_membership(db, locked, customer.email, programme(db)["name"])
    db.commit()
    db.refresh(locked)
    return locked


def cancel_pending(db: Session, customer: Customer, membership_id: str) -> None:
    membership = _own(db, customer, membership_id)
    if membership.status == "pending":
        membership.status = "cancelled"
        membership.updated_at = datetime.utcnow()
        db.commit()


# ------------------------------------------------------------------- admin


def list_members(db: Session, *, status: Optional[str] = None, limit: int = 500) -> List[CustomerMembership]:
    # Unpaid purchases stay out of the list unless asked for ("Awaiting payment").
    query = select(CustomerMembership)
    if status:
        query = query.where(CustomerMembership.status == status)
    else:
        query = query.where(CustomerMembership.status != "pending")
    return list(db.execute(query.order_by(CustomerMembership.created_at.desc()).limit(limit)).scalars())


def search_members(
    db: Session, *, status: str = "", plan_id: str = "", query: str = "", page: int = 1, page_size: int = 25,
) -> tuple:
    """Every member, filtered and paged in the database. Returns (rows, total, counts by status)."""
    from sqlalchemy import or_

    conditions = []
    if plan_id:
        conditions.append(CustomerMembership.plan_id == plan_id)
    text = (query or "").strip()
    if text:
        like = f"%{text}%"
        people = select(Customer.id).where(or_(
            Customer.email.ilike(like), Customer.first_name.ilike(like), Customer.last_name.ilike(like),
            func.concat(Customer.first_name, " ", Customer.last_name).ilike(like),
        ))
        conditions.append(or_(CustomerMembership.customer_id.in_(people), CustomerMembership.id.ilike(like),
                              CustomerMembership.plan_name.ilike(like)))
    counts = dict(db.execute(
        select(CustomerMembership.status, func.count()).where(*conditions).group_by(CustomerMembership.status)
    ).all())
    # Unpaid purchases stay out of "All" and are listed only when asked for.
    conditions.append(CustomerMembership.status == status if status else CustomerMembership.status != "pending")
    total = db.execute(select(func.count()).select_from(CustomerMembership).where(*conditions)).scalar_one()
    rows = db.execute(
        select(CustomerMembership).where(*conditions)
        .order_by(CustomerMembership.created_at.desc(), CustomerMembership.id.desc())
        .offset((max(1, page) - 1) * page_size).limit(page_size)
    ).scalars().all()
    return list(rows), total, counts


def admin_cancel(db: Session, membership_id: str) -> CustomerMembership:
    """End a membership now. Refunds, if any, are made from the payment's own page."""
    membership = db.get(CustomerMembership, membership_id)
    if membership is None:
        raise NotFoundError("We couldn't find that membership.", error_code="MEMBERSHIP_NOT_FOUND")
    if membership.status != "active":
        raise ConflictError("Only an active membership can be ended.", error_code="MEMBERSHIP_NOT_ACTIVE")
    now = datetime.utcnow()
    membership.status = "cancelled"
    membership.ends_at = now
    membership.updated_at = now
    db.commit()
    db.refresh(membership)
    return membership
