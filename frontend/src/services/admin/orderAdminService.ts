import type {
  AdminOrder,
  AdminOrderStatus,
  AdminResult,
  PaymentStatus,
} from "@/types/admin";

import { ApiError } from "@/services/api/client";

import type { PaymentLinkSent } from "./admin-data-source";
import { adminDataSource } from "./admin-data-source.instance";

/**
 * Order management.
 *
 * The rule this service owns is which status changes are legal. An order that
 * has been delivered cannot go back to processing, and a cancelled order is
 * final — allowing either would corrupt the timeline that customer support
 * reads.
 */

export function listOrders(): Promise<AdminOrder[]> {
  return adminDataSource.listOrders();
}

export function getOrder(id: string): Promise<AdminOrder | null> {
  return adminDataSource.getOrder(id);
}

/** Where an order can go next, given where it is. */
const ALLOWED_NEXT: Record<AdminOrderStatus, AdminOrderStatus[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["shipped", "cancelled"],
  shipped: ["delivered", "returned"],
  delivered: ["returned"],
  cancelled: [],
  returned: [],
};

export function allowedTransitions(from: AdminOrderStatus): AdminOrderStatus[] {
  return ALLOWED_NEXT[from] ?? [];
}

export async function updateOrderStatus(
  id: string,
  status: AdminOrderStatus,
  note: string,
  by: string,
): Promise<AdminResult<AdminOrder>> {
  const order = await adminDataSource.getOrder(id);
  if (!order) return { ok: false, reason: "That order no longer exists." };

  if (order.status === status) {
    return { ok: false, reason: `This order is already ${status}.` };
  }

  if (!allowedTransitions(order.status).includes(status)) {
    return {
      ok: false,
      reason: `An order that is ${order.status} cannot be moved to ${status}.`,
    };
  }

  return { ok: true, data: await adminDataSource.updateOrderStatus(id, status, note, by) };
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
