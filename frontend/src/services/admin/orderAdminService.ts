import type {
  AdminOrder,
  AdminOrderStatus,
  AdminResult,
  PaymentStatus,
} from "@/types/admin";

import { stageLabel } from "@/lib/orders/orderFlow";
import { ApiError } from "@/services/api/client";

import type { PaymentLinkSent } from "./admin-data-source";
import { adminDataSource } from "./admin-data-source.instance";

/**
 * Order management.
 *
 * Which status changes are legal is the server's decision, not this file's
 * (`backend/app/services/fulfilment/workflow.py`, docs/order-fulfilment.md).
 * The order page draws the actions `fulfilmentAdminService` returns; this
 * only reads orders and passes a status change through for the server to
 * accept or refuse with its own message.
 */

/**
 * Every order, or those an ID names: `q` is an Order ID (`DCZ10241`),
 * `customerId` a Customer ID. Both are matched exactly by the server.
 */
export function listOrders(filters: { q?: string; customerId?: string } = {}): Promise<AdminOrder[]> {
  return adminDataSource.listOrders(filters.customerId || undefined, filters.q || undefined);
}

export function getOrder(id: string): Promise<AdminOrder | null> {
  return adminDataSource.getOrder(id);
}

/**
 * Ask the server to move an order (confirm, cancel, record a return to
 * origin). Every other stage belongs to packing and shipments, and the server
 * refuses it here with a message that says so.
 */
export async function updateOrderStatus(
  id: string,
  status: AdminOrderStatus,
  note: string,
  by: string,
): Promise<AdminResult<AdminOrder>> {
  const order = await adminDataSource.getOrder(id);
  if (!order) return { ok: false, reason: "That order no longer exists." };

  if (order.status === status) {
    return { ok: false, reason: `This order is already ${stageLabel(status).toLowerCase()}.` };
  }

  try {
    return { ok: true, data: await adminDataSource.updateOrderStatus(id, status, note, by) };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof ApiError && error.message
          ? error.message
          : "The status could not be updated. Please try again.",
    };
  }
}

export async function updatePaymentStatus(
  id: string,
  status: PaymentStatus,
): Promise<AdminResult<AdminOrder>> {
  const order = await adminDataSource.getOrder(id);
  if (!order) return { ok: false, reason: "That order no longer exists." };
  return { ok: true, data: await adminDataSource.updatePaymentStatus(id, status) };
}

/**
 * Whether a payment link can be offered for this order.
 *
 * Mirrors the server's rule so the button only appears where it can work:
 * cash on delivery, not yet paid, and not finished. The server checks again —
 * this decides what to show, not what is allowed.
 */
export function canSendPaymentLink(order: AdminOrder): boolean {
  return (
    order.paymentMethod === "cod" &&
    order.paymentStatus !== "paid" &&
    !["cancelled", "returned", "delivered"].includes(order.status)
  );
}

export async function sendPaymentLink(id: string): Promise<AdminResult<PaymentLinkSent>> {
  try {
    return { ok: true, data: await adminDataSource.sendPaymentLink(id) };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof ApiError && error.message
          ? error.message
          : "The payment link could not be sent.",
    };
  }
}

/** Orders still needing action. Drives the sidebar badge. */
