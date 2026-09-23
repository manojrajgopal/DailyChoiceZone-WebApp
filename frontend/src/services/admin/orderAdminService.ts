import type {
  AdminOrder,
  AdminOrderStatus,
  AdminResult,
  PaymentStatus,
} from "@/types/admin";

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

/** Orders still needing action. Drives the sidebar badge. */
export async function countOpenOrders(): Promise<number> {
  const orders = await adminDataSource.listOrders();
  return orders.filter((order) =>
    ["pending", "confirmed", "processing"].includes(order.status),
  ).length;
}
