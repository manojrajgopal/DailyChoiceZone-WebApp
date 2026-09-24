"use client";

import { useCallback, useEffect, useState } from "react";

import type { Product } from "@/types";

import * as wishlistService from "@/services/wishlistService";
import { useSessionStore } from "@/store/sessionStore";
import { useWishlistStore } from "@/store/wishlistStore";
import { toast } from "@/store/toastStore";

import { useHydrated } from "./useHydrated";

/**
 * The wishlist.
 *
 * Signed in, it lives on the server and follows the customer between devices.
 * Signed out, it is staged locally and merged up on sign-in.
 *
 * The local store stays the single place the *ids* are read from in either
 * mode: when signed in it mirrors what the server returned, which keeps the
 * heart on every product card instant instead of waiting on a request per
 * card.
 */

/**
 * The one sync in flight, shared by everything that asks for it.
 *
 * A product grid mounts thirty `useWishlistItem`s at once, and every one of
 * them wants the mirror to be current. Without this they each fired their own
 * request: thirty identical round trips to render one page of hearts.
 */
let inFlight: Promise<void> | null = null;

/**
 * Keep the local mirror in step with the server, and merge a guest list once.
 *
 * Called by **every** hook in this file, including the count — the badge and
 * the account tile read the mirror, so a hook that only read it would show
 * zero until something else happened to fill it in.
 *
 * What gets merged is `pending`, which only ever holds things saved while
 * signed out. Merging `productIds` instead posted the server's own list back
 * to it on every navigation.
 */
function useWishlistSync() {
  const hydrated = useHydrated();
  const session = useSessionStore((state) => state.session);
  const replace = useWishlistStore((state) => state.replace);

  const isSignedIn = hydrated && session !== null;

  useEffect(() => {
    if (!hydrated || !isSignedIn) return;

    /**
     * No cleanup, deliberately.
     *
     * The result is written to the store rather than to this component's
     * state, so an unmount mid-flight has nothing to leak into — and the other
     * twenty-nine cards sharing this promise still want the answer.
     */
    inFlight ??= (async () => {
      const staged = useWishlistStore.getState().drain();
      if (staged.length > 0) await wishlistService.mergeGuestWishlist(staged);

      const ids = await wishlistService.fetchWishlistIds();
      useWishlistStore.getState().replace(ids);
    })()
      .catch(() => {
        /* an unreachable API leaves the local mirror alone */
      })
      .finally(() => {
        // Cleared so the next page load, a later sign-in, or a retry after a
        // failure can run one of its own.
        inFlight = null;
      });
  }, [hydrated, isSignedIn, replace]);

  return { isSignedIn, hydrated };
}

export function useWishlist() {
  const { isSignedIn, hydrated } = useWishlistSync();

  const productIds = useWishlistStore((state) => state.productIds);
  const removeId = useWishlistStore((state) => state.remove);
  const clearLocal = useWishlistStore((state) => state.clear);

  const [resolved, setResolved] = useState<Product[]>([]);
  const [isResolving, setIsResolving] = useState(false);

  useEffect(() => {
    if (!hydrated || productIds.length === 0) return;

    let active = true;
    setIsResolving(true);

    const load = isSignedIn
      ? wishlistService.fetchWishlist()
      : wishlistService.resolveWishlist(productIds);

    load
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
  }, [productIds, hydrated, isSignedIn]);

  /**
   * Derived, not stored.
   *
   * Emptying the wishlist takes effect on the very next render instead of
   * waiting for an effect to clear stale products.
   */
  const products = hydrated && productIds.length > 0 ? resolved : [];

  const remove = useCallback(
    (product: Product) => {
      removeId(product.id);
      if (isSignedIn) void wishlistService.removeFromWishlist(product.id);
      toast.info(`${product.name} removed from wishlist`);
    },
    [removeId, isSignedIn],
  );

  const clear = useCallback(() => {
    if (isSignedIn) {
      for (const id of productIds) void wishlistService.removeFromWishlist(id);
    }
    clearLocal();
  }, [isSignedIn, productIds, clearLocal]);

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
 *
 * The local mirror is updated first and the request follows. A heart that
 * waited for a round trip would feel broken, and the mirror is reconciled with
 * the server on the next load either way.
 */
export function useWishlistItem(productId: string) {
  const { isSignedIn, hydrated } = useWishlistSync();
  const productIds = useWishlistStore((state) => state.productIds);
  const toggleId = useWishlistStore((state) => state.toggle);
  const stage = useWishlistStore((state) => state.stage);

  const isWishlisted = hydrated && productIds.includes(productId);

  const toggle = useCallback(
    (productName?: string) => {
      const nowWishlisted = toggleId(productId);

      if (isSignedIn) {
        void (nowWishlisted
          ? wishlistService.addToWishlist(productId)
          : wishlistService.removeFromWishlist(productId));
      } else if (nowWishlisted) {
        // Staged for the merge that happens when they sign in.
        stage(productId);
      }

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
    [productId, toggleId, stage, isSignedIn],
  );

  return { isWishlisted, toggle, hydrated };
}

/** Badge count for the header, and the tile on the account page. */
export function useWishlistCount(): number {
  const { hydrated } = useWishlistSync();
  const productIds = useWishlistStore((state) => state.productIds);
  return hydrated ? productIds.length : 0;
}
