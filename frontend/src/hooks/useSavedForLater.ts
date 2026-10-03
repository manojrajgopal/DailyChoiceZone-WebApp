"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { Product, ResolvedCartLine } from "@/types";

import * as discovery from "@/services/discoveryService";
import type { ServerCart } from "@/services/cartService";
import { getProductsByIds } from "@/services/productService";
import { useCustomerStatus } from "@/hooks/useSession";
import { useCartStore } from "@/store/cartStore";
import { useSavedForLaterStore } from "@/store/savedForLaterStore";
import { toast } from "@/store/toastStore";

import { useHydrated } from "./useHydrated";

/**
 * One saved line, ready to render — the same shape signed in or out.
 *
 * Prices are today's, in rupees. `priceDrop` is said only when the server
 * knows what the line cost when it was saved; nothing here is ever charged.
 */
export interface SavedEntry {
  key: string;
  /** The server row (signed in). */
  id: number | null;
  /** The local line (signed out). */
  lineId: string | null;
  product: Product;
  size: string | null;
  color: string | null;
  quantity: number;
  status: discovery.SavedStatus;
  message: string;
  maxQuantity: number;
  canMoveToCart: boolean;
  unitPrice: number;
  priceDrop: { from: number; to: number } | null;
  inWishlist: boolean;
  savedAt: string | number;
}

function fromServer(item: discovery.SavedItem): SavedEntry {
  return {
    key: `s-${item.id}`,
    id: item.id,
    lineId: null,
    product: item.product,
    size: item.size,
    color: item.color,
    quantity: item.quantity,
    status: item.status,
    message: item.message,
    maxQuantity: item.maxQuantity,
    canMoveToCart: item.canMoveToCart,
    unitPrice: item.unitPrice / 100,
    priceDrop: item.priceDrop ? { from: item.priceDrop.from / 100, to: item.priceDrop.to / 100 } : null,
    inWishlist: item.inWishlist,
    savedAt: item.savedAt,
  };
}

/** A guest's line against the live catalogue: the same checks the server makes, for display. */
export function guestStatus(product: Product, size: string | null, quantity: number) {
  if (product.sizes.length > 0 && (!size || !product.sizes.includes(size))) {
    return { status: "variant-unavailable" as const, message: "This option is no longer available — choose another.",
      maxQuantity: 0 };
  }
  if (product.stock <= 0) return { status: "out-of-stock" as const, message: "Currently unavailable", maxQuantity: 0 };
  const cap = Math.min(product.stock, 10);
  if (quantity > cap) return { status: "limited" as const, message: `Only ${cap} available`, maxQuantity: cap };
  return { status: "available" as const, message: "", maxQuantity: cap };
}

export function useSavedForLater(options: { onCart?: (cart: ServerCart) => void } = {}) {
  const { onCart } = options;
  const hydrated = useHydrated();
  const { isSignedIn, isPending } = useCustomerStatus();

  const guestLines = useSavedForLaterStore((state) => state.lines);
  const saveGuest = useSavedForLaterStore((state) => state.save);
  const removeGuest = useSavedForLaterStore((state) => state.remove);
  const clearGuest = useSavedForLaterStore((state) => state.clear);
  const addGuestCart = useCartStore((state) => state.addItem);
  const removeGuestCart = useCartStore((state) => state.removeLine);

  const [serverItems, setServerItems] = useState<discovery.SavedItem[] | null>(null);
  const [guestProducts, setGuestProducts] = useState<Map<string, Product>>(new Map());
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  /** The entry an action is running on, so its buttons can't be pressed twice. */
  const [busy, setBusy] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!hydrated || !isSignedIn) return;
    let active = true;
    setLoading(true);
    discovery
      .fetchSaved()
      .then((list) => {
        if (!active) return;
        setServerItems(list.items);
        setFailed(false);
      })
      .catch(() => {
        if (!active) return;
        setServerItems([]);
        setFailed(true);
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [hydrated, isSignedIn, version]);

  const guestKey = guestLines.map((line) => line.productId).join(",");
  useEffect(() => {
    if (!hydrated || isSignedIn || isPending || guestKey === "") return;
    let active = true;
    setLoading(true);
    getProductsByIds([...new Set(guestKey.split(","))])
      .then((products) => active && setGuestProducts(new Map(products.map((p) => [p.id, p]))))
      .catch(() => active && setGuestProducts(new Map()))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [hydrated, isSignedIn, isPending, guestKey]);

  const entries: SavedEntry[] = useMemo(() => {
    if (isSignedIn) return (serverItems ?? []).map(fromServer);
    return guestLines.flatMap((line) => {
      const product = guestProducts.get(line.productId);
      // A product that can no longer be found is withdrawn; drop it quietly.
      if (!product) return [];
      const state = guestStatus(product, line.size, line.quantity);
      return [{
        key: `g-${line.lineId}`,
        id: null,
        lineId: line.lineId,
        product,
        size: line.size,
        color: line.color,
        quantity: line.quantity,
        ...state,
        canMoveToCart: state.status === "available" || state.status === "limited",
        unitPrice: product.price,
        priceDrop: null,
        inWishlist: false,
        savedAt: line.savedAt,
      }];
    });
  }, [isSignedIn, serverItems, guestLines, guestProducts]);

  /** Move a bag line here. */
  const saveLine = useCallback(
    async (line: ResolvedCartLine) => {
      if (!isSignedIn) {
        saveGuest({ productId: line.productId, size: line.size, color: line.color, quantity: line.quantity });
        removeGuestCart(line.lineId);
        toast.success(`${line.product.name} saved for later`);
        return true;
      }
      setBusy(`c-${line.lineId}`);
      try {
        const result = await discovery.saveForLater(line.lineId);
        setServerItems(result.saved.items);
        onCart?.(result.cart);
        toast.success(`${line.product.name} saved for later`);
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "We couldn't save that for later.");
        return false;
      } finally {
        setBusy(null);
      }
    },
    [isSignedIn, saveGuest, removeGuestCart, onCart],
  );

  /** Back to the bag — checked again by the server (signed in) or against live stock (guest). */
  const moveToCart = useCallback(
    async (entry: SavedEntry) => {
      if (!entry.canMoveToCart) {
        toast.error(entry.message || `${entry.product.name} is currently unavailable.`);
        return false;
      }
      if (!isSignedIn) {
        addGuestCart({
          productId: entry.product.id,
          size: entry.size,
          color: entry.color,
          quantity: Math.min(entry.quantity, entry.maxQuantity || entry.quantity),
          maxQuantity: entry.product.stock,
        });
        if (entry.lineId) removeGuest(entry.lineId);
        toast.success(`${entry.product.name} moved to your bag`);
        return true;
      }
      if (entry.id === null) return false;
      setBusy(entry.key);
      try {
        const result = await discovery.moveSavedToCart(entry.id);
        setServerItems(result.saved.items);
        onCart?.(result.cart);
        toast.success(`${entry.product.name} moved to your bag`);
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "We couldn't move that to your bag.");
        // The answer may have changed what's possible (sold out since): read again.
        setVersion((v) => v + 1);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [isSignedIn, addGuestCart, removeGuest, onCart],
  );

  const remove = useCallback(
    async (entry: SavedEntry) => {
      if (!isSignedIn) {
        if (entry.lineId) removeGuest(entry.lineId);
        return true;
      }
      if (entry.id === null) return false;
      setBusy(entry.key);
      try {
        const list = await discovery.removeSaved(entry.id);
        setServerItems(list.items);
        toast.info(`${entry.product.name} removed`);
        return true;
      } catch {
        toast.error("We couldn't remove that. Please try again.");
        return false;
      } finally {
        setBusy(null);
      }
    },
    [isSignedIn, removeGuest],
  );

  const clear = useCallback(async () => {
    if (!isSignedIn) {
      clearGuest();
      return;
    }
    try {
      const list = await discovery.clearSaved();
      setServerItems(list.items);
    } catch {
      toast.error("We couldn't clear your saved items. Please try again.");
    }
  }, [isSignedIn, clearGuest]);

  return {
    entries,
    count: entries.length,
    isLoading: !hydrated || isPending || loading || (isSignedIn && serverItems === null),
    failed,
    busy,
    saveLine,
    moveToCart,
    remove,
    clear,
    refresh: () => setVersion((v) => v + 1),
  };
}
