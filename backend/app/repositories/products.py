"""Product queries.

All filtering, sorting and pagination happens here, in SQL. The alternative —
loading the catalogue and filtering it in Python, or worse in the browser —
stops working at the first catalogue that does not fit in memory, and stops
being fast well before that.
"""

from __future__ import annotations

from typing import List, Optional, Sequence, Tuple

from sqlalchemy import Select, and_, case, distinct, func, or_, select
from sqlalchemy.orm import Session, aliased, selectinload

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


# ------------------------------------------------------------------ filters
#
# Each filter is a condition tagged with its *dimension*, so the facets can
# apply every filter except the one they are counting (disjunctive facets:
# ticking one brand still shows how many products the other brands have).
# Category, collection, size, colour, tag and attribute filters are IN /
# EXISTS subqueries rather than joins, so the result set is never multiplied
# and the count needs no DISTINCT.

ATTRIBUTE_DIMENSION = "attr:"
MAX_ATTRIBUTE_FILTERS = 20
MAX_ATTRIBUTE_VALUES = 30


def _available():
    """What can actually be sold: on hand minus what is held for payments in progress."""
    return Product.stock - Product.reserved_stock


def _status_condition(query: ProductQuery):
    if query.include_unpublished:
        if query.status and query.status != "all":
            return Product.status == query.status
        return None
    return Product.status.in_(PUBLISHED_STATUSES)


def resolve_attribute_filters(db: Session, query: ProductQuery) -> List[tuple]:
    """
    The query's `attr.<code>` filters matched to real attributes: `(attribute, filter)`.

    Unknown, archived and non-filterable codes are dropped, as are values a
    filter can't use (a number filter without a number, an empty list).
    """
    wanted = list(query.attributes or [])[:MAX_ATTRIBUTE_FILTERS]
    if not wanted:
        return []
    from app.models import ProductAttribute

    codes = {f.code for f in wanted}
    attributes = {
        a.code: a for a in db.execute(
            select(ProductAttribute).where(ProductAttribute.code.in_(codes), ProductAttribute.status == "active",
                                           ProductAttribute.filterable.is_(True))
        ).scalars()
    }
    resolved = []
    for wanted_filter in wanted:
        attribute = attributes.get(wanted_filter.code)
        if attribute is None:
            continue
        if attribute.type == "number":
            if wanted_filter.min is None and wanted_filter.max is None:
                continue
        else:
            values = [v for v in wanted_filter.values if v][:MAX_ATTRIBUTE_VALUES]
            if attribute.type == "boolean":
                values = [v for v in values if v in ("true", "false")]
            if not values:
                continue
            wanted_filter = wanted_filter.model_copy(update={"values": values})
        resolved.append((attribute, wanted_filter))
    return resolved


def _attribute_condition(attribute, wanted):
    from app.models import ProductAttributeValue

    # Aliased: the attribute facets join the values table themselves, and an
    # un-aliased EXISTS would correlate to that join instead of to the product.
    Value = aliased(ProductAttributeValue)
    where = [Value.product_id == Product.id, Value.attribute_id == attribute.id]
    if attribute.type == "number":
        if wanted.min is not None:
            where.append(Value.value_number >= wanted.min)
        if wanted.max is not None:
            where.append(Value.value_number <= wanted.max)
    else:
        where.append(Value.value_normalized.in_(wanted.values))
    return select(Value.id).where(*where).exists()


def filter_conditions(query: ProductQuery, *, search=None, attributes=None) -> List[tuple]:
    """Every filter as `(dimension, condition)`. `search` is the matching condition for the term, if any."""
    out: List[tuple] = []

    status = _status_condition(query)
    if status is not None:
        out.append(("status", status))

    if query.category:
        # Accepts slugs or ids, because the storefront routes by slug and the
        # portal filters by id, and neither should have to convert first.
        out.append(("category", Product.category_id.in_(
            select(Category.id).where(or_(Category.slug.in_(query.category), Category.id.in_(query.category)))
        )))

    if query.subcategory:
        out.append(("subcategory", Product.subcategory.in_(query.subcategory)))

    if query.collection:
        out.append(("collection", Product.id.in_(
            select(CollectionProduct.product_id)
            .join(Collection, Collection.id == CollectionProduct.collection_id)
            .where(or_(Collection.slug == query.collection, Collection.id == query.collection))
        )))

    if query.brands:
        out.append(("brand", Product.brand.in_(query.brands)))

    if query.min_price is not None:
        out.append(("price", Product.price >= query.min_price))
    if query.max_price is not None:
        out.append(("price", Product.price <= query.max_price))

    if query.min_rating is not None:
        out.append(("rating", Product.rating >= query.min_rating))

    if query.min_discount:
        out.append(("discount", Product.discount >= query.min_discount))

    # Available stock, not the raw count: a unit held for somebody's payment
    # isn't for sale. (This compared `stock > 0`, so a product whose every
    # unit was reserved still showed under "in stock".)
    if query.in_stock_only or query.availability == "in-stock":
        out.append(("availability", _available() > 0))
    elif query.availability == "out-of-stock":
        out.append(("availability", _available() <= 0))

    if query.stock_level == "out-of-stock":
        out.append(("stock", _available() <= 0))
    elif query.stock_level == "low-stock":
        out.append(("stock", and_(_available() > 0, _available() <= Product.low_stock_threshold)))
    elif query.stock_level == "in-stock":
        out.append(("stock", _available() > Product.low_stock_threshold))

    for name, flag, column in (
        ("isNew", query.is_new, Product.is_new),
        ("isTrending", query.is_trending, Product.is_trending),
        ("isBestSeller", query.is_best_seller, Product.is_best_seller),
        ("isFeatured", query.is_featured, Product.is_featured),
    ):
        if flag is not None:
            out.append((name, column == flag))

    if query.sizes:
        size = aliased(ProductSize)
        out.append(("size", select(size.id).where(size.product_id == Product.id, size.label.in_(query.sizes)).exists()))

    if query.colors:
        colour = aliased(ProductColor)
        out.append(("color", select(colour.id).where(
            colour.product_id == Product.id, colour.name.in_(query.colors)).exists()))

    for attribute, wanted in attributes or []:
        out.append((ATTRIBUTE_DIMENSION + attribute.code, _attribute_condition(attribute, wanted)))

    if search is not None:
        out.append(("search", search))

    return out


def _where(statement: Select, conditions: List[tuple], exclude: Sequence[str] = ()) -> Select:
    kept = [condition for dimension, condition in conditions if dimension not in exclude]
    return statement.where(and_(*kept)) if kept else statement


class Prepared:
    """A query with the parts that need the database worked out once: the search terms and the attributes."""

    def __init__(self, db: Session, query: ProductQuery, *, search_term: Optional[str] = None):
        from app.services.search import registry

        self.query = query
        self.backend = registry.backend()
        term = query.search if search_term is None else search_term
        self.terms = registry.parse(db, term)
        self.search = (
            None if self.terms.empty
            else self.backend.match_condition(self.terms, include_barcode=bool(query.include_unpublished))
        )
        self.attributes = resolve_attribute_filters(db, query)
        self.conditions = filter_conditions(query, search=self.search, attributes=self.attributes)

    def where(self, statement: Select, exclude: Sequence[str] = ()) -> Select:
        return _where(statement, self.conditions, exclude)


def _apply_filters(statement: Select, query: ProductQuery) -> Select:
    """Every filter, as a WHERE clause (without synonyms or attributes, which need the database)."""
    from app.services.search import registry

    terms = registry.parse(None, query.search)
    search = None if terms.empty else registry.backend().match_condition(terms)
    return _where(statement, filter_conditions(query, search=search))


def _search_condition(term: str):
    """The free-text condition for `term` (every word must match something); None for a blank term."""
    from app.services.search import registry

    terms = registry.parse(None, term)
    return None if terms.empty else registry.backend().match_condition(terms)


# ------------------------------------------------------------------- sorting

ADMIN_SORTS = ("name-asc", "name-desc", "stock-asc", "stock-desc", "updated", "category", "status")


def _apply_sort(statement: Select, sort: str, prepared: Optional[Prepared] = None) -> Select:
    """
    Ordering.

    Every option ends with `Product.id` so the order is *total*. Without it two
    products with the same price could swap places between page one and page
    two, and one of them would appear twice while the other vanished.
    """
    recommended = (
        Product.is_featured.desc(),
        Product.is_best_seller.desc(),
        Product.is_trending.desc(),
        Product.rating.desc(),
    )
    orderings = {
        "newest": (Product.created_at.desc(),),
        "oldest": (Product.created_at.asc(),),
        "price-asc": (Product.price.asc(),),
        "price-desc": (Product.price.desc(),),
        "discount": (Product.discount.desc(),),
        "rating": (Product.rating.desc(), Product.review_count.desc()),
        "popular": (Product.review_count.desc(), Product.rating.desc()),
        # "Recommended" is merchandising, not a measurement: what the shop
        # wants seen first, then what sells.
        "recommended": recommended,
        # In stock first, then the merchandising order.
        "availability": (case((_available() > 0, 1), else_=0).desc(), *recommended),
        # Portal-only orders for the product table's columns.
        "name-asc": (Product.name.asc(),),
        "name-desc": (Product.name.desc(),),
        "stock-asc": (_available().asc(),),
        "stock-desc": (_available().desc(),),
        "updated": (Product.updated_at.desc(),),
        "category": (Product.category_id.asc(), Product.name.asc()),
        "status": (Product.status.asc(), Product.name.asc()),
    }

    if sort == "best-selling":
        from app.models import ProductSearchIndex

        statement = statement.outerjoin(ProductSearchIndex, ProductSearchIndex.product_id == Product.id)
        order = (func.coalesce(ProductSearchIndex.units_sold, 0).desc(), Product.review_count.desc(),
                 Product.rating.desc())
    elif sort == "relevance":
        if prepared is not None and not prepared.terms.empty:
            order = (prepared.backend.relevance(prepared.terms).desc(), *recommended)
        else:
            order = recommended
    else:
        order = orderings.get(sort, recommended)

    return statement.order_by(*order, Product.id.asc())


def count_products(db: Session, prepared: "Prepared", exclude: Sequence[str] = ()) -> int:
    return db.execute(prepared.where(select(func.count(Product.id)), exclude)).scalar_one()


def query_products(db: Session, query: ProductQuery, *, prepared: Optional["Prepared"] = None,
                   sort: Optional[str] = None) -> Tuple[List[Product], int]:
    """A page of products, and how many there are in total."""
    prepared = prepared or Prepared(db, query)
    total = count_products(db, prepared)

    statement = _apply_sort(_with_relations(prepared.where(select(Product))), sort or query.sort, prepared)
    statement = statement.offset((query.page - 1) * query.page_size).limit(query.page_size)

    items = db.execute(statement).unique().scalars().all()
    return list(items), total


ADMIN_STATUSES = ("active", "draft", "out-of-stock", "archived")


def status_counts(db: Session, prepared: "Prepared") -> dict:
    """The portal's status tabs: products per status with every filter but the status applied."""
    rows = dict(db.execute(prepared.where(
        select(Product.status, func.count(Product.id)).group_by(Product.status), ("status",))).all())
    counts = {status: int(rows.get(status, 0)) for status in ADMIN_STATUSES}
    counts["all"] = sum(int(v) for v in rows.values())
    return counts


def filter_options(db: Session) -> dict:
    """The categories and brands the portal's dropdowns offer (every product, any status)."""
    categories = db.execute(
        select(Category.slug, Category.name).order_by(Category.display_order, Category.name)
    ).all()
    brands = db.execute(select(Product.brand).group_by(Product.brand).order_by(Product.brand)).scalars().all()
    return {"categories": [{"value": slug, "label": name} for slug, name in categories],
            "brands": [brand for brand in brands if brand]}


def term_matches_anything(db: Session, query: ProductQuery, term: str) -> bool:
    """Does `term` alone (in the shop's published scope, or the portal's) match at least one product?"""
    from app.services.search import registry

    terms = registry.parse(db, term)
    if terms.empty:
        return True
    condition = registry.backend().match_condition(terms, include_barcode=bool(query.include_unpublished))
    statement = select(Product.id).where(condition)
    status = _status_condition(query)
    if status is not None:
        statement = statement.where(status)
    return db.execute(statement.limit(1)).first() is not None


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


def get_by_identifier(
    db: Session, identifier: str, *, published_only: bool = True
) -> Optional[Product]:
    """
    Resolve `PRD001` or `wool-blend-overcoat`, whichever was asked for.

    Both are natural keys for the same row, so both belong on the same route —
    the same reasoning as categories and orders, which each answer to an id or
    to the reference a person actually has to hand. Id first: it is the
    canonical one, and a slug cannot collide with it because slugs are
    lower-case and ids are not.
    """
    statement = _with_relations(
        select(Product).where((Product.id == identifier) | (Product.slug == identifier))
    )
    if published_only:
        statement = statement.where(Product.status.in_(PUBLISHED_STATUSES))

    rows = db.execute(statement).unique().scalars().all()
    if not rows:
        return None

    # An exact id match wins, in the pathological case that a slug equals one.
    return next((row for row in rows if row.id == identifier), rows[0])


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


PRICE_BUCKETS = (
    (0, 500, "Under ₹500"),
    (500, 1000, "₹500 – ₹1,000"),
    (1000, 2000, "₹1,000 – ₹2,000"),
    (2000, 5000, "₹2,000 – ₹5,000"),
    (5000, None, "Over ₹5,000"),
)
RATING_BUCKETS = (4, 3)
DISCOUNT_BUCKETS = (10, 20, 30, 40, 50)


def build_facets(db: Session, query: ProductQuery, *, prepared: Optional[Prepared] = None) -> dict:
    """
    Filter options with counts.

    **Disjunctive**: each dimension is counted with every *other* filter
    applied but not its own, so ticking one brand doesn't make every other
    brand read zero, while ticking a size still narrows the brand counts. One
    grouped query per dimension; nothing but the counts comes back.

    The price range is counted over the *scope* (term, category, subcategory,
    collection) so the slider's bounds don't move while filters are ticked.
    """
    prepared = prepared or Prepared(db, query)

    def rows(statement, exclude):
        return db.execute(prepared.where(statement, exclude)).all()

    category_rows = rows(
        select(Category.slug, Category.name, func.count(Product.id))
        .join(Category, Category.id == Product.category_id)
        .group_by(Category.slug, Category.name).order_by(Category.name.asc()),
        ("category",),
    )
    subcategory_rows = rows(
        select(Product.subcategory, Category.slug, func.count(Product.id))
        .join(Category, Category.id == Product.category_id)
        .group_by(Product.subcategory, Category.slug).order_by(Product.subcategory.asc()),
        ("subcategory",),
    )
    brand_rows = rows(
        select(Product.brand, func.count(Product.id)).group_by(Product.brand).order_by(Product.brand.asc()),
        ("brand",),
    )
    size_rows = rows(
        select(ProductSize.label, func.count(distinct(Product.id)))
        .join(ProductSize, ProductSize.product_id == Product.id)
        .group_by(ProductSize.label).order_by(ProductSize.label.asc()),
        ("size",),
    )
    color_rows = rows(
        select(ProductColor.name, func.max(ProductColor.hex), func.count(distinct(Product.id)))
        .join(ProductColor, ProductColor.product_id == Product.id)
        .group_by(ProductColor.name).order_by(ProductColor.name.asc()),
        ("color",),
    )

    def bucket(condition):
        return func.coalesce(func.sum(case((condition, 1), else_=0)), 0)

    price_counts = rows(select(*[
        bucket(and_(Product.price >= low, Product.price < high) if high is not None else Product.price >= low)
        for low, high, _label in PRICE_BUCKETS
    ]).select_from(Product), ("price",))[0]
    rating_counts = rows(select(*[bucket(Product.rating >= value) for value in RATING_BUCKETS])
                         .select_from(Product), ("rating",))[0]
    discount_counts = rows(select(*[bucket(Product.discount >= value) for value in DISCOUNT_BUCKETS])
                           .select_from(Product), ("discount",))[0]
    in_stock, out_of_stock = rows(select(bucket(_available() > 0), bucket(_available() <= 0)).select_from(Product),
                                  ("availability",))[0]

    # The price range: the scope only.
    scope = ProductQuery(search=query.search, category=query.category, subcategory=query.subcategory,
                         collection=query.collection, include_unpublished=query.include_unpublished,
                         status=query.status)
    scope_conditions = filter_conditions(scope, search=prepared.search)
    price_row = db.execute(_where(select(func.min(Product.price), func.max(Product.price)), scope_conditions)).one()

    return {
        "categories": [{"value": slug, "label": name, "count": count} for slug, name, count in category_rows],
        "subcategories": [{"value": value, "label": value, "count": count, "parent": parent}
                          for value, parent, count in subcategory_rows if value],
        "brands": [{"value": v, "label": v, "count": c} for v, c in brand_rows if v],
        "sizes": [{"value": v, "label": v, "count": c} for v, c in size_rows if v],
        "colors": [{"value": v, "label": v, "count": c, "hex": h} for v, h, c in color_rows if v],
        "price_range": {"min": float(price_row[0] or 0), "max": float(price_row[1] or 0)},
        "price_buckets": [{"min": low, "max": high, "label": label, "count": int(count or 0)}
                          for (low, high, label), count in zip(PRICE_BUCKETS, price_counts)],
        "ratings": [{"value": str(value), "label": f"{value}★ & above", "count": int(count or 0)}
                    for value, count in zip(RATING_BUCKETS, rating_counts)],
        "discounts": [{"value": str(value), "label": f"{value}% or more", "count": int(count or 0)}
                      for value, count in zip(DISCOUNT_BUCKETS, discount_counts)],
        "availability": {"in_stock": int(in_stock or 0), "out_of_stock": int(out_of_stock or 0)},
        "attributes": _attribute_facets(db, prepared),
    }


def _attribute_facets(db: Session, prepared: Prepared) -> List[dict]:
    """
    Every active, filterable attribute with values in the result set.

    The attributes nobody has filtered on share one grouped query (all filters
    applied); each filtered attribute gets its own, without its own filter.
    """
    from app.models import ProductAttribute, ProductAttributeValue as Value

    attributes = list(db.execute(
        select(ProductAttribute).where(ProductAttribute.status == "active", ProductAttribute.filterable.is_(True))
        .order_by(ProductAttribute.position, ProductAttribute.label, ProductAttribute.id)
    ).scalars())
    if not attributes:
        return []
    filtered = {attribute.code for attribute, _ in prepared.attributes}

    def grouped(attribute_ids, exclude):
        options = db.execute(prepared.where(
            select(Value.attribute_id, Value.value_normalized, func.count(distinct(Product.id)))
            .select_from(Product)
            .join(Value, Value.product_id == Product.id)
            .where(Value.attribute_id.in_(attribute_ids))
            .group_by(Value.attribute_id, Value.value_normalized), exclude)).all()
        ranges = db.execute(prepared.where(
            select(Value.attribute_id, func.min(Value.value_number), func.max(Value.value_number))
            .select_from(Product)
            .join(Value, Value.product_id == Product.id)
            .where(Value.attribute_id.in_(attribute_ids), Value.value_number.is_not(None))
            .group_by(Value.attribute_id), exclude)).all()
        return options, ranges

    counts: dict = {}
    bounds: dict = {}
    shared = [a.id for a in attributes if a.code not in filtered]
    batches = [(shared, ())] if shared else []
    batches += [([a.id], (ATTRIBUTE_DIMENSION + a.code,)) for a in attributes if a.code in filtered]
    for ids, exclude in batches:
        options, ranges = grouped(ids, exclude)
        for attribute_id, value, count in options:
            counts.setdefault(attribute_id, {})[value] = count
        for attribute_id, low, high in ranges:
            bounds[attribute_id] = (low, high)

    facets = []
    for attribute in attributes:
        if attribute.type == "number":
            if attribute.id not in bounds:
                continue
            low, high = bounds[attribute.id]
            facets.append({"code": attribute.code, "label": attribute.label, "type": attribute.type,
                           "unit": attribute.unit, "options": [],
                           "range": {"min": float(low), "max": float(high)}})
            continue
        found = counts.get(attribute.id, {})
        if attribute.type == "boolean":
            labels = [("true", "Yes"), ("false", "No")]
        else:
            labels = [(option.value, option.label) for option in attribute.options]
        options = [{"value": value, "label": label, "count": found[value]} for value, label in labels if value in found]
        if options:
            facets.append({"code": attribute.code, "label": attribute.label, "type": attribute.type,
                           "unit": attribute.unit, "options": options, "range": None})
    return facets


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
