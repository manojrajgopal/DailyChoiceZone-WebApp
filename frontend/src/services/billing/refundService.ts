import type { Money, Refund, RefundLine, RefundStatus } from "@/types";

import { ApiError } from "@/services/api/client";

import { billingDataSource } from "./billing-data-source.instance";
import type { RefundQuery } from "./billing-data-source";
import { getBillingConfig } from "./billingService";

/**
 * Refunds.
 *
 * A refund is a request first and a movement of money second, which is why it
 * has its own record rather than being a flag on the payment: it can be
 * raised, sit in processing, and be rejected without any money ever moving.
 *
 * **Every rule about it is enforced on the server** — the over-refund check
 * against what the payment has left, the provider call, the adjustment to the
 * payment, the invoice and the order. This file used to do that sequence in
 * the browser across four separate writes, any of which could be the last one
 * before the tab closed. Now it is one request and one transaction, and what
 * comes back is the record as stored.
 *
 *   GET  /admin/billing/refunds
 *   POST /admin/billing/refunds
 *   PUT  /admin/billing/refunds/:id
 */

export type { RefundQuery };

export function getRefunds(query?: RefundQuery): Promise<Refund[]> {
  return billingDataSource.listRefunds(query);
}

export function getRefundById(id: string): Promise<Refund | null> {
  return billingDataSource.getRefund(id);
}

export function getRefundsForOrder(orderId: string): Promise<Refund[]> {
  return billingDataSource.listRefunds({ orderId });
}

/** The reasons offered in the refund and credit-note dialogs. Configuration. */
export async function refundReasons(): Promise<string[]> {
  return (await getBillingConfig()).refund.reasons;
}

export interface CreateRefundInput {
  invoiceId: string;
  amount: Money;
  reason: string;
  lines?: RefundLine[];
  /** Leave it awaiting action instead of settling it now. */
  status?: RefundStatus;
}

export type RefundResult = { ok: true; refund: Refund } | { ok: false; reason: string };

/**
 * Raise a refund.
 *
 * The checks that matter happen on the server, so the ones here are only the
 * two that save a round trip on an obviously empty form. Everything else —
 * whether there is anything left to refund, whether the provider accepts it —
 * comes back as a message written to be shown.
 */
export async function createRefund(input: CreateRefundInput): Promise<RefundResult> {
  if (input.amount <= 0) return { ok: false, reason: "Enter a refund amount above zero." };
  if (!input.reason.trim()) return { ok: false, reason: "Choose a reason for the refund." };

  try {
    const refund = await billingDataSource.createRefund({
      invoiceId: input.invoiceId,
      amount: input.amount,
      reason: input.reason.trim(),
      lines: input.lines,
      status: input.status,
    });
    return { ok: true, refund };
  } catch (error) {
    return { ok: false, reason: message(error, "The refund could not be raised.") };
  }
}

/**
 * Move a refund along.
 *
 * Completing one settles it: the provider is called and the payment, invoice
 * and order are adjusted, all inside the same transaction. Rejecting leaves
 * the money where it is.
 */
export async function setRefundStatus(
  refund: Refund,
  status: RefundStatus,
): Promise<RefundResult> {
  try {
    return { ok: true, refund: await billingDataSource.updateRefund({ ...refund, status }) };
  } catch (error) {
    return { ok: false, reason: message(error, "The refund could not be updated.") };
  }
}

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.message ? error.message : fallback;
}
