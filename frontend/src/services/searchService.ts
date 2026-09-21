import type { Paginated, Product, ProductQuery } from "@/types";

import { dataSource } from "./data-source.instance";

/**
 * Search is a catalogue query with a `q` term, so it reuses the same pipeline
 * as every listing page — which is why search results support the identical
 * filters and sorting rather than being a separate, weaker screen.
 */
export function searchProducts(
  term: string,
  query: Omit<ProductQuery, "query"> = {},
): Promise<Paginated<Product>> {
  return dataSource.queryProducts({ ...query, query: term });
}

/**
 * Type-ahead suggestions for the header search box.
 *
 * Returns a handful of matching products plus the distinct categories and
 * brands they fall into, which is what makes a suggestion dropdown feel like
 * it understands the catalogue rather than just prefix-matching names.
 */
export async function getSearchSuggestions(
  term: string,
  limit = 6,
): Promise<{
  products: Product[];
  categories: string[];
  brands: string[];
  total: number;
}> {
  const trimmed = term.trim();
  if (trimmed.length < 2) {
    return { products: [], categories: [], brands: [], total: 0 };
  }

  const { items, total } = await dataSource.queryProducts({
    query: trimmed,
    pageSize: 40,
    page: 1,
  });

  return {
    products: items.slice(0, limit),
    categories: [...new Set(items.map((product) => product.category))].slice(0, 4),
    brands: [...new Set(items.map((product) => product.brand))].slice(0, 4),
    total,
  };
}

/**
 * Popular searches, shown before anyone has typed anything.
 *
 * Static today. A real implementation would read this from search analytics.
 */
export const POPULAR_SEARCHES = [
  "linen shirt",
  "sneakers",
  "cotton dress",
  "serum",
  "backpack",
  "bedsheet",
  "earrings",
  "headphones",
] as const;
