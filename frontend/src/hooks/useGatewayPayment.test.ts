import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GatewayHandoff } from "@/types";

import { useToastStore } from "@/store/toastStore";

import { useGatewayPayment } from "./useGatewayPayment";

/**
 * Razorpay's own SDK and our thin service wrappers around it are genuinely
 * external integrations — see the rule for `html-to-image`/payment SDK
 * scripts — so they are mocked here. What this file tests is the hook's own
 * state machine: which stage each outcome lands on, what gets toasted, and
 * that cleanup (closing a QR, stopping a listener) actually runs.
 */
vi.mock("@/services/payments/paymentGatewayService", () => ({
  createQr: vi.fn(),
  pollQr: vi.fn(),
  closeQr: vi.fn(),
  verifyPayment: vi.fn(),
}));
vi.mock("@/services/payments/razorpayCheckout", () => ({
  openRazorpayCheckout: vi.fn(),
}));
vi.mock("@/services/payments/razorpayCustom", () => ({
  startCustomPayment: vi.fn(),
}));

import { closeQr, createQr, pollQr, verifyPayment } from "@/services/payments/paymentGatewayService";
import { openRazorpayCheckout } from "@/services/payments/razorpayCheckout";
import { startCustomPayment } from "@/services/payments/razorpayCustom";

const HANDOFF: GatewayHandoff = {
  provider: "razorpay",
  keyId: "key_test",
  orderReference: "order_1",
  paymentId: "PAY1",
  amount: 10000,
  currency: "INR",
  name: "Daily Choice Zone",
  email: "a@b.com",
  phone: "9999999999",
  description: "Order #1",
  expiresAt: null,
  secondsLeft: 300,
} as unknown as GatewayHandoff;

const lastToast = () => useToastStore.getState().toasts.at(-1)?.message;

describe("useGatewayPayment", () => {
  describe("cod", () => {
    it("resolves to paid immediately, without calling any gateway", async () => {
      const { result } = renderHook(() => useGatewayPayment());
      const outcome = await act(() => result.current.pay(HANDOFF, { kind: "cod" }));
      expect(outcome).toBe("paid");
      expect(openRazorpayCheckout).not.toHaveBeenCalled();
      expect(startCustomPayment).not.toHaveBeenCalled();
    });
  });

  describe("card", () => {
    it("opens Standard Checkout restricted to card, then confirms on success", async () => {
      vi.mocked(openRazorpayCheckout).mockResolvedValue({
        status: "completed",
        response: { razorpayPaymentId: "pay_1", razorpayOrderId: "order_1", razorpaySignature: "sig" },
      });
      vi.mocked(verifyPayment).mockResolvedValue({ status: "paid" });

      const { result } = renderHook(() => useGatewayPayment());
      const outcome = await act(() => result.current.pay(HANDOFF, { kind: "card", container: "#card" }));

      expect(outcome).toBe("paid");
      expect(openRazorpayCheckout).toHaveBeenCalledWith(
        HANDOFF,
        expect.objectContaining({ container: "#card", only: "card" }),
      );
      expect(verifyPayment).toHaveBeenCalledWith("PAY1", { razorpayPaymentId: "pay_1", razorpayOrderId: "order_1", razorpaySignature: "sig" });
      expect(lastToast()).toBe("Payment received");
      expect(result.current.stage).toBe("choosing");
    });

    it("reports abandoned and toasts when the shopper closes the sheet themselves", async () => {
      vi.mocked(openRazorpayCheckout).mockResolvedValue({ status: "dismissed" });
      const { result } = renderHook(() => useGatewayPayment());
      const outcome = await act(() => result.current.pay(HANDOFF, { kind: "card" }));
      expect(outcome).toBe("abandoned");
      expect(lastToast()).toBe("Payment cancelled. Your order is saved — you can pay any time.");
    });

    it("reports failed and toasts the processor's reason", async () => {
      vi.mocked(openRazorpayCheckout).mockResolvedValue({ status: "failed", reason: "Card declined" });
      const { result } = renderHook(() => useGatewayPayment());
      const outcome = await act(() => result.current.pay(HANDOFF, { kind: "card" }));
      expect(outcome).toBe("failed");
      expect(lastToast()).toBe("Card declined");
    });

    it("falls back to a generic message when opening the window itself throws", async () => {
      vi.mocked(openRazorpayCheckout).mockRejectedValue(new Error(""));
      const { result } = renderHook(() => useGatewayPayment());
      const outcome = await act(() => result.current.pay(HANDOFF, { kind: "card" }));
      expect(outcome).toBe("failed");
      expect(lastToast()).toBe("We couldn't open the payment window. Please try again.");
    });

    it("confirm() reports failed, without calling it a lost payment, when verification itself fails", async () => {
      vi.mocked(openRazorpayCheckout).mockResolvedValue({
        status: "completed",
        response: { razorpayPaymentId: "p", razorpayOrderId: "o", razorpaySignature: "s" },
      });
      vi.mocked(verifyPayment).mockRejectedValue(new Error(""));
      const { result } = renderHook(() => useGatewayPayment());
      const outcome = await act(() => result.current.pay(HANDOFF, { kind: "card" }));
      expect(outcome).toBe("failed");
      expect(lastToast()).toContain("please do not pay again");
    });
  });

  describe("upi-intent / upi-vpa / netbanking / wallet (custom checkout)", () => {
    it("maps an intent choice to the upi/intent selection", async () => {
      vi.mocked(startCustomPayment).mockResolvedValue(vi.fn());
      const { result } = renderHook(() => useGatewayPayment());
      act(() => {
        void result.current.pay(HANDOFF, { kind: "upi-intent", app: "gpay", tappedAt: 123 });
      });
      await waitFor(() => expect(startCustomPayment).toHaveBeenCalled());
      expect(startCustomPayment).toHaveBeenCalledWith(
        HANDOFF,
        { method: "upi", flow: "intent", app: "gpay", tappedAt: 123 },
        expect.any(Function),
      );
      expect(result.current.stage).toBe("waiting");
    });

    it("maps a vpa choice to the upi/collect selection", async () => {
      vi.mocked(startCustomPayment).mockResolvedValue(vi.fn());
      const { result } = renderHook(() => useGatewayPayment());
      act(() => {
        void result.current.pay(HANDOFF, { kind: "upi-vpa", vpa: "name@bank" });
      });
      await waitFor(() =>
        expect(startCustomPayment).toHaveBeenCalledWith(HANDOFF, { method: "upi", flow: "collect", vpa: "name@bank" }, expect.any(Function)),
      );
    });

    it("maps a netbanking choice", async () => {
      vi.mocked(startCustomPayment).mockResolvedValue(vi.fn());
      const { result } = renderHook(() => useGatewayPayment());
      act(() => {
        void result.current.pay(HANDOFF, { kind: "netbanking", bank: "HDFC" });
      });
      await waitFor(() =>
        expect(startCustomPayment).toHaveBeenCalledWith(HANDOFF, { method: "netbanking", bank: "HDFC" }, expect.any(Function)),
      );
    });

    it("maps a wallet choice", async () => {
      vi.mocked(startCustomPayment).mockResolvedValue(vi.fn());
      const { result } = renderHook(() => useGatewayPayment());
      act(() => {
        void result.current.pay(HANDOFF, { kind: "wallet", wallet: "paytm" });
      });
      await waitFor(() =>
        expect(startCustomPayment).toHaveBeenCalledWith(HANDOFF, { method: "wallet", wallet: "paytm" }, expect.any(Function)),
      );
    });

    it("shows a QR event, then confirms on the final response event", async () => {
      let emit!: (event: Parameters<Parameters<typeof startCustomPayment>[2]>[0]) => void;
      vi.mocked(startCustomPayment).mockImplementation(async (_h, _s, onEvent) => {
        emit = onEvent;
        return vi.fn();
      });
      vi.mocked(verifyPayment).mockResolvedValue({ status: "paid" });

      const { result } = renderHook(() => useGatewayPayment());
      let pending: Promise<string> | undefined;
      act(() => {
        pending = result.current.pay(HANDOFF, { kind: "upi-vpa", vpa: "a@b" });
      });
      await waitFor(() => expect(startCustomPayment).toHaveBeenCalled());

      act(() => emit({ type: "qr", qr: "data:image/png;base64,xyz" }));
      expect(result.current.qr).toBe("data:image/png;base64,xyz");

      act(() => emit({ type: "waiting", message: "Approve in your app" }));
      expect(result.current.message).toBe("Approve in your app");

      await act(async () => {
        emit({ type: "success", response: { razorpayPaymentId: "p", razorpayOrderId: "o", razorpaySignature: "s" } });
        await pending;
      });
      expect(await pending).toBe("paid");
      expect(verifyPayment).toHaveBeenCalledWith("PAY1", { razorpayPaymentId: "p", razorpayOrderId: "o", razorpaySignature: "s" });
    });

    it("resets and toasts on an error event", async () => {
      let emit!: (event: Parameters<Parameters<typeof startCustomPayment>[2]>[0]) => void;
      vi.mocked(startCustomPayment).mockImplementation(async (_h, _s, onEvent) => {
        emit = onEvent;
        return vi.fn();
      });
      const { result } = renderHook(() => useGatewayPayment());
      let pending: Promise<string> | undefined;
      act(() => {
        pending = result.current.pay(HANDOFF, { kind: "upi-vpa", vpa: "a@b" });
      });
      await waitFor(() => expect(startCustomPayment).toHaveBeenCalled());

      act(() => emit({ type: "error", reason: "UPI app not found" }));
      expect(await pending).toBe("failed");
      expect(lastToast()).toBe("UPI app not found");
      expect(result.current.stage).toBe("choosing");
    });

    it("exposes tap-to-open and opening it clears the prompt", async () => {
      let emit!: (event: Parameters<Parameters<typeof startCustomPayment>[2]>[0]) => void;
      vi.mocked(startCustomPayment).mockImplementation(async (_h, _s, onEvent) => {
        emit = onEvent;
        return vi.fn();
      });
      const { result } = renderHook(() => useGatewayPayment());
      act(() => {
        void result.current.pay(HANDOFF, { kind: "upi-intent" });
      });
      await waitFor(() => expect(startCustomPayment).toHaveBeenCalled());

      const open = vi.fn();
      act(() => emit({ type: "tap-to-open", appName: "GPay", open }));
      expect(result.current.tapToOpen?.appName).toBe("GPay");

      act(() => result.current.tapToOpen?.open());
      expect(open).toHaveBeenCalledOnce();
      expect(result.current.tapToOpen).toBeNull();
    });

    it("cancel() stops the listener and resolves the pending pay() as abandoned", async () => {
      const stop = vi.fn();
      vi.mocked(startCustomPayment).mockResolvedValue(stop);
      const { result } = renderHook(() => useGatewayPayment());
      let pending: Promise<string> | undefined;
      act(() => {
        pending = result.current.pay(HANDOFF, { kind: "upi-intent" });
      });
      await waitFor(() => expect(startCustomPayment).toHaveBeenCalled());

      act(() => result.current.cancel());
      expect(await pending).toBe("abandoned");
      expect(stop).toHaveBeenCalledOnce();
      expect(result.current.stage).toBe("choosing");
    });

    it("toasts a generic message when starting the payment throws", async () => {
      vi.mocked(startCustomPayment).mockRejectedValue(new Error(""));
      const { result } = renderHook(() => useGatewayPayment());
      const outcome = await act(() => result.current.pay(HANDOFF, { kind: "upi-intent" }));
      expect(outcome).toBe("failed");
      expect(lastToast()).toBe("The payment could not be started.");
    });
  });

  describe("upi-qr", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("mints a code, polls, and resolves paid once the gateway reports a scan", async () => {
      vi.mocked(createQr).mockResolvedValue({ id: "qr1", imageUrl: "https://x/qr.png", amount: 10000, status: "created" });
      vi.mocked(pollQr).mockResolvedValueOnce({ status: "created", paid: false }).mockResolvedValueOnce({ status: "paid", paid: true });

      const { result } = renderHook(() => useGatewayPayment());
      let pending: Promise<string> | undefined;
      act(() => {
        pending = result.current.pay(HANDOFF, { kind: "upi-qr" });
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(result.current.qr).toBe("https://x/qr.png");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });

      expect(await pending).toBe("paid");
      expect(lastToast()).toBe("Payment received");
    });

    it("toasts and reports failed when the code cannot be minted", async () => {
      vi.mocked(createQr).mockRejectedValue(new Error("No QR for you"));
      const { result } = renderHook(() => useGatewayPayment());
      const outcome = await act(() => result.current.pay(HANDOFF, { kind: "upi-qr" }));
      expect(outcome).toBe("failed");
      expect(lastToast()).toBe("No QR for you");
    });

    it("closes the code and reports abandoned when the shopper cancels before scanning", async () => {
      vi.mocked(createQr).mockResolvedValue({ id: "qr1", imageUrl: "https://x/qr.png", amount: 10000, status: "created" });
      vi.mocked(pollQr).mockResolvedValue({ status: "created", paid: false });
      vi.mocked(closeQr).mockResolvedValue({ closed: true });

      const { result } = renderHook(() => useGatewayPayment());
      let pending: Promise<string> | undefined;
      act(() => {
        pending = result.current.pay(HANDOFF, { kind: "upi-qr" });
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      act(() => result.current.cancel());
      expect(await pending).toBe("abandoned");
      expect(closeQr).toHaveBeenCalledWith("PAY1", "qr1");
    });
  });

  describe("expire()", () => {
    it("stops the active payment and shows the expiry message", async () => {
      const stop = vi.fn();
      vi.mocked(startCustomPayment).mockResolvedValue(stop);
      const { result } = renderHook(() => useGatewayPayment());
      act(() => {
        void result.current.pay(HANDOFF, { kind: "upi-intent" });
      });
      await waitFor(() => expect(startCustomPayment).toHaveBeenCalled());

      act(() => result.current.expire());
      expect(result.current.stage).toBe("expired");
      expect(result.current.message).toContain("time to pay ran out");
      expect(stop).toHaveBeenCalledOnce();
    });
  });

  describe("isPaying", () => {
    it("is false while choosing or expired, true in every other stage", async () => {
      const { result } = renderHook(() => useGatewayPayment());
      expect(result.current.isPaying).toBe(false);
      act(() => result.current.expire());
      expect(result.current.isPaying).toBe(false);
    });
  });

  describe("unmount", () => {
    it("stops whatever payment was in flight", async () => {
      const stop = vi.fn();
      vi.mocked(startCustomPayment).mockResolvedValue(stop);
      const { result, unmount } = renderHook(() => useGatewayPayment());
      act(() => {
        void result.current.pay(HANDOFF, { kind: "upi-intent" });
      });
      await waitFor(() => expect(startCustomPayment).toHaveBeenCalled());
      unmount();
      expect(stop).toHaveBeenCalledOnce();
    });
  });
});
