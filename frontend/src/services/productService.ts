import type { Paginated, Product, ProductFacets, ProductQuery } from "@/types";

import { dataSource } from "./data-source.instance";
import { findRecommended } from "@/lib/recommendations/related";

/**
 * The catalogue API the UI codes against.
 *
 * Components and hooks call these functions and nothing below them. Each is a
 * thin, named intention — `getNewArrivals()` rather than a raw query object
 * sprinkled through the pages — which is what keeps merchandising rules in one
 * file instead of scattered across the app.
 */

export function getProducts(query: ProductQuery = {}): Promise<Paginated<Product>> {
  return dataSource.queryProducts(query);
}

export function getProductBySlug(slug: string): Promise<Product | null> {
  return dataSource.getProductBySlug(slug);
}

export function getProductsByIds(ids: string[]): Promise<Product[]> {
  return dataSource.getProductsByIds(ids);
}

export function getProductsByCategory(
  category: string,
  query: Omit<ProductQuery, "category"> = {},
): Promise<Paginated<Product>> {
  return dataSource.queryProducts({ ...query, category: [category] });
}

export function getFacets(
  scope?: Pick<ProductQuery, "category" | "subcategory" | "query">,
): Promise<ProductFacets> {
  return dataSource.getFacets(scope);
}

/* ------------------------------------------------------- merchandising rails */

/**
 * Each rail is a query, expressed once here.
 *
 * `isNew`, `isTrending` and friends are not filterable fields on
 * `ProductQuery` — they are merchandising decisions, so they are resolved here
 * rather than being exposed to the URL.
 */
async function rail(
  predicate: (product: Product) => boolean,
  limit: number,
  sort: ProductQuery["sort"] = "recommended",
): Promise<Product[]> {
  // Ask for a generous page, then narrow by flag. With a real backend these
  // become `GET /products/new` and the filtering happens server-side.
  const { items } = await dataSource.queryProducts({ sort, pageSize: 250, page: 1 });
  return items.filter(predicate).slice(0, limit);
}

export function getNewArrivals(limit = 6): Promise<Product[]> {
  return rail((product) => product.isNew, limit, "newest");
}

export function getTrendingProducts(limit = 6): Promise<Product[]> {
  return rail((product) => product.isTrending, limit, "popular");
}

export function getBestSellingProducts(limit = 6): Promise<Product[]> {
  return rail((product) => product.isBestSeller, limit, "popular");
}

export function getFeaturedProducts(limit = 6): Promise<Product[]> {
  return rail((product) => product.isFeatured, limit);
}

/** Deals: genuinely reduced and actually in stock, deepest cut first. */
export function getDeals(limit = 6): Promise<Product[]> {
  return rail((product) => product.discount >= 20 && product.stock > 0, limit, "discount");
}

/* ------------------------------------------------------------ relationships */

export function getRelatedProducts(productId: string, limit = 8): Promise<Product[]> {
  return dataSource.getRelatedProducts(productId, limit);
}

/**
 * Recommendations for this shopper.
 *
 * Driven by recently viewed ids, which the caller supplies because only the
 * browser knows them. With no history, fall back to featured products so the
 * rail is never empty on a first visit.
 */
export async function getRecommendedProducts(
  recentlyViewedIds: string[],
  limit = 6,
): Promise<Product[]> {
  if (recentlyViewedIds.length === 0) {
    return getFeaturedProducts(limit);
  }

  const [recentlyViewed, { items: catalogue }] = await Promise.all([
    dataSource.getProductsByIds(recentlyViewedIds),
    dataSource.queryProducts({ pageSize: 250, page: 1 }),
  ]);

  const recommended = findRecommended(recentlyViewed, catalogue, limit);
  // A very short history can yield fewer than `limit`; top up with featured.
  if (recommended.length >= limit) return recommended;

  const featured = await getFeaturedProducts(limit);
  const seen = new Set([...recommended.map((p) => p.id), ...recentlyViewedIds]);
  return [...recommended, ...featured.filter((p) => !seen.has(p.id))].slice(0, limit);
}
