"""Suggest identifiers, resolve one exactly — see the package docstring."""

from __future__ import annotations

import re
from typing import Dict, List, Optional, Tuple

from sqlalchemy import func, inspect, or_, select
from sqlalchemy.orm import Session

from app.core.errors import AppError, AuthorizationError, NotFoundError, ValidationError
from app.core.permissions import permissions_for
from app.models import AdminUser, Customer
from app.services.lookup.registry import (
    ADMIN_ENTITIES,
    CUSTOMER_ENTITIES,
    DEFAULT_LIMIT,
    MAX_LIMIT,
    Entity,
    IdColumn,
    normalise,
)
from app.services.search.base import LIKE_ESCAPE, escape_like
from app.utils.ids import _WIDTH as ID_DIGITS

# Digits (and the dashes of a yearly number) long enough to be worth matching
# anywhere in a document number. Shorter would match nearly everything.
_CONTAINS = re.compile(r"^[0-9-]{3,}$")
_INT_MAX = 2**63 - 1
# An integer key typed as "12" also means 120–129, 1200–1299 … up to this many digits.
_INT_DIGITS = 12


# ------------------------------------------------------------------ access


def can_access(admin: AdminUser, entity: Entity) -> bool:
    """The entity's read rule: the role's current permissions or the stored ones (as `require_access`)."""
    if admin.role == "super-admin" or entity.access is None:
        return True
    granted = set(admin.permissions or []) | set(permissions_for(admin.role))
    return bool(granted & entity.access)


def _admin_entity(db: Session, admin: AdminUser, key: str) -> Tuple[Entity, list]:
    entity = ADMIN_ENTITIES.get(key)
    if entity is None:
        raise NotFoundError("There is nothing to look up by that name.", error_code="LOOKUP_UNKNOWN_ENTITY")
    if not can_access(admin, entity):
        raise AuthorizationError(
            f"Your role does not include looking up {entity.label.lower()}s.", error_code="PERMISSION_DENIED"
        )
    return entity, (entity.scope(db, admin) if entity.scope else [])


def _customer_entity(customer: Customer, key: str) -> Tuple[Entity, list]:
    entity = CUSTOMER_ENTITIES.get(key)
    if entity is None:
        raise NotFoundError("There is nothing to look up by that name.", error_code="LOOKUP_UNKNOWN_ENTITY")
    return entity, [getattr(entity.model, entity.owner) == customer.id]


def allowed_entities(db: Session, admin: AdminUser) -> List[Entity]:
    """Every entity this administrator may look up, in registry order."""
    out = []
    for entity in ADMIN_ENTITIES.values():
        if not can_access(admin, entity):
            continue
        if entity.scope is not None:
            try:
                entity.scope(db, admin)
            except AppError:
                continue
        out.append(entity)
    return out


# ---------------------------------------------------------------- matching


def _could_start(starts: str, text: str) -> bool:
    """Whether a value beginning with `starts` could begin with `text` (either may be the shorter)."""
    n = min(len(starts), len(text))
    return starts[:n] == text[:n]


def _compact(text: str) -> str:
    return text.replace("-", "")


def _int_digits(column: IdColumn, q: str) -> Optional[str]:
    if column.display_prefix and q.startswith(column.display_prefix):
        # `GC12`, `GC-12` and the padded `GC-000012` all name key 12.
        digits = q[len(column.display_prefix):].lstrip("-")
        digits = digits.lstrip("0") or digits[:1]
    else:
        digits = q
    return digits if digits.isdigit() else None


def _prefix(attr, value: str):
    return attr.like(f"{escape_like(value)}%", escape=LIKE_ESCAPE)


def _conditions(entity: Entity, column: IdColumn, q: str) -> list:
    """The indexed conditions under which `column` matches what was typed."""
    attr = getattr(entity.model, column.attr)

    if column.kind == "int":
        digits = _int_digits(column, q)
        if digits is None or (len(digits) > 1 and digits.startswith("0")) or len(digits) > _INT_DIGITS:
            return []
        n = int(digits)
        ranges, scale = [], 1
        # "12" → 12, 120–129, 1200–1299 …: each a primary-key range.
        while len(digits) + len(str(scale)) - 1 <= _INT_DIGITS and n * scale <= _INT_MAX:
            low, high = n * scale, min((n + 1) * scale - 1, _INT_MAX)
            ranges.append(attr == low if scale == 1 else attr.between(low, high))
            scale *= 10
        return ranges

    variants = {q}
    if column.kind == "business":
        variants.add(_compact(q))
        if q.isdigit():
            # "1002" → PRD1002…, and "7" → PRD007 (ids are zero-padded).
            variants.add(column.starts + q)
            variants.add(column.starts + q.zfill(ID_DIGITS))
    out = [_prefix(attr, v) for v in sorted(variants) if v and _could_start(column.starts, v)]
    if column.contains and _CONTAINS.match(q):
        # The running number sits after the year. A leading wildcard cannot seek the
        # index, so it scans; hence the three-digit minimum before it is tried.
        out.append(attr.like(f"%{escape_like(q)}%", escape=LIKE_ESCAPE))
    return out


def _display(column: IdColumn, value) -> str:
    return f"{column.display_prefix}{value}" if column.kind == "int" else str(value)


def _rank(entity: Entity, q: str, values: tuple) -> Tuple[int, int, str]:
    """Exact first, then values that start with what was typed, then the rest; shorter, then in order."""
    display = _display(entity.columns[0], values[0])
    best = 2
    for column, value in zip(entity.columns, values):
        if value is None:
            continue
        text = _display(column, value).upper()
        typed = {q, _compact(q)} if column.kind == "business" else {q}
        if text in typed or (column.kind == "business" and _compact(text) in typed):
            best = 0
            break
        if any(text.startswith(t) for t in typed):
            best = min(best, 1)
    return best, len(display), display


def _suggest(db: Session, entity: Entity, q: str, conditions: list, limit: int) -> Tuple[List[dict], bool]:
    options = [c for column in entity.columns for c in _conditions(entity, column, q)]
    if not options:
        return [], False
    model = entity.model
    columns = [getattr(model, column.attr) for column in entity.columns]
    display = columns[0]
    rows = db.execute(
        # Identifier columns only: never a name, never the row.
        select(*columns).where(or_(*options), *conditions)
        .order_by(func.length(display), display)
        .limit(limit + 1)
    ).all()
    has_more = len(rows) > limit
    ranked = sorted((tuple(row) for row in rows[:limit]), key=lambda values: _rank(entity, q, values))

    items = []
    for values in ranked:
        item = {"id": _display(entity.columns[0], values[0])}
        # Found by another identifier (a SKU, a gateway id): say which, since
        # the ID shown would not explain the match.
        for column, value in zip(entity.columns[1:], values[1:]):
            text = None if value is None else _display(column, value).upper()
            if text and (text.startswith(q) or text.startswith(_compact(q)) or (column.contains and q in text)):
                if not item["id"].upper().startswith(q):
                    item["match"] = _display(column, value)
                break
        items.append(item)
    return items, has_more


def _exact(db: Session, entity: Entity, q: str, conditions: list):
    """The one row this identifier names, or None. Equality only: PRD002 is never PRD0021."""
    model = entity.model
    for column in entity.columns:
        attr = getattr(model, column.attr)
        if column.kind == "int":
            digits = _int_digits(column, q)
            if digits is None or int(digits) > _INT_MAX:
                continue
            condition = attr == int(digits)
        elif column.kind == "business":
            condition = attr.in_(sorted({q, _compact(q)}))
        else:
            condition = attr == q
        row = db.execute(select(model).where(condition, *conditions).limit(1)).scalars().first()
        if row is not None:
            return row
    return None


def _limit(limit: Optional[int]) -> int:
    if limit is None:
        return DEFAULT_LIMIT
    if limit < 1 or limit > MAX_LIMIT:
        raise ValidationError(f"Ask for between 1 and {MAX_LIMIT} suggestions.", error_code="LOOKUP_BAD_LIMIT")
    return limit


def _payload(db: Session, entity: Entity, row) -> dict:
    first = entity.columns[0]
    identifier = _display(first, getattr(row, first.attr))
    return {
        **entity.describe(),
        "id": identifier,
        # What the record's own screen is opened with (`?id=`): the primary
        # key, which for shipments or tickets is not the ID people read.
        # A preview may name another (a package opens its packing job).
        "key": str(inspect(row).identity[0]),
        **entity.preview(db, row),
    }


def _suggestions(entity: Entity, q: str, items: List[dict], has_more: bool) -> dict:
    return {**entity.describe(), "query": q, "items": items, "hasMore": has_more}


# ---------------------------------------------------------------- portal API


def suggest(db: Session, admin: AdminUser, key: str, raw: Optional[str], limit: Optional[int] = None) -> dict:
    entity, conditions = _admin_entity(db, admin, key)
    q = normalise(raw, label=entity.id_label)
    if not q:
        return _suggestions(entity, q, [], False)
    items, has_more = _suggest(db, entity, q, conditions, _limit(limit))
    return _suggestions(entity, q, items, has_more)


def resolve(db: Session, admin: AdminUser, key: str, raw: Optional[str]) -> dict:
    entity, conditions = _admin_entity(db, admin, key)
    return _resolve(db, entity, raw, conditions)


def _resolve(db: Session, entity: Entity, raw: Optional[str], conditions: list) -> dict:
    q = normalise(raw, label=entity.id_label)
    if not q:
        raise ValidationError(f"Enter a {entity.id_label}.", error_code="LOOKUP_EMPTY_ID")
    row = _exact(db, entity, q, conditions)
    if row is None:
        # The same answer whether it does not exist or is outside this
        # account's reach: a lookup must not confirm someone else's record.
        raise NotFoundError(f"{entity.id_label} {q} was not found.", error_code="LOOKUP_NOT_FOUND")
    return _payload(db, entity, row)


def suggest_everywhere(db: Session, admin: AdminUser, raw: Optional[str], per_entity: int = 3) -> dict:
    """
    One box for every ID: each entity this administrator may open, a few
    suggestions each. Columns whose IDs cannot start with what was typed are
    skipped without a query (see `IdColumn.starts`).
    """
    q = normalise(raw)
    per_entity = max(1, min(per_entity, 5))
    groups: List[dict] = []
    if len(q) >= 2:
        for entity in allowed_entities(db, admin):
            conditions = entity.scope(db, admin) if entity.scope else []
            items, has_more = _suggest(db, entity, q, conditions, per_entity)
            if items:
                groups.append(_suggestions(entity, q, items, has_more))
    return {"query": q, "groups": groups, "total": sum(len(g["items"]) for g in groups)}


# -------------------------------------------------------------- customer API


def suggest_for_customer(db: Session, customer: Customer, key: str, raw: Optional[str],
                         limit: Optional[int] = None) -> dict:
    entity, conditions = _customer_entity(customer, key)
    q = normalise(raw, label=entity.id_label)
    if not q:
        return _suggestions(entity, q, [], False)
    items, has_more = _suggest(db, entity, q, conditions, _limit(limit))
    return _suggestions(entity, q, items, has_more)


def resolve_for_customer(db: Session, customer: Customer, key: str, raw: Optional[str]) -> dict:
    entity, conditions = _customer_entity(customer, key)
    return _resolve(db, entity, raw, conditions)


def describe_all(entities: Dict[str, Entity]) -> List[dict]:
    return [entity.describe() for entity in entities.values()]


__all__ = ["allowed_entities", "can_access", "describe_all", "resolve", "resolve_for_customer", "suggest",
           "suggest_everywhere", "suggest_for_customer"]
