"""
Who may try on, how much, and what happens to their images.

Three sources of allowance, checked in this order for every request:

1. **The membership plan.** A plan's `try_on` entitlement is copied onto a
   membership when it is bought (`benefits["tryOn"]`), like every other
   benefit. A membership bought before the plan included try-on uses the
   plan's current entitlement, so adding try-on to a plan reaches existing
   members. The allowance resets every membership month, counted from the
   day the membership started — the same rhythm as free deliveries.
2. **Allocations** an administrator granted the customer (extra generations
   for a period, possibly on a dedicated credential).
3. **The trial**, for customers with no qualifying plan: a small lifetime
   allowance, when the store switches it on.

Only successful generations count (`usage`): a request reserves one unit
while it runs and gives it back if it fails or is cancelled. Reserving locks
the customer's row, so simultaneous requests are counted one after another
and can't overshoot a limit together.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import ValidationError
from app.models import Customer, CustomerMembership, MembershipPlan, VtoAllocation, VtoRequest, VtoUsage
from app.services import membership as memberships
from app.services.try_on import programme
from app.services.try_on.errors import TryOnError

ACTIVE_STATUSES = ("queued", "processing", "retrying")
COUNTED = ("reserved", "consumed")

DEFAULT_RULES = {
    "enabled": False,
    "perPeriod": 10,
    "perDay": None,
    "concurrent": 1,
    "capabilities": [],
    "qualityTiers": [],
    "maxUploadMb": 8,
    "retention": "temporary",
    "retentionDays": 7,
    "storageQuota": None,
    "download": True,
    "history": True,
    "retriesPerRequest": 2,
    "allocationRequests": True,
    "modelChoice": False,
}


def _opt_int(value, low: int, high: int) -> Optional[int]:
    if value in (None, ""):
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ValidationError("Check the try-on limits: whole numbers only.", error_code="INVALID_TRY_ON") from None
    if not low <= number <= high:
        raise ValidationError(f"Try-on limits must be between {low} and {high}.", error_code="INVALID_TRY_ON")
    return number


def normalise(value) -> Optional[dict]:
    """A plan's try-on entitlement, checked and completed. None = not included."""
    if value in (None, {}, False):
        return None
    if not isinstance(value, dict):
        raise ValidationError("Send the try-on entitlement as an object.", error_code="INVALID_TRY_ON")
    rules = {**DEFAULT_RULES}
    rules["enabled"] = value.get("enabled") is True
    rules["perPeriod"] = _opt_int(value.get("perPeriod", DEFAULT_RULES["perPeriod"]), 1, 100000)
    rules["perDay"] = _opt_int(value.get("perDay"), 1, 10000)
    rules["concurrent"] = _opt_int(value.get("concurrent", 1), 1, 10) or 1
    for name in ("capabilities", "qualityTiers"):
        items = value.get(name) or []
        if not isinstance(items, list):
            raise ValidationError(f"{name} must be a list.", error_code="INVALID_TRY_ON")
        rules[name] = [str(i)[:60] for i in items if isinstance(i, str)][:30]
    try:
        rules["maxUploadMb"] = max(0.5, min(float(value.get("maxUploadMb") or 8), 25))
    except (TypeError, ValueError):
        raise ValidationError("Check the maximum upload size.", error_code="INVALID_TRY_ON") from None
    if value.get("retention", "temporary") not in ("temporary", "permanent"):
        raise ValidationError("Retention is temporary or permanent.", error_code="INVALID_TRY_ON")
    rules["retention"] = value.get("retention", "temporary")
    rules["retentionDays"] = _opt_int(value.get("retentionDays", 7), 1, 365) or 7
    rules["storageQuota"] = _opt_int(value.get("storageQuota"), 1, 100000)
    for name in ("download", "history", "allocationRequests", "modelChoice"):
        rules[name] = value.get(name, DEFAULT_RULES[name]) is True
    rules["retriesPerRequest"] = _opt_int(value.get("retriesPerRequest", 2), 0, 10) or 0
    return rules


TRIAL_RULES = {**DEFAULT_RULES, "enabled": True, "perPeriod": None, "concurrent": 1, "retention": "temporary",
               "retentionDays": 3, "storageQuota": 10, "retriesPerRequest": 1, "allocationRequests": True}


@dataclass
class Entitlement:
    """What one customer may do right now."""

    eligible: bool
    reason: str = ""
    source: str = "none"  # plan | trial | allocation | none
    rules: dict = field(default_factory=lambda: dict(DEFAULT_RULES))
    membership: Optional[CustomerMembership] = None
    plan_id: Optional[str] = None
    plan_name: str = ""
    period_start: Optional[datetime] = None
    period_end: Optional[datetime] = None
    used_period: int = 0
    used_today: int = 0
    trial_limit: int = 0
    trial_used: int = 0
    allocations: List[VtoAllocation] = field(default_factory=list)

    @property
    def remaining(self) -> Optional[int]:
        if self.source == "trial":
            return max(self.trial_limit - self.trial_used, 0)
        limit = self.rules.get("perPeriod")
        return None if limit is None else max(int(limit) - self.used_period, 0)


def _day_start(now: datetime) -> datetime:
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def plan_rules(db: Session, membership: CustomerMembership) -> Optional[dict]:
    snapshot = (membership.benefits or {}).get("tryOn")
    if isinstance(snapshot, dict) and snapshot.get("enabled"):
        try:
            return normalise(snapshot)
        except ValidationError:
            pass
    plan = db.get(MembershipPlan, membership.plan_id)
    if plan is None or not plan.try_on:
        return None
    try:
        rules = normalise(plan.try_on)
    except ValidationError:
        return None
    return rules if rules and rules["enabled"] else None


def _count(db: Session, *conditions) -> int:
    return db.execute(select(func.count()).select_from(VtoUsage).where(VtoUsage.status.in_(COUNTED), *conditions)).scalar_one()


def active_allocations(db: Session, customer_id: str, now: Optional[datetime] = None) -> List[VtoAllocation]:
    now = now or datetime.utcnow()
    return list(db.execute(select(VtoAllocation).where(
        VtoAllocation.customer_id == customer_id, VtoAllocation.status == "active",
        VtoAllocation.starts_at <= now,
        (VtoAllocation.ends_at.is_(None)) | (VtoAllocation.ends_at > now),
    ).order_by(VtoAllocation.starts_at)).scalars())


def allocation_used(db: Session, allocation: VtoAllocation, since: Optional[datetime] = None) -> int:
    conditions = [VtoUsage.allocation_id == allocation.id, VtoUsage.source == "allocation"]
    if since is not None:
        conditions.append(VtoUsage.created_at >= since)
    return _count(db, *conditions)


def resolve(db: Session, customer: Optional[Customer], now: Optional[datetime] = None) -> Entitlement:
    """The customer's entitlement as of now, with usage counted."""
    now = now or datetime.utcnow()
    settings = programme.get(db)
    if not settings["enabled"]:
        return Entitlement(False, "programme_off")
    if customer is None:
        return Entitlement(False, "signed_out")

    allocations = active_allocations(db, customer.id, now)
    membership = memberships.active_membership(db, customer.id, now)
    if membership is not None and memberships.programme(db)["enabled"]:
        rules = plan_rules(db, membership)
        if rules:
            start = memberships._period_start(membership, now)
            end = min(memberships.add_months(start, 1), membership.ends_at or memberships.add_months(start, 1))
            used = _count(db, VtoUsage.customer_id == customer.id, VtoUsage.source == "plan",
                          VtoUsage.membership_id == membership.id, VtoUsage.created_at >= start)
            today = _count(db, VtoUsage.customer_id == customer.id, VtoUsage.source == "plan",
                           VtoUsage.created_at >= _day_start(now))
            return Entitlement(True, "", "plan", rules, membership, membership.plan_id, membership.plan_name,
                               start, end, used, today, allocations=allocations)

    trial = settings["trial"]
    trial_used = _count(db, VtoUsage.customer_id == customer.id, VtoUsage.source == "trial")
    if trial["enabled"] and trial["generations"] > 0:
        rules = {**TRIAL_RULES, "capabilities": trial["capabilities"]}
        return Entitlement(True, "", "trial", rules, trial_limit=trial["generations"], trial_used=trial_used,
                           allocations=allocations)
    if allocations:
        rules = {**DEFAULT_RULES, "enabled": True, "perPeriod": None, "concurrent": 2}
        return Entitlement(True, "", "allocation", rules, allocations=allocations, trial_used=trial_used)
    return Entitlement(False, "plan_ineligible", trial_used=trial_used)


@dataclass
class Charge:
    """Which allowance one request draws on."""

    source: str
    allocation: Optional[VtoAllocation] = None
    membership_id: Optional[str] = None


def _allocation_with_room(db: Session, entitlement: Entitlement, capability: str,
                          now: datetime) -> Optional[VtoAllocation]:
    for allocation in entitlement.allocations:
        if allocation.capability_keys and capability not in allocation.capability_keys:
            continue
        if allocation.generations is not None and allocation_used(db, allocation) >= allocation.generations:
            continue
        if allocation.per_day is not None and allocation_used(db, allocation, _day_start(now)) >= allocation.per_day:
            continue
        return allocation
    return None


def choose_charge(db: Session, entitlement: Entitlement, capability: str, now: Optional[datetime] = None) -> Charge:
    """The allowance this request uses, or a TryOnError saying why there is none."""
    now = now or datetime.utcnow()
    if not entitlement.eligible:
        raise TryOnError("plan_ineligible", status_code=403)
    rules = entitlement.rules
    capability_ok = not rules.get("capabilities") or capability in rules["capabilities"]

    if entitlement.source == "plan" and capability_ok:
        under_period = rules.get("perPeriod") is None or entitlement.used_period < rules["perPeriod"]
        under_day = rules.get("perDay") is None or entitlement.used_today < rules["perDay"]
        if under_period and under_day:
            return Charge("plan", membership_id=entitlement.membership.id if entitlement.membership else None)
    if entitlement.source == "trial" and capability_ok and entitlement.trial_used < entitlement.trial_limit:
        return Charge("trial")
    allocation = _allocation_with_room(db, entitlement, capability, now)
    if allocation is not None:
        return Charge("allocation", allocation=allocation)
    if not capability_ok and not entitlement.allocations:
        raise TryOnError("plan_ineligible", "Your plan doesn't include try-on for this kind of item.", status_code=403)
    raise TryOnError("limit_reached", status_code=429)


def lock_customer(db: Session, customer_id: str) -> None:
    """Serialise this customer's quota decisions until the transaction ends."""
    db.execute(select(Customer.id).where(Customer.id == customer_id).with_for_update()).first()


def in_progress(db: Session, customer_id: str) -> int:
    return db.execute(select(func.count()).select_from(VtoRequest).where(
        VtoRequest.customer_id == customer_id, VtoRequest.status.in_(ACTIVE_STATUSES))).scalar_one()


def reserve(db: Session, request: VtoRequest, charge: Charge, now: Optional[datetime] = None) -> VtoUsage:
    now = now or datetime.utcnow()
    usage = db.execute(select(VtoUsage).where(VtoUsage.request_id == request.id)).scalar_one_or_none()
    if usage is None:
        usage = VtoUsage(customer_id=request.customer_id, request_id=request.id, created_at=now)
        db.add(usage)
    usage.source = charge.source
    usage.membership_id = charge.membership_id
    usage.allocation_id = charge.allocation.id if charge.allocation else None
    usage.status = "reserved"
    # A retry counts in the period it runs in, not the one the first attempt did.
    usage.created_at = now
    usage.updated_at = now
    request.source = charge.source
    request.allocation_id = usage.allocation_id
    return usage


def settle(db: Session, request_id: str, outcome: str) -> None:
    """consumed on success; released on failure or cancellation."""
    usage = db.execute(select(VtoUsage).where(VtoUsage.request_id == request_id)).scalar_one_or_none()
    if usage is not None and usage.status == "reserved":
        usage.status = "consumed" if outcome == "succeeded" else "released"
        usage.updated_at = datetime.utcnow()


def stored_results(db: Session, customer_id: str) -> int:
    return db.execute(select(func.count()).select_from(VtoRequest).where(
        VtoRequest.customer_id == customer_id, VtoRequest.status == "succeeded",
        VtoRequest.deleted_at.is_(None), VtoRequest.result_deleted_at.is_(None),
        VtoRequest.storage_mode == "permanent")).scalar_one()


def summary(db: Session, customer: Optional[Customer]) -> dict:
    """What the customer pages show: eligibility, allowance, reset date, retention."""
    from app.services.try_on import storage

    entitlement = resolve(db, customer)
    rules = entitlement.rules
    store = storage.status()
    retention = rules.get("retention", "temporary")
    effective = "ephemeral" if store["active"] == "ephemeral" else retention
    allocations = []
    for a in entitlement.allocations:
        used = allocation_used(db, a)
        allocations.append({
            "id": a.id, "kind": a.kind, "dedicated": a.kind == "dedicated_credential",
            "generations": a.generations, "used": used,
            "remaining": None if a.generations is None else max(a.generations - used, 0),
            "perDay": a.per_day, "capabilities": a.capability_keys or [], "endsAt": a.ends_at,
        })
    return {
        "eligible": entitlement.eligible,
        "reason": entitlement.reason,
        "source": entitlement.source,
        "planId": entitlement.plan_id,
        "planName": entitlement.plan_name,
        "membershipId": entitlement.membership.id if entitlement.membership else None,
        "perPeriod": rules.get("perPeriod") if entitlement.source == "plan" else (
            entitlement.trial_limit if entitlement.source == "trial" else None),
        "usedThisPeriod": entitlement.used_period if entitlement.source == "plan" else entitlement.trial_used,
        "remaining": entitlement.remaining,
        "perDay": rules.get("perDay"),
        "usedToday": entitlement.used_today,
        "periodStart": entitlement.period_start,
        "resetsAt": entitlement.period_end if entitlement.source == "plan" else None,
        "concurrent": rules.get("concurrent", 1),
        "inProgress": in_progress(db, customer.id) if customer else 0,
        "capabilities": rules.get("capabilities") or [],
        "maxUploadMb": rules.get("maxUploadMb"),
        "retention": effective,
        "retentionDays": rules.get("retentionDays"),
        "ephemeralMinutes": store["ephemeralTtlMinutes"],
        "storageQuota": rules.get("storageQuota"),
        "storedResults": stored_results(db, customer.id) if customer else 0,
        "download": bool(rules.get("download")),
        "history": bool(rules.get("history", True)),
        "retriesPerRequest": rules.get("retriesPerRequest", 0),
        "allocationRequests": bool(rules.get("allocationRequests")) or entitlement.source in ("none", "trial"),
        "modelChoice": bool(rules.get("modelChoice")),
        "allocations": allocations,
        "trial": {"limit": entitlement.trial_limit, "used": entitlement.trial_used} if entitlement.source == "trial" else None,
    }
