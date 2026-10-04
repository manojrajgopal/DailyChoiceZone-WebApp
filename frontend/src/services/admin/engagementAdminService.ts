import { apiGet, apiPost, apiPut, apiDelete, query } from "@/services/api/client";

import type { Paged } from "./operationsAdminService";

/**
 * Portal calls for stock and price alerts, product questions, gift cards,
 * store credit and reward points. Every permission is checked by the server.
 * Money is in rupees unless a field says paise.
 */

const ADMIN = { auth: "admin" } as const;

type Person = { id: string; name: string; email: string } | null;

/* ------------------------------------------------------------------ alerts */

export interface AdminAlertRow {
  id: number;
  kind: "stock" | "price";
  status: "active" | "notified" | "unsubscribed";
  size?: string;
  color?: string;
  mode?: "any" | "target";
  baselinePrice?: number;
  targetPrice?: number | null;
  notifiedPrice?: number | null;
  createdAt: string;
  notifiedAt: string | null;
  unsubscribedAt: string | null;
  product: { id: string; name: string; slug: string; image: string; price: number; available: boolean } | null;
  customer: Person;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string;
  delivery: { status: string; error: string; at: string; count: number } | null;
  history?: { fromPrice: number; toPrice: number; outcome: string; note: string; at: string }[];
}

/** `productId` (Product ID or SKU) and `customerId` are matched exactly — never by name or email. */
export function listAlerts(
  kind: "stock" | "price",
  filters: { status?: string; productId?: string; customerId?: string; page?: number; pageSize?: number },
) {
  return apiGet<Paged<AdminAlertRow> & { counts: Record<string, number> }>(`/admin/alerts/${kind}${query(filters)}`, ADMIN);
}

export function resendAlert(kind: "stock" | "price", id: number) {
  return apiPost<{ outcome: string }>(`/admin/alerts/${kind}/${id}/resend`, {}, ADMIN);
}

/* --------------------------------------------------------------- questions */

export interface AdminQuestion {
  id: number;
  status: "pending" | "approved" | "rejected";
  question: string;
  author: string;
  size: string;
  color: string;
  rejectionReason: string;
  askedAt: string;
  moderatedAt: string | null;
  product: { id: string; name: string; slug: string; status: string } | null;
  customer: Person;
  answer: { body: string; published: boolean; by: string; updatedAt: string; publishedAt: string | null } | null;
  events?: { action: string; note: string; by: string; at: string }[];
}

/**
 * `q` is a Question ID, `productId` a Product ID or SKU and `customerId` a
 * Customer ID — each matched exactly. `text` searches the question's own words only.
 */
export function listQuestions(filters: {
  status?: string; answered?: string; q?: string; productId?: string; customerId?: string; text?: string;
  page?: number; pageSize?: number;
}) {
  return apiGet<Paged<AdminQuestion> & { counts: Record<string, number> }>(`/admin/questions${query(filters)}`, ADMIN);
}

export function getQuestion(id: number) {
  return apiGet<AdminQuestion>(`/admin/questions/${id}`, ADMIN);
}

export function approveQuestion(id: number) {
  return apiPost<AdminQuestion>(`/admin/questions/${id}/approve`, {}, ADMIN);
}

export function rejectQuestion(id: number, reason: string) {
  return apiPost<AdminQuestion>(`/admin/questions/${id}/reject`, { reason }, ADMIN);
}

export function answerQuestion(id: number, answer: string, publish: boolean, approve: boolean) {
  return apiPut<AdminQuestion>(`/admin/questions/${id}/answer`, { answer, publish, approve }, ADMIN);
}

export function editQuestion(id: number, question: string) {
  return apiPut<AdminQuestion>(`/admin/questions/${id}`, { question }, ADMIN);
}

export function deleteQuestion(id: number) {
  return apiDelete<void>(`/admin/questions/${id}`, ADMIN);
}

/* -------------------------------------------------------------- gift cards */

export interface AdminGiftCard {
  id: number;
  reference: string;
  last4: string;
  status: string;
  rawStatus: string;
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
  activatedAt: string | null;
  source: "purchase" | "admin";
  senderName: string;
  statusReason: string;
  purchaser: Person;
  gatewayPaymentId: string | null;
  transactions?: { kind: string; label: string; amount: number; balanceAfter: number; orderId: string | null; note: string; at: string }[];
  /** Every email about the card, from the email log. */
  emails?: { to: string; subject: string; status: string; error: string; at: string; bouncedAt: string | null }[];
}

export interface GiftCardSettings {
  enabled: boolean;
  minAmount: number;
  maxAmount: number;
  denominations: number[];
  allowCustomAmount: boolean;
  validityMonths: number;
  maxCardsPerOrder: number;
  allowWithCoupons: boolean;
  storeCreditEnabled: boolean;
  storeCreditWithGiftCards: boolean;
  storeCreditWithCoupons: boolean;
}

/**
 * Gift cards, found by ID only: `q` is a Gift card ID (`GC12`), `customer` the
 * purchaser's Customer ID and `code` a whole card code — each matched exactly.
 */
export function listGiftCards(filters: {
  status?: string;
  q?: string;
  customer?: string;
  code?: string;
  page?: number;
  pageSize?: number;
}) {
  return apiGet<Paged<AdminGiftCard> & { counts: Record<string, number>; outstanding: number }>(
    `/admin/gift-cards${query(filters)}`, ADMIN);
}

export function getGiftCard(id: number) {
  return apiGet<AdminGiftCard>(`/admin/gift-cards/${id}`, ADMIN);
}

export function issueGiftCard(input: { amount: number; recipientName: string; recipientEmail: string; message: string; reason: string }) {
  return apiPost<AdminGiftCard>("/admin/gift-cards", input, ADMIN);
}

export function giftCardAction(id: number, action: "disable" | "enable" | "reissue" | "refund", reason: string) {
  return apiPost<AdminGiftCard>(`/admin/gift-cards/${id}/${action}`, { reason }, ADMIN);
}

export function getGiftCardSettings() {
  return apiGet<GiftCardSettings>("/admin/gift-cards/settings", ADMIN);
}

export function saveGiftCardSettings(settings: GiftCardSettings) {
  return apiPut<GiftCardSettings>("/admin/gift-cards/settings", settings, ADMIN);
}

/* ------------------------------------------------------------ store credit */

export interface CreditBalanceRow {
  customer: { id: string; name: string; email: string; status: string };
  balance: number;
  lifetimeCredited: number;
  lifetimeSpent: number;
  updatedAt: string | null;
}

export interface CreditLedger {
  customer: { id: string; name: string; email: string };
  balance: number;
  lifetimeCredited: number;
  lifetimeSpent: number;
  items: { id: number; kind: string; label: string; amount: number; balanceAfter: number; reason: string; orderId: string | null; createdAt: string; by: string | null }[];
  pagination: Paged<unknown>["pagination"];
}

/** `q`: a Customer ID, exactly — found even without a credit account. */
export function listStoreCredit(filters: { q?: string; withBalance?: boolean; page?: number; pageSize?: number }) {
  return apiGet<Paged<CreditBalanceRow> & { outstanding: number }>(`/admin/store-credit${query(filters)}`, ADMIN);
}

export function getCreditLedger(customerId: string, page = 1) {
  return apiGet<CreditLedger>(`/admin/store-credit/${encodeURIComponent(customerId)}${query({ page })}`, ADMIN);
}

export function adjustStoreCredit(customerId: string, input: { kind: string; amount: number; reason: string; requestKey: string }) {
  return apiPost(`/admin/store-credit/${encodeURIComponent(customerId)}`, input, ADMIN);
}

/* ----------------------------------------------------------------- loyalty */

export interface LoyaltyMetrics {
  outstanding: number;
  outstandingValue: number;
  pending: number;
  debt: number;
  customersWithPoints: number;
  expiringIn30Days: number;
  period: Record<string, number>;
  days: number;
}

export interface LoyaltyBalanceRow {
  customer: { id: string; name: string; email: string };
  available: number;
  pending: number;
  debt: number;
  lifetimeEarned: number;
  lifetimeRedeemed: number;
  lifetimeExpired: number;
  lifetimeReversed: number;
}

export interface LoyaltyLedgerRow {
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
  by: string | null;
  customer: { id: string; name: string; email: string };
}

export interface LoyaltySettings {
  enabled: boolean;
  pointsPer100: number;
  redeemPoints: number;
  redeemValue: number;
  minRedeemPoints: number;
  maxPointsPerOrder: number;
  maxOrderPercent: number;
  expiryMonths: number;
  pendingDays: number | null;
  expiryWarningDays: number;
  excludeTax: boolean;
  excludeTenderPaid: boolean;
  excludeDiscountedItems: boolean;
  eligibleCategories: string[];
  excludedCategories: string[];
  excludedProducts: string[];
  memberMultiplier: number;
  planMultipliers: Record<string, number>;
  allowWithCoupons: boolean;
  allowWithGiftCards: boolean;
  allowWithStoreCredit: boolean;
}

export function getLoyaltyMetrics(days = 30) {
  return apiGet<LoyaltyMetrics>(`/admin/loyalty/metrics${query({ days })}`, ADMIN);
}

/** `q`: a Customer ID, exactly. */
export function listLoyaltyBalances(filters: { q?: string; page?: number; pageSize?: number }) {
  return apiGet<Paged<LoyaltyBalanceRow>>(`/admin/loyalty/balances${query(filters)}`, ADMIN);
}

/** `customerId` and `orderId` (or `q`, either) are matched exactly — never by name, email or reason. */
export function listLoyaltyLedger(filters: { kind?: string; q?: string; customerId?: string; orderId?: string; page?: number; pageSize?: number }) {
  return apiGet<Paged<LoyaltyLedgerRow>>(`/admin/loyalty/ledger${query(filters)}`, ADMIN);
}

export function adjustPoints(customerId: string, input: { kind: "manual_credit" | "manual_debit"; points: number; reason: string; requestKey: string }) {
  return apiPost(`/admin/loyalty/customers/${encodeURIComponent(customerId)}/adjust`, input, ADMIN);
}

export function getLoyaltySettings() {
  return apiGet<LoyaltySettings>("/admin/loyalty/settings", ADMIN);
}

export function saveLoyaltySettings(settings: LoyaltySettings) {
  return apiPut<LoyaltySettings>("/admin/loyalty/settings", settings, ADMIN);
}

export function runLoyaltyHousekeeping() {
  return apiPost<{ released: number; expiredPoints: number }>("/admin/loyalty/housekeeping", {}, ADMIN);
}
