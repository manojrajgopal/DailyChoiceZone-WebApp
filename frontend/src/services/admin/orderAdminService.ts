import type {
  AdminOrder,
  AdminOrderStatus,
  AdminResult,
  PaymentStatus,
} from "@/types/admin";

import { availableMoves, needsConfirmation, stageLabel, type Move } from "@/lib/orders/orderFlow";
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

/** Where an order can go from here, and what kind of move each is. */
export function availableMovesFor(order: AdminOrder): Move[] {
  return availableMoves(order.status, order.awaitingPayment ?? false);
}

export async function updateOrderStatus(
  id: string,
  status: AdminOrderStatus,
  note: string,
  by: string,
  confirm = false,
): Promise<AdminResult<AdminOrder>> {
  const order = await adminDataSource.getOrder(id);
  if (!order) return { ok: false, reason: "That order no longer exists." };

  if (order.status === status) {
    return { ok: false, reason: `This order is already ${stageLabel(status).toLowerCase()}.` };
  }

  const move = availableMovesFor(order).find((entry) => entry.target === status);
  if (!move) {
    return {
      ok: false,
      reason: `An order that is ${stageLabel(order.status).toLowerCase()} cannot be moved to ${stageLabel(status).toLowerCase()}.`,
    };
  }
  if (needsConfirmation(move) && !confirm) {
    return { ok: false, reason: "This change skips or reverses a stage and needs confirming." };
  }

  try {
    return {
      ok: true,
      data: await adminDataSource.updateOrderStatus(id, status, note, by, confirm),
    };
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
