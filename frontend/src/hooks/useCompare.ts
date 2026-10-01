"use client";

import { useCallback, useEffect, useState } from "react";

import type { Product } from "@/types";

import { ApiError } from "@/services/api/client";
import * as engagement from "@/services/engagementService";
import { getProductsByIds } from "@/services/productService";
import { useCompareStore } from "@/store/compareStore";
import { toast } from "@/store/toastStore";

import { useHydrated } from "./useHydrated";
import { useCustomerStatus } from "./useSession";

export const COMPARE_LIMIT = engagement.COMPARE_LIMIT;

/**
 * Product comparison.
 *
 * Signed in, the list lives on the server and follows the customer between
 * devices; signed out it lives in this browser and is merged onto the account
 * at sign-in — the same arrangement as the wishlist, for the same reasons.
 * The limit is enforced by the server for accounts and here for guests.
 */

let synced: Promise<void> | null = null;

function useCompareSync() {
  const hydrated = useHydrated();
  const { isSignedIn, isPending } = useCustomerStatus();

  useEffect(() => {
    if (!hydrated || !isSignedIn) return;
    synced ??= (async () => {
      const staged = useCompareStore.getState().drain();
      const result = staged.length > 0 ? await engagement.mergeCompare(staged) : await engagement.fetchCompareIds();
      useCompareStore.getState().set(result.productIds);
    })().catch(() => {
      synced = null;
    });
  }, [hydrated, isSignedIn]);

  // Signed out again: the next sign-in syncs afresh.
  useEffect(() => {
    if (hydrated && !isSignedIn && !isPending) synced = null;
  }, [hydrated, isSignedIn, isPending]);

  return { hydrated, isSignedIn, isPending };
}

/** The ids, and the actions — what a "Compare" button and the tray need. */
export function useCompareList() {
  const { hydrated, isSignedIn } = useCompareSync();
  const productIds = useCompareStore((state) => state.productIds);
  const setIds = useCompareStore((state) => state.set);
  const stage = useCompareStore((state) => state.stage);
  const clearLocal = useCompareStore((state) => state.clear);
  const ids = hydrated ? productIds : [];

  /**
   * Add a product. At the limit, `replace` names the one to swap out; without
   * it, nothing changes and the caller is told the list is full.
   */
  const add = useCallback(
    async (product: Pick<Product, "id" | "name">, replace?: string): Promise<"added" | "full" | "failed"> => {
      const current = useCompareStore.getState().productIds;
      if (current.includes(product.id)) return "added";
      if (current.length >= COMPARE_LIMIT && !replace) return "full";
      if (isSignedIn) {
        try {
          const result = await engagement.addToCompare(product.id, replace);
          setIds(result.productIds);
        } catch (error) {
          if (error instanceof ApiError && error.code === "COMPARISON_FULL") return "full";
          toast.error(error instanceof ApiError ? error.message : "Couldn't add it to the comparison.");
          return "failed";
        }
      } else {
        const next = [...current.filter((id) => id !== replace), product.id].slice(-COMPARE_LIMIT);
        setIds(next);
        stage(next);
      }
      toast.success(`${product.name} added to comparison`, { label: "Compare now", href: "/compare" });
      return "added";
    },
    [isSignedIn, setIds, stage],
  );

  const remove = useCallback(
    async (productId: string) => {
      const next = useCompareStore.getState().productIds.filter((id) => id !== productId);
      setIds(next);
      if (isSignedIn) {
        try {
          setIds((await engagement.removeFromCompare(productId)).productIds);
        } catch {
          /* the next sync puts the server's list back */
        }
      } else {
        stage(next);
      }
    },
    [isSignedIn, setIds, stage],
  );

  const clear = useCallback(async () => {
    clearLocal();
    if (isSignedIn) await engagement.clearCompare().catch(() => undefined);
  }, [isSignedIn, clearLocal]);

  return { productIds: ids, count: ids.length, hydrated, add, remove, clear, has: (id: string) => ids.includes(id) };
}

/** The products themselves, for the comparison page. */
export function useCompareProducts() {
  const { productIds, hydrated, remove, clear } = useCompareList();
  const { isSignedIn, isPending } = useCustomerStatus();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const key = productIds.join(",");

  useEffect(() => {
    if (!hydrated || isPending) return;
    if (!key) {
      setProducts([]);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    setError(false);
    const load = isSignedIn
      ? engagement.fetchCompareProducts().then((result) => result.items)
      : getProductsByIds(key.split(","));
    load
      .then((items) => {
        if (!live) return;
        // In the order they were added; anything no longer for sale drops out.
        const byId = new Map(items.map((item) => [item.id, item]));
        setProducts(key.split(",").map((id) => byId.get(id)).filter((item): item is Product => Boolean(item)));
      })
      .catch(() => live && setError(true))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [key, hydrated, isPending, isSignedIn]);

  return { products, loading: !hydrated || isPending || loading, error, remove, clear, productIds };
}
