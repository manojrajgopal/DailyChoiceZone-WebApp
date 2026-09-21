import type {
  Category,
  Collection,
  Coupon,
  HomepageConfig,
  Paginated,
  Product,
  ProductFacets,
  ProductQuery,
  PromoBanner,
  Review,
  SiteConfig,
} from "@/types";

import { buildQueryString } from "@/lib/filters/search-params";

import type { DataSource } from "../data-source";

/**
 * The REST data source. Written, but not active yet.
 *
 * This exists so the mock is provably a stand-in rather than a design
 * decision: the seam is real, and switching over is two steps.
 *
 *   1. Point `NEXT_PUBLIC_API_URL` at the API.
 *   2. Set `NEXT_PUBLIC_DATA_SOURCE=http`.
 *
 * No component, hook or service changes. If the eventual endpoints return
 * slightly different field names, this file is the only place that maps them —
 * that is precisely why it is the only file that knows they exist.
 *
 * One thing to add before trusting this in production: validate responses
 * (with zod or similar) instead of casting. A network payload is untrusted
 * input; local JSON we generate ourselves is not.
 */

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`Request failed (${status}): ${url}`);
    this.name = "HttpError";
  }
}

async function get<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", ...init?.headers },
  });

  if (!response.ok) throw new HttpError(response.status, url);
  return (await response.json()) as T;
}

/** Like `get`, but a 404 is a legitimate "not found" rather than an error. */
async function getOrNull<T>(path: string): Promise<T | null> {
  try {
    return await get<T>(path);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}

export const httpAdapter: DataSource = {
  queryProducts(query: ProductQuery): Promise<Paginated<Product>> {
    return get<Paginated<Product>>(`/products${buildQueryString(query)}`);
  },

  getProductBySlug(slug: string): Promise<Product | null> {
    return getOrNull<Product>(`/products/${encodeURIComponent(slug)}`);
  },

  getProductsByIds(ids: string[]): Promise<Product[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return get<Product[]>(`/products?ids=${ids.map(encodeURIComponent).join(",")}`);
  },

  getRelatedProducts(productId: string, limit = 8): Promise<Product[]> {
    return get<Product[]>(`/products/${encodeURIComponent(productId)}/related?limit=${limit}`);
  },

  getFacets(scope): Promise<ProductFacets> {
    return get<ProductFacets>(`/products/facets${buildQueryString(scope ?? {})}`);
  },

  listCategories(): Promise<Category[]> {
    return get<Category[]>("/categories");
  },

  getCategoryBySlug(slug: string): Promise<Category | null> {
    return getOrNull<Category>(`/categories/${encodeURIComponent(slug)}`);
  },

  listCollections(): Promise<Collection[]> {
    return get<Collection[]>("/collections");
  },

  getCollectionBySlug(slug: string): Promise<Collection | null> {
    return getOrNull<Collection>(`/collections/${encodeURIComponent(slug)}`);
  },

  listReviews(productId: string): Promise<Review[]> {
    return get<Review[]>(`/products/${encodeURIComponent(productId)}/reviews`);
  },

  listCoupons(): Promise<Coupon[]> {
    return get<Coupon[]>("/coupons");
  },

  getSiteConfig(): Promise<SiteConfig> {
    return get<SiteConfig>("/site-config");
  },

  getHomepageConfig(): Promise<HomepageConfig> {
    return get<HomepageConfig>("/homepage");
  },

  listBanners(): Promise<PromoBanner[]> {
    return get<PromoBanner[]>("/banners");
  },
};
