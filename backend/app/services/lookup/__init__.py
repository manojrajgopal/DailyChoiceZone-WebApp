"""
Identifier lookup (docs/id-lookup.md): every entity is found by its ID.

Two questions, answered separately on purpose:

- **Which IDs start like this?** `suggest` returns identifiers and nothing
  else: no names, no amounts, no contact details. It is what an autocomplete
  calls on every pause in typing, so it stays small, cheap and safe.
- **What is this exact ID?** `resolve` takes one identifier, matches it
  exactly — `PRD002` never answers for `PRD0021` — and returns a short preview
  of the record: the main facts, not every column.

## Only identifiers are matched

The columns searched are the ones listed in each entity's `columns`: its
business id (`PRD001`) and its unique document numbers or codes (`DCZ10241`,
`DCZ-SH-2026-000001`, a SKU, a coupon code). Never a name, an email, a phone
number or a slug — a slug is the name with dashes. Typing "shoe" finds nothing
unless an identifier really starts with SHOE.

## Every match is an indexed query

Each identifier column is unique (or indexed), so:

- a prefix (`PRD00`) is `col LIKE 'PRD00%'` — a range read on the index;
- digits only (`1002`) also try the entity's own prefix (`PRD1002%`), and for
  numbers with a year in the middle a contains match. That one reads the
  column's index rather than the table, and stops at `limit` rows;
- integer keys turn "12" into the ranges [12], [120, 129], [1200, 1299]… so
  the primary key is still used.

User input is bound as a parameter and its `%`/`_` escaped; nothing is ever
formatted into SQL.

## Authorisation is the entity's own

An entity can be looked up only by an administrator who could already open it
in the portal (`ADMIN_ENTITIES[...].access`, mirroring that area's read
guard), and a customer can look up only their own records (`CUSTOMER_ENTITIES`
are all scoped by `customer_id`). A valid ID is never a reason to show more.
"""

from app.services.lookup.registry import (  # noqa: F401
    ADMIN_ENTITIES,
    CUSTOMER_ENTITIES,
    MAX_LIMIT,
    Entity,
    IdColumn,
    normalise,
)
from app.services.lookup.service import (  # noqa: F401
    allowed_entities,
    can_access,
    resolve,
    resolve_for_customer,
    suggest,
    suggest_everywhere,
    suggest_for_customer,
)
