"""
The support desk (working tickets) and its configuration (who handles what).

- Working tickets: the `support` permission, or being an active agent linked
  to this portal account — in which case only your team's tickets and your
  own are reachable (see `tickets.can_work`).
- Configuring: the super admin, or the `support-config` permission.
"""

from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.routes.support import _read
from app.core.database import get_db
from app.core.errors import AuthorizationError, NotFoundError, ValidationError
from app.core.permissions import permissions_for
from app.dependencies.auth import get_current_admin
from app.models import (
    AdminUser,
    CannedResponse,
    SupportAgent,
    SupportArticle,
    SupportDepartment,
    SupportEmailTemplate,
    SupportRole,
    SupportTeam,
    SupportTicket,
    TicketAttachment,
)
from app.schemas.base import CamelModel
from app.services.support import admin_config, analytics, config, notify, queries
from app.services.support import attachments as files
from app.services.support import tickets as service
from app.utils.response import Pagination, ok, ok_list

router = APIRouter(prefix="/admin/support", tags=["Admin · Support"])


def can_configure(admin: AdminUser) -> bool:
    return admin.role == "super-admin" or "support-config" in (admin.permissions or []) \
        or "support-config" in permissions_for(admin.role)


def configurer(admin: AdminUser = Depends(get_current_admin)) -> AdminUser:
    if not can_configure(admin):
        raise AuthorizationError("Only a super admin can configure support.", error_code="PERMISSION_DENIED")
    return admin


def _scope(db: Session, admin: AdminUser):
    """(team ids, agent id) this admin is limited to, or (None, None) for everything."""
    agent = service.can_work(db, admin)
    if service.sees_everything(admin):
        return agent, None, None
    return agent, ([agent.team_id] if agent.team_id else []), agent.id


def _ticket(db: Session, admin: AdminUser, ticket_id: str) -> SupportTicket:
    ticket = db.get(SupportTicket, ticket_id)
    if ticket is None:
        raise NotFoundError("We couldn't find that ticket.", error_code="TICKET_NOT_FOUND")
    service.can_work(db, admin, ticket)
    return ticket


def _find(db: Session, admin: AdminUser, reference: str) -> SupportTicket:
    """A ticket by id or number, within what this admin may reach."""
    ticket = db.get(SupportTicket, reference) or db.execute(
        select(SupportTicket).where(SupportTicket.number == (reference or "").strip())).scalar_one_or_none()
    if ticket is None:
        raise NotFoundError(f"No ticket {reference}.", error_code="TICKET_NOT_FOUND")
    service.can_work(db, admin, ticket)
    return ticket


# ------------------------------------------------------------------- the desk


@router.get("/me", summary="What this administrator can do in support")
def me(db: Session = Depends(get_db), admin: AdminUser = Depends(get_current_admin)):
    agent = service.agent_for(db, admin)
    works = service.sees_everything(admin) or (agent is not None and agent.active)
    return ok({
        "canWork": works,
        "seesEverything": service.sees_everything(admin),
        "canConfigure": can_configure(admin),
        "agent": admin_config.agent_view(db, agent) if agent else None,
    })


@router.get("/dashboard", summary="Support analytics")
def dashboard(days: int = Query(30, ge=1, le=365), db: Session = Depends(get_db),
              admin: AdminUser = Depends(get_current_admin)):
    _, team_ids, agent_id = _scope(db, admin)
    return ok(analytics.dashboard(db, days=days, team_ids=team_ids, agent_id=agent_id))


@router.get("/lookups", summary="Teams, agents, categories and replies for the desk")
def lookups(db: Session = Depends(get_db), admin: AdminUser = Depends(get_current_admin)):
    service.can_work(db, admin)
    return ok(queries.lookups(db))


@router.get("/tickets", summary="Search and filter tickets")
def list_tickets(
    status: str = "", view: str = "", category: str = "", subcategory: str = "", issue: str = "",
    priority: str = "", team: str = "", agent: str = "", contactType: str = "", channel: str = "",
    featureStage: str = "", customer: str = "", order: str = "", product: str = "", membership: str = "",
    sla: str = "", q: str = Query("", max_length=120), sort: str = "updated",
    date_from: str = Query("", alias="from"), date_to: str = Query("", alias="to"), hideMerged: str = "1",
    page: int = Query(1, ge=1), pageSize: int = Query(25, ge=1, le=100),
    db: Session = Depends(get_db), admin: AdminUser = Depends(get_current_admin),
):
    me_agent, team_ids, agent_id = _scope(db, admin)
    filters = {
        "status": status, "view": view, "category": category, "subcategory": subcategory, "issue": issue,
        "priority": priority, "team": team, "agent": agent, "contactType": contactType, "channel": channel,
        "featureStage": featureStage, "customer": customer, "order": order, "product": product,
        "membership": membership, "sla": sla, "q": q, "sort": sort, "from": date_from, "to": date_to,
        "hideMerged": hideMerged,
    }
    rows, total = queries.staff_tickets(db, filters, me=me_agent, scope_team_ids=team_ids, scope_agent_id=agent_id,
                                        page=page, page_size=pageSize)
    return ok_list([service.row(db, t, audience="staff") for t in rows],
                   pagination=Pagination.build(page, pageSize, total))


@router.get("/tickets/{ticket_id}", summary="One ticket, everything about it")
def get_ticket(ticket_id: str, db: Session = Depends(get_db), admin: AdminUser = Depends(get_current_admin)):
    return ok(service.staff_view(db, _ticket(db, admin, ticket_id)))


@router.post("/tickets/{ticket_id}/messages", status_code=201, summary="Reply, or add an internal note")
async def post_message(
    ticket_id: str,
    body: str = Form(""),
    internal: bool = Form(False),
    status: str = Form(""),
    files_in: Optional[List[UploadFile]] = File(None, alias="files"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    ticket = _ticket(db, admin, ticket_id)
    uploads = await _read(files_in, db)
    service.staff_message(db, ticket, service.staff_actor(db, admin), body, uploads, internal=internal,
                          status=status or None)
    db.refresh(ticket)
    return ok(service.staff_view(db, ticket))


class StatusChange(CamelModel):
    status: str
    note: str = ""


@router.put("/tickets/{ticket_id}/status", summary="Change status")
def change_status(ticket_id: str, payload: StatusChange, db: Session = Depends(get_db),
                  admin: AdminUser = Depends(get_current_admin)):
    ticket = _ticket(db, admin, ticket_id)
    service.set_status(db, ticket, payload.status, service.staff_actor(db, admin), note=payload.note.strip()[:500])
    db.commit()
    return ok(service.staff_view(db, ticket))


class Assignment(CamelModel):
    team_id: Optional[int] = None
    agent_id: Optional[int] = None


@router.put("/tickets/{ticket_id}/assignment", summary="Assign or reassign")
def change_assignment(ticket_id: str, payload: Assignment, db: Session = Depends(get_db),
                      admin: AdminUser = Depends(get_current_admin)):
    ticket = _ticket(db, admin, ticket_id)
    service.assign(db, ticket, team_id=payload.team_id, agent_id=payload.agent_id,
                   actor=service.staff_actor(db, admin))
    db.commit()
    return ok(service.staff_view(db, ticket))


class PriorityChange(CamelModel):
    priority: str


@router.put("/tickets/{ticket_id}/priority", summary="Change priority")
def change_priority(ticket_id: str, payload: PriorityChange, db: Session = Depends(get_db),
                    admin: AdminUser = Depends(get_current_admin)):
    ticket = _ticket(db, admin, ticket_id)
    service.set_priority(db, ticket, payload.priority, service.staff_actor(db, admin))
    db.commit()
    return ok(service.staff_view(db, ticket))


class StageChange(CamelModel):
    stage: str


@router.put("/tickets/{ticket_id}/stage", summary="Move a feature request along")
def change_stage(ticket_id: str, payload: StageChange, db: Session = Depends(get_db),
                 admin: AdminUser = Depends(get_current_admin)):
    ticket = _ticket(db, admin, ticket_id)
    service.set_feature_stage(db, ticket, payload.stage, service.staff_actor(db, admin))
    db.commit()
    return ok(service.staff_view(db, ticket))


class Escalation(CamelModel):
    reason: str


@router.post("/tickets/{ticket_id}/escalate", summary="Escalate")
def escalate(ticket_id: str, payload: Escalation, db: Session = Depends(get_db),
             admin: AdminUser = Depends(get_current_admin)):
    ticket = _ticket(db, admin, ticket_id)
    reason = payload.reason.strip()
    if len(reason) < 3:
        raise ValidationError("Say why it's being escalated.", error_code="REASON_REQUIRED")
    service.escalate(db, ticket, service.staff_actor(db, admin), reason[:300])
    db.commit()
    return ok(service.staff_view(db, ticket))


class Other(CamelModel):
    other: str


@router.post("/tickets/{ticket_id}/merge", summary="Merge this ticket into another")
def merge(ticket_id: str, payload: Other, db: Session = Depends(get_db), admin: AdminUser = Depends(get_current_admin)):
    source = _ticket(db, admin, ticket_id)
    target = _find(db, admin, payload.other)
    service.merge(db, source, target, service.staff_actor(db, admin))
    return ok(service.staff_view(db, target), message=f"Merged into {target.number}.")


@router.post("/tickets/{ticket_id}/links", summary="Link a related ticket")
def add_link(ticket_id: str, payload: Other, db: Session = Depends(get_db), admin: AdminUser = Depends(get_current_admin)):
    ticket = _ticket(db, admin, ticket_id)
    service.link(db, ticket, _find(db, admin, payload.other), service.staff_actor(db, admin))
    return ok(service.staff_view(db, ticket))


@router.delete("/tickets/{ticket_id}/links/{other_id}", summary="Unlink a ticket")
def remove_link(ticket_id: str, other_id: str, db: Session = Depends(get_db),
                admin: AdminUser = Depends(get_current_admin)):
    ticket = _ticket(db, admin, ticket_id)
    service.unlink(db, ticket, other_id, service.staff_actor(db, admin))
    return ok(service.staff_view(db, ticket))


@router.post("/tickets/{ticket_id}/read", summary="Mark the customer's messages read")
def read(ticket_id: str, db: Session = Depends(get_db), admin: AdminUser = Depends(get_current_admin)):
    service.mark_read(db, _ticket(db, admin, ticket_id), "agent")
    return ok()


@router.post("/tickets/{ticket_id}/typing", summary="An agent is typing")
def typing(ticket_id: str, db: Session = Depends(get_db), admin: AdminUser = Depends(get_current_admin)):
    service.typing(db, _ticket(db, admin, ticket_id), "agent")
    return ok()


@router.get("/tickets/{ticket_id}/attachments/{attachment_id}", summary="A short-lived link to a file")
def attachment(ticket_id: str, attachment_id: int, db: Session = Depends(get_db),
               admin: AdminUser = Depends(get_current_admin)):
    ticket = _ticket(db, admin, ticket_id)
    row = db.get(TicketAttachment, attachment_id)
    if row is None or row.ticket_id != ticket.id:
        raise NotFoundError("We couldn't find that file.", error_code="ATTACHMENT_NOT_FOUND")
    return ok({"url": files.link(row), "name": row.file_name, "contentType": row.content_type})


# ------------------------------------------------------------ configuration


@router.get("/config", summary="Every support setting")
def get_config(db: Session = Depends(get_db), admin: AdminUser = Depends(configurer)):
    def rows(model, order):
        return db.execute(select(model).order_by(*order)).scalars().all()

    return ok({
        "settings": config.settings(db),
        "departments": [admin_config.department_view(db, r) for r in rows(SupportDepartment, (SupportDepartment.sort_order, SupportDepartment.name))],
        "roles": [admin_config.role_view(db, r) for r in rows(SupportRole, (SupportRole.sort_order, SupportRole.name))],
        "teams": [admin_config.team_view(db, r) for r in rows(SupportTeam, (SupportTeam.sort_order, SupportTeam.name))],
        "agents": [admin_config.agent_view(db, r) for r in rows(SupportAgent, (SupportAgent.name,))],
        "categories": config.tree(db, active_only=False),
        "articles": [admin_config.article_view(r) for r in rows(SupportArticle, (SupportArticle.sort_order, SupportArticle.id))],
        "canned": [admin_config.canned_view(r) for r in rows(CannedResponse, (CannedResponse.title,))],
        "templates": [admin_config.template_view(r) for r in rows(SupportEmailTemplate, (SupportEmailTemplate.audience, SupportEmailTemplate.key))],
        "portalAccounts": admin_config.portal_accounts(db),
        "variables": list(notify.VARIABLES),
        "options": {
            "priorities": list(config.PRIORITIES), "contactTypes": list(config.CONTACT_TYPES),
            "forms": list(config.FORMS), "assignment": list(config.ASSIGNMENT),
            "escalationWhen": list(config.ESCALATION_WHEN), "escalationNotify": list(config.ESCALATION_NOTIFY),
        },
        "attachmentsEnabled": files.enabled(),
    })


@router.put("/config/settings", summary="Save SLA, hours, chat, escalation and other settings")
def save_settings(payload: dict, db: Session = Depends(get_db), admin: AdminUser = Depends(configurer)):
    return ok(config.save_settings(db, payload), message="Support settings saved.")


def _crud(name: str, save, delete, view, needs_db_view: bool = True):
    """Create, update and delete routes for one configuration list."""

    @router.post(f"/config/{name}", status_code=201, summary=f"Add to {name}", name=f"add_{name}")
    def create(payload: dict, db: Session = Depends(get_db), admin: AdminUser = Depends(configurer)):
        row = save(db, payload)
        return ok(view(db, row) if needs_db_view else view(row))

    @router.put(f"/config/{name}/{{row_id}}", summary=f"Update in {name}", name=f"update_{name}")
    def update(row_id: int, payload: dict, db: Session = Depends(get_db), admin: AdminUser = Depends(configurer)):
        row = save(db, payload, row_id)
        return ok(view(db, row) if needs_db_view else view(row))

    @router.delete(f"/config/{name}/{{row_id}}", summary=f"Delete from {name}", name=f"delete_{name}")
    def remove(row_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(configurer)):
        delete(db, row_id)
        return ok(message="Deleted.")


def _delete(model, what):
    def delete(db: Session, row_id: int) -> None:
        row = db.get(model, row_id)
        if row is None:
            raise NotFoundError(f"No such {what}.", error_code="NOT_FOUND")
        db.delete(row)
        db.commit()

    return delete


_crud("departments", admin_config.save_department, admin_config.delete_department, admin_config.department_view)
_crud("roles", admin_config.save_role, admin_config.delete_role, admin_config.role_view)
_crud("teams", admin_config.save_team, admin_config.delete_team, admin_config.team_view)
_crud("agents", admin_config.save_agent, admin_config.delete_agent, admin_config.agent_view)
_crud("categories", admin_config.save_category, admin_config.delete_category,
      lambda db, row: {"id": row.id, "name": row.name})
_crud("articles", admin_config.save_article, _delete(SupportArticle, "article"), admin_config.article_view,
      needs_db_view=False)
_crud("canned", admin_config.save_canned, _delete(CannedResponse, "reply"), admin_config.canned_view,
      needs_db_view=False)


@router.put("/config/templates/{key}", summary="Edit an email template")
def save_template(key: str, payload: dict, db: Session = Depends(get_db), admin: AdminUser = Depends(configurer)):
    return ok(admin_config.template_view(admin_config.save_template(db, key, payload)))


class TemplatePreview(CamelModel):
    subject: str
    body: str


@router.post("/config/templates/preview", summary="Preview a template with sample values")
def preview_template(payload: TemplatePreview, db: Session = Depends(get_db), admin: AdminUser = Depends(configurer)):
    return ok(notify.preview(db, payload.subject, payload.body))
