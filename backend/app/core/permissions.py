"""
What each administrator role may write.

**One copy, on purpose.** This used to live in two places — the settings route
and the seeder — and they drifted: `manager` and `editor` were missing from one
of them, so every administrator seeded with those roles was allowed nothing.

It is **not** part of the editable content document, and must not become one.
The lists an administrator can edit in the portal decide what the interface
offers; this decides what the API permits. Putting it somewhere an
administrator can change would let one grant themselves the permission to
grant permissions.
"""

from __future__ import annotations

from typing import Dict, List

# The resources a permission can name. `require_permission` takes one of these.
RESOURCES = (
    "products",
    "orders",
    "customers",
    "coupons",
    "reviews",
    "content",
    "reports",
    "settings",
    "admins",
)

PERMISSIONS_BY_ROLE: Dict[str, List[str]] = {
    # A super admin is not enumerated here in practice — `require_permission`
    # lets the role through on its own — but the list is stored so the portal
    # can show what it covers.
    "super-admin": list(RESOURCES),
    "admin": [r for r in RESOURCES if r != "admins"],
    "manager": ["products", "orders", "customers", "reviews", "reports"],
    "editor": ["products", "content"],
    "staff": ["products", "orders", "reviews"],
}


def permissions_for(role: str) -> List[str]:
    """
    What a role may write.

    An unknown role gets nothing rather than a default set: a typo in a role
    name should lock a door, not open one.
    """
    return list(PERMISSIONS_BY_ROLE.get(role, ()))
