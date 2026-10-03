import type { Paginated, Product, ProductFacets, ProductFilters, ProductQuery } from "@/types";

import { dataSource } from "./data-source.instance";
import { findRecommended } from "@/lib/recommendations/related";
import { getToken } from "@/services/api/client";
import { getForYou } from "@/services/discoveryService";

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

/**
 * One product, by id.
 *
 * A slug resolves too — the server answers to either — which is what keeps a
 * link shared before the storefront moved to ids working. The detail page
 * redirects such a URL to the canonical one.
 */
export function getProduct(idOrSlug: string): Promise<Product | null> {
  return dataSource.getProduct(idOrSlug);
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

export function getFacets(scope?: ProductFilters): Promise<ProductFacets> {
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
 * The server's ranking first (`/recommendations/for-you`): signed in, it works
 * from the account's own history and purchases; signed out, from the recently
 * viewed ids the caller supplies, because only the browser knows them.
 *
 * If that can't be reached, the same idea is worked out here from the
 * catalogue — and with no history at all, featured products — so the rail is
 * never empty on a first visit.
 */
export async function getRecommendedProducts(
  recentlyViewedIds: string[],
  limit = 6,
): Promise<Product[]> {
  try {
    const items = await getForYou({
      seed: recentlyViewedIds.slice(0, 6),
      limit,
      signedIn: Boolean(getToken("customer")),
    });
    if (items.length > 0) return items;
  } catch {
    /* worked out below instead */
  }

  if (recentlyViewedIds.length === 0) {
    return getFeaturedProducts(limit);
  }

  const recentlyViewed = await dataSource.getProductsByIds(recentlyViewedIds);

  /**
   * Candidates from the departments this shopper has been looking in.
   *
   * The scoring weights subcategory, then category, then brand — so a product
   * from a department they have not touched scores near zero and is only ever
   * ballast. This used to fetch the first hundred products of the whole
   * catalogue to pick six near neighbours: a large request whose best answers
   * might not even be in it, since page one is ordered by merchandising rather
   * than by anything to do with this shopper.
   */
  const categories = [...new Set(recentlyViewed.map((product) => product.category))];

  const { items: candidates } = await dataSource.queryProducts({
    category: categories,
    inStockOnly: true,
    pageSize: 48,
    page: 1,
  });

  const recommended = findRecommended(recentlyViewed, candidates, limit);
  // A very short history can yield fewer than `limit`; top up with featured.
  if (recommended.length >= limit) return recommended;

  const featured = await getFeaturedProducts(limit);
  const seen = new Set([...recommended.map((p) => p.id), ...recentlyViewedIds]);
  return [...recommended, ...featured.filter((p) => !seen.has(p.id))].slice(0, limit);
}
