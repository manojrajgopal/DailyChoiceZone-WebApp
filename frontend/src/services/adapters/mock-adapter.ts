import categoriesJson from "@/data/categories.json";
import collectionsJson from "@/data/collections.json";
import couponsJson from "@/data/coupons.json";
import homepageJson from "@/data/homepage.json";
import reviewsJson from "@/data/reviews.json";
import siteConfigJson from "@/data/site-config.json";

import type {
  Category,
  Collection,
  Coupon,
  HomepageConfig,
  HomeSectionLayout,
  Paginated,
  Product,
  ProductFacets,
  ProductQuery,
  PromoBanner,
  Review,
  SiteConfig,
} from "@/types";

import { storefrontProducts } from "@/lib/admin/catalogue";
import { livePromoBanners } from "@/lib/admin/banners";
import { approvedReviewIds } from "@/lib/admin/reviews";
import { applyStoreSettings } from "@/lib/admin/site-settings";
import { homeSectionLayout } from "@/lib/admin/homepage-layout";
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
const CATEGORIES = categoriesJson as Category[];
const COLLECTIONS = collectionsJson as Collection[];
const REVIEWS = reviewsJson as Review[];
const COUPONS = couponsJson as Coupon[];
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

/**
 * The catalogue is resolved per call, not cached at module scope.
 *
 * `storefrontProducts()` merges the committed JSON with whatever the admin
 * portal has changed locally, and hides drafts. A module-level snapshot would
 * mean an admin editing a product never saw the change on the storefront.
 */
function catalogue(): Product[] {
  return storefrontProducts();
}

function indexBy<K extends "id" | "slug">(field: K): Map<string, Product> {
  return new Map(catalogue().map((product) => [product[field], product]));
}

export const mockAdapter: DataSource = {
  async queryProducts(query: ProductQuery): Promise<Paginated<Product>> {
    return settle(queryProducts(catalogue(), query));
  },

  async getProductBySlug(slug: string): Promise<Product | null> {
    return settle(indexBy("slug").get(slug) ?? null);
  },

  async getProductsByIds(ids: string[]): Promise<Product[]> {
    const byId = indexBy("id");
    const resolved = ids
      .map((id) => byId.get(id))
      .filter((product): product is Product => product !== undefined);
    return settle(resolved);
  },

  async getRelatedProducts(productId: string, limit = 8): Promise<Product[]> {
    const products = catalogue();
    const seed = products.find((product) => product.id === productId);
    if (!seed) return settle([]);
    return settle(findRelated(seed, products, limit));
  },

  async getFacets(scope): Promise<ProductFacets> {
    const products = catalogue();
    const scoped = scope ? products.filter((product) => matchesFilters(product, scope)) : products;
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
    // Only what moderation has approved — see `approvedReviewIds`. Resolved per
    // call so approving or rejecting a review takes effect straight away.
    const approved = approvedReviewIds();
    const forProduct = REVIEWS.filter(
      (review) => review.productId === productId && approved.has(review.id),
    ).sort((a, b) => b.date.localeCompare(a.date));
    return settle(forProduct);
  },

  async listCoupons(): Promise<Coupon[]> {
    return settle(COUPONS);
  },

  async getSiteConfig(): Promise<SiteConfig> {
    // The commercial numbers come from store settings — see `applyStoreSettings`.
    return settle(applyStoreSettings(SITE_CONFIG));
  },

  async getHomepageConfig(): Promise<HomepageConfig> {
    return settle(HOMEPAGE);
  },

  async getHomeSectionLayout(): Promise<HomeSectionLayout[]> {
    // Resolved on every call, like the catalogue: an admin who hides a section
    // must see it gone, not a cached copy of the old layout.
    return settle(homeSectionLayout());
  },

  async listBanners(): Promise<PromoBanner[]> {
    // Resolved per call so a banner's schedule and switch take effect without
    // a rebuild — see `livePromoBanners`.
    return settle(livePromoBanners());
  },
};
