"""Store settings, billing configuration, administrators and notifications."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.core.permissions import permissions_for
from app.core.security import hash_password
from app.dependencies.auth import get_current_admin, require_permission
from app.models import AdminUser, Notification, Order, Product, Review, SettingDocument
from app.services import site as site_service
from app.schemas.auth import AdminUserOut, AdminUserWrite
from app.utils.ids import next_id
from app.utils.response import ok, ok_list

router = APIRouter(prefix="/admin", tags=["Admin"])

# What counts as an order still needing attention. The same set the orders
# screen filters by, named once so the chip and the screen cannot disagree.
OPEN_ORDER_STATUSES = ("pending", "confirmed", "processing", "packed")

# The documents this endpoint will serve. An allowlist, so a crafted key cannot
# read or write something that was never meant to be configuration.
DOCUMENTS = {"store", "billing", "tax", "site", "content", "navigation", "admin_navigation"}



# -------------------------------------------------------------- settings


@router.get("/settings/{key}", summary="Read a configuration document")
def get_document(
    key: str,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    if key not in DOCUMENTS:
        raise NotFoundError(f"No configuration document '{key}'.", error_code="UNKNOWN_DOCUMENT")

    row = db.get(SettingDocument, key)
    value = row.value if row else {}
    if key == "billing":
        # Shown with the fixed document-number formats, whatever is stored.
        from app.core import numbering

        value = numbering.with_locked(value)
    return ok(value)


@router.put("/settings/{key}", summary="Save a configuration document")
def save_document(
    key: str,
    payload: dict,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("settings")),
):
    """
    Stored whole, merged at the top level.

    Settings, billing and tax are each read and written entire, by one person,
    a handful of times a year. Exploding them into columns would mean a
    migration every time a field is added, to buy querying nobody does.

    The merge is not cosmetic. A replace meant any section the saving screen
    does not model was *deleted* by saving: the billing screen knows nothing
    about `order` or `sku`, so one visit to it removed the order-number prefix
    and the next order placed got the number `1` — colliding with an existing
    one from then on. Sections are only ever replaced by a screen that sends
    them.
    """
    if key not in DOCUMENTS:
        raise NotFoundError(f"No configuration document '{key}'.", error_code="UNKNOWN_DOCUMENT")
    if key == "billing":
        # Number formats are fixed in code; see `app.core.numbering`.
        from app.core import numbering

        payload = numbering.strip_locked(payload)
    if key == "store" and "notifications" in payload:
        from app.services import staff_alerts

        payload = {**payload, "notifications": staff_alerts.clean(payload["notifications"])}

    row = db.get(SettingDocument, key)
    if row is None:
        row = SettingDocument(key=key, value=payload)
        db.add(row)
    else:
        row.value = {**(row.value or {}), **payload}

    db.commit()
    return ok(payload, message="Settings saved.")


@router.get("/alert-channels", summary="How staff alerts can be delivered")
def alert_channels(
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("settings")),
):
    """Per channel (in-app, email, SMS, WhatsApp): switched on, provider set up, and why not."""
    from app.services import staff_alerts

    return ok(staff_alerts.channel_status(db))


@router.post("/alert-channels/test", summary="Send a test staff alert on every channel that is on")
def test_alert(
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("settings")),
):
    """
    Goes exactly where a real alert would — the bell, the administrators and
    the alert recipients — so the store can check before it matters.
    """
    from app.core import rate_limit
    from app.services import staff_alerts

    rate_limit.check(f"test-alert:{admin.id}", limit=5, window_seconds=600,
                     message="Too many test alerts. Please wait a few minutes.")
    result = staff_alerts.send(db, "test", "Test alert from Daily Choice Zone",
                               f"{admin.name or admin.id} sent this to check that store alerts arrive.",
                               "/admin/settings", permission="settings")
    db.commit()
    return ok({"channels": staff_alerts.channel_status(db), "sent": result}, message="Test alert sent.")


# -------------------------------------------------------- administrators


@router.get("/users", summary="Everyone who can sign in to the portal")
def list_admins(
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    admins = db.execute(select(AdminUser).order_by(AdminUser.created_at)).scalars().all()
    return ok_list([AdminUserOut.from_model(user).model_dump(by_alias=True) for user in admins])


@router.post("/users", status_code=201, summary="Add an administrator")
def create_admin(
    payload: AdminUserWrite,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("admins")),
):
    if not payload.email or not payload.name or not payload.password:
        raise ValidationError(
            "A name, email and password are all required.", error_code="ADMIN_INCOMPLETE"
        )

    existing = db.execute(
        select(AdminUser.id).where(AdminUser.email == payload.email.lower())
    ).scalar_one_or_none()
    if existing:
        raise ConflictError("An administrator already uses that email.", error_code="EMAIL_TAKEN")

    role = payload.role or "staff"
    user = AdminUser(
        id=next_id(db, AdminUser, "admin_user"),
        email=payload.email.lower(),
        password_hash=hash_password(payload.password),
        name=payload.name,
        role=role,
        permissions=permissions_for(role),
        status=payload.status or "active",
    )

    db.add(user)
    from app.services import audit

    audit.record(db, "admins.create", resource_type="admins", resource_id=user.id, actor=admin,
                 summary=f"Added administrator {user.name} ({user.role})",
                 changes=audit.diff({}, {"email": user.email, "role": user.role, "status": user.status}))
    db.commit()
    db.refresh(user)
    return ok(AdminUserOut.from_model(user).model_dump(by_alias=True), message="Administrator added.")


@router.put("/users/{user_id}", summary="Update an administrator")
def update_admin(
    user_id: str,
    payload: AdminUserWrite,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("admins")),
):
    """
    Change a name, a role, a password or a status.

    **The last active super admin cannot be demoted or suspended.** Locking
    everyone out of the portal is not a state anyone can recover from through
    the portal.
    """
    user = db.get(AdminUser, user_id)
    if user is None:
        raise NotFoundError("No such administrator.", error_code="ADMIN_NOT_FOUND")

    provided = payload.model_dump(exclude_unset=True, by_alias=False)
    losing_super = (
        user.role == "super-admin"
        # Any status but "active" signs them out for good, not only "suspended".
        and (provided.get("role", user.role) != "super-admin"
             or ("status" in provided and provided["status"] != "active"))
    )

    if losing_super:
        remaining = db.execute(
            select(AdminUser.id).where(
                AdminUser.role == "super-admin",
                AdminUser.status == "active",
                AdminUser.id != user.id,
            )
        ).first()

        if remaining is None:
            raise ConflictError(
                "This is the last active super admin. Promote someone else first.",
                error_code="LAST_SUPER_ADMIN",
            )

    from app.services import audit

    before = audit.snapshot(user, ("name", "email", "role", "status", "permissions"))
    if payload.name is not None:
        user.name = payload.name
    if payload.email is not None:
        user.email = payload.email.lower()
    if payload.role is not None:
        user.role = payload.role
        user.permissions = permissions_for(payload.role)
    if payload.status is not None:
        user.status = payload.status
    if payload.password:
        user.password_hash = hash_password(payload.password)

    changes = audit.diff(before, audit.snapshot(user, ("name", "email", "role", "status", "permissions")))
    if payload.password:
        changes["password"] = {"from": audit.REDACTED, "to": audit.REDACTED}
    audit.record(db, "admins.update", resource_type="admins", resource_id=user.id, actor=admin,
                 summary=f"Changed administrator {user.name}" + (f" ({', '.join(changes)})" if changes else ""),
                 changes=changes or None)
    db.commit()
    db.refresh(user)
    return ok(AdminUserOut.from_model(user).model_dump(by_alias=True), message="Administrator updated.")


@router.delete("/users/{user_id}", summary="Remove an administrator")
def delete_admin(
    user_id: str,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("admins")),
):
    user = db.get(AdminUser, user_id)
    if user is None:
        raise NotFoundError("No such administrator.", error_code="ADMIN_NOT_FOUND")

    if user.id == admin.id:
        raise ConflictError("You cannot remove your own account.", error_code="SELF_DELETE")

    if user.role == "super-admin":
        remaining = db.execute(
            select(AdminUser.id).where(
                AdminUser.role == "super-admin",
                AdminUser.status == "active",
                AdminUser.id != user.id,
            )
        ).first()
        if remaining is None:
            raise ConflictError(
                "This is the last active super admin.", error_code="LAST_SUPER_ADMIN"
            )

    from app.services import audit

    audit.record(db, "admins.delete", resource_type="admins", resource_id=user.id, actor=admin,
                 summary=f"Removed administrator {user.name} ({user.email})",
                 changes=audit.diff({"email": user.email, "role": user.role, "status": user.status}, {}))
    db.delete(user)
    db.commit()
    return ok(message="Administrator removed.")


# ---------------------------------------------------------- sidebar counts


@router.get("/nav-counts", summary="The counts beside the sidebar links")
def nav_counts(
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    """
    Three numbers, counted in SQL.

    Every page of the portal shows these chips, so this is the most frequently
    called endpoint there is — which is why it is three `COUNT(*)`s and not a
    list.

    It replaced the portal downloading `/admin/inventory`, `/admin/orders` and
    `/admin/reviews` in full and counting the rows in the browser: **459 KB on
    every page view** to render three small numbers, and growing with the
    catalogue. This answers in about sixty bytes and does not grow at all.
    """
    available = Product.stock - Product.reserved_stock

    low_stock = db.execute(
        select(func.count())
        .select_from(Product)
        .where(available > 0, available <= Product.low_stock_threshold)
    ).scalar_one()

    open_orders = db.execute(
        select(func.count())
        .select_from(Order)
        .where(Order.status.in_(OPEN_ORDER_STATUSES))
    ).scalar_one()

    pending_reviews = db.execute(
        select(func.count()).select_from(Review).where(Review.status == "pending")
    ).scalar_one()

    from app.models import ReturnRequest

    open_returns = db.execute(
        select(func.count())
        .select_from(ReturnRequest)
        .where(ReturnRequest.status.notin_(("rejected", "cancelled", "refunded", "completed")))
    ).scalar_one()

    from app.models import SupportTicket
    from app.services.support.tickets import OPEN as OPEN_TICKET_STATUSES

    open_tickets = db.execute(
        select(func.count())
        .select_from(SupportTicket)
        .where(SupportTicket.status.in_(OPEN_TICKET_STATUSES), SupportTicket.merged_into_id.is_(None))
    ).scalar_one()

    from app.services import questions as question_service

    return ok(
        {
            "lowStock": low_stock,
            "openOrders": open_orders,
            "pendingReviews": pending_reviews,
            "openReturns": open_returns,
            "openTickets": open_tickets,
            "pendingQuestions": question_service.pending_count(db),
            "referralsInReview": _referrals_in_review(db),
            "failedNotifications": _failed_notifications(db),
            "waitingCustomers": _waiting_customers(db),
        }
    )


def _failed_notifications(db: Session) -> int:
    from app.models import NotificationDelivery

    return int(db.execute(select(func.count()).select_from(NotificationDelivery).where(
        NotificationDelivery.status == "dead", NotificationDelivery.category == "transactional")).scalar_one())


def _waiting_customers(db: Session) -> int:
    """Customers waiting for an out-of-stock product to be back (one each, however many products)."""
    from app.models import StockAlert

    return int(db.execute(select(func.count(func.distinct(StockAlert.customer_id))).where(
        StockAlert.status == "active")).scalar_one())


def _referrals_in_review(db: Session) -> int:
    from app.models import Referral

    return int(db.execute(select(func.count()).select_from(Referral).where(Referral.status == "review")).scalar_one())


# ------------------------------------------------------------ navigation


@router.get("/navigation", summary="The portal sidebar")
def get_navigation(
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    """
    The sidebar's groups and their links.

    Behind the admin dependency rather than public: it is a map of the portal,
    and there is no reason to hand one to somebody who cannot sign in.
    """
    return ok_list(site_service.admin_navigation(db))


# --------------------------------------------------------- notifications


def _visible_to(admin: AdminUser):
    """The tray items this administrator may see: everyone's, theirs, and those their role covers."""
    from app.core.permissions import permissions_for

    mine = (Notification.admin_id.is_(None)) | (Notification.admin_id == admin.id)
    if admin.role == "super-admin":
        return mine
    granted = sorted(set(admin.permissions or []) | set(permissions_for(admin.role)))
    return mine & (Notification.permission.is_(None) | Notification.permission.in_(granted or [""]))


@router.get("/notifications", summary="The notification tray")
def list_notifications(
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    """Newest first. `read` is this administrator's own: reading an item doesn't mark it read for the team."""
    from app.models import NotificationRead

    rows = db.execute(
        select(Notification).where(_visible_to(admin)).order_by(Notification.created_at.desc()).limit(200)
    ).scalars().all()
    read_ids = set(db.execute(select(NotificationRead.notification_id).where(
        NotificationRead.admin_id == admin.id,
        NotificationRead.notification_id.in_([row.id for row in rows] or [""]))).scalars())

    return ok_list(
        [
            {
                "id": row.id,
                "kind": row.kind,
                "title": row.title,
                "body": row.body,
                "href": row.href,
                "read": bool(row.read) or row.id in read_ids,
                "at": row.created_at,
            }
            for row in rows
        ]
    )


def _mark(db: Session, admin: AdminUser, ids) -> None:
    from app.models import NotificationRead

    ids = list(ids)
    if not ids:
        return
    done = set(db.execute(select(NotificationRead.notification_id).where(
        NotificationRead.admin_id == admin.id, NotificationRead.notification_id.in_(ids))).scalars())
    now = datetime.utcnow()
    for notification_id in ids:
        if notification_id not in done:
            db.add(NotificationRead(notification_id=notification_id, admin_id=admin.id, read_at=now))


@router.put("/notifications/{notification_id}/read", summary="Mark one as read")
def mark_read(
    notification_id: str,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    row = db.execute(select(Notification).where(Notification.id == notification_id, _visible_to(admin))
                     ).scalar_one_or_none()
    if row is None:
        raise NotFoundError("No such notification.", error_code="NOTIFICATION_NOT_FOUND")

    _mark(db, admin, [row.id])
    db.commit()
    return ok(message="Marked as read.")


@router.put("/notifications/read-all", summary="Mark everything as read")
def mark_all_read(
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    ids = db.execute(select(Notification.id).where(_visible_to(admin), Notification.read.is_(False))).scalars()
    _mark(db, admin, ids)
    db.commit()
    return ok(message="All marked as read.")
