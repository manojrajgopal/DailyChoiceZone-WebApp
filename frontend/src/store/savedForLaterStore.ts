"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { STORAGE_KEYS } from "@/lib/storage/local-storage";
import { buildLineId } from "@/services/cartService";

/**
 * A guest's "saved for later" lines.
 *
 * Like the guest bag, this is staging, not truth: ids, the chosen variant and
 * a quantity — never a product copy and never a price. It is priced from the
 * live catalogue whenever it is shown, and handed to the server once at sign-in
 * (`GuestDataSync`), after which the account's saved list is the only one.
 */

/** A guest's list stays short; the account holds up to `SAVED_FOR_LATER_LIMIT`. */
export const MAX_GUEST_SAVED = 30;

export interface SavedLine {
  lineId: string;
  productId: string;
  size: string | null;
  color: string | null;
  quantity: number;
  savedAt: number;
}

interface SavedForLaterState {
  lines: SavedLine[];
  /** Save a line, merging with the same variant already saved. */
  save: (input: { productId: string; size?: string | null; color?: string | null; quantity?: number }) => void;
  remove: (lineId: string) => void;
  setQuantity: (lineId: string, quantity: number) => void;
  clear: () => void;
}

export const useSavedForLaterStore = create<SavedForLaterState>()(
  persist(
    (set, get) => ({
      lines: [],

      save: ({ productId, size = null, color = null, quantity = 1 }) => {
        const lineId = buildLineId(productId, size, color);
        const existing = get().lines.find((line) => line.lineId === lineId);
        if (existing) {
          set({
            lines: get().lines.map((line) =>
              line.lineId === lineId ? { ...line, quantity: Math.min(10, line.quantity + quantity) } : line,
            ),
          });
          return;
        }
        const next: SavedLine = {
          lineId,
          productId,
          size,
          color,
          quantity: Math.max(1, Math.min(10, quantity)),
          savedAt: Date.now(),
        };
        set({ lines: [next, ...get().lines].slice(0, MAX_GUEST_SAVED) });
      },

      remove: (lineId) => set({ lines: get().lines.filter((line) => line.lineId !== lineId) }),

      setQuantity: (lineId, quantity) =>
        set({
          lines: get().lines.map((line) =>
            line.lineId === lineId ? { ...line, quantity: Math.max(1, Math.min(10, quantity)) } : line,
          ),
        }),

      clear: () => set({ lines: [] }),
    }),
    {
      name: STORAGE_KEYS.savedForLater,
      version: 1,
      partialize: (state) => ({ lines: state.lines }),
    },
  ),
);
