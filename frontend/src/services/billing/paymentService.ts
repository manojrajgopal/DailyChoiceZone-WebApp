import type { Money, Payment, PaymentEvent, PaymentMethodKey, BillingPaymentStatus } from "@/types";

import { billingDataSource } from "./billing-data-source.instance";
import type { PaymentQuery } from "./billing-data-source";
import { paymentProvider } from "./providers/mock-provider";

/**
 * Payments.
 *
 * The UI talks to this file; this file talks to a `PaymentProvider`. Nothing
 * above it names a gateway, so swapping Razorpay in later touches
 * `providers/`, not a component.
 *
 * Future: `GET /billing/payments`, `GET /billing/payments/:id`,
 * `POST /billing/payments`, `POST /billing/payments/:id/refund`.
 *
 * **Security:** the only payment detail kept is `instrumentHint` — a masked
 * remnant of the kind a gateway returns after processing. No card number,
 * expiry, CVV, UPI PIN, bank credential or gateway secret is collected, stored
 * or transmitted anywhere in this application, and none may be added. Real
 * card entry belongs in the provider's own hosted fields, which never touch
 * this DOM.
 */

export const PAYMENT_METHOD_LABELS: Record<PaymentMethodKey, string> = {
  upi: "UPI",
  card: "Credit card",
  "debit-card": "Debit card",
  netbanking: "Net banking",
  cod: "Cash on delivery",
  wallet: "Wallet",
};

export function paymentMethodLabel(method: PaymentMethodKey): string {
  return PAYMENT_METHOD_LABELS[method] ?? method;
}

export function getPayments(query?: PaymentQuery): Promise<Payment[]> {
  return billingDataSource.listPayments(query);
}

export function getPaymentById(id: string): Promise<Payment | null> {
  return billingDataSource.getPayment(id);
}

export function getPaymentByOrderId(orderId: string): Promise<Payment | null> {
  return billingDataSource.getPaymentByOrderId(orderId);
}

export interface CreatePaymentInput {
  id: string;
  orderId: string;
  orderNumber: string;
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  amount: Money;
  currency: string;
  method: PaymentMethodKey;
}

/**
 * Take a payment.
 *
 * The record is written whatever the outcome, including a failure. A payment
 * that failed is not an absence of a payment — it is something support will be
 * asked about, and a system that only records successes cannot answer.
 */
export async function createPayment(input: CreatePaymentInput): Promise<Payment> {
  const now = new Date();

  const result = await paymentProvider.createPayment({
    orderId: input.orderId,
    invoiceId: input.invoiceId,
    customerId: input.customerId,
    customerName: input.customerName,
    customerEmail: input.customerEmail,
    amount: input.amount,
    currency: input.currency,
    method: input.method,
  });

  const timeline: PaymentEvent[] = [
    { status: "initiated", at: now.toISOString(), note: "Payment initiated at checkout." },
    {
      status: "processing",
      at: new Date(now.getTime() + 1000).toISOString(),
      note: input.method === "cod" ? "Awaiting collection on delivery." : "Sent to the payment provider.",
    },
  ];

  if (result.status === "paid") {
    timeline.push({
      status: "succeeded",
      at: new Date(now.getTime() + 2000).toISOString(),
      note: "Authorised and captured.",
    });
  } else if (result.status === "failed") {
    timeline.push({
      status: "failed",
      at: new Date(now.getTime() + 2000).toISOString(),
      note: result.failureReason ?? "Declined by the provider.",
    });
  }

  const payment: Payment = {
    id: input.id,
    transactionId: result.transactionId,
    orderId: input.orderId,
    orderNumber: input.orderNumber,
    invoiceId: input.invoiceId,
    invoiceNumber: input.invoiceNumber,
    customerId: input.customerId,
    customerName: input.customerName,
    customerEmail: input.customerEmail,
    amount: input.amount,
    refundedAmount: 0,
    method: input.method,
    status: result.status === "paid" ? "paid" : result.status === "failed" ? "failed" : "pending",
    provider: paymentProvider.name,
    createdAt: now.toISOString(),
    capturedAt: result.status === "paid" ? new Date(now.getTime() + 2000).toISOString() : null,
    timeline,
    instrumentHint: result.instrumentHint,
  };

  return billingDataSource.createPayment(payment);
}

export function updatePayment(payment: Payment): Promise<Payment> {
  return billingDataSource.updatePayment(payment);
}

/** Confirm an outcome. See the provider interface on why this belongs server-side. */
export async function verifyPayment(payment: Payment): Promise<Payment> {
  const result = await paymentProvider.verifyPayment(payment.transactionId);
  if (!result.ok) return payment;

  return updatePayment({
    ...payment,
    status: result.status === "paid" ? "paid" : payment.status,
    capturedAt: payment.capturedAt ?? new Date().toISOString(),
  });
}

/**
 * Settle a payment that was pending — a courier collecting cash, or an admin
 * confirming a bank transfer landed.
 */
export async function capturePayment(payment: Payment): Promise<Payment> {
  const at = new Date().toISOString();
  return updatePayment({
    ...payment,
    status: "paid",
    capturedAt: at,
    timeline: [...payment.timeline, { status: "succeeded", at, note: "Marked as received." }],
  });
}

/**
 * Send money back through the provider and record it.
 *
 * The status is derived from how much of the payment has now been returned, so
 * a second partial refund flips it to fully refunded without anyone having to
 * remember to. Returns `null` when the provider refuses, so the caller can say
 * so rather than showing a refund that did not happen.
 */
export async function refundPayment(
  payment: Payment,
  amount: Money,
  reason: string,
): Promise<Payment | null> {
  const result = await paymentProvider.refundPayment(payment.transactionId, amount, reason);
  if (!result.ok) return null;

  const refundedAmount = Math.min(payment.amount, payment.refundedAmount + amount);
  const status: BillingPaymentStatus =
    refundedAmount >= payment.amount ? "refunded" : "partially-refunded";
  const at = new Date().toISOString();

  return updatePayment({
    ...payment,
    refundedAmount,
    status,
    timeline: [
      ...payment.timeline,
      {
        status: "refunded",
        at,
        note: `${status === "refunded" ? "Full" : "Partial"} refund issued — ${reason}.`,
      },
    ],
  });
}

/** What can still be refunded against a payment. */
export function refundableAmount(payment: Payment): Money {
  if (payment.status === "failed" || payment.status === "pending") return 0;
  return Math.max(0, payment.amount - payment.refundedAmount);
}
