import type { Category, Collection } from "@/types";
import type {
  AdminBanner,
  AdminCoupon,
  AdminOrderStatus,
  AdminCustomer,
  AdminHomeSection,
  AdminNavGroup,
  AdminNotification,
  AdminOrder,
  AdminProduct,
  AdminReview,
  AdminUser,
  AnalyticsRange,
  AnalyticsSnapshot,
  DashboardStats,
  InventoryItem,
  PaymentStatus,
  ReviewStatus,
  StockAdjustment,
  StoreSettings,
} from "@/types/admin";

import { pageCache } from "@/services/api/cache";
import type { AdminProductListParams, AdminProductPage } from "@/types/searchAdmin";

import { apiDelete, apiGet, apiGetPage, apiGetPageWithMeta, apiPost, apiPut, query } from "@/services/api/client";

import type { AdminDataSource, NavCounts, PaymentLinkSent, ReviewFilters } from "../admin-data-source";

/**
 * The portal, over the REST API.
 *
 * Implements the same `AdminDataSource` the mock did, so no admin view, hook
 * or service changed when the backend arrived.
 *
 * Most methods are a call and nothing else — the API already speaks the shapes
 * these types describe. The few that map are the ones where the API returns
 * something *better* than the frontend type was built for, and the mapping
 * lives here rather than being pushed into the components.
 */

const AUTH = { auth: "admin" } as const;

/**
 * The sidebar, read once per page rather than once per navigation.
 *
 * It is the same document on every screen and only changes when somebody
 * edits it — at which point the editor says to reload. Re-fetching it on each
 * route change was a request per click for an answer that never differed.
 */
const navigation = pageCache(() => apiGet<AdminNavGroup[]>("/admin/navigation", AUTH));

/**
 * Forget the cached sidebar. The menu depends on who is signed in — each
 * administrator sees what their permissions allow — so it is dropped on every
 * sign-in and sign-out rather than carried over to the next person.
 */
export function invalidateAdminNavigation(): void {
  navigation.invalidate();
}

/* ------------------------------------------------------------------- shapes */

interface ApiInventoryRow {
  productId: string;
  name: string;
  sku: string;
  category: string;
  image: string;
  stock: number;
  reserved: number;
  available: number;
  lowStockThreshold: number;
  status: InventoryItem["status"];
}

/**
 * An order as the API returns it.
 *
 * The one place the two vocabularies differ: the API calls them `items`, which
 * is what the table is, and the frontend type calls them `lines`, which is
 * what an order document calls them. The rename happens here so no view has to
 * know about it — and so the admin order page stops reading `order.lines` off
 * a response that never had the field.
 */
interface ApiAdminOrder extends Omit<AdminOrder, "lines"> {
  items: AdminOrder["lines"];
}

function toAdminOrder({ items, ...order }: ApiAdminOrder): AdminOrder {
  return { ...order, lines: items ?? [] };
}

interface ApiStockLogRow {
  productId: string;
  reason: string;
  quantityAfter: number;
  note: string;
  by: string;
  at: string;
}

interface ApiAnalytics {
  range: AnalyticsRange;
  revenue: number;
  orders: number;
  customers: number;
  unitsSold: number;
  averageOrderValue: number;
  revenueDelta: number | null;
  ordersDelta: number | null;
  series: { label: string; revenue: number; orders: number }[];
  byCategory: { label: string; value: number; units: number }[];
  topProducts: {
    productId: string;
    name: string;
    sku: string;
    units: number;
    revenue: number;
    stock: number;
  }[];
  orderStatus: { label: string; value: number }[];
}

/* ------------------------------------------------------------------ adapter */

export const httpAdminAdapter: AdminDataSource = {
  /* ------------------------------------------------------------ products */

  async listProducts(): Promise<AdminProduct[]> {
    /**
     * The whole catalogue, a page at a time.
     *
     * The screens that call this — categories and collections — count
     * membership across every product, so they genuinely need all of them. The
     * API caps a page at 100 and is right to: no single request may ask it to
     * serialise the table. Asking for 500 did not get 500, it got a 422, and
     * the counts came out empty.
     */
    const PAGE_SIZE = 100;
    const all: AdminProduct[] = [];

    for (let page = 1; ; page += 1) {
      const result = await apiGetPage<AdminProduct>(
        `/admin/products?pageSize=${PAGE_SIZE}&page=${page}`,
        AUTH,
      );
      all.push(...result.items);
      if (page >= result.totalPages || result.items.length === 0) break;
    }

    return all;
  },

  async listProductsPage(params: AdminProductListParams): Promise<AdminProductPage> {
    /**
     * The product list screen: one page, filtered, sorted and counted by the
     * server (docs/search-and-filters.md §6), never the whole catalogue.
     */
    const { flag, status, ...rest } = params;
    const result = await apiGetPageWithMeta<AdminProduct, Pick<AdminProductPage, "counts" | "filters">>(
      `/admin/products${query({
        ...rest,
        status: status && status !== "all" ? status : undefined,
        ...(flag ? { [flag]: true } : {}),
      })}`,
      AUTH,
    );
    return {
      items: result.items,
      pagination: {
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: result.totalPages,
      },
      counts: { all: 0, active: 0, draft: 0, "out-of-stock": 0, archived: 0, ...result.meta.counts },
      filters: {
        categories: result.meta.filters?.categories ?? [],
        brands: result.meta.filters?.brands ?? [],
      },
    };
  },

  getProduct(id: string): Promise<AdminProduct | null> {
    return apiGet<AdminProduct>(`/admin/products/${encodeURIComponent(id)}`, AUTH).catch(() => null);
  },

  createProduct(product: AdminProduct): Promise<AdminProduct> {
    return apiPost<AdminProduct>("/products", toProductPayload(product), AUTH);
  },

  updateProduct(product: AdminProduct): Promise<AdminProduct> {
    return apiPut<AdminProduct>(
      `/products/${encodeURIComponent(product.id)}`,
      toProductPayload(product),
      AUTH,
    );
  },

  async deleteProduct(id: string): Promise<void> {
    await apiDelete(`/products/${encodeURIComponent(id)}`, AUTH);
  },

  /* ---------------------------------------------------------- categories */

  listCategories(): Promise<Category[]> {
    return apiGet<Category[]>("/categories?withCounts=true");
  },

  saveCategory(category: Category): Promise<Category> {
    const payload = {
      name: category.name,
      slug: category.slug,
      description: category.description,
      image: category.image,
      order: category.order,
      featured: category.featured,
      groups: category.groups,
    };

    // An id the API already knows is an update; anything else is a create.
    return category.id && category.id.startsWith("CAT")
      ? apiPut<Category>(`/admin/categories/${encodeURIComponent(category.id)}`, payload, AUTH)
      : apiPost<Category>("/admin/categories", payload, AUTH);
  },

  async deleteCategory(id: string): Promise<void> {
    await apiDelete(`/admin/categories/${encodeURIComponent(id)}`, AUTH);
  },

  /* --------------------------------------------------------- collections */

  listCollections(): Promise<Collection[]> {
    return apiGet<Collection[]>("/collections");
  },

  saveCollection(collection: Collection): Promise<Collection> {
    const payload = {
      name: collection.name,
      slug: collection.slug,
      description: collection.description,
      image: collection.image,
      featured: collection.featured,
      productIds: collection.productIds,
    };

    return collection.id && collection.id.startsWith("COL")
      ? apiPut<Collection>(`/admin/collections/${encodeURIComponent(collection.id)}`, payload, AUTH)
      : apiPost<Collection>("/admin/collections", payload, AUTH);
  },

  async deleteCollection(id: string): Promise<void> {
    await apiDelete(`/admin/collections/${encodeURIComponent(id)}`, AUTH);
  },

  /* ----------------------------------------------------------- inventory */

  async listInventory(productId?: string): Promise<InventoryItem[]> {
    const rows = await apiGet<ApiInventoryRow[]>(`/admin/inventory${query({ q: productId || undefined })}`, AUTH);
    // `slug` is not on the API row because nothing in the inventory view links
    // to a storefront page; the type carries it, so it is filled in blank
    // rather than omitted.
    return rows.map((row) => ({ ...row, slug: "" }));
  },

  async adjustStock(adjustment: StockAdjustment): Promise<InventoryItem> {
    const row = await apiPut<ApiInventoryRow>(
      `/admin/inventory/${encodeURIComponent(adjustment.productId)}`,
      {
        quantity: adjustment.newStock,
        reason: adjustment.reason,
        note: adjustment.note,
      },
      AUTH,
    );
    return { ...row, slug: "" };
  },

  async listStockLog(productId?: string): Promise<StockAdjustment[]> {
    const rows = await apiGet<ApiStockLogRow[]>(
      `/admin/inventory/log${query({ productId: productId || undefined })}`,
      AUTH,
    );
    return rows.map((row) => ({
      productId: row.productId,
      newStock: row.quantityAfter,
      reason: row.reason as StockAdjustment["reason"],
      note: row.note,
      at: row.at,
      by: row.by,
    }));
  },

  /* -------------------------------------------------------------- orders */

  async listOrders(customerId?: string, q?: string): Promise<AdminOrder[]> {
    return (
      await apiGet<ApiAdminOrder[]>(`/admin/orders${query({ customerId, q })}`, AUTH)
    ).map(toAdminOrder);
  },

  async getOrder(id: string): Promise<AdminOrder | null> {
    const order = await apiGet<ApiAdminOrder>(
      `/admin/orders/${encodeURIComponent(id)}`,
      AUTH,
    ).catch(() => null);
    return order && toAdminOrder(order);
  },

  async updateOrderStatus(
    id: string,
    status: AdminOrderStatus,
    note: string,
    by: string,
    confirm = false,
  ): Promise<AdminOrder> {
    // `by` is not sent: the server takes the actor from the token. A client
    // that could name the actor could name somebody else.
    void by;
    return toAdminOrder(
      await apiPut<ApiAdminOrder>(
        `/admin/orders/${encodeURIComponent(id)}/status`,
        { status, note, confirm },
        AUTH,
      ),
    );
  },

  async updatePaymentStatus(id: string, status: PaymentStatus): Promise<AdminOrder> {
    // Payment status follows the order's own lifecycle — marking an order
    // delivered settles a cash-on-delivery payment, and recording a settlement
    // is a billing action. Both go through their own endpoints.
    return toAdminOrder(
      await apiPut<ApiAdminOrder>(
        `/admin/orders/${encodeURIComponent(id)}/status`,
        { status, note: `Payment marked ${status}.` },
        AUTH,
      ),
    );
  },

  sendPaymentLink(id: string) {
    // The order is marked paid by the gateway's confirmation, never by this
    // call: sending a link is a request for money, not a receipt of it.
    return apiPost<PaymentLinkSent>(
      `/admin/orders/${encodeURIComponent(id)}/payment-link`,
      {},
      AUTH,
    );
  },

  /* ----------------------------------------------------------- customers */

  listCustomers(q?: string): Promise<AdminCustomer[]> {
    return apiGet<AdminCustomer[]>(`/admin/customers${query({ q })}`, AUTH);
  },

  getCustomer(id: string): Promise<AdminCustomer | null> {
    return apiGet<AdminCustomer>(`/admin/customers/${encodeURIComponent(id)}`, AUTH).catch(() => null);
  },

  setCustomerStatus(id: string, status: AdminCustomer["status"]): Promise<AdminCustomer> {
    return apiPut<AdminCustomer>(
      `/admin/customers/${encodeURIComponent(id)}/status`,
      { status },
      AUTH,
    );
  },

  /* ------------------------------------------------------------- coupons */

  listCoupons(): Promise<AdminCoupon[]> {
    return apiGet<AdminCoupon[]>("/admin/coupons", AUTH);
  },

  async saveCoupon(coupon: AdminCoupon): Promise<AdminCoupon> {
    const existing = coupon.id && coupon.id.startsWith("CPN");
    const saved = existing
      ? await apiPut<{ id: string }>(`/admin/coupons/${encodeURIComponent(coupon.id)}`, coupon, AUTH)
      : await apiPost<{ id: string }>("/admin/coupons", coupon, AUTH);

    // Re-read rather than trusting the write's echo: `status` is derived from
    // the dates on every read, so only the server knows what it is now.
    const all = await apiGet<AdminCoupon[]>("/admin/coupons", AUTH);
    return all.find((entry) => entry.id === saved.id) ?? { ...coupon, id: saved.id };
  },

  async deleteCoupon(id: string): Promise<void> {
    await apiDelete(`/admin/coupons/${encodeURIComponent(id)}`, AUTH);
  },

  /* ------------------------------------------------------------- reviews */

  listReviews(filters: ReviewFilters = {}): Promise<AdminReview[]> {
    return apiGet<AdminReview[]>(
      `/admin/reviews${query({ productId: filters.productId || undefined, customerId: filters.customerId || undefined })}`,
      AUTH,
    );
  },

  async setReviewStatus(id: string, status: ReviewStatus): Promise<AdminReview> {
    await apiPut(`/admin/reviews/${encodeURIComponent(id)}`, { status }, AUTH);
    const all = await apiGet<AdminReview[]>("/admin/reviews", AUTH);
    return all.find((review) => review.id === id) as AdminReview;
  },

  async deleteReview(id: string): Promise<void> {
    await apiDelete(`/admin/reviews/${encodeURIComponent(id)}`, AUTH);
  },

  /* ------------------------------------------------------------ homepage */

  getHomepage(): Promise<AdminHomeSection[]> {
    return apiGet<AdminHomeSection[]>("/admin/homepage", AUTH);
  },

  saveHomepage(sections: AdminHomeSection[]): Promise<AdminHomeSection[]> {
    return apiPut<AdminHomeSection[]>(
      "/admin/homepage",
      sections.map((section) => ({
        id: section.id,
        active: section.active,
        displayOrder: section.displayOrder,
        title: section.title,
        subtitle: section.subtitle,
      })),
      AUTH,
    );
  },

  /* ------------------------------------------------------------- banners */

  listBanners(): Promise<AdminBanner[]> {
    return apiGet<AdminBanner[]>("/admin/banners", AUTH);
  },

  saveBanner(banner: AdminBanner): Promise<AdminBanner> {
    return banner.id && banner.id.startsWith("BNR")
      ? apiPut<AdminBanner>(`/admin/banners/${encodeURIComponent(banner.id)}`, banner, AUTH)
      : apiPost<AdminBanner>("/admin/banners", banner, AUTH);
  },

  async deleteBanner(id: string): Promise<void> {
    await apiDelete(`/admin/banners/${encodeURIComponent(id)}`, AUTH);
  },

  /* ----------------------------------------------------------- analytics */

  async getAnalytics(range: AnalyticsRange): Promise<AnalyticsSnapshot> {
    const data = await apiGet<ApiAnalytics>(`/admin/reports?range=${range}`, AUTH);

    return {
      range,
      revenue: data.revenue,
      orders: data.orders,
      averageOrderValue: data.averageOrderValue,
      unitsSold: data.unitsSold,
      customers: data.customers,
      // The API returns null when there is no prior period to compare with;
      // the chart reads a number, and zero is the honest rendering of
      // "nothing to compare against".
      revenueDelta: data.revenueDelta ?? 0,
      ordersDelta: data.ordersDelta ?? 0,
      series: data.series,
      byCategory: data.byCategory.map((row) => ({
        category: row.label,
        revenue: row.value,
        units: row.units,
      })),
      topProducts: data.topProducts.map((row) => ({
        productId: row.productId,
        name: row.name,
        image: "",
        category: "",
        unitsSold: row.units,
        revenue: row.revenue,
        stock: row.stock,
      })),
      byStatus: data.orderStatus.map((row) => ({
        status: row.label as AnalyticsSnapshot["byStatus"][number]["status"],
        count: row.value,
      })),
    };
  },

  async getDashboard(): Promise<DashboardStats> {
    const data = await apiGet<Omit<DashboardStats, "recentOrders"> & {
      recentOrders: ApiAdminOrder[];
    }>("/admin/dashboard", AUTH);

    return {
      stats: data.stats,
      generatedAt: data.generatedAt,
      recentOrders: (data.recentOrders ?? []).map(toAdminOrder),
      lowStock: data.lowStock ?? [],
    };
  },

  /* ------------------------------------------------------------ settings */

  getSettings(): Promise<StoreSettings> {
    return apiGet<StoreSettings>("/admin/settings/store", AUTH);
  },

  saveSettings(settings: StoreSettings): Promise<StoreSettings> {
    return apiPut<StoreSettings>("/admin/settings/store", settings, AUTH);
  },

  /* --------------------------------------------------------- admin users */

  listAdminUsers(): Promise<AdminUser[]> {
    return apiGet<AdminUser[]>("/admin/users", AUTH);
  },

  saveAdminUser(user: AdminUser, password?: string): Promise<AdminUser> {
    // The password travels only on the way in — no response carries one back.
    const body = password ? { ...user, password } : user;

    return user.id && user.id.startsWith("ADM")
      ? apiPut<AdminUser>(`/admin/users/${encodeURIComponent(user.id)}`, body, AUTH)
      : apiPost<AdminUser>("/admin/users", body, AUTH);
  },

  async deleteAdminUser(id: string): Promise<void> {
    await apiDelete(`/admin/users/${encodeURIComponent(id)}`, AUTH);
  },

  /* ------------------------------------------------------- notifications */

  listNotifications(): Promise<AdminNotification[]> {
    return apiGet<AdminNotification[]>("/admin/notifications", AUTH);
  },

  async markNotificationRead(id: string): Promise<void> {
    await apiPut(`/admin/notifications/${encodeURIComponent(id)}/read`, {}, AUTH);
  },

  async markAllNotificationsRead(): Promise<void> {
    await apiPut("/admin/notifications/read-all", {}, AUTH);
  },

  /* -------------------------------------------------------- navigation */

  getNavigation(): Promise<AdminNavGroup[]> {
    return navigation.read();
  },

  getNavCounts(): Promise<NavCounts> {
    return apiGet<NavCounts>("/admin/nav-counts", AUTH);
  },
};

/* ------------------------------------------------------------------ mapping */

function toProductPayload(product: AdminProduct) {
  return {
    name: product.name,
    slug: product.slug,
    sku: product.sku,
    brand: product.brand,
    // The category is identified by its Category ID. The slug is sent only
    // for a product that has no ID yet (older data), which the API still accepts.
    categoryId: product.categoryId || undefined,
    category: product.categoryId ? undefined : product.category,
    subcategory: product.subcategory,
    price: product.price,
    originalPrice: product.originalPrice,
    currency: product.currency,
    description: product.description,
    material: product.material,
    care: product.care,
    images: product.images,
    colors: product.colors,
    sizes: product.sizes,
    tags: product.tags,
    specifications: product.specifications,
    isNew: product.isNew,
    isTrending: product.isTrending,
    isBestSeller: product.isBestSeller,
    isFeatured: product.isFeatured,
    isReturnable: product.isReturnable ?? true,
    isReplaceable: product.isReplaceable ?? true,
    stock: product.stock,
    status: product.status,
    lowStockThreshold: product.lowStockThreshold,
    reservedStock: product.reservedStock,
    barcode: product.barcode,
    taxRatePercent: product.taxRatePercent,
    metaTitle: product.seo?.metaTitle,
    metaDescription: product.seo?.metaDescription,
  };
}
