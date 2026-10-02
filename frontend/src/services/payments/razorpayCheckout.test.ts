import { afterEach, describe, expect, it } from "vitest";

import type { GatewayHandoff } from "@/types";

import { openRazorpayCheckout } from "./razorpayCheckout";

/**
 * jsdom never actually fetches `<script src>` tags, so "loading" Razorpay's
 * SDK here means: find the tag the module created, install a fake
 * `window.Razorpay` constructor, and dispatch the `load` event ourselves —
 * exactly the signal the module waits for. The fake constructor matches the
 * `RazorpayInstance` shape from `types/payment-gateway.d.ts` and records the
 * instance it created so the test can trigger its callbacks (`handler`,
 * `modal.ondismiss`, `on("payment.failed", …)`) the way the real iframe would.
 */
const SCRIPT_ID = "razorpay-checkout";

interface RecordedInstance {
  options: Record<string, unknown>;
  openCalled: boolean;
  closeCalled: boolean;
  handlers: Record<string, (event: never) => void>;
}

let lastInstance: RecordedInstance | null = null;

class FakeRazorpayStandard {
  options: Record<string, unknown>;
  constructor(options: Record<string, unknown>) {
    this.options = options;
    lastInstance = { options, openCalled: false, closeCalled: false, handlers: {} };
  }
  open() {
    lastInstance!.openCalled = true;
  }
  close() {
    lastInstance!.closeCalled = true;
  }
  on(event: string, handler: (event: never) => void) {
    lastInstance!.handlers[event] = handler;
  }
}

const HANDOFF: GatewayHandoff = {
  provider: "razorpay",
  keyId: "rzp_test_123",
  orderReference: "order_abc",
  paymentId: "PAY1",
  amount: 50000,
  currency: "INR",
  name: "Asha Rao",
  email: "asha@example.com",
  phone: "9876543210",
  description: "Order DCZ-1",
  expiresAt: null,
  secondsLeft: null,
} as unknown as GatewayHandoff;

/**
 * Dispatch `load` on the script tag the module just created — but only the
 * first time: the module caches the Razorpay constructor at module scope
 * once loaded, so later calls in this file resolve without creating a new
 * tag at all. Either way, a couple of microtask ticks lets the `await
 * loadCheckout()` continuation (which constructs `Standard` and calls
 * `.open()`) run before the test inspects `lastInstance`.
 */
async function loadWithFakeSdk() {
  const script = document.getElementById(SCRIPT_ID);
  if (script) {
    (window as unknown as { Razorpay: unknown }).Razorpay = FakeRazorpayStandard;
    script.dispatchEvent(new Event("load"));
  }
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  lastInstance = null;
});

describe("openRazorpayCheckout", () => {
  // These two failure-path tests must run (and must run in this order)
  // before any test lets the SDK load successfully: once it has, the module
  // caches the Razorpay constructor at module scope and every later call
  // skips script loading entirely — there is no way back to a "loads but
  // looks wrong" or "fails to load" state from this file after that.

  it("rejects when the script loads but Razorpay's global looks wrong", async () => {
    const outcome = openRazorpayCheckout(HANDOFF);
    const script = document.getElementById(SCRIPT_ID)!;
    expect(script).not.toBeNull();
    (window as unknown as { Razorpay: unknown }).Razorpay = class {}; // no .prototype.open
    script.dispatchEvent(new Event("load"));
    await expect(outcome).rejects.toThrow(/couldn't load secure payment/);
  });

  it("rejects when the script fails to load, and lets a later attempt retry", async () => {
    const outcome = openRazorpayCheckout(HANDOFF);
    const script = document.getElementById(SCRIPT_ID)!;
    expect(script).not.toBeNull();
    script.dispatchEvent(new Event("error"));
    await expect(outcome).rejects.toThrow(/couldn't load secure payment/);

    // A later attempt is not stuck with the earlier failure.
    const retry = openRazorpayCheckout(HANDOFF);
    await loadWithFakeSdk();
    (lastInstance!.options.modal as { ondismiss: () => void }).ondismiss();
    await expect(retry).resolves.toEqual({ status: "dismissed" });
  });

  it("creates the script tag, opens Checkout, and resolves 'completed' when the handler fires", async () => {
    const outcome = openRazorpayCheckout(HANDOFF);
    await loadWithFakeSdk();

    expect(lastInstance!.openCalled).toBe(true);
    expect(lastInstance!.options).toMatchObject({ key: "rzp_test_123", order_id: "order_abc", amount: 50000, currency: "INR" });

    const handler = lastInstance!.options.handler as (r: unknown) => void;
    handler({ razorpay_payment_id: "pay_1", razorpay_order_id: "order_abc", razorpay_signature: "sig_1" });

    await expect(outcome).resolves.toEqual({
      status: "completed",
      response: { razorpayPaymentId: "pay_1", razorpayOrderId: "order_abc", razorpaySignature: "sig_1" },
    });
  });

  it("resolves 'dismissed' when the shopper closes the modal", async () => {
    const outcome = openRazorpayCheckout(HANDOFF);
    await loadWithFakeSdk();

    const modal = lastInstance!.options.modal as { ondismiss: () => void };
    modal.ondismiss();

    await expect(outcome).resolves.toEqual({ status: "dismissed" });
  });

  it("resolves 'failed' with the gateway's reason on payment.failed", async () => {
    const outcome = openRazorpayCheckout(HANDOFF);
    await loadWithFakeSdk();

    lastInstance!.handlers["payment.failed"]!({ error: { description: "Card declined" } } as never);

    await expect(outcome).resolves.toEqual({ status: "failed", reason: "Card declined" });
  });

  it("uses a generic reason when the gateway sends none", async () => {
    const outcome = openRazorpayCheckout(HANDOFF);
    await loadWithFakeSdk();

    lastInstance!.handlers["payment.failed"]!({} as never);

    await expect(outcome).resolves.toEqual({ status: "failed", reason: "The payment did not go through. No money has been taken." });
  });

  it("only resolves once: a failed payment is not then reported as dismissed", async () => {
    const outcome = openRazorpayCheckout(HANDOFF);
    await loadWithFakeSdk();

    lastInstance!.handlers["payment.failed"]!({ error: { description: "Declined" } } as never);
    (lastInstance!.options.modal as { ondismiss: () => void }).ondismiss();

    await expect(outcome).resolves.toEqual({ status: "failed", reason: "Declined" });
  });

  it("passes a Razorpay timeout equal to the seconds left on the payment window", async () => {
    const outcome = openRazorpayCheckout({ ...HANDOFF, secondsLeft: 120 });
    await loadWithFakeSdk();
    expect(lastInstance!.options.timeout).toBe(120);
    (lastInstance!.options.modal as { ondismiss: () => void }).ondismiss();
    await outcome;
  });

  it("sends no timeout when there is no window left (null or zero)", async () => {
    const outcome = openRazorpayCheckout({ ...HANDOFF, secondsLeft: 0 });
    await loadWithFakeSdk();
    expect(lastInstance!.options.timeout).toBeUndefined();
    (lastInstance!.options.modal as { ondismiss: () => void }).ondismiss();
    await outcome;
  });

  it("swallows an error from closing an already-closed sheet on abort", async () => {
    const controller = new AbortController();
    const outcome = openRazorpayCheckout(HANDOFF, { signal: controller.signal });
    await loadWithFakeSdk();
    lastInstance!.closeCalled = false;
    const instance = lastInstance!;
    // Simulate a sheet that throws when asked to close twice.
    const originalClose = FakeRazorpayStandard.prototype.close;
    FakeRazorpayStandard.prototype.close = function () {
      throw new Error("already closed");
    };
    try {
      controller.abort();
      await expect(outcome).resolves.toEqual({ status: "dismissed" });
    } finally {
      FakeRazorpayStandard.prototype.close = originalClose;
    }
    void instance;
  });

  it("passes the embedded container and single-method config when given", async () => {
    const outcome = openRazorpayCheckout(HANDOFF, { container: "#pay-frame", only: "card" });
    await loadWithFakeSdk();
    expect(lastInstance!.options.parent).toBe("#pay-frame");
    expect(lastInstance!.options.config).toMatchObject({
      display: { sequence: ["block.card"], preferences: { show_default_blocks: false } },
    });
    (lastInstance!.options.modal as { ondismiss: () => void }).ondismiss();
    await outcome;
  });

  it("resolves 'dismissed' immediately when the caller's signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = openRazorpayCheckout(HANDOFF, { signal: controller.signal });
    await loadWithFakeSdk();
    await expect(outcome).resolves.toEqual({ status: "dismissed" });
    expect(lastInstance!.closeCalled).toBe(false); // nothing to close, never opened the sheet's close path
  });

  it("closes the sheet and resolves 'dismissed' when the caller aborts mid-payment", async () => {
    const controller = new AbortController();
    const outcome = openRazorpayCheckout(HANDOFF, { signal: controller.signal });
    await loadWithFakeSdk();
    controller.abort();
    await expect(outcome).resolves.toEqual({ status: "dismissed" });
    expect(lastInstance!.closeCalled).toBe(true);
  });

  it("rejects when there is no window (server environment)", async () => {
    const original = globalThis.window;
    // @ts-expect-error -- simulating SSR
    delete globalThis.window;
    try {
      await expect(openRazorpayCheckout(HANDOFF)).rejects.toThrow(/isn't available/);
    } finally {
      globalThis.window = original;
    }
  });
});
