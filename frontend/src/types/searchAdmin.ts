/**
 * Search & filters, admin side: the server-paged product list, product
 * attributes, and search analytics + settings.
 * Contract: docs/search-and-filters.md §6.
 */
import type { AdminProduct, ProductStatus } from "@/types/admin";

/* ------------------------------------------------------- admin product list */

export type AdminProductSort =
  | "relevance"
  | "recommended"
  | "newest"
  | "oldest"
  | "price-asc"
  | "price-desc"
  | "rating"
  | "popular"
  | "best-selling"
  | "discount"
  | "availability"
  | "name-asc"
  | "name-desc"
  | "stock-asc"
  | "stock-desc"
  | "updated"
  | "category"
  | "status";

export type AdminStockFilter = "in-stock" | "low-stock" | "out-of-stock";
export type AdminProductFlag = "isNew" | "isTrending" | "isBestSeller" | "isFeatured";

export interface AdminProductListParams {
  /** A Product ID or SKU, matched exactly (docs/id-lookup.md). */
  q?: string;
  status?: ProductStatus | "all" | "";
  /** One or more category slugs or ids. */
  category?: string | string[];
  brands?: string | string[];
  stock?: AdminStockFilter | "";
  flag?: AdminProductFlag | "";
  sort?: AdminProductSort | "";
  page?: number;
  pageSize?: number;
}

export type AdminProductCounts = Record<ProductStatus | "all", number>;

export interface AdminProductPage {
  items: AdminProduct[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  counts: AdminProductCounts;
  filters: { categories: { value: string; label: string }[]; brands: string[] };
}

/* --------------------------------------------------------------- attributes */

export type AttributeType = "select" | "multi" | "number" | "boolean";
export type AttributeStatus = "active" | "archived";

export interface AttributeOption {
  id: number;
  value: string;
  label: string;
  position: number;
}

export interface ProductAttribute {
  id: number;
  code: string;
  label: string;
  type: AttributeType;
  unit: string;
  filterable: boolean;
  searchable: boolean;
  position: number;
  status: AttributeStatus;
  options: AttributeOption[];
  productCount: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface AttributeInput {
  code?: string;
  label?: string;
  type?: AttributeType;
  unit?: string;
  filterable?: boolean;
  searchable?: boolean;
  position?: number;
  status?: AttributeStatus;
  /** The whole list: with an id = keep/rename, without = add, missing = remove. */
  options?: { id?: number; label: string; value?: string }[];
}

/** A value as the API sends it: option value(s), a number, a boolean, or unset. */
export type AttributeValue = string | string[] | number | boolean | null;

export interface ProductAttributeEntry {
  id: number;
  code: string;
  label: string;
  type: AttributeType;
  unit: string;
  options: AttributeOption[];
  value: AttributeValue;
}

export interface ProductAttributeValues {
  productId: string;
  attributes: ProductAttributeEntry[];
}

/* --------------------------------------------------------- search analytics */

export type SearchRange = "7d" | "30d" | "90d";

export interface SearchAnalytics {
  range: SearchRange;
  from: string;
  to: string;
  /** Rates (`zeroResultRate`, `ctr`, `conversionRate`) are percentages, 0–100. */
  totals: {
    searches: number;
    uniqueTerms: number;
    zeroResultSearches: number;
    zeroResultRate: number;
    clicks: number;
    ctr: number;
    conversions: number;
    conversionRate: number;
  };
  topSearches: { term: string; searches: number; clicks: number; ctr: number; conversions: number; avgResults: number }[];
  zeroResults: { term: string; searches: number; lastSearchedAt: string | null }[];
  /** `change` is a percentage; null when the term is new (no searches the period before). */
  trending: { term: string; searches: number; previous: number; change: number | null }[];
  series: { date: string; searches: number; zeroResults: number; clicks: number }[];
}

export type PopularMode = "curated" | "auto";

export interface SearchSettings {
  popularMode: PopularMode;
  popularSearches: string[];
  autoPopular: string[];
  synonyms: string[][];
  lastRebuildAt: string | null;
  dictionarySize: number;
}

export interface SearchSettingsInput {
  popularMode?: PopularMode;
  popularSearches?: string[];
  synonyms?: string[][];
}

export interface SearchRebuildResult {
  terms: number;
  products: number;
  unitsSold: number;
}
