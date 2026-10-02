import { describe, expect, it, vi } from "vitest";

import type { TenderPreview } from "@/services/walletService";
import { api, fail, networkError } from "@/test/api";
import { renderUI, screen, waitFor } from "@/test/render";

import { NO_TENDERS, TendersPanel } from "./TendersPanel";

function preview(overrides: Partial<TenderPreview> = {}): TenderPreview {
  return {
    grandTotal: 100000,
    giftCards: [],
    giftCardTotal: 0,
    storeCredit: { available: 0, applied: 0 },
    points: {
      enabled: false,
      available: 0,
      maxPoints: 0,
      reason: "",
      minRedeemPoints: 0,
      redeemPoints: 0,
      redeemValue: 0,
      applied: 0,
      value: 0,
    },
    tenderTotal: 0,
    amountDue: 100000,
    messages: [],
    ...overrides,
  };
}

function setup(props: Partial<Parameters<typeof TendersPanel>[0]> = {}) {
  const onChange = vi.fn();
  const view = renderUI(
    <TendersPanel
      couponCode={props.couponCode ?? null}
      deliveryMethod={props.deliveryMethod ?? "standard"}
      placeOfSupply={props.placeOfSupply ?? null}
      pincode={props.pincode ?? null}
      onChange={onChange}
      disabled={props.disabled}
    />,
  );
  return { ...view, onChange };
}

describe("TendersPanel", () => {
  describe("initial preview", () => {
    it("requests a preview on mount with the given context and no tenders, showing Checking… meanwhile", async () => {
      api.post("/checkout/tenders", preview());
      const { onChange } = setup({ couponCode: "SAVE10", deliveryMethod: "express", placeOfSupply: "Karnataka", pincode: "560001" });
      expect(screen.getByRole("status")).toHaveTextContent("Checking…");
      await waitFor(() => expect(onChange).toHaveBeenCalledWith(NO_TENDERS, preview()));
      expect(api.last("POST", "/checkout/tenders")!.body).toEqual({
        couponCode: "SAVE10",
        deliveryMethod: "express",
        placeOfSupply: "Karnataka",
        pincode: "560001",
        giftCardCodes: [],
        useStoreCredit: false,
        points: 0,
      });
      await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    });

    it("links to buying a gift card", async () => {
      api.post("/checkout/tenders", preview());
      setup();
      expect(screen.getByRole("link", { name: "Send one" })).toHaveAttribute("href", "/gift-cards");
    });

    it("shows nothing but the heading and form when the preview fails", async () => {
      api.post("/checkout/tenders", fail(500, "Could not price your order"));
      const { onChange } = setup();
      await waitFor(() => expect(onChange).toHaveBeenCalledWith(NO_TENDERS, null));
      expect(screen.getByText("Could not price your order")).toBeInTheDocument();
    });

    it("surfaces the API's own message for a network failure (it is still an ApiError)", async () => {
      api.post("/checkout/tenders", networkError());
      setup();
      expect(await screen.findByText("We couldn't connect just now. Please check your internet connection and try again.")).toBeInTheDocument();
    });

    it("falls back to a generic message for a non-API error (e.g. Next's own control-flow signal)", async () => {
      api.post("/checkout/tenders", networkError(Object.assign(new Error("DYNAMIC_SERVER_USAGE"), { digest: "DYNAMIC_SERVER_USAGE" })));
      setup();
      expect(await screen.findByText("We couldn't check that just now.")).toBeInTheDocument();
    });
  });

  describe("gift cards", () => {
    it("adds a code, re-requests the preview with it, and shows the applied card", async () => {
      api.post("/checkout/tenders", (req) =>
        req.body.giftCardCodes.length
          ? preview({ giftCards: [{ last4: "WXYZ", applied: 20000, balance: 30000, error: "" }], giftCardTotal: 20000, tenderTotal: 20000, amountDue: 80000 })
          : preview(),
      );
      const { user } = setup();
      await waitFor(() => expect(api.requests("POST", "/checkout/tenders")).toHaveLength(1));

      await user.type(screen.getByLabelText("Gift card code"), "DCZG-WXYZ");
      await user.click(screen.getByRole("button", { name: "Apply" }));

      expect(await screen.findByText(/Card ending WXYZ/)).toBeInTheDocument();
      expect(screen.getByText(/₹200 applied/)).toBeInTheDocument();
      expect(screen.getByLabelText("Gift card code")).toHaveValue("");
      expect(api.last("POST", "/checkout/tenders")!.body).toMatchObject({ giftCardCodes: ["DCZG-WXYZ"] });
    });

    it("does not add the same code twice", async () => {
      api.post("/checkout/tenders", preview());
      const { user } = setup();
      await waitFor(() => expect(api.requests("POST", "/checkout/tenders")).toHaveLength(1));
      const input = screen.getByLabelText("Gift card code");
      await user.type(input, "DUPE");
      await user.click(screen.getByRole("button", { name: "Apply" }));
      await user.type(input, "DUPE");
      await user.click(screen.getByRole("button", { name: "Apply" }));
      await waitFor(() => {
        const last = api.last("POST", "/checkout/tenders")!;
        expect(last.body.giftCardCodes).toEqual(["DUPE"]);
      });
    });

    it("disables Apply until something is typed, and ignores whitespace-only submission", async () => {
      api.post("/checkout/tenders", preview());
      const { user } = setup();
      expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
      const input = screen.getByLabelText("Gift card code");
      await user.type(input, "   ");
      // The button stays disabled for whitespace since code.trim() is empty.
      expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    });

    it("removes an applied gift card", async () => {
      api.post("/checkout/tenders", (req) =>
        req.body.giftCardCodes.length
          ? preview({ giftCards: [{ last4: "WXYZ", applied: 20000, balance: 30000, error: "" }], tenderTotal: 20000, amountDue: 80000 })
          : preview(),
      );
      const { user } = setup();
      await user.type(screen.getByLabelText("Gift card code"), "DCZG-WXYZ");
      await user.click(screen.getByRole("button", { name: "Apply" }));
      await screen.findByText(/Card ending WXYZ/);

      await user.click(screen.getByRole("button", { name: "Remove gift card ending WXYZ" }));
      await waitFor(() => expect(api.last("POST", "/checkout/tenders")!.body.giftCardCodes).toEqual([]));
      await waitFor(() => expect(screen.queryByText(/Card ending WXYZ/)).not.toBeInTheDocument());
    });

    it("reports a refused code, drops it from what's sent, and keeps good codes", async () => {
      let call = 0;
      api.post("/checkout/tenders", (req) => {
        call += 1;
        if (call === 1) return preview();
        // After BAD is added: refused, with a last4 derived from the code itself.
        if (req.body.giftCardCodes.includes("BAD1")) {
          return preview({ giftCards: [{ last4: "BAD1", applied: 0, balance: 0, error: "This card has expired." }] });
        }
        return preview();
      });
      const { user } = setup();
      await waitFor(() => expect(api.requests("POST", "/checkout/tenders")).toHaveLength(1));
      await user.type(screen.getByLabelText("Gift card code"), "BAD1");
      await user.click(screen.getByRole("button", { name: "Apply" }));

      expect(await screen.findByText("Gift card ending BAD1: This card has expired.")).toBeInTheDocument();
      await waitFor(() => {
        const last = api.last("POST", "/checkout/tenders")!;
        expect(last.body.giftCardCodes).toEqual([]);
      });
    });
  });

  describe("store credit", () => {
    it("is hidden when there is none available", async () => {
      api.post("/checkout/tenders", preview({ storeCredit: { available: 0, applied: 0 } }));
      setup();
      await waitFor(() => expect(api.requests("POST", "/checkout/tenders")).toHaveLength(1));
      expect(screen.queryByText(/Use store credit/)).not.toBeInTheDocument();
    });

    it("can be toggled on, shows what's applied, and resends the choice", async () => {
      api.post("/checkout/tenders", (req) =>
        preview({
          storeCredit: { available: 50000, applied: req.body.useStoreCredit ? 50000 : 0 },
          tenderTotal: req.body.useStoreCredit ? 50000 : 0,
          amountDue: req.body.useStoreCredit ? 50000 : 100000,
        }),
      );
      const { user } = setup();
      const checkbox = await screen.findByRole("checkbox", { name: /Use store credit \(₹500 available\)/ });
      expect(checkbox).not.toBeChecked();

      await user.click(checkbox);
      expect(checkbox).toBeChecked();
      expect(await screen.findByText("₹500 applied")).toBeInTheDocument();
      expect(api.last("POST", "/checkout/tenders")!.body).toMatchObject({ useStoreCredit: true });
    });
  });

  describe("reward points", () => {
    function withPoints(overrides: Partial<TenderPreview["points"]> = {}) {
      return preview({
        points: {
          enabled: true,
          available: 500,
          maxPoints: 300,
          reason: "",
          minRedeemPoints: 100,
          redeemPoints: 100,
          redeemValue: 10,
          applied: 0,
          value: 0,
          ...overrides,
        },
      });
    }

    it("is hidden entirely when there are none available", async () => {
      api.post("/checkout/tenders", preview({ points: { enabled: true, available: 0, maxPoints: 0, reason: "", minRedeemPoints: 0, redeemPoints: 0, redeemValue: 0, applied: 0, value: 0 } }));
      setup();
      await waitFor(() => expect(api.requests("POST", "/checkout/tenders")).toHaveLength(1));
      expect(screen.queryByText(/Reward points/)).not.toBeInTheDocument();
    });

    it("shows the reason instead of an input when points can't be redeemed yet", async () => {
      api.post("/checkout/tenders", withPoints({ maxPoints: 0, reason: "Earn 100 points to start redeeming." }));
      setup();
      expect(await screen.findByText("Earn 100 points to start redeeming.")).toBeInTheDocument();
      expect(screen.queryByLabelText("Points to use")).not.toBeInTheDocument();
    });

    it("applies a typed amount, use-maximum, and remove, each resending the selection", async () => {
      api.post("/checkout/tenders", (req) =>
        // `value` is money() input, i.e. minor units (paise): 200 points → ₹20 → 2000 paise.
        withPoints({ applied: req.body.points, value: req.body.points > 0 ? req.body.points * 10 : 0 }),
      );
      const { user } = setup();
      await screen.findByText(/500 available/);

      await user.type(screen.getByLabelText("Points to use"), "200");
      await user.click(screen.getAllByRole("button", { name: "Apply" }).at(-1)!);
      expect(await screen.findByText(/200 points applied — ₹20 off what you pay\./)).toBeInTheDocument();
      expect(api.last("POST", "/checkout/tenders")!.body).toMatchObject({ points: 200 });

      await user.click(screen.getByRole("button", { name: "Use maximum" }));
      await waitFor(() => expect(api.last("POST", "/checkout/tenders")!.body).toMatchObject({ points: 300 }));
      expect(screen.getByLabelText("Points to use")).toHaveValue(300);

      await user.click(screen.getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(api.last("POST", "/checkout/tenders")!.body).toMatchObject({ points: 0 }));
      expect(screen.queryByText(/points applied/)).not.toBeInTheDocument();
    });

    it("treats a non-numeric points entry as zero", async () => {
      api.post("/checkout/tenders", (req) => withPoints({ applied: req.body.points }));
      const { user } = setup();
      await screen.findByText(/500 available/);
      await user.type(screen.getByLabelText("Points to use"), "abc");
      await user.click(screen.getAllByRole("button", { name: "Apply" }).at(-1)!);
      await waitFor(() => expect(api.last("POST", "/checkout/tenders")!.body).toMatchObject({ points: 0 }));
    });
  });

  describe("the totals strip", () => {
    it("is shown only once some tender total is applied", async () => {
      api.post("/checkout/tenders", preview({ tenderTotal: 0 }));
      setup();
      await waitFor(() => expect(api.requests("POST", "/checkout/tenders")).toHaveLength(1));
      expect(screen.queryByText("Left to pay")).not.toBeInTheDocument();
    });

    it("shows order total, what's paid with tenders, and what's left", async () => {
      api.post("/checkout/tenders", preview({ grandTotal: 100000, tenderTotal: 30000, amountDue: 70000 }));
      setup();
      expect(await screen.findByText("Left to pay")).toBeInTheDocument();
      expect(screen.getByText("₹1,000")).toBeInTheDocument();
      expect(screen.getByText("− ₹300")).toBeInTheDocument();
      expect(screen.getByText("₹700")).toBeInTheDocument();
    });

    it("shows any server messages", async () => {
      api.post("/checkout/tenders", preview({ messages: ["Points can't be combined with this coupon."] }));
      setup();
      expect(await screen.findByText("Points can't be combined with this coupon.")).toBeInTheDocument();
    });
  });

  describe("disabled", () => {
    it("disables every control", async () => {
      api.post("/checkout/tenders", preview({ storeCredit: { available: 100, applied: 0 } }));
      setup({ disabled: true });
      await waitFor(() => expect(api.requests("POST", "/checkout/tenders")).toHaveLength(1));
      expect(screen.getByLabelText("Gift card code")).toBeDisabled();
      expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
      expect(await screen.findByRole("checkbox", { name: /Use store credit/ })).toBeDisabled();
    });
  });
});
