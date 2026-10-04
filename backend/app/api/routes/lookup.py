"""
Identifier lookup (docs/id-lookup.md): find any record by its ID.

Portal (each entity needs the permission its own screens need):

    GET  /api/admin/lookup/entities                what this administrator can look up
    GET  /api/admin/lookup?q=                       every ID starting like this, grouped by entity
    GET  /api/admin/lookup/{entity}?q=&limit=       IDs of one entity — identifiers only
    GET  /api/admin/lookup/{entity}/{identifier}    exactly that one, as a short preview

Customer (only their own records):

    GET  /api/account/lookup/{entity}?q=&limit=
    GET  /api/account/lookup/{entity}/{identifier}

Suggestions carry IDs and nothing else; the preview is a separate request for
the one ID chosen, so typing never downloads records.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core import rate_limit
from app.core.database import get_db
from app.dependencies.auth import get_current_admin, get_current_customer
from app.models import AdminUser, Customer
from app.services import lookup as service
from app.services.lookup.service import describe_all
from app.utils.response import ok

admin_router = APIRouter(prefix="/admin/lookup", tags=["Admin · ID lookup"])
account_router = APIRouter(prefix="/account/lookup", tags=["Account · ID lookup"])

# An autocomplete fires a request per pause in typing — a few a second at
# most. This is far above that and far below a script walking every ID.
_PER_MINUTE = 240
_SLOW_DOWN = "That's a lot of lookups in a short time. Please wait a moment and try again."


def _throttle(kind: str, actor_id: str) -> None:
    rate_limit.check(f"lookup:{kind}:{actor_id}", limit=_PER_MINUTE, window_seconds=60, message=_SLOW_DOWN)


# ------------------------------------------------------------------ portal


@admin_router.get("/entities", summary="What this administrator can look up by ID")
def entities(db: Session = Depends(get_db), admin: AdminUser = Depends(get_current_admin)):
    return ok({"items": [entity.describe() for entity in service.allowed_entities(db, admin)]})


@admin_router.get("", summary="Every ID that starts like this, grouped by entity")
def everywhere(
    q: str = Query("", max_length=64),
    per_entity: int = Query(3, ge=1, le=5, alias="perEntity"),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    _throttle("admin", admin.id)
    return ok(service.suggest_everywhere(db, admin, q, per_entity))


@admin_router.get("/{entity}", summary="IDs of one entity that start like this")
def suggest(
    entity: str,
    q: str = Query("", max_length=64),
    limit: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    admin: AdminUser = Depends(get_current_admin),
):
    _throttle("admin", admin.id)
    return ok(service.suggest(db, admin, entity, q, limit))


@admin_router.get("/{entity}/{identifier}", summary="Exactly this ID, as a short preview")
def resolve(entity: str, identifier: str, db: Session = Depends(get_db),
            admin: AdminUser = Depends(get_current_admin)):
    _throttle("admin", admin.id)
    return ok(service.resolve(db, admin, entity, identifier))


# ---------------------------------------------------------------- customer


@account_router.get("/entities", summary="What a customer can look up by ID")
def my_entities(customer: Customer = Depends(get_current_customer)):
    return ok({"items": describe_all(service.CUSTOMER_ENTITIES)})


@account_router.get("/{entity}", summary="Your IDs that start like this")
def my_suggest(
    entity: str,
    q: str = Query("", max_length=64),
    limit: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    customer: Customer = Depends(get_current_customer),
):
    _throttle("customer", customer.id)
    return ok(service.suggest_for_customer(db, customer, entity, q, limit))


@account_router.get("/{entity}/{identifier}", summary="One of your records, by its exact ID")
def my_resolve(entity: str, identifier: str, db: Session = Depends(get_db),
               customer: Customer = Depends(get_current_customer)):
    _throttle("customer", customer.id)
    return ok(service.resolve_for_customer(db, customer, entity, identifier))
