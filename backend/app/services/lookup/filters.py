"""
ID filters for list endpoints (docs/id-lookup.md).

A list's "find this one" box is a lookup, not a search: it is given an ID —
usually one picked from the autocomplete — and keeps the rows that ID names,
exactly. `PRD001` keeps PRD001 and never PRD0010; a name, an email or a phone
number keeps nothing.

    conditions.append(id_condition("order", q))                    # the list's own entity
    conditions.append(id_condition("order", q, column=Refund.order_id,
                                   via=Order.id))                  # a related entity's ID

Text that no ID could contain matches nothing rather than raising, so a stale
bookmark with `?q=Asha` shows an empty list instead of an error page.
"""

from __future__ import annotations

from typing import Optional

from sqlalchemy import false, or_, select

from app.core.errors import ValidationError
from app.services.lookup.registry import ADMIN_ENTITIES, Entity, normalise
from app.services.lookup.service import _compact, _int_digits, _INT_MAX


def _equalities(entity: Entity, q: str) -> list:
    options = []
    for column in entity.columns:
        attr = getattr(entity.model, column.attr)
        if column.kind == "int":
            digits = _int_digits(column, q)
            if digits is not None and int(digits) <= _INT_MAX:
                options.append(attr == int(digits))
        elif column.kind == "business":
            options.append(attr.in_(sorted({q, _compact(q)})))
        else:
            options.append(attr == q)
    return options


def normalised_id(raw: Optional[str]) -> Optional[str]:
    """What was given, as an ID; "" when blank; None when it cannot be one."""
    try:
        return normalise(raw)
    except ValidationError:
        return None


def id_condition(key: str, raw: Optional[str], *, column=None, via=None):
    """
    The WHERE condition for "rows this ID names", or None when nothing was given.

    Without `column`: rows of the entity itself (any of its identifiers equal).
    With `column` (a foreign key on the listed table) and `via` (the column it
    points at, e.g. `Order.id`): rows whose related record that ID names —
    `id_condition("order", "DCZ10241", column=Refund.order_id, via=Order.id)`.
    """
    q = normalised_id(raw)
    if q == "":
        return None
    entity = ADMIN_ENTITIES[key]
    options = _equalities(entity, q) if q is not None else []
    if not options:
        return false()
    if column is None:
        return or_(*options)
    return column.in_(select(via if via is not None else getattr(entity.model, entity.columns[0].attr)).where(or_(*options)))


def any_id_condition(raw: Optional[str], *pairs):
    """
    One box that accepts any of several entities' IDs, e.g. a shipments list
    that takes a shipment number, an AWB or the order's number:

        any_id_condition(q, ("shipment", None, None), ("order", Shipment.order_id, Order.id))

    Each pair is (entity key, column, via) as for `id_condition`.
    """
    parts = [id_condition(key, raw, column=column, via=via) for key, column, via in pairs]
    parts = [p for p in parts if p is not None]
    if not parts:
        return None
    return or_(*parts)
