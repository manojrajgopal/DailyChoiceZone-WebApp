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
    # Working support tickets, and configuring who handles them.
    "support",
    "support-config",
    # Payment reconciliation and webhook events: viewing, and acting on them
    # (resolving a discrepancy, replaying an event) — kept apart on purpose.
    "payments",
    "payments-manage",
    # Pincode serviceability.
    "shipping",
    # Abandoned carts.
    "carts",
    # Back-in-stock and price-drop alerts.
    "alerts",
    # Moderating product questions and answering them.
    "questions",
    # Gift cards, store credit and reward points: each moves money or its
    # equivalent, so each is granted on its own.
    "gift-cards",
    "store-credit",
    "loyalty",
    # Growth: the referral programme (it pays out credit), flash sales and
    # bundles (they set prices).
    "referrals",
    "flash-sales",
    "bundles",
    # Reading: analytics; the audit trail (who did what — the super admin's
    # unless granted); system health.
    "analytics",
    "audit-logs",
    "health",
)

PERMISSIONS_BY_ROLE: Dict[str, List[str]] = {
    # A super admin is not enumerated here in practice — `require_permission`
    # lets the role through on its own — but the list is stored so the portal
    # can show what it covers.
    "super-admin": list(RESOURCES),
    # Configuring support — teams, routing, SLAs — is the super admin's.
    # Money-moving actions (resolving reconciliation, replaying webhooks) are
    # the super admin's; an admin can see both.
    "admin": [r for r in RESOURCES if r not in ("admins", "support-config", "payments-manage", "audit-logs")],
    "manager": ["products", "orders", "customers", "reviews", "reports", "support", "carts", "alerts", "questions",
                "flash-sales", "bundles", "analytics"],
    "editor": ["products", "content", "questions", "bundles"],
    "staff": ["products", "orders", "reviews", "support", "questions"],
}


def permissions_for(role: str) -> List[str]:
    """
    What a role may write.

    An unknown role gets nothing rather than a default set: a typo in a role
    name should lock a door, not open one.
    """
    return list(PERMISSIONS_BY_ROLE.get(role, ()))
