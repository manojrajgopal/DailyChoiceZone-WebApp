import type { CartLine, CartTotals, Coupon, Product, ResolvedCartLine } from "@/types";
import type { BillingBreakdown } from "@/types";

import { apiDelete, apiGet, apiPost, apiPut, query } from "@/services/api/client";

import { dataSource } from "./data-source.instance";

/**
 * The cart.
 *
 * **The server owns it, and the server prices it.** A signed-in customer's bag
 * follows them between devices, and every figure on it — subtotal, discount,
 * delivery, tax, total — is calculated once, in one place, by the same code
 * that will charge them. The browser renders what it is told.
 *
 * A signed-out visitor still has a bag, kept locally, because forcing someone
 * to create an account before they can look at what they have chosen is a
 * worse shop. That local bag is explicitly **staging, not truth**: it holds
 * ids and quantities only, it is never priced here, and `mergeGuestCart` posts
 * it to the server the moment somebody signs in.
 */

const AUTH = { auth: "customer" } as const;

/* ---------------------------------------------------------------- the shape */

interface ApiCartItem {
  id: number;
  productId: string;
  size: string | null;
  color: string | null;
  quantity: number;
  product: Product;
  lineTotal: number;
}

export interface ServerCart {
  items: ApiCartItem[];
  breakdown: BillingBreakdown;
  freeDeliveryShortfall: number;
  appliedCoupon: (Coupon & { discount: number }) | null;
}

export interface CartView {
  lines: ResolvedCartLine[];
  breakdown: BillingBreakdown;
  totals: CartTotals;
  coupon: Coupon | null;
}

/* -------------------------------------------------------------- conversion */

/**
 * Minor units back to rupees, for the parts of the UI that still speak them.
 *
 * The breakdown is passed through untouched — `formatMoney` reads paise — but
 * `CartTotals` is the shape the cart page and the order record have always
 * used, and changing its units would be a silent bug in every component that
 * reads it.
 */
const toMajor = (minor: number): number => minor / 100;

function toTotals(cart: ServerCart): CartTotals {
  const { breakdown } = cart;

  return {
    itemCount: breakdown.itemCount,
    subtotal: toMajor(breakdown.subtotal),
    catalogueSavings: toMajor(breakdown.productDiscount),
    couponDiscount: toMajor(breakdown.couponDiscount),
    deliveryFee: toMajor(breakdown.shipping),
    total: toMajor(breakdown.grandTotal),
    freeDeliveryShortfall: toMajor(cart.freeDeliveryShortfall),
    appliedCoupon: cart.appliedCoupon
      ? {
          code: cart.appliedCoupon.code,
          description: cart.appliedCoupon.description,
          type: cart.appliedCoupon.type,
          value: cart.appliedCoupon.value,
          minSubtotal: cart.appliedCoupon.minSubtotal,
          maxDiscount: cart.appliedCoupon.maxDiscount ?? undefined,
        }
      : null,
  };
}

function toView(cart: ServerCart): CartView {
  return {
    lines: cart.items.map((item) => ({
      lineId: String(item.id),
      productId: item.productId,
      size: item.size,
      color: item.color,
      quantity: item.quantity,
      addedAt: 0,
      product: item.product,
      lineTotal: toMajor(item.lineTotal),
      lineOriginalTotal: item.product.originalPrice * item.quantity,
    })),
    breakdown: cart.breakdown,
    totals: toTotals(cart),
    coupon: toTotals(cart).appliedCoupon,
  };
}

/* ------------------------------------------------------------ server cart */

export async function fetchCart(options: {
  couponCode?: string | null;
  deliveryMethod?: string;
  placeOfSupply?: string | null;
}): Promise<CartView> {
  const cart = await apiGet<ServerCart>(
    `/cart${query({
      coupon: options.couponCode ?? undefined,
      deliveryMethod: options.deliveryMethod,
      placeOfSupply: options.placeOfSupply ?? undefined,
    })}`,
    AUTH,
  );
  return toView(cart);
}

export async function addToCart(input: {
  productId: string;
  size?: string | null;
  color?: string | null;
  quantity?: number;
}): Promise<CartView> {
  const cart = await apiPost<ServerCart>(
    "/cart/items",
    {
      productId: input.productId,
      size: input.size ?? null,
      color: input.color ?? null,
      quantity: input.quantity ?? 1,
    },
    AUTH,
  );
  return toView(cart);
}

export async function setCartQuantity(lineId: string, quantity: number): Promise<CartView> {
  const cart = await apiPut<ServerCart>(`/cart/items/${lineId}`, { quantity }, AUTH);
  return toView(cart);
}

export async function removeFromCart(lineId: string): Promise<CartView> {
  const cart = await apiDelete<ServerCart>(`/cart/items/${lineId}`, AUTH);
  return toView(cart);
}

export async function clearCart(): Promise<CartView> {
  const cart = await apiDelete<ServerCart>("/cart", AUTH);
  return toView(cart);
}

/**
 * Move a guest's bag onto their account.
 *
 * Called once, immediately after signing in. Each line is posted separately
 * because the server merges by variant — adding the same shirt in the same
 * size twice is one line with quantity two, which is exactly the behaviour
 * wanted when a guest bag meets an account that already had something in it.
 *
 * A line that fails (sold out since, product withdrawn) is skipped rather than
 * failing the whole merge: losing one item quietly is better than losing the
 * bag and the sign-in together.
 */
export async function mergeGuestCart(lines: CartLine[]): Promise<void> {
  for (const line of lines) {
    try {
      await addToCart({
        productId: line.productId,
        size: line.size,
        color: line.color,
        quantity: line.quantity,
      });
    } catch {
      /* skip what can no longer be bought */
    }
  }
}

/* -------------------------------------------------------------- guest bag */

/**
 * Price a signed-out bag, for display only.
 *
 * Resolves ids against the catalogue and sums the lines. It deliberately does
 * **not** apply coupons, delivery or tax: those are the server's to decide,
 * and showing a guest a total the checkout then disagrees with is worse than
 * showing them a subtotal and asking them to sign in.
 */
export async function resolveGuestCart(lines: CartLine[]): Promise<ResolvedCartLine[]> {
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

/* -------------------------------------------------------------- coupons */

export type CouponResult =
  | { ok: true; coupon: Coupon; discount: number }
  | { ok: false; reason: string };

/**
 * Validate a code.
 *
 * Checked by the server, always. A discount the browser works out is a
 * discount the browser can change, and the order recalculates it regardless —
 * so asking here is the only way the answer shown matches the one charged.
 */
export async function applyCoupon(code: string, subtotal: number): Promise<CouponResult> {
  const trimmed = code.trim().toUpperCase();
  if (!trimmed) return { ok: false, reason: "Enter a coupon code." };

  try {
    const result = await apiPost<{
      valid: boolean;
      reason?: string;
      code?: string;
      description?: string;
      type?: Coupon["type"];
      value?: number;
      minSubtotal?: number;
      maxDiscount?: number | null;
      discount?: number;
    }>("/coupons/validate", { code: trimmed, subtotal: Math.round(subtotal * 100) });

    if (!result.valid) {
      return { ok: false, reason: result.reason ?? "That code cannot be used." };
    }

    return {
      ok: true,
      coupon: {
        code: result.code!,
        description: result.description ?? "",
        type: result.type ?? "percent",
        value: result.value ?? 0,
        minSubtotal: result.minSubtotal ?? 0,
        maxDiscount: result.maxDiscount ?? undefined,
      },
      discount: toMajor(result.discount ?? 0),
    };
  } catch {
    return { ok: false, reason: "We could not check that code. Please try again." };
  }
}

export function getCoupons(): Promise<Coupon[]> {
  return dataSource.listCoupons();
}

/* --------------------------------------------------------------- helpers */

/**
 * A stable identity for a guest cart line.
 *
 * Only the local bag needs this — a server line is identified by its row id.
 */
export function buildLineId(productId: string, size: string | null, color: string | null): string {
  return [productId, size ?? "_", color ?? "_"].join("::");
}

export function isPurchasable(product: Product): boolean {
  return product.stock > 0;
}
