import type { Product } from "@/types";

import { apiDelete, apiGet, apiPost, query } from "@/services/api/client";

/**
 * Back-in-stock and price-drop alerts, the comparison list, and product
 * questions. Every rule — what can be watched, the comparison limit, what a
 * question may contain — is the server's; these calls only ask.
 */

const AUTH = { auth: "customer" } as const;

/* ------------------------------------------------------------------ alerts */

export interface AlertProduct {
  id: string;
  slug: string;
  name: string;
  brand: string;
  image: string;
  price: number;
  originalPrice: number;
  available: boolean;
  listed: boolean;
}

export interface StockAlert {
  id: number;
  kind: "stock";
  status: "active" | "notified" | "unsubscribed";
  size: string;
  color: string;
  createdAt: string;
  notifiedAt: string | null;
  product: AlertProduct | null;
}

export interface PriceAlert {
  id: number;
  kind: "price";
  status: "active" | "notified" | "unsubscribed";
  mode: "any" | "target";
  baselinePrice: number;
  targetPrice: number | null;
  notifiedPrice: number | null;
  createdAt: string;
  notifiedAt: string | null;
  product: AlertProduct | null;
}

export function getMyAlerts(): Promise<{ stock: StockAlert[]; price: PriceAlert[] }> {
  return apiGet("/alerts", AUTH);
}

export function getProductAlerts(productId: string): Promise<{ stock: StockAlert[]; price: PriceAlert | null }> {
  return apiGet(`/alerts/products/${encodeURIComponent(productId)}`, AUTH);
}

export function watchStock(productId: string, size?: string | null, color?: string | null) {
  return apiPost<StockAlert & { alreadySubscribed: boolean }>(
    "/alerts/stock",
    { productId, size: size ?? "", color: color ?? "" },
    AUTH,
  );
}

export function watchPrice(productId: string, mode: "any" | "target", targetPrice?: number) {
  return apiPost<PriceAlert & { alreadySubscribed: boolean }>(
    "/alerts/price",
    { productId, mode, targetPrice: mode === "target" ? targetPrice : null },
    AUTH,
  );
}

export function stopAlert(kind: "stock" | "price", id: number) {
  return apiDelete<StockAlert | PriceAlert>(`/alerts/${kind}/${id}`, AUTH);
}

/* -------------------------------------------------------------- comparison */

export const COMPARE_LIMIT = 4;

export function fetchCompareIds(): Promise<{ productIds: string[]; limit: number }> {
  return apiGet("/compare/ids", AUTH);
}

export function fetchCompareProducts(): Promise<{ items: Product[]; limit: number }> {
  return apiGet("/compare", AUTH);
}

export function addToCompare(productId: string, replace?: string) {
  return apiPost<{ productIds: string[] }>(
    `/compare/${encodeURIComponent(productId)}${query({ replace })}`,
    {},
    AUTH,
  );
}

export function removeFromCompare(productId: string) {
  return apiDelete<{ productIds: string[] }>(`/compare/${encodeURIComponent(productId)}`, AUTH);
}

export function clearCompare() {
  return apiDelete<{ productIds: string[] }>("/compare", AUTH);
}

export function mergeCompare(productIds: string[]) {
  return apiPost<{ productIds: string[] }>("/compare/merge", { productIds }, AUTH);
}

/* --------------------------------------------------------------- questions */

export interface ProductQuestion {
  id: number;
  question: string;
  author: string;
  size: string | null;
  color: string | null;
  askedAt: string;
  answer: { body: string; by: string; answeredAt: string | null } | null;
  status?: "pending" | "approved" | "rejected";
  rejectionReason?: string;
}

export interface QuestionPage {
  items: ProductQuestion[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
  answered: number;
}

export function getQuestions(productId: string, page = 1, pageSize = 5): Promise<QuestionPage> {
  return apiGet(`/products/${encodeURIComponent(productId)}/questions${query({ page, pageSize })}`);
}

export function getMyQuestions(productId: string): Promise<ProductQuestion[]> {
  return apiGet(`/products/${encodeURIComponent(productId)}/questions/mine`, AUTH);
}

export function askQuestion(productId: string, question: string, size?: string | null, color?: string | null) {
  return apiPost<ProductQuestion>(
    `/products/${encodeURIComponent(productId)}/questions`,
    { question, size: size ?? "", color: color ?? "" },
    AUTH,
  );
}
