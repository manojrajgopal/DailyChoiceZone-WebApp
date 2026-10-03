import type { AttributeRange, AvailabilityFilter, ProductQuery, SortOption } from "@/types/product";

import { DEFAULT_PAGE_SIZE } from "./apply-filters";

/**
 * The bridge between the URL and a `ProductQuery`.
 *
 * Filters live in the URL rather than in component state, which buys three
 * things for free: shareable filtered links, a working browser back button,
 * and server-rendered listing pages. Both directions live here so they cannot
 * drift apart.
 *
 * Keys (all backward compatible): `category`, `subcategory`, `brand`, `size`,
 * `color`, `minPrice`, `maxPrice`, `minRating` (also read as `rating`),
 * `minDiscount`, `inStock=1`, `availability`, `q`, `sort`, `page`, `pageSize`,
 * plus `attr.<code>=a,b`, `attr.<code>.min` and `attr.<code>.max`.
 */

/** What Next hands a server component, plus what `useSearchParams` returns. */
export type ReadableParams =
  | URLSearchParams
  | Record<string, string | string[] | undefined>;

export const VALID_SORTS: SortOption[] = [
  "relevance",
  "recommended",
  "newest",
  "oldest",
  "price-asc",
  "price-desc",
  "rating",
  "popular",
  "best-selling",
  "discount",
  "availability",
];

const AVAILABILITY: AvailabilityFilter[] = ["in-stock", "out-of-stock"];

/** An attribute code, as the API defines it: lower-case, starting with a letter. */
const ATTRIBUTE_CODE = /^[a-z][a-z0-9_]{1,39}$/;
const ATTRIBUTE_KEY = /^attr\.([a-z][a-z0-9_]{1,39})(?:\.(min|max))?$/;

/** The default order: relevance once there is a search term, otherwise recommended. */
export function defaultSort(query: Pick<ProductQuery, "query">): SortOption {
  return query.query ? "relevance" : "recommended";
}

function keysOf(params: ReadableParams): string[] {
  if (params instanceof URLSearchParams) return [...new Set(params.keys())];
  return Object.keys(params);
}

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

  // `rating` is an alias; `minRating` wins when both are present.
  const minRating = getNumber(params, "minRating") ?? getNumber(params, "rating");
  if (minRating !== undefined) query.minRating = minRating;

  const minDiscount = getNumber(params, "minDiscount");
  if (minDiscount !== undefined) query.minDiscount = minDiscount;

  if (getOne(params, "inStock") === "1") query.inStockOnly = true;

  const availability = AVAILABILITY.find((value) => value === getOne(params, "availability"));
  if (availability) query.availability = availability;

  const q = getOne(params, "q");
  if (q) query.query = q;

  // Attribute filters, sorted by key so the same filters parse to equal objects.
  const attributes: Record<string, string[]> = {};
  const ranges: Record<string, AttributeRange> = {};
  for (const key of keysOf(params).sort()) {
    const match = ATTRIBUTE_KEY.exec(key);
    if (!match) continue;
    const code = match[1];
    const bound = match[2] as "min" | "max" | undefined;
    if (!code) continue;
    if (bound) {
      const value = getNumber(params, key);
      if (value === undefined) continue;
      ranges[code] = { ...ranges[code], [bound]: value };
    } else {
      const values = [...new Set(getAll(params, key))];
      if (values.length) attributes[code] = values;
    }
  }
  if (Object.keys(attributes).length) query.attributes = attributes;
  if (Object.keys(ranges).length) query.attributeRanges = ranges;

  return query;
}

/**
 * Serialise a query back to a URL string.
 *
 * Defaults are omitted so the common case produces a clean `/shop` rather than
 * `/shop?page=1&pageSize=24&sort=recommended`. The default sort depends on the
 * query: `relevance` with a search term, `recommended` without.
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
  if (query.availability) params.set("availability", query.availability);

  for (const code of Object.keys(query.attributes ?? {}).sort()) {
    if (ATTRIBUTE_CODE.test(code)) addList(`attr.${code}`, query.attributes?.[code]);
  }
  for (const code of Object.keys(query.attributeRanges ?? {}).sort()) {
    const range = query.attributeRanges?.[code];
    if (!range || !ATTRIBUTE_CODE.test(code)) continue;
    if (typeof range.min === "number") params.set(`attr.${code}.min`, String(range.min));
    if (typeof range.max === "number") params.set(`attr.${code}.max`, String(range.max));
  }

  if (query.query) params.set("q", query.query);
  if (query.sort && query.sort !== defaultSort(query)) params.set("sort", query.sort);
  if (query.page && query.page > 1) params.set("page", String(query.page));
  if (query.pageSize && query.pageSize !== DEFAULT_PAGE_SIZE) {
    params.set("pageSize", String(query.pageSize));
  }

  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

/* ------------------------------------------------------------------ updaters */

/*
 * Pure "next query" functions. The listing applies them to the URL (desktop)
 * or to a staged draft (the mobile drawer), so both behave identically. Every
 * one returns to page 1: changing a filter while on page 4 of the old result
 * set would otherwise land the shopper on an empty page.
 */

export type MultiFilterKey = "category" | "subcategory" | "brand" | "size" | "color";

const sameValue = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function toggleIn(list: string[], value: string): string[] {
  return list.some((entry) => sameValue(entry, value))
    ? list.filter((entry) => !sameValue(entry, value))
    : [...list, value];
}

/** Toggle one value inside a multi-select filter and reset to page 1. */
export function toggleFilterValue(
  query: ProductQuery,
  key: MultiFilterKey,
  value: string,
): ProductQuery {
  const next = toggleIn(query[key] ?? [], value);

  const updated: ProductQuery = { ...query, page: 1 };
  if (next.length > 0) {
    updated[key] = next;
  } else {
    delete updated[key];
  }
  return updated;
}

/** Set (or, with `undefined`, clear) either price bound. */
export function withPriceRange(query: ProductQuery, min?: number, max?: number): ProductQuery {
  const next: ProductQuery = { ...query, page: 1 };
  if (typeof min === "number") next.minPrice = min;
  else delete next.minPrice;
  if (typeof max === "number") next.maxPrice = max;
  else delete next.maxPrice;
  return next;
}

/** Passing the already-selected rating clears it, so the control toggles. */
export function withMinRating(query: ProductQuery, rating?: number): ProductQuery {
  const next: ProductQuery = { ...query, page: 1 };
  if (typeof rating === "number" && rating !== query.minRating) next.minRating = rating;
  else delete next.minRating;
  return next;
}

/** Passing the already-selected discount clears it, so the control toggles. */
export function withMinDiscount(query: ProductQuery, discount?: number): ProductQuery {
  const next: ProductQuery = { ...query, page: 1 };
  if (typeof discount === "number" && discount !== query.minDiscount) next.minDiscount = discount;
  else delete next.minDiscount;
  return next;
}

export function withInStockOnly(query: ProductQuery, only: boolean): ProductQuery {
  const next: ProductQuery = { ...query, page: 1 };
  if (only) next.inStockOnly = true;
  else delete next.inStockOnly;
  return next;
}

/**
 * Choose in-stock or out-of-stock; the selected value (or `undefined`) clears.
 *
 * The legacy `inStock=1` flag is dropped either way: the availability choice
 * replaces it, so the two can never disagree.
 */
export function withAvailability(query: ProductQuery, value?: AvailabilityFilter): ProductQuery {
  const current = query.availability ?? (query.inStockOnly ? "in-stock" : undefined);
  const next: ProductQuery = { ...query, page: 1 };
  delete next.inStockOnly;
  if (value && value !== current) next.availability = value;
  else delete next.availability;
  return next;
}

/** Toggle one value of a select / multi / boolean attribute filter. */
export function toggleAttributeValue(query: ProductQuery, code: string, value: string): ProductQuery {
  const attributes = { ...query.attributes };
  const values = toggleIn(attributes[code] ?? [], value);
  if (values.length) attributes[code] = values;
  else delete attributes[code];

  const next: ProductQuery = { ...query, page: 1, attributes };
  if (Object.keys(attributes).length === 0) delete next.attributes;
  return next;
}

/** Set (or clear, with both bounds undefined) a number attribute's range. */
export function withAttributeRange(
  query: ProductQuery,
  code: string,
  min?: number,
  max?: number,
): ProductQuery {
  const ranges = { ...query.attributeRanges };
  const range: AttributeRange = {};
  if (typeof min === "number") range.min = min;
  if (typeof max === "number") range.max = max;
  if (Object.keys(range).length) ranges[code] = range;
  else delete ranges[code];

  const next: ProductQuery = { ...query, page: 1, attributeRanges: ranges };
  if (Object.keys(ranges).length === 0) delete next.attributeRanges;
  return next;
}

/** Remove every value and range of one attribute. */
export function clearAttribute(query: ProductQuery, code: string): ProductQuery {
  const attributes = { ...query.attributes };
  delete attributes[code];
  const next: ProductQuery = { ...query, page: 1, attributes };
  if (Object.keys(attributes).length === 0) delete next.attributes;
  return withAttributeRange(next, code, undefined, undefined);
}

/** Drop every filter but keep sort, page size and the search term. */
export function clearFilters(query: ProductQuery): ProductQuery {
  const cleared: ProductQuery = { page: 1, pageSize: query.pageSize };
  if (query.sort) cleared.sort = query.sort;
  if (query.query) cleared.query = query.query;
  return cleared;
}
