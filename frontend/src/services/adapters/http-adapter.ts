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

import { apiGet, apiGetOrNull, apiGetPage, query } from "@/services/api/client";

import type { DataSource } from "../data-source";

/**
 * The storefront, over the REST API.
 *
 * This is the live data source. It implements the same `DataSource` contract
 * the mock did, which is why switching to a real backend changed no component,
 * no hook and no service above this line.
 *
 * There is deliberately no mapping layer: the API emits the field names the
 * frontend's types already use, so a response *is* a `Product`. A translation
 * step here would be one more thing to keep in step every time a field is
 * added, and the place a field silently goes missing.
 *
 * **Responses are cast, not validated.** That is a real gap and it is worth
 * naming: a network payload is untrusted input in a way local JSON generated
 * by this repository was not. The fix is a zod schema per shape, applied here,
 * and nowhere else needs to change when it lands.
 */

export const httpAdapter: DataSource = {
  async queryProducts(productQuery: ProductQuery): Promise<Paginated<Product>> {
    const page = await apiGetPage<Product>(
      `/products${query({
        page: productQuery.page,
        pageSize: productQuery.pageSize,
        search: productQuery.query,
        category: productQuery.category?.[0],
        subcategory: productQuery.subcategory?.[0],
        collection: productQuery.collection,
        brands: productQuery.brand,
        sizes: productQuery.size,
        colors: productQuery.color,
        minPrice: productQuery.minPrice,
        maxPrice: productQuery.maxPrice,
        minRating: productQuery.minRating,
        minDiscount: productQuery.minDiscount,
        inStockOnly: productQuery.inStockOnly || undefined,
        isNew: productQuery.isNew,
        isTrending: productQuery.isTrending,
        isBestSeller: productQuery.isBestSeller,
        isFeatured: productQuery.isFeatured,
        sort: productQuery.sort,
      })}`,
    );

    return {
      items: page.items,
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
      totalPages: page.totalPages,
    };
  },

  getProductBySlug(slug: string): Promise<Product | null> {
    return apiGetOrNull<Product>(`/products/slug/${encodeURIComponent(slug)}`);
  },

  async getProductsByIds(ids: string[]): Promise<Product[]> {
    if (ids.length === 0) return [];

    /**
     * Resolved one request per id, then re-ordered.
     *
     * The order matters — the cart and the recently-viewed rail both render in
     * the order they asked for — and a batch endpoint would be a second way to
     * read a product. At cart and rail sizes (under a dozen) the parallel
     * requests cost less than the endpoint would cost to maintain; a `?ids=`
     * parameter on the list endpoint is the answer if that ever changes.
     */
    const results = await Promise.all(
      ids.map((id) => apiGetOrNull<Product>(`/products/${encodeURIComponent(id)}`)),
    );

    return results.filter((product): product is Product => product !== null);
  },

  getRelatedProducts(productId: string, limit = 6): Promise<Product[]> {
    return apiGet<Product[]>(`/products/${encodeURIComponent(productId)}/related?limit=${limit}`);
  },

  getFacets(scope): Promise<ProductFacets> {
    return apiGet<ProductFacets>(
      `/products/facets${query({
        search: scope?.query,
        category: scope?.category,
        subcategory: scope?.subcategory,
      })}`,
    );
  },

  listCategories(): Promise<Category[]> {
    return apiGet<Category[]>("/categories?withCounts=true");
  },

  getCategoryBySlug(slug: string): Promise<Category | null> {
    return apiGetOrNull<Category>(`/categories/${encodeURIComponent(slug)}`);
  },

  listCollections(): Promise<Collection[]> {
    return apiGet<Collection[]>("/collections");
  },

  getCollectionBySlug(slug: string): Promise<Collection | null> {
    return apiGetOrNull<Collection>(`/collections/${encodeURIComponent(slug)}`);
  },

  listReviews(productId: string): Promise<Review[]> {
    return apiGet<Review[]>(`/reviews?productId=${encodeURIComponent(productId)}`);
  },

  getReviewSummary(productId: string): Promise<ReviewSummary> {
    return apiGet<ReviewSummary>(
      `/reviews/summary?productId=${encodeURIComponent(productId)}`,
    );
  },

  listCoupons(): Promise<Coupon[]> {
    return apiGet<Coupon[]>("/coupons");
  },

  getSiteConfig(): Promise<SiteConfig> {
    return apiGet<SiteConfig>("/site/config");
  },

  getHomepageConfig(): Promise<HomepageConfig> {
    return apiGet<HomepageConfig>("/site/homepage");
  },

  async getHomeSectionLayout(): Promise<HomeSectionLayout[]> {
    /**
     * The API returns only the live sections, already in order, so the layout
     * *is* the list — a projection of one response rather than a second call.
     *
     * Typed locally because `HomeSection` describes what a section renders and
     * carries no editorial state; that lives on the row the API sends.
     */
    const config = await apiGet<{ sections: { id: string; active?: boolean }[] }>("/site/homepage");

    return config.sections.map((section) => ({
      id: section.id,
      active: section.active ?? true,
    }));
  },

  listBanners(): Promise<PromoBanner[]> {
    return apiGet<PromoBanner[]>("/site/banners");
  },
};
