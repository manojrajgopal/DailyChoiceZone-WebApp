"use client";

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import type { ProductQuery, SortOption } from "@/types";

import { countActiveFilters } from "@/lib/filters/apply-filters";
import {
  buildQueryString,
  clearFilters,
  parseProductQuery,
  toggleFilterValue,
} from "@/lib/filters/search-params";

export type MultiFilterKey = "category" | "subcategory" | "brand" | "size" | "color";

interface Options {
  /** Where to push updates, e.g. `/shop` or `/category/women`. */
  basePath: string;
  /**
   * Filters implied by the route itself rather than by the URL.
   *
   * A category page locks `category`, so it is applied to results but never
   * written to the query string and never counted as a removable filter.
   */
  locked?: Pick<ProductQuery, "category" | "query">;
}

/**
 * Filter, sort and pagination state, held in the URL.
 *
 * Keeping it there rather than in component state is what makes a filtered
 * view shareable, bookmarkable, server-renderable and correctly undone by the
 * browser's back button. Every mutation below rewrites the URL; the page then
 * re-renders from it, so there is exactly one source of truth.
 */
export function useProductQuery({ basePath, locked }: Options) {
  const router = useRouter();
  const searchParams = useSearchParams();

  /** What the URL says — the removable, user-chosen filters. */
  const urlQuery = useMemo(
    () => parseProductQuery(searchParams ?? new URLSearchParams()),
    [searchParams],
  );

  /**
   * What to actually query with, including route-implied filters.
   *
   * Not memoised on purpose: `useProducts` keys its fetch on the serialised
   * query rather than on object identity, so a fresh object each render costs
   * nothing and removes a dependency list that had to be kept in step by hand.
   */
  const effectiveQuery: ProductQuery = {
    ...urlQuery,
    ...(locked?.category ? { category: locked.category } : {}),
    ...(locked?.query ? { query: locked.query } : {}),
  };

  const push = useCallback(
    (next: ProductQuery) => {
      // `scroll: false` keeps the shopper's place in a long grid when they
      // tick a filter; page changes opt back in explicitly below.
      router.push(`${basePath}${buildQueryString(next)}`, { scroll: false });
    },
    [basePath, router],
  );

  const setSort = useCallback(
    (sort: SortOption) => push({ ...urlQuery, sort, page: 1 }),
    [push, urlQuery],
  );

  const toggleFilter = useCallback(
    (key: MultiFilterKey, value: string) => push(toggleFilterValue(urlQuery, key, value)),
    [push, urlQuery],
  );

  const setPriceRange = useCallback(
    (min?: number, max?: number) => {
      const next: ProductQuery = { ...urlQuery, page: 1 };
      if (typeof min === "number") next.minPrice = min;
      else delete next.minPrice;
      if (typeof max === "number") next.maxPrice = max;
      else delete next.maxPrice;
      push(next);
    },
    [push, urlQuery],
  );

  /** Passing the already-selected value clears it, so the control toggles. */
  const setMinRating = useCallback(
    (rating?: number) => {
      const next: ProductQuery = { ...urlQuery, page: 1 };
      if (typeof rating === "number" && rating !== urlQuery.minRating) next.minRating = rating;
      else delete next.minRating;
      push(next);
    },
    [push, urlQuery],
  );

  const setMinDiscount = useCallback(
    (discount?: number) => {
      const next: ProductQuery = { ...urlQuery, page: 1 };
      if (typeof discount === "number" && discount !== urlQuery.minDiscount) {
        next.minDiscount = discount;
      } else {
        delete next.minDiscount;
      }
      push(next);
    },
    [push, urlQuery],
  );

  const setInStockOnly = useCallback(
    (only: boolean) => {
      const next: ProductQuery = { ...urlQuery, page: 1 };
      if (only) next.inStockOnly = true;
      else delete next.inStockOnly;
      push(next);
    },
    [push, urlQuery],
  );

  const setPage = useCallback(
    (page: number) => {
      router.push(`${basePath}${buildQueryString({ ...urlQuery, page })}`, { scroll: true });
    },
    [basePath, router, urlQuery],
  );

  const clearAll = useCallback(() => push(clearFilters(urlQuery)), [push, urlQuery]);

  /** Only user-chosen filters count — locked ones are not removable. */
  const activeFilterCount = useMemo(() => countActiveFilters(urlQuery), [urlQuery]);

  return {
    query: effectiveQuery,
    urlQuery,
    activeFilterCount,
    setSort,
    toggleFilter,
    setPriceRange,
    setMinRating,
    setMinDiscount,
    setInStockOnly,
    setPage,
    clearAll,
  };
}
