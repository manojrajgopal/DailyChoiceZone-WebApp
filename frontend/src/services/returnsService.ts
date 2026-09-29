import type {
  ReturnEligibility,
  ReturnKind,
  ReturnRequest,
  ReturnStatus,
} from "@/types/returns";

import { ApiError, apiGet, apiPost, apiPut } from "@/services/api/client";

const CUSTOMER = { auth: "customer" } as const;
const ADMIN = { auth: "admin" } as const;

/* ---------------------------------------------------------------- customer */

export function getOrderReturns(
  orderId: string,
): Promise<{ eligibility: ReturnEligibility; requests: ReturnRequest[] }> {
  return apiGet(`/orders/${encodeURIComponent(orderId)}/returns`, CUSTOMER);
}

export async function requestReturn(
  orderId: string,
  input: {
    kind: ReturnKind;
    reason: string;
    comment: string;
    items: { orderItemId: number; quantity: number }[];
  },
): Promise<{ ok: true; data: ReturnRequest } | { ok: false; reason: string }> {
  try {
    return {
      ok: true,
      data: await apiPost<ReturnRequest>(
        `/orders/${encodeURIComponent(orderId)}/returns`,
        input,
        CUSTOMER,
      ),
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof ApiError && error.message
          ? error.message
          : "We couldn't send your request. Please try again.",
    };
  }
}

export function cancelReturn(requestId: string): Promise<ReturnRequest> {
  return apiPost(`/returns/${encodeURIComponent(requestId)}/cancel`, {}, CUSTOMER);
}

/* ------------------------------------------------------------------- admin */

export function listReturns(filters: { status?: string; kind?: string } = {}): Promise<ReturnRequest[]> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.kind) params.set("kind", filters.kind);
  const query = params.toString();
  return apiGet(`/admin/returns${query ? `?${query}` : ""}`, ADMIN);
}

export function getReturn(id: string): Promise<ReturnRequest> {
  return apiGet(`/admin/returns/${encodeURIComponent(id)}`, ADMIN);
}

export async function moveReturn(
  id: string,
  status: ReturnStatus,
  note: string,
): Promise<{ ok: true; data: ReturnRequest } | { ok: false; reason: string }> {
  try {
    return {
      ok: true,
      data: await apiPut<ReturnRequest>(
        `/admin/returns/${encodeURIComponent(id)}/status`,
        { status, note },
        ADMIN,
      ),
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof ApiError && error.message
          ? error.message
          : "That update couldn't be saved. Please try again.",
    };
  }
}
