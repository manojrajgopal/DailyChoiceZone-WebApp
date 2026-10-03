/**
 * Razorpay Custom Checkout.
 *
 * The only way this store talks to Razorpay from the browser. Standard
 * Checkout (Razorpay's modal: their layout, their branding) is not used
 * anywhere. Custom Checkout renders **nothing**: it is a script that exposes
 * `createPayment`, and every pixel the shopper sees is ours.
 *
 * ## Safety
 *
 * For UPI, net banking and wallets nothing sensitive passes through this page
 * — a bank code, a wallet name — and the shopper authenticates in their own
 * bank's page or UPI app.
 *
 * **Cards are entered in our own form** (the store chose this; see
 * docs/payments-in-our-ui.md). The card number, expiry and CVV go from the
 * form's state straight into `createPayment`, over TLS to Razorpay — never to
 * our server, never into storage, logs or analytics. That puts this site in
 * PCI-DSS SAQ-D scope, and Razorpay accepts card payments this way only once
 * it has enabled card payments through Custom Checkout on the account. The
 * bank's own 3-D Secure page (its OTP) still opens: that is the bank's
 * authentication, which no merchant can replace.
 *
 * ## The shapes `createPayment` takes
 *
 *     method: "upi",        upi: { flow: "intent", app }   → opens the app
 *     method: "upi",        upi: { flow: "qr" }            → emits a QR image
 *     method: "upi",        upi: { flow: "collect", vpa }  → request to their app
 *     method: "netbanking", bank: "HDFC"                   → the bank's page
 *     method: "wallet",     wallet: "mobikwik"             → the wallet's page
 *     method: "card",       card[number], card[expiry_month]… → the bank's 3-D Secure page
 */

import type { GatewayHandoff } from "@/types";
import type { CardDetails } from "@/lib/payments/card";

const SCRIPT_URL = "https://checkout.razorpay.com/v1/razorpay.js";
const SCRIPT_ID = "razorpay-custom-checkout";

/** What the card form says about where the details go. */
export const CARD_NOTE =
  "Your card details go straight to our payment processor over an encrypted connection. " +
  "We never store them, and they never reach our servers.";

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
/**
 * The apps Razorpay's mobile-web intent can open, by Razorpay's own codes
 * (`createPayment(data, { app })`). "any" — the phone's own app picker — is
 * Android-only.
 */
export const UPI_APPS: UpiIntentApp[] = [
  { code: "gpay", name: "Google Pay" },
  { code: "phonepe", name: "PhonePe" },
  { code: "paytm", name: "Paytm" },
  { code: "bhim", name: "BHIM" },
  { code: "cred", name: "CRED" },
];

export function isAndroid(): boolean {
  return typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
}

export type PaymentSelection =
  /** `tappedAt`: `performance.now()` at the shopper's tap — see `startCustomPayment`. */
  | { method: "upi"; flow: "intent"; app?: string; tappedAt?: number }
  | { method: "upi"; flow: "qr" }
  | { method: "upi"; flow: "collect"; vpa: string }
  | { method: "netbanking"; bank: string }
  | { method: "wallet"; wallet: string }
  /** Typed into our form; used for this one request and not kept. */
  | { method: "card"; card: CardDetails };

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
  | { type: "error"; reason: string }
  /**
   * The app must be opened by a fresh tap: too long has passed since the
   * shopper's own, and the browser would block the hand-off. Show a button
   * that calls `open`.
   */
  | { type: "tap-to-open"; appName: string; open: () => void };

/**
 * Razorpay ships two scripts that both define `window.Razorpay`: Standard
 * Checkout (`checkout.js`, which has `open()`) and Custom Checkout
 * (`razorpay.js`, which has `createPayment()` and no `open()`). Whichever
 * loads second replaces the first, so each loader keeps its own constructor
 * instead of trusting the global — trusting it is what made the card button
 * fail with "o.open is not a function" after a UPI panel had loaded the other.
 */
type RazorpayConstructor = NonNullable<Window["Razorpay"]>;
let Custom: RazorpayConstructor | null = null;
let loading: Promise<void> | null = null;

/**
 * Load Custom Checkout ahead of time. The payment page calls this on arrival,
 * so the tap on a UPI app is not spent waiting for a script to download.
 */
export function preloadCustomCheckout(): void {
  void loadCustomCheckout().catch(() => undefined);
}

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

  if (Custom) return Promise.resolve();

  loading ??= new Promise<void>((resolve, reject) => {
    const fail = () => {
      loading = null;
      reject(new Error("We couldn't load secure payment. Please refresh the page and try again."));
    };
    const onLoad = () => {
      if (!window.Razorpay || typeof window.Razorpay.prototype?.createPayment !== "function") {
        fail();
        return;
      }
      Custom = window.Razorpay;
      resolve();
    };

    document.getElementById(SCRIPT_ID)?.remove();
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = SCRIPT_URL;
    script.async = true;
    script.addEventListener("load", onLoad, { once: true });
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

  const razorpay = new Custom!({
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

  // UPI intent takes no `upi` block: the app goes in createPayment's second
  // argument, by Razorpay's code (see UPI_APPS).
  const intentApp =
    selection.method === "upi" && selection.flow === "intent"
      ? selection.app || (isAndroid() ? "any" : "gpay")
      : null;

  if (selection.method === "upi" && selection.flow !== "intent") {
    request.upi =
      selection.flow === "collect" ? { flow: "collect", vpa: selection.vpa } : { flow: "qr" };
  }

  if (selection.method === "upi") {
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

  if (selection.method === "card") {
    // Razorpay's documented field names for Custom Checkout cards.
    request["card[number]"] = selection.card.number;
    request["card[name]"] = selection.card.name;
    request["card[expiry_month]"] = selection.card.expiryMonth;
    request["card[expiry_year]"] = selection.card.expiryYear;
    request["card[cvv]"] = selection.card.cvv;
    emit({ type: "waiting", message: "Your bank may ask you to confirm with a one-time password…" });
  }

  const launch = () => {
    try {
      const attempt = intentApp
        ? razorpay.createPayment!(request, { app: intentApp })
        : razorpay.createPayment!(request);
      wire(attempt);
    } catch (error) {
      // Never echo the request (it may hold card details) — only the reason.
      emit({
        type: "error",
        reason:
          error instanceof Error && error.message
            ? error.message
            : "The payment could not be started.",
      });
    }
  };

  /**
   * A browser opens another app only in answer to a tap, and a tap stops
   * counting after a few seconds. Placing the order can take that long; when
   * it has, the shopper is asked to tap once more and the app opens from that.
   */
  const TAP_WINDOW_MS = 3500;
  const tappedAt = selection.method === "upi" && selection.flow === "intent" ? selection.tappedAt : undefined;
  if (intentApp && tappedAt !== undefined && performance.now() - tappedAt > TAP_WINDOW_MS) {
    const appName = UPI_APPS.find((app) => app.code === intentApp)?.name ?? "your UPI app";
    emit({ type: "tap-to-open", appName, open: launch });
  } else {
    launch();
  }

  // Card details are needed only for the call just made; don't keep them.
  for (const key of Object.keys(request)) if (key.startsWith("card[")) delete request[key];

  return () => {
    abandoned = true;
  };

  function wire(attempt: ReturnType<NonNullable<typeof razorpay.createPayment>>) {
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
  }
}
