import type { Category, Collection } from "@/types";
import type {
  AdminBanner,
  AdminCoupon,
  AdminCustomer,
  AdminHomeSection,
  AdminNavGroup,
  AdminNotification,
  AdminOrder,
  AdminOrderStatus,
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
import type { AdminProductListParams, AdminProductPage } from "@/types/searchAdmin";

/**
 * The admin data-source contract — the single seam between the admin portal and
 * wherever its data lives.
 *
 * Every method is named and shaped after the endpoint that will eventually back
 * it, so switching is an adapter change and nothing more:
 *
 *   listProducts        GET    /admin/products
 *   getProduct          GET    /admin/products/:id
 *   createProduct       POST   /admin/products
 *   updateProduct       PUT    /admin/products/:id
 *   deleteProduct       DELETE /admin/products/:id
 *
 *   listOrders          GET    /admin/orders
 *   getOrder            GET    /admin/orders/:id
 *   updateOrderStatus   PUT    /admin/orders/:id/status
 *
 *   listCustomers       GET    /admin/customers
 *   getCustomer         GET    /admin/customers/:id
 *
 *   listCategories      GET    /admin/categories
 *   saveCategory        POST   /admin/categories · PUT /admin/categories/:id
 *   deleteCategory      DELETE /admin/categories/:id
 *
 *   listInventory       GET    /admin/inventory
 *   adjustStock         PUT    /admin/inventory/:id
 *
 *   listReviews         GET    /admin/reviews
 *   setReviewStatus     PUT    /admin/reviews/:id
 *
 *   listCoupons         GET    /admin/coupons
 *   saveCoupon          POST   /admin/coupons · PUT /admin/coupons/:id
 *   deleteCoupon        DELETE /admin/coupons/:id
 *
 *   getAnalytics        GET    /admin/analytics?range=30d
 *   getDashboard        GET    /admin/dashboard
 *
 *   getHomepage         GET    /admin/homepage
 *   saveHomepage        PUT    /admin/homepage
 *
 *   listBanners         GET    /admin/banners
 *   saveBanner          POST   /admin/banners · PUT /admin/banners/:id
 *   deleteBanner        DELETE /admin/banners/:id
 *
 *   getSettings         GET    /admin/settings
 *   saveSettings        PUT    /admin/settings
 *
 * Note that the *list* methods return whole collections rather than pages.
 * Filtering, sorting and pagination happen in the shared `DataTable`, because
 * the mock catalogue is small enough that paging it server-side would be
 * pretend work. When the API arrives, add a query argument here and the table's
 * existing `total`/`page` props already describe what it needs.
 */
/** The counts the sidebar chips show. */
export interface NavCounts {
  lowStock: number;
  openOrders: number;
  pendingReviews: number;
  openReturns: number;
  openTickets: number;
  pendingQuestions: number;
  referralsInReview: number;
  failedNotifications: number;
  waitingCustomers: number;
}

export interface AdminDataSource {
  /* -------------------------------------------------------------- products */
  listProducts(): Promise<AdminProduct[]>;
  /** One page of the list, filtered, sorted and counted on the server (search & filters). */
  listProductsPage(params: AdminProductListParams): Promise<AdminProductPage>;
  getProduct(id: string): Promise<AdminProduct | null>;
  createProduct(product: AdminProduct): Promise<AdminProduct>;
  updateProduct(product: AdminProduct): Promise<AdminProduct>;
  deleteProduct(id: string): Promise<void>;

  /* ------------------------------------------------------------ categories */
  listCategories(): Promise<Category[]>;
  saveCategory(category: Category): Promise<Category>;
  deleteCategory(id: string): Promise<void>;

  /* ----------------------------------------------------------- collections */
  listCollections(): Promise<Collection[]>;
  saveCollection(collection: Collection): Promise<Collection>;
  deleteCollection(id: string): Promise<void>;

  /* ------------------------------------------------------------- inventory */
  /** `productId`: a Product ID or SKU, matched exactly on the server. */
  listInventory(productId?: string): Promise<InventoryItem[]>;
  adjustStock(adjustment: StockAdjustment): Promise<InventoryItem>;
  /** Newest first; `productId` (a Product ID or SKU, exact) keeps one product's changes. */
  listStockLog(productId?: string): Promise<StockAdjustment[]>;

  /* ---------------------------------------------------------------- orders */
  /** Every order, one customer's, or the one an Order ID (`q`) names. */
  listOrders(customerId?: string, q?: string): Promise<AdminOrder[]>;
  getOrder(id: string): Promise<AdminOrder | null>;
  updateOrderStatus(
    id: string,
    status: AdminOrderStatus,
    note: string,
    by: string,
    /** Required by the server to skip stages or move backwards. */
    confirm?: boolean,
  ): Promise<AdminOrder>;
  updatePaymentStatus(id: string, status: PaymentStatus): Promise<AdminOrder>;
  /** Ask the customer to pay a confirmed, unpaid cash-on-delivery order online, on our own payment page. */
  sendPaymentLink(id: string): Promise<PaymentLinkSent>;

  /* ------------------------------------------------------------- customers */
  /** `q`: a Customer ID, matched exactly — only that customer (docs/id-lookup.md). */
  listCustomers(q?: string): Promise<AdminCustomer[]>;
  getCustomer(id: string): Promise<AdminCustomer | null>;
  setCustomerStatus(id: string, status: AdminCustomer["status"]): Promise<AdminCustomer>;

  /* --------------------------------------------------------------- coupons */
  listCoupons(): Promise<AdminCoupon[]>;
  saveCoupon(coupon: AdminCoupon): Promise<AdminCoupon>;
  deleteCoupon(id: string): Promise<void>;

  /* --------------------------------------------------------------- reviews */
  listReviews(filters?: ReviewFilters): Promise<AdminReview[]>;
  setReviewStatus(id: string, status: ReviewStatus): Promise<AdminReview>;
  deleteReview(id: string): Promise<void>;

  /* -------------------------------------------------------------- homepage */
  getHomepage(): Promise<AdminHomeSection[]>;
  saveHomepage(sections: AdminHomeSection[]): Promise<AdminHomeSection[]>;

  /* --------------------------------------------------------------- banners */
  listBanners(): Promise<AdminBanner[]>;
  saveBanner(banner: AdminBanner): Promise<AdminBanner>;
  deleteBanner(id: string): Promise<void>;

  /* ------------------------------------------------------------- analytics */
  getAnalytics(range: AnalyticsRange): Promise<AnalyticsSnapshot>;
  getDashboard(): Promise<DashboardStats>;

  /* -------------------------------------------------------------- settings */
  getSettings(): Promise<StoreSettings>;
  saveSettings(settings: StoreSettings): Promise<StoreSettings>;

  /* ----------------------------------------------------------- admin users */
  listAdminUsers(): Promise<AdminUser[]>;
  saveAdminUser(user: AdminUser, password?: string): Promise<AdminUser>;
  deleteAdminUser(id: string): Promise<void>;

  /* --------------------------------------------------------- notifications */
  listNotifications(): Promise<AdminNotification[]>;
  markNotificationRead(id: string): Promise<void>;
  markAllNotificationsRead(): Promise<void>;

  /* ------------------------------------------------------------ navigation */
  /**
   * Sidebar structure.
   *
   * Frontend configuration rather than business data, so it is read
   * synchronously — the sidebar must render on the first paint.
   */
  getNavigation(): Promise<AdminNavGroup[]>;

  /**
   * The three counts beside the sidebar links.
   *
   * Its own method because the sidebar is on every page: it used to be three
   * full list reads filtered in the browser, which downloaded the inventory,
   * the orders and the reviews to render three small numbers.
   */
  getNavCounts(): Promise<NavCounts>;
}

/** A request to pay online, sent to the customer: our own payment page's address. */
export interface PaymentLinkSent {
  url: string;
  /** The same address (kept for older callers). */
  shortUrl: string;
  paymentId: string;
  orderNumber: string;
}

/** The review list's ID filters: a Product ID (or SKU) and a Customer ID, each exact. */
export interface ReviewFilters {
  productId?: string;
  customerId?: string;
}
