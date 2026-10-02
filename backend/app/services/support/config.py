"""
Support configuration: the settings document, the category tree, routing, and
whether anyone is there to chat.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import ValidationError
from app.models import SettingDocument, SupportAgent, SupportCategory, SupportTeam
from app.support_defaults import SETTINGS as DEFAULT_SETTINGS

PRIORITIES = ("low", "medium", "high", "urgent")
PRIORITY_LABELS = {"low": "Low", "medium": "Medium", "high": "High", "urgent": "Urgent"}
CONTACT_TYPES = ("support", "bug", "feature", "feedback", "partnership", "product", "general")
FORMS = (
    "order", "product", "delivery", "payment", "membership", "account",
    "bug", "partnership", "feature", "feedback", "general",
)
ASSIGNMENT = ("manual", "round-robin", "least-active")
DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
ESCALATION_WHEN = ("no-response", "sla-breached", "unresolved")
ESCALATION_NOTIFY = ("team-lead", "admins", "super-admins")


# ------------------------------------------------------------------ settings

# India Standard Time, for when the zone database itself is missing.
_IST = timezone(timedelta(hours=5, minutes=30), "IST")


def zone(name: Optional[str]):
    """The named time zone — or IST if it can't be loaded, rather than failing the page."""
    try:
        return ZoneInfo(name or "Asia/Kolkata")
    except (ZoneInfoNotFoundError, ValueError):
        return _IST


def settings(db: Session) -> dict:
    """The support settings, with any key the store has not saved filled from defaults."""
    stored = (db.get(SettingDocument, "support") or SettingDocument(value={})).value or {}
    merged = copy.deepcopy(DEFAULT_SETTINGS)
    merged.pop("defaultTeam", None)
    merged.setdefault("defaultTeamId", None)
    for key, value in stored.items():
        merged[key] = value
    # The request-number format is fixed, whatever an older document holds.
    from app.core import numbering

    merged["ticketPrefix"] = numbering.TICKET.prefix
    return merged


def _hours(value, field: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValidationError(f"{field} must be a number of hours.", error_code="INVALID_SLA") from None
    if number <= 0 or number > 24 * 90:
        raise ValidationError(f"{field} must be between 0 and 2,160 hours.", error_code="INVALID_SLA")
    return number


def _whole(value, field: str) -> int:
    """`int(value)`, refusing a non-number with a 422 rather than a 500."""
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ValidationError(f"{field} must be a whole number.", error_code="INVALID_SETTING") from None


def save_settings(db: Session, payload: dict) -> dict:
    """Validate and store the settings document. Unknown keys are dropped."""
    current = settings(db)
    out = dict(current)

    if "ticketPrefix" in payload and payload["ticketPrefix"] != current["ticketPrefix"]:
        # Request numbers are quoted by customers; the format is fixed in code.
        raise ValidationError("Document number formats are fixed and can't be changed.",
                              error_code="NUMBERING_LOCKED")
    if "defaultPriority" in payload:
        if payload["defaultPriority"] not in PRIORITIES:
            raise ValidationError("Choose a priority.", error_code="INVALID_PRIORITY")
        out["defaultPriority"] = payload["defaultPriority"]
    if "defaultTeamId" in payload:
        team_id = payload["defaultTeamId"]
        if team_id is not None and db.get(SupportTeam, _whole(team_id, "The default team")) is None:
            raise ValidationError("That team doesn't exist.", error_code="TEAM_NOT_FOUND")
        out["defaultTeamId"] = _whole(team_id, "The default team") if team_id is not None else None
    if "sla" in payload:
        sla = {}
        for priority in PRIORITIES:
            row = (payload["sla"] or {}).get(priority) or {}
            response = _hours(row.get("response"), f"{PRIORITY_LABELS[priority]} first reply")
            resolve = _hours(row.get("resolve"), f"{PRIORITY_LABELS[priority]} resolution")
            if response > resolve:
                raise ValidationError(
                    f"{PRIORITY_LABELS[priority]}: the first reply target can't be after the resolution target.",
                    error_code="INVALID_SLA",
                )
            sla[priority] = {"response": response, "resolve": resolve}
        out["sla"] = sla
    if "slaWarningPercent" in payload:
        percent = _whole(payload["slaWarningPercent"], "The SLA warning")
        if not 10 <= percent <= 95:
            raise ValidationError("Warn between 10% and 95% of the way.", error_code="INVALID_SLA")
        out["slaWarningPercent"] = percent
    if "escalation" in payload:
        rules = []
        for index, rule in enumerate(payload["escalation"] or []):
            if rule.get("when") not in ESCALATION_WHEN or rule.get("notify") not in ESCALATION_NOTIFY:
                raise ValidationError("Each escalation rule needs a trigger and who to notify.",
                                      error_code="INVALID_ESCALATION")
            priorities = [p for p in rule.get("priorities") or [] if p in PRIORITIES]
            rules.append({
                "id": str(rule.get("id") or f"rule-{index + 1}")[:40],
                "label": str(rule.get("label") or "")[:120],
                "when": rule["when"],
                "afterMinutes": max(0, _whole(rule.get("afterMinutes") or 0, "An escalation delay")),
                "priorities": priorities,
                "notify": rule["notify"],
            })
        out["escalation"] = rules
    if "businessHours" in payload:
        hours = payload["businessHours"] or {}
        tz_name = hours.get("timezone") or "Asia/Kolkata"
        try:
            ZoneInfo(tz_name)
        except Exception:
            raise ValidationError("That timezone isn't recognised.", error_code="INVALID_TIMEZONE") from None
        days = {}
        for day in DAYS:
            span = (hours.get("days") or {}).get(day)
            if not span:
                days[day] = None
                continue
            open_, close = str(span.get("open", "")), str(span.get("close", ""))
            if not (_is_time(open_) and _is_time(close)) or open_ >= close:
                raise ValidationError(f"Check the opening hours for {day.title()}.", error_code="INVALID_HOURS")
            days[day] = {"open": open_, "close": close}
        out["businessHours"] = {"timezone": tz_name, "days": days}
    if "holidays" in payload:
        holidays = []
        for row in payload["holidays"] or []:
            try:
                datetime.strptime(str(row.get("date")), "%Y-%m-%d")
            except ValueError:
                raise ValidationError("Holidays need a date.", error_code="INVALID_HOLIDAY") from None
            holidays.append({"date": row["date"], "name": str(row.get("name") or "")[:80]})
        out["holidays"] = sorted(holidays, key=lambda h: h["date"])
    if "chat" in payload:
        chat = payload["chat"] or {}
        out["chat"] = {"enabled": bool(chat.get("enabled")),
                       "onlyInBusinessHours": bool(chat.get("onlyInBusinessHours", True))}
    for key, low, high in (("reopenDays", 0, 90), ("autoCloseResolvedDays", 0, 90),
                           ("duplicateWindowDays", 0, 365)):
        if key in payload:
            value = _whole(payload[key], key)
            if not low <= value <= high:
                raise ValidationError(f"{key} must be between {low} and {high}.", error_code="INVALID_SETTING")
            out[key] = value
    if "attachments" in payload:
        a = payload["attachments"] or {}
        out["attachments"] = {
            "maxFiles": min(10, max(1, _whole(a.get("maxFiles") or 5, "Files per message"))),
            "maxSizeMb": min(25, max(1, _whole(a.get("maxSizeMb") or 10, "File size"))),
            "maxVideoSizeMb": min(100, max(1, _whole(a.get("maxVideoSizeMb") or 25, "Video size"))),
        }

    row = db.get(SettingDocument, "support")
    now = datetime.utcnow()
    if row is None:
        db.add(SettingDocument(key="support", value=out, created_at=now, updated_at=now))
    else:
        row.value = out
        row.updated_at = now
    db.commit()
    return out


def _is_time(value: str) -> bool:
    try:
        datetime.strptime(value, "%H:%M")
        return True
    except ValueError:
        return False


# ------------------------------------------------------------------ the tree


def all_categories(db: Session, *, active_only: bool = False) -> List[SupportCategory]:
    statement = select(SupportCategory).order_by(SupportCategory.level, SupportCategory.sort_order,
                                                 SupportCategory.id)
    if active_only:
        statement = statement.where(SupportCategory.active.is_(True))
    return list(db.execute(statement).scalars().all())


def tree(db: Session, *, active_only: bool) -> List[dict]:
    """The categories as nested dicts, with the routing each node resolves to."""
    rows = all_categories(db, active_only=active_only)
    by_id = {row.id: row for row in rows}
    children: Dict[Optional[int], List[SupportCategory]] = {}
    for row in rows:
        # A child of an inactive parent is unreachable; drop it with the parent.
        if active_only and row.parent_id is not None and row.parent_id not in by_id:
            continue
        children.setdefault(row.parent_id, []).append(row)

    def build(row: SupportCategory) -> dict:
        resolved = resolve(db, row, by_id=by_id)
        return {
            "id": row.id,
            "parentId": row.parent_id,
            "level": row.level,
            "name": row.name,
            "slug": row.slug,
            "description": row.description,
            "icon": row.icon,
            "contactType": row.contact_type,
            "form": row.form,
            "teamId": row.team_id,
            "priority": row.priority,
            "slaHours": row.sla_hours,
            "customerChoice": row.customer_choice,
            "choiceTeamIds": row.choice_team_ids or [],
            "active": row.active,
            "sortOrder": row.sort_order,
            "resolved": {
                "contactType": resolved.contact_type,
                "form": resolved.form,
                "priority": resolved.priority,
                "customerChoice": resolved.customer_choice,
                "choiceTeamIds": resolved.choice_team_ids,
                "teamId": resolved.team_id,
            },
            "children": [build(child) for child in children.get(row.id, [])],
        }

    return [build(row) for row in children.get(None, [])]


@dataclass
class Routing:
    contact_type: str
    form: str
    priority: str
    team_id: Optional[int]
    sla_hours: int
    customer_choice: str
    choice_team_ids: List[int]


def chain(db: Session, node: Optional[SupportCategory], *, by_id: Optional[dict] = None) -> List[SupportCategory]:
    """The node and its ancestors, nearest first."""
    out: List[SupportCategory] = []
    seen = set()
    while node is not None and node.id not in seen:
        out.append(node)
        seen.add(node.id)
        parent_id = node.parent_id
        if not parent_id:
            break
        node = (by_id or {}).get(parent_id) or db.get(SupportCategory, parent_id)
    return out


def resolve(db: Session, node: Optional[SupportCategory], *, by_id: Optional[dict] = None) -> Routing:
    """What a node inherits: the nearest value set on it or an ancestor, else the store default."""
    nodes = chain(db, node, by_id=by_id)
    conf = settings(db)

    def first(attr: str, empty=("", None, 0)):
        for n in nodes:
            value = getattr(n, attr)
            if value not in empty and value != []:
                return value
        return None

    return Routing(
        contact_type=first("contact_type") or "support",
        form=first("form") or "general",
        priority=first("priority") or conf.get("defaultPriority", "medium"),
        team_id=first("team_id") or conf.get("defaultTeamId"),
        sla_hours=first("sla_hours") or 0,
        # "none" set on a node stops a choice its ancestors offer.
        customer_choice="" if first("customer_choice") in (None, "none") else first("customer_choice"),
        choice_team_ids=list(first("choice_team_ids") or []),
    )


# ---------------------------------------------------------------- open hours


def is_open(db: Session, now: Optional[datetime] = None) -> bool:
    """Whether the support desk is inside its business hours (and not on a holiday)."""
    conf = settings(db)
    hours = conf.get("businessHours") or {}
    local = (now or datetime.utcnow()).replace(tzinfo=timezone.utc).astimezone(zone(hours.get("timezone")))
    if any(h.get("date") == local.strftime("%Y-%m-%d") for h in conf.get("holidays") or []):
        return False
    span = (hours.get("days") or {}).get(DAYS[local.weekday()])
    if not span:
        return False
    return span["open"] <= local.strftime("%H:%M") < span["close"]


def hours_summary(db: Session) -> str:
    """"Mon–Fri 09:00–19:00 · Sat 10:00–17:00 · Sun closed" for the contact page."""
    days = (settings(db).get("businessHours") or {}).get("days") or {}
    groups: List[tuple] = []
    for day in DAYS:
        span = days.get(day)
        label = f"{span['open']}–{span['close']}" if span else "closed"
        if groups and groups[-1][2] == label:
            groups[-1] = (groups[-1][0], day, label)
        else:
            groups.append((day, day, label))
    return " · ".join(
        f"{a.title()}{'–' + b.title() if a != b else ''} {label}" for a, b, label in groups
    )


def chat_status(db: Session) -> dict:
    """Whether live chat is on offer right now, and why not when it isn't."""
    conf = settings(db).get("chat") or {}
    if not conf.get("enabled"):
        return {"available": False, "reason": "disabled", "hours": hours_summary(db)}
    if conf.get("onlyInBusinessHours", True) and not is_open(db):
        return {"available": False, "reason": "closed", "hours": hours_summary(db)}
    online = db.execute(
        select(SupportAgent.id).where(
            SupportAgent.active.is_(True),
            SupportAgent.available.is_(True),
            SupportAgent.admin_user_id.is_not(None),
        ).limit(1)
    ).first()
    if online is None:
        return {"available": False, "reason": "nobody", "hours": hours_summary(db)}
    return {"available": True, "reason": "", "hours": hours_summary(db)}


def sla_hours(db: Session, priority: str) -> dict:
    return (settings(db).get("sla") or {}).get(priority) or DEFAULT_SETTINGS["sla"]["medium"]


def due_dates(db: Session, priority: str, start: datetime, override_hours: int = 0) -> tuple:
    targets = sla_hours(db, priority)
    resolve_hours = override_hours or targets["resolve"]
    response_hours = min(targets["response"], resolve_hours)
    return start + timedelta(hours=response_hours), start + timedelta(hours=resolve_hours)
