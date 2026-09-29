/**
 * The shape of the Razorpay Checkout script, as much of it as we use.
 *
 * Hand-written rather than pulled from a package: the script is loaded from
 * Razorpay's CDN at runtime, so a types package would be a second thing to
 * keep in step with it, describing code we do not ship.
 */

interface RazorpayCheckoutResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayFailureEvent {
  error?: {
    code?: string;
    description?: string;
    reason?: string;
  };
}

interface RazorpayOptions {
  /** The publishable key id. Never the secret. */
  key: string;
  /**
   * The gateway order this payment is against.
   *
   * Optional because Custom Checkout takes it inside `createPayment` instead
   * of at construction.
   */
  order_id?: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  image?: string;
  prefill?: { name?: string; email?: string; contact?: string };
  notes?: Record<string, string>;
  theme?: { color?: string; backdrop_color?: string; hide_topbar?: boolean };
  /**
   * A CSS selector for an element to render inside.
   *
   * Razorpay's "embedded" mode. With it, Checkout draws into that container
   * as part of the page instead of opening a floating modal over it — which
   * is the difference between a payment step and a popup.
   */
  parent?: string;
  /** Seconds after which Checkout can no longer be used. */
  timeout?: number;
  /**
   * Which rails the frame offers.
   *
   * `method` is Custom Checkout's key and Standard Checkout ignores it; the
   * documented way to restrict Standard Checkout is a display config of
   * blocks, a sequence naming them, and `show_default_blocks: false` to stop
   * it adding everything else back.
   */
  config?: {
    display?: {
      blocks?: Record<string, { name: string; instruments: { method: string }[] }>;
      sequence?: string[];
      preferences?: { show_default_blocks?: boolean };
    };
  };
  handler?: (response: RazorpayCheckoutResponse) => void;
  modal?: {
    ondismiss?: () => void;
    confirm_close?: boolean;
    escape?: boolean;
  };
}

/** A UPI QR code to render, as Custom Checkout emits it. */
interface RazorpayQrEvent {
  image_url?: string;
  qr?: string;
}

/** An in-flight Custom Checkout attempt. */
interface RazorpayAttempt {
  on?(event: "payment.qr", handler: (event: RazorpayQrEvent) => void): void;
  on?(event: "payment.error", handler: (event: RazorpayFailureEvent) => void): void;
  on?(event: string, handler: (event: never) => void): void;
}

interface RazorpayInstance {
  open(): void;
  close(): void;
  /**
   * `payment.failed` is Standard Checkout's; `payment.success` and
   * `payment.error` are Custom Checkout's. One object, two scripts — which
   * events it emits depends on which one was loaded.
   */
  on?(event: "payment.failed", handler: (event: RazorpayFailureEvent) => void): void;
  on?(event: "payment.error", handler: (event: RazorpayFailureEvent) => void): void;
  on?(
    event: "payment.success",
    handler: (response: RazorpayCheckoutResponse) => void,
  ): void;
  /**
   * Custom Checkout only. Present when `razorpay.js` was loaded rather than
   * `checkout.js`, which is why both it and `on` are optional here.
   */
  createPayment?(request: Record<string, unknown>): RazorpayAttempt | undefined;
}

interface Window {
  Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
}
