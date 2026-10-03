import { describe, expect, it, vi } from "vitest";

import type { GatewayHandoff } from "@/types";
import { api } from "@/test/api";
import { renderUI, screen, waitFor } from "@/test/render";

/**
 * Razorpay's Custom Checkout script is an external SDK, so `startCustomPayment`
 * is stubbed; everything else — the method list, our card form, the verify
 * call — is real.
 */
vi.mock("@/services/payments/razorpayCustom", async (original) => ({
  ...(await original<typeof import("@/services/payments/razorpayCustom")>()),
  preloadCustomCheckout: vi.fn(),
  startCustomPayment: vi.fn(async (_handoff, _selection, onEvent) => {
    setTimeout(() => onEvent({ type: "success", response: { razorpayPaymentId: "pay_1", razorpayOrderId: "order_1",
      razorpaySignature: "sig" } }), 0);
    return vi.fn();
  }),
}));

import { startCustomPayment } from "@/services/payments/razorpayCustom";

import { EmbeddedPayment } from "./EmbeddedPayment";

const HANDOFF = {
  provider: "razorpay", keyId: "rzp_test", orderReference: "order_1", paymentId: "MEMPAY1", amount: 49900,
  currency: "INR", name: "Asha", email: "a@example.com", phone: "9999999999", description: "Membership",
} as unknown as GatewayHandoff;

async function setup() {
  api.get("/payments/methods", {
    gateway: true, methods: ["upi", "card", "netbanking", "wallet", "cod", "qr"], netbanking: [], wallet: [],
    upiIntent: false, upiQr: true, qrCodes: true,
  });
  const verify = vi.fn().mockResolvedValue({});
  const onPaid = vi.fn();
  const onCancel = vi.fn();
  const view = renderUI(<EmbeddedPayment handoff={HANDOFF} verify={verify} onPaid={onPaid} onCancel={onCancel}
    successMessage="Welcome!" heading="Pay for Plus" />);
  await screen.findByRole("button", { name: /Credit or debit card/ });
  return { ...view, verify, onPaid, onCancel };
}

describe("EmbeddedPayment", () => {
  it("offers our own methods — never cash on delivery, never the order-only QR codes", async () => {
    await setup();
    expect(screen.getByRole("heading", { name: "Pay for Plus" })).toBeInTheDocument();
    expect(screen.getByText("₹499")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cash on delivery/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Scan to pay/ })).not.toBeInTheDocument();
  });

  it("pays by card in our form, then settles with the caller's own verify", async () => {
    const { user, verify, onPaid } = await setup();
    await user.click(screen.getByRole("button", { name: /Credit or debit card/ }));
    await user.type(screen.getByLabelText("Card number"), "5555555555554444");
    await user.type(screen.getByLabelText("Name on card"), "Asha Rao");
    await user.type(screen.getByLabelText("Expiry (MM / YY)"), "1131");
    await user.type(screen.getByLabelText("CVV"), "321");
    await user.click(screen.getByRole("button", { name: "Pay ₹499" }));

    await waitFor(() => expect(onPaid).toHaveBeenCalled());
    expect(vi.mocked(startCustomPayment).mock.calls[0]?.[1]).toMatchObject({ method: "card" });
    expect(verify).toHaveBeenCalledWith({ razorpayPaymentId: "pay_1", razorpayOrderId: "order_1", razorpaySignature: "sig" });
    // The order payment's own verify endpoint is never involved.
    expect(api.requests("POST", /\/payments\/.*\/verify/)).toHaveLength(0);
  });

  it("lets the shopper back out", async () => {
    const { user, onCancel } = await setup();
    await user.click(screen.getByRole("button", { name: /Cancel — don.t pay now/ }));
    expect(onCancel).toHaveBeenCalled();
  });
});
