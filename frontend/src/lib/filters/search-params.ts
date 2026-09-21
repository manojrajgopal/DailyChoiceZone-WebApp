import type { ProductQuery, SortOption } from "@/types/product";

import { DEFAULT_PAGE_SIZE } from "./apply-filters";

/**
 * The bridge between the URL and a `ProductQuery`.
 *
 * Filters live in the URL rather than in component state, which buys three
 * things for free: shareable filtered links, a working browser back button,
 * and server-rendered listing pages. Both directions live here so they cannot
 * drift apart.
 */

/** What Next hands a server component, plus what `useSearchParams` returns. */
export type ReadableParams =
  | URLSearchParams
  | Record<string, string | string[] | undefined>;

const VALID_SORTS: SortOption[] = [
  "recommended",
  "newest",
  "price-asc",
  "price-desc",
  "rating",
  "popular",
  "discount",
];

function getAll(params: ReadableParams, key: string): string[] {
  if (params instanceof URLSearchParams) {
    return params.getAll(key).flatMap((value) => value.split(",")).filter(Boolean);
  }
  const raw = params[key];
  if (raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.flatMap((value) => value.split(",")).filter(Boolean);
}

function getOne(params: ReadableParams, key: string): string | undefined {
  const all = getAll(params, key);
  return all[0];
}

function getNumber(params: ReadableParams, key: string): number | undefined {
  const raw = getOne(params, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  // Reject junk rather than letting NaN poison a comparison downstream.
  return Number.isFinite(value) ? value : undefined;
}

/** Read a `ProductQuery` out of URL parameters, ignoring anything malformed. */
export function parseProductQuery(params: ReadableParams): ProductQuery {
  const sortRaw = getOne(params, "sort");
  const sort = VALID_SORTS.find((option) => option === sortRaw);

  const query: ProductQuery = {
    page: Math.max(1, getNumber(params, "page") ?? 1),
    pageSize: getNumber(params, "pageSize") ?? DEFAULT_PAGE_SIZE,
  };

  if (sort) query.sort = sort;

  const category = getAll(params, "category");
  if (category.length) query.category = category;

  const subcategory = getAll(params, "subcategory");
  if (subcategory.length) query.subcategory = subcategory;

  const brand = getAll(params, "brand");
  if (brand.length) query.brand = brand;

  const size = getAll(params, "size");
  if (size.length) query.size = size;

  const color = getAll(params, "color");
  if (color.length) query.color = color;

  const minPrice = getNumber(params, "minPrice");
  if (minPrice !== undefined) query.minPrice = minPrice;

  const maxPrice = getNumber(params, "maxPrice");
  if (maxPrice !== undefined) query.maxPrice = maxPrice;

  const minRating = getNumber(params, "minRating");
  if (minRating !== undefined) query.minRating = minRating;

  const minDiscount = getNumber(params, "minDiscount");
  if (minDiscount !== undefined) query.minDiscount = minDiscount;

  if (getOne(params, "inStock") === "1") query.inStockOnly = true;

  const q = getOne(params, "q");
  if (q) query.query = q;

  return query;
}

/**
 * Serialise a query back to a URL string.
 *
 * Defaults are omitted so the common case produces a clean `/shop` rather than
 * `/shop?page=1&pageSize=24&sort=recommended`.
 */
export function buildQueryString(query: ProductQuery): string {
  const params = new URLSearchParams();

  const addList = (key: string, values: string[] | undefined) => {
    if (values && values.length > 0) params.set(key, values.join(","));
  };

  addList("category", query.category);
  addList("subcategory", query.subcategory);
  addList("brand", query.brand);
  addList("size", query.size);
  addList("color", query.color);

  if (typeof query.minPrice === "number") params.set("minPrice", String(query.minPrice));
  if (typeof query.maxPrice === "number") params.set("maxPrice", String(query.maxPrice));
  if (typeof query.minRating === "number") params.set("minRating", String(query.minRating));
  if (typeof query.minDiscount === "number") params.set("minDiscount", String(query.minDiscount));
  if (query.inStockOnly) params.set("inStock", "1");
  if (query.query) params.set("q", query.query);
  if (query.sort && query.sort !== "recommended") params.set("sort", query.sort);
  if (query.page && query.page > 1) params.set("page", String(query.page));
  if (query.pageSize && query.pageSize !== DEFAULT_PAGE_SIZE) {
    params.set("pageSize", String(query.pageSize));
  }

  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

/**
 * Toggle one value inside a multi-select filter and reset to page 1.
 *
 * Returning to page 1 matters: changing a filter while on page 4 of the old
 * result set would otherwise land the shopper on an empty page.
 */
export function toggleFilterValue(
  query: ProductQuery,
  key: "category" | "subcategory" | "brand" | "size" | "color",
  value: string,
): ProductQuery {
  const current = query[key] ?? [];
  const exists = current.some((entry) => entry.toLowerCase() === value.toLowerCase());
  const next = exists
    ? current.filter((entry) => entry.toLowerCase() !== value.toLowerCase())
    : [...current, value];

  const updated: ProductQuery = { ...query, page: 1 };
  if (next.length > 0) {
    updated[key] = next;
  } else {
    delete updated[key];
  }
  return updated;
}

/** Drop every filter but keep sort, page size and the search term. */
export function clearFilters(query: ProductQuery): ProductQuery {
  const cleared: ProductQuery = { page: 1, pageSize: query.pageSize };
  if (query.sort) cleared.sort = query.sort;
  if (query.query) cleared.query = query.query;
  return cleared;
}
