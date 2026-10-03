"""
The term dictionary, and "did you mean".

`search_terms` holds the words the catalogue contains: product names, brands,
subcategories, tags, category names and attribute options, each with how many
products use it. A product's words are added when it is saved; the `search`
job rebuilds the whole dictionary (which is also what removes words nobody
uses any more).

A correction is offered only when a search finds nothing. Each word the
dictionary doesn't know is replaced by the closest word it does: an edit
distance of 1 for words up to 4 letters and 2 for longer ones, counting a
swap of neighbouring letters as one edit; ties go to the commoner word.
Candidates are narrowed in SQL first (a similar length, the same first or
last letter), so the comparison runs over a few hundred words, not all of them.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime
from typing import Dict, Iterable, List, Optional

from sqlalchemy import delete, func, insert, or_, select
from sqlalchemy.orm import Session

from app.models import Category, Product, ProductAttribute, ProductAttributeOption, ProductTag, SearchTerm
from app.services.search.base import escape_like, normalise, tokens, words

MIN_LENGTH = 3
MAX_LENGTH = 80
CANDIDATE_LIMIT = 2000
PUBLISHED = ("active", "out-of-stock")


def _keep(word: str) -> bool:
    return MIN_LENGTH <= len(word) <= MAX_LENGTH and not word.isdigit()


def distance(a: str, b: str, limit: int = 3) -> int:
    """Optimal-string-alignment distance (Damerau–Levenshtein with adjacent swaps), capped at `limit + 1`."""
    if a == b:
        return 0
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    previous2: List[int] = []
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i] + [0] * len(b)
        best = current[0]
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            value = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
            if i > 1 and j > 1 and ca == b[j - 2] and a[i - 2] == cb:
                value = min(value, previous2[j - 2] + 1)
            current[j] = value
            best = min(best, value)
        if best > limit:
            return limit + 1
        previous2, previous = previous, current
    return previous[-1]


def allowed_distance(word: str) -> int:
    return 1 if len(word) <= 4 else 2


# --------------------------------------------------------------- building


def _catalogue_words(db: Session) -> Dict[str, tuple]:
    """word -> (kind, frequency) for the whole published catalogue."""
    counts: Counter = Counter()
    kinds: Dict[str, str] = {}

    def add(text: str, kind: str) -> None:
        for word in set(tokens(text)):
            if _keep(word):
                counts[word] += 1
                kinds.setdefault(word, kind)

    for name, brand, subcategory in db.execute(
        select(Product.name, Product.brand, Product.subcategory).where(Product.status.in_(PUBLISHED))
    ):
        add(brand or "", "brand")
        add(name or "", "name")
        add((subcategory or "").replace("-", " "), "category")
    for (name,) in db.execute(select(Category.name)):
        add(name or "", "category")
    for (tag,) in db.execute(
        select(ProductTag.tag).join(Product, Product.id == ProductTag.product_id).where(Product.status.in_(PUBLISHED))
    ):
        add(tag or "", "tag")
    for (label,) in db.execute(
        select(ProductAttributeOption.label).join(ProductAttribute,
                                                  ProductAttribute.id == ProductAttributeOption.attribute_id)
        .where(ProductAttribute.status == "active", ProductAttribute.searchable.is_(True))
    ):
        add(label or "", "attribute")
    return {word: (kinds[word], count) for word, count in counts.items()}


def rebuild(db: Session) -> int:
    """Replace the dictionary with the catalogue's words. Doesn't commit. Returns the number of terms."""
    found = _catalogue_words(db)
    db.execute(delete(SearchTerm))
    now = datetime.utcnow().replace(microsecond=0)
    rows = [{"term": word, "length": len(word), "kind": kind, "frequency": count, "updated_at": now}
            for word, (kind, count) in found.items()]
    for start in range(0, len(rows), 1000):
        db.execute(insert(SearchTerm), rows[start:start + 1000])
    return len(rows)


def add_words(db: Session, texts: Iterable[str], kind: str = "name") -> int:
    """Add words that aren't in the dictionary yet (on save). Doesn't commit."""
    wanted = {word for text in texts for word in tokens(text or "") if _keep(word)}
    if not wanted:
        return 0
    known = set(db.execute(select(SearchTerm.term).where(SearchTerm.term.in_(wanted))).scalars())
    missing = sorted(wanted - {k.lower() for k in known})
    now = datetime.utcnow().replace(microsecond=0)
    for word in missing:
        db.add(SearchTerm(term=word, length=len(word), kind=kind, frequency=1, updated_at=now))
    if missing:
        db.flush()
    return len(missing)


def size(db: Session) -> int:
    return db.execute(select(func.count()).select_from(SearchTerm)).scalar_one()


# --------------------------------------------------------------- correcting


def closest(db: Session, word: str) -> Optional[str]:
    """The nearest dictionary word within the allowed distance, or None."""
    limit = allowed_distance(word)
    first, last = escape_like(word[0]), escape_like(word[-1])
    candidates = db.execute(
        select(SearchTerm.term, SearchTerm.frequency)
        .where(SearchTerm.length.between(len(word) - limit, len(word) + limit),
               or_(SearchTerm.term.like(f"{first}%", escape="!"), SearchTerm.term.like(f"%{last}", escape="!")))
        .order_by(SearchTerm.frequency.desc(), SearchTerm.term)
        .limit(CANDIDATE_LIMIT)
    ).all()
    best = None
    for term, frequency in candidates:
        term = term.lower()
        gap = distance(word, term, limit)
        if gap == 0:
            return None  # it is a known word after all
        if gap <= limit:
            key = (gap, -(frequency or 0), term)
            if best is None or key < best[0]:
                best = (key, term)
    return best[1] if best else None


def correct(db: Session, term: str) -> Optional[str]:
    """A corrected phrase when any word is unknown and has a close match; None otherwise."""
    phrase = normalise(term)
    parts = words(phrase)
    if not parts:
        return None
    checkable = [w for w in parts if _keep(w)]
    known = set()
    if checkable:
        known = {t.lower() for t in db.execute(select(SearchTerm.term).where(SearchTerm.term.in_(checkable))).scalars()}
    changed = False
    out = []
    for word in parts:
        if _keep(word) and word not in known and word.isascii():
            replacement = closest(db, word)
            if replacement and replacement != word:
                out.append(replacement)
                changed = True
                continue
        out.append(word)
    return " ".join(out) if changed else None
