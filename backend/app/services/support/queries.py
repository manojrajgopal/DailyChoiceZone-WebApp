"""Finding tickets: the customer's own list and the support desk's filters."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import List, Optional, Tuple

from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session

from app.models import Customer, Order, Product, SupportAgent, SupportTicket
from app.services.lookup.filters import any_id_condition, id_condition
from app.services.search.base import LIKE_ESCAPE, escape_like
from app.services.support import config
from app.services.support import tickets as ticket_service
from app.utils.dates import parse_dt


def customer_tickets(db: Session, customer: Customer, *, group: str = "", query: str = "") -> List[SupportTicket]:
    statement = select(SupportTicket).where(SupportTicket.customer_id == customer.id)
    if group in ticket_service.CUSTOMER_GROUPS:
        statement = statement.where(SupportTicket.status.in_(ticket_service.CUSTOMER_GROUPS[group]))
    # The box takes a request number or an order number (docs/id-lookup.md), matched
    # exactly; it is inside `customer_id == customer.id`, so it never widens the list.
    by_id = any_id_condition(query, ("ticket", None, None), ("order", SupportTicket.order_id, Order.id))
    if by_id is not None:
        statement = statement.where(by_id)
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

    # Records are named by their ID, exactly (docs/id-lookup.md): a support agent's
    # number, a Customer ID, an Order ID, a Product ID. A name or an email keeps nothing.
    agent = (filters.get("agent") or "").strip()
    if agent == "me":
        statement = statement.where(SupportTicket.agent_id == (me.id if me else -1))
    elif agent == "unassigned":
        statement = statement.where(SupportTicket.agent_id.is_(None))
    else:
        by_agent = id_condition("support_agent", agent, column=SupportTicket.agent_id, via=SupportAgent.id)
        if by_agent is not None:
            statement = statement.where(by_agent)
    for key, entity, column, via in (("customer", "customer", SupportTicket.customer_id, Customer.id),
                                     ("order", "order", SupportTicket.order_id, Order.id),
                                     ("product", "product", SupportTicket.product_id, Product.id)):
        condition = id_condition(entity, filters.get(key), column=column, via=via)
        if condition is not None:
            statement = statement.where(condition)
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

    # `q` is a ticket's ID — its number (DCZ-2026-000123) or TKT id — matched exactly.
    by_ticket = id_condition("ticket", filters.get("q"))
    if by_ticket is not None:
        statement = statement.where(by_ticket)
    # `subject` is content, not identity: words in what the customer wrote as the
    # subject. It never matches a name, an email or an agent.
    words = (filters.get("subject") or "").strip()[:120]
    if words:
        statement = statement.where(SupportTicket.subject.ilike(f"%{escape_like(words)}%", escape=LIKE_ESCAPE))

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
