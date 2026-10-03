"""
Search settings: where popular searches come from, and the synonym groups.

Stored in the `search` settings document. The curated popular-searches list is
not duplicated here: it stays `content.popularSearches` (Settings → Content),
which the storefront already reads, and this screen edits that same list.
"""

from __future__ import annotations

from typing import Dict, List, Optional

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.core.errors import ValidationError
from app.models import SettingDocument
from app.services.search.base import normalise

KEY = "search"
POPULAR_MODES = ("curated", "auto")
MAX_GROUPS = 200
MAX_GROUP_TERMS = 10
MAX_SYNONYM_LENGTH = 40
MAX_POPULAR = 20
MAX_POPULAR_LENGTH = 60


def document(db: Session) -> dict:
    row = db.get(SettingDocument, KEY)
    return dict((row.value if row else {}) or {})


def _write(db: Session, key: str, changes: dict) -> None:
    row = db.get(SettingDocument, key)
    if row is None:
        row = SettingDocument(key=key, value={})
        db.add(row)
    value = dict(row.value or {})
    value.update(changes)
    row.value = value
    flag_modified(row, "value")


def popular_mode(db: Session) -> str:
    mode = document(db).get("popularMode")
    return mode if mode in POPULAR_MODES else "curated"


def curated_popular(db: Session) -> List[str]:
    row = db.get(SettingDocument, "content")
    values = ((row.value if row else {}) or {}).get("popularSearches") or []
    return [str(v) for v in values if isinstance(v, str) and v.strip()][:MAX_POPULAR]


def synonym_groups(db: Session) -> List[List[str]]:
    groups = document(db).get("synonyms") or []
    return [list(group) for group in groups if isinstance(group, list)]


def synonym_map(db: Session) -> Dict[str, List[str]]:
    """Each term to the other members of its group(s)."""
    mapping: Dict[str, List[str]] = {}
    for group in synonym_groups(db):
        for term in group:
            others = [other for other in group if other != term]
            mapping.setdefault(term, [])
            for other in others:
                if other not in mapping[term]:
                    mapping[term].append(other)
    return mapping


def clean_synonyms(groups) -> List[List[str]]:
    if not isinstance(groups, list):
        raise ValidationError("Synonyms must be a list of groups.", error_code="INVALID_SYNONYMS")
    if len(groups) > MAX_GROUPS:
        raise ValidationError(f"At most {MAX_GROUPS} synonym groups.", error_code="INVALID_SYNONYMS")
    cleaned: List[List[str]] = []
    for group in groups:
        if isinstance(group, str):
            group = group.replace("=", ",").split(",")
        if not isinstance(group, list):
            raise ValidationError("Each synonym group is a list of words.", error_code="INVALID_SYNONYMS")
        terms = []
        for term in group:
            if not isinstance(term, str):
                raise ValidationError("Synonyms are words.", error_code="INVALID_SYNONYMS")
            term = normalise(term)
            if not term:
                continue
            if len(term) > MAX_SYNONYM_LENGTH or " " in term:
                raise ValidationError(f"“{term[:40]}” is too long: synonyms are single words of up to "
                                      f"{MAX_SYNONYM_LENGTH} characters.", error_code="INVALID_SYNONYMS")
            if term not in terms:
                terms.append(term)
        if len(terms) > MAX_GROUP_TERMS:
            raise ValidationError(f"At most {MAX_GROUP_TERMS} words in a synonym group.",
                                  error_code="INVALID_SYNONYMS")
        if len(terms) >= 2:
            cleaned.append(terms)
    return cleaned


def clean_popular(values) -> List[str]:
    if not isinstance(values, list):
        raise ValidationError("Popular searches must be a list.", error_code="INVALID_POPULAR_SEARCHES")
    cleaned: List[str] = []
    for value in values:
        if not isinstance(value, str):
            raise ValidationError("Popular searches are text.", error_code="INVALID_POPULAR_SEARCHES")
        value = " ".join(value.split())
        if not value:
            continue
        if len(value) > MAX_POPULAR_LENGTH:
            raise ValidationError(f"A popular search is at most {MAX_POPULAR_LENGTH} characters.",
                                  error_code="INVALID_POPULAR_SEARCHES")
        if value.lower() not in {v.lower() for v in cleaned}:
            cleaned.append(value)
    if len(cleaned) > MAX_POPULAR:
        raise ValidationError(f"At most {MAX_POPULAR} popular searches.", error_code="INVALID_POPULAR_SEARCHES")
    return cleaned


def save(db: Session, *, popular_mode: Optional[str] = None, popular_searches=None, synonyms=None) -> None:
    """Validate and store; doesn't commit."""
    changes: dict = {}
    if popular_mode is not None:
        if popular_mode not in POPULAR_MODES:
            raise ValidationError("Popular searches are either curated or automatic.",
                                  error_code="INVALID_POPULAR_MODE")
        changes["popularMode"] = popular_mode
    if synonyms is not None:
        changes["synonyms"] = clean_synonyms(synonyms)
    if changes:
        _write(db, KEY, changes)
    if popular_searches is not None:
        _write(db, "content", {"popularSearches": clean_popular(popular_searches)})


def mark_rebuilt(db: Session, at) -> None:
    _write(db, KEY, {"lastRebuildAt": at.replace(microsecond=0).isoformat()})
