"""
The `SearchBackend` interface, and the text rules every backend shares.

A backend answers two questions about a search term: which products match
(`match_condition`), and how well (`relevance`). The listing, the facets and
the admin list all ask through `registry.backend()`, so moving search to
Elasticsearch, OpenSearch or Meilisearch is one more implementation of this
interface and one registry entry: nothing above it names MySQL.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import List, Optional, Sequence

MAX_TERM_LENGTH = 200
# Words beyond this are dropped: nobody types twelve, and each one is a clause.
MAX_WORDS = 8
LIKE_ESCAPE = "!"

_SPACES = re.compile(r"\s+")
_WORD = re.compile(r"[0-9a-z]+(?:[-'][0-9a-z]+)*")


def normalise(term: Optional[str]) -> str:
    """Lower case, trimmed, inner whitespace collapsed, control characters gone, bounded."""
    if not term:
        return ""
    # Whitespace (tabs, newlines) separates words: kept as a space, not dropped with the other controls.
    text = "".join(" " if ch.isspace() else ch for ch in unicodedata.normalize("NFKC", term)
                   if ch.isspace() or unicodedata.category(ch)[0] != "C")
    return _SPACES.sub(" ", text).strip().lower()[:MAX_TERM_LENGTH]


def words(term: str) -> List[str]:
    """The words of a normalised term, in order, without repeats."""
    return list(dict.fromkeys(part for part in term.split(" ") if part))[:MAX_WORDS]


def tokens(text: str) -> List[str]:
    """Dictionary words in free text: letters and digits, hyphenated words kept whole."""
    return _WORD.findall(normalise(text))


def escape_like(value: str) -> str:
    """`50%` and `a_b` mean themselves in a LIKE pattern."""
    return (
        value.replace(LIKE_ESCAPE, LIKE_ESCAPE * 2)
        .replace("%", f"{LIKE_ESCAPE}%")
        .replace("_", f"{LIKE_ESCAPE}_")
    )


@dataclass
class SearchTerms:
    """A parsed search: the whole phrase, and each word with its synonyms."""

    phrase: str
    groups: List[List[str]] = field(default_factory=list)  # one per word: the word, then its synonyms

    @property
    def empty(self) -> bool:
        return not self.phrase


class SearchBackend:
    """What the catalogue needs from a search engine."""

    name = "base"

    def match_condition(self, terms: SearchTerms):  # pragma: no cover - interface
        """A SQL condition: the product matches every word (or one of its synonyms)."""
        raise NotImplementedError

    def relevance(self, terms: SearchTerms):  # pragma: no cover - interface
        """A SQL expression: higher is a better match."""
        raise NotImplementedError

    def suggest_products(self, db, terms: SearchTerms, limit: int) -> Sequence:  # pragma: no cover - interface
        """The best few published products for a partial term."""
        raise NotImplementedError
