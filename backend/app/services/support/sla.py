"""
Watching the clock on open tickets: SLA warnings and breaches, the store's
escalation rules, and closing resolved tickets nobody came back to.

Runs every minute from the app's lifespan. Each ticket is its own
transaction, so one that fails is logged and retried next pass without
undoing the rest. Every rule fires once per ticket (`sla_warned`,
`sla_breached`, `escalations_applied`) — a restart never re-sends anything.

The clock is paused while a ticket waits for the customer: a reply we are
waiting on is not a target the team can miss.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import SupportTicket
from app.services.support import config, notify
from app.services.support import tickets as ticket_service

logger = logging.getLogger(__name__)

BATCH = 200
INTERVAL_SECONDS = 60


def _rule_applies(ticket: SupportTicket, rule: dict, now: datetime) -> bool:
    if rule.get("priorities") and ticket.priority not in rule["priorities"]:
        return False
    after = timedelta(minutes=int(rule.get("afterMinutes") or 0))
    when = rule.get("when")
    if when == "no-response":
        return ticket.first_response_at is None and now >= ticket.created_at + after
    if when == "sla-breached":
        return bool(ticket.sla_breached and ticket.resolve_due_at and now >= ticket.resolve_due_at + after)
    if when == "unresolved":
        return now >= ticket.created_at + after
    return False


def check(db: Session, ticket: SupportTicket, now: datetime, conf: dict) -> bool:
    """Apply every due rule to one ticket. Returns whether anything changed."""
    changed = False
    due = ticket.resolve_due_at
    if due is not None and ticket.status not in ticket_service.PAUSED:
        window = max(60.0, (due - ticket.created_at).total_seconds())
        used = (now - ticket.created_at).total_seconds()
        if not ticket.sla_warned and now < due and used >= window * int(conf.get("slaWarningPercent") or 80) / 100:
            ticket.sla_warned = True
            ticket_service._event(ticket, "sla-warning", ticket_service.SYSTEM, to_value=due.isoformat())
            notify.staff(db, ticket, "sla_warning", title=f"{ticket.number} is due soon")
            changed = True
        if not ticket.sla_breached and now >= due:
            ticket.sla_breached = True
            ticket.sla_warned = True
            ticket_service._event(ticket, "sla-breached", ticket_service.SYSTEM, to_value=due.isoformat())
            notify.staff(db, ticket, "sla_breached", title=f"{ticket.number} missed its target")
            changed = True

    applied = list(ticket.escalations_applied or [])
    for rule in conf.get("escalation") or []:
        if rule.get("id") in applied or ticket.status in ticket_service.PAUSED:
            continue
        if _rule_applies(ticket, rule, now):
            applied.append(rule["id"])
            ticket.escalations_applied = applied
            ticket_service.escalate(db, ticket, ticket_service.SYSTEM, rule.get("label") or "Escalation rule",
                                    rule_notify=rule.get("notify"))
            changed = True
    return changed


def sweep(db: Session, now: Optional[datetime] = None) -> int:
    """One pass over the open tickets. Returns how many changed."""
    now = now or datetime.utcnow()
    conf = config.settings(db)
    changed = 0

    # Every open ticket, a page at a time by id. Taking only the first page by
    # due date would let tickets already breached (and still open) fill it
    # for good, and the newer ones behind them would never be checked.
    after = ""
    while True:
        ids = db.execute(
            select(SupportTicket.id)
            .where(SupportTicket.status.in_(ticket_service.OPEN), SupportTicket.merged_into_id.is_(None),
                   SupportTicket.id > after)
            .order_by(SupportTicket.id)
            .limit(BATCH)
        ).scalars().all()
        if not ids:
            break
        after = ids[-1]
        for ticket_id in ids:
            try:
                ticket = db.get(SupportTicket, ticket_id)
                if ticket is not None and check(db, ticket, now, conf):
                    db.commit()
                    changed += 1
            except Exception:  # noqa: BLE001 — one ticket must not stop the rest
                db.rollback()
                logger.exception("SLA check failed for %s", ticket_id)

    days = int(conf.get("autoCloseResolvedDays") or 0)
    if days > 0:
        stale = db.execute(
            select(SupportTicket.id).where(
                SupportTicket.status == "resolved",
                SupportTicket.resolved_at <= now - timedelta(days=days),
            ).limit(BATCH)
        ).scalars().all()
        for ticket_id in stale:
            try:
                ticket = db.get(SupportTicket, ticket_id)
                ticket_service.set_status(db, ticket, "closed", ticket_service.SYSTEM,
                                          note=f"Closed automatically {days} days after it was resolved.")
                db.commit()
                changed += 1
            except Exception:  # noqa: BLE001
                db.rollback()
                logger.exception("Auto-close failed for %s", ticket_id)
    return changed


def _sweep_once() -> None:
    from app.core.database import SessionLocal

    with SessionLocal() as db:
        sweep(db)


async def run_forever() -> None:
    logger.info("Support SLA sweeper running every %ss.", INTERVAL_SECONDS)
    while True:
        try:
            from app.services import jobs

            await asyncio.to_thread(jobs.tracked("support_sla", INTERVAL_SECONDS, _sweep_once))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Support SLA sweep failed; retrying next interval.")
        await asyncio.sleep(INTERVAL_SECONDS)
