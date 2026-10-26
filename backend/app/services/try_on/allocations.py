"""
Extra try-on access, asked for by customers and granted by the store.

Customers ask (`request_access`): more generations, or capacity of their own,
with a reason, the kinds of item, expected use and a period. The store
approves — creating an **allocation** — or rejects; the customer is told
either way.

An allocation is either:

- **allowance** — extra generations (optionally per day, for some kinds of
  item, between two dates) on the shared credentials; or
- **dedicated_credential** — the same, run on a credential reserved for this
  customer. The credential must be a *dedicated* credential assigned to this
  same customer: `selection` refuses it to everyone else, and refuses it to
  this customer too once the allocation is revoked, disabled or expired.
"""

from __future__ import annotations

from datetime import date, datetime, time
from typing import List, Optional, Tuple

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core import rate_limit
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import Customer, VtoAllocation, VtoAllocationRequest, VtoCapability, VtoCredential
from app.services import audit
from app.services.try_on import entitlements
from app.utils.ids import next_id

STATUSES = ("active", "disabled", "revoked", "expired")
MAX_PENDING = 3


def _date(value, name: str) -> Optional[date]:
    if value in (None, ""):
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        raise ValidationError(f"Check the {name} date.", error_code="INVALID_DATE") from None


def _capabilities(db: Session, value) -> list:
    if value in (None, ""):
        return []
    if not isinstance(value, list):
        raise ValidationError("Choose the kinds of item as a list.", error_code="INVALID_CAPABILITIES")
    keys = [str(v)[:60] for v in value if isinstance(v, str)][:20]
    known = set(db.execute(select(VtoCapability.key)).scalars())
    if any(k not in known for k in keys):
        raise ValidationError("Choose known kinds of item.", error_code="INVALID_CAPABILITIES")
    return keys


# ----------------------------------------------------------------- customers


def request_access(db: Session, customer: Customer, payload: dict) -> VtoAllocationRequest:
    if not isinstance(payload, dict):
        raise ValidationError("Send the request as an object.", error_code="INVALID_REQUEST")
    summary = entitlements.summary(db, customer)
    if not summary["allocationRequests"]:
        raise ConflictError("Your plan doesn't include requesting extra try-ons.", error_code="NOT_ALLOWED")
    rate_limit.check(f"vto-allocation:{customer.id}", limit=5, window_seconds=86400,
                     message="You've sent several requests today. We'll get back to you soon.")
    pending = db.execute(select(func.count()).select_from(VtoAllocationRequest).where(
        VtoAllocationRequest.customer_id == customer.id, VtoAllocationRequest.status == "pending")).scalar_one()
    if pending >= MAX_PENDING:
        raise ConflictError("You already have requests waiting for a reply.", error_code="TOO_MANY_PENDING")
    kind = payload.get("kind", "more_usage")
    if kind not in ("more_usage", "dedicated"):
        raise ValidationError("Choose what you're asking for.", error_code="INVALID_KIND")
    reason = str(payload.get("reason") or "").strip()[:500]
    if len(reason) < 5:
        raise ValidationError("Tell us briefly why you need it.", error_code="REASON_REQUIRED")
    try:
        expected = max(0, min(int(payload.get("expectedUsage") or 0), 100000))
    except (TypeError, ValueError):
        raise ValidationError("Expected use is a number.", error_code="INVALID_USAGE") from None
    starts, ends = _date(payload.get("startsOn"), "start"), _date(payload.get("endsOn"), "end")
    if starts and ends and ends < starts:
        raise ValidationError("The end date is before the start.", error_code="INVALID_DATES")
    model_id = str(payload.get("requestedModelId") or "").strip()[:20] or None
    if model_id:
        from app.models import VtoModel

        model = db.get(VtoModel, model_id)
        if model is None or not model.enabled or not model.verified:
            raise ValidationError("Choose an available quality option.", error_code="INVALID_MODEL")
    now = datetime.utcnow()
    row = VtoAllocationRequest(
        id=next_id(db, VtoAllocationRequest, "vto_allocation_request"), customer_id=customer.id, kind=kind,
        reason=reason, capability_keys=_capabilities(db, payload.get("capabilities")), expected_usage=expected,
        requested_model_id=model_id, starts_on=starts, ends_on=ends,
        message=str(payload.get("message") or "").strip()[:1000], status="pending", decided_by="",
        decision_note="", created_at=now, updated_at=now,
    )
    db.add(row)
    db.flush()
    try:
        from app.services import inbox

        inbox.staff(db, "try-on", "New try-on access request",
                    f"{customer.full_name} ({customer.id}) asked for {'dedicated capacity' if kind == 'dedicated' else 'more try-ons'}.",
                    href=f"/admin/try-on/allocations?request={row.id}", permission="try-on", key=f"vto-ar-{row.id}")
    except Exception:  # noqa: BLE001
        pass
    db.commit()
    return row


def withdraw(db: Session, customer: Customer, request_id: str) -> VtoAllocationRequest:
    row = db.get(VtoAllocationRequest, (request_id or "")[:20])
    if row is None or row.customer_id != customer.id:
        raise NotFoundError("We couldn't find that request.", error_code="REQUEST_NOT_FOUND")
    if row.status != "pending":
        raise ConflictError("Only a waiting request can be withdrawn.", error_code="NOT_PENDING")
    row.status, row.updated_at = "withdrawn", datetime.utcnow()
    db.commit()
    return row


def customer_requests(db: Session, customer: Customer) -> List[VtoAllocationRequest]:
    return list(db.execute(select(VtoAllocationRequest).where(VtoAllocationRequest.customer_id == customer.id)
                           .order_by(VtoAllocationRequest.created_at.desc()).limit(50)).scalars())


def request_out(row: VtoAllocationRequest, *, admin: bool = False) -> dict:
    out = {
        "id": row.id, "kind": row.kind, "reason": row.reason, "capabilities": row.capability_keys or [],
        "expectedUsage": row.expected_usage, "requestedModelId": row.requested_model_id,
        "startsOn": row.starts_on, "endsOn": row.ends_on, "message": row.message, "status": row.status,
        "decidedAt": row.decided_at, "decisionNote": row.decision_note, "allocationId": row.allocation_id,
        "createdAt": row.created_at,
    }
    if admin:
        out.update({"customerId": row.customer_id, "decidedBy": row.decided_by})
    return out


def allocation_out(db: Session, row: VtoAllocation, *, admin: bool = False) -> dict:
    used = entitlements.allocation_used(db, row)
    out = {
        "id": row.id, "kind": row.kind, "dedicated": row.kind == "dedicated_credential",
        "generations": row.generations, "used": used,
        "remaining": None if row.generations is None else max(row.generations - used, 0),
        "perDay": row.per_day, "capabilities": row.capability_keys or [], "startsAt": row.starts_at,
        "endsAt": row.ends_at, "status": row.status, "createdAt": row.created_at,
    }
    if admin:
        credential = db.get(VtoCredential, row.credential_id) if row.credential_id else None
        out.update({"customerId": row.customer_id, "requestId": row.request_id, "credentialId": row.credential_id,
                    "credentialLabel": credential.label if credential else "", "note": row.note,
                    "createdBy": row.created_by, "updatedAt": row.updated_at})
    return out


def customer_allocations(db: Session, customer: Customer) -> List[VtoAllocation]:
    return list(db.execute(select(VtoAllocation).where(VtoAllocation.customer_id == customer.id)
                           .order_by(VtoAllocation.created_at.desc()).limit(50)).scalars())


# --------------------------------------------------------------------- store


def list_requests(db: Session, *, status: str = "", customer_id: str = "", page: int = 1,
                  page_size: int = 25) -> Tuple[list, int, dict]:
    conditions = []
    if customer_id:
        conditions.append(VtoAllocationRequest.customer_id == customer_id[:20])
    counts = dict(db.execute(select(VtoAllocationRequest.status, func.count()).where(*conditions)
                             .group_by(VtoAllocationRequest.status)).all())
    if status:
        conditions.append(VtoAllocationRequest.status == status[:12])
    total = db.execute(select(func.count()).select_from(VtoAllocationRequest).where(*conditions)).scalar_one()
    rows = db.execute(select(VtoAllocationRequest).where(*conditions)
                      .order_by(VtoAllocationRequest.created_at.desc())
                      .offset((max(page, 1) - 1) * page_size).limit(page_size)).scalars().all()
    return list(rows), total, counts


def list_allocations(db: Session, *, status: str = "", customer_id: str = "", page: int = 1,
                     page_size: int = 25) -> Tuple[list, int]:
    conditions = []
    if status:
        conditions.append(VtoAllocation.status == status[:12])
    if customer_id:
        conditions.append(VtoAllocation.customer_id == customer_id[:20])
    total = db.execute(select(func.count()).select_from(VtoAllocation).where(*conditions)).scalar_one()
    rows = db.execute(select(VtoAllocation).where(*conditions).order_by(VtoAllocation.created_at.desc())
                      .offset((max(page, 1) - 1) * page_size).limit(page_size)).scalars().all()
    return list(rows), total


def _notify(db: Session, customer_id: str, title: str, body: str) -> None:
    try:
        from app.services import inbox

        inbox.customer(db, customer_id, "try-on", title, body, href="/account/try-on?tab=access")
    except Exception:  # noqa: BLE001
        pass


def _apply(db: Session, row: VtoAllocation, payload: dict) -> None:
    if "kind" in payload:
        if payload["kind"] not in ("allowance", "dedicated_credential"):
            raise ValidationError("Choose the kind of allocation.", error_code="INVALID_KIND")
        row.kind = payload["kind"]
    for key, attribute in (("generations", "generations"), ("perDay", "per_day")):
        if key in payload:
            value = payload[key]
            if value in (None, ""):
                setattr(row, attribute, None)
                continue
            try:
                number = int(value)
            except (TypeError, ValueError):
                raise ValidationError("Limits are whole numbers.", error_code="INVALID_LIMIT") from None
            if not 1 <= number <= 100000:
                raise ValidationError("Limits are between 1 and 100000.", error_code="INVALID_LIMIT")
            setattr(row, attribute, number)
    if "capabilities" in payload:
        row.capability_keys = _capabilities(db, payload["capabilities"])
    if "startsOn" in payload:
        starts = _date(payload["startsOn"], "start")
        row.starts_at = datetime.combine(starts, time.min) if starts else row.starts_at
    if "endsOn" in payload:
        ends = _date(payload["endsOn"], "end")
        row.ends_at = datetime.combine(ends, time.max.replace(microsecond=0)) if ends else None
    if row.ends_at and row.starts_at and row.ends_at <= row.starts_at:
        raise ValidationError("The end date is before the start.", error_code="INVALID_DATES")
    if "note" in payload:
        row.note = str(payload["note"] or "").strip()[:500]
    if "credentialId" in payload:
        row.credential_id = str(payload["credentialId"] or "").strip()[:20] or None
    if row.kind == "dedicated_credential":
        credential = db.get(VtoCredential, row.credential_id) if row.credential_id else None
        if credential is None or credential.deleted_at is not None:
            raise ValidationError("Choose the dedicated credential.", error_code="CREDENTIAL_REQUIRED")
        if credential.scope != "dedicated" or credential.dedicated_customer_id != row.customer_id:
            raise ValidationError(
                "That credential isn't dedicated to this customer. Mark it dedicated to them first.",
                error_code="CREDENTIAL_NOT_DEDICATED",
            )
        # One customer per dedicated credential, ever: refuse sharing it through a second allocation.
        other = db.execute(select(VtoAllocation.id).where(
            VtoAllocation.credential_id == credential.id, VtoAllocation.customer_id != row.customer_id,
            VtoAllocation.status == "active")).first()
        if other:
            raise ConflictError("That credential is allocated to another customer.", error_code="CREDENTIAL_TAKEN")
    else:
        row.credential_id = None


def create_allocation(db: Session, payload: dict, *, admin_id: str, request: Optional[VtoAllocationRequest] = None
                      ) -> VtoAllocation:
    if not isinstance(payload, dict):
        raise ValidationError("Send the allocation as an object.", error_code="INVALID_ALLOCATION")
    customer_id = request.customer_id if request else str(payload.get("customerId") or "").strip()[:20]
    if not customer_id or db.get(Customer, customer_id) is None:
        raise ValidationError("Choose the customer.", error_code="CUSTOMER_REQUIRED")
    now = datetime.utcnow()
    row = VtoAllocation(id=next_id(db, VtoAllocation, "vto_allocation"), customer_id=customer_id,
                        request_id=request.id if request else None, kind="allowance", capability_keys=[],
                        starts_at=now.replace(microsecond=0), status="active", note="", created_by=admin_id[:20],
                        created_at=now, updated_at=now)
    defaults = {}
    if request is not None:
        defaults = {"capabilities": request.capability_keys or [], "startsOn": request.starts_on,
                    "endsOn": request.ends_on, "generations": request.expected_usage or None}
    _apply(db, row, {**defaults, **{k: v for k, v in payload.items() if k != "customerId"}})
    db.add(row)
    db.flush()
    audit.record(db, "try_on_allocation.create", resource_type="try-on-allocation", resource_id=row.id,
                 summary=f"Allocated try-on access to {customer_id}"
                         + (f" on credential {row.credential_id}" if row.credential_id else ""))
    return row


def update_allocation(db: Session, allocation_id: str, payload: dict) -> VtoAllocation:
    row = get_allocation(db, allocation_id)
    if not isinstance(payload, dict):
        raise ValidationError("Send the changes as an object.", error_code="INVALID_ALLOCATION")
    before = audit.snapshot(row, ("kind", "generations", "per_day", "capability_keys", "starts_at", "ends_at",
                                  "credential_id", "status"))
    _apply(db, row, payload)
    if "status" in payload:
        if payload["status"] not in ("active", "disabled"):
            raise ValidationError("Use revoke to end an allocation.", error_code="INVALID_STATUS")
        if row.status in ("revoked", "expired"):
            raise ConflictError("A revoked or expired allocation can't be changed back.", error_code="ALLOCATION_ENDED")
        row.status = payload["status"]
    row.updated_at = datetime.utcnow()
    audit.record(db, "try_on_allocation.update", resource_type="try-on-allocation", resource_id=row.id,
                 summary=f"Updated try-on allocation {row.id}", changes=audit.diff(before, audit.snapshot(row, before)))
    return row


def get_allocation(db: Session, allocation_id: str) -> VtoAllocation:
    row = db.get(VtoAllocation, (allocation_id or "")[:20])
    if row is None:
        raise NotFoundError("We couldn't find that allocation.", error_code="ALLOCATION_NOT_FOUND")
    return row


def revoke(db: Session, allocation_id: str, note: str = "") -> VtoAllocation:
    row = get_allocation(db, allocation_id)
    if row.status in ("revoked", "expired"):
        return row
    row.status, row.updated_at = "revoked", datetime.utcnow()
    if note:
        row.note = (row.note + " · " + note.strip()).strip(" ·")[:500]
    audit.record(db, "try_on_allocation.revoke", resource_type="try-on-allocation", resource_id=row.id,
                 summary=f"Revoked try-on allocation {row.id}")
    _notify(db, row.customer_id, "Your extra try-on access has ended", "Your extra try-on allocation was withdrawn.")
    return row


def get_request(db: Session, request_id: str) -> VtoAllocationRequest:
    row = db.get(VtoAllocationRequest, (request_id or "")[:20])
    if row is None:
        raise NotFoundError("We couldn't find that request.", error_code="REQUEST_NOT_FOUND")
    return row


def decide(db: Session, request_id: str, decision: str, payload: dict, *, admin_id: str) -> VtoAllocationRequest:
    row = get_request(db, request_id)
    if row.status != "pending":
        raise ConflictError("This request has already been answered.", error_code="ALREADY_DECIDED")
    payload = payload if isinstance(payload, dict) else {}
    now = datetime.utcnow()
    note = str(payload.get("note") or "").strip()[:500]
    if decision == "approve":
        allocation = create_allocation(db, payload.get("allocation") or {}, admin_id=admin_id, request=row)
        row.allocation_id = allocation.id
        row.status = "approved"
        _notify(db, row.customer_id, "Your try-on request was approved",
                note or "You have extra try-on access. See your try-on page for details.")
    elif decision == "reject":
        row.status = "rejected"
        _notify(db, row.customer_id, "About your try-on request",
                note or "We couldn't approve your request for extra try-on access this time.")
    else:
        raise ValidationError("Approve or reject.", error_code="INVALID_DECISION")
    row.decided_by, row.decided_at, row.decision_note, row.updated_at = admin_id[:20], now, note, now
    audit.record(db, f"try_on_allocation_request.{decision}", resource_type="try-on-allocation-request",
                 resource_id=row.id, summary=f"{decision.capitalize()}d try-on request {row.id} of {row.customer_id}")
    return row
