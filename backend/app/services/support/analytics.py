"""The support dashboard's numbers."""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta
from typing import List, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import SupportAgent, SupportTeam, SupportTicket, TicketFeedback
from app.services.support import tickets as ticket_service


def _minutes(a: datetime, b: datetime) -> float:
    return max(0.0, (b - a).total_seconds() / 60)


def _avg(values: List[float]) -> Optional[float]:
    return round(sum(values) / len(values), 1) if values else None


def dashboard(db: Session, *, days: int = 30, team_ids: Optional[List[int]] = None,
              agent_id: Optional[int] = None) -> dict:
    """
    Counts across every ticket (what is open now), and trends across the
    last `days` (what arrived, how fast it was answered and resolved).

    `team_ids`/`agent_id` narrow it to what an agent without the `support`
    permission may see.
    """
    now = datetime.utcnow()
    since = now - timedelta(days=days)

    def scoped(statement):
        if team_ids is not None or agent_id is not None:
            from sqlalchemy import or_

            conditions = []
            if team_ids:
                conditions.append(SupportTicket.team_id.in_(team_ids))
            if agent_id is not None:
                conditions.append(SupportTicket.agent_id == agent_id)
            statement = statement.where(or_(*conditions)) if conditions else statement.where(False)
        return statement

    by_status = dict(db.execute(
        scoped(select(SupportTicket.status, func.count()).where(SupportTicket.merged_into_id.is_(None))
               .group_by(SupportTicket.status))
    ).all())
    open_statuses = ticket_service.OPEN
    urgent_open = db.execute(scoped(
        select(func.count()).select_from(SupportTicket).where(
            SupportTicket.status.in_(open_statuses), SupportTicket.priority == "urgent",
            SupportTicket.merged_into_id.is_(None))
    )).scalar_one()
    breached_open = db.execute(scoped(
        select(func.count()).select_from(SupportTicket).where(
            SupportTicket.status.in_(open_statuses), SupportTicket.sla_breached.is_(True),
            SupportTicket.merged_into_id.is_(None))
    )).scalar_one()

    recent = db.execute(scoped(
        select(SupportTicket).where(SupportTicket.created_at >= since, SupportTicket.merged_into_id.is_(None))
    )).scalars().all()

    teams = {t.id: t.name for t in db.execute(select(SupportTeam)).scalars()}
    agents = {a.id: a.name for a in db.execute(select(SupportAgent)).scalars()}

    first_response = [_minutes(t.created_at, t.first_response_at) for t in recent if t.first_response_at]
    resolution = [_minutes(t.created_at, t.resolved_at) for t in recent if t.resolved_at]
    finished = [t for t in recent if t.resolved_at is not None and t.resolve_due_at is not None]
    on_time = [t for t in finished if t.resolved_at <= t.resolve_due_at and not t.sla_breached]

    series = defaultdict(lambda: {"created": 0, "resolved": 0})
    for t in recent:
        series[t.created_at.strftime("%Y-%m-%d")]["created"] += 1
        if t.resolved_at and t.resolved_at >= since:
            series[t.resolved_at.strftime("%Y-%m-%d")]["resolved"] += 1
    over_time = []
    for offset in range(days, -1, -1):
        day = (now - timedelta(days=offset)).strftime("%Y-%m-%d")
        over_time.append({"date": day, **series[day]})

    feedback = db.execute(
        select(TicketFeedback).where(TicketFeedback.created_at >= since)
    ).scalars().all()
    if team_ids is not None or agent_id is not None:
        visible = {t.id for t in recent}
        feedback = [f for f in feedback if f.ticket_id in visible]
    ratings = [f.rating for f in feedback]

    by_agent = defaultdict(lambda: {"total": 0, "open": 0, "resolved": 0, "ratings": []})
    for t in recent:
        key = agents.get(t.agent_id, "Unassigned")
        by_agent[key]["total"] += 1
        by_agent[key]["open"] += t.status in open_statuses
        by_agent[key]["resolved"] += t.status in ("resolved", "closed")
    rating_by_ticket = {f.ticket_id: f.rating for f in feedback}
    for t in recent:
        if t.id in rating_by_ticket:
            by_agent[agents.get(t.agent_id, "Unassigned")]["ratings"].append(rating_by_ticket[t.id])

    def counted(values) -> List[dict]:
        return [{"label": k or "—", "value": v} for k, v in Counter(values).most_common()]

    return {
        "days": days,
        "totals": {
            "total": sum(by_status.values()),
            "open": sum(by_status.get(s, 0) for s in ("submitted", "triaged", "assigned", "acknowledged",
                                                       "reopened", "escalated")),
            "inProgress": by_status.get("in-progress", 0) + by_status.get("waiting-internal", 0),
            "waitingCustomer": by_status.get("waiting-customer", 0),
            "urgent": urgent_open,
            "resolved": by_status.get("resolved", 0),
            "closed": by_status.get("closed", 0),
            "slaBreached": breached_open,
            "createdInRange": len(recent),
        },
        "byStatus": [{"label": ticket_service.STAFF_LABELS.get(s, s), "status": s, "value": by_status.get(s, 0)}
                     for s in ticket_service.STATUSES if by_status.get(s)],
        "byCategory": counted(t.category_label for t in recent),
        "byPriority": [{"label": p.title(), "value": sum(1 for t in recent if t.priority == p)}
                       for p in ("urgent", "high", "medium", "low")],
        "byTeam": counted(teams.get(t.team_id, "Unrouted") for t in recent),
        "byAgent": sorted(
            [{"label": k, "total": v["total"], "open": v["open"], "resolved": v["resolved"],
              "rating": _avg(v["ratings"])} for k, v in by_agent.items()],
            key=lambda r: -r["total"],
        ),
        "byChannel": counted(t.channel for t in recent),
        "overTime": over_time,
        "avgFirstResponseMinutes": _avg(first_response),
        "avgResolutionMinutes": _avg(resolution),
        "slaCompliance": round(100 * len(on_time) / len(finished), 1) if finished else None,
        "satisfaction": {
            "average": _avg([float(r) for r in ratings]),
            "count": len(ratings),
            "positivePercent": round(100 * sum(1 for r in ratings if r >= 4) / len(ratings), 1) if ratings else None,
            "distribution": [{"label": f"{n}★", "value": ratings.count(n)} for n in range(5, 0, -1)],
            "recent": [{"ticketId": f.ticket_id, "rating": f.rating, "comment": f.comment, "at": f.created_at}
                       for f in sorted(feedback, key=lambda f: f.created_at, reverse=True)[:5] if f.comment],
        },
    }
