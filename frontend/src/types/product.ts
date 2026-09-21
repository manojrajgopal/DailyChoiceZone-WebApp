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
}

export interface ProductSpecification {
  label: string;
  value: string;
}

export interface Product {
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
  /** Units available. Zero means out of stock. */
  stock: number;
  sku: string;
  care: string;
  specifications: ProductSpecification[];
}

/** The sort orders offered in the listing toolbar. */
export type SortOption =
  | "recommended"
  | "newest"
  | "price-asc"
  | "price-desc"
  | "rating"
  | "popular"
  | "discount";

export const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "recommended", label: "Recommended" },
  { value: "newest", label: "Newest first" },
  { value: "price-asc", label: "Price: low to high" },
  { value: "price-desc", label: "Price: high to low" },
  { value: "rating", label: "Customer rating" },
  { value: "popular", label: "Most popular" },
  { value: "discount", label: "Biggest discount" },
];

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
  /** Free-text search term. */
  query?: string;
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
}

/** One selectable value in a filter panel, with its result count. */
export interface FacetOption {
  value: string;
  label: string;
  count: number;
}

/** The option lists a filter panel renders, derived from the catalogue. */
export interface ProductFacets {
  categories: FacetOption[];
  subcategories: FacetOption[];
  brands: FacetOption[];
  sizes: FacetOption[];
  colors: FacetOption[];
  priceRange: { min: number; max: number };
}
