import { describe, expect, it } from "vitest";

import type { CartLine } from "@/types";
import { makeProduct } from "@/test/sliceA-fixtures";
import { api, fail, networkError, ok } from "@/test/api";

import type { ServerCart } from "./cartService";
import {
  addToCart,
  applyCoupon,
  buildLineId,
  clearCart,
  fetchCart,
  fetchCartCount,
  getCoupons,
  isPurchasable,
  mergeGuestCart,
  openRecoveryLink,
  removeBundle,
  removeFromCart,
  resolveGuestCart,
  setBundleQuantity,
  setCartQuantity,
} from "./cartService";

function serverCart(overrides: Partial<ServerCart> = {}): ServerCart {
  return {
    items: [
      {
        id: 1,
        productId: "P1",
        size: "M",
        color: "Red",
        quantity: 2,
        product: makeProduct({ id: "P1", price: 500, originalPrice: 600 }),
        lineTotal: 100000, // paise
      },
    ],
    breakdown: {
      currency: "INR",
      itemCount: 2,
      subtotal: 100000,
      productDiscount: 0,
      couponDiscount: 0,
      couponCode: null,
      shipping: 5000,
      otherCharges: 0,
      taxableAmount: 100000,
      tax: { mode: "intra-state", taxableAmount: 100000, cgst: 0, sgst: 0, igst: 0, totalTax: 0, ratePercent: 0 },
      grandTotal: 105000,
      pricesIncludeTax: false,
    },
    freeDeliveryShortfall: 10000,
    appliedCoupon: null,
    ...overrides,
  };
}

describe("fetchCart", () => {
  it("GETs the priced cart with coupon/delivery/pincode query params and maps money to rupees", async () => {
    api.get("/cart", ok(serverCart()));
    const result = await fetchCart({ couponCode: "SAVE10", deliveryMethod: "express", placeOfSupply: "KA", pincode: "560001" });

    const request = api.last("GET", "/cart")!;
    expect(request.query.get("coupon")).toBe("SAVE10");
    expect(request.query.get("deliveryMethod")).toBe("express");
    expect(request.query.get("placeOfSupply")).toBe("KA");
    expect(request.query.get("pincode")).toBe("560001");
    expect(request.headers.authorization).toBeUndefined(); // no token set in this test

    expect(result.totals.subtotal).toBe(1000);
    expect(result.totals.deliveryFee).toBe(50);
    expect(result.totals.total).toBe(1050);
    expect(result.lines[0]).toMatchObject({ lineId: "1", productId: "P1", lineTotal: 1000 });
  });

  it("sends the customer's auth header", async () => {
    window.localStorage.setItem("dcz:auth-token", "cust");
    api.get("/cart", ok(serverCart()));
    await fetchCart({});
    expect(api.last()!.headers.authorization).toBe("Bearer cust");
  });

  it("defaults optional fields to null/empty in the view", async () => {
    api.get("/cart", ok(serverCart()));
    const result = await fetchCart({});
    expect(result.couponError).toBeNull();
    expect(result.membership).toBeNull();
    expect(result.delivery).toBeNull();
    expect(result.bundles).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it("maps an applied coupon through to totals and coupon", async () => {
    api.get("/cart", ok(serverCart({
      appliedCoupon: { code: "SAVE10", description: "10% off", type: "percent", value: 10, minSubtotal: 0, maxDiscount: 200, discount: 100 },
    })));
    const result = await fetchCart({});
    expect(result.coupon).toEqual({ code: "SAVE10", description: "10% off", type: "percent", value: 10, minSubtotal: 0, maxDiscount: 200 });
  });

  it("defaults maxDiscount to undefined when the applied coupon has none", async () => {
    api.get("/cart", ok(serverCart({
      appliedCoupon: { code: "SAVE10", description: "", type: "percent", value: 10, minSubtotal: 0, discount: 100 },
    })));
    const result = await fetchCart({});
    expect(result.coupon?.maxDiscount).toBeUndefined();
  });

  it("propagates a server failure", async () => {
    api.get("/cart", fail(500));
    await expect(fetchCart({})).rejects.toMatchObject({ status: 500 });
  });
});

describe("fetchCartCount", () => {
  it("GETs just the item count", async () => {
    api.get("/cart/count", { itemCount: 5 });
    expect(await fetchCartCount()).toBe(5);
  });
});

describe("addToCart", () => {
  it("POSTs the variant and quantity, defaulting quantity to 1 and variant fields to null", async () => {
    api.post("/cart/items", (req) => serverCart({ items: [] }) as unknown as object ?? req.body);
    await addToCart({ productId: "P1" });
    expect(api.last("POST", "/cart/items")!.body).toEqual({ productId: "P1", size: null, color: null, quantity: 1 });
  });

  it("sends an explicit size/color/quantity", async () => {
    api.post("/cart/items", serverCart());
    await addToCart({ productId: "P1", size: "L", color: "Blue", quantity: 3 });
    expect(api.last()!.body).toEqual({ productId: "P1", size: "L", color: "Blue", quantity: 3 });
  });
});

describe("setCartQuantity / removeFromCart / clearCart", () => {
  it("PUTs the new quantity for a line", async () => {
    api.put("/cart/items/1", serverCart());
    await setCartQuantity("1", 5);
    expect(api.last("PUT", "/cart/items/1")!.body).toEqual({ quantity: 5 });
  });

  it("DELETEs a line", async () => {
    api.delete("/cart/items/1", serverCart());
    const result = await removeFromCart("1");
    expect(result.lines).toHaveLength(1);
  });

  it("DELETEs the whole cart", async () => {
    api.delete("/cart", serverCart({ items: [] }));
    const result = await clearCart();
    expect(result.lines).toEqual([]);
  });
});

describe("setBundleQuantity / removeBundle", () => {
  it("PUTs a bundle's new quantity", async () => {
    api.put("/cart/bundles/9", serverCart());
    await setBundleQuantity(9, 2);
    expect(api.last("PUT", "/cart/bundles/9")!.body).toEqual({ quantity: 2 });
  });

  it("DELETEs a bundle", async () => {
    api.delete("/cart/bundles/9", serverCart());
    const result = await removeBundle(9);
    expect(result.lines).toHaveLength(1);
  });
});

describe("mergeGuestCart", () => {
  const lines: CartLine[] = [
    { lineId: "a", productId: "P1", size: "M", color: null, quantity: 1, addedAt: 1 },
    { lineId: "b", productId: "P2", size: null, color: null, quantity: 2, addedAt: 2 },
  ];

  it("posts every line to addToCart", async () => {
    api.post("/cart/items", serverCart());
    await mergeGuestCart(lines);
    expect(api.requests("POST", "/cart/items")).toHaveLength(2);
    expect(api.requests("POST", "/cart/items")[0]!.body).toMatchObject({ productId: "P1" });
    expect(api.requests("POST", "/cart/items")[1]!.body).toMatchObject({ productId: "P2" });
  });

  it("skips a line that fails and still processes the rest", async () => {
    api.post("/cart/items", (req) => {
      if ((req.body as { productId: string }).productId === "P1") return fail(409, "Sold out");
      return ok(serverCart());
    });
    await expect(mergeGuestCart(lines)).resolves.toBeUndefined();
    expect(api.requests("POST", "/cart/items")).toHaveLength(2);
  });
});

describe("resolveGuestCart", () => {
  it("is empty with no lines, and makes no request", async () => {
    expect(await resolveGuestCart([])).toEqual([]);
    expect(api.calls).toHaveLength(0);
  });

  it("resolves products, clamps quantity to stock, and sorts by addedAt", async () => {
    api.get("/products/A", makeProduct({ id: "A", price: 100, originalPrice: 120, stock: 2 }));
    api.get("/products/B", makeProduct({ id: "B", price: 200, originalPrice: 200, stock: 10 }));
    const lines: CartLine[] = [
      { lineId: "b", productId: "B", size: null, color: null, quantity: 1, addedAt: 2 },
      { lineId: "a", productId: "A", size: null, color: null, quantity: 5, addedAt: 1 },
    ];
    const result = await resolveGuestCart(lines);
    expect(result.map((l) => l.productId)).toEqual(["A", "B"]);
    expect(result[0]!.quantity).toBe(2); // clamped to stock
    expect(result[0]!.lineTotal).toBe(200);
    expect(result[0]!.lineOriginalTotal).toBe(240);
  });

  it("drops a line whose product can no longer be found", async () => {
    api.get("/products/missing", fail(404));
    const lines: CartLine[] = [{ lineId: "x", productId: "missing", size: null, color: null, quantity: 1, addedAt: 1 }];
    expect(await resolveGuestCart(lines)).toEqual([]);
  });

  it("clamps quantity up to at least 1 even for an out-of-stock product", async () => {
    api.get("/products/A", makeProduct({ id: "A", stock: 0 }));
    const lines: CartLine[] = [{ lineId: "a", productId: "A", size: null, color: null, quantity: 5, addedAt: 1 }];
    const result = await resolveGuestCart(lines);
    expect(result[0]!.quantity).toBe(1);
  });
});

describe("applyCoupon", () => {
  it("rejects an empty or whitespace-only code without a request", async () => {
    expect(await applyCoupon("   ", 1000)).toEqual({ ok: false, reason: "Enter a coupon code." });
    expect(api.calls).toHaveLength(0);
  });

  it("upper-cases and trims the code, and sends subtotal in paise", async () => {
    api.post("/coupons/validate", (req) => ({ valid: true, ...req.body, code: (req.body as { code: string }).code, discount: 500 }));
    await applyCoupon(" save10 ", 1000);
    expect(api.last()!.body).toEqual({ code: "SAVE10", subtotal: 100000 });
  });

  it("returns the coupon and discount (rupees) on success", async () => {
    api.post("/coupons/validate", { valid: true, code: "SAVE10", description: "10% off", type: "percent", value: 10, minSubtotal: 0, discount: 10000 });
    const result = await applyCoupon("SAVE10", 1000);
    expect(result).toEqual({ ok: true, coupon: { code: "SAVE10", description: "10% off", type: "percent", value: 10, minSubtotal: 0, maxDiscount: undefined }, discount: 100 });
  });

  it("returns the server's reason when invalid", async () => {
    api.post("/coupons/validate", { valid: false, reason: "This code has expired." });
    expect(await applyCoupon("OLD", 1000)).toEqual({ ok: false, reason: "This code has expired." });
  });

  it("has a default reason when invalid without one", async () => {
    api.post("/coupons/validate", { valid: false });
    expect(await applyCoupon("X", 1000)).toEqual({ ok: false, reason: "That code cannot be used." });
  });

  it("reports a generic reason on a network/server error", async () => {
    api.post("/coupons/validate", networkError());
    expect(await applyCoupon("X", 1000)).toEqual({ ok: false, reason: "We could not check that code. Please try again." });
  });

  it("defaults the discount to 0 when the server omits it", async () => {
    api.post("/coupons/validate", { valid: true, code: "SAVE10", description: "", type: "percent", value: 10, minSubtotal: 0 });
    const result = await applyCoupon("SAVE10", 1000);
    expect(result).toMatchObject({ ok: true, discount: 0 });
  });
});

describe("getCoupons", () => {
  it("delegates to the data source with the customer token", async () => {
    window.localStorage.setItem("dcz:auth-token", "cust");
    api.get("/coupons", ok([]));
    await getCoupons();
    expect(api.last()!.headers.authorization).toBe("Bearer cust");
  });
});

describe("buildLineId", () => {
  it.each([
    ["P1", "M", "Red", "P1::M::Red"],
    ["P1", null, null, "P1::_::_"],
    ["P1", "M", null, "P1::M::_"],
  ])("builds %s/%s/%s as %s", (productId, size, color, expected) => {
    expect(buildLineId(productId, size, color)).toBe(expected);
  });
});

describe("isPurchasable", () => {
  it.each([
    [1, true],
    [0, false],
    [-1, false],
  ])("stock %s is purchasable: %s", (stock, expected) => {
    expect(isPurchasable(makeProduct({ stock }))).toBe(expected);
  });
});

describe("openRecoveryLink", () => {
  it("POSTs the token and returns the changes", async () => {
    api.post("/cart/recover", { changes: [{ name: "Shirt", kind: "price", message: "Price changed" }], restored: 2 });
    const result = await openRecoveryLink("tok-123");
    expect(result.restored).toBe(2);
    expect(api.last()!.body).toEqual({ token: "tok-123" });
  });
});
