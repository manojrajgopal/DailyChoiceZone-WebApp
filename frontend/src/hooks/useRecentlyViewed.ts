"use client";

import { useCallback, useEffect, useState } from "react";

import type { Product } from "@/types";

import * as discovery from "@/services/discoveryService";
import { getProductsByIds } from "@/services/productService";
import { useCustomerStatus } from "@/hooks/useSession";
import { useRecentlyViewedStore } from "@/store/recentlyViewedStore";
import { toast } from "@/store/toastStore";

import { useHydrated } from "./useHydrated";

/**
 * Recently viewed products, resolved and ready to render.
 *
 * Two homes, one interface — the same arrangement as the bag. **Signed in**,
 * the history is the account's, read from the server, so it follows the
 * customer between devices. **Signed out**, it is the browser's own short list
 * (`recentlyViewedStore`), handed to the account at sign-in by `GuestDataSync`.
 *
 * `excludeId` keeps the product currently on screen out of its own
 * "recently viewed" rail, which would otherwise be the first thing in it.
 */
export function useRecentlyViewed(options: { excludeId?: string; limit?: number } = {}) {
  const { excludeId, limit = 8 } = options;

  const hydrated = useHydrated();
  const { isSignedIn, isPending } = useCustomerStatus();
  const productIds = useRecentlyViewedStore((state) => state.productIds);
  const clearLocal = useRecentlyViewedStore((state) => state.clear);
  const removeLocal = useRecentlyViewedStore((state) => state.remove);

  const [resolved, setResolved] = useState<Product[]>([]);
  const [isResolving, setIsResolving] = useState(false);
  const [server, setServer] = useState<{ products: Product[]; total: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);

  const ids = productIds.filter((id) => id !== excludeId).slice(0, limit);
  // A primitive key keeps this effect from re-running on every render, which a
  // fresh array identity would cause.
  const idsKey = ids.join(",");

  /* ----------------------------------------------------------- guest */
  useEffect(() => {
    // The empty case is derived below rather than written into state.
    if (!hydrated || isSignedIn || isPending || idsKey === "") return;

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
  }, [idsKey, hydrated, isSignedIn, isPending]);

  /* ------------------------------------------------------- signed in */
  useEffect(() => {
    if (!hydrated || !isSignedIn) return;

    let active = true;
    setIsResolving(true);
    discovery
      .fetchRecentlyViewed({ pageSize: limit, exclude: excludeId })
      .then((page) => {
        if (!active) return;
        setServer({ products: page.items.map((entry) => entry.product), total: page.total });
        setFailed(false);
      })
      .catch(() => {
        if (!active) return;
        setServer({ products: [], total: 0 });
        setFailed(true);
      })
      .finally(() => {
        if (active) setIsResolving(false);
      });

    return () => {
      active = false;
    };
  }, [hydrated, isSignedIn, limit, excludeId, version]);

  const products = isSignedIn ? (server?.products ?? []) : hydrated && idsKey !== "" ? resolved : [];
  const total = isSignedIn ? (server?.total ?? 0) : productIds.filter((id) => id !== excludeId).length;

  const clear = useCallback(async () => {
    if (isSignedIn) {
      try {
        await discovery.clearRecentlyViewed();
        setServer({ products: [], total: 0 });
      } catch {
        toast.error("We couldn't clear your recently viewed products. Please try again.");
        return;
      }
    }
    clearLocal();
  }, [isSignedIn, clearLocal, setServer]);

  const remove = useCallback(
    async (productId: string) => {
      if (isSignedIn) {
        try {
          await discovery.removeRecentlyViewed(productId);
        } catch {
          toast.error("We couldn't remove that product. Please try again.");
          return;
        }
        setServer((current) =>
          current
            ? { products: current.products.filter((p) => p.id !== productId), total: Math.max(0, current.total - 1) }
            : current,
        );
        setVersion((v) => v + 1);
        return;
      }
      removeLocal(productId);
    },
    [isSignedIn, removeLocal, setServer, setVersion],
  );

  return {
    products,
    ids: isSignedIn ? products.map((p) => p.id) : ids,
    /** How many there are in all, for a "View all" link. */
    total,
    isLoading: !hydrated || isPending || isResolving || (isSignedIn && server === null),
    isEmpty: hydrated && !isPending && (isSignedIn ? server !== null && server.products.length === 0 : ids.length === 0),
    /** The history couldn't be read (signed in only). */
    failed,
    clear,
    remove,
    refresh: () => setVersion((v) => v + 1),
  };
}

/**
 * When each product was last recorded from this page load.
 *
 * Module-scoped on purpose: React StrictMode runs effects twice, navigating
 * back and forth remounts the page, and a re-render must never write again.
 * The server throttles repeats too; this saves the request.
 */
const recordedAt = new Map<string, number>();
const REPEAT_MS = 30_000;

/** For tests: forget what has been recorded. */
export function resetRecordedViews(): void {
  recordedAt.clear();
}

/**
 * Record a product view exactly once per mount.
 *
 * Called by the product detail page only after the product has loaded — the
 * page is rendered on the server and a missing product is a 404 before this
 * runs, so an invalid id never reaches anyone's history. Kept separate from
 * the read hook so a page that merely *displays* the rail never writes to it.
 */
export function useRecordProductView(
  productId: string | undefined,
  options: { color?: string | null; size?: string | null; source?: string } = {},
): void {
  const record = useRecentlyViewedStore((state) => state.record);
  const { isSignedIn, isPending } = useCustomerStatus();
  const { color, size, source } = options;

  useEffect(() => {
    if (!productId || isPending) return;

    if (!isSignedIn) {
      record(productId);
      return;
    }

    const last = recordedAt.get(productId);
    if (last !== undefined && Date.now() - last < REPEAT_MS) return;
    recordedAt.set(productId, Date.now());
    // Fire and forget: history must never slow down or break the page.
    discovery.recordProductView({ productId, color, size, source }).catch(() => {
      recordedAt.delete(productId);
    });
    // The variant is remembered as first seen; changing colour isn't a new view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, record, isSignedIn, isPending]);
}
