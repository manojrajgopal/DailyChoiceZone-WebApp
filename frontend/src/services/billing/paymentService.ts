import type { Money, Payment, PaymentMethodKey } from "@/types";

import { billingDataSource } from "./billing-data-source.instance";
import type { PaymentQuery } from "./billing-data-source";

/**
 * Payments.
 *
 * Reading, and the one write the portal makes: confirming that a pending
 * payment was received — a courier collecting cash, an admin confirming a
 * transfer landed.
 *
 * **Taking money is not done here and cannot be.** The provider abstraction
 * lives on the server (`app/services/payments/`), because creating a payment,
 * verifying a signature and handling a webhook are all secret-key operations,
 * and a secret key in a browser bundle is not a secret. Swapping Razorpay in
 * for the current provider is a backend change; nothing in this application
 * names a gateway.
 *
 * **Security:** the only payment detail kept anywhere is `instrumentHint` — a
 * masked remnant of the kind a gateway returns after processing. No card
 * number, expiry, CVV, UPI PIN, bank credential or gateway secret is
 * collected, stored or transmitted by this application, and none may be added.
 * Real card entry belongs in the provider's own hosted fields, which never
 * touch this DOM.
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

/**
 * Settle a payment that was pending.
 *
 * The server appends the timeline entry and moves the order's payment status
 * with it, so the two cannot drift apart.
 */
export function capturePayment(payment: Payment): Promise<Payment> {
  return billingDataSource.updatePayment(payment);
}

/**
 * What can still be refunded against a payment.
 *
 * Derived here so the refund dialog can show a ceiling before anyone types.
 * The server checks the same thing and its answer is the one that decides.
 */
export function refundableAmount(payment: Payment): Money {
  if (payment.status === "failed" || payment.status === "pending") return 0;
  return Math.max(0, payment.amount - payment.refundedAmount);
}
