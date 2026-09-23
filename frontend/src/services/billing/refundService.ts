import type { Invoice, Money, Payment, Refund, RefundLine, RefundStatus } from "@/types";

import { billingDataSource } from "./billing-data-source.instance";
import type { RefundQuery } from "./billing-data-source";
import { getBillingConfig } from "./billingService";
import { updateInvoice } from "./invoiceService";
import { refundPayment, refundableAmount } from "./paymentService";

/**
 * Refunds.
 *
 * A refund is a request first and a movement of money second, which is why it
 * has its own record rather than being a flag on the payment: it can be raised,
 * sit in processing, and be rejected without any money ever moving. Only a
 * *completed* refund touches the payment and the invoice.
 *
 * Partial refunds are first class. `lines` is empty for a whole-order refund
 * and populated for a per-item one; the amount is authoritative either way, so
 * the rest of the system never has to re-derive it.
 *
 * Future: `GET /billing/refunds`, `GET /billing/refunds/:id`,
 * `POST /billing/payments/:id/refund`.
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

export function refundReasons(): string[] {
  return getBillingConfig().refund.reasons;
}

export interface CreateRefundInput {
  invoice: Invoice;
  payment: Payment;
  amount: Money;
  reason: string;
  lines?: RefundLine[];
  initiatedBy: string;
  /** Skip the provider call and leave it awaiting action. */
  status?: RefundStatus;
}

export type RefundResult =
  | { ok: true; refund: Refund }
  | { ok: false; reason: string };

/**
 * Raise a refund.
 *
 * Refusing to over-refund is the important rule here, and it is checked against
 * what the *payment* has left rather than what the invoice was worth — two
 * partial refunds that each look reasonable can together exceed the amount
 * actually collected.
 */
export async function createRefund(input: CreateRefundInput): Promise<RefundResult> {
  const { invoice, payment, amount, reason } = input;

  if (amount <= 0) {
    return { ok: false, reason: "Enter a refund amount above zero." };
  }

  const available = refundableAmount(payment);
  if (available <= 0) {
    return {
      ok: false,
      reason:
        payment.status === "pending"
          ? "Nothing has been collected on this order yet, so there is nothing to refund."
          : "This payment has already been refunded in full.",
    };
  }

  if (amount > available) {
    return { ok: false, reason: "That is more than is left to refund on this payment." };
  }

  if (!reason.trim()) {
    return { ok: false, reason: "Choose a reason for the refund." };
  }

  const now = new Date();
  const existing = await billingDataSource.listRefunds({});
  const sequence = existing.length + 1;

  const status = input.status ?? "completed";

  const refund: Refund = {
    id: `ref_${String(sequence).padStart(4, "0")}`,
    refundNumber: `DCZ-RF-${now.getFullYear()}-${String(sequence).padStart(5, "0")}`,
    orderId: invoice.orderId,
    orderNumber: invoice.orderNumber,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    paymentId: payment.id,
    customerId: invoice.customerId,
    customerName: invoice.customerName,
    amount,
    reason: reason.trim(),
    status,
    requestedAt: now.toISOString(),
    processedAt: status === "completed" ? now.toISOString() : null,
    lines: input.lines ?? [],
    creditNoteId: null,
    initiatedBy: input.initiatedBy,
  };

  await billingDataSource.createRefund(refund);

  // Only a completed refund has actually moved money, so only a completed
  // refund adjusts the payment and the invoice.
  if (status === "completed") {
    const updatedPayment = await refundPayment(payment, amount, refund.reason);
    if (!updatedPayment) {
      await billingDataSource.updateRefund({ ...refund, status: "rejected", processedAt: null });
      return { ok: false, reason: "The payment provider refused the refund." };
    }

    await updateInvoice({
      ...invoice,
      amountRefunded: invoice.amountRefunded + amount,
      paymentStatus: updatedPayment.status,
    });
  }

  return { ok: true, refund };
}

/**
 * Move a refund along.
 *
 * Completing one here does what `createRefund` would have done at the time:
 * calls the provider and adjusts the payment and invoice. Rejecting one leaves
 * the money where it is.
 */
export async function setRefundStatus(
  refund: Refund,
  status: RefundStatus,
  invoice: Invoice | null,
  payment: Payment | null,
): Promise<RefundResult> {
  if (refund.status === "completed") {
    return { ok: false, reason: "This refund is already complete." };
  }

  const now = new Date().toISOString();

  if (status === "completed") {
    if (!invoice || !payment) {
      return { ok: false, reason: "The invoice or payment for this refund is missing." };
    }
    if (refund.amount > refundableAmount(payment)) {
      return { ok: false, reason: "That is more than is left to refund on this payment." };
    }

    const updatedPayment = await refundPayment(payment, refund.amount, refund.reason);
    if (!updatedPayment) {
      return { ok: false, reason: "The payment provider refused the refund." };
    }

    await updateInvoice({
      ...invoice,
      amountRefunded: invoice.amountRefunded + refund.amount,
      paymentStatus: updatedPayment.status,
    });
  }

  const updated = await billingDataSource.updateRefund({
    ...refund,
    status,
    processedAt: status === "completed" ? now : refund.processedAt,
  });

  return { ok: true, refund: updated };
}

export function linkCreditNote(refund: Refund, creditNoteId: string): Promise<Refund> {
  return billingDataSource.updateRefund({ ...refund, creditNoteId });
}
