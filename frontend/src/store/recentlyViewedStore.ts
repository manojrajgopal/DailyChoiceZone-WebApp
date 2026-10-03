"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { STORAGE_KEYS } from "@/lib/storage/local-storage";

/**
 * How many products a guest's browser remembers. Enough to be useful, short
 * enough to stay relevant; a signed-in customer's history is kept on the
 * server instead (`RECENTLY_VIEWED_LIMIT`).
 */
const MAX_ENTRIES = 12;

interface RecentlyViewedState {
  /** Most recently viewed first. */
  productIds: string[];
  /**
   * When each was last viewed, in milliseconds since the epoch — so that, at
   * sign-in, a guest's view only moves a product to the front of the account's
   * history if it really is newer than what the account holds.
   */
  viewedAt: Record<string, number>;
  record: (productId: string) => void;
  remove: (productId: string) => void;
  clear: () => void;
}

export const useRecentlyViewedStore = create<RecentlyViewedState>()(
  persist(
    (set, get) => ({
      productIds: [],
      viewedAt: {},

      /**
       * Record a view.
       *
       * Re-viewing a product moves it to the front rather than adding a
       * duplicate, so the list stays a set ordered by recency.
       */
      record: (productId) => {
        const withoutDuplicate = get().productIds.filter((id) => id !== productId);
        const productIds = [productId, ...withoutDuplicate].slice(0, MAX_ENTRIES);
        const viewedAt: Record<string, number> = {};
        for (const id of productIds) viewedAt[id] = get().viewedAt[id] ?? 0;
        viewedAt[productId] = Date.now();
        set({ productIds, viewedAt });
      },

      remove: (productId) => {
        const viewedAt = { ...get().viewedAt };
        delete viewedAt[productId];
        set({ productIds: get().productIds.filter((id) => id !== productId), viewedAt });
      },

      clear: () => set({ productIds: [], viewedAt: {} }),
    }),
    {
      name: STORAGE_KEYS.recentlyViewed,
      version: 2,
      partialize: (state) => ({ productIds: state.productIds, viewedAt: state.viewedAt }),
      /**
       * Version 1 kept only the order. Its entries get no time (0), which the
       * server reads as "as old as allowed" — so an old guest view can never
       * displace a newer one on the account.
       */
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Partial<RecentlyViewedState>;
        if (version < 2) {
          return { productIds: state.productIds ?? [], viewedAt: {} } as unknown as RecentlyViewedState;
        }
        return state as RecentlyViewedState;
      },
    },
  ),
);
