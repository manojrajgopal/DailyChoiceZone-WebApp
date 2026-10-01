"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { STORAGE_KEYS } from "@/lib/storage/local-storage";

/**
 * The comparison list: product ids, in the order they were added.
 *
 * The same two-list arrangement as the wishlist:
 *
 * - `productIds` is what every "Compare" button and the tray read. Signed in
 *   it mirrors the server; signed out it is the list itself.
 * - `pending` holds what was added while signed out, to be merged onto the
 *   account at the next sign-in and then emptied.
 */
interface CompareState {
  productIds: string[];
  pending: string[];
  set: (productIds: string[]) => void;
  stage: (productIds: string[]) => void;
  drain: () => string[];
  clear: () => void;
}

export const useCompareStore = create<CompareState>()(
  persist(
    (set, get) => ({
      productIds: [],
      pending: [],

      set: (productIds) => {
        const current = get().productIds;
        const same = current.length === productIds.length && current.every((id, i) => id === productIds[i]);
        if (!same) set({ productIds });
      },

      stage: (productIds) => set({ pending: productIds }),

      drain: () => {
        const staged = get().pending;
        if (staged.length > 0) set({ pending: [] });
        return staged;
      },

      clear: () => set({ productIds: [], pending: [] }),
    }),
    {
      name: STORAGE_KEYS.compare,
      version: 1,
      partialize: (state) => ({ productIds: state.productIds, pending: state.pending }),
    },
  ),
);
