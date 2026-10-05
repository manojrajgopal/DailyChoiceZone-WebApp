import { beforeEach, describe, expect, it } from "vitest";

import type { AdminOrder } from "@/types/admin";

import { api, fail } from "@/test/api";
import { setUpAdmin } from "@/test/sliceB-admin";

import * as orders from "./orderAdminService";

function order(overrides: Partial<AdminOrder> = {}): AdminOrder {
  return {
    id: "O1",
    orderNumber: "DCZ1",
    customerId: "C1",
    customerName: "A",
    customerEmail: "a@b.com",
    placedAt: "2024-01-01",
    status: "pending",
    paymentStatus: "pending",
    paymentMethod: "cod",
    lines: [],
    shippingAddress: {} as never,
    totals: {} as never,
    timeline: [],
    trackingNumber: null,
    ...overrides,
  };
}

beforeEach(() => {
  setUpAdmin();
});

describe("listOrders / getOrder", () => {
  it("GETs their own endpoints", async () => {
    api.get(/^\/admin\/orders/, []);
    await orders.listOrders();
    expect(api.last("GET", "/admin/orders")!.headers.authorization).toBe("Bearer test-token");

    api.get("/admin/orders/O1", { id: "O1", items: [] });
    await expect(orders.getOrder("O1")).resolves.toMatchObject({ id: "O1" });
  });
});

describe("updateOrderStatus", () => {
  it("refuses when the order no longer exists", async () => {
    api.get("/admin/orders/missing", fail(404));
    const result = await orders.updateOrderStatus("missing", "confirmed", "", "A1");
    expect(result).toEqual({ ok: false, reason: "That order no longer exists." });
  });

  it("refuses a no-op move to the same status", async () => {
    api.get("/admin/orders/O1", { id: "O1", items: [], status: "pending" });
    const result = await orders.updateOrderStatus("O1", "pending", "", "A1");
    expect(result).toEqual({ ok: false, reason: "This order is already pending." });
  });

  it("leaves legality to the server and shows its message", async () => {
    api.get("/admin/orders/O1", { id: "O1", items: [], status: "confirmed" });
    api.put(
      "/admin/orders/O1/status",
      fail(409, "Order cannot be moved directly from Confirmed to Delivered.", "INVALID_TRANSITION"),
    );
    const result = await orders.updateOrderStatus("O1", "delivered", "", "A1");
    expect(result).toEqual({ ok: false, reason: "Order cannot be moved directly from Confirmed to Delivered." });
  });

  it("writes an allowed move, never asking to confirm a skip", async () => {
    api.get("/admin/orders/O1", { id: "O1", items: [], status: "pending" });
    api.put("/admin/orders/O1/status", { id: "O1", items: [], status: "confirmed" });
    const result = await orders.updateOrderStatus("O1", "confirmed", "Paid", "A1");
    expect(result.ok).toBe(true);
    expect(api.last("PUT", "/admin/orders/O1/status")!.body).toMatchObject({ status: "confirmed", note: "Paid" });
  });
});

describe("updatePaymentStatus", () => {
  it("refuses when the order no longer exists", async () => {
    api.get("/admin/orders/missing", fail(404));
    const result = await orders.updatePaymentStatus("missing", "paid");
    expect(result).toEqual({ ok: false, reason: "That order no longer exists." });
  });

  it("writes the payment status", async () => {
    api.get("/admin/orders/O1", { id: "O1", items: [] });
    api.put("/admin/orders/O1/status", { id: "O1", items: [], paymentStatus: "paid" });
    const result = await orders.updatePaymentStatus("O1", "paid");
    expect(result.ok).toBe(true);
    expect(api.last("PUT", "/admin/orders/O1/status")!.body).toEqual({ status: "paid", note: "Payment marked paid." });
  });
});

describe("canSendPaymentLink", () => {
  it.each([
    [{ paymentMethod: "cod", paymentStatus: "pending", status: "confirmed" }, true],
    [{ paymentMethod: "upi", paymentStatus: "pending", status: "confirmed" }, false],
    [{ paymentMethod: "cod", paymentStatus: "paid", status: "confirmed" }, false],
    [{ paymentMethod: "cod", paymentStatus: "pending", status: "cancelled" }, false],
    [{ paymentMethod: "cod", paymentStatus: "pending", status: "delivered" }, false],
  ])("%j -> %s", (partial, expected) => {
    expect(orders.canSendPaymentLink(order(partial as Partial<AdminOrder>))).toBe(expected);
  });
});

describe("sendPaymentLink", () => {
  it("resolves ok with the link on success", async () => {
    api.post("/admin/orders/O1/payment-link", { url: "https://x/checkout/payment?payment=PAY1&online=1", shortUrl: "https://x/checkout/payment?payment=PAY1&online=1", paymentId: "PAY1", orderNumber: "DCZ1" });
    const result = await orders.sendPaymentLink("O1");
    expect(result).toEqual({ ok: true, data: { url: "https://x/checkout/payment?payment=PAY1&online=1", shortUrl: "https://x/checkout/payment?payment=PAY1&online=1", paymentId: "PAY1", orderNumber: "DCZ1" } });
  });

  it("surfaces the server's error message on failure", async () => {
    api.post("/admin/orders/O1/payment-link", fail(422, "This order is not cash on delivery"));
    const result = await orders.sendPaymentLink("O1");
    expect(result).toEqual({ ok: false, reason: "This order is not cash on delivery" });
  });

  it("falls back to a generic message when the server gives none", async () => {
    api.post("/admin/orders/O1/payment-link", fail(500, ""));
    const result = await orders.sendPaymentLink("O1");
    expect(result).toEqual({ ok: false, reason: "The payment link could not be sent." });
  });
});
