/**
 * The bridge to Razorpay Checkout.
 *
 * Checkout is a script Razorpay hosts and a modal it renders. The card number,
 * the UPI PIN, the bank login — all of it is collected inside Razorpay's own
 * iframe, on Razorpay's origin. **None of it reaches this application**, which
 * is the entire reason to use a hosted checkout rather than build a card form:
 * a field this code can read is a field this code is responsible for.
 *
 * What comes back out is three opaque references. They go straight to our
 * server, which checks them against the gateway with the key secret. Nothing
 * here decides whether a payment succeeded — see `verifyPayment`.
 */

import type { GatewayHandoff } from "@/types";

const SCRIPT_URL = "https://checkout.razorpay.com/v1/checkout.js";
const SCRIPT_ID = "razorpay-checkout";

/** What Checkout hands back when a payment goes through. */
export interface RazorpayResponse {
  razorpayPaymentId: string;
  razorpayOrderId: string;
  razorpaySignature: string;
}

export type CheckoutOutcome =
  | { status: "completed"; response: RazorpayResponse }
  /** The shopper closed the sheet. The order stands, unpaid. */
  | { status: "dismissed" }
  | { status: "failed"; reason: string };

/**
 * Load the script once per document.
 *
 * The promise is kept rather than the boolean, so two components opening
 * Checkout at the same time wait on one load instead of appending two tags.
 * A failed load clears it, so the next attempt can retry rather than
 * inheriting the failure.
 */
/**
 * Razorpay ships two scripts that both define `window.Razorpay`: Standard
 * Checkout (`checkout.js`, which has `open()`) and Custom Checkout
 * (`razorpay.js`, which has `createPayment()` and no `open()`). Whichever
 * loads second replaces the first, so each loader keeps its own constructor
 * instead of trusting the global — trusting it is what made the card button
 * fail with "o.open is not a function" after a UPI panel had loaded the other.
 */
type RazorpayConstructor = NonNullable<Window["Razorpay"]>;
let Standard: RazorpayConstructor | null = null;
let loading: Promise<void> | null = null;

function loadCheckout(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Secure payment isn't available here. Please try again in your browser."));
  }

  if (Standard) return Promise.resolve();

  loading ??= new Promise<void>((resolve, reject) => {
    const onError = () => {
      loading = null;
      reject(new Error("We couldn't load secure payment. Please refresh the page and try again."));
    };
    const onLoad = () => {
      if (!window.Razorpay || typeof window.Razorpay.prototype?.open !== "function") {
        onError();
        return;
      }
      Standard = window.Razorpay;
      resolve();
    };

    // Always a fresh tag: an existing one may have loaded before the other
    // script replaced the global, and its constructor is no longer reachable.
    document.getElementById(SCRIPT_ID)?.remove();
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = SCRIPT_URL;
    script.async = true;
    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });
    document.head.append(script);
  });

  return loading;
}

/**
 * Open the payment sheet and wait for it to close.
 *
 * Resolves rather than throws for a dismissal, because a shopper changing
 * their mind is an ordinary outcome and the caller has something useful to do
 * about it: the order exists, so it offers to try again. Only a gateway that
 * will not load is thrown.
 *
 * `handoff` comes from our own server. Nothing in it is a secret — see
 * `gateway_handoff` on the API side for why the amount here is a label rather
 * than an instruction.
 */
export async function openRazorpayCheckout(
  handoff: GatewayHandoff,
  options: {
    /**
     * A CSS selector to render inside, instead of floating over the page.
     *
     * Razorpay's embedded mode. Given one, Checkout draws into that container
     * as part of the payment step — no modal, no backdrop, no window over the
     * site. Without one it falls back to the modal, which is what a narrow
     * screen with nowhere to embed actually wants.
     */
    container?: string;
    /**
     * Restrict the frame to one rail, e.g. `"card"`.
     *
     * The storefront offers UPI, net banking and wallets in its own panels,
     * so the embedded frame is there for the one rail that cannot be ours.
     * Letting it offer everything would put two pickers on one page.
     */
    only?: string;
    /**
     * Aborting closes the frame and reports "dismissed".
     *
     * Embedded mode draws no close button of its own, so the page's own
     * "Cancel" and "Pay another way" need a way to take it down.
     */
    signal?: AbortSignal;
  } = {},
): Promise<CheckoutOutcome> {
  await loadCheckout();

  return new Promise<CheckoutOutcome>((resolve) => {
    /**
     * Resolve exactly once.
     *
     * Razorpay calls `modal.ondismiss` after a failure as well as after a
     * plain close, so without this a failed payment would be reported twice
     * and the second answer — "dismissed" — would overwrite the real reason.
     */
    let settled = false;
    const settle = (outcome: CheckoutOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    const checkout = new Standard!({
      key: handoff.keyId,
      order_id: handoff.orderReference,
      amount: handoff.amount,
      currency: handoff.currency,
      name: handoff.merchantName || "Daily Choice Zone",
      description: handoff.description,
      ...(options.container ? { parent: options.container } : {}),
      // Razorpay's own `timeout`, in seconds: after it the customer can no
      // longer use Checkout. Set to what is left of the server's window, so
      // the payment frame closes when the order's hold does. Advisory — a
      // browser timer pauses in a background tab — which is why the server
      // refunds anything that still lands late.
      ...(typeof handoff.secondsLeft === "number" && handoff.secondsLeft > 0
        ? { timeout: handoff.secondsLeft }
        : {}),
      ...(options.only
        ? {
            config: {
              display: {
                blocks: {
                  [options.only]: {
                    name: options.only === "card" ? "Card" : options.only,
                    instruments: [{ method: options.only }],
                  },
                },
                sequence: [`block.${options.only}`],
                // Without this Razorpay appends every other rail underneath.
                preferences: { show_default_blocks: false },
              },
            },
          }
        : {}),
      prefill: {
        name: handoff.name,
        email: handoff.email,
        contact: handoff.phone,
      },
      notes: { paymentId: handoff.paymentId },
      // Matched to the storefront's own ink and cream, so the embedded frame
      // reads as part of this page rather than as a visitor in it.
      theme: { color: "#1c1917", backdrop_color: "#faf7f2", hide_topbar: true },

      handler: (response) => {
        settle({
          status: "completed",
          response: {
            razorpayPaymentId: response.razorpay_payment_id,
            razorpayOrderId: response.razorpay_order_id,
            razorpaySignature: response.razorpay_signature,
          },
        });
      },

      modal: {
        ondismiss: () => settle({ status: "dismissed" }),
        // Closing by accident mid-payment is the worst moment to close.
        confirm_close: true,
        escape: false,
      },
    });

    checkout.on?.("payment.failed", (event) => {
      settle({
        status: "failed",
        reason:
          event?.error?.description ||
          "The payment did not go through. No money has been taken.",
      });
    });

    if (options.signal?.aborted) {
      settle({ status: "dismissed" });
      return;
    }
    options.signal?.addEventListener(
      "abort",
      () => {
        try {
          checkout.close();
        } catch {
          /* already closed */
        }
        settle({ status: "dismissed" });
      },
      { once: true },
    );

    checkout.open();
  });
}
