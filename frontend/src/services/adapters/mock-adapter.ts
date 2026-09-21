import bannersJson from "@/data/banners.json";
import categoriesJson from "@/data/categories.json";
import collectionsJson from "@/data/collections.json";
import couponsJson from "@/data/coupons.json";
import homepageJson from "@/data/homepage.json";
import productsJson from "@/data/products.json";
import reviewsJson from "@/data/reviews.json";
import siteConfigJson from "@/data/site-config.json";

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

import { buildFacets, matchesFilters, queryProducts } from "@/lib/filters/apply-filters";
import { findRelated } from "@/lib/recommendations/related";

import type { DataSource } from "../data-source";

/**
 * The mock data source: local JSON standing in for a backend.
 *
 * The casts below are the one place raw JSON becomes domain types. That is an
 * adapter's whole job, and confining it here is what keeps the rest of the app
 * honest — nothing downstream touches `products.json`.
 *
 * A real HTTP adapter should *validate* rather than cast, since a network
 * response is untrusted in a way a file we generate ourselves is not.
 */
const PRODUCTS = productsJson as Product[];
const CATEGORIES = categoriesJson as Category[];
const COLLECTIONS = collectionsJson as Collection[];
const REVIEWS = reviewsJson as Review[];
const COUPONS = couponsJson as Coupon[];
const BANNERS = bannersJson as PromoBanner[];
const SITE_CONFIG = siteConfigJson as SiteConfig;
const HOMEPAGE = homepageJson as HomepageConfig;

/**
 * Optional artificial latency, in milliseconds.
 *
 * Defaults to zero so nothing is slowed down for no reason. Set
 * `NEXT_PUBLIC_MOCK_LATENCY=400` to make loading skeletons and spinners
 * visible while working on them.
 */
const LATENCY = Number(process.env.NEXT_PUBLIC_MOCK_LATENCY ?? 0);

async function settle<T>(value: T): Promise<T> {
  if (LATENCY > 0) {
    await new Promise((resolve) => setTimeout(resolve, LATENCY));
  }
  return value;
}

/** Index by id once, rather than scanning the array on every lookup. */
const PRODUCTS_BY_ID = new Map(PRODUCTS.map((product) => [product.id, product]));
const PRODUCTS_BY_SLUG = new Map(PRODUCTS.map((product) => [product.slug, product]));

export const mockAdapter: DataSource = {
  async queryProducts(query: ProductQuery): Promise<Paginated<Product>> {
    return settle(queryProducts(PRODUCTS, query));
  },

  async getProductBySlug(slug: string): Promise<Product | null> {
    return settle(PRODUCTS_BY_SLUG.get(slug) ?? null);
  },

  async getProductsByIds(ids: string[]): Promise<Product[]> {
    const resolved = ids
      .map((id) => PRODUCTS_BY_ID.get(id))
      .filter((product): product is Product => product !== undefined);
    return settle(resolved);
  },

  async getRelatedProducts(productId: string, limit = 8): Promise<Product[]> {
    const seed = PRODUCTS_BY_ID.get(productId);
    if (!seed) return settle([]);
    return settle(findRelated(seed, PRODUCTS, limit));
  },

  async getFacets(scope): Promise<ProductFacets> {
    const scoped = scope ? PRODUCTS.filter((product) => matchesFilters(product, scope)) : PRODUCTS;
    return settle(buildFacets(scoped));
  },

  async listCategories(): Promise<Category[]> {
    return settle([...CATEGORIES].sort((a, b) => a.order - b.order));
  },

  async getCategoryBySlug(slug: string): Promise<Category | null> {
    return settle(CATEGORIES.find((category) => category.slug === slug) ?? null);
  },

  async listCollections(): Promise<Collection[]> {
    return settle(COLLECTIONS);
  },

  async getCollectionBySlug(slug: string): Promise<Collection | null> {
    return settle(COLLECTIONS.find((collection) => collection.slug === slug) ?? null);
  },

  async listReviews(productId: string): Promise<Review[]> {
    const forProduct = REVIEWS.filter((review) => review.productId === productId).sort(
      (a, b) => b.date.localeCompare(a.date),
    );
    return settle(forProduct);
  },

  async listCoupons(): Promise<Coupon[]> {
    return settle(COUPONS);
  },

  async getSiteConfig(): Promise<SiteConfig> {
    return settle(SITE_CONFIG);
  },

  async getHomepageConfig(): Promise<HomepageConfig> {
    return settle(HOMEPAGE);
  },

  async listBanners(): Promise<PromoBanner[]> {
    return settle(BANNERS);
  },
};
