"use client";

import { useEffect, useState } from "react";

import type { Product } from "@/types";

import { getProductsByIds } from "@/services/productService";
import { useRecentlyViewedStore } from "@/store/recentlyViewedStore";

import { useHydrated } from "./useHydrated";

/**
 * Recently viewed products, resolved and ready to render.
 *
 * `excludeId` keeps the product currently on screen out of its own
 * "recently viewed" rail, which would otherwise be the first thing in it.
 */
export function useRecentlyViewed(options: { excludeId?: string; limit?: number } = {}) {
  const { excludeId, limit = 8 } = options;

  const hydrated = useHydrated();
  const productIds = useRecentlyViewedStore((state) => state.productIds);
  const clear = useRecentlyViewedStore((state) => state.clear);

  const [resolved, setResolved] = useState<Product[]>([]);
  const [isResolving, setIsResolving] = useState(false);

  const ids = productIds.filter((id) => id !== excludeId).slice(0, limit);
  // A primitive key keeps this effect from re-running on every render, which a
  // fresh array identity would cause.
  const idsKey = ids.join(",");

  useEffect(() => {
    // The empty case is derived below rather than written into state.
    if (!hydrated || idsKey === "") return;

    let active = true;
    setIsResolving(true);

    getProductsByIds(idsKey.split(","))
      .then((result) => {
        if (active) setResolved(result);
      })
      .catch(() => {
        if (active) setResolved([]);
      })
      .finally(() => {
        if (active) setIsResolving(false);
      });

    return () => {
      active = false;
    };
  }, [idsKey, hydrated]);

  const products = hydrated && idsKey !== "" ? resolved : [];

  return {
    products,
    ids,
    isLoading: !hydrated || isResolving,
    isEmpty: hydrated && ids.length === 0,
    clear,
  };
}

/**
 * Record a product view exactly once per mount.
 *
 * Called by the product detail page. Kept separate from the read hook so a
 * page that merely *displays* the rail never accidentally writes to it.
 */
export function useRecordProductView(productId: string | undefined): void {
  const record = useRecentlyViewedStore((state) => state.record);

  useEffect(() => {
    if (!productId) return;
    record(productId);
  }, [productId, record]);
}
