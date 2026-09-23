import adminUsersJson from "@/data/admin/admin-users.json";
import analyticsJson from "@/data/admin/analytics.json";
import bannersJson from "@/data/admin/banners.json";
import couponsJson from "@/data/admin/coupons.json";
import customersJson from "@/data/admin/customers.json";
import dashboardJson from "@/data/admin/dashboard.json";
import adminHomepageJson from "@/data/admin/homepage.json";
import navigationJson from "@/data/admin/navigation.json";
import notificationsJson from "@/data/admin/notifications.json";
import ordersJson from "@/data/admin/orders.json";
import adminReviewsJson from "@/data/admin/reviews.json";
import settingsJson from "@/data/admin/settings.json";

import categoriesJson from "@/data/categories.json";
import collectionsJson from "@/data/collections.json";

import type { Category, Collection } from "@/types";
import type {
  AdminBanner,
  AdminCoupon,
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
  StockAdjustment,
  StockStatus,
  StoreSettings,
} from "@/types/admin";

import {
  allAdminProducts,
  findAdminProduct,
} from "@/lib/admin/catalogue";
import {
  OVERLAY_KEYS,
  create,
  readDocument,
  remove,
  resolve,
  update,
  writeDocument,
} from "@/lib/admin/mock-store";
import { readJson, writeJson } from "@/lib/storage/local-storage";

import type { AdminDataSource } from "../admin-data-source";

/**
 * The mock admin data source.
 *
 * Reads come from the committed JSON with the local overlay applied; writes go
 * into that overlay. The casts below are the one place raw JSON becomes domain
 * types, which is an adapter's whole job — nothing downstream touches the JSON.
 *
 * A real HTTP adapter should *validate* responses rather than cast, since a
 * network payload is untrusted in a way a file we generate ourselves is not.
 */

const BASE_ORDERS = ordersJson as AdminOrder[];
const BASE_CUSTOMERS = customersJson as AdminCustomer[];
const BASE_COUPONS = couponsJson as AdminCoupon[];
const BASE_REVIEWS = adminReviewsJson as AdminReview[];
const BASE_BANNERS = bannersJson as AdminBanner[];
const BASE_ADMIN_USERS = adminUsersJson as AdminUser[];
const BASE_CATEGORIES = categoriesJson as Category[];
const BASE_COLLECTIONS = collectionsJson as Collection[];
const BASE_HOMEPAGE = adminHomepageJson as AdminHomeSection[];
const BASE_SETTINGS = settingsJson as StoreSettings;
const BASE_NOTIFICATIONS = notificationsJson as AdminNotification[];
const ANALYTICS = analyticsJson as Record<AnalyticsRange, AnalyticsSnapshot>;
const DASHBOARD = dashboardJson as DashboardStats;
const NAVIGATION = navigationJson as AdminNavGroup[];

/** Matches the storefront's latency switch, for exercising loading states. */
const LATENCY = Number(process.env.NEXT_PUBLIC_MOCK_LATENCY ?? 0);

async function settle<T>(value: T): Promise<T> {
  if (LATENCY > 0) await new Promise((r) => setTimeout(r, LATENCY));
  return value;
}

function notFound(what: string, id: string): never {
  throw new Error(`${what} "${id}" not found`);
}

/** Categories and collections have no id in their base JSON shape guard. */
const withId = <T extends { id: string }>(records: T[]) => records;

/* ------------------------------------------------------------------ inventory */

function stockStatus(available: number, threshold: number): StockStatus {
  if (available <= 0) return "out-of-stock";
  if (available <= threshold) return "low-stock";
  return "in-stock";
}

/**
 * Inventory rows are derived from products, never stored separately.
 *
 * Stock lives on the product; a parallel inventory table in mock data would
 * drift from it within a few edits.
 */
function inventoryFromProducts(): InventoryItem[] {
  return allAdminProducts()
    .filter((product) => product.status !== "archived")
    .map((product) => {
      const available = Math.max(0, product.stock - product.reservedStock);
      return {
        productId: product.id,
        name: product.name,
        slug: product.slug,
        sku: product.sku,
        image: product.images[0] ?? "",
        category: product.category,
        stock: product.stock,
        reserved: product.reservedStock,
        available,
        lowStockThreshold: product.lowStockThreshold,
        status: stockStatus(available, product.lowStockThreshold),
      };
    });
}

/* --------------------------------------------------------------- notifications */

const READ_NOTIFICATIONS_KEY = OVERLAY_KEYS.notifications;

function readNotificationState(): string[] {
  return readJson<string[]>(READ_NOTIFICATIONS_KEY, []);
}

/* ------------------------------------------------------------------- adapter */

export const mockAdminAdapter: AdminDataSource = {
  /* -------------------------------------------------------------- products */
  async listProducts() {
    return settle(allAdminProducts());
  },

  async getProduct(id) {
    return settle(findAdminProduct(id));
  },

  async createProduct(product) {
    return settle(create(OVERLAY_KEYS.products, product));
  },

  async updateProduct(product) {
    return settle(update(OVERLAY_KEYS.products, product));
  },

  async deleteProduct(id) {
    remove(OVERLAY_KEYS.products, id);
    return settle(undefined);
  },

  /* ------------------------------------------------------------ categories */
  async listCategories() {
    return settle(
      [...resolve(withId(BASE_CATEGORIES), OVERLAY_KEYS.categories)].sort(
        (a, b) => a.order - b.order,
      ),
    );
  },

  async saveCategory(category) {
    const exists = BASE_CATEGORIES.some((c) => c.id === category.id);
    const existsLocally = resolve(withId(BASE_CATEGORIES), OVERLAY_KEYS.categories).some(
      (c) => c.id === category.id,
    );
    return settle(
      exists || existsLocally
        ? update(OVERLAY_KEYS.categories, category)
        : create(OVERLAY_KEYS.categories, category),
    );
  },

  async deleteCategory(id) {
    remove(OVERLAY_KEYS.categories, id);
    return settle(undefined);
  },

  /* ----------------------------------------------------------- collections */
  async listCollections() {
    return settle(resolve(withId(BASE_COLLECTIONS), OVERLAY_KEYS.collections));
  },

  async saveCollection(collection) {
    const known = resolve(withId(BASE_COLLECTIONS), OVERLAY_KEYS.collections).some(
      (c) => c.id === collection.id,
    );
    return settle(
      known
        ? update(OVERLAY_KEYS.collections, collection)
        : create(OVERLAY_KEYS.collections, collection),
    );
  },

  async deleteCollection(id) {
    remove(OVERLAY_KEYS.collections, id);
    return settle(undefined);
  },

  /* ------------------------------------------------------------- inventory */
  async listInventory() {
    return settle(inventoryFromProducts());
  },

  async adjustStock(adjustment) {
    const product = findAdminProduct(adjustment.productId);
    if (!product) notFound("Product", adjustment.productId);

    const updated: AdminProduct = {
      ...product,
      stock: Math.max(0, Math.trunc(adjustment.newStock)),
      // Restocking a sold-out product should bring it back to sale, and
      // emptying an active one should take it out — the status must not lie.
      status:
        adjustment.newStock <= 0
          ? "out-of-stock"
          : product.status === "out-of-stock"
            ? "active"
            : product.status,
      updatedAt: adjustment.at,
      updatedBy: adjustment.by,
    };
    update(OVERLAY_KEYS.products, updated);

    const log = readJson<StockAdjustment[]>(OVERLAY_KEYS.stockLog, []);
    writeJson(OVERLAY_KEYS.stockLog, [adjustment, ...log].slice(0, 200));

    const row = inventoryFromProducts().find((item) => item.productId === updated.id);
    return settle(row ?? notFound("Inventory row", updated.id));
  },

  async listStockLog() {
    return settle(readJson<StockAdjustment[]>(OVERLAY_KEYS.stockLog, []));
  },

  /* ---------------------------------------------------------------- orders */
  async listOrders() {
    return settle(
      [...resolve(BASE_ORDERS, OVERLAY_KEYS.orders)].sort((a, b) =>
        b.placedAt.localeCompare(a.placedAt),
      ),
    );
  },

  async getOrder(id) {
    const orders = resolve(BASE_ORDERS, OVERLAY_KEYS.orders);
    // Accept either the internal id or the customer-facing number, so a
    // support agent can paste whichever one they have.
    return settle(
      orders.find((order) => order.id === id || order.orderNumber === id) ?? null,
    );
  },

  async updateOrderStatus(id, status, note, by) {
    const order = await this.getOrder(id);
    if (!order) notFound("Order", id);

    const updated: AdminOrder = {
      ...order,
      status,
      // The timeline is append-only: it records what happened, not the
      // current state, so a correction never erases history.
      timeline: [...order.timeline, { status, at: new Date().toISOString(), note, by }],
      // Cash on delivery settles when it is handed over.
      paymentStatus:
        status === "delivered" && order.paymentStatus === "cod-pending"
          ? "paid"
          : status === "returned"
            ? "refunded"
            : order.paymentStatus,
    };
    return settle(update(OVERLAY_KEYS.orders, updated));
  },

  async updatePaymentStatus(id, paymentStatus) {
    const order = await this.getOrder(id);
    if (!order) notFound("Order", id);
    return settle(update(OVERLAY_KEYS.orders, { ...order, paymentStatus }));
  },

  /* ------------------------------------------------------------- customers */
  async listCustomers() {
    return settle(resolve(BASE_CUSTOMERS, OVERLAY_KEYS.customers));
  },

  async getCustomer(id) {
    const customers = resolve(BASE_CUSTOMERS, OVERLAY_KEYS.customers);
    return settle(customers.find((customer) => customer.id === id) ?? null);
  },

  async setCustomerStatus(id, status) {
    const customer = await this.getCustomer(id);
    if (!customer) notFound("Customer", id);
    return settle(update(OVERLAY_KEYS.customers, { ...customer, status }));
  },

  /* --------------------------------------------------------------- coupons */
  async listCoupons() {
    return settle(resolve(BASE_COUPONS, OVERLAY_KEYS.coupons));
  },

  async saveCoupon(coupon) {
    const known = resolve(BASE_COUPONS, OVERLAY_KEYS.coupons).some((c) => c.id === coupon.id);
    return settle(
      known ? update(OVERLAY_KEYS.coupons, coupon) : create(OVERLAY_KEYS.coupons, coupon),
    );
  },

  async deleteCoupon(id) {
    remove(OVERLAY_KEYS.coupons, id);
    return settle(undefined);
  },

  /* --------------------------------------------------------------- reviews */
  async listReviews() {
    return settle(
      [...resolve(BASE_REVIEWS, OVERLAY_KEYS.reviews)].sort((a, b) =>
        b.submittedAt.localeCompare(a.submittedAt),
      ),
    );
  },

  async setReviewStatus(id, status) {
    const review = resolve(BASE_REVIEWS, OVERLAY_KEYS.reviews).find((r) => r.id === id);
    if (!review) notFound("Review", id);
    return settle(update(OVERLAY_KEYS.reviews, { ...review, status }));
  },

  async deleteReview(id) {
    remove(OVERLAY_KEYS.reviews, id);
    return settle(undefined);
  },

  /* -------------------------------------------------------------- homepage */
  async getHomepage() {
    const sections = readDocument(OVERLAY_KEYS.homepage, BASE_HOMEPAGE);
    return settle([...sections].sort((a, b) => a.displayOrder - b.displayOrder));
  },

  async saveHomepage(sections) {
    // Renumber on save so `displayOrder` is always dense and 1-based,
    // whatever the UI handed over.
    const normalised = sections.map((section, index) => ({
      ...section,
      displayOrder: index + 1,
    }));
    return settle(writeDocument(OVERLAY_KEYS.homepage, normalised));
  },

  /* --------------------------------------------------------------- banners */
  async listBanners() {
    return settle(
      [...resolve(BASE_BANNERS, OVERLAY_KEYS.banners)].sort(
        (a, b) => a.displayOrder - b.displayOrder,
      ),
    );
  },

  async saveBanner(banner) {
    const known = resolve(BASE_BANNERS, OVERLAY_KEYS.banners).some((b) => b.id === banner.id);
    return settle(
      known ? update(OVERLAY_KEYS.banners, banner) : create(OVERLAY_KEYS.banners, banner),
    );
  },

  async deleteBanner(id) {
    remove(OVERLAY_KEYS.banners, id);
    return settle(undefined);
  },

  /* ------------------------------------------------------------- analytics */
  async getAnalytics(range) {
    return settle(ANALYTICS[range] ?? ANALYTICS["30d"]);
  },

  /**
   * Dashboard KPIs.
   *
   * Product and low-stock counts are recomputed from the live catalogue rather
   * than read from `dashboard.json`, so deleting a product or restocking one is
   * reflected immediately (requirement 42). Revenue and order counts stay as
   * generated, because recomputing them would need the full order history
   * re-aggregated on every dashboard load.
   */
  async getDashboard() {
    const products = allAdminProducts();
    const sellable = products.filter((p) => p.status === "active" || p.status === "out-of-stock");
    const lowStock = inventoryFromProducts().filter((item) => item.status === "low-stock").length;

    const stats = DASHBOARD.stats.map((stat) => {
      if (stat.id === "products") return { ...stat, value: sellable.length };
      if (stat.id === "lowStock") return { ...stat, value: lowStock };
      return stat;
    });

    return settle({ ...DASHBOARD, stats });
  },

  /* -------------------------------------------------------------- settings */
  async getSettings() {
    return settle(readDocument(OVERLAY_KEYS.settings, BASE_SETTINGS));
  },

  async saveSettings(settings) {
    return settle(writeDocument(OVERLAY_KEYS.settings, settings));
  },

  /* ----------------------------------------------------------- admin users */
  async listAdminUsers() {
    return settle(resolve(BASE_ADMIN_USERS, OVERLAY_KEYS.adminUsers));
  },

  async saveAdminUser(user) {
    const known = resolve(BASE_ADMIN_USERS, OVERLAY_KEYS.adminUsers).some((u) => u.id === user.id);
    return settle(
      known ? update(OVERLAY_KEYS.adminUsers, user) : create(OVERLAY_KEYS.adminUsers, user),
    );
  },

  async deleteAdminUser(id) {
    remove(OVERLAY_KEYS.adminUsers, id);
    return settle(undefined);
  },

  /* --------------------------------------------------------- notifications */
  async listNotifications() {
    const readIds = new Set(readNotificationState());
    return settle(
      BASE_NOTIFICATIONS.map((notification) => ({
        ...notification,
        read: notification.read || readIds.has(notification.id),
      })),
    );
  },

  async markNotificationRead(id) {
    const readIds = readNotificationState();
    if (!readIds.includes(id)) writeJson(READ_NOTIFICATIONS_KEY, [...readIds, id]);
    return settle(undefined);
  },

  async markAllNotificationsRead() {
    writeJson(READ_NOTIFICATIONS_KEY, BASE_NOTIFICATIONS.map((n) => n.id));
    return settle(undefined);
  },

  /* ------------------------------------------------------------ navigation */
  getNavigation() {
    return NAVIGATION;
  },
};
