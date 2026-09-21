"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { STORAGE_KEYS } from "@/lib/storage/local-storage";

/**
 * Wishlist state: an ordered list of product ids, oldest first.
 *
 * Ids only, for the same reason as the cart — a wishlist is often revisited
 * long after items were saved, which is exactly when cached prices go stale.
 */

interface WishlistState {
  productIds: string[];
  toggle: (productId: string) => boolean;
  add: (productId: string) => void;
  remove: (productId: string) => void;
  clear: () => void;
  has: (productId: string) => boolean;
}

export const useWishlistStore = create<WishlistState>()(
  persist(
    (set, get) => ({
      productIds: [],

      /** Returns whether the product is wishlisted *after* the toggle. */
      toggle: (productId) => {
        const exists = get().productIds.includes(productId);
        set({
          productIds: exists
            ? get().productIds.filter((id) => id !== productId)
            : [...get().productIds, productId],
        });
        return !exists;
      },

      add: (productId) => {
        if (get().productIds.includes(productId)) return;
        set({ productIds: [...get().productIds, productId] });
      },

      remove: (productId) => {
        set({ productIds: get().productIds.filter((id) => id !== productId) });
      },

      clear: () => set({ productIds: [] }),

      has: (productId) => get().productIds.includes(productId),
    }),
    {
      name: STORAGE_KEYS.wishlist,
      version: 1,
      partialize: (state) => ({ productIds: state.productIds }),
    },
  ),
);
