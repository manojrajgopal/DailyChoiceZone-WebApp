"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { CartLine } from "@/types";

import { STORAGE_KEYS } from "@/lib/storage/local-storage";
import { buildLineId } from "@/services/cartService";

/**
 * Cart state.
 *
 * The store holds ids, variants and quantities — never product copies and
 * never prices. Pricing is derived from the live catalogue on read, so a cart
 * that has been sitting in local storage for a month still shows today's
 * prices. See `useCart` for the resolved, render-ready view.
 */

interface CartState {
  lines: CartLine[];
  /** Stored as a code, not a resolved coupon, so its value is re-validated. */
  couponCode: string | null;

  addItem: (input: {
    productId: string;
    size?: string | null;
    color?: string | null;
    quantity?: number;
    maxQuantity?: number;
  }) => void;
  removeLine: (lineId: string) => void;
  setQuantity: (lineId: string, quantity: number, maxQuantity?: number) => void;
  incrementLine: (lineId: string, maxQuantity?: number) => void;
  decrementLine: (lineId: string) => void;
  applyCouponCode: (code: string | null) => void;
  clearCart: () => void;
}

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      lines: [],
      couponCode: null,

      addItem: ({ productId, size = null, color = null, quantity = 1, maxQuantity }) => {
        const lineId = buildLineId(productId, size, color);
        const existing = get().lines.find((line) => line.lineId === lineId);
        const ceiling = maxQuantity ?? Number.MAX_SAFE_INTEGER;

        if (existing) {
          // Same product, same variant: merge rather than add a second row.
          set({
            lines: get().lines.map((line) =>
              line.lineId === lineId
                ? { ...line, quantity: Math.min(line.quantity + quantity, ceiling) }
                : line,
            ),
          });
          return;
        }

        set({
          lines: [
            ...get().lines,
            {
              lineId,
              productId,
              size,
              color,
              quantity: Math.min(Math.max(1, quantity), ceiling),
              addedAt: Date.now(),
            },
          ],
        });
      },

      removeLine: (lineId) => {
        set({ lines: get().lines.filter((line) => line.lineId !== lineId) });
      },

      setQuantity: (lineId, quantity, maxQuantity) => {
        if (quantity <= 0) {
          set({ lines: get().lines.filter((line) => line.lineId !== lineId) });
          return;
        }
        const ceiling = maxQuantity ?? Number.MAX_SAFE_INTEGER;
        set({
          lines: get().lines.map((line) =>
            line.lineId === lineId ? { ...line, quantity: Math.min(quantity, ceiling) } : line,
          ),
        });
      },

      incrementLine: (lineId, maxQuantity) => {
        const line = get().lines.find((entry) => entry.lineId === lineId);
        if (!line) return;
        get().setQuantity(lineId, line.quantity + 1, maxQuantity);
      },

      decrementLine: (lineId) => {
        const line = get().lines.find((entry) => entry.lineId === lineId);
        if (!line) return;
        get().setQuantity(lineId, line.quantity - 1);
      },

      applyCouponCode: (code) => set({ couponCode: code }),

      clearCart: () => set({ lines: [], couponCode: null }),
    }),
    {
      name: STORAGE_KEYS.cart,
      version: 1,
      // Only persist data, never the action functions.
      partialize: (state) => ({ lines: state.lines, couponCode: state.couponCode }),
    },
  ),
);

/** Total units in the cart. Used by the header badge. */
export function selectCartCount(state: CartState): number {
  return state.lines.reduce((sum, line) => sum + line.quantity, 0);
}
