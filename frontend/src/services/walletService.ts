import { apiGet, apiPost, query } from "@/services/api/client";
import type { GatewayHandoff } from "@/types";

/**
 * Gift cards, store credit and reward points.
 *
 * Every balance and every amount is worked out on the server. A gift card
 * code is sent to the server and nowhere else — never stored in the browser.
 * Money here is in rupees, except where a field says paise.
 */

const AUTH = { auth: "customer" } as const;

export interface Paged<T> {
  items: T[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
}

/* ------------------------------------------------------------- gift cards */

export interface GiftCardOptions {
  enabled: boolean;
  minAmount: number;
  maxAmount: number;
  denominations: number[];
  allowCustomAmount: boolean;
  validityMonths: number;
}

export interface GiftCardSummary {
  id: number;
  last4: string;
  status: "pending" | "active" | "partially-used" | "used" | "expired" | "disabled" | "refunded" | "cancelled";
  balance: number;
  initialAmount: number;
  expiresAt: string | null;
  usable: boolean;
  recipientName: string;
  recipientEmail: string;
  message: string;
  createdAt: string;
  deliveredAt: string | null;
  paidAt: string | null;
}

export interface GiftCardCheck {
  valid: boolean;
  reason: string;
  last4?: string;
  status?: GiftCardSummary["status"];
  balance?: number;
  initialAmount?: number;
  expiresAt?: string | null;
  usable?: boolean;
}

export function getGiftCardOptions(): Promise<GiftCardOptions> {
  return apiGet("/gift-cards/options");
}

export function buyGiftCard(input: {
  amount: number;
  recipientName: string;
  recipientEmail: string;
  senderName?: string;
  message?: string;
}): Promise<{ giftCard: GiftCardSummary; gateway: GatewayHandoff | null }> {
  return apiPost("/gift-cards/purchase", input, AUTH);
}

export function verifyGiftCardPayment(cardId: number, response: Record<string, string>): Promise<GiftCardSummary> {
  return apiPost(`/gift-cards/${cardId}/verify`, response, AUTH);
}

export function abandonGiftCard(cardId: number): Promise<void> {
  return apiPost(`/gift-cards/${cardId}/abandon`, {}, AUTH);
}

export function checkGiftCard(code: string): Promise<GiftCardCheck> {
  return apiPost("/gift-cards/check", { code }, AUTH);
}

export function getMyGiftCards(): Promise<GiftCardSummary[]> {
  return apiGet("/gift-cards/mine", AUTH);
}

/* ----------------------------------------------------------- store credit */

export interface StoreCreditEntry {
  id: number;
  kind: string;
  label: string;
  amount: number;
  balanceAfter: number;
  reason: string;
  orderId: string | null;
  createdAt: string;
}

export interface StoreCreditPage extends Paged<StoreCreditEntry> {
  balance: number;
  lifetimeCredited: number;
  lifetimeSpent: number;
}

export function getStoreCredit(page = 1): Promise<StoreCreditPage> {
  return apiGet(`/account/store-credit${query({ page })}`, AUTH);
}

/* ---------------------------------------------------------------- rewards */

export interface RewardRules {
  pointsPer100: number;
  redeemPoints: number;
  redeemValue: number;
  minRedeemPoints: number;
  maxPointsPerOrder: number;
  maxOrderPercent: number;
  expiryMonths: number;
  pendingDays: number | null;
  excludeTax: boolean;
  excludeTenderPaid: boolean;
  excludeDiscountedItems: boolean;
  memberMultiplier: number;
  allowWithCoupons: boolean;
  allowWithGiftCards: boolean;
  allowWithStoreCredit: boolean;
}

export interface RewardEntry {
  id: number;
  kind: string;
  label: string;
  points: number;
  balanceAfter: number;
  orderId: string | null;
  reason: string;
  availableAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface RewardsPage extends Paged<RewardEntry> {
  enabled: boolean;
  available: number;
  debt: number;
  availableValue: number;
  pending: number;
  nextReleaseAt: string | null;
  lifetimeEarned: number;
  lifetimeRedeemed: number;
  lifetimeExpired: number;
  lifetimeReversed: number;
  nextExpiry: { at: string; points: number } | null;
  rules: RewardRules;
}

export function getRewards(page = 1): Promise<RewardsPage> {
  return apiGet(`/account/rewards${query({ page })}`, AUTH);
}

/* --------------------------------------------------------------- checkout */

/** Amounts in paise, like the bag's breakdown. */
export interface TenderPreview {
  grandTotal: number;
  giftCards: { last4: string; applied: number; balance: number; error: string }[];
  giftCardTotal: number;
  storeCredit: { available: number; applied: number };
  points: {
    enabled: boolean;
    available: number;
    maxPoints: number;
    reason: string;
    minRedeemPoints: number;
    redeemPoints: number;
    redeemValue: number;
    applied: number;
    value: number;
  };
  tenderTotal: number;
  amountDue: number;
  messages: string[];
}

export function previewTenders(input: {
  couponCode?: string | null;
  deliveryMethod?: string;
  placeOfSupply?: string | null;
  pincode?: string | null;
  giftCardCodes: string[];
  useStoreCredit: boolean;
  points: number;
}): Promise<TenderPreview> {
  return apiPost("/checkout/tenders", input, AUTH);
}
