"""
Who hears about a ticket, and what they are told.

Every address used here is read from the database at the moment of sending:
the customer's own, the assigned agent's, the team's agents and the team's
configured inbox, and — only where nobody else would hear — the portal's
super admins. There is no support address in code.

Emails go through the store's email pipeline (`services.email.notify`): queued
on the session and sent after the commit, so a rolled-back change sends
nothing. Two email types gate them: `support_updates` (to customers, which a
customer cannot switch off — it is the reply to their own request) and
`support_team` (to staff, never offered to customers).
"""

from __future__ import annotations

import html as html_lib
import re
import secrets
from datetime import datetime
from typing import Iterable, List, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings as app_settings
from app.models import (
    AdminUser,
    CustomerNotification,
    Notification,
    SupportAgent,
    SupportEmailTemplate,
    SupportTeam,
    SupportTicket,
)
from app.services.support import config

VARIABLES = (
    "customer_name", "ticket_number", "category", "subject", "status", "priority",
    "assigned_agent", "assigned_team", "store_name", "ticket_url", "message",
    "response_due", "resolve_due", "reopen_days", "escalation_reason",
)
_VAR = re.compile(r"\{\{\s*([a-z_]+)\s*\}\}")


def _store_name(db: Session) -> str:
    from app.services import billing

    return (billing.store_settings(db).get("general") or {}).get("storeName") or "Daily Choice Zone"


def _when(db: Session, value: Optional[datetime]) -> str:
    if value is None:
        return "—"
    from datetime import timezone

    local = value.replace(tzinfo=timezone.utc).astimezone(
        config.zone((config.settings(db).get("businessHours") or {}).get("timezone")))
    return local.strftime("%d %b %Y, %I:%M %p").lstrip("0")


def customer_url(ticket: SupportTicket) -> str:
    base = app_settings.STOREFRONT_URL.rstrip("/")
    if ticket.customer_id:
        return f"{base}/account/ticket?number={ticket.number}"
    from app.services.support.tickets import guest_key

    key = guest_key(ticket)
    return f"{base}/support/ticket?number={ticket.number}&key={key}"


def staff_url(ticket: SupportTicket) -> str:
    return f"{app_settings.STOREFRONT_URL.rstrip('/')}/admin/support/ticket?id={ticket.id}"


def variables(db: Session, ticket: SupportTicket, *, audience: str, **extra) -> dict:
    from app.services.support import tickets as ticket_service

    team = db.get(SupportTeam, ticket.team_id) if ticket.team_id else None
    agent = db.get(SupportAgent, ticket.agent_id) if ticket.agent_id else None
    values = {
        "customer_name": ticket.name,
        "ticket_number": ticket.number,
        "category": " › ".join(p for p in (ticket.category_label, ticket.subcategory_label, ticket.issue_label) if p)
        or "Support",
        "subject": ticket.subject,
        "status": ticket_service.status_label(ticket.status, audience),
        "priority": config.PRIORITY_LABELS.get(ticket.priority, ticket.priority),
        "assigned_agent": agent.name if agent else (team.name + " team" if team else "our team"),
        "assigned_team": team.name if team else "support",
        "store_name": _store_name(db),
        "ticket_url": customer_url(ticket) if audience == "customer" else staff_url(ticket),
        "message": "",
        "response_due": _when(db, ticket.response_due_at),
        "resolve_due": _when(db, ticket.resolve_due_at),
        "reopen_days": str(config.settings(db).get("reopenDays", 7)),
        "escalation_reason": "",
    }
    values.update({k: str(v) for k, v in extra.items() if v is not None})
    return values


def render(text: str, values: dict, *, html: bool) -> str:
    def swap(match):
        value = values.get(match.group(1), "")
        return html_lib.escape(value) if html else value

    return _VAR.sub(swap, text or "")


def _template(db: Session, key: str) -> Optional[SupportEmailTemplate]:
    row = db.get(SupportEmailTemplate, key)
    return row if row is not None and row.enabled else None


def _body_html(body: str, values: dict) -> str:
    paragraphs = [p for p in render(body, values, html=True).split("\n\n") if p.strip()]
    return "".join(
        f'<p style="margin:0 0 14px;font-size:14px;line-height:1.6">{p.replace(chr(10), "<br>")}</p>'
        for p in paragraphs
    )


def preview(db: Session, subject: str, body: str) -> dict:
    """A template rendered with sample values, for the editor."""
    from app.services.email import layout

    sample = {name: f"[{name}]" for name in VARIABLES}
    sample.update({
        "customer_name": "Asha Rao", "ticket_number": "DCZ-2026-000123", "category": "Payments › UPI Issue",
        "subject": "Payment deducted but no order", "status": "In progress", "priority": "High",
        "assigned_agent": "Your support agent", "assigned_team": "Payments & Finance",
        "store_name": _store_name(db), "ticket_url": app_settings.STOREFRONT_URL,
        "message": "Could you share the transaction reference from your UPI app?",
    })
    rendered_subject = render(subject, sample, html=False)
    return {
        "subject": rendered_subject,
        "html": layout(rendered_subject, _body_html(body, sample), cta=("View request", sample["ticket_url"])),
    }


def _send(db: Session, key: str, ticket: SupportTicket, to: str, values: dict, *, internal: bool) -> None:
    from app.services import email as email_service

    template = _template(db, key)
    if template is None or not to:
        return
    subject = render(template.subject, values, html=False)[:200]
    html = email_service.layout(
        subject, _body_html(template.body, values),
        cta=("Open the request" if internal else "View your request", values["ticket_url"]),
    )
    email_service.notify(
        db, "support_team" if internal else "support_updates", to=to,
        customer_id=None if internal else ticket.customer_id,
        subject=subject, html=html, text=render(template.body, values, html=False),
        reference=ticket.number,
    )


# ---------------------------------------------------------------- customers


def customer(db: Session, ticket: SupportTicket, key: str, *, title: str, message: str = "", **extra) -> None:
    """Tell the customer — by email, and in their account if they have one."""
    values = variables(db, ticket, audience="customer", message=message, **extra)
    _send(db, key, ticket, ticket.email, values, internal=False)
    if ticket.customer_id:
        db.add(CustomerNotification(
            customer_id=ticket.customer_id, kind=key, title=title[:200],
            body=(message or ticket.subject)[:500],
            href=f"/account/ticket?number={ticket.number}", read=False, created_at=datetime.utcnow(),
        ))


# -------------------------------------------------------------------- staff


def team_agents(db: Session, team_id: Optional[int]) -> List[SupportAgent]:
    if not team_id:
        return []
    return list(db.execute(
        select(SupportAgent).where(SupportAgent.team_id == team_id, SupportAgent.active.is_(True))
    ).scalars().all())


def _admins(db: Session, roles: Iterable[str]) -> List[AdminUser]:
    return list(db.execute(
        select(AdminUser).where(AdminUser.role.in_(list(roles)), AdminUser.status == "active")
    ).scalars().all())


def _tray(db: Session, ticket: SupportTicket, title: str, body: str, admin_id: Optional[str]) -> None:
    db.add(Notification(
        id=f"NTF-{secrets.token_hex(8)}", kind="support", title=title[:255], body=body[:500],
        href=f"/admin/support/ticket?id={ticket.id}", read=False, created_at=datetime.utcnow(),
        admin_id=admin_id,
    ))


def staff(
    db: Session,
    ticket: SupportTicket,
    key: str,
    *,
    title: str,
    audience: str = "handlers",
    message: str = "",
    exclude_admin_id: Optional[str] = None,
    **extra,
) -> None:
    """
    Tell the people handling a ticket.

    `audience`:
    - handlers — the assigned agent; if nobody is assigned, the team's agents
      and the team inbox; if the team has nobody, the super admins.
    - team — the team's agents and inbox, even when someone is assigned.
    - team-lead — the team's leads (else the super admins).
    - admins / super-admins — the portal's administrators.
    """
    values = variables(db, ticket, audience="staff", message=message, **extra)
    emails: dict = {}
    tray: dict = {}

    def add_agent(agent: SupportAgent) -> None:
        if not agent.active:
            return
        if agent.notify_email and agent.email:
            emails[agent.email.lower()] = agent.email
        if agent.notify_portal and agent.admin_user_id:
            tray[agent.admin_user_id] = True

    def add_admins(roles) -> None:
        for admin in _admins(db, roles):
            emails.setdefault(admin.email.lower(), admin.email)
            tray[admin.id] = True

    team = db.get(SupportTeam, ticket.team_id) if ticket.team_id else None
    agent = db.get(SupportAgent, ticket.agent_id) if ticket.agent_id else None

    if audience in ("handlers", "team"):
        if agent is not None and audience == "handlers":
            add_agent(agent)
        else:
            for member in team_agents(db, ticket.team_id):
                add_agent(member)
            if team is not None and team.notify_email:
                emails.setdefault(team.notify_email.lower(), team.notify_email)
        if not emails and not tray:
            add_admins(["super-admin"])
    elif audience == "team-lead":
        for member in team_agents(db, ticket.team_id):
            if member.is_lead:
                add_agent(member)
        if not emails and not tray:
            add_admins(["super-admin"])
    elif audience == "admins":
        add_admins(["super-admin", "admin"])
    elif audience == "super-admins":
        add_admins(["super-admin"])

    if exclude_admin_id:
        tray.pop(exclude_admin_id, None)
        mine = db.get(AdminUser, exclude_admin_id)
        if mine is not None:
            emails.pop(mine.email.lower(), None)

    for address in emails.values():
        _send(db, key, ticket, address, values, internal=True)
    for admin_id in tray:
        _tray(db, ticket, title, message or ticket.subject, admin_id)
