import { beforeEach, describe, expect, it } from "vitest";

import { api } from "@/test/api";
import { setUpAdmin } from "@/test/sliceB-admin";

import { EMPTY_SEARCH_RESULTS, listNotifications, markAllNotificationsRead, markNotificationRead, search } from "./adminSearchService";

const PRODUCT = { id: "P1", name: "Cotton Kurta", sku: "SKU1", brand: "Daily Choice", category: "women", subcategory: "kurtas" };
const ORDER = { id: "O1", orderNumber: "DCZ100", customerName: "Asha Menon", customerEmail: "asha@x.com", status: "pending" };
const CUSTOMER = { id: "C1", firstName: "Asha", lastName: "Menon", email: "asha@x.com", phone: "9999999999" };
const INVOICE = { id: "I1", invoiceNumber: "INV-1", customerName: "Asha", breakdown: { grandTotal: 10000 } };
const PAYMENT = { id: "PAY1", transactionId: "TXN1", customerName: "Asha", amount: 10000 };
const REFUND = { id: "R1", refundNumber: "RFD-1", customerName: "Asha", amount: 500 };

beforeEach(() => {
  setUpAdmin();
  api.get(/^\/admin\/products/, [PRODUCT]);
  api.get(/^\/admin\/orders/, [ORDER]);
  api.get("/admin/customers", [CUSTOMER]);
  api.get(/^\/admin\/billing\/invoices/, [INVOICE]);
  api.get(/^\/admin\/billing\/payments/, [PAYMENT]);
  api.get(/^\/admin\/billing\/refunds/, [REFUND]);
});

describe("search", () => {
  it("is empty for a term shorter than two characters, without calling anything", async () => {
    const result = await search("a");
    expect(result).toEqual(EMPTY_SEARCH_RESULTS);
    expect(api.calls).toHaveLength(0);
  });

  it("matches a product by name, sku, brand, category or subcategory", async () => {
    const result = await search("kurta");
    expect(result.products).toHaveLength(1);
    expect(result.products[0]).toMatchObject({ kind: "product", id: "P1", title: "Cotton Kurta", href: "/admin/products/edit?id=P1" });
  });

  it("requires every word to match (an AND search)", async () => {
    const result = await search("cotton skirt");
    expect(result.products).toHaveLength(0);
  });

  it("matches orders, customers and shapes billing hits straight through", async () => {
    const result = await search("asha");
    expect(result.customers[0]).toMatchObject({ kind: "customer", title: "Asha Menon", subtitle: "asha@x.com" });
    expect(result.orders[0]).toMatchObject({ kind: "order", title: "DCZ100" });
    expect(result.invoices[0]).toMatchObject({ kind: "invoice", href: "/admin/billing/invoices/detail?id=I1" });
    expect(result.payments[0]).toMatchObject({ kind: "payment", href: "/admin/billing/payments/detail?id=PAY1" });
    expect(result.refunds[0]).toMatchObject({ kind: "refund", href: "/admin/billing/refunds" });
  });

  it("totals every group's hits", async () => {
    const result = await search("asha");
    expect(result.total).toBe(result.products.length + result.orders.length + result.customers.length + result.invoices.length + result.payments.length + result.refunds.length);
  });

  it("caps each group at perGroup", async () => {
    api.get("/admin/customers", [CUSTOMER, { ...CUSTOMER, id: "C2" }, { ...CUSTOMER, id: "C3" }]);
    const result = await search("asha", 2);
    expect(result.customers).toHaveLength(2);
  });

  it("is case-insensitive", async () => {
    const result = await search("KURTA");
    expect(result.products).toHaveLength(1);
  });
});

describe("notifications", () => {
  it("lists, marks one read and marks all read", async () => {
    api.get("/admin/notifications", []);
    await listNotifications();
    expect(api.last("GET", "/admin/notifications")).toBeTruthy();

    api.put("/admin/notifications/N1/read", {});
    await markNotificationRead("N1");
    expect(api.last("PUT", "/admin/notifications/N1/read")).toBeTruthy();

    api.put("/admin/notifications/read-all", {});
    await markAllNotificationsRead();
    expect(api.last("PUT", "/admin/notifications/read-all")).toBeTruthy();
  });
});
