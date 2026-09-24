"""Product queries.

All filtering, sorting and pagination happens here, in SQL. The alternative —
loading the catalogue and filtering it in Python, or worse in the browser —
stops working at the first catalogue that does not fit in memory, and stops
being fast well before that.
"""

from __future__ import annotations

from typing import List, Optional, Sequence, Tuple

from sqlalchemy import Select, and_, distinct, func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.models import (
    Category,
    Collection,
    CollectionProduct,
    Product,
    ProductColor,
    ProductSize,
    ProductTag,
)
from app.schemas.catalogue import ProductQuery

# What a customer is allowed to see. Drafts and archived products are
# admin-only — publishing is what `status` controls, and leaking an unfinished
# product onto the shop would make the Draft state meaningless.
PUBLISHED_STATUSES = ("active", "out-of-stock")


def _with_relations(statement: Select) -> Select:
    """Eager-load the child collections a `ProductOut` needs.

    Without this, serialising a page of 24 products issues 24 × 5 extra
    queries. `selectinload` turns that into five.
    """
    return statement.options(
        selectinload(Product.images),
        selectinload(Product.colors),
        selectinload(Product.sizes),
        selectinload(Product.specifications),
        selectinload(Product.tags),
        selectinload(Product.category),
    )


def _apply_filters(statement: Select, query: ProductQuery) -> Select:
    """Every filter, as a WHERE clause."""
    conditions = []

    if query.include_unpublished:
        if query.status and query.status != "all":
            conditions.append(Product.status == query.status)
    else:
        conditions.append(Product.status.in_(PUBLISHED_STATUSES))

    if query.category:
        # Accepts a slug or an id, because the storefront routes by slug and
        # the portal filters by id, and neither should have to convert first.
        statement = statement.join(Category, Category.id == Product.category_id)
        conditions.append(or_(Category.slug == query.category, Category.id == query.category))

    if query.subcategory:
        conditions.append(Product.subcategory == query.subcategory)

    if query.collection:
        statement = statement.join(
            CollectionProduct, CollectionProduct.product_id == Product.id
        ).join(Collection, Collection.id == CollectionProduct.collection_id)
        conditions.append(
            or_(Collection.slug == query.collection, Collection.id == query.collection)
        )

    if query.brands:
        conditions.append(Product.brand.in_(query.brands))

    if query.min_price is not None:
        conditions.append(Product.price >= query.min_price)
    if query.max_price is not None:
        conditions.append(Product.price <= query.max_price)

    if query.min_rating is not None:
        conditions.append(Product.rating >= query.min_rating)

    if query.min_discount:
        conditions.append(Product.discount >= query.min_discount)

    if query.in_stock_only:
        conditions.append(Product.stock > 0)

    for flag, column in (
        (query.is_new, Product.is_new),
        (query.is_trending, Product.is_trending),
        (query.is_best_seller, Product.is_best_seller),
        (query.is_featured, Product.is_featured),
    ):
        if flag is not None:
            conditions.append(column == flag)

    # Size and colour are child rows, so these are EXISTS subqueries rather
    # than joins — a join would multiply the result set and need a DISTINCT.
    if query.sizes:
        conditions.append(
            select(ProductSize.id)
            .where(and_(ProductSize.product_id == Product.id, ProductSize.label.in_(query.sizes)))
            .exists()
        )

    if query.colors:
        conditions.append(
            select(ProductColor.id)
            .where(and_(ProductColor.product_id == Product.id, ProductColor.name.in_(query.colors)))
            .exists()
        )

    if query.search:
        conditions.append(_search_condition(query.search))

    return statement.where(and_(*conditions)) if conditions else statement


def _search_condition(term: str):
    """
    Free-text search across the fields somebody actually types.

    Every word must match *something* — so "linen shirt" finds a linen shirt
    and not everything linen plus everything shirt. `LIKE %term%` is the honest
    choice at this catalogue size; a full-text index is the answer when the
    catalogue is large enough for it to matter, and it changes only this
    function.
    """
    clauses = []

    for word in term.strip().split():
        pattern = f"%{word}%"
        clauses.append(
            or_(
                Product.name.like(pattern),
                Product.brand.like(pattern),
                Product.description.like(pattern),
                Product.material.like(pattern),
                Product.subcategory.like(pattern),
                Product.sku.like(pattern),
                select(ProductTag.id)
                .where(and_(ProductTag.product_id == Product.id, ProductTag.tag.like(pattern)))
                .exists(),
            )
        )

    return and_(*clauses) if clauses else None


def _apply_sort(statement: Select, sort: str) -> Select:
    """
    Ordering.

    Every option ends with `Product.id` so the order is *total*. Without it two
    products with the same price could swap places between page one and page
    two, and one of them would appear twice while the other vanished.
    """
    orderings = {
        "newest": (Product.created_at.desc(),),
        "price-asc": (Product.price.asc(),),
        "price-desc": (Product.price.desc(),),
        "discount": (Product.discount.desc(),),
        "rating": (Product.rating.desc(), Product.review_count.desc()),
        "popular": (Product.review_count.desc(), Product.rating.desc()),
        # "Recommended" is merchandising, not a measurement: what the shop
        # wants seen first, then what sells.
        "recommended": (
            Product.is_featured.desc(),
            Product.is_best_seller.desc(),
            Product.is_trending.desc(),
            Product.rating.desc(),
        ),
    }

    return statement.order_by(*orderings.get(sort, orderings["recommended"]), Product.id.asc())


def query_products(db: Session, query: ProductQuery) -> Tuple[List[Product], int]:
    """A page of products, and how many there are in total."""
    base = _apply_filters(select(Product), query)

    # Counted over the same filters but without the eager loads or ordering,
    # which MySQL would otherwise have to satisfy just to throw away.
    #
    # Built from its own `select(Product.id)` rather than wrapping `base`:
    # inside a subquery of `select(Product)`, a reference to `Product.id`
    # resolves to the *outer* table, so the filters are silently dropped and
    # every search reports the whole catalogue.
    id_query = _apply_filters(select(Product.id), query).distinct().subquery()
    total = db.execute(select(func.count()).select_from(id_query)).scalar_one()

    statement = _apply_sort(_with_relations(base), query.sort)
    statement = statement.offset((query.page - 1) * query.page_size).limit(query.page_size)

    items = db.execute(statement).unique().scalars().all()
    return list(items), total


def get_by_id(db: Session, product_id: str, *, published_only: bool = False) -> Optional[Product]:
    statement = _with_relations(select(Product).where(Product.id == product_id))
    if published_only:
        statement = statement.where(Product.status.in_(PUBLISHED_STATUSES))
    return db.execute(statement).unique().scalar_one_or_none()


def get_by_slug(db: Session, slug: str, *, published_only: bool = True) -> Optional[Product]:
    statement = _with_relations(select(Product).where(Product.slug == slug))
    if published_only:
        statement = statement.where(Product.status.in_(PUBLISHED_STATUSES))
    return db.execute(statement).unique().scalar_one_or_none()


def get_many(db: Session, ids: Sequence[str], *, published_only: bool = True) -> List[Product]:
    """
    Resolve ids to products, **in the order asked for**.

    The cart and the recently-viewed rail both care about order, and SQL makes
    no promise about it. Re-ordering in Python is cheaper and clearer than a
    CASE expression that has to be rebuilt for every call.
    """
    if not ids:
        return []

    statement = _with_relations(select(Product).where(Product.id.in_(list(ids))))
    if published_only:
        statement = statement.where(Product.status.in_(PUBLISHED_STATUSES))

    found = {product.id: product for product in db.execute(statement).unique().scalars().all()}
    return [found[pid] for pid in ids if pid in found]


def get_related(db: Session, product: Product, limit: int = 6) -> List[Product]:
    """
    Products a shopper might look at next.

    Nearest first: same subcategory, then same category, then same brand. Each
    tier is a separate query rather than one clever ranking expression, because
    "closest match first" is the actual intent and a single ORDER BY of three
    CASE branches says it far less clearly.
    """
    collected: List[Product] = []
    seen = {product.id}

    tiers = [
        and_(Product.category_id == product.category_id, Product.subcategory == product.subcategory),
        Product.category_id == product.category_id,
        Product.brand == product.brand,
    ]

    for condition in tiers:
        if len(collected) >= limit:
            break

        statement = (
            _with_relations(select(Product))
            .where(
                and_(
                    condition,
                    Product.status.in_(PUBLISHED_STATUSES),
                    Product.id.notin_(list(seen)),
                )
            )
            .order_by(Product.rating.desc(), Product.id.asc())
            .limit(limit - len(collected))
        )

        for candidate in db.execute(statement).unique().scalars().all():
            collected.append(candidate)
            seen.add(candidate.id)

    return collected


def build_facets(db: Session, query: ProductQuery) -> dict:
    """
    Filter options with counts, for the result set the filters already describe.

    Counted against the *scope* (search term and category) rather than the full
    filter set, so ticking one brand does not make every other brand read zero
    — which would make the filter panel impossible to use.
    """
    scope = ProductQuery(
        search=query.search,
        category=query.category,
        subcategory=query.subcategory,
        collection=query.collection,
        include_unpublished=query.include_unpublished,
    )
    base = _apply_filters(select(Product.id), scope).subquery()
    ids = select(base.c.id)

    def counted(column, model=Product, join_condition=None) -> List[dict]:
        statement = select(column, func.count(distinct(Product.id)))
        if join_condition is not None:
            statement = statement.join(model, join_condition)
        rows = db.execute(
            statement.where(Product.id.in_(ids)).group_by(column).order_by(column.asc())
        ).all()
        return [{"value": value, "label": value, "count": count} for value, count in rows if value]

    category_rows = db.execute(
        select(Category.slug, Category.name, func.count(distinct(Product.id)))
        .join(Category, Category.id == Product.category_id)
        .where(Product.id.in_(ids))
        .group_by(Category.slug, Category.name)
        .order_by(Category.name.asc())
    ).all()

    price_row = db.execute(
        select(func.min(Product.price), func.max(Product.price)).where(Product.id.in_(ids))
    ).one()

    return {
        "categories": [
            {"value": slug, "label": name, "count": count} for slug, name, count in category_rows
        ],
        "subcategories": counted(Product.subcategory),
        "brands": counted(Product.brand),
        "sizes": counted(ProductSize.label, ProductSize, ProductSize.product_id == Product.id),
        "colors": counted(ProductColor.name, ProductColor, ProductColor.product_id == Product.id),
        "price_range": {
            "min": float(price_row[0] or 0),
            "max": float(price_row[1] or 0),
        },
    }


def slug_exists(db: Session, slug: str, *, ignore_id: Optional[str] = None) -> bool:
    statement = select(Product.id).where(Product.slug == slug)
    if ignore_id:
        statement = statement.where(Product.id != ignore_id)
    return db.execute(statement.limit(1)).scalar_one_or_none() is not None


def sku_exists(db: Session, sku: str, *, ignore_id: Optional[str] = None) -> bool:
    statement = select(Product.id).where(Product.sku == sku)
    if ignore_id:
        statement = statement.where(Product.id != ignore_id)
    return db.execute(statement.limit(1)).scalar_one_or_none() is not None
