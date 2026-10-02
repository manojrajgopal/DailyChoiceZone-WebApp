import { beforeEach, describe, expect, it } from "vitest";

import type { Address, DeliveryMethod, PaymentMethod, PlaceOrderInput } from "@/types";
import { api, fail, ok } from "@/test/api";

import {
  cancelOrder,
  getDeliveryMethod,
  getOrder,
  getOrders,
  getPaymentMethod,
  placeOrder,
  setDeliveryMethods,
  setPaymentMethods,
} from "./orderService";

const DELIVERY: DeliveryMethod = { id: "standard", name: "Standard", description: "3-5 days", fee: 0, estimate: "3-5 business days" };
const PAYMENT: PaymentMethod = { id: "upi", name: "UPI", description: "" };

const ADDRESS: Address = {
  id: "A1", fullName: "Asha Rao", phone: "9876543210", line1: "221B Baker Street", line2: "",
  city: "Bengaluru", state: "Karnataka", pincode: "560001", type: "home", isDefault: true,
};

function apiOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "O1",
    orderNumber: "DCZ-O1",
    placedAt: "2026-09-01T10:00:00Z",
    status: "pending",
    paymentStatus: "pending",
    paymentMethod: "upi",
    deliveryMethod: "standard",
    expectedDelivery: "2026-09-05",
    items: [
      { productId: "P1", name: "Shirt", slug: "shirt", image: "", brand: "DCZ", size: "M", color: "Red", quantity: 1, unitPrice: 50000, lineTotal: 50000 },
    ],
    totals: { itemCount: 1, subtotal: 50000, catalogueSavings: 0, couponDiscount: 0, deliveryFee: 0, taxAmount: 0, total: 50000 },
    shippingAddress: { fullName: "Asha Rao", phone: "9876543210", line1: "221B Baker Street", line2: "", city: "Bengaluru", state: "Karnataka", pincode: "560001", country: "India" },
    couponCode: null,
    invoiceId: "INV1",
    invoiceNumber: "DCZ-INV-1",
    ...overrides,
  };
}

beforeEach(() => {
  // Pre-populate so `methodsLoaded()` short-circuits rather than dynamically
  // importing siteService and hitting the network — these tests are about
  // orderService's own mapping, not site content loading.
  setDeliveryMethods([DELIVERY]);
  setPaymentMethods([PAYMENT]);
});

describe("placeOrder", () => {
  it("POSTs the shipping details, methods, coupon and extras — never prices", async () => {
    api.post("/orders", (req) => ({
      order: apiOrder(),
      invoiceId: "INV1",
      invoiceNumber: "DCZ-INV-1",
      paymentId: "PAY1",
      paymentStatus: "paid",
      gateway: null,
      echo: req.body,
    }));

    const input: PlaceOrderInput = {
      lines: [],
      totals: { itemCount: 1, subtotal: 500, catalogueSavings: 0, couponDiscount: 0, deliveryFee: 0, total: 500, freeDeliveryShortfall: 0, appliedCoupon: { code: "SAVE10", description: "", type: "percent", value: 10, minSubtotal: 0 } },
      address: ADDRESS,
      deliveryMethod: DELIVERY,
      paymentMethod: PAYMENT,
      email: "asha@example.com",
      giftCardCodes: ["GC1"],
      useStoreCredit: true,
      points: 50,
      expectedTotal: 50000,
    };

    const result = await placeOrder(input);

    expect(result.order.id).toBe("O1");
    expect(result.paymentId).toBe("PAY1");
    expect(result.gateway).toBeNull();
    const body = api.last("POST", "/orders")!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      deliveryMethod: "standard",
      paymentMethod: "upi",
      couponCode: "SAVE10",
      email: "asha@example.com",
      saveAddress: true,
      giftCardCodes: ["GC1"],
      useStoreCredit: true,
      points: 50,
      expectedTotal: 50000,
    });
    expect(body).not.toHaveProperty("totals");
    expect(body).not.toHaveProperty("lines");
  });

  it("sends billingAddress null and couponCode null by default", async () => {
    api.post("/orders", { order: apiOrder(), invoiceId: "I", invoiceNumber: "N", paymentId: "P", paymentStatus: "paid", gateway: null });
    const input: PlaceOrderInput = {
      lines: [], totals: { itemCount: 1, subtotal: 500, catalogueSavings: 0, couponDiscount: 0, deliveryFee: 0, total: 500, freeDeliveryShortfall: 0, appliedCoupon: null },
      address: ADDRESS, deliveryMethod: DELIVERY, paymentMethod: PAYMENT, email: "a@b.com",
    };
    await placeOrder(input);
    const body = api.last()!.body as Record<string, unknown>;
    expect(body.billingAddress).toBeNull();
    expect(body.couponCode).toBeNull();
    expect(body.giftCardCodes).toEqual([]);
    expect(body.useStoreCredit).toBe(false);
    expect(body.points).toBe(0);
  });

  it("returns a gateway handoff when payment is still pending", async () => {
    const gateway = { provider: "razorpay" as const, keyId: "rzp_test", orderReference: "order_x", paymentId: "PAY1", amount: 50000, currency: "INR", name: "Asha", email: "a@b.com", phone: "999", description: "", expiresAt: null, secondsLeft: null };
    api.post("/orders", { order: apiOrder(), invoiceId: "I", invoiceNumber: "N", paymentId: "PAY1", paymentStatus: "pending", gateway });
    const input: PlaceOrderInput = {
      lines: [], totals: { itemCount: 1, subtotal: 500, catalogueSavings: 0, couponDiscount: 0, deliveryFee: 0, total: 500, freeDeliveryShortfall: 0, appliedCoupon: null },
      address: ADDRESS, deliveryMethod: DELIVERY, paymentMethod: PAYMENT, email: "a@b.com",
    };
    const result = await placeOrder(input);
    expect(result.gateway).toEqual(gateway);
  });

  it("propagates a rejected order (e.g. price changed)", async () => {
    api.post("/orders", fail(409, "Prices changed since you loaded this page."));
    const input: PlaceOrderInput = {
      lines: [], totals: { itemCount: 1, subtotal: 500, catalogueSavings: 0, couponDiscount: 0, deliveryFee: 0, total: 500, freeDeliveryShortfall: 0, appliedCoupon: null },
      address: ADDRESS, deliveryMethod: DELIVERY, paymentMethod: PAYMENT, email: "a@b.com",
    };
    await expect(placeOrder(input)).rejects.toMatchObject({ status: 409 });
  });
});

describe("getOrders", () => {
  it("GETs and maps every order", async () => {
    api.get("/orders", ok([apiOrder({ id: "O1" }), apiOrder({ id: "O2" })]));
    const result = await getOrders();
    expect(result.map((o) => o.id)).toEqual(["O1", "O2"]);
    expect(result[0]!.deliveryMethod).toMatchObject({ id: "standard", name: "Standard" });
    expect(result[0]!.paymentMethod).toMatchObject({ id: "upi", name: "UPI" });
  });

  it("is an empty list rather than throwing when the request fails", async () => {
    api.get("/orders", fail(401));
    await expect(getOrders()).resolves.toEqual([]);
  });

  it("maps bundle and flash-sale fields, defaulting when absent", async () => {
    api.get("/orders", ok([apiOrder({ items: [{ productId: "P1", name: "Shirt", slug: "s", image: "", brand: "B", size: null, color: null, quantity: 1, unitPrice: 100, lineTotal: 100 }] })]));
    const [order] = await getOrders();
    expect(order!.lines[0]).toMatchObject({ bundleName: "", bundleQuantity: 0, regularUnitPrice: null, flashSaleId: null });
  });
});

describe("getOrder", () => {
  it("GETs a single order by id/number", async () => {
    api.get("/orders/O1", apiOrder({ id: "O1" }));
    const result = await getOrder("O1");
    expect(result?.id).toBe("O1");
  });

  it("is null for an unknown order", async () => {
    api.get("/orders/missing", fail(404));
    expect(await getOrder("missing")).toBeNull();
  });
});

describe("cancelOrder", () => {
  it("POSTs the reason and maps the updated order", async () => {
    api.post("/orders/O1/cancel", (req) => apiOrder({ status: "cancelled", echo: req.body }));
    const result = await cancelOrder("O1", "Changed my mind");
    expect(result.status).toBe("cancelled");
    expect(api.last()!.body).toEqual({ reason: "Changed my mind" });
  });

  it("defaults the reason to an empty string", async () => {
    api.post("/orders/O1/cancel", apiOrder({ status: "cancelled" }));
    await cancelOrder("O1");
    expect(api.last()!.body).toEqual({ reason: "" });
  });
});

describe("methodsLoaded fallback", () => {
  it("still maps the order (with raw ids) when the method lists are empty and siteService can't load them", async () => {
    // Undo the beforeEach's pre-population for this one test, so the order
    // mapper has to go through methodsLoaded()'s dynamic import of
    // siteService — which itself fails here, and is swallowed.
    setDeliveryMethods([]);
    setPaymentMethods([]);
    api.get("/site/content", fail(500));
    api.get("/orders/O1", apiOrder({ id: "O1", deliveryMethod: "standard", paymentMethod: "upi" }));

    const result = await getOrder("O1");

    expect(result?.deliveryMethod.id).toBe("standard");
    expect(result?.paymentMethod.id).toBe("upi");
  });
});

describe("getDeliveryMethod / getPaymentMethod", () => {
  it("finds a configured method by id", () => {
    expect(getDeliveryMethod("standard")).toEqual(DELIVERY);
    expect(getPaymentMethod("upi")).toEqual(PAYMENT);
  });

  it("falls back to a record carrying the raw id for an unknown method", () => {
    expect(getDeliveryMethod("withdrawn")).toEqual({ id: "withdrawn", name: "withdrawn", description: "", fee: 0, estimate: "" });
  });

  it("falls back to a standard label (not the raw id) for an unknown payment method", () => {
    expect(getPaymentMethod("cod")).toMatchObject({ id: "cod", name: "Cash on delivery" });
  });
});
