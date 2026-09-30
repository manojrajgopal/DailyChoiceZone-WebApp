"""
The support configuration a fresh store starts with.

Installed **once, if absent** — by the migration for a real database and by
the test fixtures for the test one. After that every row is the store's to
edit in the portal; nothing here is read at runtime.

There are deliberately **no people and no email addresses** in this file.
Departments, roles and teams are the shape of a support desk; who works in
them, and where their mail goes, is added by the super admin.
"""

from __future__ import annotations

from datetime import datetime

DEPARTMENTS = [
    ("Customer Support", "Orders, returns, accounts and general questions."),
    ("Engineering", "The website, the apps and anything technical."),
    ("Finance", "Payments, refunds and invoices."),
    ("Operations", "Warehouse, delivery and couriers."),
    ("Membership", "The membership programme and its members."),
    ("Product", "The catalogue, product quality and feature requests."),
    ("Business Development", "Partnerships, wholesale, vendors and affiliates."),
]

ROLES = [
    "Super Admin", "Admin", "Developer", "Customer Support", "Product Manager", "Finance",
    "Operations", "Membership Manager", "Sales", "Partnership Manager",
]

# name, department, assignment strategy, offered to customers to choose
TEAMS = [
    ("Customer Support", "Customer Support", "round-robin", False),
    ("Technical Support", "Engineering", "least-active", True),
    ("Developers", "Engineering", "least-active", True),
    ("Payments & Finance", "Finance", "round-robin", False),
    ("Delivery & Operations", "Operations", "round-robin", False),
    ("Membership Team", "Membership", "round-robin", False),
    ("Product Team", "Product", "round-robin", False),
    ("Business & Partnerships", "Business Development", "manual", False),
]

# A subcategory or issue entry is a name, or a dict overriding what it
# inherits: priority, contact_type, form, team, issues (a third level).
CATEGORIES = [
    {
        "name": "Orders", "icon": "package", "contact_type": "support", "form": "order",
        "team": "Customer Support", "priority": "medium",
        "description": "Where it is, changing or cancelling it, missing or wrong items.",
        "children": [
            "Order Status", "Order Cancellation",
            {"name": "Missing Item", "priority": "high"},
            {"name": "Wrong Item", "priority": "high"},
            "Order Modification", "Other Order Issue",
        ],
    },
    {
        "name": "Products", "icon": "shirt", "contact_type": "product", "form": "product",
        "team": "Product Team", "priority": "medium",
        "description": "Sizes, stock, quality, or something that arrived damaged.",
        "children": [
            {"name": "Product Information", "priority": "low"},
            {"name": "Product Availability", "priority": "low"},
            "Product Quality",
            {"name": "Damaged Product", "priority": "high", "team": "Customer Support"},
            {"name": "Wrong Product", "priority": "high", "team": "Customer Support"},
            {"name": "Product Suggestion", "priority": "low", "contact_type": "feedback"},
        ],
    },
    {
        "name": "Delivery", "icon": "truck", "contact_type": "support", "form": "delivery",
        "team": "Delivery & Operations", "priority": "medium",
        "description": "Late parcels, tracking, addresses and couriers.",
        "children": [
            "Delayed Delivery", "Tracking Issue", "Delivery Address",
            {"name": "Failed Delivery", "priority": "high"}, "Courier Issue",
        ],
    },
    {
        "name": "Returns & Refunds", "icon": "rotate", "contact_type": "support", "form": "order",
        "team": "Customer Support", "priority": "medium",
        "description": "Returns, exchanges and refunds that haven't arrived.",
        "children": [
            "Return Request", "Return Status", "Refund Status",
            {"name": "Refund Not Received", "priority": "high", "team": "Payments & Finance"},
            "Exchange Request",
        ],
    },
    {
        "name": "Payments", "icon": "card", "contact_type": "support", "form": "payment",
        "team": "Payments & Finance", "priority": "medium",
        "description": "Failed payments, money taken without an order, UPI and cards.",
        "children": [
            "Payment Failed",
            {"name": "Payment Deducted but Order Failed", "priority": "high"},
            "Payment Verification",
            {"name": "UPI Issue", "issues": [
                "UPI app didn't open", "Payment stuck on pending", "Money deducted twice",
            ]},
            "Card Issue", "Other Payment Issue",
        ],
    },
    {
        "name": "Membership", "icon": "crown", "contact_type": "support", "form": "membership",
        "team": "Membership Team", "priority": "medium",
        "description": "Plans, benefits, upgrades and cancelling.",
        "children": [
            {"name": "Membership Information", "priority": "low"},
            {"name": "Membership Benefits", "priority": "low"},
            "Upgrade Membership", "Downgrade Membership", "Cancel Membership",
            {"name": "Membership Payment", "priority": "high", "form": "payment"},
            "Membership Issue",
        ],
    },
    {
        "name": "Account", "icon": "user", "contact_type": "support", "form": "account",
        "team": "Customer Support", "priority": "medium",
        "description": "Signing in, signing up, passwords and your profile.",
        "children": [
            {"name": "Login Problem", "issues": [
                "Forgot my password", "Not receiving emails", "Something else",
            ]},
            "Signup Problem", "Password Reset",
            {"name": "Profile Issue", "priority": "low"},
            {"name": "Account Security", "priority": "urgent"},
        ],
    },
    {
        "name": "Technical / Bug", "icon": "bug", "contact_type": "bug", "form": "bug",
        "team": "Technical Support", "priority": "high", "customer_choice": "agent",
        "choice_teams": ["Technical Support", "Developers"],
        "description": "Something on the website isn't working as it should.",
        "children": [
            {"name": "Website Bug", "issues": [
                "Page doesn't load", "A button doesn't work", "Something looks wrong", "Something else",
            ]},
            {"name": "Checkout Bug", "priority": "urgent"},
            "Product Page Bug",
            {"name": "Payment Bug", "priority": "urgent"},
            "Membership Bug",
            {"name": "Admin Portal Bug", "team": "Developers"},
            {"name": "Performance Issue", "priority": "medium"},
            {"name": "Other Technical Issue", "priority": "medium"},
        ],
    },
    {
        "name": "Business / Partnership", "icon": "briefcase", "contact_type": "partnership",
        "form": "partnership", "team": "Business & Partnerships", "priority": "low",
        "description": "Partnerships, wholesale, supplying us, affiliates and advertising.",
        "children": [
            "Partnership", "Wholesale", "Vendor", "Affiliate", "Advertising", "Other Business Enquiry",
        ],
    },
    {
        "name": "Feedback", "icon": "message", "contact_type": "feedback", "form": "feedback",
        "team": "Customer Support", "priority": "low",
        "description": "Ideas, feature requests, complaints and compliments.",
        "children": [
            "Suggestion",
            {"name": "Feature Request", "contact_type": "feature", "form": "feature", "team": "Product Team"},
            {"name": "Complaint", "priority": "medium", "contact_type": "support", "form": "general"},
            "General Feedback",
        ],
    },
    {
        "name": "General", "icon": "help", "contact_type": "general", "form": "general",
        "team": "Customer Support", "priority": "low",
        "description": "Anything else, including careers.",
        "children": [
            "General Question",
            {"name": "Careers & Jobs", "team": "Business & Partnerships"},
            "Other",
        ],
    },
]

# key, audience, label, subject, body
TEMPLATES = [
    ("ticket_created", "customer", "Request received",
     "We've received your request {{ticket_number}}",
     "Hello {{customer_name}},\n\nThank you for getting in touch. We've received your request and our "
     "{{assigned_team}} team will reply soon.\n\nRequest: {{ticket_number}}\nTopic: {{category}}\n"
     "Subject: {{subject}}\n\nYou can follow it and reply at any time from the link below.\n\n"
     "Regards,\n{{store_name}}"),
    ("ticket_assigned", "customer", "Request assigned",
     "Your request {{ticket_number}} is with our team",
     "Hello {{customer_name}},\n\nYour request \"{{subject}}\" is now with {{assigned_agent}} from our "
     "{{assigned_team}} team.\n\nRegards,\n{{store_name}}"),
    ("agent_replied", "customer", "New reply",
     "New reply on your request {{ticket_number}}",
     "Hello {{customer_name}},\n\n{{assigned_agent}} replied to your request \"{{subject}}\":\n\n"
     "{{message}}\n\nReply from the link below.\n\nRegards,\n{{store_name}}"),
    ("status_changed", "customer", "Status changed",
     "Update on your request {{ticket_number}}: {{status}}",
     "Hello {{customer_name}},\n\nYour request \"{{subject}}\" is now: {{status}}.\n\n"
     "Regards,\n{{store_name}}"),
    ("ticket_resolved", "customer", "Request resolved",
     "Your request {{ticket_number}} has been resolved",
     "Hello {{customer_name}},\n\nWe've marked your request \"{{subject}}\" as resolved. If anything is "
     "still not right, just reply and we'll pick it up again.\n\nWe'd love to know how we did — you can "
     "rate your experience from the link below.\n\nRegards,\n{{store_name}}"),
    ("ticket_closed", "customer", "Request closed",
     "Your request {{ticket_number}} has been closed",
     "Hello {{customer_name}},\n\nYour request \"{{subject}}\" is now closed. You can reopen it within "
     "{{reopen_days}} days if you need to.\n\nRegards,\n{{store_name}}"),
    ("ticket_reopened", "customer", "Request reopened",
     "Your request {{ticket_number}} has been reopened",
     "Hello {{customer_name}},\n\nYour request \"{{subject}}\" is open again and back with our team.\n\n"
     "Regards,\n{{store_name}}"),
    ("new_ticket", "internal", "New request (team)",
     "[{{priority}}] New request {{ticket_number}}: {{subject}}",
     "A new {{category}} request has arrived for {{assigned_team}}.\n\nFrom: {{customer_name}}\n"
     "Priority: {{priority}}\nRespond by: {{response_due}}\n\n{{message}}"),
    ("agent_assigned", "internal", "Assigned to you",
     "{{ticket_number}} is assigned to you: {{subject}}",
     "Hello {{assigned_agent}},\n\n{{ticket_number}} ({{category}}, {{priority}} priority) is now assigned "
     "to you.\n\nRespond by: {{response_due}}"),
    ("urgent_ticket", "internal", "Urgent or high priority",
     "[{{priority}}] {{ticket_number}} needs attention: {{subject}}",
     "A {{priority}} priority request has arrived for {{assigned_team}}.\n\nFrom: {{customer_name}}\n"
     "Respond by: {{response_due}}\n\n{{message}}"),
    ("customer_replied", "internal", "Customer replied",
     "{{customer_name}} replied on {{ticket_number}}",
     "{{customer_name}} replied on \"{{subject}}\":\n\n{{message}}"),
    ("sla_warning", "internal", "SLA due soon",
     "SLA due soon on {{ticket_number}}",
     "{{ticket_number}} (\"{{subject}}\", {{priority}}) is due by {{resolve_due}} and is still {{status}}."),
    ("sla_breached", "internal", "SLA breached",
     "SLA breached on {{ticket_number}}",
     "{{ticket_number}} (\"{{subject}}\", {{priority}}) passed its target of {{resolve_due}} and is still "
     "{{status}}."),
    ("escalation", "internal", "Escalation",
     "Escalated: {{ticket_number}} — {{subject}}",
     "{{ticket_number}} has been escalated: {{escalation_reason}}.\n\nTeam: {{assigned_team}}\n"
     "Assigned: {{assigned_agent}}\nPriority: {{priority}}\nStatus: {{status}}"),
]

SETTINGS = {
    "ticketPrefix": "DCZ",
    "defaultPriority": "medium",
    "defaultTeam": "Customer Support",
    # Hours to first reply and to resolution, per priority.
    "sla": {
        "low": {"response": 24, "resolve": 48},
        "medium": {"response": 8, "resolve": 24},
        "high": {"response": 4, "resolve": 8},
        "urgent": {"response": 1, "resolve": 2},
    },
    # Warn when this share of the window has gone.
    "slaWarningPercent": 80,
    "escalation": [
        {"id": "urgent-no-reply", "label": "Urgent request not answered within an hour",
         "when": "no-response", "afterMinutes": 60, "priorities": ["urgent"], "notify": "team-lead"},
        {"id": "sla-breached", "label": "Target missed", "when": "sla-breached", "afterMinutes": 0,
         "priorities": [], "notify": "admins"},
        {"id": "still-open-a-day-later", "label": "Still unresolved a day after the target",
         "when": "sla-breached", "afterMinutes": 1440, "priorities": [], "notify": "super-admins"},
    ],
    "businessHours": {
        "timezone": "Asia/Kolkata",
        "days": {
            "mon": {"open": "09:00", "close": "19:00"}, "tue": {"open": "09:00", "close": "19:00"},
            "wed": {"open": "09:00", "close": "19:00"}, "thu": {"open": "09:00", "close": "19:00"},
            "fri": {"open": "09:00", "close": "19:00"}, "sat": {"open": "10:00", "close": "17:00"},
            "sun": None,
        },
    },
    "holidays": [],
    "chat": {"enabled": True, "onlyInBusinessHours": True},
    "reopenDays": 7,
    "autoCloseResolvedDays": 5,
    "duplicateWindowDays": 30,
    "attachments": {"maxFiles": 5, "maxSizeMb": 10, "maxVideoSizeMb": 25},
}

# Help articles written from how this store actually works.
ARTICLES = [
    {
        "title": "How do I cancel an order?",
        "slug": "cancel-an-order",
        "summary": "Cancel from your account any time before the order is shipped.",
        "body": "Open Account → Orders, choose the order and select Cancel order. You can cancel while "
                "the order is placed, confirmed, being prepared or packed. Once it has shipped it can't be "
                "cancelled — you can return it after delivery instead.\n\nIf you paid online, the full "
                "amount is refunded to your original payment method, usually within 5–7 working days.",
        "categories": [("Orders", "Order Cancellation")],
        "keywords": "cancel order stop",
    },
    {
        "title": "How do I return or replace an item?",
        "slug": "return-or-replace",
        "summary": "Start a return or replacement from the order page after delivery.",
        "body": "Open Account → Orders, choose the delivered order and select Return or replace. Pick "
                "the items and the reason. We'll collect the item from your delivery address; a refund is "
                "issued once it reaches us, or a replacement is sent out.",
        "categories": [("Returns & Refunds", "Return Request"), ("Returns & Refunds", "Exchange Request"),
                       ("Products", "Damaged Product"), ("Products", "Wrong Product")],
        "keywords": "return replace exchange damaged wrong",
    },
    {
        "title": "When will I get my refund?",
        "slug": "refund-timing",
        "summary": "Refunds to online payments usually arrive in 5–7 working days.",
        "body": "Once a refund is issued you'll get an email. Refunds to UPI, cards, net banking and wallets "
                "usually reach you within 5–7 working days, depending on your bank. Cash on delivery orders "
                "that were never paid have nothing to refund.",
        "categories": [("Returns & Refunds", "Refund Status"), ("Returns & Refunds", "Refund Not Received")],
        "keywords": "refund money back when",
    },
    {
        "title": "Money was taken but I have no order",
        "slug": "payment-deducted-no-order",
        "summary": "Payments that don't complete an order are refunded automatically.",
        "body": "If your bank shows a payment but you have no confirmed order, the payment either completes "
                "the order within a few minutes or is refunded automatically. If it's been more than a day, "
                "contact us with the transaction reference from your bank or UPI app and we'll trace it.",
        "categories": [("Payments", "Payment Deducted but Order Failed"), ("Payments", "UPI Issue")],
        "keywords": "deducted charged debited no order failed",
    },
    {
        "title": "How does membership work, and how do I cancel it?",
        "slug": "membership-and-cancelling",
        "summary": "One payment, no automatic renewal — it simply ends on its end date.",
        "body": "A membership is a single payment for a set period, and it never renews automatically, so "
                "there is nothing to cancel to stop future charges. Your benefits apply at checkout until "
                "the end date shown in Account → Membership. If you'd like to end it early or have a "
                "question about a refund, contact our membership team.",
        "categories": [("Membership", "Cancel Membership"), ("Membership", "Membership Information"),
                       ("Membership", "Membership Benefits")],
        "keywords": "membership cancel renew benefits",
    },
    {
        "title": "Where is my order?",
        "slug": "track-an-order",
        "summary": "Every order's progress is shown on its page in your account.",
        "body": "Open Account → Orders and choose the order to see each stage — confirmed, packed, shipped, "
                "out for delivery and delivered — and the expected delivery date. We also email you at each "
                "step.",
        "categories": [("Orders", "Order Status"), ("Delivery", "Delayed Delivery"),
                       ("Delivery", "Tracking Issue")],
        "keywords": "track where status late delayed",
    },
    {
        "title": "I can't sign in",
        "slug": "cant-sign-in",
        "summary": "Check the email address you signed up with, then contact us.",
        "body": "Make sure you're using the email address you created the account with. If you still "
                "can't sign in, contact us from this page and we'll help you get back in. We will never ask "
                "for your password.",
        "categories": [("Account", "Login Problem"), ("Account", "Password Reset")],
        "keywords": "login sign in password locked",
    },
]


def install(connection, now: datetime | None = None) -> None:
    """
    Insert every default whose table is still empty — never update.

    Takes a SQLAlchemy connection (the migration's, or a test session's) and
    uses plain table descriptions rather than the models, so it keeps working
    whatever the models become.
    """
    import sqlalchemy as sa

    now = now or datetime.utcnow()

    # JSON columns carry their type, so lists and dicts are serialised rather
    # than handed to the driver as Python objects.
    json_columns = {"choice_team_ids", "category_ids", "value"}

    def table(name, *columns):
        return sa.table(name, *(sa.column(c, sa.JSON) if c in json_columns else sa.column(c) for c in columns))

    departments = table("support_departments", "id", "name", "description", "active", "sort_order", "created_at")
    roles = table("support_roles", "id", "name", "description", "active", "sort_order", "created_at")
    teams = table("support_teams", "id", "name", "department_id", "description", "notify_email",
                  "assignment", "customer_selectable", "active", "sort_order", "created_at")
    categories = table("support_categories", "id", "parent_id", "level", "name", "slug", "description",
                       "icon", "contact_type", "form", "team_id", "priority", "sla_hours",
                       "customer_choice", "choice_team_ids", "active", "sort_order", "created_at")
    templates = table("support_email_templates", "key", "audience", "label", "subject", "body",
                      "enabled", "updated_at")
    articles = table("support_articles", "title", "slug", "summary", "body", "category_ids", "keywords",
                     "active", "views", "helpful", "not_helpful", "sort_order", "created_at", "updated_at")
    documents = table("setting_documents", "key", "value", "created_at", "updated_at")

    def empty(t) -> bool:
        return connection.execute(sa.select(sa.func.count()).select_from(t)).scalar() == 0

    if empty(departments):
        connection.execute(departments.insert(), [
            {"name": n, "description": d, "active": True, "sort_order": i, "created_at": now}
            for i, (n, d) in enumerate(DEPARTMENTS)
        ])
    if empty(roles):
        connection.execute(roles.insert(), [
            {"name": n, "description": "", "active": True, "sort_order": i, "created_at": now}
            for i, n in enumerate(ROLES)
        ])

    dept_ids = {r.name: r.id for r in connection.execute(sa.select(departments.c.id, departments.c.name))}
    if empty(teams):
        connection.execute(teams.insert(), [
            {"name": n, "department_id": dept_ids.get(d), "description": "", "notify_email": "",
             "assignment": strategy, "customer_selectable": selectable, "active": True,
             "sort_order": i, "created_at": now}
            for i, (n, d, strategy, selectable) in enumerate(TEAMS)
        ])
    team_ids = {r.name: r.id for r in connection.execute(sa.select(teams.c.id, teams.c.name))}

    if empty(categories):
        def slug(name: str) -> str:
            import re
            return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")

        def add(entry, parent_id, level, order, inherited):
            spec = {"name": entry} if isinstance(entry, str) else entry
            own = {k: spec.get(k) for k in ("priority", "contact_type", "form", "team") if spec.get(k)}
            result = connection.execute(categories.insert().values(
                parent_id=parent_id, level=level, name=spec["name"], slug=slug(spec["name"]),
                description=spec.get("description", ""), icon=spec.get("icon", ""),
                # Only the top level states every value; below it an empty
                # value means "inherit", so a branch is re-routed in one place.
                contact_type=own.get("contact_type", "") if level > 1 else inherited["contact_type"],
                form=own.get("form", "") if level > 1 else inherited["form"],
                team_id=team_ids.get(own["team"]) if own.get("team") else (
                    team_ids.get(inherited["team"]) if level == 1 else None),
                priority=own.get("priority", "") if level > 1 else inherited["priority"],
                sla_hours=0,
                customer_choice=spec.get("customer_choice", ""),
                choice_team_ids=[team_ids[t] for t in spec.get("choice_teams", []) if t in team_ids],
                active=True, sort_order=order, created_at=now,
            ))
            # A lightweight table has no primary key to report; the driver has the row id.
            new_id = result.lastrowid
            for index, child in enumerate(spec.get("children", []) + spec.get("issues", [])):
                add(child, new_id, level + 1, index, inherited)

        for index, top in enumerate(CATEGORIES):
            add(top, None, 1, index, {k: top.get(k, "") for k in ("contact_type", "form", "team", "priority")})

    if empty(templates):
        connection.execute(templates.insert(), [
            {"key": k, "audience": a, "label": l, "subject": s, "body": b, "enabled": True, "updated_at": now}
            for k, a, l, s, b in TEMPLATES
        ])

    if empty(articles):
        rows = list(connection.execute(sa.select(categories.c.id, categories.c.name, categories.c.parent_id)))
        by_id = {r.id: r for r in rows}

        def find(top: str, sub: str):
            for r in rows:
                parent = by_id.get(r.parent_id) if r.parent_id else None
                if r.name == sub and parent is not None and parent.name == top:
                    return r.id
            return None

        connection.execute(articles.insert(), [
            {"title": a["title"], "slug": a["slug"], "summary": a["summary"], "body": a["body"],
             "category_ids": [c for c in (find(t, s) for t, s in a["categories"]) if c],
             "keywords": a["keywords"], "active": True, "views": 0, "helpful": 0, "not_helpful": 0,
             "sort_order": i, "created_at": now, "updated_at": now}
            for i, a in enumerate(ARTICLES)
        ])

    has_settings = connection.execute(
        sa.select(sa.func.count()).select_from(documents).where(documents.c.key == "support")
    ).scalar()
    if not has_settings:
        value = dict(SETTINGS)
        value["defaultTeamId"] = team_ids.get(value.pop("defaultTeam"))
        connection.execute(documents.insert(), [
            {"key": "support", "value": value, "created_at": now, "updated_at": now}
        ])
