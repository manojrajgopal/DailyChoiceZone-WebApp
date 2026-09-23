import type { Money, PaymentMethodKey } from "@/types";

import type {
  CreatePaymentRequest,
  PaymentProvider,
  PaymentResult,
  RefundResult,
} from "./payment-provider";

/**
 * A payment provider that moves no money.
 *
 * It exists so the checkout has something to call and the transaction records
 * look like the real thing — a reference, a method, a timeline. Nothing here
 * contacts a network and nothing here is a transaction.
 *
 * **What it deliberately does not do:** collect or return a card number, an
 * expiry, a CVV, a UPI PIN or a bank credential. `instrumentHint` is a
 * fabricated, non-identifying remnant of the kind a real gateway hands back
 * *after* processing — the only payment detail a storefront should ever hold.
 * When this is replaced by a real provider, that stays true: card fields belong
 * in the gateway's own hosted inputs, never in this application's DOM.
 *
 * Cash on delivery is the one method that is honestly "pending": no money has
 * moved and none will until the courier arrives.
 */

const SUFFIXES = ["4242", "1881", "9006", "3310", "7712"];

/** Deterministic pseudo-randomness, so a re-render cannot change a reference. */
function hash(seed: string): number {
  let value = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    value ^= seed.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return Math.abs(value);
}

function transactionIdFor(orderId: string): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `TXN${stamp}${String(hash(orderId) % 100000).padStart(5, "0")}`;
}

function instrumentHintFor(method: PaymentMethodKey, seed: string): string {
  const pick = <T,>(list: T[]): T => list[hash(seed) % list.length]!;

  switch (method) {
    case "card":
    case "debit-card":
      return `•••• ${pick(SUFFIXES)}`;
    case "upi":
      return `•••••@${pick(["okhdfc", "okaxis", "ybl", "paytm"])}`;
    case "netbanking":
      return pick(["HDFC Bank", "ICICI Bank", "State Bank of India", "Axis Bank"]);
    case "wallet":
      return pick(["Paytm Wallet", "PhonePe Wallet", "Amazon Pay"]);
    case "cod":
      return "Collect on delivery";
    default:
      return "";
  }
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";

  async createPayment(request: CreatePaymentRequest): Promise<PaymentResult> {
    const transactionId = transactionIdFor(request.orderId);
    const instrumentHint = instrumentHintFor(request.method, request.orderId);

    // Cash on delivery is genuinely unsettled until the courier collects.
    if (request.method === "cod") {
      return { ok: true, transactionId, status: "pending", instrumentHint };
    }

    return { ok: true, transactionId, status: "paid", instrumentHint };
  }

  async verifyPayment(transactionId: string): Promise<PaymentResult> {
    // A real provider checks a signature on the server. There is nothing to
    // verify against here, so this reports what it was told.
    return {
      ok: true,
      transactionId,
      status: "paid",
      instrumentHint: "",
    };
  }

  async getPayment(transactionId: string): Promise<PaymentResult | null> {
    return { ok: true, transactionId, status: "paid", instrumentHint: "" };
  }

  async refundPayment(
    transactionId: string,
    amount: Money,
    _reason: string,
  ): Promise<RefundResult> {
    void amount;
    void _reason;
    return {
      ok: true,
      refundReference: `RFND${transactionId.slice(3)}`,
      status: "completed",
    };
  }
}

/**
 * The active provider.
 *
 * Swapping in a real gateway is a change to this one expression — plus that
 * provider's own class, plus the server-side verification the interface's
 * header describes. Nothing above this line learns about it.
 */
export const paymentProvider: PaymentProvider = new MockPaymentProvider();
