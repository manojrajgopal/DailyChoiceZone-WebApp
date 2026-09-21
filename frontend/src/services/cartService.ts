import type { CartLine, CartTotals, Coupon, Product, ResolvedCartLine } from "@/types";

import { dataSource } from "./data-source.instance";

/**
 * Cart pricing.
 *
 * All of it is pure and synchronous, deliberately: the numbers a shopper sees
 * must update the instant they change a quantity, with no request in between.
 * The one async part — resolving ids to products — is separated out.
 *
 * When a real cart API exists, `POST /cart` becomes the source of truth for
 * these totals and this file becomes the optimistic local estimate. The shapes
 * already match, so the UI will not need to change.
 */

export interface DeliverySettings {
  freeDeliveryThreshold: number;
  standardDeliveryFee: number;
}

export const DEFAULT_DELIVERY: DeliverySettings = {
  freeDeliveryThreshold: 999,
  standardDeliveryFee: 79,
};

/* ------------------------------------------------------------ line resolution */

/**
 * Join stored cart lines against the live catalogue.
 *
 * Lines whose product no longer exists are dropped rather than rendered as a
 * broken row — a product can be delisted while it sits in someone's cart.
 * Quantity is clamped to available stock for the same reason.
 */
export async function resolveCartLines(lines: CartLine[]): Promise<ResolvedCartLine[]> {
  if (lines.length === 0) return [];

  const products = await dataSource.getProductsByIds(lines.map((line) => line.productId));
  const byId = new Map(products.map((product) => [product.id, product]));

  return lines
    .map((line) => {
      const product = byId.get(line.productId);
      if (!product) return null;
      const quantity = Math.max(1, Math.min(line.quantity, Math.max(product.stock, 1)));
      return {
        ...line,
        quantity,
        product,
        lineTotal: product.price * quantity,
        lineOriginalTotal: product.originalPrice * quantity,
      } satisfies ResolvedCartLine;
    })
    .filter((line): line is ResolvedCartLine => line !== null)
    .sort((a, b) => a.addedAt - b.addedAt);
}

/* -------------------------------------------------------------------- pricing */

/** What a coupon is worth against a given subtotal. Never exceeds it. */
export function couponDiscountFor(coupon: Coupon | null, subtotal: number): number {
  if (!coupon) return 0;
  if (subtotal < coupon.minSubtotal) return 0;

  if (coupon.type === "percent") {
    const raw = (subtotal * coupon.value) / 100;
    const capped = typeof coupon.maxDiscount === "number" ? Math.min(raw, coupon.maxDiscount) : raw;
    return Math.min(Math.round(capped), subtotal);
  }

  if (coupon.type === "flat") {
    return Math.min(coupon.value, subtotal);
  }

  // free-shipping waives delivery instead of reducing the subtotal.
  return 0;
}

/**
 * The full money picture.
 *
 * Two rules worth stating, because both are easy to get subtly wrong:
 *
 * 1. The free-delivery threshold is tested against the *pre-coupon* subtotal.
 *    Applying a coupon should never quietly add a delivery fee back — that
 *    reads as a bug to a shopper even when the arithmetic is defensible.
 *
 * 2. The threshold waives *standard* delivery only. Express is a paid
 *    upgrade, so its fee stands whatever the basket is worth; spending more
 *    should not silently turn a paid upgrade into a free one.
 *
 * `selectedDelivery` is omitted on the bag page, where no method has been
 * chosen yet and standard is the honest default.
 */
export function computeTotals(
  lines: ResolvedCartLine[],
  coupon: Coupon | null = null,
  settings: DeliverySettings = DEFAULT_DELIVERY,
  selectedDelivery?: { id: string; fee: number },
): CartTotals {
  const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);
  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const originalTotal = lines.reduce((sum, line) => sum + line.lineOriginalTotal, 0);
  const catalogueSavings = Math.max(0, originalTotal - subtotal);

  const appliedCoupon = coupon && subtotal >= coupon.minSubtotal ? coupon : null;
  const couponDiscount = couponDiscountFor(appliedCoupon, subtotal);

  const earnedFreeDelivery =
    subtotal >= settings.freeDeliveryThreshold || appliedCoupon?.type === "free-shipping";

  // An upgrade is any method other than the standard one. Standard pricing
  // stays config-driven; an upgrade carries the fee quoted for that method.
  const isUpgrade = selectedDelivery !== undefined && selectedDelivery.id !== "standard";

  const deliveryFee =
    itemCount === 0
      ? 0
      : isUpgrade
        ? selectedDelivery.fee
        : earnedFreeDelivery
          ? 0
          : settings.standardDeliveryFee;

  return {
    itemCount,
    subtotal,
    catalogueSavings,
    couponDiscount,
    deliveryFee,
    total: Math.max(0, subtotal - couponDiscount + deliveryFee),
    freeDeliveryShortfall: Math.max(0, settings.freeDeliveryThreshold - subtotal),
    appliedCoupon,
  };
}

/* -------------------------------------------------------------------- coupons */

export type CouponResult =
  | { ok: true; coupon: Coupon; discount: number }
  | { ok: false; reason: string };

/**
 * Validate a typed coupon code against the cart.
 *
 * Returns a reason rather than throwing, because "this code needs ₹500 more in
 * your bag" is useful information and not an error condition.
 */
export async function applyCoupon(code: string, subtotal: number): Promise<CouponResult> {
  const trimmed = code.trim().toUpperCase();
  if (!trimmed) return { ok: false, reason: "Enter a coupon code." };

  const coupons = await dataSource.listCoupons();
  const coupon = coupons.find((entry) => entry.code.toUpperCase() === trimmed);

  if (!coupon) {
    return { ok: false, reason: `"${trimmed}" is not a valid code.` };
  }

  if (subtotal < coupon.minSubtotal) {
    const shortfall = coupon.minSubtotal - subtotal;
    return {
      ok: false,
      reason: `Add ₹${shortfall.toLocaleString("en-IN")} more to use ${coupon.code}.`,
    };
  }

  return { ok: true, coupon, discount: couponDiscountFor(coupon, subtotal) };
}

export function getCoupons(): Promise<Coupon[]> {
  return dataSource.listCoupons();
}

/* --------------------------------------------------------------------- helpers */

/**
 * A stable identity for a cart line.
 *
 * The same product in two sizes is two lines; the same product in the same size
 * added twice is one line with quantity two. Encoding the variant in the id is
 * what makes "add to cart" idempotent per variant.
 */
export function buildLineId(productId: string, size: string | null, color: string | null): string {
  return [productId, size ?? "_", color ?? "_"].join("::");
}

/** Is this product orderable at all? Used to disable "Add to cart". */
export function isPurchasable(product: Product): boolean {
  return product.stock > 0;
}
