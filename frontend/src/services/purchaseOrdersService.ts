/**
 * Purchase orders and goods receiving (permission `purchasing`).
 * Contract: docs/shipping-and-suppliers.md §6 "Admin: purchase orders".
 *
 * Totals, tax and the `actions` a PO allows are the server's; nothing here
 * computes them. Calls throw `ApiError`.
 */
import type {
  GoodsReceipt,
  GoodsReceiptInput,
  PurchaseOrder,
  PurchaseOrderInput,
  PurchaseOrderPage,
  PurchaseOrderTransition,
} from "@/types/suppliers";

import { apiGet, apiPost, apiPut, query } from "@/services/api/client";

const ADMIN = { auth: "admin" } as const;
const id = encodeURIComponent;

export interface PurchaseOrderFilters {
  q?: string;
  status?: string;
  supplier?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export function listPurchaseOrders(filters: PurchaseOrderFilters = {}): Promise<PurchaseOrderPage> {
  return apiGet(`/admin/purchase-orders${query({ ...filters })}`, ADMIN);
}

export function getPurchaseOrder(poId: string): Promise<PurchaseOrder> {
  return apiGet(`/admin/purchase-orders/${id(poId)}`, ADMIN);
}

export function createPurchaseOrder(input: PurchaseOrderInput): Promise<PurchaseOrder> {
  return apiPost(`/admin/purchase-orders`, input, ADMIN);
}

/** Drafts only; anything else is 409 PO_NOT_EDITABLE. */
export function updatePurchaseOrder(poId: string, input: PurchaseOrderInput): Promise<PurchaseOrder> {
  return apiPut(`/admin/purchase-orders/${id(poId)}`, input, ADMIN);
}

export function transitionPurchaseOrder(
  poId: string,
  action: PurchaseOrderTransition,
  note?: string,
): Promise<PurchaseOrder> {
  return apiPost(`/admin/purchase-orders/${id(poId)}/${action}`, note ? { note } : {}, ADMIN);
}

export function cancelPurchaseOrder(poId: string, reason: string): Promise<PurchaseOrder> {
  return apiPost(`/admin/purchase-orders/${id(poId)}/cancel`, { reason }, ADMIN);
}

/** The same `idempotencyKey` again returns the PO unchanged, so stock is never added twice. */
export function receiveGoods(poId: string, input: GoodsReceiptInput): Promise<PurchaseOrder> {
  return apiPost(`/admin/purchase-orders/${id(poId)}/receipts`, input, ADMIN);
}

export function listReceipts(poId: string): Promise<GoodsReceipt[]> {
  return apiGet(`/admin/purchase-orders/${id(poId)}/receipts`, ADMIN);
}
