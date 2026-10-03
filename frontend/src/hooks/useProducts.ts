"use client";

import type { Paginated, Product, ProductFacets, ProductFilters, ProductQuery } from "@/types";

import { getFacets, getProducts, getRelatedProducts } from "@/services/productService";

import { useAsync, type AsyncState } from "./useAsync";

/**
 * Data hooks for the catalogue.
 *
 * Components use these; nothing imports the services or JSON directly. The
 * serialised query in the dependency array is what makes a filter change
 * re-fetch without re-running on every unrelated render.
 */

export function useProducts(query: ProductQuery): AsyncState<Paginated<Product>> {
  const key = JSON.stringify(query);
  return useAsync(() => getProducts(query), [key]);
}

/**
 * Filter options and counts for the listing's current filters.
 *
 * Paging and sort are dropped before keying, so turning a page or re-sorting
 * never refetches the facets — only a filter change does.
 */
export function useFacets(
  scope?: ProductFilters | ProductQuery,
  { enabled = true }: { enabled?: boolean } = {},
): AsyncState<ProductFacets> {
  const filters = facetFilters(scope);
  const key = JSON.stringify(filters ?? {});
  return useAsync(() => getFacets(filters), [key], { enabled });
}

function facetFilters(scope?: ProductFilters | ProductQuery): ProductFilters | undefined {
  if (!scope) return undefined;
  const { sort: _sort, page: _page, pageSize: _pageSize, ...filters } = scope as ProductQuery;
  void _sort;
  void _page;
  void _pageSize;
  return filters;
}

export function useRelatedProducts(productId: string | undefined, limit = 8) {
  return useAsync(
    () => (productId ? getRelatedProducts(productId, limit) : Promise.resolve([])),
    [productId, limit],
    { enabled: Boolean(productId), initialData: [] },
  );
}
