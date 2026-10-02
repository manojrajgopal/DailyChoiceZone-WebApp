import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AvailableMethods } from "@/services/payments/paymentGatewayService";
import { api, fail } from "@/test/api";
import { renderUI, screen, waitFor, within } from "@/test/render";

function methods(overrides: Partial<AvailableMethods> = {}): AvailableMethods {
  return {
    gateway: true,
    methods: ["upi", "card", "netbanking", "wallet", "cod"],
    netbanking: [{ code: "hdfc", name: "HDFC Bank" }, { code: "icici", name: "ICICI Bank" }],
    wallet: [{ code: "paytm", name: "Paytm Wallet" }],
    upiIntent: false,
    upiQr: true,
    qrCodes: false,
    ...overrides,
  };
}

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
}

/**
 * `getPaymentMethods` (and `describe`/`methodFor`'s data) sits behind a
 * page-lifetime cache (`pageCache` in `services/api/cache.ts`): once resolved,
 * every later caller in the same module graph gets the same cached promise.
 * Each test therefore gets a fresh module registry so its own `/payments/methods`
 * registration is the one actually read.
 */
async function load() {
  vi.resetModules();
  return (await import("./PaymentMethods")).PaymentMethods;
}

describe("PaymentMethods", () => {
  beforeEach(() => {
    setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
  });

  describe("loading and failure", () => {
    it("shows placeholders while the methods are loading", async () => {
      api.get("/payments/methods", () => new Promise(() => undefined));
      const PaymentMethods = await load();
      const { container } = renderUI(<PaymentMethods onPay={vi.fn()} isPaying={false} total="₹999" />);
      expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    });

    it("shows a message when the methods can't be loaded", async () => {
      api.get("/payments/methods", fail(500));
      const PaymentMethods = await load();
      renderUI(<PaymentMethods onPay={vi.fn()} isPaying={false} total="₹999" />);
      expect(await screen.findByText("We could not load the payment options. Please refresh the page.")).toBeInTheDocument();
    });

    it("shows a message when nothing is available", async () => {
      api.get("/payments/methods", methods({ methods: [] }));
      const PaymentMethods = await load();
      renderUI(<PaymentMethods onPay={vi.fn()} isPaying={false} total="₹999" />);
      expect(await screen.findByText(/No payment method is available/)).toBeInTheDocument();
    });
  });

  describe("UPI on a desktop", () => {
    it("offers a QR code when the account supports it", async () => {
      api.get("/payments/methods", methods({ upiIntent: false, upiQr: true }));
      const PaymentMethods = await load();
      const onPay = vi.fn();
      const { user } = renderUI(<PaymentMethods onPay={onPay} isPaying={false} total="₹999" />);
      await user.click(await screen.findByRole("button", { name: /^UPI/ }));
      expect(screen.getByText("Scan a QR code with any UPI app")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Show a QR code to scan" }));
      expect(onPay).toHaveBeenCalledWith({ kind: "upi-qr" });
    });

    it("explains UPI apps need a phone when neither intent nor QR work on this device", async () => {
      api.get("/payments/methods", methods({ upiIntent: true, upiQr: false }));
      const PaymentMethods = await load();
      const { user } = renderUI(<PaymentMethods onPay={vi.fn()} isPaying={false} total="₹999" />);
      await user.click(await screen.findByRole("button", { name: /^UPI/ }));
      expect(screen.getByText(/UPI apps can be used when you pay from your phone/)).toBeInTheDocument();
    });

    it("says UPI isn't available when the account offers neither rail", async () => {
      api.get("/payments/methods", methods({ upiIntent: false, upiQr: false }));
      const PaymentMethods = await load();
      const { user } = renderUI(<PaymentMethods onPay={vi.fn()} isPaying={false} total="₹999" />);
      await user.click(await screen.findByRole("button", { name: /^UPI/ }));
      expect(screen.getByText(/UPI isn't available right now/)).toBeInTheDocument();
    });
  });

  describe("UPI on a phone", () => {
    it("offers app buttons and reports the tapped app", async () => {
      setUserAgent("Mozilla/5.0 (Linux; Android 13)");
      api.get("/payments/methods", methods({ upiIntent: true, upiQr: false }));
      const PaymentMethods = await load();
      const onPay = vi.fn();
      const { user } = renderUI(<PaymentMethods onPay={onPay} isPaying={false} total="₹999" />);
      await user.click(await screen.findByRole("button", { name: /^UPI/ }));
      expect(screen.getByText(/Google Pay, PhonePe, Paytm and any other UPI app/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Google Pay" }));
      expect(onPay).toHaveBeenCalledWith(expect.objectContaining({ kind: "upi-intent", app: "gpay" }));
    });

    it("offers 'any other UPI app' only on Android", async () => {
      setUserAgent("Mozilla/5.0 (Linux; Android 13)");
      api.get("/payments/methods", methods({ upiIntent: true }));
      const PaymentMethods = await load();
      const onPay = vi.fn();
      const { user } = renderUI(<PaymentMethods onPay={onPay} isPaying={false} total="₹999" />);
      await user.click(await screen.findByRole("button", { name: /^UPI/ }));
      await user.click(screen.getByRole("button", { name: "Any other UPI app" }));
      expect(onPay).toHaveBeenCalledOnce();
      const call = onPay.mock.calls[0]![0] as { kind: string; app?: string };
      expect(call.kind).toBe("upi-intent");
      expect(call.app).toBeUndefined();
    });

    it("omits 'any other UPI app' on iPhone", async () => {
      setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)");
      api.get("/payments/methods", methods({ upiIntent: true }));
      const PaymentMethods = await load();
      const { user } = renderUI(<PaymentMethods onPay={vi.fn()} isPaying={false} total="₹999" />);
      await user.click(await screen.findByRole("button", { name: /^UPI/ }));
      expect(screen.queryByRole("button", { name: "Any other UPI app" })).not.toBeInTheDocument();
    });
  });

  describe("scan to pay (QR Codes product)", () => {
    it("shows its own panel when qrCodes is enabled", async () => {
      api.get("/payments/methods", methods({ methods: ["qr"], qrCodes: true }));
      const PaymentMethods = await load();
      const onPay = vi.fn();
      const { user } = renderUI(<PaymentMethods onPay={onPay} isPaying={false} total="₹499" />);
      await user.click(await screen.findByRole("button", { name: /^Scan to pay/ }));
      await user.click(screen.getByRole("button", { name: "Show QR code · Pay ₹499" }));
      expect(onPay).toHaveBeenCalledWith({ kind: "upi-qr" });
    });

    it("is absent when the methods list omits it even if qrCodes is true", async () => {
      api.get("/payments/methods", methods({ methods: ["card"], qrCodes: true }));
      const PaymentMethods = await load();
      renderUI(<PaymentMethods onPay={vi.fn()} isPaying={false} total="₹499" />);
      await screen.findByRole("button", { name: /Credit or debit card/ });
      expect(screen.queryByRole("button", { name: /^Scan to pay/ })).not.toBeInTheDocument();
    });
  });

  describe("card", () => {
    it("pays with the given container selector", async () => {
      api.get("/payments/methods", methods());
      const PaymentMethods = await load();
      const onPay = vi.fn();
      const { user } = renderUI(<PaymentMethods onPay={onPay} isPaying={false} total="₹999" cardContainer="#card-el" />);
      await user.click(await screen.findByRole("button", { name: /Credit or debit card/ }));
      await user.click(screen.getByRole("button", { name: "Continue to secure card entry" }));
      expect(onPay).toHaveBeenCalledWith({ kind: "card", container: "#card-el" });
    });
  });

  describe("net banking", () => {
    it("filters the bank list and pays with the chosen bank", async () => {
      api.get("/payments/methods", methods());
      const PaymentMethods = await load();
      const onPay = vi.fn();
      const { user } = renderUI(<PaymentMethods onPay={onPay} isPaying={false} total="₹999" />);
      await user.click(await screen.findByRole("button", { name: /Net banking/ }));
      expect(screen.getByRole("radio", { name: "HDFC Bank" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Pay ₹999 at your bank/ })).toBeDisabled();

      await user.type(screen.getByLabelText("Search for your bank"), "icici");
      expect(screen.queryByRole("radio", { name: "HDFC Bank" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("radio", { name: "ICICI Bank" }));
      const pay = screen.getByRole("button", { name: /Pay ₹999 at your bank/ });
      expect(pay).toBeEnabled();
      await user.click(pay);
      expect(onPay).toHaveBeenCalledWith({ kind: "netbanking", bank: "icici" });
    });

    it("says no bank matches an unknown search", async () => {
      api.get("/payments/methods", methods());
      const PaymentMethods = await load();
      const { user } = renderUI(<PaymentMethods onPay={vi.fn()} isPaying={false} total="₹999" />);
      await user.click(await screen.findByRole("button", { name: /Net banking/ }));
      await user.type(screen.getByLabelText("Search for your bank"), "zzz");
      expect(screen.getByText("No bank matches “zzz”.")).toBeInTheDocument();
    });
  });

  describe("wallet", () => {
    it("requires a wallet to be chosen before paying", async () => {
      api.get("/payments/methods", methods());
      const PaymentMethods = await load();
      const onPay = vi.fn();
      const { user } = renderUI(<PaymentMethods onPay={onPay} isPaying={false} total="₹999" />);
      await user.click(await screen.findByRole("button", { name: /Wallet/ }));
      const pay = screen.getByRole("button", { name: /Pay ₹999 with your wallet/ });
      expect(pay).toBeDisabled();
      await user.click(screen.getByRole("radio", { name: "Paytm Wallet" }));
      expect(pay).toBeEnabled();
      await user.click(pay);
      expect(onPay).toHaveBeenCalledWith({ kind: "wallet", wallet: "paytm" });
    });
  });

  describe("cash on delivery", () => {
    it("places the order, showing a spinner while isPaying", async () => {
      api.get("/payments/methods", methods());
      const PaymentMethods = await load();
      const onPay = vi.fn();
      const { user, rerender } = renderUI(<PaymentMethods onPay={onPay} isPaying={false} total="₹999" />);
      await user.click(await screen.findByRole("button", { name: /Cash on delivery/ }));
      await user.click(screen.getByRole("button", { name: "Place order · ₹999" }));
      expect(onPay).toHaveBeenCalledWith({ kind: "cod" });

      rerender(<PaymentMethods onPay={onPay} isPaying total="₹999" />);
      expect(screen.getByRole("button", { name: /Placing order…/ })).toBeDisabled();
    });

    it("explains COD isn't available for this PIN code instead of offering it", async () => {
      api.get("/payments/methods", methods());
      const PaymentMethods = await load();
      renderUI(<PaymentMethods onPay={vi.fn()} isPaying={false} total="₹999" codUnavailable />);
      expect(await screen.findByText(/Cash on delivery isn.t available for your delivery PIN code/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Cash on delivery/ })).not.toBeInTheDocument();
    });
  });

  describe("accordion behaviour", () => {
    it("opens one panel at a time", async () => {
      api.get("/payments/methods", methods());
      const PaymentMethods = await load();
      const { user } = renderUI(<PaymentMethods onPay={vi.fn()} isPaying={false} total="₹999" />);
      const upi = await screen.findByRole("button", { name: /^UPI/ });
      const card = screen.getByRole("button", { name: /Credit or debit card/ });

      await user.click(upi);
      expect(upi).toHaveAttribute("aria-expanded", "true");
      await user.click(card);
      expect(card).toHaveAttribute("aria-expanded", "true");
      expect(upi).toHaveAttribute("aria-expanded", "false");

      await user.click(card);
      expect(card).toHaveAttribute("aria-expanded", "false");
    });

    it("disables every pay action while isPaying, across panels", async () => {
      api.get("/payments/methods", methods());
      const PaymentMethods = await load();
      const { user } = renderUI(<PaymentMethods onPay={vi.fn()} isPaying total="₹999" />);
      await user.click(await screen.findByRole("button", { name: /^UPI/ }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Show a QR code to scan" })).toBeDisabled());
    });
  });

  describe("describe() and methodFor()", () => {
    it("summarises each choice and maps it to an order-level method", async () => {
      const { describe: describeChoice, methodFor } = await import("./PaymentMethods");
      const m = methods();
      expect(describeChoice({ kind: "upi-intent", app: "gpay" }, m)).toBe("Google Pay");
      expect(describeChoice({ kind: "upi-intent" }, m)).toBe("UPI app");
      expect(describeChoice({ kind: "upi-qr" }, m)).toBe("Scan to pay");
      expect(describeChoice({ kind: "upi-vpa", vpa: "a@bank" }, m)).toBe("a@bank");
      expect(describeChoice({ kind: "upi-vpa", vpa: "" }, m)).toBe("UPI ID");
      expect(describeChoice({ kind: "card" }, m)).toBe("Card");
      expect(describeChoice({ kind: "netbanking", bank: "hdfc" }, m)).toBe("HDFC Bank");
      expect(describeChoice({ kind: "netbanking", bank: "unknown" }, m)).toBe("Net banking");
      expect(describeChoice({ kind: "netbanking", bank: "hdfc" }, null)).toBe("Net banking");
      expect(describeChoice({ kind: "wallet", wallet: "paytm" }, m)).toBe("Paytm Wallet");
      expect(describeChoice({ kind: "wallet", wallet: "unknown" }, m)).toBe("Wallet");
      expect(describeChoice({ kind: "cod" }, m)).toBe("Cash on delivery");

      expect(methodFor({ kind: "upi-intent" })).toBe("upi");
      expect(methodFor({ kind: "upi-qr" })).toBe("upi");
      expect(methodFor({ kind: "upi-vpa", vpa: "" })).toBe("upi");
      expect(methodFor({ kind: "card" })).toBe("card");
      expect(methodFor({ kind: "netbanking", bank: "hdfc" })).toBe("netbanking");
      expect(methodFor({ kind: "wallet", wallet: "paytm" })).toBe("wallet");
      expect(methodFor({ kind: "cod" })).toBe("cod");
    });
  });
});
