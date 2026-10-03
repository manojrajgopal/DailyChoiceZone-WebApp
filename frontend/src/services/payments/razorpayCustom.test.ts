import { afterEach, describe, expect, it, vi } from "vitest";

import type { GatewayHandoff } from "@/types";

import {
  CARD_NOTE,
  UPI_APPS,
  isAndroid,
  startCustomPayment,
  supportsUpiIntent,
  type CustomPaymentEvent,
} from "./razorpayCustom";

const SCRIPT_ID = "razorpay-custom-checkout";

interface RecordedAttempt {
  handlers: Record<string, (event: never) => void>;
}
interface RecordedInstance {
  options: Record<string, unknown>;
  lastRequest: Record<string, unknown> | null;
  /** A copy taken at the moment of the call. */
  sent: Record<string, unknown> | null;
  lastAppOption: { app: string } | undefined;
  handlers: Record<string, (event: never) => void>;
  attempt: RecordedAttempt;
}

let lastInstance: RecordedInstance | null = null;

class FakeRazorpayCustom {
  options: Record<string, unknown>;
  constructor(options: Record<string, unknown>) {
    this.options = options;
    lastInstance = { options, lastRequest: null, sent: null, lastAppOption: undefined, handlers: {}, attempt: { handlers: {} } };
  }
  on(event: string, handler: (event: never) => void) {
    lastInstance!.handlers[event] = handler;
  }
  createPayment(request: Record<string, unknown>, appOption?: { app: string }) {
    lastInstance!.lastRequest = request;
    lastInstance!.sent = { ...request };
    lastInstance!.lastAppOption = appOption;
    return {
      on(event: string, handler: (e: never) => void) {
        lastInstance!.attempt.handlers[event] = handler;
      },
    };
  }
}

async function loadWithFakeSdk() {
  const script = document.getElementById(SCRIPT_ID);
  if (script) {
    (window as unknown as { Razorpay: unknown }).Razorpay = FakeRazorpayCustom;
    script.dispatchEvent(new Event("load"));
  }
  await Promise.resolve();
  await Promise.resolve();
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

afterEach(() => {
  lastInstance = null;
});

describe("supportsUpiIntent / isAndroid", () => {
  const originalUserAgent = navigator.userAgent;
  afterEach(() => {
    Object.defineProperty(window.navigator, "userAgent", { value: originalUserAgent, configurable: true });
  });

  it.each([
    ["Mozilla/5.0 (Linux; Android 13)", true, true],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)", true, false],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", false, false],
  ])("%s -> supportsUpiIntent=%s, isAndroid=%s", (ua, supports, android) => {
    Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
    expect(supportsUpiIntent()).toBe(supports);
    expect(isAndroid()).toBe(android);
  });
});

describe("CARD_NOTE / UPI_APPS", () => {
  it("tells the shopper where card details go", () => {
    expect(CARD_NOTE).toMatch(/never store them/);
  });

  it("lists the known UPI apps by Razorpay's package codes", () => {
    expect(UPI_APPS.map((a) => a.code)).toEqual(["gpay", "phonepe", "paytm", "bhim", "cred"]);
  });
});

describe("startCustomPayment", () => {
  // This failure-path test must run before any test lets the SDK load
  // successfully: once it has, the module caches the constructor and every
  // later call skips script loading.
  it("rejects when the script fails to load, and lets a later attempt retry", async () => {
    const outcome = startCustomPayment(HANDOFF, { method: "upi", flow: "qr" }, vi.fn());
    const script = document.getElementById(SCRIPT_ID)!;
    expect(script).not.toBeNull();
    script.dispatchEvent(new Event("error"));
    await expect(outcome).rejects.toThrow(/couldn't load secure payment/);

    const events: CustomPaymentEvent[] = [];
    const retry = startCustomPayment(HANDOFF, { method: "upi", flow: "qr" }, (e) => events.push(e));
    await loadWithFakeSdk();
    await retry;
    expect(lastInstance).not.toBeNull();
  });

  it("rejects when there is no window (server environment)", async () => {
    const original = globalThis.window;
    // @ts-expect-error -- simulating SSR
    delete globalThis.window;
    try {
      await expect(startCustomPayment(HANDOFF, { method: "upi", flow: "qr" }, vi.fn())).rejects.toThrow(/isn't available/);
    } finally {
      globalThis.window = original;
    }
  });

  it("starts a UPI collect request, sends a waiting event, and reports success", async () => {
    const events: CustomPaymentEvent[] = [];
    const abandon = startCustomPayment(HANDOFF, { method: "upi", flow: "collect", vpa: "asha@upi" }, (e) => events.push(e));
    await loadWithFakeSdk();

    expect(events).toContainEqual({ type: "waiting", message: "We have sent a request to your UPI app. Approve it to finish." });
    expect(lastInstance!.lastRequest).toMatchObject({ method: "upi", upi: { flow: "collect", vpa: "asha@upi" } });

    lastInstance!.attempt.handlers["payment.qr"]?.({} as never); // not registered for collect flow's request path, harmless
    lastInstance!.handlers["payment.success"]!({
      razorpay_payment_id: "pay_1", razorpay_order_id: "order_abc", razorpay_signature: "sig_1",
    } as never);

    expect(events.at(-1)).toEqual({
      type: "success",
      response: { razorpayPaymentId: "pay_1", razorpayOrderId: "order_abc", razorpaySignature: "sig_1" },
    });
    await abandon; // resolves to the abandon function; awaiting just confirms no throw
  });

  it("emits a qr event from the attempt when the flow is 'qr'", async () => {
    const events: CustomPaymentEvent[] = [];
    await startCustomPayment(HANDOFF, { method: "upi", flow: "qr" }, (e) => events.push(e));
    await loadWithFakeSdk();
    expect(lastInstance!.lastRequest).toMatchObject({ upi: { flow: "qr" } });

    lastInstance!.attempt.handlers["payment.qr"]!({ image_url: "data:image/png;base64,AAA" } as never);
    expect(events.at(-1)).toEqual({ type: "qr", qr: "data:image/png;base64,AAA" });
  });

  it("reports an error from the attempt with the gateway's reason, or a generic one", async () => {
    const events: CustomPaymentEvent[] = [];
    await startCustomPayment(HANDOFF, { method: "netbanking", bank: "HDFC" }, (e) => events.push(e));
    await loadWithFakeSdk();
    expect(lastInstance!.lastRequest).toMatchObject({ method: "netbanking", bank: "HDFC" });
    expect(events).toContainEqual({ type: "waiting", message: "Taking you to your bank to sign in…" });

    lastInstance!.attempt.handlers["payment.error"]!({ error: { description: "Bank timed out" } } as never);
    expect(events.at(-1)).toEqual({ type: "error", reason: "Bank timed out" });
  });

  it("sends a card in Razorpay's field names, then keeps none of it", async () => {
    const events: CustomPaymentEvent[] = [];
    const card = { number: "4111111111111111", name: "Asha Rao", expiryMonth: "12", expiryYear: "30", cvv: "123" };
    const started = startCustomPayment(HANDOFF, { method: "card", card }, (event) => events.push(event));
    await loadWithFakeSdk();
    await started;
    // What reached createPayment, recorded at the moment of the call.
    expect(lastInstance!.sent).toMatchObject({
      method: "card", order_id: "order_abc", "card[number]": "4111111111111111", "card[name]": "Asha Rao",
      "card[expiry_month]": "12", "card[expiry_year]": "30", "card[cvv]": "123",
    });
    expect(events[0]).toMatchObject({ type: "waiting", message: expect.stringMatching(/bank may ask/) });
    // The request object is emptied of card fields straight after the call.
    expect(Object.keys(lastInstance!.lastRequest!).some((key) => key.startsWith("card["))).toBe(false);
  });

  it("reports a wallet payment's waiting message", async () => {
    const events: CustomPaymentEvent[] = [];
    await startCustomPayment(HANDOFF, { method: "wallet", wallet: "mobikwik" }, (e) => events.push(e));
    await loadWithFakeSdk();
    expect(lastInstance!.lastRequest).toMatchObject({ method: "wallet", wallet: "mobikwik" });
    expect(events).toContainEqual({ type: "waiting", message: "Taking you to your wallet to approve…" });
  });

  it("picks the given app, or a platform default, for a UPI intent", async () => {
    const events: CustomPaymentEvent[] = [];
    await startCustomPayment(HANDOFF, { method: "upi", flow: "intent", app: "phonepe" }, (e) => events.push(e));
    await loadWithFakeSdk();
    expect(lastInstance!.lastAppOption).toEqual({ app: "phonepe" });
  });

  it("defers an intent to a fresh tap when too long has passed since the shopper's own", async () => {
    const events: CustomPaymentEvent[] = [];
    const longAgo = performance.now() - 10_000;
    await startCustomPayment(HANDOFF, { method: "upi", flow: "intent", app: "gpay", tappedAt: longAgo }, (e) => events.push(e));
    await loadWithFakeSdk();

    const tapToOpen = events.find((e) => e.type === "tap-to-open");
    expect(tapToOpen).toMatchObject({ type: "tap-to-open", appName: "Google Pay" });
    expect(lastInstance!.lastRequest).toBeNull(); // not launched yet

    (tapToOpen as Extract<CustomPaymentEvent, { type: "tap-to-open" }>).open();
    expect(lastInstance!.lastRequest).toMatchObject({ method: "upi" });
  });

  it("launches immediately when the tap was recent", async () => {
    const events: CustomPaymentEvent[] = [];
    await startCustomPayment(HANDOFF, { method: "upi", flow: "intent", tappedAt: performance.now() }, (e) => events.push(e));
    await loadWithFakeSdk();
    expect(events.some((e) => e.type === "tap-to-open")).toBe(false);
    expect(lastInstance!.lastRequest).toMatchObject({ method: "upi" });
  });

  it("stops emitting events once abandoned", async () => {
    const events: CustomPaymentEvent[] = [];
    const abandon = await startCustomPayment(HANDOFF, { method: "wallet", wallet: "paytm" }, (e) => events.push(e));
    await loadWithFakeSdk();
    const before = events.length;
    abandon();
    lastInstance!.attempt.handlers["payment.error"]?.({ error: { description: "x" } } as never);
    expect(events).toHaveLength(before);
  });

  it("reports an error when createPayment itself throws", async () => {
    const events: CustomPaymentEvent[] = [];
    await startCustomPayment(HANDOFF, { method: "upi", flow: "qr" }, (e) => events.push(e));
    await loadWithFakeSdk();
    // Re-wire createPayment on the existing instance to throw for this assertion.
    (window as unknown as { Razorpay: typeof FakeRazorpayCustom }).Razorpay.prototype.createPayment = () => {
      throw new Error("boom");
    };
    const events2: CustomPaymentEvent[] = [];
    await startCustomPayment(HANDOFF, { method: "upi", flow: "qr" }, (e) => events2.push(e));
    await loadWithFakeSdk();
    expect(events2).toContainEqual({ type: "error", reason: "boom" });
  });

  it("uses a generic reason when createPayment throws something other than an Error", async () => {
    const events: CustomPaymentEvent[] = [];
    await startCustomPayment(HANDOFF, { method: "upi", flow: "qr" }, (e) => events.push(e));
    await loadWithFakeSdk();
    (window as unknown as { Razorpay: typeof FakeRazorpayCustom }).Razorpay.prototype.createPayment = () => {
      // Simulating a non-Error throw from the SDK.
      throw "not an Error instance";
    };
    const events2: CustomPaymentEvent[] = [];
    await startCustomPayment(HANDOFF, { method: "upi", flow: "qr" }, (e) => events2.push(e));
    await loadWithFakeSdk();
    expect(events2).toContainEqual({ type: "error", reason: "The payment could not be started." });
  });

  it("reports an error from the Razorpay instance itself (not the attempt)", async () => {
    const events: CustomPaymentEvent[] = [];
    await startCustomPayment(HANDOFF, { method: "upi", flow: "qr" }, (e) => events.push(e));
    await loadWithFakeSdk();
    lastInstance!.handlers["payment.error"]!({ error: { description: "Instance-level failure" } } as never);
    expect(events).toContainEqual({ type: "error", reason: "Instance-level failure" });
  });

  it("uses a generic reason for an instance-level error with no description", async () => {
    const events: CustomPaymentEvent[] = [];
    await startCustomPayment(HANDOFF, { method: "upi", flow: "qr" }, (e) => events.push(e));
    await loadWithFakeSdk();
    lastInstance!.handlers["payment.error"]!({} as never);
    expect(events).toContainEqual({ type: "error", reason: "The payment did not go through. No money has been taken." });
  });
});
