"use client";

import type { Paginated, Product, ProductFacets, ProductQuery } from "@/types";

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

export function useFacets(
  scope?: Pick<ProductQuery, "category" | "subcategory" | "query">,
): AsyncState<ProductFacets> {
  const key = JSON.stringify(scope ?? {});
  return useAsync(() => getFacets(scope), [key]);
}

export function useRelatedProducts(productId: string | undefined, limit = 8) {
  return useAsync(
    () => (productId ? getRelatedProducts(productId, limit) : Promise.resolve([])),
    [productId, limit],
    { enabled: Boolean(productId), initialData: [] },
  );
}
