"use client";

import { useEffect, useRef } from "react";

import { useHydrated } from "@/hooks/useHydrated";
import { useConfirmedCustomer } from "@/hooks/useSession";
import { mergeRecentlyViewed, mergeSaved } from "@/services/discoveryService";
import { useRecentlyViewedStore } from "@/store/recentlyViewedStore";
import { useSavedForLaterStore } from "@/store/savedForLaterStore";

/**
 * Hand a guest's browsing history and saved-for-later lines to their account,
 * once, the moment they're signed in — the same thing `useCart` does for the
 * guest bag.
 *
 * The server de-duplicates and keeps the newer of two views, so a merge that
 * runs twice (two tabs) changes nothing. The local lists are cleared only
 * after the server has accepted them: a failed request leaves them to try
 * again on the next page, rather than losing them.
 */
export function GuestDataSync() {
  const hydrated = useHydrated();
  const signedIn = useConfirmedCustomer();
  const running = useRef(false);

  useEffect(() => {
    if (!hydrated || !signedIn || running.current) return;
    const recent = useRecentlyViewedStore.getState();
    const saved = useSavedForLaterStore.getState();
    if (recent.productIds.length === 0 && saved.lines.length === 0) return;
    running.current = true;

    const viewed = recent.productIds.map((productId) => ({ productId, viewedAt: recent.viewedAt[productId] ?? 0 }));
    const lines = saved.lines.map(({ productId, size, color, quantity }) => ({ productId, size, color, quantity }));

    void (async () => {
      if (viewed.length) {
        try {
          await mergeRecentlyViewed(viewed);
          useRecentlyViewedStore.getState().clear();
        } catch {
          /* kept locally; tried again on the next page */
        }
      }
      if (lines.length) {
        try {
          await mergeSaved(lines);
          useSavedForLaterStore.getState().clear();
        } catch {
          /* kept locally; tried again on the next page */
        }
      }
      running.current = false;
    })();
  }, [hydrated, signedIn]);

  return null;
}
