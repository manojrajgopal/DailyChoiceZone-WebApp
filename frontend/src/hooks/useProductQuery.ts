"use client";

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import type { AvailabilityFilter, ProductQuery, SortOption } from "@/types";

import { countActiveFilters } from "@/lib/filters/apply-filters";
import {
  buildQueryString,
  clearFilters,
  parseProductQuery,
  toggleAttributeValue,
  toggleFilterValue,
  withAttributeRange,
  withAvailability,
  withInStockOnly,
  withMinDiscount,
  withMinRating,
  withPriceRange,
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

  /**
   * Write a whole new query to the URL.
   *
   * Filter changes `push`, so back undoes them one at a time; `replace` is for
   * changes made while typing, which should not leave a history entry per
   * keystroke.
   */
  const apply = useCallback(
    (next: ProductQuery, { replace = false }: { replace?: boolean } = {}) => {
      // `scroll: false` keeps the shopper's place in a long grid when they
      // tick a filter; page changes opt back in explicitly below.
      const href = `${basePath}${buildQueryString(next)}`;
      if (replace) router.replace(href, { scroll: false });
      else router.push(href, { scroll: false });
    },
    [basePath, router],
  );

  const push = useCallback((next: ProductQuery) => apply(next), [apply]);

  const setSort = useCallback(
    (sort: SortOption) => push({ ...urlQuery, sort, page: 1 }),
    [push, urlQuery],
  );

  const toggleFilter = useCallback(
    (key: MultiFilterKey, value: string) => push(toggleFilterValue(urlQuery, key, value)),
    [push, urlQuery],
  );

  const setPriceRange = useCallback(
    (min?: number, max?: number) => push(withPriceRange(urlQuery, min, max)),
    [push, urlQuery],
  );

  /** Passing the already-selected value clears it, so the control toggles. */
  const setMinRating = useCallback(
    (rating?: number) => push(withMinRating(urlQuery, rating)),
    [push, urlQuery],
  );

  const setMinDiscount = useCallback(
    (discount?: number) => push(withMinDiscount(urlQuery, discount)),
    [push, urlQuery],
  );

  const setInStockOnly = useCallback(
    (only: boolean) => push(withInStockOnly(urlQuery, only)),
    [push, urlQuery],
  );

  /** In stock / out of stock; the selected value clears it. */
  const setAvailability = useCallback(
    (value?: AvailabilityFilter) => push(withAvailability(urlQuery, value)),
    [push, urlQuery],
  );

  const toggleAttribute = useCallback(
    (code: string, value: string) => push(toggleAttributeValue(urlQuery, code, value)),
    [push, urlQuery],
  );

  const setAttributeRange = useCallback(
    (code: string, min?: number, max?: number) => push(withAttributeRange(urlQuery, code, min, max)),
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
    setAvailability,
    toggleAttribute,
    setAttributeRange,
    setPage,
    clearAll,
    apply,
  };
}
