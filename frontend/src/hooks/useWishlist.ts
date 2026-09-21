"use client";

import { useCallback, useEffect, useState } from "react";

import type { Product } from "@/types";

import { resolveWishlist } from "@/services/wishlistService";
import { useWishlistStore } from "@/store/wishlistStore";
import { toast } from "@/store/toastStore";

import { useHydrated } from "./useHydrated";

/** The wishlist with its products resolved, for the wishlist page. */
export function useWishlist() {
  const hydrated = useHydrated();
  const productIds = useWishlistStore((state) => state.productIds);
  const removeId = useWishlistStore((state) => state.remove);
  const clear = useWishlistStore((state) => state.clear);

  const [resolved, setResolved] = useState<Product[]>([]);
  const [isResolving, setIsResolving] = useState(false);

  useEffect(() => {
    // Nothing to resolve. The empty case is derived below rather than written
    // into state, which keeps this effect free of synchronous setState.
    if (!hydrated || productIds.length === 0) return;

    let active = true;
    setIsResolving(true);

    resolveWishlist(productIds)
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
  }, [productIds, hydrated]);

  /**
   * Derived, not stored.
   *
   * Emptying the wishlist takes effect on the very next render instead of
   * waiting for an effect to clear stale products — so the list can never
   * briefly show items that are no longer saved.
   */
  const products = hydrated && productIds.length > 0 ? resolved : [];

  const remove = useCallback(
    (product: Product) => {
      removeId(product.id);
      toast.info(`${product.name} removed from wishlist`);
    },
    [removeId],
  );

  return {
    products,
    count: hydrated ? productIds.length : 0,
    isLoading: !hydrated || isResolving,
    isEmpty: hydrated && productIds.length === 0,
    hydrated,
    remove,
    clear,
  };
}

/**
 * Wishlist state for a single product — what a product card needs.
 *
 * `isWishlisted` is false until hydration so the heart's server and client
 * markup agree; it fills in on the next paint.
 */
export function useWishlistItem(productId: string) {
  const hydrated = useHydrated();
  const productIds = useWishlistStore((state) => state.productIds);
  const toggleId = useWishlistStore((state) => state.toggle);

  const isWishlisted = hydrated && productIds.includes(productId);

  const toggle = useCallback(
    (productName?: string) => {
      const nowWishlisted = toggleId(productId);
      const label = productName ?? "Item";
      if (nowWishlisted) {
        toast.success(`${label} saved to wishlist`, {
          label: "View wishlist",
          href: "/wishlist",
        });
      } else {
        toast.info(`${label} removed from wishlist`);
      }
      return nowWishlisted;
    },
    [productId, toggleId],
  );

  return { isWishlisted, toggle, hydrated };
}

/** Badge count for the header. */
export function useWishlistCount(): number {
  const hydrated = useHydrated();
  const productIds = useWishlistStore((state) => state.productIds);
  return hydrated ? productIds.length : 0;
}
