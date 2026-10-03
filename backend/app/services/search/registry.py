"""
Which `SearchBackend` the store uses (`SEARCH_BACKEND`), and turning a typed
term into `SearchTerms` with the store's synonyms applied.

Adding an engine: implement `SearchBackend` in a module beside `mysql.py` and
add it to `BACKENDS`. Nothing else names an engine.
"""

from __future__ import annotations

from typing import Dict, Optional, Type

from sqlalchemy.orm import Session

from app.core.config import settings
from app.services.search.base import SearchBackend, SearchTerms, normalise, words
from app.services.search.mysql import MySQLBackend

BACKENDS: Dict[str, Type[SearchBackend]] = {"mysql": MySQLBackend}
_instances: Dict[str, SearchBackend] = {}


def backend() -> SearchBackend:
    name = (getattr(settings, "SEARCH_BACKEND", "mysql") or "mysql").lower()
    cls = BACKENDS.get(name, MySQLBackend)
    if name not in _instances:
        _instances[name] = cls()
    return _instances[name]


def parse(db: Optional[Session], term: Optional[str]) -> SearchTerms:
    """The phrase and its words, each with its synonyms (when a session is given to read them)."""
    phrase = normalise(term)
    if not phrase:
        return SearchTerms(phrase="")
    synonyms = {}
    if db is not None:
        from app.services.search import settings as search_settings

        synonyms = search_settings.synonym_map(db)
    groups = [[word] + [s for s in synonyms.get(word, []) if s != word] for word in words(phrase)]
    return SearchTerms(phrase=phrase, groups=groups)
