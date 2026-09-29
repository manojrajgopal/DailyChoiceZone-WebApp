/**
 * Razorpay Custom Checkout.
 *
 * The difference from `razorpayCheckout.ts` — which this replaces on the
 * payment page — is whose interface the shopper is looking at. Standard
 * Checkout renders Razorpay's modal in an iframe: their layout, their
 * branding, their "Test Mode" ribbon. Custom Checkout renders **nothing**. It
 * is a script that exposes `createPayment`, and every pixel is ours.
 *
 * ## What that does and does not change about safety
 *
 * For UPI, net banking and wallets it changes nothing at all. The only things
 * that pass through this page are a bank code, a wallet name or a UPI address
 * — none of them a credential. The shopper authenticates in their own bank's
 * page or their own UPI app, exactly as before.
 *
 * **Cards are different and are deliberately not handled here.** Sending a
 * card number through `createPayment` would put PANs and CVVs in this
 * application's own JavaScript, which moves the whole site from PCI-DSS SAQ-A
 * to SAQ-D, and Razorpay gates that behind a PCI certification on the account.
 * `openCardPayment` in `razorpayCheckout.ts` stays the card path for that
 * reason, and `CARD_NOTE` below is what the UI says about it.
 *
 * ## The shapes `createPayment` takes
 *
 *     method: "upi",        upi: { flow: "intent", app }   → opens the app
 *     method: "upi",        upi: { flow: "qr" }            → emits a QR image
 *     method: "upi",        upi: { flow: "collect", vpa }  → request to their app
 *     method: "netbanking", bank: "HDFC"                   → the bank's page
 *     method: "wallet",     wallet: "mobikwik"             → the wallet's page
 */

import type { GatewayHandoff } from "@/types";

const SCRIPT_URL = "https://checkout.razorpay.com/v1/razorpay.js";
const SCRIPT_ID = "razorpay-custom-checkout";

/** Why cards do not use this file. Shown in the UI beside the card option. */
export const CARD_NOTE =
  "Card details are entered on a secure field provided by our payment " +
  "processor, so this site never sees or stores them.";

export interface UpiIntentApp {
  /** The Android package, which is what the intent is addressed to. */
  code: string;
  name: string;
}

/**
 * The UPI apps worth offering by name.
 *
 * Razorpay resolves an intent by package name, so these are the packages, not
 * display strings. Offered only on a device that could have them installed —
 * a `upi://` intent on a desktop opens nothing and looks broken.
 */
export const UPI_APPS: UpiIntentApp[] = [
  { code: "com.google.android.apps.nbu.paisa.user", name: "Google Pay" },
  { code: "com.phonepe.app", name: "PhonePe" },
  { code: "net.one97.paytm", name: "Paytm" },
  { code: "in.org.npci.upiapp", name: "BHIM" },
  { code: "in.amazon.mShop.android.shopping", name: "Amazon Pay" },
];

export type PaymentSelection =
  | { method: "upi"; flow: "intent"; app?: string }
  | { method: "upi"; flow: "qr" }
  | { method: "upi"; flow: "collect"; vpa: string }
  | { method: "netbanking"; bank: string }
  | { method: "wallet"; wallet: string };

export interface RazorpaySuccess {
  razorpayPaymentId: string;
  razorpayOrderId: string;
  razorpaySignature: string;
}

export type CustomPaymentEvent =
  /** A QR image to display. `qr` is a data URL. */
  | { type: "qr"; qr: string }
  /** Waiting on the shopper — in their UPI app, their bank, their wallet. */
  | { type: "waiting"; message: string }
  | { type: "success"; response: RazorpaySuccess }
  | { type: "error"; reason: string };

let loading: Promise<void> | null = null;

/**
 * Load the script once per document.
 *
 * The promise is kept rather than a boolean so two mounts wait on one load; a
 * failure clears it so the next attempt retries rather than inheriting it.
 */
function loadCustomCheckout(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Secure payment isn't available here. Please try again in your browser."));
  }

  if (window.Razorpay) return Promise.resolve();

  loading ??= new Promise<void>((resolve, reject) => {
    const fail = () => {
      loading = null;
      reject(new Error("We couldn't load secure payment. Please refresh the page and try again."));
    };

    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", fail, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = SCRIPT_URL;
    script.async = true;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", fail, { once: true });
    document.head.append(script);
  });

  return loading;
}

/** True on a device that could have a UPI app installed to hand off to. */
export function supportsUpiIntent(): boolean {
  if (typeof navigator === "undefined") return false;
  // Coarse on purpose: the question is "could an app answer a upi:// link",
  // and a touch device with a small viewport is the honest approximation.
  return /android|iphone|ipad|ipod/i.test(navigator.userAgent);
}

/**
 * Start a payment, and report what happens as it happens.
 *
 * `onEvent` is called rather than a promise resolved, because these flows are
 * not one round trip: a QR has to be shown while the page keeps waiting, and a
 * collect request sits pending until somebody approves it on their phone.
 *
 * Returns a function that abandons the attempt, for a shopper who changes
 * their mind — the order stays, unpaid, and can be paid later.
 */
export async function startCustomPayment(
  handoff: GatewayHandoff,
  selection: PaymentSelection,
  onEvent: (event: CustomPaymentEvent) => void,
): Promise<() => void> {
  await loadCustomCheckout();

  const razorpay = new window.Razorpay!({
    key: handoff.keyId,
    // No `order_id` here: Custom Checkout takes it inside createPayment.
    amount: handoff.amount,
    currency: handoff.currency,
    name: handoff.merchantName,
  });

  let abandoned = false;

  const emit = (event: CustomPaymentEvent) => {
    if (!abandoned) onEvent(event);
  };

  razorpay.on?.("payment.success", (response) => {
    emit({
      type: "success",
      response: {
        razorpayPaymentId: response.razorpay_payment_id,
        razorpayOrderId: response.razorpay_order_id,
        razorpaySignature: response.razorpay_signature,
      },
    });
  });

  razorpay.on?.("payment.error", (event) => {
    emit({
      type: "error",
      reason:
        event?.error?.description ||
        "The payment did not go through. No money has been taken.",
    });
  });

  const request: Record<string, unknown> = {
    amount: handoff.amount,
    currency: handoff.currency,
    order_id: handoff.orderReference,
    email: handoff.email,
    contact: handoff.phone,
    method: selection.method,
  };

  if (selection.method === "upi") {
    request.upi =
      selection.flow === "collect"
        ? { flow: "collect", vpa: selection.vpa }
        : selection.flow === "intent"
          ? { flow: "intent", ...(selection.app ? { app: selection.app } : {}) }
          : { flow: "qr" };

    emit({
      type: "waiting",
      message:
        selection.flow === "qr"
          ? "Scan the code with any UPI app to pay."
          : selection.flow === "collect"
            ? "We have sent a request to your UPI app. Approve it to finish."
            : "Complete the payment in your UPI app.",
    });
  }

  if (selection.method === "netbanking") {
    request.bank = selection.bank;
    emit({ type: "waiting", message: "Taking you to your bank to sign in…" });
  }

  if (selection.method === "wallet") {
    request.wallet = selection.wallet;
    emit({ type: "waiting", message: "Taking you to your wallet to approve…" });
  }

  try {
    const attempt = razorpay.createPayment!(request);

    // A QR flow answers with an image to render; the others redirect or hand
    // off to an app and come back through `payment.success`.
    attempt?.on?.("payment.qr", (event) => {
      const qr = event?.image_url || event?.qr;
      if (qr) emit({ type: "qr", qr });
    });

    attempt?.on?.("payment.error", (event) => {
      emit({
        type: "error",
        reason: event?.error?.description || "The payment could not be started.",
      });
    });
  } catch (error) {
    emit({
      type: "error",
      reason:
        error instanceof Error && error.message
          ? error.message
          : "The payment could not be started.",
    });
  }

  return () => {
    abandoned = true;
  };
}
