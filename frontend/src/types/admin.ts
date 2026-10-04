import type { Address, CartTotals, Product } from "./index";

/**
 * The admin domain model.
 *
 * The governing rule: **there is one product model.** `AdminProduct` extends the
 * customer `Product` with management metadata rather than redefining it, so a
 * product created in the admin portal is the same shape the storefront reads.
 * When a backend arrives it returns `Product` to the storefront and
 * `AdminProduct` to the admin, from one table.
 */

/* ------------------------------------------------------------------ products */

export type ProductStatus = "draft" | "active" | "out-of-stock" | "archived";

/** Management fields that only the admin portal cares about. */
export interface ProductManagement {
  status: ProductStatus;
  /** Stock level at which the inventory page starts warning. */
  lowStockThreshold: number;
  /** Physically held back for unfulfilled orders; not sellable. */
  reservedStock: number;
  barcode: string;
  taxRatePercent: number;
  createdAt: string;
  updatedAt: string;
  /** Who last touched it. An admin user id. */
  updatedBy: string;
  seo: {
    metaTitle: string;
    metaDescription: string;
  };
}

/** The customer product plus its management metadata. */
export type AdminProduct = Product &
  ProductManagement & {
    /**
     * The images shared by every colour, as stored. `images` falls back to
     * the first colour's photographs when there are none; the edit form must
     * not mistake those for shared ones.
     */
    sharedImages?: string[];
    /**
     * The Category ID (`CAT001`) the product belongs to. `category` is the
     * slug the storefront's URLs use; the portal picks and saves by this.
     */
    categoryId?: string;
  };

/** What the product form submits. Derived fields are computed on save. */
export type ProductDraft = Omit<AdminProduct, "discount" | "createdAt" | "updatedAt" | "updatedBy">;

/* ----------------------------------------------------------------- inventory */

export type StockStatus = "in-stock" | "low-stock" | "out-of-stock";

/**
 * A row on the inventory page.
 *
 * Derived from a product rather than stored separately — stock lives on the
 * product, and duplicating it would let the two drift apart.
 */
export interface InventoryItem {
  productId: string;
  name: string;
  slug: string;
  sku: string;
  image: string;
  category: string;
  stock: number;
  reserved: number;
  /** `stock - reserved`, i.e. what can actually be sold. */
  available: number;
  lowStockThreshold: number;
  status: StockStatus;
}

export interface StockAdjustment {
  productId: string;
  newStock: number;
  /** Why it changed — the beginning of an audit trail. */
  reason: "restock" | "correction" | "damage" | "return" | "stocktake";
  note: string;
  at: string;
  by: string;
}

/* -------------------------------------------------------------------- orders */

/** The fulfilment pipeline and its exits — see `lib/orders/orderFlow`. */
export type AdminOrderStatus =
  | "pending"
  | "confirmed"
  | "processing"
  | "packed"
  | "shipped"
  | "in-transit"
  | "out-for-delivery"
  | "delivered"
  | "cancelled"
  | "returned";

export type PaymentStatus = "paid" | "pending" | "failed" | "refunded" | "cod-pending";

/**
 * A line in an admin order.
 *
 * Holds `productId` plus a snapshot of name, price and image *as sold*. This is
 * the one place duplication is correct: an invoice must not change because the
 * product was later renamed or repriced.
 */
export interface AdminOrderLine {
  productId: string;
  name: string;
  sku: string;
  image: string;
  size: string | null;
  color: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  /** A component of a bundle: the bundle's name and how many were bought. */
  bundleName?: string;
  bundleQuantity?: number;
  /** The catalogue price when the line was bought for less (flash sale or bundle). */
  regularUnitPrice?: number | null;
  flashSaleId?: number | null;
}

export interface OrderEvent {
  status: AdminOrderStatus;
  at: string;
  note: string;
  by: string;
}

export interface AdminOrder {
  id: string;
  /** Customer-facing number, e.g. "DCZ10241". */
  orderNumber: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  placedAt: string;
  status: AdminOrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: string;
  lines: AdminOrderLine[];
  shippingAddress: Address;
  totals: CartTotals & { taxAmount: number };
  /** Append-only history. Drives the order timeline. */
  timeline: OrderEvent[];
  /** Courier reference once shipped. */
  trackingNumber: string | null;
  /** A checkout order still waiting for its payment: only a payment confirms it. */
  awaitingPayment?: boolean;
}

/* ----------------------------------------------------------------- customers */

export type CustomerStatus = "active" | "blocked";

export interface AdminCustomer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  status: CustomerStatus;
  joinedAt: string;
  /** Aggregates, recomputed from orders rather than stored authoritatively. */
  orderCount: number;
  totalSpent: number;
  lastOrderAt: string | null;
  addresses: Address[];
  wishlistProductIds: string[];
}

/* ------------------------------------------------------------------- coupons */

export type CouponStatus = "active" | "scheduled" | "expired" | "disabled";

export interface AdminCoupon {
  id: string;
  code: string;
  description: string;
  type: "percent" | "flat" | "free-shipping";
  value: number;
  minSubtotal: number;
  maxDiscount: number | null;
  startsAt: string;
  endsAt: string | null;
  /** `null` means unlimited. All customers together. */
  usageLimit: number | null;
  usageCount: number;
  /** Times each customer may use it; `null` for no limit. */
  perCustomerLimit?: number | null;
  /** Who may use it. */
  audience?: "everyone" | "selected" | "members" | "first-order" | "segment";
  /** Customers a `selected` coupon is for. */
  customerIds?: string[];
  /** Customer segmentation: the segment a `segment` coupon is for, and its name (list rows). */
  segmentId?: number | null;
  segmentName?: string;
  /** Listed in the store for eligible shoppers. */
  showInStore?: boolean;
  /** How many different customers have used it. */
  customersUsed?: number;
  /** Total discount given, in rupees. */
  totalDiscount?: number;
  status: CouponStatus;
  createdAt: string;
}

/* ------------------------------------------------------------------- reviews */

export type ReviewStatus = "pending" | "approved" | "rejected";

export interface AdminReview {
  id: string;
  productId: string;
  productName: string;
  productImage: string;
  customerId: string;
  customerName: string;
  rating: number;
  title: string;
  body: string;
  submittedAt: string;
  status: ReviewStatus;
  verifiedPurchase: boolean;
}

/* ------------------------------------------------------------------- banners */

export interface AdminBanner {
  id: string;
  title: string;
  subtitle: string;
  image: string;
  buttonText: string;
  buttonLink: string;
  startsAt: string;
  endsAt: string | null;
  active: boolean;
  displayOrder: number;
}

/* --------------------------------------------------------- homepage sections */

export type HomeSectionKind =
  | "product-carousel"
  | "product-grid"
  | "category-grid"
  | "collection-grid"
  | "promo-banner"
  | "featured-products";

export type HomeSectionSourceKey =
  | "new-arrivals"
  | "trending"
  | "bestsellers"
  | "featured"
  | "recommended"
  | "deals";

/**
 * The editable form of a homepage section.
 *
 * The storefront's `homepage.json` is the rendered contract; this is the admin's
 * view of the same thing, with `active` and `displayOrder` added so sections can
 * be toggled and reordered without deleting them.
 */
export interface AdminHomeSection {
  id: string;
  type: HomeSectionKind;
  title: string;
  subtitle: string;
  /** Which catalogue query feeds it. Unused by layout-only sections. */
  source: HomeSectionSourceKey | null;
  limit: number;
  active: boolean;
  displayOrder: number;
}

/* --------------------------------------------------------------- admin users */

export type AdminRole = "super-admin" | "admin" | "manager" | "editor";

export type AdminUserStatus = "active" | "disabled";

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
  status: AdminUserStatus;
  /**
   * What the server says this account may write, in the API's own vocabulary.
   *
   * Present on the signed-in administrator and on anyone listed by the admin
   * users endpoint; absent on a user assembled locally, where `can()` falls
   * back to the role. It decides which controls are drawn, never whether a
   * write succeeds — the API checks the same list.
   */
  permissions?: string[];
  lastLoginAt: string | null;
  createdAt: string;
  avatarInitials: string;
}

/** An authenticated admin session. */
export interface AdminSession {
  user: AdminUser;
  /** The bearer token every admin endpoint validates. */
  token: string;
  issuedAt: string;
}

/* ------------------------------------------------------------------ dashboard */

/** One KPI tile. `delta` is the change against the previous period, in percent. */
export interface DashboardStat {
  id: string;
  label: string;
  value: number;
  format: "currency" | "number";
  delta: number | null;
  /** Where the tile links to. */
  href: string;
  icon: "sales" | "orders" | "customers" | "products" | "alert";
}

/** A product the dashboard is warning about. */
export interface DashboardLowStock {
  productId: string;
  name: string;
  sku: string;
  stock: number;
  available: number;
}

export interface DashboardStats {
  stats: DashboardStat[];
  generatedAt: string;
  /**
   * The eight most recent orders and the five thinnest lines of stock.
   *
   * Both arrive with the figures above, because the same request that
   * aggregates the tiles has the rows to hand. The dashboard used to drop them
   * and then read every order and every product back out of two list endpoints
   * to show eight rows and five.
   */
  recentOrders: AdminOrder[];
  lowStock: DashboardLowStock[];
}

/* ------------------------------------------------------------------ analytics */

export type AnalyticsRange = "today" | "7d" | "30d" | "3m" | "1y";

export interface TimeSeriesPoint {
  /** ISO date, or an hour label for the "today" range. */
  label: string;
  revenue: number;
  orders: number;
}

export interface CategorySales {
  category: string;
  revenue: number;
  units: number;
}

export interface TopProduct {
  productId: string;
  name: string;
  image: string;
  category: string;
  unitsSold: number;
  revenue: number;
  stock: number;
}

export interface StatusBreakdown {
  status: AdminOrderStatus;
  count: number;
}

export interface AnalyticsSnapshot {
  range: AnalyticsRange;
  revenue: number;
  orders: number;
  averageOrderValue: number;
  unitsSold: number;
  customers: number;
  /** Percent change against the preceding period of equal length. */
  revenueDelta: number;
  ordersDelta: number;
  series: TimeSeriesPoint[];
  byCategory: CategorySales[];
  topProducts: TopProduct[];
  byStatus: StatusBreakdown[];
}

/* ------------------------------------------------------------------- settings */

export interface StoreSettings {
  general: {
    storeName: string;
    tagline: string;
    description: string;
    logoUrl: string;
  };
  contact: {
    email: string;
    phone: string;
    supportHours: string;
    addressLine: string;
    city: string;
    state: string;
    pincode: string;
    country: string;
  };
  currency: {
    code: "INR";
    symbol: string;
    locale: string;
  };
  shipping: {
    freeDeliveryThreshold: number;
    standardFee: number;
    expressFee: number;
    standardEstimate: string;
    expressEstimate: string;
  };
  tax: {
    enabled: boolean;
    ratePercent: number;
    pricesIncludeTax: boolean;
    gstin: string;
  };
  notifications: {
    orderConfirmation: boolean;
    shippingUpdates: boolean;
    lowStockAlerts: boolean;
    reviewAlerts: boolean;
    marketingEmails: boolean;
  };
  social: {
    instagram: string;
    facebook: string;
    youtube: string;
  };
  returns: {
    windowDays: number;
    policyNote: string;
  };
}

/* -------------------------------------------------------------- notifications */

export type NotificationKind = "stock" | "order" | "review" | "coupon" | "system" | "support";

export interface AdminNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  at: string;
  read: boolean;
  href: string;
}

/* ------------------------------------------------------------------ nav config */

export interface AdminNavItem {
  id: string;
  label: string;
  /** "" for a folder: a row that only opens and closes the links under it. */
  href: string;
  icon: string;
  /** Shown as a count chip, resolved at render time. */
  badge?: "pendingReviews" | "openOrders" | "lowStock" | "openReturns" | "openTickets";
  /**
   * What is nested under this row: a folder's links, or a link's own
   * sub-pages (Billing's invoices, payments...). Open while the current page
   * is inside, or when the person opens it; the sidebar renders any depth.
   */
  children?: AdminNavItem[];
}

export interface AdminNavGroup {
  id: string;
  heading: string;
  items: AdminNavItem[];
}

/* ------------------------------------------------------------- shared results */

/** A page of admin rows. Same shape the future REST endpoints will return. */
export interface AdminPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** What a mutation returns, so the UI can report success or a reason. */
export type AdminResult<T> = { ok: true; data: T } | { ok: false; reason: string };
