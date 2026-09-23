"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { BillingBreakdown, CartTotals, Coupon, Product, ResolvedCartLine } from "@/types";

import {
  applyCoupon as validateCoupon,
  computeTotals,
  resolveCartLines,
  type DeliverySettings,
  DEFAULT_DELIVERY,
} from "@/services/cartService";
import { getDeliveryMethod } from "@/services/orderService";
import { getSiteConfig } from "@/services/siteService";
import { breakdownForCart } from "@/services/billing/billingService";
import { useCartStore } from "@/store/cartStore";
import { useCheckoutStore } from "@/store/checkoutStore";
import { toast } from "@/store/toastStore";

import { useHydrated } from "./useHydrated";

/**
 * The cart, joined against the catalogue and priced.
 *
 * This is the only cart API components should use. It owns the awkward parts:
 * resolving stored ids to products, re-validating the saved coupon against the
 * current subtotal, and not rendering persisted state until after hydration.
 */
export function useCart() {
  const hydrated = useHydrated();

  const lines = useCartStore((state) => state.lines);
  const couponCode = useCartStore((state) => state.couponCode);
  const addItem = useCartStore((state) => state.addItem);
  const removeLine = useCartStore((state) => state.removeLine);
  const setQuantity = useCartStore((state) => state.setQuantity);
  const incrementLine = useCartStore((state) => state.incrementLine);
  const decrementLine = useCartStore((state) => state.decrementLine);
  const applyCouponCode = useCartStore((state) => state.applyCouponCode);
  const clearCart = useCartStore((state) => state.clearCart);

  const [resolved, setResolved] = useState<ResolvedCartLine[]>([]);
  const [validatedCoupon, setValidatedCoupon] = useState<Coupon | null>(null);
  const [delivery, setDelivery] = useState<DeliverySettings>(DEFAULT_DELIVERY);
  const [isResolving, setIsResolving] = useState(false);

  // Delivery thresholds come from site config, so pricing rules stay in data.
  useEffect(() => {
    let active = true;
    getSiteConfig()
      .then((config) => {
        if (!active) return;
        setDelivery({
          freeDeliveryThreshold: config.freeDeliveryThreshold,
          standardDeliveryFee: config.standardDeliveryFee,
        });
      })
      .catch(() => {
        // Keep the defaults; a missing config should not break the cart.
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    // Nothing to resolve. The empty case is derived below rather than written
    // into state, which keeps this effect free of synchronous setState.
    if (!hydrated || lines.length === 0) return;

    let active = true;
    setIsResolving(true);

    resolveCartLines(lines)
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
  }, [lines, hydrated]);

  /**
   * Derived, not stored.
   *
   * Clearing the bag takes effect on the very next render rather than waiting
   * for an effect — which matters at checkout, where a stale line would mean a
   * stale total.
   *
   * Memoised so the identity is stable: the totals calculation below depends
   * on it, and a fresh array each render would recompute the money on every
   * keystroke elsewhere in the tree.
   */
  const resolvedLines = useMemo(
    () => (hydrated && lines.length > 0 ? resolved : []),
    [hydrated, lines.length, resolved],
  );

  const subtotal = useMemo(
    () => resolvedLines.reduce((sum, line) => sum + line.lineTotal, 0),
    [resolvedLines],
  );

  // Re-validate the stored code whenever the subtotal moves: removing an item
  // can drop the cart below a coupon's minimum, and the total must reflect that.
  useEffect(() => {
    if (!couponCode) return;

    let active = true;
    validateCoupon(couponCode, subtotal)
      .then((result) => {
        if (!active) return;
        setValidatedCoupon(result.ok ? result.coupon : null);
      })
      .catch(() => {
        if (active) setValidatedCoupon(null);
      });

    return () => {
      active = false;
    };
  }, [couponCode, subtotal]);

  /** No code means no coupon, without waiting for an effect to clear it. */
  const coupon = couponCode ? validatedCoupon : null;

  /**
   * The delivery method chosen at checkout, if any.
   *
   * Read here so the figures in the bag, in every checkout step and on the
   * confirmation all come from one calculation — picking express must change
   * the total everywhere at once, not just on the step that set it.
   */
  const deliveryMethodId = useCheckoutStore((state) => state.deliveryMethodId);

  const totals: CartTotals = useMemo(() => {
    const method = getDeliveryMethod(deliveryMethodId);
    return computeTotals(resolvedLines, coupon, delivery, { id: method.id, fee: method.fee });
  }, [resolvedLines, coupon, delivery, deliveryMethodId]);

  /**
   * The state tax is charged against.
   *
   * The billing address decides it, so it is only known once one has been
   * entered. Before that the seller's own state stands in, which shows the
   * intra-state split; entering an out-of-state address switches the labelling
   * to IGST. The grand total is identical either way — same rate, different
   * name — so nothing a shopper is quoted moves.
   */
  const billingState = useCheckoutStore((state) => state.billingAddress?.state ?? state.address?.state ?? "");

  /**
   * The full money picture, from the one billing calculation.
   *
   * Everything downstream — the bag, every checkout step, the confirmation and
   * the invoice — renders this. `totals` is kept because the free-delivery
   * nudge and the coupon plumbing are expressed in it, but no component does
   * its own arithmetic on either.
   */
  const breakdown: BillingBreakdown = useMemo(
    () => breakdownForCart(resolvedLines, totals, billingState),
    [resolvedLines, totals, billingState],
  );

  /** Add a product, with a toast and a link straight to the cart. */
  const add = useCallback(
    (
      product: Product,
      options: { size?: string | null; color?: string | null; quantity?: number } = {},
    ) => {
      addItem({
        productId: product.id,
        size: options.size ?? null,
        color: options.color ?? null,
        quantity: options.quantity ?? 1,
        maxQuantity: product.stock,
      });
      toast.success(`${product.name} added to bag`, { label: "View bag", href: "/cart" });
    },
    [addItem],
  );

  const remove = useCallback(
    (lineId: string, productName?: string) => {
      removeLine(lineId);
      toast.info(productName ? `${productName} removed` : "Item removed from bag");
    },
    [removeLine],
  );

  const applyCode = useCallback(
    async (code: string) => {
      const result = await validateCoupon(code, subtotal);
      if (result.ok) {
        applyCouponCode(result.coupon.code);
        toast.success(`Coupon ${result.coupon.code} applied`);
      } else {
        toast.error(result.reason);
      }
      return result;
    },
    [applyCouponCode, subtotal],
  );

  const removeCode = useCallback(() => {
    applyCouponCode(null);
    toast.info("Coupon removed");
  }, [applyCouponCode]);

  return {
    /** Render-ready lines. Empty until hydration completes. */
    lines: resolvedLines,
    /** Raw stored lines — use only when you need ids without products. */
    rawLines: lines,
    totals,
    /** The billing breakdown for these lines. One calculation, shared. */
    breakdown,
    coupon,
    /** True while ids are being joined against the catalogue. */
    isLoading: !hydrated || isResolving,
    isEmpty: hydrated && lines.length === 0,
    hydrated,

    add,
    remove,
    setQuantity,
    increment: incrementLine,
    decrement: decrementLine,
    applyCode,
    removeCode,
    clear: clearCart,
  };
}

/**
 * Just the badge count, so the header does not resolve the whole cart.
 *
 * Returns 0 until hydrated to keep server and client markup identical.
 */
export function useCartCount(): number {
  const hydrated = useHydrated();
  const lines = useCartStore((state) => state.lines);
  if (!hydrated) return 0;
  return lines.reduce((sum, line) => sum + line.quantity, 0);
}
