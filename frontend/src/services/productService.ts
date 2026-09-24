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

/**
 * Every product, a page at a time.
 *
 * The API caps a page at 100 — deliberately, so no single request can ask it
 * to serialise the whole catalogue. The sitemap genuinely does need all of
 * them, so it pages through rather than asking for a limit the server is right
 * to refuse. Nothing else should use this.
 */
export async function getAllProducts(): Promise<Product[]> {
  const pageSize = 100;
  const all: Product[] = [];

  for (let page = 1; ; page += 1) {
    const { items, totalPages } = await getProducts({ page, pageSize });
    all.push(...items);
    if (page >= totalPages || items.length === 0) break;
  }

  return all;
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
 * The flags are sent to the API, so the database returns six products rather
 * than the browser fetching a few hundred and discarding most of them. That is
 * the difference between a rail that stays fast at ten thousand products and
 * one that does not.
 */
async function rail(filters: ProductQuery, limit: number): Promise<Product[]> {
  const { items } = await dataSource.queryProducts({ ...filters, page: 1, pageSize: limit });
  return items;
}

export function getNewArrivals(limit = 6): Promise<Product[]> {
  return rail({ isNew: true, sort: "newest" }, limit);
}

export function getTrendingProducts(limit = 6): Promise<Product[]> {
  return rail({ isTrending: true, sort: "popular" }, limit);
}

export function getBestSellingProducts(limit = 6): Promise<Product[]> {
  return rail({ isBestSeller: true, sort: "popular" }, limit);
}

export function getFeaturedProducts(limit = 6): Promise<Product[]> {
  return rail({ isFeatured: true, sort: "recommended" }, limit);
}

/** Deals: genuinely reduced and actually in stock, deepest cut first. */
export function getDeals(limit = 6): Promise<Product[]> {
  return rail({ minDiscount: 20, inStockOnly: true, sort: "discount" }, limit);
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

  // One page of candidates, not the catalogue: recommendations pick a handful
  // of near neighbours, and the API caps a page at 100 — asking for 250 was a
  // 422 and an empty rail rather than a bigger pool.
  const [recentlyViewed, { items: catalogue }] = await Promise.all([
    dataSource.getProductsByIds(recentlyViewedIds),
    dataSource.queryProducts({ pageSize: 100, page: 1 }),
  ]);

  const recommended = findRecommended(recentlyViewed, catalogue, limit);
  // A very short history can yield fewer than `limit`; top up with featured.
  if (recommended.length >= limit) return recommended;

  const featured = await getFeaturedProducts(limit);
  const seen = new Set([...recommended.map((p) => p.id), ...recentlyViewedIds]);
  return [...recommended, ...featured.filter((p) => !seen.has(p.id))].slice(0, limit);
}
