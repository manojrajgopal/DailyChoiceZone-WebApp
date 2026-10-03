"""
The catalogue listing with search on top: relevance, the typo fallback, the log.

`GET /api/products` and `GET /api/products/facets` both go through here so a
corrected term means the same thing in the result list and in its filters.
"""

from __future__ import annotations

from typing import List, Optional, Tuple

from sqlalchemy.orm import Session

from app.models import Product
from app.repositories import products as repo
from app.schemas.catalogue import ProductQuery
from app.services.search import dictionary
from app.services.search.base import normalise


def effective_term(db: Session, query: ProductQuery) -> Tuple[Optional[str], Optional[str]]:
    """
    `(term to search, correction)`.

    The correction is used only when the typed term on its own matches nothing
    in scope and the corrected one matches something: a term that finds
    products is never second-guessed, and filters that narrow a good term to
    nothing are the shopper's choice, not a typo.
    """
    term = normalise(query.search)
    if not term:
        return None, None
    if repo.term_matches_anything(db, query, term):
        return term, None
    corrected = dictionary.correct(db, term)
    if corrected and corrected != term and repo.term_matches_anything(db, query, corrected):
        return corrected, corrected
    return term, None


def prepare(db: Session, query: ProductQuery) -> Tuple[repo.Prepared, Optional[str]]:
    term, corrected = effective_term(db, query)
    return repo.Prepared(db, query, search_term=term or ""), corrected


def list_products(db: Session, query: ProductQuery, *, sort: Optional[str] = None, log: bool = False,
                  visitor_id: Optional[str] = None,
                  customer_id: Optional[str] = None) -> Tuple[List[Product], int, Optional[dict]]:
    """
    A page of products, the total, and (for a search) `{term, correctedTerm, searchId}`.

    `sort=None` means the default: relevance with a term, recommended without.
    Page 1 of a search is logged when `log` is set.
    """
    prepared, corrected = prepare(db, query)
    searching = not prepared.terms.empty
    chosen = sort or ("relevance" if searching else query.sort or "recommended")
    items, total = repo.query_products(db, query, prepared=prepared, sort=chosen)
    if not searching:
        return items, total, None
    search_id = None
    if log and query.page == 1:
        search_id = _log(db, query, total, corrected, chosen, visitor_id, customer_id)
    return items, total, {"term": normalise(query.search), "corrected_term": corrected, "search_id": search_id}


def _log(db, query, total, corrected, sort, visitor_id, customer_id) -> Optional[int]:
    from app.services.search import analytics

    try:
        return analytics.log_search(db, term=query.search or "", results=total, corrected=corrected, query=query,
                                    visitor_id=visitor_id, customer_id=customer_id, sort=sort)
    except Exception:  # noqa: BLE001 - analytics must never break a search
        import logging

        logging.getLogger(__name__).warning("Could not log a search", exc_info=True)
        db.rollback()
        return None


def facets(db: Session, query: ProductQuery) -> dict:
    prepared, _corrected = prepare(db, query)
    return repo.build_facets(db, query, prepared=prepared)
