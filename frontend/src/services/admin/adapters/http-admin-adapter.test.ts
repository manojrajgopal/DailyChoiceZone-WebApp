import { beforeEach, describe, expect, it } from "vitest";

import type { AdminBanner, AdminCoupon, AdminHomeSection, AdminOrder } from "@/types/admin";

import { api, fail, ok } from "@/test/api";
import { setUpAdmin } from "@/test/sliceB-admin";

import { httpAdminAdapter, invalidateAdminNavigation } from "./http-admin-adapter";

const AUTH = () => api.last()!.headers.authorization;

beforeEach(() => {
  setUpAdmin();
});

describe("products", () => {
  it("listProducts pages through the catalogue at 100 a page until it runs out", async () => {
    api.get(/^\/admin\/products/, (req) => {
      const page = Number(req.query.get("page"));
      if (page === 1) return ok([{ id: "P1" }], { page: 1, page_size: 100, total: 101, total_pages: 2 });
      return ok([{ id: "P2" }], { page: 2, page_size: 100, total: 101, total_pages: 2 });
    });
    const products = await httpAdminAdapter.listProducts();
    expect(products.map((p) => p.id)).toEqual(["P1", "P2"]);
    expect(api.requests("GET", "/admin/products")).toHaveLength(2);
  });

  it("listProducts stops as soon as a page comes back empty, even if totalPages claims more", async () => {
    api.get(/^\/admin\/products/, ok([], { page: 1, page_size: 100, total: 0, total_pages: 3 }));
    const products = await httpAdminAdapter.listProducts();
    expect(products).toHaveLength(0);
    expect(api.requests("GET", "/admin/products")).toHaveLength(1);
  });

  it("getProduct resolves null on a 404 rather than throwing", async () => {
    api.get("/admin/products/missing", fail(404));
    await expect(httpAdminAdapter.getProduct("missing")).resolves.toBeNull();
  });

  it("createProduct POSTs to /products with the admin token, not /admin/products", async () => {
    api.post("/products", { id: "P9" });
    await httpAdminAdapter.createProduct({ id: "", name: "Kurta", price: 100 } as never);
    const request = api.last("POST", "/products")!;
    expect(request.body).toMatchObject({ name: "Kurta", price: 100 });
    expect(request.headers.authorization).toBe("Bearer test-token");
  });

  it("updateProduct PUTs to /products/:id", async () => {
    api.put("/products/P1", { id: "P1" });
    await httpAdminAdapter.updateProduct({ id: "P1", name: "Kurta" } as never);
    expect(api.last("PUT", "/products/P1")).toBeTruthy();
  });

  it("deleteProduct DELETEs /products/:id", async () => {
    api.delete("/products/P1", {});
    await httpAdminAdapter.deleteProduct("P1");
    expect(api.last("DELETE", "/products/P1")).toBeTruthy();
  });
});

describe("categories and collections", () => {
  it("listCategories GETs with withCounts=true", async () => {
    api.get("/categories", []);
    await httpAdminAdapter.listCategories();
    expect(api.last()!.url).toContain("withCounts=true");
  });

  it("saveCategory POSTs a new one (no CAT-prefixed id)", async () => {
    api.post("/admin/categories", { id: "CAT1" });
    await httpAdminAdapter.saveCategory({ id: "", name: "Women", slug: "women", groups: [], order: 1 } as never);
    expect(api.last("POST", "/admin/categories")).toBeTruthy();
  });

  it("saveCategory PUTs an existing one (a CAT-prefixed id)", async () => {
    api.put("/admin/categories/CAT1", {});
    await httpAdminAdapter.saveCategory({ id: "CAT1", name: "Women", slug: "women", groups: [], order: 1 } as never);
    expect(api.last("PUT", "/admin/categories/CAT1")).toBeTruthy();
  });

  it("deleteCategory DELETEs /admin/categories/:id", async () => {
    api.delete("/admin/categories/CAT1", {});
    await httpAdminAdapter.deleteCategory("CAT1");
    expect(api.last("DELETE", "/admin/categories/CAT1")).toBeTruthy();
  });

  it("listCollections / saveCollection / deleteCollection mirror categories", async () => {
    api.get("/collections", []);
    await httpAdminAdapter.listCollections();
    expect(api.last("GET", "/collections")).toBeTruthy();

    api.post("/admin/collections", {});
    await httpAdminAdapter.saveCollection({ id: "", name: "Sale", slug: "sale", productIds: [] } as never);
    expect(api.last("POST", "/admin/collections")).toBeTruthy();

    api.delete("/admin/collections/COL1", {});
    await httpAdminAdapter.deleteCollection("COL1");
    expect(api.last("DELETE", "/admin/collections/COL1")).toBeTruthy();
  });
});

describe("inventory", () => {
  it("listInventory fills in a blank slug for every row", async () => {
    api.get("/admin/inventory", [{ productId: "P1", name: "Kurta", sku: "SKU1", category: "women", image: "", stock: 5, reserved: 0, available: 5, lowStockThreshold: 3, status: "in-stock" }]);
    const rows = await httpAdminAdapter.listInventory();
    expect(rows[0]).toMatchObject({ productId: "P1", slug: "" });
  });

  it("adjustStock PUTs the new quantity, reason and note", async () => {
    api.put("/admin/inventory/P1", { productId: "P1", name: "Kurta", sku: "SKU1", category: "women", image: "", stock: 10, reserved: 0, available: 10, lowStockThreshold: 3, status: "in-stock" });
    await httpAdminAdapter.adjustStock({ productId: "P1", newStock: 10, reason: "restock", note: "Refilled", at: "2024-01-01", by: "A1" });
    expect(api.last("PUT", "/admin/inventory/P1")!.body).toEqual({ quantity: 10, reason: "restock", note: "Refilled" });
  });

  it("listStockLog maps quantityAfter to newStock", async () => {
    api.get("/admin/inventory/log", [{ productId: "P1", reason: "restock", quantityAfter: 10, note: "n", by: "A1", at: "2024-01-01" }]);
    const rows = await httpAdminAdapter.listStockLog();
    expect(rows[0]).toMatchObject({ productId: "P1", newStock: 10 });
  });
});

describe("orders", () => {
  const API_ORDER = { id: "O1", orderNumber: "DCZ1", items: [{ productId: "P1" }] };

  it("listOrders renames items to lines and passes a customerId filter", async () => {
    api.get(/^\/admin\/orders/, [API_ORDER]);
    const orders = await httpAdminAdapter.listOrders("C1");
    expect((orders[0] as AdminOrder).lines).toEqual([{ productId: "P1" }]);
    expect(api.last()!.query.get("customerId")).toBe("C1");
  });

  it("listOrders omits the filter when no customerId is given", async () => {
    api.get(/^\/admin\/orders/, []);
    await httpAdminAdapter.listOrders();
    expect(api.last()!.query.has("customerId")).toBe(false);
  });

  it("getOrder resolves null on failure and maps items on success", async () => {
    api.get("/admin/orders/O1", API_ORDER);
    const order = await httpAdminAdapter.getOrder("O1");
    expect(order?.lines).toEqual([{ productId: "P1" }]);

    api.get("/admin/orders/O2", fail(404));
    await expect(httpAdminAdapter.getOrder("O2")).resolves.toBeNull();
  });

  it("updateOrderStatus PUTs status/note/confirm but never the actor", async () => {
    api.put("/admin/orders/O1/status", API_ORDER);
    await httpAdminAdapter.updateOrderStatus("O1", "shipped", "On its way", "admin-1", true);
    expect(api.last("PUT", "/admin/orders/O1/status")!.body).toEqual({ status: "shipped", note: "On its way", confirm: true });
  });

  it("updatePaymentStatus writes a synthetic note through the same status endpoint", async () => {
    api.put("/admin/orders/O1/status", API_ORDER);
    await httpAdminAdapter.updatePaymentStatus("O1", "paid");
    expect(api.last("PUT", "/admin/orders/O1/status")!.body).toEqual({ status: "paid", note: "Payment marked paid." });
  });

  it("sendPaymentLink POSTs with an empty body", async () => {
    api.post("/admin/orders/O1/payment-link", { url: "https://x/checkout/payment?payment=PAY1&online=1", shortUrl: "https://x/checkout/payment?payment=PAY1&online=1", paymentId: "PAY1", orderNumber: "DCZ1" });
    const link = await httpAdminAdapter.sendPaymentLink("O1");
    expect(link.paymentId).toBe("PAY1");
    expect(api.last("POST", "/admin/orders/O1/payment-link")!.body).toEqual({});
  });
});

describe("customers", () => {
  it("listCustomers / getCustomer / setCustomerStatus hit their endpoints with the admin token", async () => {
    api.get("/admin/customers", []);
    await httpAdminAdapter.listCustomers();
    expect(AUTH()).toBe("Bearer test-token");

    api.get("/admin/customers/C1", fail(404));
    await expect(httpAdminAdapter.getCustomer("C1")).resolves.toBeNull();

    api.put("/admin/customers/C1/status", { id: "C1", status: "blocked" });
    await httpAdminAdapter.setCustomerStatus("C1", "blocked");
    expect(api.last("PUT", "/admin/customers/C1/status")!.body).toEqual({ status: "blocked" });
  });
});

describe("coupons", () => {
  it("saveCoupon writes then re-reads the list to pick up the server's derived status", async () => {
    let listCall = 0;
    api.get("/admin/coupons", () => {
      listCall += 1;
      return [{ id: "CPN1", code: "SAVE10", status: "active" }];
    });
    api.post("/admin/coupons", { id: "CPN1" });
    const saved = await httpAdminAdapter.saveCoupon({ id: "", code: "SAVE10" } as AdminCoupon);
    expect((saved as AdminCoupon).status).toBe("active");
    expect(listCall).toBe(1);
  });

  it("saveCoupon PUTs when the id already starts with CPN", async () => {
    api.get("/admin/coupons", [{ id: "CPN1", code: "SAVE10" }]);
    api.put("/admin/coupons/CPN1", { id: "CPN1" });
    await httpAdminAdapter.saveCoupon({ id: "CPN1", code: "SAVE10" } as AdminCoupon);
    expect(api.last("PUT", "/admin/coupons/CPN1")).toBeTruthy();
  });

  it("falls back to the submitted coupon when the re-read doesn't contain it", async () => {
    api.get("/admin/coupons", []);
    api.post("/admin/coupons", { id: "CPN9" });
    const saved = await httpAdminAdapter.saveCoupon({ id: "", code: "SAVE20" } as AdminCoupon);
    expect(saved).toMatchObject({ id: "CPN9", code: "SAVE20" });
  });

  it("deleteCoupon DELETEs /admin/coupons/:id", async () => {
    api.delete("/admin/coupons/CPN1", {});
    await httpAdminAdapter.deleteCoupon("CPN1");
    expect(api.last("DELETE", "/admin/coupons/CPN1")).toBeTruthy();
  });
});

describe("reviews", () => {
  it("setReviewStatus PUTs the status, then re-reads to return the full row", async () => {
    api.put("/admin/reviews/R1", {});
    api.get("/admin/reviews", [{ id: "R1", status: "approved" }]);
    const review = await httpAdminAdapter.setReviewStatus("R1", "approved");
    expect(review).toMatchObject({ id: "R1", status: "approved" });
    expect(api.last("PUT", "/admin/reviews/R1")!.body).toEqual({ status: "approved" });
  });

  it("deleteReview DELETEs /admin/reviews/:id", async () => {
    api.delete("/admin/reviews/R1", {});
    await httpAdminAdapter.deleteReview("R1");
    expect(api.last("DELETE", "/admin/reviews/R1")).toBeTruthy();
  });
});

describe("homepage and banners", () => {
  it("saveHomepage sends only the editable fields per section", async () => {
    api.put("/admin/homepage", []);
    await httpAdminAdapter.saveHomepage([
      { id: "S1", type: "product-grid", title: "New in", subtitle: "", source: "new-arrivals", limit: 6, active: true, displayOrder: 1 } as AdminHomeSection,
    ]);
    expect(api.last("PUT", "/admin/homepage")!.body).toEqual([
      { id: "S1", active: true, displayOrder: 1, title: "New in", subtitle: "" },
    ]);
  });

  it("saveBanner POSTs a new banner, PUTs a BNR-prefixed one", async () => {
    api.post("/admin/banners", {});
    await httpAdminAdapter.saveBanner({ id: "", title: "Sale" } as AdminBanner);
    expect(api.last("POST", "/admin/banners")).toBeTruthy();

    api.put("/admin/banners/BNR1", {});
    await httpAdminAdapter.saveBanner({ id: "BNR1", title: "Sale" } as AdminBanner);
    expect(api.last("PUT", "/admin/banners/BNR1")).toBeTruthy();
  });

  it("deleteBanner DELETEs /admin/banners/:id", async () => {
    api.delete("/admin/banners/BNR1", {});
    await httpAdminAdapter.deleteBanner("BNR1");
    expect(api.last("DELETE", "/admin/banners/BNR1")).toBeTruthy();
  });
});

describe("analytics and dashboard", () => {
  it("getAnalytics maps byCategory/topProducts/orderStatus and defaults null deltas to zero", async () => {
    api.get("/admin/reports", {
      range: "30d", revenue: 1000, orders: 10, customers: 5, unitsSold: 20, averageOrderValue: 100,
      revenueDelta: null, ordersDelta: null,
      series: [], byCategory: [{ label: "Women", value: 500, units: 10 }],
      topProducts: [{ productId: "P1", name: "Kurta", sku: "SKU1", units: 5, revenue: 500, stock: 10 }],
      orderStatus: [{ label: "delivered", value: 3 }],
    });
    const snapshot = await httpAdminAdapter.getAnalytics("30d");
    expect(snapshot.revenueDelta).toBe(0);
    expect(snapshot.ordersDelta).toBe(0);
    expect(snapshot.byCategory).toEqual([{ category: "Women", revenue: 500, units: 10 }]);
    expect(snapshot.topProducts[0]).toMatchObject({ productId: "P1", name: "Kurta", unitsSold: 5 });
    expect(snapshot.byStatus).toEqual([{ status: "delivered", count: 3 }]);
    expect(api.last()!.url).toContain("range=30d");
  });

  it("getAnalytics keeps real deltas instead of zeroing them", async () => {
    api.get("/admin/reports", {
      range: "7d", revenue: 0, orders: 0, customers: 0, unitsSold: 0, averageOrderValue: 0,
      revenueDelta: -12.5, ordersDelta: 4,
      series: [], byCategory: [], topProducts: [], orderStatus: [],
    });
    const snapshot = await httpAdminAdapter.getAnalytics("7d");
    expect(snapshot.revenueDelta).toBe(-12.5);
    expect(snapshot.ordersDelta).toBe(4);
  });

  it("getDashboard defaults recentOrders and lowStock to empty arrays, and maps order lines", async () => {
    api.get("/admin/dashboard", { stats: [], generatedAt: "2024-01-01", recentOrders: [{ id: "O1", items: [{ productId: "P1" }] }] });
    const dashboard = await httpAdminAdapter.getDashboard();
    expect(dashboard.recentOrders[0]!.lines).toEqual([{ productId: "P1" }]);
    expect(dashboard.lowStock).toEqual([]);
  });
});

describe("settings and admin users", () => {
  it("getSettings / saveSettings use /admin/settings/store", async () => {
    api.get("/admin/settings/store", {});
    await httpAdminAdapter.getSettings();
    expect(api.last("GET", "/admin/settings/store")).toBeTruthy();

    api.put("/admin/settings/store", {});
    await httpAdminAdapter.saveSettings({} as never);
    expect(api.last("PUT", "/admin/settings/store")).toBeTruthy();
  });

  it("saveAdminUser POSTs a user with no id, PUTs an ADM-prefixed one, and sends the password only when given", async () => {
    api.post("/admin/users", {});
    await httpAdminAdapter.saveAdminUser({ id: "", name: "New" } as never);
    expect(api.last("POST", "/admin/users")!.body).toEqual({ id: "", name: "New" });

    api.put("/admin/users/ADM1", {});
    await httpAdminAdapter.saveAdminUser({ id: "ADM1", name: "Existing" } as never, "newpassword");
    expect(api.last("PUT", "/admin/users/ADM1")!.body).toMatchObject({ password: "newpassword" });
  });

  it("deleteAdminUser DELETEs /admin/users/:id", async () => {
    api.delete("/admin/users/ADM1", {});
    await httpAdminAdapter.deleteAdminUser("ADM1");
    expect(api.last("DELETE", "/admin/users/ADM1")).toBeTruthy();
  });
});

describe("notifications", () => {
  it("lists, marks one read, and marks all read", async () => {
    api.get("/admin/notifications", []);
    await httpAdminAdapter.listNotifications();
    expect(api.last("GET", "/admin/notifications")).toBeTruthy();

    api.put("/admin/notifications/N1/read", {});
    await httpAdminAdapter.markNotificationRead("N1");
    expect(api.last("PUT", "/admin/notifications/N1/read")).toBeTruthy();

    api.put("/admin/notifications/read-all", {});
    await httpAdminAdapter.markAllNotificationsRead();
    expect(api.last("PUT", "/admin/notifications/read-all")).toBeTruthy();
  });
});

describe("navigation", () => {
  it("caches the sidebar for the document, and invalidate forces a fresh read", async () => {
    let calls = 0;
    api.get("/admin/navigation", () => {
      calls += 1;
      return [];
    });
    await httpAdminAdapter.getNavigation();
    await httpAdminAdapter.getNavigation();
    expect(calls).toBe(1);

    invalidateAdminNavigation();
    await httpAdminAdapter.getNavigation();
    expect(calls).toBe(2);
  });

  it("getNavCounts GETs /admin/nav-counts", async () => {
    api.get("/admin/nav-counts", { lowStock: 1, openOrders: 2, pendingReviews: 0, openReturns: 0, openTickets: 0, pendingQuestions: 0, referralsInReview: 0, failedNotifications: 0 });
    const counts = await httpAdminAdapter.getNavCounts();
    expect(counts.lowStock).toBe(1);
  });
});
