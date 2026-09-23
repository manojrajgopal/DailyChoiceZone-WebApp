import type { Money, PaymentMethodKey } from "@/types";

/**
 * The payment gateway boundary.
 *
 * No component, hook or service outside this folder may name a provider. The UI
 * asks for a payment; which company processes it is a deployment decision, and
 * the day Razorpay is swapped for Stripe should touch one file.
 *
 * The method names mirror what every gateway actually offers, because they all
 * converge on the same four operations however differently they spell them:
 *
 *   createPayment  → create an order/intent, return something the client can present
 *   verifyPayment  → confirm the outcome, having been told about it
 *   getPayment     → read current state, for reconciliation
 *   refundPayment  → return money against a captured payment
 *
 * **Where the real work will not be:** verification belongs on a server. A
 * client saying "this succeeded" is a claim, not a fact — the signature check
 * and the webhook that confirms it must happen somewhere the customer cannot
 * reach. `verifyPayment` is in this interface so the call site exists and reads
 * correctly today; its implementation moves behind `POST /billing/payments/:id/verify`.
 */

export interface CreatePaymentRequest {
  orderId: string;
  invoiceId: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  amount: Money;
  currency: string;
  method: PaymentMethodKey;
  /** Free-form, echoed back by the gateway. Useful for reconciliation. */
  notes?: Record<string, string>;
}

export interface PaymentResult {
  ok: boolean;
  /** The provider's own reference. */
  transactionId: string;
  status: "pending" | "authorized" | "paid" | "failed";
  /** Non-identifying remnant only — "•••• 4242", "manoj@okhdfc". Never a PAN. */
  instrumentHint: string;
  /** Present when `ok` is false. Safe to show a customer. */
  failureReason?: string;
}

export interface RefundResult {
  ok: boolean;
  refundReference: string;
  status: "processing" | "completed" | "rejected";
  failureReason?: string;
}

export interface PaymentProvider {
  /** Identifies the implementation in stored records, e.g. "mock", "razorpay". */
  readonly name: string;

  createPayment(request: CreatePaymentRequest): Promise<PaymentResult>;

  /**
   * Confirm an outcome. A real implementation validates a signature *server
   * side*; see the note above.
   */
  verifyPayment(transactionId: string): Promise<PaymentResult>;

  getPayment(transactionId: string): Promise<PaymentResult | null>;

  refundPayment(transactionId: string, amount: Money, reason: string): Promise<RefundResult>;
}
