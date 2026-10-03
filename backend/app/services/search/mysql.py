"""
The MySQL search backend: escaped `LIKE` matching and a computed relevance score.

Matching covers the product's own columns (name, brand, SKU, subcategory,
material, description), its tags, and `product_search_index.search_text`
(category and collection names, colours, specifications, attribute values).
The collation is case-insensitive, so `LIKE` is too.

Why not a FULLTEXT index: InnoDB full-text search doesn't see rows written
in the still-open transaction, ignores words shorter than
`innodb_ft_min_token_size`, and can't do substring or SKU-prefix matches —
see docs/search-and-filters.md, "Why not a FULLTEXT index".
"""

from __future__ import annotations

from typing import Sequence

from sqlalchemy import and_, case, literal, or_, select
from sqlalchemy.orm import Session, selectinload

from app.models import Product, ProductSearchIndex, ProductTag
from app.services.search.base import LIKE_ESCAPE, SearchBackend, SearchTerms, escape_like

PUBLISHED = ("active", "out-of-stock")


def _contains(column, word: str):
    return column.like(f"%{escape_like(word)}%", escape=LIKE_ESCAPE)


def _starts(column, word: str):
    return column.like(f"{escape_like(word)}%", escape=LIKE_ESCAPE)


def _word_start(column, word: str):
    """A word in the column starts with `word` (the first one, or one after a space)."""
    return or_(_starts(column, word), column.like(f"% {escape_like(word)}%", escape=LIKE_ESCAPE))


def _tag_exists(condition):
    return select(ProductTag.id).where(ProductTag.product_id == Product.id, condition).exists()


def _indexed(word: str):
    return (
        select(ProductSearchIndex.product_id)
        .where(ProductSearchIndex.product_id == Product.id, _contains(ProductSearchIndex.search_text, word))
        .exists()
    )


class MySQLBackend(SearchBackend):
    name = "mysql"

    def _word_matches(self, word: str, include_barcode: bool):
        clauses = [
            _contains(Product.name, word),
            _contains(Product.brand, word),
            _contains(Product.sku, word),
            _contains(Product.subcategory, word),
            _contains(Product.material, word),
            _contains(Product.description, word),
            _tag_exists(_contains(ProductTag.tag, word)),
            _indexed(word),
        ]
        if include_barcode:
            clauses.append(_contains(Product.barcode, word))
        return or_(*clauses)

    def match_condition(self, terms: SearchTerms, *, include_barcode: bool = False):
        """Every word (or one of its synonyms) matches something."""
        if terms.empty or not terms.groups:
            return None
        return and_(*[
            or_(*[self._word_matches(alternative, include_barcode) for alternative in group])
            for group in terms.groups
        ])

    def relevance(self, terms: SearchTerms):
        """See the scoring table in docs/search-and-filters.md."""
        phrase = terms.phrase
        score = (
            case((Product.name == phrase, 100), else_=0)
            + case((Product.sku == phrase, 90), else_=0)
            + case((_starts(Product.name, phrase), 60), else_=0)
            + case((_starts(Product.sku, phrase), 50), else_=0)
            + case((Product.name.like(f"% {escape_like(phrase)}%", escape=LIKE_ESCAPE), 40), else_=0)
        )
        for group in terms.groups:
            def any_of(build):
                return or_(*[build(word) for word in group])

            score = (
                score
                + case((any_of(lambda w: _word_start(Product.name, w)), 15), else_=0)
                + case((any_of(lambda w: Product.brand == w), 12),
                       (any_of(lambda w: _starts(Product.brand, w)), 8), else_=0)
                + case((any_of(lambda w: _contains(Product.name, w)), 8), else_=0)
                + case((any_of(lambda w: _tag_exists(ProductTag.tag == w)), 8), else_=0)
                + case((any_of(_indexed), 5), else_=0)
                + case((any_of(lambda w: _contains(Product.description, w)), 2), else_=0)
            )
        return score if terms.groups else literal(0)

    def suggest_products(self, db: Session, terms: SearchTerms, limit: int) -> Sequence[Product]:
        condition = self.match_condition(terms)
        if condition is None:
            return []
        statement = (
            select(Product)
            .options(selectinload(Product.images))
            .where(Product.status.in_(PUBLISHED), condition)
            .order_by(self.relevance(terms).desc(), Product.is_featured.desc(), Product.rating.desc(), Product.id)
            .limit(limit)
        )
        return list(db.execute(statement).scalars().all())
