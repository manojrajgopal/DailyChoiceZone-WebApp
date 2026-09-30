"""
Support tickets: raising one, routing it, and every move after that.

## The lifecycle

    submitted → triaged → assigned → acknowledged → in-progress
        ⇄ waiting-customer / waiting-internal → escalated → resolved → closed
    resolved / closed → reopened → assigned / in-progress …

`TRANSITIONS` is the whole of what staff may do by hand; anything else is
refused. The automatic moves (routing on creation, the first reply, a
customer answering, a reopen) only ever take steps that table allows.
"Reassigned" is an event, not a status: the ticket stays where it was in its
lifecycle and the history records who it moved from and to.

## The two sides

Everything a customer reads comes from `customer_view`, which leaves out
internal notes and their files, the audit trail, and every staff email
address. Staff read `staff_view`. Access is checked before either is built —
by account for a signed-in customer, by the emailed key for a guest, by
permission and team for staff (`can_work`).
"""

from __future__ import annotations

import hmac
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core import numbering
from app.core.errors import AuthorizationError, ConflictError, NotFoundError, ValidationError
from app.models import (
    AdminUser,
    Customer,
    CustomerMembership,
    Order,
    Product,
    SupportAgent,
    SupportCategory,
    SupportRole,
    SupportTeam,
    SupportTicket,
    TicketEvent,
    TicketFeedback,
    TicketLink,
    TicketMessage,
)
from app.services.support import attachments as files
from app.services.support import config, notify
from app.utils.ids import next_id

# ------------------------------------------------------------------ statuses

STATUSES = (
    "submitted", "triaged", "assigned", "acknowledged", "in-progress", "waiting-customer",
    "waiting-internal", "escalated", "resolved", "closed", "reopened",
)
STAFF_LABELS = {
    "submitted": "Submitted", "triaged": "Triaged", "assigned": "Assigned", "acknowledged": "Acknowledged",
    "in-progress": "In progress", "waiting-customer": "Waiting for customer",
    "waiting-internal": "Waiting for internal team", "escalated": "Escalated", "resolved": "Resolved",
    "closed": "Closed", "reopened": "Reopened",
}
CUSTOMER_LABELS = {
    "submitted": "Received", "triaged": "Received", "assigned": "Assigned", "acknowledged": "Seen by our team",
    "in-progress": "In progress", "waiting-customer": "Waiting for your reply",
    "waiting-internal": "In progress", "escalated": "Escalated", "resolved": "Resolved",
    "closed": "Closed", "reopened": "Reopened",
}
OPEN = tuple(s for s in STATUSES if s not in ("resolved", "closed"))
# Where the SLA clock is not the team's to answer for.
PAUSED = ("waiting-customer",)
TRANSITIONS: Dict[str, Tuple[str, ...]] = {
    "submitted": ("triaged", "assigned", "in-progress", "escalated", "resolved", "closed"),
    "triaged": ("assigned", "in-progress", "escalated", "resolved", "closed"),
    "assigned": ("acknowledged", "in-progress", "waiting-customer", "waiting-internal", "escalated", "resolved"),
    "acknowledged": ("in-progress", "waiting-customer", "waiting-internal", "escalated", "resolved"),
    "in-progress": ("waiting-customer", "waiting-internal", "escalated", "resolved"),
    "waiting-customer": ("in-progress", "resolved", "closed"),
    "waiting-internal": ("in-progress", "escalated", "resolved"),
    "escalated": ("assigned", "in-progress", "waiting-customer", "waiting-internal", "resolved"),
    "resolved": ("closed", "reopened"),
    "closed": ("reopened",),
    "reopened": ("assigned", "in-progress", "waiting-customer", "waiting-internal", "escalated", "resolved"),
}
# What a customer's filter tabs mean.
CUSTOMER_GROUPS = {
    "open": ("submitted", "triaged", "assigned", "acknowledged", "reopened", "escalated"),
    "in-progress": ("in-progress", "waiting-internal"),
    "waiting": ("waiting-customer",),
    "resolved": ("resolved",),
    "closed": ("closed",),
}
FEATURE_STAGES = ("requested", "under-review", "planned", "in-development", "released", "rejected")
FEATURE_LABELS = {
    "requested": "Requested", "under-review": "Under review", "planned": "Planned",
    "in-development": "In development", "released": "Released", "rejected": "Not planned",
}

# The extra fields each form collects: key → longest accepted value.
DETAIL_FIELDS: Dict[str, Dict[str, int]] = {
    "order": {"orderNumber": 30},
    "product": {"orderNumber": 30, "productName": 200},
    "delivery": {"orderNumber": 30, "trackingNumber": 60, "deliveryAddress": 500},
    "payment": {"orderNumber": 30, "paymentMethod": 30, "transactionRef": 80, "amount": 20, "paymentDate": 20},
    "membership": {"planName": 80},
    "account": {"accountEmail": 255, "device": 120},
    "bug": {"pageUrl": 500, "feature": 120, "browser": 120, "os": 120, "device": 120, "screen": 40,
            "steps": 3000, "expected": 1500, "actual": 1500, "consoleErrors": 4000, "userAgent": 400},
    "partnership": {"company": 160, "contactPerson": 120, "businessEmail": 255, "partnershipType": 60,
                    "website": 300, "phone": 20},
    "feature": {"featureTitle": 160, "useCase": 2000, "whyNeeded": 2000, "customerImpact": 60,
                "suggestedPriority": 20},
    "feedback": {"rating": 2},
    "general": {},
}
DETAIL_LABELS = {
    "orderNumber": "Order number", "productName": "Product", "trackingNumber": "Tracking number",
    "deliveryAddress": "Delivery address", "paymentMethod": "Payment method",
    "transactionRef": "Transaction reference", "amount": "Amount", "paymentDate": "Payment date",
    "planName": "Plan", "accountEmail": "Account email", "device": "Device", "pageUrl": "Page",
    "feature": "Feature", "browser": "Browser", "os": "Operating system", "screen": "Screen",
    "steps": "Steps to reproduce", "expected": "Expected result", "actual": "Actual result",
    "consoleErrors": "Error details", "userAgent": "User agent", "company": "Company",
    "contactPerson": "Contact person", "businessEmail": "Business email",
    "partnershipType": "Partnership type", "website": "Website", "phone": "Phone",
    "featureTitle": "Feature", "useCase": "Use case", "whyNeeded": "Why it's needed",
    "customerImpact": "Impact", "suggestedPriority": "Suggested priority", "rating": "Rating",
}

EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")
PHONE = re.compile(r"^[6-9]\d{9}$")


@dataclass
class Actor:
    kind: str  # customer | agent | system
    id: str = ""
    name: str = ""
    admin: Optional[AdminUser] = None
    agent: Optional[SupportAgent] = None


SYSTEM = Actor("system", "", "System")


def status_label(status: str, audience: str = "staff") -> str:
    return (CUSTOMER_LABELS if audience == "customer" else STAFF_LABELS).get(status, status)


# ---------------------------------------------------------------- identity


def guest_key(ticket: SupportTicket) -> str:
    from app.services.email import crypto

    if not ticket.access_key:
        return ""
    try:
        return crypto.unseal(ticket.access_key).get("k", "")
    except Exception:
        return ""


def _seal_key(key: str) -> str:
    from app.services.email import crypto

    return crypto.seal({"k": key})


def find_for_customer(db: Session, number: str, *, customer: Optional[Customer], key: str = "") -> SupportTicket:
    """
    A ticket the caller may read — theirs by account, or by the guest key.

    Every refusal is the same 404, so trying numbers learns nothing about
    which ones exist.
    """
    ticket = db.execute(select(SupportTicket).where(SupportTicket.number == (number or "").strip())).scalar_one_or_none()
    missing = NotFoundError("We couldn't find that request.", error_code="TICKET_NOT_FOUND")
    if ticket is None:
        raise missing
    if customer is not None and ticket.customer_id == customer.id:
        return ticket
    expected = guest_key(ticket)
    if key and expected and hmac.compare_digest(key, expected):
        return ticket
    raise missing


def agent_for(db: Session, admin: AdminUser) -> Optional[SupportAgent]:
    return db.execute(select(SupportAgent).where(SupportAgent.admin_user_id == admin.id)).scalar_one_or_none()


def staff_actor(db: Session, admin: AdminUser) -> Actor:
    agent = agent_for(db, admin)
    return Actor("agent", admin.id, agent.name if agent else admin.name, admin=admin, agent=agent)


def sees_everything(admin: AdminUser) -> bool:
    from app.core.permissions import permissions_for

    if admin.role == "super-admin":
        return True
    # Permissions follow the role (the stored list is a copy of it, written
    # when the role is set), so a resource added later reaches the roles it
    # was added to without rewriting any administrator's record.
    return "support" in (admin.permissions or []) or "support" in permissions_for(admin.role)


def can_work(db: Session, admin: AdminUser, ticket: Optional[SupportTicket] = None) -> Optional[SupportAgent]:
    """
    Refuse an administrator who may not handle this ticket (or any, with no ticket).

    Everyone with the `support` permission sees every ticket. An agent linked
    to a portal account without it sees their own team's tickets and those
    assigned to them — nothing else.
    """
    agent = agent_for(db, admin)
    if sees_everything(admin):
        return agent
    if agent is None or not agent.active:
        raise AuthorizationError("Your role doesn't include support.", error_code="PERMISSION_DENIED")
    if ticket is not None and ticket.agent_id != agent.id and (agent.team_id is None or ticket.team_id != agent.team_id):
        raise NotFoundError("We couldn't find that ticket.", error_code="TICKET_NOT_FOUND")
    return agent


# ------------------------------------------------------------------- history


def _event(ticket: SupportTicket, kind: str, actor: Actor, *, from_value: str = "", to_value: str = "",
           note: str = "") -> None:
    ticket.events.append(TicketEvent(
        kind=kind, from_value=from_value[:160], to_value=to_value[:160], note=note[:500],
        actor_kind=actor.kind, actor_id=actor.id or "", actor_name=actor.name or "",
        created_at=datetime.utcnow(),
    ))


def _system(ticket: SupportTicket, body: str) -> None:
    """A line both sides see in the conversation: an assignment, a status change."""
    ticket.messages.append(TicketMessage(kind="system", author_name="", body=body, created_at=datetime.utcnow()))


def _touch(ticket: SupportTicket) -> None:
    ticket.updated_at = datetime.utcnow()


# ---------------------------------------------------------------- assignment


def open_count(db: Session, agent_id: int) -> int:
    return db.execute(
        select(func.count()).select_from(SupportTicket)
        .where(SupportTicket.agent_id == agent_id, SupportTicket.status.in_(OPEN))
    ).scalar_one()


def pick_agent(db: Session, team: Optional[SupportTeam]) -> Optional[SupportAgent]:
    """Who in the team takes a new request, by the team's own strategy."""
    if team is None or team.assignment == "manual":
        return None
    candidates = list(db.execute(
        select(SupportAgent).where(
            SupportAgent.team_id == team.id, SupportAgent.active.is_(True), SupportAgent.available.is_(True),
        ).order_by(SupportAgent.id)
    ).scalars().all())
    if not candidates:
        return None
    if team.assignment == "least-active":
        return min(candidates, key=lambda a: (open_count(db, a.id), a.id))
    # Round robin: the next agent after the last one given a request.
    after = [a for a in candidates if team.last_assigned_agent_id is None or a.id > team.last_assigned_agent_id]
    chosen = (after or candidates)[0]
    team.last_assigned_agent_id = chosen.id
    return chosen


def assign(db: Session, ticket: SupportTicket, *, team_id: Optional[int], agent_id: Optional[int],
           actor: Actor, notify_people: bool = True) -> SupportTicket:
    """Move a ticket to a team and/or an agent, recording who did it."""
    team = db.get(SupportTeam, team_id) if team_id else None
    if team_id and (team is None or not team.active):
        raise ValidationError("Choose an active team.", error_code="TEAM_NOT_FOUND")
    agent = db.get(SupportAgent, agent_id) if agent_id else None
    if agent_id and (agent is None or not agent.active):
        raise ValidationError("Choose an active agent.", error_code="AGENT_NOT_FOUND")
    if agent is not None and team is None:
        team = db.get(SupportTeam, agent.team_id) if agent.team_id else None

    old_team = db.get(SupportTeam, ticket.team_id) if ticket.team_id else None
    old_agent = db.get(SupportAgent, ticket.agent_id) if ticket.agent_id else None
    new_team_id = team.id if team else None
    new_agent_id = agent.id if agent else None
    if new_team_id == ticket.team_id and new_agent_id == ticket.agent_id:
        return ticket

    if new_team_id != ticket.team_id:
        _event(ticket, "team", actor, from_value=old_team.name if old_team else "", to_value=team.name if team else "")
    if new_agent_id != ticket.agent_id:
        _event(ticket, "reassigned" if old_agent else "assigned", actor,
               from_value=old_agent.name if old_agent else "", to_value=agent.name if agent else "Unassigned")
    ticket.team_id, ticket.agent_id = new_team_id, new_agent_id

    if agent is not None:
        _system(ticket, f"Assigned to {agent.name}" + (f" ({team.name})." if team else "."))
        if ticket.status in ("submitted", "triaged", "reopened"):
            _move(ticket, "assigned", actor)
    elif team is not None:
        _system(ticket, f"Your request is with our {team.name} team.")
        if ticket.status == "submitted":
            _move(ticket, "triaged", actor)
    _touch(ticket)

    if notify_people:
        if agent is not None:
            notify.staff(db, ticket, "agent_assigned", title=f"{ticket.number} assigned to you",
                         exclude_admin_id=actor.admin.id if actor.admin and actor.admin.id == agent.admin_user_id else None)
            notify.customer(db, ticket, "ticket_assigned", title=f"{ticket.number} is with {agent.name}")
        elif team is not None:
            notify.staff(db, ticket, "new_ticket", title=f"{ticket.number} moved to {team.name}", audience="team",
                         message=ticket.description[:600])
    return ticket


# ------------------------------------------------------------------- status


def _move(ticket: SupportTicket, status: str, actor: Actor, note: str = "") -> None:
    """Change status and record it. Callers check the transition first."""
    old = ticket.status
    ticket.status = status
    now = datetime.utcnow()
    if old in PAUSED and status not in PAUSED:
        _resume_clock(ticket, old, now)
    if status == "resolved":
        ticket.resolved_at = now
    if status == "closed":
        ticket.closed_at = now
    _event(ticket, "status", actor, from_value=old, to_value=status, note=note)
    if CUSTOMER_LABELS.get(old) != CUSTOMER_LABELS.get(status):
        _system(ticket, f"Status changed from {CUSTOMER_LABELS.get(old, old)} to {CUSTOMER_LABELS.get(status, status)}.")
    _touch(ticket)


def _resume_clock(ticket: SupportTicket, paused_status: str, now: datetime) -> None:
    """
    Give back the time spent waiting on the customer: the target moves later by
    as long as the ticket sat paused, so an answer we waited on is never a
    breach the moment it arrives.
    """
    since = next((e.created_at for e in reversed(ticket.events)
                  if e.kind == "status" and e.to_value == paused_status), None)
    if since is None or ticket.resolve_due_at is None:
        return
    waited = now - since
    if waited.total_seconds() <= 0:
        return
    ticket.resolve_due_at += waited
    if ticket.response_due_at is not None and ticket.first_response_at is None:
        ticket.response_due_at += waited
    if ticket.resolve_due_at > now:
        ticket.sla_breached = False


def transitions_for(ticket: SupportTicket) -> List[str]:
    return list(TRANSITIONS.get(ticket.status, ()))


def set_status(db: Session, ticket: SupportTicket, status: str, actor: Actor, *, note: str = "",
               notify_customer: bool = True) -> SupportTicket:
    if ticket.merged_into_id:
        raise ConflictError("This ticket was merged into another; work on that one.", error_code="TICKET_MERGED")
    if status not in STATUSES:
        raise ValidationError(f"'{status}' isn't a ticket status.", error_code="INVALID_STATUS")
    if status == ticket.status:
        return ticket
    if status not in TRANSITIONS.get(ticket.status, ()):
        raise ConflictError(
            f"A ticket that is {STAFF_LABELS[ticket.status].lower()} can't move to {STAFF_LABELS[status].lower()}.",
            error_code="INVALID_TRANSITION",
        )
    if status == "reopened":
        _reopen(db, ticket, actor, note=note)
    else:
        _move(ticket, status, actor, note)
    if notify_customer:
        _announce(db, ticket, status)
    return ticket


def _announce(db: Session, ticket: SupportTicket, status: str) -> None:
    label = CUSTOMER_LABELS[status]
    if status == "resolved":
        notify.customer(db, ticket, "ticket_resolved", title=f"{ticket.number} has been resolved")
    elif status == "closed":
        notify.customer(db, ticket, "ticket_closed", title=f"{ticket.number} has been closed")
    elif status == "reopened":
        notify.customer(db, ticket, "ticket_reopened", title=f"{ticket.number} has been reopened")
    else:
        notify.customer(db, ticket, "status_changed", title=f"{ticket.number}: {label}")


def _reopen(db: Session, ticket: SupportTicket, actor: Actor, note: str = "") -> None:
    _move(ticket, "reopened", actor, note)
    ticket.reopened_count += 1
    ticket.resolved_at = None
    ticket.closed_at = None
    now = datetime.utcnow()
    _, ticket.resolve_due_at = config.due_dates(db, ticket.priority, now)
    ticket.sla_warned = False
    ticket.sla_breached = False
    ticket.escalations_applied = []
    notify.staff(db, ticket, "customer_replied" if actor.kind == "customer" else "new_ticket",
                 title=f"{ticket.number} was reopened", message=note or "The request was reopened.",
                 exclude_admin_id=actor.admin.id if actor.admin else None)


def set_priority(db: Session, ticket: SupportTicket, priority: str, actor: Actor) -> SupportTicket:
    if priority not in config.PRIORITIES:
        raise ValidationError("Choose low, medium, high or urgent.", error_code="INVALID_PRIORITY")
    if priority == ticket.priority:
        return ticket
    old = ticket.priority
    old_targets, new_targets = config.sla_hours(db, old), config.sla_hours(db, priority)
    # Shift the targets by the difference, from wherever the clock started.
    if ticket.response_due_at and not ticket.first_response_at:
        start = ticket.response_due_at - timedelta(hours=old_targets["response"])
        ticket.response_due_at = start + timedelta(hours=new_targets["response"])
    if ticket.resolve_due_at and ticket.status in OPEN:
        start = ticket.resolve_due_at - timedelta(hours=old_targets["resolve"])
        ticket.resolve_due_at = start + timedelta(hours=new_targets["resolve"])
        if ticket.resolve_due_at > datetime.utcnow():
            ticket.sla_breached = False
            ticket.sla_warned = False
    ticket.priority = priority
    _event(ticket, "priority", actor, from_value=old, to_value=priority)
    _touch(ticket)
    if priority in ("high", "urgent") and config.PRIORITIES.index(priority) > config.PRIORITIES.index(old):
        notify.staff(db, ticket, "urgent_ticket", title=f"{ticket.number} is now {priority}", audience="team-lead",
                     message=ticket.subject)
    return ticket


def set_feature_stage(db: Session, ticket: SupportTicket, stage: str, actor: Actor) -> SupportTicket:
    if ticket.contact_type != "feature":
        raise ConflictError("Only feature requests have a stage.", error_code="NOT_A_FEATURE_REQUEST")
    if stage not in FEATURE_STAGES:
        raise ValidationError("Choose a stage.", error_code="INVALID_STAGE")
    if stage == ticket.feature_stage:
        return ticket
    _event(ticket, "stage", actor, from_value=ticket.feature_stage, to_value=stage)
    _system(ticket, f"Feature request stage: {FEATURE_LABELS[stage]}.")
    ticket.feature_stage = stage
    _touch(ticket)
    notify.customer(db, ticket, "status_changed", title=f"{ticket.number}: {FEATURE_LABELS[stage]}",
                    status=FEATURE_LABELS[stage])
    return ticket


# ------------------------------------------------------------------ creating


def _clean_details(form: str, raw: dict) -> dict:
    fields = DETAIL_FIELDS.get(form, {})
    out = {}
    for key, limit in fields.items():
        value = (raw or {}).get(key)
        if value is None:
            continue
        text = str(value).strip()[:limit]
        if text:
            out[key] = text
    return out


def _node(db: Session, node_id, *, parent: Optional[SupportCategory], level: int) -> Optional[SupportCategory]:
    if node_id in (None, ""):
        return None
    node = db.get(SupportCategory, int(node_id))
    if node is None or not node.active or node.level != level or node.parent_id != (parent.id if parent else None):
        raise ValidationError("Please choose from the options shown.", error_code="INVALID_CATEGORY")
    return node


def _has_children(db: Session, node: SupportCategory) -> bool:
    return db.execute(
        select(SupportCategory.id).where(SupportCategory.parent_id == node.id, SupportCategory.active.is_(True)).limit(1)
    ).first() is not None


def _next_number(db: Session, prefix: str, now: datetime) -> str:
    stem = f"{prefix}-{now.year}-"
    last = db.execute(
        select(SupportTicket.number).where(SupportTicket.number.like(f"{stem}%"))
        .order_by(func.length(SupportTicket.number).desc(), SupportTicket.number.desc())
        .limit(1).with_for_update()
    ).scalar_one_or_none()
    count = int(last.rsplit("-", 1)[1]) if last else 0
    # At least six digits, and longer once the year passes 999,999 requests.
    return f"{stem}{count + 1:0{numbering.TICKET.min_digits}d}"


def selectable(db: Session, node: SupportCategory) -> dict:
    """The teams and agents a customer may choose between for this category."""
    routing = config.resolve(db, node)
    if routing.customer_choice not in ("team", "agent"):
        return {"choice": "", "teams": []}
    team_ids = routing.choice_team_ids or ([routing.team_id] if routing.team_id else [])
    teams = [t for t in (db.get(SupportTeam, i) for i in team_ids) if t is not None and t.active]
    out = []
    for team in teams:
        agents = []
        if routing.customer_choice == "agent":
            rows = db.execute(
                select(SupportAgent, SupportRole.name)
                .outerjoin(SupportRole, SupportRole.id == SupportAgent.role_id)
                .where(SupportAgent.team_id == team.id, SupportAgent.active.is_(True),
                       SupportAgent.show_to_customers.is_(True))
                .order_by(SupportAgent.name)
            ).all()
            agents = [
                # Never the email: the customer chooses a person, the system knows the address.
                {"id": agent.id, "name": agent.name, "role": role or "", "specialization": agent.specialization,
                 "photoUrl": agent.photo_url, "available": agent.available}
                for agent, role in rows
            ]
        out.append({"id": team.id, "name": team.name, "description": team.description, "agents": agents})
    return {"choice": routing.customer_choice, "teams": out}


def create(db: Session, payload: dict, *, customer: Optional[Customer], uploads: List[Tuple[str, bytes]],
           user_agent: str = "", channel: str = "form") -> Tuple[SupportTicket, str]:
    """
    Raise a ticket. Returns it and, for a guest, the key that opens it.

    Everything is checked before anything is written — the category path, the
    customer's own order, the files — so a refusal leaves no half-made ticket.
    """
    conf = config.settings(db)
    if str(payload.get("website") or "").strip():
        # The honeypot field is invisible to people; only a form-filling bot sets it.
        raise ValidationError("We couldn't send that. Please try again.", error_code="REJECTED")

    category = _node(db, payload.get("categoryId"), parent=None, level=1)
    if category is None and channel != "chat":
        raise ValidationError("Choose what you need help with.", error_code="CATEGORY_REQUIRED")
    subcategory = _node(db, payload.get("subcategoryId"), parent=category, level=2) if category else None
    if category is not None and subcategory is None and _has_children(db, category) and channel != "chat":
        raise ValidationError("Choose the option that fits best.", error_code="SUBCATEGORY_REQUIRED")
    issue = _node(db, payload.get("issueId"), parent=subcategory, level=3) if subcategory else None
    if subcategory is not None and issue is None and _has_children(db, subcategory):
        raise ValidationError("Choose the issue that fits best.", error_code="ISSUE_REQUIRED")
    deepest = issue or subcategory or category
    routing = config.resolve(db, deepest)

    # ---- who is asking
    if customer is not None:
        name = customer.full_name
        email = customer.email
        phone = customer.phone or re.sub(r"\D", "", str(payload.get("phone") or ""))[-10:]
    else:
        name = str(payload.get("name") or "").strip()[:160]
        email = str(payload.get("email") or "").strip().lower()[:255]
        phone = re.sub(r"\D", "", str(payload.get("phone") or ""))[-10:]
        if len(name) < 2:
            raise ValidationError("Enter your name.", error_code="NAME_REQUIRED")
        if not EMAIL.match(email):
            raise ValidationError("Enter a valid email address so we can reply.", error_code="EMAIL_REQUIRED")
    if phone and not PHONE.match(phone):
        raise ValidationError("Enter a 10-digit mobile number, or leave it blank.", error_code="INVALID_PHONE")

    description = str(payload.get("description") or "").strip()
    if len(description) < 10:
        raise ValidationError("Please tell us a little more (at least 10 characters).", error_code="DESCRIPTION_TOO_SHORT")
    if len(description) > 5000:
        raise ValidationError("Please keep the description under 5,000 characters.", error_code="DESCRIPTION_TOO_LONG")
    subject = str(payload.get("subject") or "").strip()[:200] or (
        deepest.name if deepest is not None else description[:80]
    )

    details = _clean_details(routing.form, payload.get("details") or {})
    if routing.form == "bug" and user_agent:
        details.setdefault("userAgent", user_agent[:400])

    # ---- what it is about — only the customer's own records
    order = None
    if payload.get("orderId"):
        order = db.get(Order, str(payload["orderId"]))
        if order is None or customer is None or order.customer_id != customer.id:
            raise NotFoundError("We couldn't find that order on your account.", error_code="ORDER_NOT_FOUND")
    product = None
    if payload.get("productId"):
        product = db.get(Product, str(payload["productId"]))
        if product is None:
            raise NotFoundError("We couldn't find that product.", error_code="PRODUCT_NOT_FOUND")
    membership = None
    if customer is not None and routing.form == "membership":
        from app.services.membership import active_membership

        membership = active_membership(db, customer.id)

    # ---- who handles it
    team = db.get(SupportTeam, routing.team_id) if routing.team_id else None
    if team is not None and not team.active:
        team = db.get(SupportTeam, conf.get("defaultTeamId")) if conf.get("defaultTeamId") else None
    agent = None
    chosen_by_customer = False
    if deepest is not None and (payload.get("teamId") or payload.get("agentId")):
        options = selectable(db, deepest)
        teams = {t["id"]: t for t in options["teams"]}
        if payload.get("teamId"):
            if int(payload["teamId"]) not in teams:
                raise ValidationError("Choose one of the teams shown.", error_code="INVALID_TEAM")
            team = db.get(SupportTeam, int(payload["teamId"]))
        if payload.get("agentId"):
            wanted = int(payload["agentId"])
            owner = next((t for t in teams.values() if any(a["id"] == wanted for a in t["agents"])), None)
            if owner is None:
                raise ValidationError("Choose one of the people shown.", error_code="INVALID_AGENT")
            agent = db.get(SupportAgent, wanted)
            team = db.get(SupportTeam, owner["id"])
        chosen_by_customer = True
    if agent is None:
        agent = pick_agent(db, team)

    checked = files.validate(uploads, conf.get("attachments") or {})

    # ---- write it
    now = datetime.utcnow()
    key = "" if customer is not None else secrets.token_urlsafe(24)
    ticket = SupportTicket(
        id=next_id(db, SupportTicket, "support_ticket"),
        number=_next_number(db, numbering.TICKET.prefix, now),
        customer_id=customer.id if customer else None,
        name=name, email=email, phone=phone, access_key=_seal_key(key) if key else "",
        channel=channel, contact_type=routing.contact_type,
        category_id=category.id if category else None,
        subcategory_id=subcategory.id if subcategory else None,
        issue_id=issue.id if issue else None,
        category_label=category.name if category else "Live chat",
        subcategory_label=subcategory.name if subcategory else "",
        issue_label=issue.name if issue else "",
        subject=subject, description=description, details=details,
        order_id=order.id if order else None, product_id=product.id if product else None,
        membership_id=membership.id if membership else None,
        priority=routing.priority, team_id=None, agent_id=None, status="submitted",
        feature_stage="requested" if routing.contact_type == "feature" else "",
        escalations_applied=[],
        last_message_at=now, last_message_preview=description[:200],
        agent_unread=1, created_at=now, updated_at=now,
    )
    ticket.response_due_at, ticket.resolve_due_at = config.due_dates(db, routing.priority, now, routing.sla_hours)
    requester = Actor("customer", customer.id if customer else "", name)
    first = TicketMessage(kind="customer", author_name=name, body=description, created_at=now)
    ticket.messages.append(first)
    _event(ticket, "created", requester, to_value=routing.priority,
           note=" › ".join(p for p in (ticket.category_label, ticket.subcategory_label, ticket.issue_label) if p))
    _system(ticket, "Your request has been received.")
    db.add(ticket)
    db.flush()

    if checked:
        for row in files.store(ticket.id, checked, message_id=first.id, uploaded_by="customer", internal=False):
            ticket.attachments.append(row)

    if chosen_by_customer:
        _event(ticket, "customer-choice", requester, to_value=(agent.name if agent else team.name if team else ""))
    assign(db, ticket, team_id=team.id if team else None, agent_id=agent.id if agent else None,
           actor=SYSTEM, notify_people=False)

    notify.customer(db, ticket, "ticket_created", title=f"We've received {ticket.number}", message=description[:600])
    if agent is not None:
        # The person who has it hears once, as its owner — not again as a team member.
        notify.staff(db, ticket, "agent_assigned", title=f"{ticket.number} assigned to you")
    else:
        notify.staff(db, ticket, "new_ticket", title=f"New {ticket.priority} request {ticket.number}",
                     audience="team", message=description[:600])
    if ticket.priority in ("high", "urgent"):
        notify.staff(db, ticket, "urgent_ticket", title=f"{ticket.priority.title()} request {ticket.number}",
                     audience="team-lead", message=description[:600])
    db.commit()
    db.refresh(ticket)
    return ticket, key


def duplicates(db: Session, customer: Customer, payload: dict) -> List[SupportTicket]:
    """The customer's open requests about the same thing, before they raise another."""
    days = int(config.settings(db).get("duplicateWindowDays") or 30)
    statement = select(SupportTicket).where(
        SupportTicket.customer_id == customer.id,
        SupportTicket.status.in_(OPEN),
        SupportTicket.merged_into_id.is_(None),
        SupportTicket.created_at >= datetime.utcnow() - timedelta(days=days),
    )
    issue_id, sub_id = payload.get("issueId"), payload.get("subcategoryId")
    if issue_id:
        statement = statement.where(SupportTicket.issue_id == int(issue_id))
    elif sub_id:
        statement = statement.where(SupportTicket.subcategory_id == int(sub_id))
    elif payload.get("categoryId"):
        statement = statement.where(SupportTicket.category_id == int(payload["categoryId"]))
    else:
        return []
    if payload.get("orderId"):
        statement = statement.where(or_(SupportTicket.order_id == str(payload["orderId"]),
                                        SupportTicket.order_id.is_(None)))
    return list(db.execute(statement.order_by(SupportTicket.created_at.desc()).limit(5)).scalars().all())


# ------------------------------------------------------------------ messages


def _preview(ticket: SupportTicket, body: str, now: datetime) -> None:
    ticket.last_message_at = now
    ticket.last_message_preview = (body or "Sent a file").strip()[:200]
    ticket.updated_at = now


def customer_message(db: Session, ticket: SupportTicket, body: str, uploads: List[Tuple[str, bytes]],
                     *, customer: Optional[Customer]) -> TicketMessage:
    if ticket.merged_into_id:
        target = db.get(SupportTicket, ticket.merged_into_id)
        raise ConflictError(f"This request continues in {target.number if target else 'another request'}.",
                            error_code="TICKET_MERGED")
    if ticket.status == "closed":
        raise ConflictError("This request is closed. Reopen it to reply.", error_code="TICKET_CLOSED")
    body = (body or "").strip()
    if not body and not uploads:
        raise ValidationError("Write a message or attach a file.", error_code="EMPTY_MESSAGE")
    if len(body) > 5000:
        raise ValidationError("Please keep messages under 5,000 characters.", error_code="MESSAGE_TOO_LONG")
    checked = files.validate(uploads, config.settings(db).get("attachments") or {})

    actor = Actor("customer", customer.id if customer else "", ticket.name)
    if ticket.status == "resolved":
        _reopen(db, ticket, actor, note="The customer replied after it was resolved.")
    elif ticket.status == "waiting-customer":
        _move(ticket, "in-progress", actor)

    now = datetime.utcnow()
    message = TicketMessage(kind="customer", author_name=ticket.name, body=body, created_at=now)
    ticket.messages.append(message)
    db.flush()
    for row in files.store(ticket.id, checked, message_id=message.id, uploaded_by="customer", internal=False):
        ticket.attachments.append(row)
    _mark_read(ticket, reader="customer", now=now)
    ticket.agent_unread += 1
    ticket.customer_typing_at = None
    _preview(ticket, body, now)
    notify.staff(db, ticket, "customer_replied", title=f"{ticket.name} replied on {ticket.number}", message=body[:1000])
    db.commit()
    db.refresh(message)
    return message


def staff_message(db: Session, ticket: SupportTicket, actor: Actor, body: str, uploads: List[Tuple[str, bytes]],
                  *, internal: bool, status: Optional[str] = None) -> TicketMessage:
    if ticket.merged_into_id:
        raise ConflictError("This ticket was merged into another; reply there.", error_code="TICKET_MERGED")
    body = (body or "").strip()
    if not body and not uploads:
        raise ValidationError("Write a message or attach a file.", error_code="EMPTY_MESSAGE")
    if len(body) > 10000:
        raise ValidationError("Please keep messages under 10,000 characters.", error_code="MESSAGE_TOO_LONG")
    if not internal and ticket.status == "closed":
        raise ConflictError("Reopen the ticket before replying to the customer.", error_code="TICKET_CLOSED")
    if status and status not in STATUSES:
        raise ValidationError("Choose a status.", error_code="INVALID_STATUS")
    checked = files.validate(uploads, config.settings(db).get("attachments") or {})

    now = datetime.utcnow()
    agent = actor.agent
    message = TicketMessage(
        kind="note" if internal else "agent", author_admin_id=actor.id or None,
        author_agent_id=agent.id if agent else None, author_name=actor.name, body=body, created_at=now,
    )
    ticket.messages.append(message)
    db.flush()
    for row in files.store(ticket.id, checked, message_id=message.id, uploaded_by="agent", internal=internal):
        ticket.attachments.append(row)

    if internal:
        _event(ticket, "note", actor, note=body[:200])
        _touch(ticket)
    else:
        if ticket.first_response_at is None:
            ticket.first_response_at = now
        # Whoever answers an unassigned ticket takes it.
        if ticket.agent_id is None and agent is not None and agent.active:
            assign(db, ticket, team_id=agent.team_id or ticket.team_id, agent_id=agent.id, actor=actor,
                   notify_people=False)
        _mark_read(ticket, reader="agent", now=now)
        ticket.customer_unread += 1
        ticket.agent_typing_at = None
        _event(ticket, "reply", actor)
        _preview(ticket, body, now)
        # Answering the customer is working the ticket; any status asked for
        # is taken from there.
        if ticket.status in ("submitted", "triaged", "assigned", "acknowledged", "reopened", "escalated"):
            _move(ticket, "in-progress", actor)
        if status and status != ticket.status:
            set_status(db, ticket, status, actor, notify_customer=False)
        notify.customer(db, ticket, "agent_replied", title=f"New reply on {ticket.number}", message=body[:1000])
    db.commit()
    db.refresh(message)
    return message


def _mark_read(ticket: SupportTicket, *, reader: str, now: datetime) -> None:
    """The reader has seen everything the other side sent."""
    theirs = ("agent", "system") if reader == "customer" else ("customer",)
    for message in ticket.messages:
        if message.kind in theirs and message.read_at is None:
            message.read_at = now
    if reader == "customer":
        ticket.customer_unread = 0
    else:
        ticket.agent_unread = 0


def mark_read(db: Session, ticket: SupportTicket, reader: str) -> None:
    _mark_read(ticket, reader=reader, now=datetime.utcnow())
    db.commit()


def typing(db: Session, ticket: SupportTicket, side: str) -> None:
    now = datetime.utcnow()
    if side == "customer":
        ticket.customer_typing_at = now
    else:
        ticket.agent_typing_at = now
    db.commit()


# --------------------------------------------------------- customer actions


def _reopen_until(db: Session, ticket: SupportTicket) -> Optional[datetime]:
    base = ticket.closed_at or ticket.resolved_at
    if base is None:
        return None
    return base + timedelta(days=int(config.settings(db).get("reopenDays") or 0))


def customer_close(db: Session, ticket: SupportTicket, customer: Optional[Customer]) -> SupportTicket:
    if ticket.status == "closed":
        return ticket
    actor = Actor("customer", customer.id if customer else "", ticket.name)
    _move(ticket, "closed", actor, note="Closed by the customer.")
    notify.staff(db, ticket, "customer_replied", title=f"{ticket.name} closed {ticket.number}",
                 message="The customer closed this request.")
    db.commit()
    return ticket


def customer_reopen(db: Session, ticket: SupportTicket, customer: Optional[Customer], reason: str = "") -> SupportTicket:
    if ticket.status not in ("resolved", "closed"):
        raise ConflictError("This request is still open.", error_code="TICKET_OPEN")
    if ticket.merged_into_id:
        raise ConflictError("This request continues in another one.", error_code="TICKET_MERGED")
    until = _reopen_until(db, ticket)
    if until is None or datetime.utcnow() > until:
        raise ConflictError("This request can no longer be reopened — please raise a new one.",
                            error_code="REOPEN_WINDOW_CLOSED")
    actor = Actor("customer", customer.id if customer else "", ticket.name)
    _reopen(db, ticket, actor, note=reason.strip()[:500])
    notify.customer(db, ticket, "ticket_reopened", title=f"{ticket.number} has been reopened")
    db.commit()
    return ticket


def feedback(db: Session, ticket: SupportTicket, rating, comment: str) -> TicketFeedback:
    if ticket.status not in ("resolved", "closed"):
        raise ConflictError("You can rate a request once it's resolved.", error_code="TICKET_OPEN")
    if db.get(TicketFeedback, ticket.id) is not None:
        raise ConflictError("You've already rated this request — thank you.", error_code="ALREADY_RATED")
    try:
        score = int(rating)
    except (TypeError, ValueError):
        score = 0
    if not 1 <= score <= 5:
        raise ValidationError("Choose from one to five stars.", error_code="INVALID_RATING")
    row = TicketFeedback(ticket_id=ticket.id, rating=score, comment=(comment or "").strip()[:1000],
                         agent_id=ticket.agent_id, customer_id=ticket.customer_id, created_at=datetime.utcnow())
    db.add(row)
    _event(ticket, "feedback", Actor("customer", ticket.customer_id or "", ticket.name), to_value=f"{score}/5")
    db.commit()
    return row


# ------------------------------------------------------------ staff actions


def escalate(db: Session, ticket: SupportTicket, actor: Actor, reason: str, *, rule_notify: Optional[str] = None) -> SupportTicket:
    """Raise a ticket's escalation level and tell the next people up."""
    ticket.escalation_level += 1
    level = ticket.escalation_level
    audience = rule_notify or ("team-lead" if level == 1 else "admins" if level == 2 else "super-admins")
    _event(ticket, "escalated", actor, to_value=f"Level {level}", note=reason)
    if ticket.status != "escalated" and "escalated" in TRANSITIONS.get(ticket.status, ()):
        _move(ticket, "escalated", actor, note=reason)
    _touch(ticket)
    notify.staff(db, ticket, "escalation", title=f"{ticket.number} escalated", audience=audience,
                 escalation_reason=reason or "escalated by the team", message=reason)
    return ticket


def merge(db: Session, source: SupportTicket, target: SupportTicket, actor: Actor) -> SupportTicket:
    """
    Fold a duplicate into the ticket that carries on. Nothing is moved or
    deleted: the duplicate keeps its messages and history, is closed, and
    points to the one that continues.
    """
    if source.id == target.id:
        raise ValidationError("Choose a different ticket.", error_code="SAME_TICKET")
    if source.merged_into_id or target.merged_into_id:
        raise ConflictError("One of those tickets has already been merged.", error_code="ALREADY_MERGED")
    same_person = (source.customer_id and source.customer_id == target.customer_id) or (
        not source.customer_id and source.email.lower() == target.email.lower())
    if not same_person:
        raise ConflictError("Only tickets from the same customer can be merged.", error_code="DIFFERENT_CUSTOMER")
    source.merged_into_id = target.id
    if source.status != "closed":
        _move(source, "closed", actor, note=f"Merged into {target.number}.")
    _system(source, f"This request was merged into {target.number}. We'll continue there.")
    _system(target, f"{source.number} was merged into this request.")
    _event(source, "merged", actor, to_value=target.number)
    _event(target, "merged-in", actor, from_value=source.number)
    db.add(TicketLink(ticket_id=source.id, other_id=target.id, kind="merged", created_by=actor.name,
                      created_at=datetime.utcnow()))
    _touch(target)
    db.commit()
    return target


def link(db: Session, ticket: SupportTicket, other: SupportTicket, actor: Actor) -> None:
    if ticket.id == other.id:
        raise ValidationError("Choose a different ticket.", error_code="SAME_TICKET")
    exists = db.execute(select(TicketLink).where(
        or_((TicketLink.ticket_id == ticket.id) & (TicketLink.other_id == other.id),
            (TicketLink.ticket_id == other.id) & (TicketLink.other_id == ticket.id))
    )).first()
    if exists:
        return
    db.add(TicketLink(ticket_id=ticket.id, other_id=other.id, kind="related", created_by=actor.name,
                      created_at=datetime.utcnow()))
    _event(ticket, "linked", actor, to_value=other.number)
    _event(other, "linked", actor, to_value=ticket.number)
    db.commit()


def unlink(db: Session, ticket: SupportTicket, other_id: str, actor: Actor) -> None:
    rows = db.execute(select(TicketLink).where(
        TicketLink.kind == "related",
        or_((TicketLink.ticket_id == ticket.id) & (TicketLink.other_id == other_id),
            (TicketLink.ticket_id == other_id) & (TicketLink.other_id == ticket.id)),
    )).scalars().all()
    for row in rows:
        db.delete(row)
    other = db.get(SupportTicket, other_id)
    _event(ticket, "unlinked", actor, to_value=other.number if other else other_id)
    db.commit()


# ------------------------------------------------------------------------ SLA


def sla_state(ticket: SupportTicket, db: Optional[Session] = None, now: Optional[datetime] = None) -> dict:
    """On track, due soon, breached, met or paused — with the time left, for display."""
    now = now or datetime.utcnow()
    due = ticket.resolve_due_at
    if due is None:
        return {"state": "none", "dueAt": None, "minutesLeft": None}
    if ticket.status in ("resolved", "closed"):
        finished = ticket.resolved_at or ticket.closed_at or now
        return {"state": "met" if finished <= due and not ticket.sla_breached else "breached",
                "dueAt": due, "minutesLeft": None}
    minutes = int((due - now).total_seconds() // 60)
    if ticket.status in PAUSED:
        return {"state": "paused", "dueAt": due, "minutesLeft": minutes}
    if ticket.sla_breached or minutes < 0:
        return {"state": "breached", "dueAt": due, "minutesLeft": minutes}
    percent = 80
    if db is not None:
        percent = int(config.settings(db).get("slaWarningPercent") or 80)
    window = max(1, int((due - ticket.created_at).total_seconds() // 60))
    used = window - minutes
    return {"state": "due-soon" if used >= window * percent / 100 else "on-track", "dueAt": due,
            "minutesLeft": minutes}


# --------------------------------------------------------------------- views


def _team_name(db: Session, team_id: Optional[int]) -> str:
    team = db.get(SupportTeam, team_id) if team_id else None
    return team.name if team else ""


def _agent_card(db: Session, agent_id: Optional[int], *, with_email: bool) -> Optional[dict]:
    agent = db.get(SupportAgent, agent_id) if agent_id else None
    if agent is None:
        return None
    role = db.get(SupportRole, agent.role_id) if agent.role_id else None
    card = {"id": agent.id, "name": agent.name, "role": role.name if role else "", "photoUrl": agent.photo_url}
    if with_email:
        card["email"] = agent.email
    return card


def row(db: Session, ticket: SupportTicket, *, audience: str) -> dict:
    """A ticket as a line in a list."""
    agent = _agent_card(db, ticket.agent_id, with_email=False)
    data = {
        "id": ticket.id,
        "number": ticket.number,
        "subject": ticket.subject,
        "category": ticket.category_label,
        "subcategory": ticket.subcategory_label,
        "issue": ticket.issue_label,
        "contactType": ticket.contact_type,
        "channel": ticket.channel,
        "priority": ticket.priority,
        "status": ticket.status,
        "statusLabel": status_label(ticket.status, audience),
        "featureStage": ticket.feature_stage,
        "team": _team_name(db, ticket.team_id),
        "agent": agent["name"] if agent else "",
        "createdAt": ticket.created_at,
        "updatedAt": ticket.updated_at,
        "lastMessageAt": ticket.last_message_at,
        "lastMessage": ticket.last_message_preview,
        "unread": ticket.customer_unread if audience == "customer" else ticket.agent_unread,
        "sla": sla_state(ticket, db),
        "orderNumber": (db.get(Order, ticket.order_id).order_number if ticket.order_id and db.get(Order, ticket.order_id) else
                        (ticket.details or {}).get("orderNumber", "")),
    }
    if audience == "staff":
        data.update({"customerName": ticket.name, "customerEmail": ticket.email, "customerId": ticket.customer_id,
                     "escalationLevel": ticket.escalation_level, "teamId": ticket.team_id, "agentId": ticket.agent_id,
                     "mergedInto": ticket.merged_into_id})
    return data


def _order_summary(db: Session, order_id: Optional[str]) -> Optional[dict]:
    order = db.get(Order, order_id) if order_id else None
    if order is None:
        return None
    return {
        "id": order.id, "number": order.order_number, "placedAt": order.placed_at, "status": order.status,
        "paymentStatus": order.payment_status, "paymentMethod": order.payment_method, "total": float(order.total),
        "items": [{"name": i.name, "quantity": i.quantity, "image": i.image, "productId": i.product_id,
                   "size": i.size, "color": i.color, "lineTotal": float(i.line_total)} for i in order.items],
    }


def _product_summary(db: Session, product_id: Optional[str]) -> Optional[dict]:
    product = db.get(Product, product_id) if product_id else None
    if product is None:
        return None
    image = product.images[0].url if getattr(product, "images", None) else ""
    return {"id": product.id, "name": product.name, "brand": product.brand, "slug": product.slug,
            "image": image, "price": float(product.price)}


def _details_view(ticket: SupportTicket) -> List[dict]:
    return [{"key": k, "label": DETAIL_LABELS.get(k, k), "value": v} for k, v in (ticket.details or {}).items()]


def _messages(db: Session, ticket: SupportTicket, *, audience: str) -> List[dict]:
    by_message: Dict[Optional[int], List[dict]] = {}
    for attachment in ticket.attachments:
        if audience == "customer" and attachment.internal:
            continue
        by_message.setdefault(attachment.message_id, []).append(files.view(attachment))
    out = []
    for message in ticket.messages:
        if audience == "customer" and message.kind == "note":
            continue
        author = message.author_name
        if audience == "customer" and message.kind == "customer":
            author = "You"
        out.append({
            "id": message.id, "kind": message.kind, "author": author, "body": message.body,
            "createdAt": message.created_at, "readAt": message.read_at,
            "attachments": by_message.get(message.id, []),
        })
    return out


def _typing(at: Optional[datetime]) -> bool:
    return at is not None and datetime.utcnow() - at < timedelta(seconds=8)


def customer_view(db: Session, ticket: SupportTicket) -> dict:
    """Everything the customer may see — no notes, no audit trail, no staff emails."""
    feedback_row = db.get(TicketFeedback, ticket.id)
    merged = db.get(SupportTicket, ticket.merged_into_id) if ticket.merged_into_id else None
    until = _reopen_until(db, ticket)
    now = datetime.utcnow()
    team = db.get(SupportTeam, ticket.team_id) if ticket.team_id else None
    return {
        **row(db, ticket, audience="customer"),
        "description": ticket.description,
        "details": _details_view(ticket),
        "priorityLabel": config.PRIORITY_LABELS.get(ticket.priority, ticket.priority),
        "featureStageLabel": FEATURE_LABELS.get(ticket.feature_stage, ""),
        "teamName": team.name if team else "",
        "agentCard": _agent_card(db, ticket.agent_id, with_email=False),
        "responseDueAt": ticket.response_due_at,
        "firstResponseAt": ticket.first_response_at,
        "resolvedAt": ticket.resolved_at,
        "closedAt": ticket.closed_at,
        "order": _order_summary(db, ticket.order_id),
        "product": _product_summary(db, ticket.product_id),
        "messages": _messages(db, ticket, audience="customer"),
        "agentTyping": _typing(ticket.agent_typing_at),
        "mergedInto": merged.number if merged else None,
        "canReply": ticket.status != "closed" and not merged,
        "canClose": ticket.status != "closed" and not merged,
        "canReopen": ticket.status in ("resolved", "closed") and not merged and until is not None and now <= until,
        "reopenUntil": until,
        "canRate": ticket.status in ("resolved", "closed") and feedback_row is None,
        "feedback": {"rating": feedback_row.rating, "comment": feedback_row.comment} if feedback_row else None,
        "attachmentsEnabled": files.enabled(),
    }


def staff_view(db: Session, ticket: SupportTicket) -> dict:
    customer = db.get(Customer, ticket.customer_id) if ticket.customer_id else None
    membership = db.get(CustomerMembership, ticket.membership_id) if ticket.membership_id else None
    feedback_row = db.get(TicketFeedback, ticket.id)
    links = db.execute(select(TicketLink).where(or_(TicketLink.ticket_id == ticket.id,
                                                    TicketLink.other_id == ticket.id))).scalars().all()
    linked = []
    for link_row in links:
        other_id = link_row.other_id if link_row.ticket_id == ticket.id else link_row.ticket_id
        other = db.get(SupportTicket, other_id)
        if other is None:
            continue
        kind = link_row.kind
        if kind == "merged":
            kind = "merged-into" if link_row.ticket_id == ticket.id else "merged-from"
        linked.append({"id": other.id, "number": other.number, "subject": other.subject, "status": other.status,
                       "statusLabel": STAFF_LABELS.get(other.status, other.status), "kind": kind})
    orders = 0
    if customer is not None:
        orders = db.execute(select(func.count()).select_from(Order).where(Order.customer_id == customer.id)).scalar_one()
    return {
        **row(db, ticket, audience="staff"),
        "description": ticket.description,
        "details": _details_view(ticket),
        "priorityLabel": config.PRIORITY_LABELS.get(ticket.priority, ticket.priority),
        "featureStageLabel": FEATURE_LABELS.get(ticket.feature_stage, ""),
        "agentCard": _agent_card(db, ticket.agent_id, with_email=True),
        "phone": ticket.phone,
        "responseDueAt": ticket.response_due_at,
        "firstResponseAt": ticket.first_response_at,
        "resolvedAt": ticket.resolved_at,
        "closedAt": ticket.closed_at,
        "reopenedCount": ticket.reopened_count,
        "slaBreached": ticket.sla_breached,
        "transitions": [{"value": s, "label": STAFF_LABELS[s]} for s in transitions_for(ticket)],
        "customer": {
            "id": customer.id, "name": customer.full_name, "email": customer.email, "phone": customer.phone,
            "orders": orders, "since": customer.created_at,
        } if customer else {"id": None, "name": ticket.name, "email": ticket.email, "phone": ticket.phone,
                            "orders": 0, "guest": True},
        "order": _order_summary(db, ticket.order_id),
        "product": _product_summary(db, ticket.product_id),
        "membership": {"id": membership.id, "plan": membership.plan_name, "status": membership.status,
                       "startsAt": membership.starts_at, "endsAt": membership.ends_at} if membership else None,
        "messages": _messages(db, ticket, audience="staff"),
        "events": [{"id": e.id, "kind": e.kind, "from": e.from_value, "to": e.to_value, "note": e.note,
                    "actorKind": e.actor_kind, "actor": e.actor_name, "at": e.created_at} for e in ticket.events],
        "links": linked,
        "feedback": {"rating": feedback_row.rating, "comment": feedback_row.comment,
                     "at": feedback_row.created_at} if feedback_row else None,
        "customerTyping": _typing(ticket.customer_typing_at),
        "attachmentsEnabled": files.enabled(),
    }
