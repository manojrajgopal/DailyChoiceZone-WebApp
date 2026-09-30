"""Finding tickets: the customer's own list and the support desk's filters."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import List, Optional, Tuple

from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session

from app.models import Customer, Order, SupportAgent, SupportTicket
from app.services.support import config
from app.services.support import tickets as ticket_service
from app.utils.dates import parse_dt


def customer_tickets(db: Session, customer: Customer, *, group: str = "", query: str = "") -> List[SupportTicket]:
    statement = select(SupportTicket).where(SupportTicket.customer_id == customer.id)
    if group in ticket_service.CUSTOMER_GROUPS:
        statement = statement.where(SupportTicket.status.in_(ticket_service.CUSTOMER_GROUPS[group]))
    text = (query or "").strip()
    if text:
        like = f"%{text}%"
        statement = statement.outerjoin(Order, Order.id == SupportTicket.order_id).where(or_(
            SupportTicket.number.ilike(like), SupportTicket.subject.ilike(like), Order.order_number.ilike(like),
        ))
    return list(db.execute(statement.order_by(SupportTicket.updated_at.desc()).limit(200)).scalars().all())


PRIORITY_ORDER = case(
    {"urgent": 0, "high": 1, "medium": 2, "low": 3}, value=SupportTicket.priority, else_=4
)


def staff_tickets(
    db: Session,
    filters: dict,
    *,
    me: Optional[SupportAgent],
    scope_team_ids: Optional[List[int]] = None,
    scope_agent_id: Optional[int] = None,
    page: int = 1,
    page_size: int = 25,
) -> Tuple[List[SupportTicket], int]:
    """
    Every filter the desk offers, applied in the database.

    `scope_*` narrows to what an agent without the `support` permission may
    see; it is applied first and no filter can widen it.
    """
    statement = select(SupportTicket)
    if scope_team_ids is not None or scope_agent_id is not None:
        conditions = []
        if scope_team_ids:
            conditions.append(SupportTicket.team_id.in_(scope_team_ids))
        if scope_agent_id is not None:
            conditions.append(SupportTicket.agent_id == scope_agent_id)
        statement = statement.where(or_(*conditions)) if conditions else statement.where(False)

    statuses = [s for s in (filters.get("status") or "").split(",") if s in ticket_service.STATUSES]
    view = filters.get("view") or ""
    if statuses:
        statement = statement.where(SupportTicket.status.in_(statuses))
    elif view == "open":
        statement = statement.where(SupportTicket.status.in_(ticket_service.OPEN))
    elif view == "waiting":
        statement = statement.where(SupportTicket.status == "waiting-customer")
    elif view == "done":
        statement = statement.where(SupportTicket.status.in_(("resolved", "closed")))
    if filters.get("hideMerged", "1") == "1":
        statement = statement.where(SupportTicket.merged_into_id.is_(None))

    for key, column in (("category", SupportTicket.category_id), ("subcategory", SupportTicket.subcategory_id),
                        ("issue", SupportTicket.issue_id), ("team", SupportTicket.team_id)):
        value = filters.get(key)
        if value and str(value).isdigit():
            statement = statement.where(column == int(value))
    for key, column in (("priority", SupportTicket.priority), ("contactType", SupportTicket.contact_type),
                        ("channel", SupportTicket.channel), ("featureStage", SupportTicket.feature_stage)):
        values = [v for v in (filters.get(key) or "").split(",") if v]
        if values:
            statement = statement.where(column.in_(values))

    agent = filters.get("agent") or ""
    if agent == "me":
        statement = statement.where(SupportTicket.agent_id == (me.id if me else -1))
    elif agent == "unassigned":
        statement = statement.where(SupportTicket.agent_id.is_(None))
    elif agent.isdigit():
        statement = statement.where(SupportTicket.agent_id == int(agent))

    if filters.get("customer"):
        statement = statement.where(SupportTicket.customer_id == filters["customer"])
    if filters.get("order"):
        order_text = str(filters["order"]).strip()
        statement = statement.outerjoin(Order, Order.id == SupportTicket.order_id).where(
            or_(SupportTicket.order_id == order_text, Order.order_number == order_text))
    if filters.get("product"):
        statement = statement.where(SupportTicket.product_id == filters["product"])
    if filters.get("membership") == "1":
        statement = statement.where(SupportTicket.membership_id.is_not(None))

    for key, op in (("from", "ge"), ("to", "le")):
        value = parse_dt(filters.get(key)) if filters.get(key) else None
        if value is not None:
            statement = statement.where(SupportTicket.created_at >= value if op == "ge" else SupportTicket.created_at <= value)

    now = datetime.utcnow()
    sla = filters.get("sla") or ""
    if sla == "breached":
        statement = statement.where(SupportTicket.status.in_(ticket_service.OPEN),
                                    or_(SupportTicket.sla_breached.is_(True), SupportTicket.resolve_due_at < now))
    elif sla == "due-soon":
        statement = statement.where(SupportTicket.status.in_(ticket_service.OPEN), SupportTicket.sla_breached.is_(False),
                                    SupportTicket.resolve_due_at >= now,
                                    SupportTicket.resolve_due_at <= now + timedelta(hours=2))
    elif sla == "on-track":
        statement = statement.where(SupportTicket.status.in_(ticket_service.OPEN), SupportTicket.sla_breached.is_(False),
                                    SupportTicket.resolve_due_at > now + timedelta(hours=2))

    text = (filters.get("q") or "").strip()
    if text:
        like = f"%{text}%"
        agent_ids = select(SupportAgent.id).where(SupportAgent.name.ilike(like))
        statement = statement.where(or_(
            SupportTicket.number.ilike(like), SupportTicket.subject.ilike(like), SupportTicket.email.ilike(like),
            SupportTicket.name.ilike(like), SupportTicket.order_id == text, SupportTicket.product_id == text,
            SupportTicket.agent_id.in_(agent_ids),
            SupportTicket.order_id.in_(select(Order.id).where(Order.order_number.ilike(like))),
        ))

    total = db.execute(select(func.count()).select_from(statement.order_by(None).subquery())).scalar_one()

    sort = filters.get("sort") or "updated"
    order = {
        "created": SupportTicket.created_at.desc(),
        "oldest": SupportTicket.created_at.asc(),
        "priority": PRIORITY_ORDER,
        "due": SupportTicket.resolve_due_at.asc(),
    }.get(sort, SupportTicket.updated_at.desc())
    rows = db.execute(
        statement.order_by(order, SupportTicket.created_at.desc())
        .offset((max(1, page) - 1) * page_size).limit(page_size)
    ).scalars().all()
    return list(rows), total


def lookups(db: Session) -> dict:
    """What the desk's filter bar and assignment menus offer."""
    from app.models import CannedResponse, SupportTeam

    teams = db.execute(select(SupportTeam).order_by(SupportTeam.sort_order, SupportTeam.name)).scalars().all()
    agents = db.execute(select(SupportAgent).order_by(SupportAgent.name)).scalars().all()
    canned = db.execute(select(CannedResponse).where(CannedResponse.active.is_(True))
                        .order_by(CannedResponse.title)).scalars().all()
    return {
        "teams": [{"id": t.id, "name": t.name, "active": t.active} for t in teams],
        "agents": [{"id": a.id, "name": a.name, "teamId": a.team_id, "active": a.active, "available": a.available}
                   for a in agents],
        "categories": config.tree(db, active_only=False),
        "statuses": [{"value": s, "label": ticket_service.STAFF_LABELS[s]} for s in ticket_service.STATUSES],
        "priorities": [{"value": p, "label": config.PRIORITY_LABELS[p]} for p in config.PRIORITIES],
        "featureStages": [{"value": s, "label": ticket_service.FEATURE_LABELS[s]} for s in ticket_service.FEATURE_STAGES],
        "contactTypes": list(config.CONTACT_TYPES),
        "canned": [{"id": c.id, "title": c.title, "body": c.body, "categoryId": c.category_id} for c in canned],
    }
