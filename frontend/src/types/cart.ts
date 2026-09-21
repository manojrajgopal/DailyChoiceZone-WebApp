import type { Product } from "./product";

/**
 * A line in the cart.
 *
 * It stores a `productId` plus the chosen variant, never a copy of the
 * product. Price and availability are always re-read from the catalogue, so
 * nobody's cart can hold a stale price. `lineId` identifies the line itself,
 * because the same product in two sizes is two separate lines.
 */
export interface CartLine {
  lineId: string;
  productId: string;
  size: string | null;
  color: string | null;
  quantity: number;
  /** When the line was added — keeps cart ordering stable across reloads. */
  addedAt: number;
}

/** A cart line joined against the catalogue, ready to render. */
export interface ResolvedCartLine extends CartLine {
  product: Product;
  lineTotal: number;
  /** What the line would have cost at full list price. */
  lineOriginalTotal: number;
}

export interface Coupon {
  code: string;
  description: string;
  /** "percent" reads `value` as a percentage; "flat" reads it as rupees. */
  type: "percent" | "flat" | "free-shipping";
  value: number;
  /** Cart subtotal required before the coupon applies. */
  minSubtotal: number;
  /** Cap on the discount for percent coupons, in rupees. */
  maxDiscount?: number;
}

/** The fully computed money picture for a cart. Produced by cartService. */
export interface CartTotals {
  itemCount: number;
  subtotal: number;
  /** Savings already baked into list prices. */
  catalogueSavings: number;
  couponDiscount: number;
  deliveryFee: number;
  total: number;
  /** How much more to spend to earn free delivery; zero once earned. */
  freeDeliveryShortfall: number;
  appliedCoupon: Coupon | null;
}
