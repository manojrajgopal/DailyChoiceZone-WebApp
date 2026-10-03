import { apiGet, apiPost, apiPut, query } from "@/services/api/client";
import type {
  CreateRefundRequest,
  OrderRefunds,
  RefundBreakdown,
  RefundRecord,
  RefundRequest,
  RefundSettings,
} from "@/types/refunds";

/**
 * Partial refunds in the portal (permission `refunds`; approving above the
 * threshold and the settings need `refunds-large`). The server works out every
 * amount — lines, tax, shipping, what's left — and checks every limit again
 * when a refund is raised. See docs/refunds.md.
 */

const ADMIN = { auth: "admin" } as const;
const enc = encodeURIComponent;

export function getOrderRefunds(orderId: string): Promise<OrderRefunds> {
  return apiGet(`/admin/refunds/orders/${enc(orderId)}`, ADMIN);
}

export function calculateRefund(orderId: string, request: RefundRequest): Promise<RefundBreakdown> {
  return apiPost(`/admin/refunds/orders/${enc(orderId)}/calculate`, request, ADMIN);
}

export function createOrderRefund(orderId: string, request: CreateRefundRequest): Promise<RefundRecord> {
  return apiPost(`/admin/refunds/orders/${enc(orderId)}`, request, ADMIN);
}

export function approveRefund(id: string): Promise<RefundRecord> {
  return apiPost(`/admin/refunds/${enc(id)}/approve`, undefined, ADMIN);
}

export function rejectRefund(id: string, note: string): Promise<RefundRecord> {
  return apiPost(`/admin/refunds/${enc(id)}/reject`, { note }, ADMIN);
}

export function cancelRefund(id: string, note: string): Promise<RefundRecord> {
  return apiPost(`/admin/refunds/${enc(id)}/cancel`, { note }, ADMIN);
}

export function retryRefund(id: string): Promise<RefundRecord> {
  return apiPost(`/admin/refunds/${enc(id)}/retry`, undefined, ADMIN);
}

export function getRefundSettings(): Promise<RefundSettings> {
  return apiGet("/admin/refunds/settings", ADMIN);
}

export function saveRefundSettings(input: Partial<RefundSettings>): Promise<RefundSettings> {
  // `methods` is the read-only list of what exists; only the settings are sent.
  const body = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "methods"));
  return apiPut("/admin/refunds/settings", body, ADMIN);
}

export interface RefundListFilters {
  status?: string;
  method?: string;
  reasonCode?: string;
  q?: string;
  orderId?: string;
  awaitingApproval?: boolean;
  page?: number;
  pageSize?: number;
}

export interface RefundList {
  items: RefundRecord[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
}

export interface RefundSummary {
  requested: number;
  awaitingApproval: number;
  processing: number;
  failed: number;
  refundedToday: number;
  refundedTodayCount: number;
}

export function listRefunds(filters: RefundListFilters = {}): Promise<RefundList> {
  return apiGet(`/admin/refunds${query({ ...filters, awaitingApproval: filters.awaitingApproval || undefined })}`, ADMIN);
}

export function getRefundSummary(): Promise<RefundSummary> {
  return apiGet("/admin/refunds/summary", ADMIN);
}

export function getRefund(id: string): Promise<RefundRecord> {
  return apiGet(`/admin/refunds/${enc(id)}`, ADMIN);
}
