"""
Editing the support configuration: departments, roles, teams, agents, the
category tree, help articles, canned replies and email templates.

A row that tickets or other rows depend on is **deactivated, never deleted** —
removing a team with tickets would orphan their history. Deletion is offered
only for rows nothing refers to yet.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Optional

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import (
    AdminUser,
    CannedResponse,
    SupportAgent,
    SupportArticle,
    SupportCategory,
    SupportDepartment,
    SupportEmailTemplate,
    SupportRole,
    SupportTeam,
    SupportTicket,
)
from app.services.support import config
from app.services.support import tickets as ticket_service

EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")


def _text(payload: dict, key: str, limit: int, *, required: bool = False, label: str = "") -> str:
    value = str(payload.get(key) or "").strip()[:limit]
    if required and not value:
        raise ValidationError(f"{label or key} is required.", error_code="FIELD_REQUIRED")
    return value


def _get(db: Session, model, row_id, what: str):
    row = db.get(model, row_id)
    if row is None:
        raise NotFoundError(f"No such {what}.", error_code="NOT_FOUND")
    return row


def _unique(db: Session, model, column, value: str, own_id, message: str) -> None:
    clash = db.execute(select(model).where(func.lower(column) == value.lower())).scalars().first()
    if clash is not None and clash.id != own_id:
        raise ConflictError(message, error_code="DUPLICATE")


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:120] or "item"


def _tickets_using(db: Session, *conditions) -> int:
    return db.execute(select(func.count()).select_from(SupportTicket).where(or_(*conditions))).scalar_one()


# --------------------------------------------------------- departments/roles


def department_view(db: Session, row: SupportDepartment) -> dict:
    teams = db.execute(select(func.count()).select_from(SupportTeam).where(SupportTeam.department_id == row.id)).scalar_one()
    return {"id": row.id, "name": row.name, "description": row.description, "active": row.active,
            "sortOrder": row.sort_order, "teams": teams}


def save_department(db: Session, payload: dict, row_id: Optional[int] = None) -> SupportDepartment:
    row = _get(db, SupportDepartment, row_id, "department") if row_id else SupportDepartment(created_at=datetime.utcnow())
    name = _text(payload, "name", 80, required=True, label="Name")
    _unique(db, SupportDepartment, SupportDepartment.name, name, row.id, "There's already a department with that name.")
    row.name, row.description = name, _text(payload, "description", 255)
    row.active = bool(payload.get("active", True))
    row.sort_order = int(payload.get("sortOrder") or 0)
    db.add(row)
    db.commit()
    return row


def delete_department(db: Session, row_id: int) -> None:
    row = _get(db, SupportDepartment, row_id, "department")
    if db.execute(select(SupportTeam.id).where(SupportTeam.department_id == row.id)).first():
        raise ConflictError("Teams belong to this department. Move them or switch the department off instead.",
                            error_code="IN_USE")
    db.delete(row)
    db.commit()


def role_view(db: Session, row: SupportRole) -> dict:
    agents = db.execute(select(func.count()).select_from(SupportAgent).where(SupportAgent.role_id == row.id)).scalar_one()
    return {"id": row.id, "name": row.name, "description": row.description, "active": row.active,
            "sortOrder": row.sort_order, "agents": agents}


def save_role(db: Session, payload: dict, row_id: Optional[int] = None) -> SupportRole:
    row = _get(db, SupportRole, row_id, "role") if row_id else SupportRole(created_at=datetime.utcnow())
    name = _text(payload, "name", 80, required=True, label="Name")
    _unique(db, SupportRole, SupportRole.name, name, row.id, "There's already a role with that name.")
    row.name, row.description = name, _text(payload, "description", 255)
    row.active = bool(payload.get("active", True))
    row.sort_order = int(payload.get("sortOrder") or 0)
    db.add(row)
    db.commit()
    return row


def delete_role(db: Session, row_id: int) -> None:
    row = _get(db, SupportRole, row_id, "role")
    if db.execute(select(SupportAgent.id).where(SupportAgent.role_id == row.id)).first():
        raise ConflictError("Agents have this role. Change theirs or switch the role off instead.", error_code="IN_USE")
    db.delete(row)
    db.commit()


# --------------------------------------------------------------------- teams


def team_view(db: Session, row: SupportTeam) -> dict:
    members = db.execute(select(SupportAgent).where(SupportAgent.team_id == row.id)).scalars().all()
    department = db.get(SupportDepartment, row.department_id) if row.department_id else None
    open_tickets = db.execute(select(func.count()).select_from(SupportTicket).where(
        SupportTicket.team_id == row.id, SupportTicket.status.in_(ticket_service.OPEN))).scalar_one()
    return {
        "id": row.id, "name": row.name, "departmentId": row.department_id,
        "department": department.name if department else "", "description": row.description,
        "notifyEmail": row.notify_email, "assignment": row.assignment,
        "customerSelectable": row.customer_selectable, "active": row.active, "sortOrder": row.sort_order,
        "agents": len(members), "activeAgents": sum(1 for m in members if m.active),
        "availableAgents": sum(1 for m in members if m.active and m.available), "openTickets": open_tickets,
    }


def save_team(db: Session, payload: dict, row_id: Optional[int] = None) -> SupportTeam:
    row = _get(db, SupportTeam, row_id, "team") if row_id else SupportTeam(created_at=datetime.utcnow())
    name = _text(payload, "name", 80, required=True, label="Name")
    _unique(db, SupportTeam, SupportTeam.name, name, row.id, "There's already a team with that name.")
    department_id = payload.get("departmentId")
    if department_id and db.get(SupportDepartment, int(department_id)) is None:
        raise ValidationError("Choose a department.", error_code="DEPARTMENT_NOT_FOUND")
    notify_email = _text(payload, "notifyEmail", 255).lower()
    if notify_email and not EMAIL.match(notify_email):
        raise ValidationError("Enter a valid team inbox address, or leave it blank.", error_code="INVALID_EMAIL")
    assignment = payload.get("assignment") or "round-robin"
    if assignment not in config.ASSIGNMENT:
        raise ValidationError("Choose how requests are assigned.", error_code="INVALID_ASSIGNMENT")
    row.name, row.description = name, _text(payload, "description", 255)
    row.department_id = int(department_id) if department_id else None
    row.notify_email, row.assignment = notify_email, assignment
    row.customer_selectable = bool(payload.get("customerSelectable"))
    row.active = bool(payload.get("active", True))
    row.sort_order = int(payload.get("sortOrder") or 0)
    db.add(row)
    db.commit()
    return row


def delete_team(db: Session, row_id: int) -> None:
    row = _get(db, SupportTeam, row_id, "team")
    in_use = _tickets_using(db, SupportTicket.team_id == row.id) or db.execute(
        select(SupportAgent.id).where(SupportAgent.team_id == row.id)).first() or db.execute(
        select(SupportCategory.id).where(SupportCategory.team_id == row.id)).first()
    if in_use:
        raise ConflictError("Tickets, agents or categories use this team. Switch it off instead.", error_code="IN_USE")
    db.delete(row)
    db.commit()


# -------------------------------------------------------------------- agents


def agent_view(db: Session, row: SupportAgent) -> dict:
    role = db.get(SupportRole, row.role_id) if row.role_id else None
    team = db.get(SupportTeam, row.team_id) if row.team_id else None
    admin = db.get(AdminUser, row.admin_user_id) if row.admin_user_id else None
    return {
        "id": row.id, "name": row.name, "email": row.email, "phone": row.phone, "photoUrl": row.photo_url,
        "roleId": row.role_id, "role": role.name if role else "", "teamId": row.team_id,
        "team": team.name if team else "", "specialization": row.specialization, "active": row.active,
        "available": row.available, "isLead": row.is_lead, "showToCustomers": row.show_to_customers,
        "notifyEmail": row.notify_email, "notifyPortal": row.notify_portal,
        "adminUserId": row.admin_user_id, "adminUser": {"id": admin.id, "name": admin.name, "email": admin.email,
                                                        "role": admin.role} if admin else None,
        "openTickets": ticket_service.open_count(db, row.id),
    }


def save_agent(db: Session, payload: dict, row_id: Optional[int] = None) -> SupportAgent:
    now = datetime.utcnow()
    row = _get(db, SupportAgent, row_id, "agent") if row_id else SupportAgent(created_at=now)
    name = _text(payload, "name", 120, required=True, label="Name")
    email = _text(payload, "email", 255, required=True, label="Email").lower()
    if not EMAIL.match(email):
        raise ValidationError("Enter a valid email address.", error_code="INVALID_EMAIL")
    _unique(db, SupportAgent, SupportAgent.email, email, row.id, "Another agent already uses that email.")
    phone = re.sub(r"\D", "", str(payload.get("phone") or ""))[-10:]
    if phone and not re.match(r"^[6-9]\d{9}$", phone):
        raise ValidationError("Enter a 10-digit mobile number, or leave it blank.", error_code="INVALID_PHONE")
    photo = _text(payload, "photoUrl", 500)
    if photo and not photo.startswith(("https://", "http://")):
        raise ValidationError("The photo must be a web address (https://…).", error_code="INVALID_PHOTO")
    for key, model, what in (("roleId", SupportRole, "role"), ("teamId", SupportTeam, "team")):
        value = payload.get(key)
        if value and db.get(model, int(value)) is None:
            raise ValidationError(f"Choose a {what}.", error_code="NOT_FOUND")
    admin_user_id = payload.get("adminUserId") or None
    if admin_user_id:
        if db.get(AdminUser, admin_user_id) is None:
            raise ValidationError("That portal account doesn't exist.", error_code="ADMIN_NOT_FOUND")
        taken = db.execute(select(SupportAgent).where(SupportAgent.admin_user_id == admin_user_id)).scalars().first()
        if taken is not None and taken.id != row.id:
            raise ConflictError(f"That portal account is already linked to {taken.name}.", error_code="DUPLICATE")
    row.name, row.email, row.phone, row.photo_url = name, email, phone, photo
    row.role_id = int(payload["roleId"]) if payload.get("roleId") else None
    row.team_id = int(payload["teamId"]) if payload.get("teamId") else None
    row.specialization = _text(payload, "specialization", 160)
    row.admin_user_id = admin_user_id
    for key, attr, default in (("active", "active", True), ("available", "available", True),
                               ("isLead", "is_lead", False), ("showToCustomers", "show_to_customers", False),
                               ("notifyEmail", "notify_email", True), ("notifyPortal", "notify_portal", True)):
        setattr(row, attr, bool(payload.get(key, default)))
    row.updated_at = now
    db.add(row)
    db.commit()
    return row


def delete_agent(db: Session, row_id: int) -> None:
    row = _get(db, SupportAgent, row_id, "agent")
    if _tickets_using(db, SupportTicket.agent_id == row.id):
        raise ConflictError("This agent has handled tickets, so their history stays. Switch them off instead.",
                            error_code="IN_USE")
    db.delete(row)
    db.commit()


def portal_accounts(db: Session) -> list:
    """Portal accounts that an agent can be linked to."""
    rows = db.execute(select(AdminUser).where(AdminUser.status == "active").order_by(AdminUser.name)).scalars().all()
    return [{"id": a.id, "name": a.name, "email": a.email, "role": a.role} for a in rows]


# ---------------------------------------------------------------- categories


def save_category(db: Session, payload: dict, row_id: Optional[int] = None) -> SupportCategory:
    row = _get(db, SupportCategory, row_id, "category") if row_id else SupportCategory(created_at=datetime.utcnow())
    name = _text(payload, "name", 120, required=True, label="Name")
    if row_id is None:
        parent_id = payload.get("parentId")
        parent = _get(db, SupportCategory, int(parent_id), "parent") if parent_id else None
        if parent is not None and parent.level >= 3:
            raise ValidationError("The tree goes three levels deep: category, option, issue.", error_code="TOO_DEEP")
        row.parent_id = parent.id if parent else None
        row.level = parent.level + 1 if parent else 1
    slug = _slug(name)
    clash = db.execute(select(SupportCategory).where(
        SupportCategory.parent_id.is_(None) if row.parent_id is None else SupportCategory.parent_id == row.parent_id,
        SupportCategory.slug == slug)).scalars().first()
    if clash is not None and clash.id != row.id:
        raise ConflictError("There's already an option with that name here.", error_code="DUPLICATE")
    contact_type = payload.get("contactType") or ""
    form = payload.get("form") or ""
    priority = payload.get("priority") or ""
    choice = payload.get("customerChoice") or ""
    if contact_type and contact_type not in config.CONTACT_TYPES:
        raise ValidationError("Choose a request type.", error_code="INVALID_TYPE")
    if form and form not in config.FORMS:
        raise ValidationError("Choose a form.", error_code="INVALID_FORM")
    if priority and priority not in config.PRIORITIES:
        raise ValidationError("Choose a priority.", error_code="INVALID_PRIORITY")
    if choice not in ("", "none", "team", "agent"):
        raise ValidationError("Choose whether customers pick who handles it.", error_code="INVALID_CHOICE")
    team_id = payload.get("teamId")
    if team_id and db.get(SupportTeam, int(team_id)) is None:
        raise ValidationError("Choose a team.", error_code="TEAM_NOT_FOUND")
    choice_team_ids = []
    for value in payload.get("choiceTeamIds") or []:
        if db.get(SupportTeam, int(value)) is None:
            raise ValidationError("Choose teams that exist.", error_code="TEAM_NOT_FOUND")
        choice_team_ids.append(int(value))
    if row.level == 1 and not (contact_type and form):
        raise ValidationError("A top-level category needs a request type and a form.", error_code="FIELD_REQUIRED")
    row.name, row.slug = name, slug
    row.description = _text(payload, "description", 255)
    row.icon = _text(payload, "icon", 40)
    row.contact_type, row.form, row.priority = contact_type, form, priority
    row.team_id = int(team_id) if team_id else None
    row.sla_hours = max(0, int(payload.get("slaHours") or 0))
    # "" inherits from the parent; "none" is an explicit "no choice here".
    row.customer_choice = choice
    row.choice_team_ids = choice_team_ids
    row.active = bool(payload.get("active", True))
    row.sort_order = int(payload.get("sortOrder") or 0)
    db.add(row)
    db.commit()
    return row


def delete_category(db: Session, row_id: int) -> None:
    row = _get(db, SupportCategory, row_id, "category")
    if db.execute(select(SupportCategory.id).where(SupportCategory.parent_id == row.id)).first():
        raise ConflictError("Remove or move the options under it first, or switch it off.", error_code="IN_USE")
    if _tickets_using(db, SupportTicket.category_id == row.id, SupportTicket.subcategory_id == row.id,
                      SupportTicket.issue_id == row.id):
        raise ConflictError("Tickets were raised under this option. Switch it off instead.", error_code="IN_USE")
    db.delete(row)
    db.commit()


# ------------------------------------------------------------------ articles


def article_view(row: SupportArticle, *, full: bool = True) -> dict:
    data = {"id": row.id, "title": row.title, "slug": row.slug, "summary": row.summary,
            "categoryIds": row.category_ids or [], "keywords": row.keywords, "active": row.active,
            "views": row.views, "helpful": row.helpful, "notHelpful": row.not_helpful, "sortOrder": row.sort_order,
            "updatedAt": row.updated_at}
    if full:
        data["body"] = row.body
    return data


def save_article(db: Session, payload: dict, row_id: Optional[int] = None) -> SupportArticle:
    now = datetime.utcnow()
    row = _get(db, SupportArticle, row_id, "article") if row_id else SupportArticle(
        created_at=now, views=0, helpful=0, not_helpful=0)
    title = _text(payload, "title", 200, required=True, label="Title")
    body = str(payload.get("body") or "").strip()
    if len(body) < 20:
        raise ValidationError("Write the article (at least 20 characters).", error_code="FIELD_REQUIRED")
    slug = _slug(_text(payload, "slug", 200) or title)
    clash = db.execute(select(SupportArticle).where(SupportArticle.slug == slug)).scalars().first()
    if clash is not None and clash.id != row.id:
        raise ConflictError("Another article uses that address.", error_code="DUPLICATE")
    ids = [int(i) for i in payload.get("categoryIds") or [] if db.get(SupportCategory, int(i)) is not None]
    row.title, row.slug, row.body = title, slug, body[:20000]
    row.summary = _text(payload, "summary", 300)
    row.category_ids = ids
    row.keywords = _text(payload, "keywords", 300)
    row.active = bool(payload.get("active", True))
    row.sort_order = int(payload.get("sortOrder") or 0)
    row.updated_at = now
    db.add(row)
    db.commit()
    return row


def search_articles(db: Session, query: str = "", category_ids=None, limit: int = 6) -> list:
    """Active articles matching words in the query or the chosen categories."""
    rows = db.execute(select(SupportArticle).where(SupportArticle.active.is_(True))
                      .order_by(SupportArticle.sort_order, SupportArticle.id)).scalars().all()
    words = [w for w in re.findall(r"[a-z0-9]+", (query or "").lower()) if len(w) > 2]
    wanted = {int(i) for i in (category_ids or []) if i}

    def score(article: SupportArticle) -> int:
        haystack = f"{article.title} {article.summary} {article.keywords} {article.body}".lower()
        points = sum(3 if w in article.title.lower() or w in article.keywords.lower() else 1
                     for w in words if w in haystack)
        if wanted and wanted & set(article.category_ids or []):
            points += 10
        return points

    if not words and not wanted:
        return rows[:limit]
    ranked = sorted(((score(a), a) for a in rows), key=lambda pair: -pair[0])
    return [a for s, a in ranked if s > 0][:limit]


# ----------------------------------------------------------- canned replies


def canned_view(row: CannedResponse) -> dict:
    return {"id": row.id, "title": row.title, "body": row.body, "categoryId": row.category_id,
            "active": row.active, "updatedAt": row.updated_at}


def save_canned(db: Session, payload: dict, row_id: Optional[int] = None) -> CannedResponse:
    now = datetime.utcnow()
    row = _get(db, CannedResponse, row_id, "reply") if row_id else CannedResponse(created_at=now)
    row.title = _text(payload, "title", 120, required=True, label="Title")
    body = str(payload.get("body") or "").strip()
    if not body:
        raise ValidationError("Write the reply.", error_code="FIELD_REQUIRED")
    row.body = body[:5000]
    category_id = payload.get("categoryId")
    row.category_id = int(category_id) if category_id and db.get(SupportCategory, int(category_id)) else None
    row.active = bool(payload.get("active", True))
    row.updated_at = now
    db.add(row)
    db.commit()
    return row


# ----------------------------------------------------------------- templates


def template_view(row: SupportEmailTemplate) -> dict:
    return {"key": row.key, "audience": row.audience, "label": row.label, "subject": row.subject,
            "body": row.body, "enabled": row.enabled, "updatedAt": row.updated_at}


def save_template(db: Session, key: str, payload: dict) -> SupportEmailTemplate:
    row = _get(db, SupportEmailTemplate, key, "template")
    subject = _text(payload, "subject", 200, required=True, label="Subject")
    body = str(payload.get("body") or "").strip()
    if len(body) < 5:
        raise ValidationError("Write the email.", error_code="FIELD_REQUIRED")
    from app.services.support.notify import VARIABLES, _VAR

    unknown = sorted({m for m in _VAR.findall(subject + body) if m not in VARIABLES})
    if unknown:
        raise ValidationError(f"Unknown variable: {', '.join('{{' + u + '}}' for u in unknown)}.",
                              error_code="UNKNOWN_VARIABLE")
    row.subject, row.body = subject, body[:10000]
    row.enabled = bool(payload.get("enabled", True))
    row.updated_at = datetime.utcnow()
    db.commit()
    return row
