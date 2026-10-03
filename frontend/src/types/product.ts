/**
 * The catalogue domain model.
 *
 * These types are the contract between the data layer and the UI. Components
 * depend on these, never on the shape of `products.json`. When a real API
 * arrives, its adapter maps the response into these types and every component
 * keeps working untouched.
 */

export type CurrencyCode = "INR";

export interface ProductColor {
  /** Human-readable name shown in the UI, e.g. "Terracotta". */
  name: string;
  /** Any CSS colour — used for the swatch. */
  hex: string;
  /**
   * Photographs of the product in this colour. Empty when the colour has none
   * of its own and the product's shared `images` stand for it — see
   * `lib/products/colourImages`.
   */
  images?: string[];
}

export interface ProductSpecification {
  label: string;
  value: string;
}

/** A live flash sale on a product: `price` is then the sale price. Set by the server. */
export interface ProductFlashSale {
  saleId: number;
  itemId: number;
  name: string;
  price: number;
  regularPrice: number;
  startsAt: string;
  endsAt: string;
  stockLimit: number | null;
  remaining: number | null;
  perCustomerLimit: number | null;
  allowCoupons: boolean;
}

export interface Product {
  flashSale?: ProductFlashSale | null;
  id: string;
  slug: string;
  name: string;
  brand: string;
  /** Category slug, e.g. "women". Resolve to a Category via categoryService. */
  category: string;
  /** Subcategory slug, e.g. "shirts". */
  subcategory: string;
  price: number;
  /** Pre-discount price. Equal to price when the item is not discounted. */
  originalPrice: number;
  /** Whole percent off, precomputed by the data layer. */
  discount: number;
  currency: CurrencyCode;
  rating: number;
  reviewCount: number;
  images: string[];
  colors: ProductColor[];
  /** Empty for products where size is meaningless, e.g. most home goods. */
  sizes: string[];
  description: string;
  material: string;
  /** Free-form keywords. Powers search and the recommendation heuristic. */
  tags: string[];
  isNew: boolean;
  isTrending: boolean;
  isBestSeller: boolean;
  isFeatured: boolean;
  /** Whether it can be sent back after delivery for a refund. */
  isReturnable?: boolean;
  /** Whether it can be exchanged for the same item after delivery. */
  isReplaceable?: boolean;
  /** Units available. Zero means out of stock. */
  stock: number;
  sku: string;
  care: string;
  specifications: ProductSpecification[];
}

/**
 * The sort orders the listing toolbar offers.
 *
 * The labels live in the store's content document — this union is what the
 * query string and the API agree on.
 */
export type SortOption =
  | "recommended"
  | "newest"
  | "price-asc"
  | "price-desc"
  | "rating"
  | "popular"
  | "discount"
  /* Search & filters: `relevance` is the default once there is a search term. */
  | "relevance"
  | "oldest"
  | "best-selling"
  | "availability";

/** `availability` filter values (`?availability=`). */
export type AvailabilityFilter = "in-stock" | "out-of-stock";

/** A number attribute's range filter (`attr.<code>.min` / `attr.<code>.max`). */
export interface AttributeRange {
  min?: number;
  max?: number;
}

/**
 * Every filter a listing page can apply.
 *
 * All fields are optional, so a partial object is always a valid query — which
 * is what makes round-tripping filters through the URL simple.
 */
export interface ProductFilters {
  category?: string[];
  subcategory?: string[];
  brand?: string[];
  size?: string[];
  color?: string[];
  minPrice?: number;
  maxPrice?: number;
  /** Minimum star rating, e.g. 4 for "4 stars and above". */
  minRating?: number;
  /** Minimum discount percent, e.g. 30 for "30% and above". */
  minDiscount?: number;
  /** When true, hide out-of-stock products. */
  inStockOnly?: boolean;
  /** Only products in stock, or only those out of stock. */
  availability?: AvailabilityFilter;
  /**
   * Dynamic attribute filters, by attribute code: option values for select /
   * multi attributes, `"true"` / `"false"` for boolean ones (`attr.<code>=a,b`).
   */
  attributes?: Record<string, string[]>;
  /** Number attribute ranges, by attribute code. */
  attributeRanges?: Record<string, AttributeRange>;
  /** Free-text search term. */
  query?: string;
  /** Narrow to one collection, by slug or id. */
  collection?: string;

  /*
   * Merchandising flags.
   *
   * Filters like any other, because that is what they are: a rail is a query
   * with a flag set. They stay out of the URL — `useProductQuery` never writes
   * them — but they belong on the query object so the *server* can answer
   * "the new arrivals" instead of the browser fetching 250 products and
   * throwing most of them away.
   */
  isNew?: boolean;
  isTrending?: boolean;
  isBestSeller?: boolean;
  isFeatured?: boolean;
}

/** A listing request: what to filter by, how to sort, and which page. */
export interface ProductQuery extends ProductFilters {
  sort?: SortOption;
  page?: number;
  pageSize?: number;
}

/**
 * A page of results.
 *
 * Deliberately shaped like a REST paginated response, so the mock adapter and
 * a future HTTP adapter can return the identical thing.
 */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** Set on a product listing that carried a search term. */
  search?: SearchMeta;
}

/** What the listing says about a search: the term, a typo correction, the log id. */
export interface SearchMeta {
  term: string;
  /** The corrected term when the original found nothing and this did. */
  correctedTerm: string | null;
  /** Set on page 1 of a search; what result clicks are recorded against. */
  searchId: number | null;
}

/** One selectable value in a filter panel, with its result count. */
export interface FacetOption {
  value: string;
  label: string;
  count: number;
  /** Subcategories: the category slug they belong to. */
  parent?: string | null;
  /** Colours: the swatch colour, when known. */
  hex?: string | null;
}

/** A preset price band; `max` is null for the open-ended top band. */
export interface PriceBucket {
  min: number;
  max: number | null;
  label: string;
  count: number;
}

export type AttributeType = "select" | "multi" | "number" | "boolean";

/** One dynamic attribute's filter options (or range, for a number attribute). */
export interface AttributeFacet {
  code: string;
  label: string;
  type: AttributeType;
  unit: string;
  options: FacetOption[];
  range: { min: number; max: number } | null;
}

/** The option lists a filter panel renders, derived from the catalogue. */
export interface ProductFacets {
  categories: FacetOption[];
  subcategories: FacetOption[];
  brands: FacetOption[];
  sizes: FacetOption[];
  colors: FacetOption[];
  priceRange: { min: number; max: number };
  /*
   * Search & filters. Optional so a facet set computed locally (see
   * `buildFacets`) is still valid; the API always sends them.
   */
  priceBuckets?: PriceBucket[];
  ratings?: FacetOption[];
  discounts?: FacetOption[];
  availability?: { inStock: number; outOfStock: number };
  attributes?: AttributeFacet[];
}

/* ------------------------------------------------------------- suggestions */

/** One product in the search-as-you-type dropdown (a light payload, not a `Product`). */
export interface SuggestedProduct {
  id: string;
  slug: string;
  name: string;
  brand: string;
  /** The first image's URL, or "" when the product has none. */
  image: string;
  /** Rupees, a live flash sale included — as the product card shows it. */
  price: number;
  originalPrice: number;
}

/** `GET /api/search/suggest`. */
export interface SearchSuggestions {
  /** The term as the server normalised it. */
  query: string;
  /** Set when nothing matched the typed term and these suggestions are for the correction. */
  correctedTerm: string | null;
  products: SuggestedProduct[];
  categories: { slug: string; name: string }[];
  brands: { value: string; label: string }[];
  /** The store's popular searches (always filled, even for a blank term). */
  popular: string[];
}
