"""
Customer support: who handles what, and every conversation with a customer.

## Configuration, all of it in the database

Departments, roles, teams, agents, the category tree, the routing on each
category, help articles, canned replies and email templates are rows an
administrator edits in the portal. Nothing about *who* receives a request is
written in code — there is no support address anywhere in this module.

## One conversation per ticket

A chat is a ticket (`channel="chat"`) — the same messages, attachments and
history. There is no separate chat store to drift out of step with the ticket
it belongs to.

## What a customer can never see

Messages of kind `note` are internal. Every read the customer side makes goes
through `services.support.customer_view`, which drops them — as it drops the
audit trail and every staff email address.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import BusinessId


class SupportDepartment(Base):
    """Engineering, Finance, Customer Support … — the groups teams belong to."""

    __tablename__ = "support_departments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False, unique=True)
    description: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class SupportRole(Base):
    """What an agent does: Developer, Finance, Membership Manager …"""

    __tablename__ = "support_roles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False, unique=True)
    description: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class SupportTeam(Base):
    """
    The group a request is routed to.

    `notify_email` is an optional shared inbox the store configures — it is
    added to, never instead of, the agents' own addresses.
    """

    __tablename__ = "support_teams"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False, unique=True)
    department_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("support_departments.id", ondelete="SET NULL"), nullable=True, index=True
    )
    description: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    notify_email: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    # manual | round-robin | least-active
    assignment: Mapped[str] = mapped_column(String(20), nullable=False, default="round-robin")
    # Offered to customers where a category lets them choose who handles it.
    customer_selectable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    last_assigned_agent_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class SupportAgent(Base):
    """
    A person who handles requests.

    Linked to a portal account when they reply from the portal; an agent
    without one still receives the emails for their team.
    """

    __tablename__ = "support_agents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    admin_user_id: Mapped[Optional[str]] = mapped_column(
        BusinessId, ForeignKey("admin_users.id", ondelete="SET NULL"), nullable=True, unique=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    email: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    phone: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    photo_url: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    role_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("support_roles.id", ondelete="SET NULL"), nullable=True, index=True
    )
    team_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("support_teams.id", ondelete="SET NULL"), nullable=True, index=True
    )
    specialization: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)
    # Taking new requests right now. Off for leave, a full queue, a shift end.
    available: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_lead: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Listed (name, role, specialisation — never the email) where a customer
    # may pick who handles their request.
    show_to_customers: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    notify_email: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    notify_portal: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class SupportCategory(Base):
    """
    One node of the Category → Subcategory → Issue tree, and how it is routed.

    Routing is inherited: an issue with no team of its own uses its
    subcategory's, then its category's, then the store default — so a whole
    branch is routed by setting one row.

    `form` names the set of fields the contact page asks for (order, payment,
    bug, partnership …); `contact_type` separates the workflows (a bug report,
    a feature request, a partnership enquiry, a support ticket).
    """

    __tablename__ = "support_categories"
    __table_args__ = (UniqueConstraint("parent_id", "slug", name="uq_support_category_slug"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    parent_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("support_categories.id", ondelete="CASCADE"), nullable=True, index=True
    )
    level: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    slug: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    icon: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    # support | bug | feature | feedback | partnership | product | general
    contact_type: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    form: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    team_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("support_teams.id", ondelete="SET NULL"), nullable=True
    )
    priority: Mapped[str] = mapped_column(String(10), nullable=False, default="")
    # Overrides the priority's resolution target, in hours. 0 = use the priority's.
    sla_hours: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # none | team | agent — whether the customer picks who handles it.
    customer_choice: Mapped[str] = mapped_column(String(10), nullable=False, default="")
    # Teams offered when the customer may choose.
    choice_team_ids: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class SupportTicket(Base):
    """One request from a customer, from submission to closure."""

    __tablename__ = "support_tickets"

    id: Mapped[str] = mapped_column(BusinessId, primary_key=True)
    number: Mapped[str] = mapped_column(String(30), nullable=False, unique=True, index=True)

    customer_id: Mapped[Optional[str]] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="SET NULL"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    phone: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    # A guest opens their ticket with a key sent by email. Kept encrypted (not
    # hashed) so later emails can carry the same link; compared in constant time.
    access_key: Mapped[str] = mapped_column(String(255), nullable=False, default="")

    channel: Mapped[str] = mapped_column(String(10), nullable=False, default="form")
    contact_type: Mapped[str] = mapped_column(String(20), nullable=False, default="support", index=True)
    category_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("support_categories.id", ondelete="SET NULL"), nullable=True, index=True
    )
    subcategory_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("support_categories.id", ondelete="SET NULL"), nullable=True, index=True
    )
    issue_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("support_categories.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # The names as they were when the request was made — a renamed category
    # must not rewrite what the customer asked about.
    category_label: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    subcategory_label: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    issue_label: Mapped[str] = mapped_column(String(120), nullable=False, default="")

    subject: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    # The fields particular to the form: bug environment, payment reference,
    # company details, feature use case …
    details: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)

    order_id: Mapped[Optional[str]] = mapped_column(
        BusinessId, ForeignKey("orders.id", ondelete="SET NULL"), nullable=True, index=True
    )
    product_id: Mapped[Optional[str]] = mapped_column(
        BusinessId, ForeignKey("products.id", ondelete="SET NULL"), nullable=True, index=True
    )
    membership_id: Mapped[Optional[str]] = mapped_column(
        BusinessId, ForeignKey("customer_memberships.id", ondelete="SET NULL"), nullable=True
    )

    priority: Mapped[str] = mapped_column(String(10), nullable=False, default="medium", index=True)
    team_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("support_teams.id", ondelete="SET NULL"), nullable=True, index=True
    )
    agent_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("support_agents.id", ondelete="SET NULL"), nullable=True, index=True
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="submitted", index=True)
    # Feature requests only: requested → under-review → planned → …
    feature_stage: Mapped[str] = mapped_column(String(20), nullable=False, default="")

    response_due_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    resolve_due_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, index=True)
    first_response_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    closed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    reopened_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    escalation_level: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Escalation rules already applied, so a rule fires once per ticket.
    escalations_applied: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    sla_warned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    sla_breached: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)
    merged_into_id: Mapped[Optional[str]] = mapped_column(
        BusinessId, ForeignKey("support_tickets.id", ondelete="SET NULL"), nullable=True
    )

    # Unread counts for each side, and who is typing — enough for a chat that
    # polls, without a socket server.
    customer_unread: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    agent_unread: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    customer_typing_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    agent_typing_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_message_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_message_preview: Mapped[str] = mapped_column(String(200), nullable=False, default="")

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)

    # Loaded when a ticket is opened, not with every row of a list or report.
    messages: Mapped[List["TicketMessage"]] = relationship(
        back_populates="ticket", cascade="all, delete-orphan",
        order_by="TicketMessage.id",
    )
    attachments: Mapped[List["TicketAttachment"]] = relationship(
        back_populates="ticket", cascade="all, delete-orphan",
        order_by="TicketAttachment.id",
    )
    events: Mapped[List["TicketEvent"]] = relationship(
        back_populates="ticket", cascade="all, delete-orphan",
        order_by="TicketEvent.id",
    )


class TicketMessage(Base):
    """
    One entry in a ticket's conversation.

    `kind`: customer | agent | system (visible to both) | note (staff only).
    """

    __tablename__ = "ticket_messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ticket_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("support_tickets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(10), nullable=False)
    author_admin_id: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    author_agent_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    author_name: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    body: Mapped[str] = mapped_column(Text, nullable=False)
    # When the other side opened it. A message is "delivered" once saved.
    read_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    ticket: Mapped[SupportTicket] = relationship(back_populates="messages")


class TicketAttachment(Base):
    """
    A file a customer or agent added.

    Stored privately (never at a public address): `storage_key` is fetched
    through a short-lived signed link, and only after the ticket's access
    check — see `services.support.attachments`.
    """

    __tablename__ = "ticket_attachments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ticket_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("support_tickets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    message_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("ticket_messages.id", ondelete="SET NULL"), nullable=True, index=True
    )
    file_name: Mapped[str] = mapped_column(String(200), nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    storage_key: Mapped[str] = mapped_column(String(300), nullable=False)
    # Files attached to an internal note are internal too.
    internal: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    uploaded_by: Mapped[str] = mapped_column(String(10), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    ticket: Mapped[SupportTicket] = relationship(back_populates="attachments")


class TicketEvent(Base):
    """The audit trail: every change to a ticket, who made it and when."""

    __tablename__ = "ticket_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ticket_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("support_tickets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(30), nullable=False)
    from_value: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    to_value: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    note: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    # customer | agent | system
    actor_kind: Mapped[str] = mapped_column(String(10), nullable=False)
    actor_id: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    actor_name: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)

    ticket: Mapped[SupportTicket] = relationship(back_populates="events")


class TicketLink(Base):
    """Two tickets about the same thing — `related`, or `merged` into another."""

    __tablename__ = "ticket_links"
    __table_args__ = (UniqueConstraint("ticket_id", "other_id", name="uq_ticket_link"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ticket_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("support_tickets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    other_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("support_tickets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(10), nullable=False, default="related")
    created_by: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class TicketFeedback(Base):
    """How the customer rated the help they got, once resolved."""

    __tablename__ = "ticket_feedback"

    ticket_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("support_tickets.id", ondelete="CASCADE"), primary_key=True
    )
    rating: Mapped[int] = mapped_column(Integer, nullable=False)
    comment: Mapped[str] = mapped_column(String(1000), nullable=False, default="")
    agent_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    customer_id: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)


class SupportArticle(Base):
    """A help article, suggested before a ticket is raised."""

    __tablename__ = "support_articles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    slug: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    summary: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    body: Mapped[str] = mapped_column(Text, nullable=False)
    # The categories (any level) it answers questions about.
    category_ids: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    keywords: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    views: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    helpful: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    not_helpful: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class CannedResponse(Base):
    """A saved reply an agent can insert and edit before sending."""

    __tablename__ = "support_canned_responses"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    category_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("support_categories.id", ondelete="SET NULL"), nullable=True
    )
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class SupportEmailTemplate(Base):
    """
    The words of each support email, with {{variables}}.

    `audience` is customer or internal; internal templates go to the agents and
    team inboxes routing picks — never to an address written here.
    """

    __tablename__ = "support_email_templates"

    key: Mapped[str] = mapped_column(String(40), primary_key=True)
    audience: Mapped[str] = mapped_column(String(10), nullable=False)
    label: Mapped[str] = mapped_column(String(120), nullable=False)
    subject: Mapped[str] = mapped_column(String(200), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class CustomerNotification(Base):
    """An update in the customer's account: a reply, a status change."""

    __tablename__ = "customer_notifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[str] = mapped_column(
        BusinessId, ForeignKey("customers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(30), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    body: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    href: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    read: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
