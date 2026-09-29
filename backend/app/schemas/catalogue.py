"""Products, categories and collections — request and response shapes."""

from __future__ import annotations

from datetime import datetime
from typing import List, Literal, Optional

from pydantic import Field, field_validator

from app.models.catalogue import images_for
from app.schemas.base import CamelModel

# ---------------------------------------------------------------- pieces


class ColorOut(CamelModel):
    name: str
    hex: str
    # This colour's own photographs. Empty when the colour has none and the
    # product's shared `images` stand for it.
    images: List[str] = []


class SpecificationOut(CamelModel):
    label: str
    value: str


# --------------------------------------------------------------- products


class ProductOut(CamelModel):
    """
    A product as the storefront renders it.

    Deliberately the same shape as the frontend's `Product` type, field for
    field, so the adapter is a fetch with no mapping in between.
    """

    id: str
    slug: str
    name: str
    brand: str
    category: str
    subcategory: str
    price: float
    original_price: float
    discount: int
    currency: str
    rating: float
    review_count: int
    images: List[str]
    colors: List[ColorOut]
    sizes: List[str]
    description: str
    material: str
    care: str
    tags: List[str]
    specifications: List[SpecificationOut]
    is_new: bool
    is_trending: bool
    is_best_seller: bool
    is_featured: bool
    stock: int
    sku: str

    @classmethod
    def from_model(cls, product) -> "ProductOut":
        return cls(
            id=product.id,
            slug=product.slug,
            name=product.name,
            brand=product.brand,
            # The frontend keys categories by slug, not id — its URLs are
            # /category/women. The id is what the admin works in.
            category=product.category.slug if product.category else "",
            subcategory=product.subcategory,
            price=float(product.price),
            original_price=float(product.original_price),
            discount=product.discount,
            currency=product.currency,
            rating=float(product.rating),
            review_count=product.review_count,
            # The shared images — or, for a product photographed only per
            # colour, the first colour's — so anything that reads `images[0]`
            # (a wishlist row, an old client) still has a picture.
            images=images_for(product),
            colors=[
                ColorOut(
                    name=c.name,
                    hex=c.hex,
                    images=[image.url for image in product.images if image.color == c.name],
                )
                for c in product.colors
            ],
            sizes=[size.label for size in product.sizes],
            description=product.description,
            material=product.material,
            care=product.care,
            tags=[tag.tag for tag in product.tags],
            specifications=[
                SpecificationOut(label=s.label, value=s.value) for s in product.specifications
            ],
            is_new=product.is_new,
            is_trending=product.is_trending,
            is_best_seller=product.is_best_seller,
            is_featured=product.is_featured,
            stock=product.stock,
            sku=product.sku,
        )


class SeoOut(CamelModel):
    meta_title: str
    meta_description: str


class AdminProductOut(ProductOut):
    """
    The same product, plus the fields only the portal sees.

    Inheritance rather than a parallel type: there is one product record, and
    the customer view is a projection of it. Two independent shapes is exactly
    the divergence the shared model exists to prevent.
    """

    status: str
    low_stock_threshold: int
    reserved_stock: int
    barcode: str
    tax_rate_percent: float
    created_at: datetime
    updated_at: datetime
    updated_by: Optional[str] = None
    seo: SeoOut
    # Only the images shared by every colour. `images` falls back to the first
    # colour's photographs when there are none, which is right for a shop
    # window and wrong for an edit form: saving it would duplicate them.
    shared_images: List[str] = []

    @classmethod
    def from_model(cls, product) -> "AdminProductOut":
        base = ProductOut.from_model(product).model_dump(by_alias=False)
        return cls(
            **base,
            status=product.status,
            low_stock_threshold=product.low_stock_threshold,
            reserved_stock=product.reserved_stock,
            barcode=product.barcode,
            tax_rate_percent=float(product.tax_rate_percent),
            created_at=product.created_at,
            updated_at=product.updated_at,
            updated_by=product.updated_by,
            shared_images=[image.url for image in product.images if not image.color],
            seo=SeoOut(
                meta_title=product.meta_title,
                meta_description=product.meta_description,
            ),
        )


class ColorIn(CamelModel):
    name: str = Field(min_length=1, max_length=60)
    hex: str = "#000000"
    # The photographs of the product in this colour, in display order.
    images: List[str] = Field(default_factory=list, max_length=12)

    @field_validator("images")
    @classmethod
    def _image_urls(cls, value: List[str]) -> List[str]:
        cleaned = []
        for url in value:
            url = url.strip()
            if not url:
                continue
            if len(url) > 500:
                raise ValueError("An image address is too long.")
            if not (url.startswith("https://") or url.startswith("http://") or url.startswith("/uploads/")):
                raise ValueError("Images must be web addresses or uploaded files.")
            cleaned.append(url)
        return list(dict.fromkeys(cleaned))


class SpecificationIn(CamelModel):
    label: str
    value: str


class ProductWrite(CamelModel):
    """
    Creating or editing a product.

    Every field is optional on update: `PUT /api/products/{id}` applies
    whatever the payload contains, which is what keeps one endpoint able to
    change a price, a category or a set of images without three endpoints to
    do it.

    Creation validates the required subset in the service, where the rule
    belongs — a schema that made them required here could not be reused for
    updates.
    """

    name: Optional[str] = None
    slug: Optional[str] = None
    sku: Optional[str] = None
    brand: Optional[str] = None
    category: Optional[str] = None
    subcategory: Optional[str] = None
    price: Optional[float] = Field(default=None, ge=0)
    original_price: Optional[float] = Field(default=None, ge=0)
    currency: Optional[str] = None
    description: Optional[str] = None
    material: Optional[str] = None
    care: Optional[str] = None
    images: Optional[List[str]] = None
    colors: Optional[List[ColorIn]] = None
    sizes: Optional[List[str]] = None
    tags: Optional[List[str]] = None
    specifications: Optional[List[SpecificationIn]] = None
    is_new: Optional[bool] = None
    is_trending: Optional[bool] = None
    is_best_seller: Optional[bool] = None
    is_featured: Optional[bool] = None
    stock: Optional[int] = Field(default=None, ge=0)
    status: Optional[Literal["active", "draft", "out-of-stock", "archived"]] = None
    low_stock_threshold: Optional[int] = Field(default=None, ge=0)
    reserved_stock: Optional[int] = Field(default=None, ge=0)
    barcode: Optional[str] = None
    tax_rate_percent: Optional[float] = Field(default=None, ge=0, le=100)
    meta_title: Optional[str] = None
    meta_description: Optional[str] = None


# ------------------------------------------------------------- categories


class CategoryGroupItem(CamelModel):
    slug: str
    name: str


class CategoryGroup(CamelModel):
    name: str
    items: List[CategoryGroupItem]


class CategoryOut(CamelModel):
    id: str
    slug: str
    name: str
    description: str
    image: str
    order: int
    featured: bool
    groups: List[CategoryGroup] = []
    # Populated on list endpoints so the portal can show it without a second call.
    product_count: Optional[int] = None

    @classmethod
    def from_model(cls, category, product_count: Optional[int] = None) -> "CategoryOut":
        return cls(
            id=category.id,
            slug=category.slug,
            name=category.name,
            description=category.description,
            image=category.image,
            order=category.display_order,
            featured=category.featured,
            groups=category.groups or [],
            product_count=product_count,
        )


class CategoryWrite(CamelModel):
    name: Optional[str] = None
    slug: Optional[str] = None
    description: Optional[str] = None
    image: Optional[str] = None
    order: Optional[int] = None
    featured: Optional[bool] = None
    groups: Optional[List[CategoryGroup]] = None


# ------------------------------------------------------------ collections


class CollectionOut(CamelModel):
    id: str
    slug: str
    name: str
    tagline: str
    description: str
    image: str
    featured: bool
    product_ids: List[str]

    @classmethod
    def from_model(cls, collection) -> "CollectionOut":
        return cls(
            id=collection.id,
            slug=collection.slug,
            name=collection.name,
            tagline=collection.tagline,
            description=collection.description,
            image=collection.image,
            featured=collection.featured,
            product_ids=[item.product_id for item in collection.items],
        )


class CollectionWrite(CamelModel):
    name: Optional[str] = None
    slug: Optional[str] = None
    tagline: Optional[str] = None
    description: Optional[str] = None
    image: Optional[str] = None
    featured: Optional[bool] = None
    product_ids: Optional[List[str]] = None


# ----------------------------------------------------------------- facets


class FacetValue(CamelModel):
    value: str
    label: str
    count: int


class PriceRange(CamelModel):
    min: float
    max: float


class ProductFacets(CamelModel):
    """The filter options for a result set, with counts."""

    categories: List[FacetValue]
    subcategories: List[FacetValue]
    brands: List[FacetValue]
    sizes: List[FacetValue]
    colors: List[FacetValue]
    price_range: PriceRange


# ---------------------------------------------------------------- queries


SortOption = Literal[
    "recommended", "newest", "price-asc", "price-desc", "rating", "popular", "discount"
]
"""
The orders a listing can be asked for.

Hyphenated because these appear in the storefront's own URLs — `?sort=price-asc`
is a link somebody can copy — and an API that spelt them differently would mean
a translation layer whose only job is to be got wrong once.
"""


class ProductQuery(CamelModel):
    """
    One flexible query, rather than an endpoint per flag.

    `isNew`, `isTrending`, `isBestSeller` and `isFeatured` are filters here for
    the same reason category is: they narrow a list. Four endpoints that each
    return products would be four things to keep consistent.
    """

    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=24, ge=1, le=100)
    search: Optional[str] = None
    category: Optional[str] = None
    subcategory: Optional[str] = None
    collection: Optional[str] = None
    brands: Optional[List[str]] = None
    sizes: Optional[List[str]] = None
    colors: Optional[List[str]] = None
    min_price: Optional[float] = None
    max_price: Optional[float] = None
    min_rating: Optional[float] = None
    min_discount: Optional[int] = None
    in_stock_only: bool = False
    is_new: Optional[bool] = None
    is_trending: Optional[bool] = None
    is_best_seller: Optional[bool] = None
    is_featured: Optional[bool] = None
    sort: SortOption = "recommended"
    # Admin-only: include drafts and archived products.
    include_unpublished: bool = False
    status: Optional[str] = None

    @field_validator("brands", "sizes", "colors", mode="before")
    @classmethod
    def _split_csv(cls, value):
        """Accept `brands=Nyra,Stride` as well as repeated parameters."""
        if isinstance(value, str):
            return [part.strip() for part in value.split(",") if part.strip()]
        return value
