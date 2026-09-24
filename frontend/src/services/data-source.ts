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
  ReviewSummary,
  SiteConfig,
} from "@/types";

/**
 * The data-source contract — the single seam between this frontend and
 * wherever its data actually lives.
 *
 * Every method is deliberately shaped like the REST endpoint that will
 * eventually back it, so the swap is an adapter change and nothing more:
 *
 *   queryProducts      →  GET  /products?category=&sort=&page=
 *   getProductBySlug   →  GET  /products/:slug
 *   getProductsByIds   →  GET  /products?ids=a,b,c
 *   getRelatedProducts →  GET  /products/:id/related
 *   getFacets          →  GET  /products/facets
 *   listCategories     →  GET  /categories
 *   listCollections    →  GET  /collections
 *   listReviews        →  GET  /reviews?productId=
 *   getReviewSummary   →  GET  /reviews/summary?productId=
 *
 * Note that filtering, sorting and pagination are the *data source's* job, not
 * the UI's. Today the mock adapter runs them locally over JSON; tomorrow the
 * server runs them in SQL. Either way `productService` asks the same question
 * and the components never learn the difference.
 */
export interface DataSource {
  /** Filter, sort and paginate the catalogue. */
  queryProducts(query: ProductQuery): Promise<Paginated<Product>>;
  /** A single product, or `null` when no such slug exists. */
  getProductBySlug(slug: string): Promise<Product | null>;
  /** Resolve ids to products. Order follows the ids given; unknown ids drop. */
  getProductsByIds(ids: string[]): Promise<Product[]>;
  /** Similar products for a detail page. */
  getRelatedProducts(productId: string, limit?: number): Promise<Product[]>;
  /**
   * Filter options with counts.
   *
   * `scope` narrows which products the facets are computed over, so a category
   * page shows only that category's brands and sizes.
   */
  getFacets(scope?: Pick<ProductQuery, "category" | "subcategory" | "query">): Promise<ProductFacets>;

  listCategories(): Promise<Category[]>;
  getCategoryBySlug(slug: string): Promise<Category | null>;

  listCollections(): Promise<Collection[]>;
  getCollectionBySlug(slug: string): Promise<Collection | null>;

  listReviews(productId: string): Promise<Review[]>;
  getReviewSummary(productId: string): Promise<ReviewSummary>;
  listCoupons(): Promise<Coupon[]>;

  getSiteConfig(): Promise<SiteConfig>;
  getHomepageConfig(): Promise<HomepageConfig>;
  /**
   * Which homepage sections are live, and in what order.
   *
   * Separate from `getHomepageConfig` because it changes on a different clock:
   * the section definitions are part of the build, the layout is editorial
   * state an administrator changes at any time.
   */
  getHomeSectionLayout(): Promise<HomeSectionLayout[]>;
  listBanners(): Promise<PromoBanner[]>;
}
