import type { GatewayHandoff } from "@/types";

import { pageCache } from "@/services/api/cache";
import { apiDelete, apiGet, apiPost, apiUrl } from "@/services/api/client";

import type { RazorpayResponse } from "./razorpayCheckout";

/**
 * Talking to our own server about payments.
 *
 * Three calls, and the important thing about all three is what they do *not*
 * do: none of them decides whether a payment succeeded. The browser reports,
 * the server verifies. A client that could settle its own payment would be a
 * client that could give itself free orders.
 */

const AUTH = { auth: "customer" } as const;

/** Which gateway is live, and the publishable key to open it with. */
export interface PaymentConfig {
  provider: string;
  keyId: string;
  /** False when checkout completes without a handoff — the mock provider. */
  gateway: boolean;
  /**
   * "test", "live", or "none" when no gateway is connected.
   *
   * Derived by the server from the key's own prefix, so the storefront's
   * statement about whether real money is taken follows the keys rather than
   * a separate setting somebody has to remember to change.
   */
  mode: "test" | "live" | "none";
}

/**
 * Read once per page.
 *
 * It changes when a key is rotated, which is a server restart away, so
 * fetching it per component would be a request each to learn the same thing.
 */
const config = pageCache(() => apiGet<PaymentConfig>("/payments/config"));

export function getPaymentConfig(): Promise<PaymentConfig> {
  return config.read();
}

/** One bank or wallet the gateway can route to. */
export interface NamedRail {
  code: string;
  name: string;
}

/**
 * What the payment page may offer.
 *
 * The intersection of two lists: the methods the store has switched on in its
 * own settings, and the ones the Razorpay account can actually take. A method
 * in the first but not the second is one a shopper picks and the gateway then
 * refuses — a failure after the decision, which is the worst place for one.
 */
export interface AvailableMethods {
  gateway: boolean;
  /** "upi" | "card" | "netbanking" | "wallet" | "cod" */
  methods: string[];
  netbanking: NamedRail[];
  wallet: NamedRail[];
  /** Whether a `upi://` app handoff is available. */
  upiIntent: boolean;
  /** Whether a QR code or a UPI-ID request is available through Checkout. */
  upiQr: boolean;
  /**
   * Whether Razorpay's QR Codes product is available.
   *
   * Separate from `upiQr`: QR Codes are their own product, enabled
   * independently of Checkout's UPI method, so an account can scan-to-pay
   * while Checkout UPI is switched off.
   */
  qrCodes: boolean;
}

/** A minted, single-use UPI QR code. */
export interface QrCode {
  id: string;
  /**
   * Our own endpoint, serving the code and nothing else.
   *
   * Razorpay's own image is a portrait poster with the code a third of the way
   * down it; sized to fit a payment panel its modules end up too small for a
   * camera to resolve, and no UPI app can read it. The server crops it.
   */
  imageUrl: string;
  /** Razorpay's full poster, for a "save this" link. */
  posterUrl?: string;
  amount: number;
  status: string;
  closeBy?: number | null;
}

/**
 * Mint a QR code worth exactly this invoice, once.
 *
 * A QR payment is not attached to a gateway order — scanning produces a
 * payment of its own — so it is settled by `pollQr` below and by the
 * `qr_code.credited` webhook, both of which read the gateway's own answer.
 */
export async function createQr(paymentId: string): Promise<QrCode> {
  const code = await apiPost<QrCode>(
    `/payments/${encodeURIComponent(paymentId)}/qr`,
    {},
    AUTH,
  );

  // The server hands back a path; only the client knows the API's origin.
  return { ...code, imageUrl: apiUrl(code.imageUrl) };
}

/** Has it been scanned? Answered by the server reading the gateway. */
export function pollQr(
  paymentId: string,
  qrId: string,
): Promise<{ status: string; paid: boolean }> {
  return apiGet<{ status: string; paid: boolean }>(
    `/payments/${encodeURIComponent(paymentId)}/qr/${encodeURIComponent(qrId)}`,
    AUTH,
  );
}

/** Retire a code the shopper walked away from, so it cannot be scanned later. */
export function closeQr(paymentId: string, qrId: string): Promise<{ closed: boolean }> {
  return apiDelete<{ closed: boolean }>(
    `/payments/${encodeURIComponent(paymentId)}/qr/${encodeURIComponent(qrId)}`,
    AUTH,
  );
}

/**
 * Read once per page.
 *
 * It answers with a forty-bank list, and every panel on the payment page wants
 * the same copy of it.
 */
const methods = pageCache(() => apiGet<AvailableMethods>("/payments/methods"));

export function getPaymentMethods(): Promise<AvailableMethods> {
  return methods.read();
}

/**
 * Hand Checkout's three references to the server for verification.
 *
 * Throws with the server's own message when verification fails, because the
 * reason matters: "that payment belongs to a different order" and "the payment
 * could not be verified" are different problems and only one of them is worth
 * retrying.
 *
 * Note what is *not* sent: no amount, no total, no status. The server knows
 * what is owed and asks the gateway what was paid.
 */
export function verifyPayment(
  paymentId: string,
  response: RazorpayResponse,
): Promise<{ status: string }> {
  return apiPost<{ status: string }>(
    `/payments/${encodeURIComponent(paymentId)}/verify`,
    response,
    AUTH,
  );
}

/**
 * Get back to the payment sheet for an order that was left unpaid.
 *
 * Returns the **same** gateway order rather than a new one, so a shopper who
 * dismissed Checkout and came back cannot end up with two open payments
 * against one invoice.
 *
 * A `gateway` of null means there is nothing to pay — it has been settled,
 * very likely by the webhook while the shopper was away.
 */
export interface PaymentSession {
  status: string;
  /** The order's customer-facing number, for the confirmation page's URL. */
  orderNumber: string;
  /** Null when there is nothing left to pay. */
  gateway: GatewayHandoff | null;
}

export function getPaymentSession(paymentId: string): Promise<PaymentSession> {
  return apiGet<PaymentSession>(
    `/payments/${encodeURIComponent(paymentId)}/session`,
    AUTH,
  );
}
