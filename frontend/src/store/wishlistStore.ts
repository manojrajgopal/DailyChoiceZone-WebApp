"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { STORAGE_KEYS } from "@/lib/storage/local-storage";

/**
 * Wishlist state: an ordered list of product ids, oldest first.
 *
 * Ids only, for the same reason as the cart — a wishlist is often revisited
 * long after items were saved, which is exactly when cached prices go stale.
 *
 * Two lists, not one, and the distinction matters:
 *
 * - `productIds` is what the heart on every card reads. Signed in it is a
 *   *mirror* of the server; signed out it is the list itself.
 * - `pending` is only ever things saved **while signed out**, waiting to be
 *   merged onto an account. It is drained on sign-in and emptied.
 *
 * Collapsing them was a bug worth naming: with one list, every page load
 * merged the mirror back into the account it had just been read from, posting
 * the whole wishlist again on every navigation.
 */

interface WishlistState {
  productIds: string[];
  /** Saved while signed out; merged onto the account at the next sign-in. */
  pending: string[];
  toggle: (productId: string) => boolean;
  add: (productId: string) => void;
  remove: (productId: string) => void;
  replace: (productIds: string[]) => void;
  /** Mark an id as saved while signed out. */
  stage: (productId: string) => void;
  /** Take the staged ids and clear them. */
  drain: () => string[];
  clear: () => void;
  has: (productId: string) => boolean;
}

export const useWishlistStore = create<WishlistState>()(
  persist(
    (set, get) => ({
      productIds: [],
      pending: [],

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
        set({
          productIds: get().productIds.filter((id) => id !== productId),
          pending: get().pending.filter((id) => id !== productId),
        });
      },

      /**
       * Mirror the server's list.
       *
       * Only the sync effect calls this. It writes nothing when the list is
       * already identical, so seeding the mirror cannot restart effects that
       * depend on `productIds`.
       */
      replace: (productIds) => {
        const current = get().productIds;
        const same =
          current.length === productIds.length &&
          current.every((id, index) => id === productIds[index]);
        if (!same) set({ productIds });
      },

      stage: (productId) => {
        if (get().pending.includes(productId)) return;
        set({ pending: [...get().pending, productId] });
      },

      drain: () => {
        const staged = get().pending;
        if (staged.length > 0) set({ pending: [] });
        return staged;
      },

      clear: () => set({ productIds: [], pending: [] }),

      has: (productId) => get().productIds.includes(productId),
    }),
    {
      name: STORAGE_KEYS.wishlist,
      version: 2,
      partialize: (state) => ({ productIds: state.productIds, pending: state.pending }),
    },
  ),
);
