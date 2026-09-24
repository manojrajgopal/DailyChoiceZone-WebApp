"""Store settings, billing configuration, administrators and notifications."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy import select, update as sql_update
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.core.security import hash_password
from app.dependencies.auth import get_current_admin, require_permission
from app.models import AdminUser, Notification, SettingDocument
from app.schemas.auth import AdminUserOut, AdminUserWrite
from app.utils.ids import next_id
from app.utils.response import ok, ok_list

router = APIRouter(prefix="/admin", tags=["Admin"])

# The documents this endpoint will serve. An allowlist, so a crafted key cannot
# read or write something that was never meant to be configuration.
DOCUMENTS = {"store", "billing", "tax", "site"}

# Every role the portal can assign. A role missing from here would create an
# administrator who is allowed nothing, which is not a state the portal offers.
PERMISSIONS_BY_ROLE = {
    "super-admin": [
        "products", "orders", "customers", "coupons", "reviews",
        "content", "reports", "settings", "admins",
    ],
    "admin": [
        "products", "orders", "customers", "coupons", "reviews",
        "content", "reports", "settings",
    ],
    "manager": ["products", "orders", "customers", "reviews", "reports"],
    "editor": ["products", "content"],
    "staff": ["products", "orders", "reviews"],
}


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
    return ok(row.value if row else {})


@router.put("/settings/{key}", summary="Save a configuration document")
def save_document(
    key: str,
    payload: dict,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(require_permission("settings")),
):
    """
    Stored whole.

    Settings, billing and tax are each read and written entire, by one person,
    a handful of times a year. Exploding them into columns would mean a
    migration every time a field is added, to buy querying nobody does.
    """
    if key not in DOCUMENTS:
        raise NotFoundError(f"No configuration document '{key}'.", error_code="UNKNOWN_DOCUMENT")

    row = db.get(SettingDocument, key)
    if row is None:
        row = SettingDocument(key=key, value=payload)
        db.add(row)
    else:
        row.value = payload

    db.commit()
    return ok(payload, message="Settings saved.")


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
        permissions=PERMISSIONS_BY_ROLE.get(role, []),
        status=payload.status or "active",
    )

    db.add(user)
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
        and (provided.get("role", user.role) != "super-admin" or provided.get("status") == "suspended")
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

    if payload.name is not None:
        user.name = payload.name
    if payload.email is not None:
        user.email = payload.email.lower()
    if payload.role is not None:
        user.role = payload.role
        user.permissions = PERMISSIONS_BY_ROLE.get(payload.role, [])
    if payload.status is not None:
        user.status = payload.status
    if payload.password:
        user.password_hash = hash_password(payload.password)

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

    db.delete(user)
    db.commit()
    return ok(message="Administrator removed.")


# --------------------------------------------------------- notifications


@router.get("/notifications", summary="The notification tray")
def list_notifications(
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    rows = db.execute(
        select(Notification).order_by(Notification.created_at.desc())
    ).scalars().all()

    return ok_list(
        [
            {
                "id": row.id,
                "kind": row.kind,
                "title": row.title,
                "body": row.body,
                "href": row.href,
                "read": row.read,
                "at": row.created_at,
            }
            for row in rows
        ]
    )


@router.put("/notifications/{notification_id}/read", summary="Mark one as read")
def mark_read(
    notification_id: str,
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    row = db.get(Notification, notification_id)
    if row is None:
        raise NotFoundError("No such notification.", error_code="NOTIFICATION_NOT_FOUND")

    row.read = True
    db.commit()
    return ok(message="Marked as read.")


@router.put("/notifications/read-all", summary="Mark everything as read")
def mark_all_read(
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    db.execute(sql_update(Notification).where(Notification.read.is_(False)).values(read=True))
    db.commit()
    return ok(message="All marked as read.")
