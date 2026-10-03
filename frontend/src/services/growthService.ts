import type { Product } from "@/types";

import { apiDelete, apiGet, apiPost, apiPut, getToken, query } from "@/services/api/client";

/**
 * Storefront calls for flash sales, bundles, referrals and the analytics
 * events. Prices and rewards come from the server; nothing here decides one.
 */

const AUTH = { auth: "customer" } as const;

/* ------------------------------------------------------------- flash sales */

export interface FlashSaleView {
  id: number;
  name: string;
  description: string;
  phase: "scheduled" | "live" | "ended";
  startsAt: string;
  endsAt: string;
  allowCoupons: boolean;
  items: {
    id: number;
    productId: string;
    salePrice: number;
    regularPrice: number;
    stockLimit: number | null;
    perCustomerLimit: number | null;
    remaining: number | null;
    soldOut: boolean;
    product: Product;
  }[];
}

export const getFlashSales = () =>
  apiGet<{ live: FlashSaleView[]; upcoming: FlashSaleView[]; serverTime: string }>("/flash-sales");

/* ----------------------------------------------------------------- bundles */

export interface BundleView {
  id: number;
  slug: string;
  name: string;
  description: string;
  image: string;
  price: number;
  regularPrice: number;
  saving: number;
  savingPercent: number;
  available: number;
  purchasable: boolean;
  reason: string | null;
  maxPerOrder: number;
  startsAt: string | null;
  endsAt: string | null;
  components: { productId: string; quantity: number; unitPrice: number; regularPrice: number; available: number; product: Product }[];
}

export const getBundles = (productId?: string) => apiGet<BundleView[]>(`/bundles${query({ productId })}`);
export const getBundle = (slug: string) => apiGet<BundleView>(`/bundles/${encodeURIComponent(slug)}`);

/** A bundle in the bag, as the server priced it. Money in paise. */
export interface CartBundleLine {
  id: number;
  bundleId: number;
  slug: string;
  name: string;
  image: string;
  quantity: number;
  unitPrice: number;
  regularUnitPrice: number;
  lineTotal: number;
  available: number;
  maxPerOrder: number;
  problem: string | null;
  components: { productId: string; name: string; slug: string; image: string; size: string | null; color: string | null; quantity: number }[];
}

export interface BagIssue {
  code: string;
  message: string;
  productId?: string;
  cartItemId?: number;
  cartBundleId?: number;
}

type CartPayload = { breakdown: { itemCount: number } };

export const addBundleToCart = (bundleId: number, quantity: number, selections: { productId: string; size?: string | null; color?: string | null }[]) =>
  apiPost<CartPayload>("/cart/bundles", { bundleId, quantity, selections }, AUTH);
export const setBundleQuantity = (entryId: number, quantity: number) => apiPut<CartPayload>(`/cart/bundles/${entryId}`, { quantity }, AUTH);
export const removeBundle = (entryId: number) => apiDelete<CartPayload>(`/cart/bundles/${entryId}`, AUTH);

/* --------------------------------------------------------------- referrals */

export interface ReferralRules {
  enabled: boolean;
  rewardType: "store_credit" | "points";
  referrerReward: number;
  refereeReward: number;
  minOrderAmount: number;
  rewardOn: "paid" | "delivered";
  windowDays: number;
  unit: string;
}

export interface MyReferrals {
  rules: ReferralRules;
  code: string | null;
  codeDisabled: boolean;
  shareUrl: string | null;
  stats: { invited: number; pending: number; rewarded: number; earnedCredit: number; earnedPoints: number };
  referrals: { id: number; name: string; status: string; statusLabel: string; joinedAt: string; rewardedAt: string | null; reward: string | null; expiresAt: string | null }[];
  joinedWith: { status: string; statusLabel: string; reward: string | null; expiresAt: string | null } | null;
  unit: string;
}

export const getMyReferrals = () => apiGet<MyReferrals>("/account/referrals", AUTH);
export const checkReferralCode = (code: string) =>
  apiGet<{ valid: boolean; code: string | null; rules: ReferralRules | null }>(`/referrals/check${query({ code })}`);

/** The code from a `?ref=` link, kept until sign-up. */
const REFERRAL_KEY = "dcz:referral-code";

export function rememberReferralCode(code: string): void {
  try {
    localStorage.setItem(REFERRAL_KEY, code.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 16));
  } catch {
    /* storage off: the code can still be typed */
  }
}

export function rememberedReferralCode(): string {
  try {
    return localStorage.getItem(REFERRAL_KEY) ?? "";
  } catch {
    return "";
  }
}

export function forgetReferralCode(): void {
  try {
    localStorage.removeItem(REFERRAL_KEY);
  } catch {
    /* nothing to forget */
  }
}

/* --------------------------------------------------------------- analytics */

const VISITOR_KEY = "dcz:visitor";

/** A random id for this browser — not tied to a person. */
function visitorId(): string {
  try {
    let id = localStorage.getItem(VISITOR_KEY);
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      id = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9-]/g, "");
      localStorage.setItem(VISITOR_KEY, id);
    }
    return id;
  } catch {
    return "";
  }
}

/**
 * Tell the server about a visit, a product viewed or checkout opened. Fire
 * and forget: analytics must never slow down or break the page.
 */
export type TrackedEvent =
  | "visit"
  | "product_view"
  | "checkout_start"
  // Product discovery: a recommendation rail seen or clicked, a recently viewed product reopened.
  | "recommendation_impression"
  | "recommendation_click"
  | "recently_viewed_click";

export function trackEvent(
  event: TrackedEvent,
  extra: { productId?: string; utmSource?: string; placement?: string } = {},
): void {
  if (typeof window === "undefined") return;
  const id = visitorId();
  if (!id) return;
  const signedIn = Boolean(getToken("customer"));
  void apiPost("/analytics/events", {
    event, visitorId: id, productId: extra.productId, referrer: document.referrer.slice(0, 500),
    utmSource: (extra.utmSource ?? "").slice(0, 60),
    ...(extra.placement ? { placement: extra.placement.slice(0, 60) } : {}),
  }, signedIn ? AUTH : {}).catch(() => undefined);
}
