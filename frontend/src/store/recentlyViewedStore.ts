"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { STORAGE_KEYS } from "@/lib/storage/local-storage";

/** How many products to remember. Enough to be useful, short enough to stay relevant. */
const MAX_ENTRIES = 12;

interface RecentlyViewedState {
  /** Most recently viewed first. */
  productIds: string[];
  record: (productId: string) => void;
  clear: () => void;
}

export const useRecentlyViewedStore = create<RecentlyViewedState>()(
  persist(
    (set, get) => ({
      productIds: [],

      /**
       * Record a view.
       *
       * Re-viewing a product moves it to the front rather than adding a
       * duplicate, so the list stays a set ordered by recency.
       */
      record: (productId) => {
        const withoutDuplicate = get().productIds.filter((id) => id !== productId);
        set({ productIds: [productId, ...withoutDuplicate].slice(0, MAX_ENTRIES) });
      },

      clear: () => set({ productIds: [] }),
    }),
    {
      name: STORAGE_KEYS.recentlyViewed,
      version: 1,
      partialize: (state) => ({ productIds: state.productIds }),
    },
  ),
);
