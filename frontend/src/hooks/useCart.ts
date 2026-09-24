"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { BillingBreakdown, CartTotals, Product, ResolvedCartLine } from "@/types";

import * as cartService from "@/services/cartService";
import { useCartStore } from "@/store/cartStore";
import { useCheckoutStore } from "@/store/checkoutStore";
import { useSessionStore } from "@/store/sessionStore";
import { toast } from "@/store/toastStore";

import { useHydrated } from "./useHydrated";

/**
 * The cart, priced by the server.
 *
 * Two modes, one interface. **Signed in**, everything lives on the server: the
 * lines, the coupon, and every figure in the breakdown. **Signed out**, the
 * lines are staged in local storage and priced only as a subtotal, because
 * delivery, coupons and tax are the server's to decide and quoting a guest a
 * total the checkout then disagrees with is worse than quoting none.
 *
 * Components see the same shape either way, which is why none of them changed
 * when the backend arrived.
 */

const EMPTY_BREAKDOWN: BillingBreakdown = {
  currency: "INR",
  itemCount: 0,
  subtotal: 0,
  productDiscount: 0,
  couponDiscount: 0,
  couponCode: null,
  shipping: 0,
  otherCharges: 0,
  taxableAmount: 0,
  tax: { mode: "none", taxableAmount: 0, cgst: 0, sgst: 0, igst: 0, totalTax: 0, ratePercent: 0 },
  grandTotal: 0,
  pricesIncludeTax: true,
};

const EMPTY_TOTALS: CartTotals = {
  itemCount: 0,
  subtotal: 0,
  catalogueSavings: 0,
  couponDiscount: 0,
  deliveryFee: 0,
  total: 0,
  freeDeliveryShortfall: 0,
  appliedCoupon: null,
};

export function useCart() {
  const hydrated = useHydrated();

  const session = useSessionStore((state) => state.session);
  const isSignedIn = hydrated && session !== null;

  // The guest bag. Also the staging area that `mergeGuestCart` drains.
  const guestLines = useCartStore((state) => state.lines);
  const guestCoupon = useCartStore((state) => state.couponCode);
  const addGuestItem = useCartStore((state) => state.addItem);
  const removeGuestLine = useCartStore((state) => state.removeLine);
  const setGuestQuantity = useCartStore((state) => state.setQuantity);
  const applyGuestCoupon = useCartStore((state) => state.applyCouponCode);
  const clearGuestCart = useCartStore((state) => state.clearCart);

  const deliveryMethodId = useCheckoutStore((state) => state.deliveryMethodId);
  const billingState = useCheckoutStore(
    (state) => state.billingAddress?.state ?? state.address?.state ?? null,
  );

  const [view, setView] = useState<cartService.CartView | null>(null);
  const [guestResolved, setGuestResolved] = useState<ResolvedCartLine[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [version, setVersion] = useState(0);

  /** Force a re-read after a mutation. */
  const refresh = useCallback(() => setVersion((current) => current + 1), []);

  /* --------------------------------------------------------- server cart */

  useEffect(() => {
    if (!hydrated || !isSignedIn) return;

    let active = true;
    cartService
      .fetchCart({
        couponCode: guestCoupon,
        deliveryMethod: deliveryMethodId,
        placeOfSupply: billingState,
      })
      .then((result) => {
        if (active) setView(result);
      })
      .catch(() => {
        if (active) setView(null);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [hydrated, isSignedIn, guestCoupon, deliveryMethodId, billingState, version]);

  /* ---------------------------------------------------------- guest cart */

  useEffect(() => {
    if (!hydrated || isSignedIn) return;

    let active = true;
    cartService
      .resolveGuestCart(guestLines)
      .then((lines) => {
        if (active) setGuestResolved(lines);
      })
      .catch(() => {
        if (active) setGuestResolved([]);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [hydrated, isSignedIn, guestLines]);

  /* -------------------------------------------------- merge on sign-in */

  const merged = useRef(false);

  useEffect(() => {
    if (!hydrated || !isSignedIn || merged.current) return;
    if (guestLines.length === 0) {
      merged.current = true;
      return;
    }

    merged.current = true;
    const staged = [...guestLines];
    clearGuestCart();

    void cartService.mergeGuestCart(staged).then(refresh);
  }, [hydrated, isSignedIn, guestLines, clearGuestCart, refresh]);

  /* ------------------------------------------------------------- derived */

  const lines: ResolvedCartLine[] = isSignedIn ? (view?.lines ?? []) : guestResolved;

  const breakdown: BillingBreakdown = useMemo(() => {
    if (isSignedIn) return view?.breakdown ?? EMPTY_BREAKDOWN;

    // A guest sees the goods value and nothing else, for the reason in the
    // hook's own docstring.
    const subtotal = guestResolved.reduce((sum, line) => sum + line.lineTotal, 0);
    const listTotal = guestResolved.reduce((sum, line) => sum + line.lineOriginalTotal, 0);

    return {
      ...EMPTY_BREAKDOWN,
      itemCount: guestResolved.reduce((count, line) => count + line.quantity, 0),
      subtotal: Math.round(subtotal * 100),
      productDiscount: Math.round(Math.max(0, listTotal - subtotal) * 100),
      grandTotal: Math.round(subtotal * 100),
    };
  }, [isSignedIn, view, guestResolved]);

  const totals: CartTotals = useMemo(() => {
    if (isSignedIn) return view?.totals ?? EMPTY_TOTALS;

    const subtotal = guestResolved.reduce((sum, line) => sum + line.lineTotal, 0);
    const listTotal = guestResolved.reduce((sum, line) => sum + line.lineOriginalTotal, 0);

    return {
      ...EMPTY_TOTALS,
      itemCount: guestResolved.reduce((count, line) => count + line.quantity, 0),
      subtotal,
      catalogueSavings: Math.max(0, listTotal - subtotal),
      total: subtotal,
    };
  }, [isSignedIn, view, guestResolved]);

  /* ------------------------------------------------------------- actions */

  const add = useCallback(
    async (
      product: Product,
      options: { size?: string | null; color?: string | null; quantity?: number } = {},
    ) => {
      if (isSignedIn) {
        try {
          const result = await cartService.addToCart({
            productId: product.id,
            size: options.size ?? null,
            color: options.color ?? null,
            quantity: options.quantity ?? 1,
          });
          setView(result);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Could not add that to your bag.");
          return;
        }
      } else {
        addGuestItem({
          productId: product.id,
          size: options.size ?? null,
          color: options.color ?? null,
          quantity: options.quantity ?? 1,
          maxQuantity: product.stock,
        });
      }

      toast.success(`${product.name} added to bag`, { label: "View bag", href: "/cart" });
    },
    [isSignedIn, addGuestItem],
  );

  const remove = useCallback(
    async (lineId: string, productName?: string) => {
      if (isSignedIn) {
        try {
          setView(await cartService.removeFromCart(lineId));
        } catch {
          toast.error("Could not remove that item.");
          return;
        }
      } else {
        removeGuestLine(lineId);
      }

      toast.info(productName ? `${productName} removed` : "Item removed from bag");
    },
    [isSignedIn, removeGuestLine],
  );

  const setQuantity = useCallback(
    async (lineId: string, quantity: number, maxQuantity?: number) => {
      if (isSignedIn) {
        try {
          setView(await cartService.setCartQuantity(lineId, quantity));
        } catch {
          toast.error("Could not change that quantity.");
        }
        return;
      }
      setGuestQuantity(lineId, quantity, maxQuantity);
    },
    [isSignedIn, setGuestQuantity],
  );

  const increment = useCallback(
    (lineId: string, maxQuantity?: number) => {
      const line = lines.find((entry) => entry.lineId === lineId);
      return setQuantity(lineId, (line?.quantity ?? 0) + 1, maxQuantity);
    },
    [lines, setQuantity],
  );

  const decrement = useCallback(
    (lineId: string) => {
      const line = lines.find((entry) => entry.lineId === lineId);
      return setQuantity(lineId, Math.max(0, (line?.quantity ?? 1) - 1));
    },
    [lines, setQuantity],
  );

  const applyCode = useCallback(
    async (code: string) => {
      const result = await cartService.applyCoupon(code, totals.subtotal);

      if (result.ok) {
        applyGuestCoupon(result.coupon.code);
        refresh();
        toast.success(`Coupon ${result.coupon.code} applied`);
      } else {
        toast.error(result.reason);
      }

      return result;
    },
    [totals.subtotal, applyGuestCoupon, refresh],
  );

  const removeCode = useCallback(() => {
    applyGuestCoupon(null);
    refresh();
    toast.info("Coupon removed");
  }, [applyGuestCoupon, refresh]);

  const clear = useCallback(async () => {
    if (isSignedIn) {
      try {
        setView(await cartService.clearCart());
      } catch {
        /* the order that emptied it has already succeeded */
      }
    }
    clearGuestCart();
  }, [isSignedIn, clearGuestCart]);

  return {
    lines,
    /** Raw stored lines — the guest staging area. */
    rawLines: guestLines,
    totals,
    /** The billing breakdown, in minor units. Calculated by the server. */
    breakdown,
    coupon: totals.appliedCoupon,
    isLoading: !hydrated || isLoading,
    isEmpty: hydrated && !isLoading && lines.length === 0,
    hydrated,

    add,
    remove,
    setQuantity,
    increment,
    decrement,
    applyCode,
    removeCode,
    clear,
  };
}

/**
 * Just the badge count.
 *
 * Reads whichever bag is live. Zero until hydration so the server and client
 * markup agree.
 */
export function useCartCount(): number {
  const hydrated = useHydrated();
  const session = useSessionStore((state) => state.session);
  const guestLines = useCartStore((state) => state.lines);
  const [serverCount, setServerCount] = useState(0);

  const isSignedIn = hydrated && session !== null;

  useEffect(() => {
    if (!isSignedIn) return;

    let active = true;
    cartService
      .fetchCart({})
      .then((cart) => {
        if (active) setServerCount(cart.breakdown.itemCount);
      })
      .catch(() => {
        if (active) setServerCount(0);
      });

    return () => {
      active = false;
    };
  }, [isSignedIn]);

  if (!hydrated) return 0;
  if (isSignedIn) return serverCount;
  return guestLines.reduce((sum, line) => sum + line.quantity, 0);
}
