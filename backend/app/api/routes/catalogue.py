"""Categories and collections, for the storefront."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.schemas.catalogue import CategoryOut, CollectionOut
from app.services import catalogue as service
from app.utils.response import ok, ok_list

router = APIRouter(prefix="/categories", tags=["Categories"])
collections_router = APIRouter(prefix="/collections", tags=["Categories"])


@router.get("", summary="List categories")
def list_categories(
    with_counts: bool = Query(False, alias="withCounts"),
    db: Session = Depends(get_db),
):
    rows = service.list_categories(db, with_counts=with_counts)
    return ok_list(
        [
            CategoryOut.from_model(category, count if with_counts else None).model_dump(
                by_alias=True
            )
            for category, count in rows
        ]
    )


@router.get("/{identifier}", summary="Get a category by id or slug")
def get_category(identifier: str, db: Session = Depends(get_db)):
    """`CAT001` or `women` — the portal works in ids, the storefront in slugs."""
    category = service.get_category(db, identifier)
    return ok(CategoryOut.from_model(category).model_dump(by_alias=True))


@collections_router.get("", summary="List collections")
def list_collections(db: Session = Depends(get_db)):
    collections = service.list_collections(db)
    return ok_list([CollectionOut.from_model(c).model_dump(by_alias=True) for c in collections])


@collections_router.get("/{identifier}", summary="Get a collection by id or slug")
def get_collection(identifier: str, db: Session = Depends(get_db)):
    collection = service.get_collection(db, identifier)
    return ok(CollectionOut.from_model(collection).model_dump(by_alias=True))
