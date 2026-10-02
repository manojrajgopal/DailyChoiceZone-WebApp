import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { selectCartCount, useCartStore } from "./cartStore";

const KEY = "dcz:cart";
const cart = () => useCartStore.getState();

function stored(): unknown {
  return JSON.parse(localStorage.getItem(KEY) ?? "null");
}

describe("useCartStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("initial state", () => {
    it("starts empty with no coupon", () => {
      expect(cart().lines).toEqual([]);
      expect(cart().couponCode).toBeNull();
      expect(selectCartCount(cart())).toBe(0);
    });
  });

  describe("addItem", () => {
    it("adds a line with a variant id, quantity 1 by default and the time it was added", () => {
      cart().addItem({ productId: "P1", size: "M", color: "Red" });
      expect(cart().lines).toEqual([
        { lineId: "P1::M::Red", productId: "P1", size: "M", color: "Red", quantity: 1, addedAt: Date.parse("2026-01-01T00:00:00Z") },
      ]);
    });

    it("uses placeholders for a missing size or colour", () => {
      cart().addItem({ productId: "P1" });
      expect(cart().lines[0]).toMatchObject({ lineId: "P1::_::_", size: null, color: null });
    });

    it("merges the same product and variant into one line", () => {
      cart().addItem({ productId: "P1", size: "M", quantity: 2 });
      cart().addItem({ productId: "P1", size: "M", quantity: 3 });
      expect(cart().lines).toHaveLength(1);
      expect(cart().lines[0]!.quantity).toBe(5);
    });

    it("keeps a different variant of the same product as a separate line, in order", () => {
      cart().addItem({ productId: "P1", size: "M" });
      cart().addItem({ productId: "P1", size: "L" });
      cart().addItem({ productId: "P2" });
      expect(cart().lines.map((l) => l.lineId)).toEqual(["P1::M::_", "P1::L::_", "P2::_::_"]);
    });

    it.each([
      [0, 1],
      [-5, 1],
      [1, 1],
      [4, 4],
    ])("clamps a new line's quantity %i to at least 1 (→ %i)", (quantity, expected) => {
      cart().addItem({ productId: "P1", quantity });
      expect(cart().lines[0]!.quantity).toBe(expected);
    });

    it("caps a new line at the stock ceiling", () => {
      cart().addItem({ productId: "P1", quantity: 10, maxQuantity: 3 });
      expect(cart().lines[0]!.quantity).toBe(3);
    });

    it("caps a merged line at the stock ceiling", () => {
      cart().addItem({ productId: "P1", quantity: 2 });
      cart().addItem({ productId: "P1", quantity: 5, maxQuantity: 4 });
      expect(cart().lines[0]!.quantity).toBe(4);
    });

    it("has no ceiling when none is given, even for huge quantities", () => {
      cart().addItem({ productId: "P1", quantity: 1_000_000 });
      expect(cart().lines[0]!.quantity).toBe(1_000_000);
    });

    it("documents current behaviour: merging a non-positive quantity lowers the line (not clamped like a new line)", () => {
      cart().addItem({ productId: "P1", quantity: 3 });
      cart().addItem({ productId: "P1", quantity: -2 });
      expect(cart().lines[0]!.quantity).toBe(1);
    });

    it("merging a line leaves other lines in the cart untouched", () => {
      cart().addItem({ productId: "P1", size: "M", quantity: 1 });
      cart().addItem({ productId: "P2", quantity: 1 });
      cart().addItem({ productId: "P1", size: "M", quantity: 2 });
      expect(cart().lines).toEqual([
        expect.objectContaining({ lineId: "P1::M::_", quantity: 3 }),
        expect.objectContaining({ lineId: "P2::_::_", quantity: 1 }),
      ]);
    });
  });

  describe("quantity changes", () => {
    beforeEach(() => {
      cart().addItem({ productId: "P1", quantity: 2 });
      cart().addItem({ productId: "P2", quantity: 1 });
    });

    it("sets a quantity on only the matching line", () => {
      cart().setQuantity("P1::_::_", 7);
      expect(cart().lines.map((l) => l.quantity)).toEqual([7, 1]);
    });

    it("caps a set quantity at the ceiling", () => {
      cart().setQuantity("P1::_::_", 7, 5);
      expect(cart().lines[0]!.quantity).toBe(5);
    });

    it.each([0, -1])("removes the line when the quantity is set to %i", (quantity) => {
      cart().setQuantity("P1::_::_", quantity);
      expect(cart().lines.map((l) => l.productId)).toEqual(["P2"]);
    });

    it("increments up to the ceiling and no further", () => {
      cart().incrementLine("P1::_::_", 3);
      cart().incrementLine("P1::_::_", 3);
      expect(cart().lines[0]!.quantity).toBe(3);
    });

    it("increments without a ceiling", () => {
      cart().incrementLine("P1::_::_");
      expect(cart().lines[0]!.quantity).toBe(3);
    });

    it("decrements, and removes the line once it reaches zero", () => {
      cart().decrementLine("P2::_::_");
      expect(cart().lines.map((l) => l.productId)).toEqual(["P1"]);
      cart().decrementLine("P1::_::_");
      expect(cart().lines[0]!.quantity).toBe(1);
    });

    it("ignores increments and decrements of a line that isn't there", () => {
      const before = cart().lines;
      cart().incrementLine("nope");
      cart().decrementLine("nope");
      expect(cart().lines).toBe(before);
    });

    it("leaves other lines alone when setting the quantity of an unknown line", () => {
      cart().setQuantity("nope", 4);
      expect(cart().lines.map((l) => l.quantity)).toEqual([2, 1]);
    });

    it("removes a line by id and ignores an unknown id", () => {
      cart().removeLine("P1::_::_");
      cart().removeLine("unknown");
      expect(cart().lines.map((l) => l.productId)).toEqual(["P2"]);
    });

    it("counts every unit across lines", () => {
      expect(selectCartCount(cart())).toBe(3);
    });
  });

  describe("coupon and clearing", () => {
    it("stores a coupon code and clears it with null", () => {
      cart().applyCouponCode("SAVE10");
      expect(cart().couponCode).toBe("SAVE10");
      cart().applyCouponCode(null);
      expect(cart().couponCode).toBeNull();
    });

    it("clears lines and the coupon together", () => {
      cart().addItem({ productId: "P1" });
      cart().applyCouponCode("SAVE10");
      cart().clearCart();
      expect(cart().lines).toEqual([]);
      expect(cart().couponCode).toBeNull();
    });
  });

  describe("persistence", () => {
    it("writes only the data, under the cart key, with its version", () => {
      cart().addItem({ productId: "P1", size: "S" });
      cart().applyCouponCode("X");
      expect(stored()).toEqual({
        state: { lines: [expect.objectContaining({ lineId: "P1::S::_", quantity: 1 })], couponCode: "X" },
        version: 1,
      });
    });

    it("rehydrates a stored cart, with working actions", async () => {
      const line = { lineId: "P9::_::_", productId: "P9", size: null, color: null, quantity: 4, addedAt: 1 };
      localStorage.setItem(KEY, JSON.stringify({ state: { lines: [line], couponCode: "OLD" }, version: 1 }));
      await useCartStore.persist.rehydrate();
      expect(cart().lines).toEqual([line]);
      expect(cart().couponCode).toBe("OLD");
      cart().incrementLine("P9::_::_");
      expect(cart().lines[0]!.quantity).toBe(5);
    });

    it("ignores corrupt stored JSON and keeps the current cart", async () => {
      cart().addItem({ productId: "P1" });
      localStorage.setItem(KEY, "{not json");
      await useCartStore.persist.rehydrate();
      expect(cart().lines).toHaveLength(1);
    });

    it("does not adopt a cart saved under another version", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      localStorage.setItem(KEY, JSON.stringify({ state: { lines: [{ lineId: "x" }], couponCode: "OLD" }, version: 0 }));
      await useCartStore.persist.rehydrate();
      expect(cart().lines).toEqual([]);
      expect(cart().couponCode).toBeNull();
    });
  });
});
