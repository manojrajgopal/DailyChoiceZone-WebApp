"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { BillingBreakdown, CartTotals, Product, ResolvedCartLine } from "@/types";

import * as cartService from "@/services/cartService";
import { useConfirmedCustomer, useCustomerStatus } from "@/hooks/useSession";
import { useCartStore } from "@/store/cartStore";
import { useCheckoutStore } from "@/store/checkoutStore";
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

/**
 * The item count from the most recent server cart, shared across the page.
 *
 * The header badge and the bag itself both want to know what is in the cart.
 * Without this they each fetched it — two reads of the same cart on the one
 * page where both are on screen, and the badge's copy was the less useful of
 * the two because it asked without the delivery method or the coupon.
 *
 * So `useCart` publishes what it loaded and the badge listens. The badge only
 * fetches when nothing has published yet, which is every page except the bag
 * and the checkout.
 */
let publishedCount: number | null = null;
const countListeners = new Set<(count: number) => void>();

/**
 * Set the moment a full cart read starts, not when it finishes.
 *
 * The badge decides whether to fetch during its own effect, which runs in the
 * same commit as the bag's — long before any request has come back. A flag
 * that only went up on completion would always look clear, and the badge would
 * duplicate the request every time.
 */
let fullCartLoading = false;

function publishItemCount(count: number): void {
  publishedCount = count;
  for (const listen of countListeners) listen(count);
}

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

  /**
   * Confirmed, not merely stored.
   *
   * Asking the server for a cart on a token local storage happens to hold is
   * a request that returns 401 whenever that token has expired — one per page,
   * for as long as the stale session sits there.
   *
   * `isPending` is the other half of that answer, and the hook is wrong
   * without it: while the check is in flight a signed-in shopper looks like a
   * guest, and treating them as one resolves an empty local bag and reports an
   * empty cart. The checkout's guard acted on that and sent them back to /cart.
   */
  const { isSignedIn, isPending } = useCustomerStatus();

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
  // Delivery is priced for where it's going, once checkout knows.
  const deliveryPincode = useCheckoutStore((state) => state.address?.pincode ?? null);

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
    // Claimed synchronously so the badge knows not to ask as well.
    fullCartLoading = true;

    cartService
      .fetchCart({
        couponCode: guestCoupon,
        deliveryMethod: deliveryMethodId,
        placeOfSupply: billingState,
        pincode: deliveryPincode,
      })
      .then((result) => {
        if (!active) return;
        setView(result);
        publishItemCount(result.breakdown.itemCount);
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
  }, [hydrated, isSignedIn, guestCoupon, deliveryMethodId, billingState, deliveryPincode, version]);

  /* ---------------------------------------------------------- guest cart */

  useEffect(() => {
    if (!hydrated || isSignedIn || isPending) return;

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
  }, [hydrated, isSignedIn, isPending, guestLines]);

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

  const add = useAddAction(setView);

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
    /** The code in the bag, applied or not. */
    couponCode: guestCoupon,
    /** Why that code does not apply, when it does not. */
    couponError: isSignedIn ? (view?.couponError ?? null) : null,
    membership: isSignedIn ? (view?.membership ?? null) : null,
    /** The delivery pincode's serviceability, once checkout has an address. */
    delivery: isSignedIn ? (view?.delivery ?? null) : null,
    isLoading: !hydrated || isPending || isLoading,
    isEmpty: hydrated && !isPending && !isLoading && lines.length === 0,
    hydrated,

    add,
    remove,
    setQuantity,
    increment,
    decrement,
    applyCode,
    removeCode,
    clear,
    /** Read the bag again from the server — after something outside this hook changed it. */
    refresh,
  };
}

/**
 * Adding to the bag, without reading it.
 *
 * `useCart` loads and prices the entire bag, which is exactly what the bag and
 * the checkout need. A product page, a quick view and the wishlist only ever
 * *write* to it — so mounting the full hook there spent a priced cart read per
 * page to obtain one function, and on the product page it also gave the header
 * badge a second cart to race against.
 *
 * The response to the add is a whole cart, so the badge still gets its number
 * from here the moment something is added.
 */
export function useAddToCart() {
  return useAddAction(null);
}

/**
 * The shared body of `add`.
 *
 * `onView` is the full hook's `setView`, so the bag re-renders from the
 * server's answer. Null for callers that do not display the cart; they still
 * publish the count, which is all the badge reads.
 */
function useAddAction(onView: ((view: cartService.CartView) => void) | null) {
  const isSignedIn = useConfirmedCustomer();
  const addGuestItem = useCartStore((state) => state.addItem);

  return useCallback(
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
          onView?.(result);
          publishItemCount(result.breakdown.itemCount);
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
    [isSignedIn, addGuestItem, onView],
  );
}

/**
 * Just the badge count.
 *
 * Reads whichever bag is live. Zero until hydration so the server and client
 * markup agree.
 *
 * On a page that already shows the cart it takes the count from there rather
 * than fetching one of its own — see `publishItemCount`.
 */
export function useCartCount(): number {
  const hydrated = useHydrated();
  const guestLines = useCartStore((state) => state.lines);
  const [serverCount, setServerCount] = useState(publishedCount ?? 0);

  const isSignedIn = useConfirmedCustomer();

  useEffect(() => {
    if (!isSignedIn) return;

    let active = true;

    const listen = (count: number) => {
      if (active) setServerCount(count);
    };
    countListeners.add(listen);

    if (publishedCount !== null) {
      setServerCount(publishedCount);
      return () => {
        active = false;
        countListeners.delete(listen);
      };
    }

    /**
     * Decide in a microtask, not here.
     *
     * The badge lives in the layout and the bag in the page, so this effect
     * usually runs first — before the bag has had a chance to say it is already
     * loading the cart. React flushes every effect of one commit in a single
     * synchronous pass, so a microtask queued here runs after all of them.
     *
     * "Usually", not always: the two can land in different commits when the
     * page streams in behind its layout, and then the badge asks as well. That
     * is why it asks for a count rather than a cart — the duplicate, when it
     * happens, is an integer instead of a priced bag.
     */
    queueMicrotask(() => {
      if (!active || fullCartLoading || publishedCount !== null) return;

      // Nothing on this page shows the cart, so the badge reads the count.
      void cartService
        .fetchCartCount()
        .then((count) => {
          if (active) publishItemCount(count);
        })
        .catch(() => {
          if (active) setServerCount(0);
        });
    });

    return () => {
      active = false;
      countListeners.delete(listen);
    };
  }, [isSignedIn]);

  if (!hydrated) return 0;
  if (isSignedIn) return serverCount;
  return guestLines.reduce((sum, line) => sum + line.quantity, 0);
}
