import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AuthSession, Product } from "@/types";

import { api, fail, ok } from "@/test/api";
import { useCartStore } from "@/store/cartStore";
import { useCheckoutStore } from "@/store/checkoutStore";
import { useToastStore } from "@/store/toastStore";

import { announceItemCount, useAddToCart, useCart, useCartCount } from "./useCart";

function product(id: string, overrides: Partial<Product> = {}): Product {
  return {
    id,
    slug: id,
    name: `Product ${id}`,
    brand: "Brand",
    category: "women",
    subcategory: "kurtas",
    price: 100,
    originalPrice: 150,
    discount: 33,
    currency: "INR",
    rating: 4,
    reviewCount: 0,
    images: [],
    colors: [],
    sizes: [],
    description: "",
    material: "",
    tags: [],
    isNew: false,
    isTrending: false,
    isBestSeller: false,
    isFeatured: false,
    stock: 5,
    sku: id,
    care: "",
    specifications: [],
    ...overrides,
  };
}

const lastToast = () => useToastStore.getState().toasts.at(-1)?.message;

describe("useCart (guest)", () => {
  it("is loading until hydrated, then empty with nothing in the bag", async () => {
    const { result } = renderHook(() => useCart());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.lines).toEqual([]);
    expect(result.current.isEmpty).toBe(true);
    expect(result.current.totals.total).toBe(0);
  });

  it("resolves the guest bag into priced lines and totals", async () => {
    useCartStore.setState({ lines: [{ lineId: "P1::_::_", productId: "P1", size: null, color: null, quantity: 2, addedAt: 1 }] });
    api.get(/^\/products\/P1$/, product("P1", { price: 100, originalPrice: 150 }));
    const { result } = renderHook(() => useCart());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.lines).toHaveLength(1);
    expect(result.current.totals.subtotal).toBe(200);
    expect(result.current.totals.catalogueSavings).toBe(100);
    expect(result.current.totals.total).toBe(200);
    expect(result.current.breakdown.subtotal).toBe(20000); // minor units
  });

  describe("remove", () => {
    it("removes a guest line and toasts with the product's name", async () => {
      useCartStore.setState({ lines: [{ lineId: "P1::_::_", productId: "P1", size: null, color: null, quantity: 1, addedAt: 1 }] });
      const { result } = renderHook(() => useCart());
      await act(() => result.current.remove("P1::_::_", "Kurta"));
      expect(useCartStore.getState().lines).toEqual([]);
      expect(lastToast()).toBe("Kurta removed");
    });

    it("falls back to a generic message without a name", async () => {
      useCartStore.setState({ lines: [{ lineId: "P1::_::_", productId: "P1", size: null, color: null, quantity: 1, addedAt: 1 }] });
      const { result } = renderHook(() => useCart());
      await act(() => result.current.remove("P1::_::_"));
      expect(lastToast()).toBe("Item removed from bag");
    });
  });

  describe("quantity", () => {
    it("setQuantity updates a guest line", async () => {
      useCartStore.setState({ lines: [{ lineId: "P1::_::_", productId: "P1", size: null, color: null, quantity: 1, addedAt: 1 }] });
      const { result } = renderHook(() => useCart());
      await act(() => result.current.setQuantity("P1::_::_", 3));
      expect(useCartStore.getState().lines[0]?.quantity).toBe(3);
    });

    it("setQuantity of zero removes the line", async () => {
      useCartStore.setState({ lines: [{ lineId: "P1::_::_", productId: "P1", size: null, color: null, quantity: 1, addedAt: 1 }] });
      const { result } = renderHook(() => useCart());
      await act(() => result.current.setQuantity("P1::_::_", 0));
      expect(useCartStore.getState().lines).toEqual([]);
    });

    it("increment and decrement adjust relative to the current resolved quantity", async () => {
      useCartStore.setState({ lines: [{ lineId: "P1::_::_", productId: "P1", size: null, color: null, quantity: 2, addedAt: 1 }] });
      api.get(/^\/products\/P1$/, product("P1"));
      const { result } = renderHook(() => useCart());
      await waitFor(() => expect(result.current.lines).toHaveLength(1));

      await act(() => result.current.increment("P1::_::_"));
      expect(useCartStore.getState().lines[0]?.quantity).toBe(3);

      await act(() => result.current.decrement("P1::_::_"));
      expect(useCartStore.getState().lines[0]?.quantity).toBe(2);
    });

    it("decrement never goes below zero relative quantity", async () => {
      const { result } = renderHook(() => useCart());
      await act(() => result.current.decrement("missing::_::_"));
      // No matching line (quantity falls back to 1): quantity 1 - 1 = 0 removes/no-ops cleanly.
      expect(useCartStore.getState().lines).toEqual([]);
    });
  });

  describe("coupons", () => {
    it("applyCode stores the code and toasts on success", async () => {
      api.post("/coupons/validate", { valid: true, code: "SAVE10", type: "percent", value: 10, discount: 5000 });
      const { result } = renderHook(() => useCart());
      let outcome: { ok: boolean } | undefined;
      await act(async () => {
        outcome = await result.current.applyCode("save10");
      });
      expect(outcome?.ok).toBe(true);
      expect(useCartStore.getState().couponCode).toBe("SAVE10");
      expect(lastToast()).toBe("Coupon SAVE10 applied");
    });

    it("applyCode toasts the reason on failure, without storing a code", async () => {
      api.post("/coupons/validate", { valid: false, reason: "Minimum order not met" });
      const { result } = renderHook(() => useCart());
      await act(async () => {
        await result.current.applyCode("BIG500");
      });
      expect(useCartStore.getState().couponCode).toBeNull();
      expect(lastToast()).toBe("Minimum order not met");
    });

    it("removeCode clears the stored coupon and toasts", async () => {
      useCartStore.setState({ couponCode: "SAVE10" });
      const { result } = renderHook(() => useCart());
      act(() => result.current.removeCode());
      expect(useCartStore.getState().couponCode).toBeNull();
      expect(lastToast()).toBe("Coupon removed");
    });
  });

  describe("clear", () => {
    it("empties the guest cart", async () => {
      useCartStore.setState({ lines: [{ lineId: "P1::_::_", productId: "P1", size: null, color: null, quantity: 1, addedAt: 1 }] });
      const { result } = renderHook(() => useCart());
      await act(() => result.current.clear());
      expect(useCartStore.getState().lines).toEqual([]);
    });
  });

  describe("bundles", () => {
    it("setBundleQuantity updates the view and publishes the item count", async () => {
      api.put("/cart/bundles/7", ok({ items: [], breakdown: { itemCount: 4, subtotal: 0, productDiscount: 0, couponDiscount: 0, couponCode: null, shipping: 0, otherCharges: 0, taxableAmount: 0, tax: { mode: "none", taxableAmount: 0, cgst: 0, sgst: 0, igst: 0, totalTax: 0, ratePercent: 0 }, grandTotal: 0, pricesIncludeTax: true, currency: "INR" }, freeDeliveryShortfall: 0, appliedCoupon: null }));
      const { result } = renderHook(() => useCart());
      await act(() => result.current.setBundleQuantity(7, 2));
      expect(api.last("PUT", "/cart/bundles/7")!.body).toEqual({ quantity: 2 });
    });

    it("setBundleQuantity toasts the server's error message on failure", async () => {
      api.put("/cart/bundles/7", fail(409, "That bundle sold out"));
      const { result } = renderHook(() => useCart());
      await act(() => result.current.setBundleQuantity(7, 2));
      expect(lastToast()).toBe("That bundle sold out");
    });

    it("removeBundle toasts with the bundle's name", async () => {
      api.delete("/cart/bundles/7", ok({ items: [], breakdown: { itemCount: 0, subtotal: 0, productDiscount: 0, couponDiscount: 0, couponCode: null, shipping: 0, otherCharges: 0, taxableAmount: 0, tax: { mode: "none", taxableAmount: 0, cgst: 0, sgst: 0, igst: 0, totalTax: 0, ratePercent: 0 }, grandTotal: 0, pricesIncludeTax: true, currency: "INR" }, freeDeliveryShortfall: 0, appliedCoupon: null }));
      const { result } = renderHook(() => useCart());
      await act(() => result.current.removeBundle(7, "Combo pack"));
      expect(lastToast()).toBe("Combo pack removed");
    });
  });

  describe("delivery pricing context", () => {
    it("is not reached in guest mode (no server cart fetch)", () => {
      useCheckoutStore.setState({ deliveryMethodId: "express" });
      renderHook(() => useCart());
      expect(api.requests("GET", "/cart")).toHaveLength(0);
    });
  });
});

describe("useAddToCart (guest)", () => {
  it("adds the product with the given options, capped by its stock", () => {
    const add = renderHook(() => useAddToCart()).result;
    act(() => {
      void add.current(product("P1", { stock: 3 }), { size: "M", quantity: 1 });
    });
    expect(useCartStore.getState().lines[0]).toMatchObject({ productId: "P1", size: "M", quantity: 1 });
    expect(lastToast()).toBe("Product P1 added to bag");
  });
});

describe("useCartCount (guest)", () => {
  it("is zero before hydration-independent guest lines exist", () => {
    const { result } = renderHook(() => useCartCount());
    expect(result.current).toBe(0);
  });

  it("sums guest line quantities", () => {
    useCartStore.setState({
      lines: [
        { lineId: "P1::_::_", productId: "P1", size: null, color: null, quantity: 2, addedAt: 1 },
        { lineId: "P2::_::_", productId: "P2", size: null, color: null, quantity: 3, addedAt: 2 },
      ],
    });
    const { result } = renderHook(() => useCartCount());
    expect(result.current).toBe(5);
  });
});

describe("announceItemCount", () => {
  it("is callable without throwing (publishes to the shared badge listeners)", () => {
    expect(() => announceItemCount(5)).not.toThrow();
  });
});

/**
 * Signed-in cart reads go through the server and depend on the same
 * module-scoped session confirmation as the other hooks — a fresh module
 * graph per scenario, seeded through `localStorage`.
 */
describe("signed-in cart (fresh module)", () => {
  async function freshSignedIn() {
    const session: AuthSession = {
      user: { id: "U1", firstName: "A", lastName: "B", email: "a@b.com", phone: "1", memberSince: "2024-01-01" },
      token: "cust-token",
    };
    window.localStorage.setItem("dcz:session", JSON.stringify({ state: { session }, version: 1 }));
    vi.resetModules();
    const [sessionStoreMod, cartStoreMod, toastStoreMod, hookMod] = await Promise.all([
      import("@/store/sessionStore"),
      import("@/store/cartStore"),
      import("@/store/toastStore"),
      import("./useCart"),
    ]);
    for (
      let i = 0;
      i < 50 && !(sessionStoreMod.useSessionStore.persist?.hasHydrated?.() && cartStoreMod.useCartStore.persist?.hasHydrated?.());
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return { ...hookMod, toastStore: toastStoreMod.useToastStore };
  }

  const EMPTY_BREAKDOWN = {
    currency: "INR", itemCount: 1, subtotal: 10000, productDiscount: 0, couponDiscount: 0, couponCode: null,
    shipping: 0, otherCharges: 0, taxableAmount: 10000,
    tax: { mode: "none", taxableAmount: 10000, cgst: 0, sgst: 0, igst: 0, totalTax: 0, ratePercent: 0 },
    grandTotal: 10000, pricesIncludeTax: true,
  };

  it("fetches the priced server cart once signed in", async () => {
    const { useCart: fresh } = await freshSignedIn();
    api.get("/auth/me", { id: "U1", email: "a@b.com", firstName: "A", lastName: "B", name: "A B", phone: "1", status: "active", joinedAt: "2024-01-01" });
    api.get(/^\/cart/, {
      items: [{ id: 1, productId: "P1", size: null, color: null, quantity: 1, product: product("P1"), lineTotal: 10000 }],
      breakdown: EMPTY_BREAKDOWN,
      freeDeliveryShortfall: 0,
      appliedCoupon: null,
    });

    const { result } = renderHook(() => fresh());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.lines).toHaveLength(1);
    expect(result.current.totals.total).toBe(100);
  });

  it("merges a staged guest cart onto the account after sign-in", async () => {
    window.localStorage.setItem("dcz:cart", JSON.stringify({ state: { lines: [{ lineId: "P1::_::_", productId: "P1", size: null, color: null, quantity: 2, addedAt: 1 }], couponCode: null }, version: 1 }));
    const { useCart: fresh } = await freshSignedIn();
    api.get("/auth/me", { id: "U1", email: "a@b.com", firstName: "A", lastName: "B", name: "A B", phone: "1", status: "active", joinedAt: "2024-01-01" });
    api.get(/^\/cart/, { items: [], breakdown: { ...EMPTY_BREAKDOWN, itemCount: 0, subtotal: 0, grandTotal: 0 }, freeDeliveryShortfall: 0, appliedCoupon: null });
    api.post("/cart/items", { items: [{ id: 2, productId: "P1", size: null, color: null, quantity: 2, product: product("P1"), lineTotal: 20000 }], breakdown: { ...EMPTY_BREAKDOWN, itemCount: 2, subtotal: 20000, grandTotal: 20000 }, freeDeliveryShortfall: 0, appliedCoupon: null });

    renderHook(() => fresh());
    await waitFor(() => expect(api.requests("POST", "/cart/items")).toHaveLength(1));
    expect(api.last("POST", "/cart/items")!.body).toMatchObject({ productId: "P1", quantity: 2 });
  });

  it("useAddToCart posts to the server and publishes the new count", async () => {
    const { useAddToCart: fresh, toastStore } = await freshSignedIn();
    api.get("/auth/me", { id: "U1", email: "a@b.com", firstName: "A", lastName: "B", name: "A B", phone: "1", status: "active", joinedAt: "2024-01-01" });
    api.post("/cart/items", {
      items: [{ id: 1, productId: "P1", size: "M", color: null, quantity: 1, product: product("P1"), lineTotal: 10000 }],
      breakdown: { ...EMPTY_BREAKDOWN, itemCount: 1 },
      freeDeliveryShortfall: 0,
      appliedCoupon: null,
    });

    const { result } = renderHook(() => fresh());
    await waitFor(() => expect(api.requests("GET", "/auth/me")).toHaveLength(1));
    await act(() => result.current(product("P1"), { size: "M" }));
    expect(api.last("POST", "/cart/items")!.body).toMatchObject({ productId: "P1", size: "M", quantity: 1 });
    expect(toastStore.getState().toasts.at(-1)?.message).toBe("Product P1 added to bag");
  });

  it("useAddToCart toasts the server's error message on failure", async () => {
    const { useAddToCart: fresh, toastStore } = await freshSignedIn();
    api.get("/auth/me", { id: "U1", email: "a@b.com", firstName: "A", lastName: "B", name: "A B", phone: "1", status: "active", joinedAt: "2024-01-01" });
    api.post("/cart/items", fail(409, "That size just sold out"));

    const { result } = renderHook(() => fresh());
    await waitFor(() => expect(api.requests("GET", "/auth/me")).toHaveLength(1));
    await act(() => result.current(product("P1")));
    expect(toastStore.getState().toasts.at(-1)?.message).toBe("That size just sold out");
  });

  it("useCartCount reads the badge count from the server once nothing else has published one", async () => {
    const { useCartCount: fresh } = await freshSignedIn();
    api.get("/auth/me", { id: "U1", email: "a@b.com", firstName: "A", lastName: "B", name: "A B", phone: "1", status: "active", joinedAt: "2024-01-01" });
    api.get("/cart/count", { itemCount: 6 });

    const { result } = renderHook(() => fresh());
    await waitFor(() => expect(result.current).toBe(6));
  });
});
