import { describe, expect, it, vi } from "vitest";

import type { Coupon } from "@/types";
import { api, fail } from "@/test/api";
import { renderUI, screen, waitFor } from "@/test/render";

import { CouponForm } from "./CouponForm";

const SAVE10: Coupon = { code: "SAVE10", description: "10% off", type: "percent", value: 10, minSubtotal: 0 };

function setup(props: Partial<Parameters<typeof CouponForm>[0]> = {}) {
  const onApply = vi.fn(async () => undefined);
  const onRemove = vi.fn();
  const view = renderUI(<CouponForm applied={null} subtotal={1000} onApply={onApply} onRemove={onRemove} {...props} />);
  return { ...view, onApply, onRemove };
}

describe("CouponForm", () => {
  describe("entering a code", () => {
    it("keeps Apply disabled until a code is typed, upper-cases it, applies it and clears the field", async () => {
      api.get("/coupons", []);
      const { user, onApply } = setup();
      const input = screen.getByPlaceholderText("Coupon code");
      const apply = screen.getByRole("button", { name: "Apply" });
      expect(apply).toBeDisabled();

      await user.type(input, "save10");
      expect(input).toHaveValue("SAVE10");
      expect(apply).toBeEnabled();
      await user.click(apply);

      expect(onApply).toHaveBeenCalledWith("SAVE10");
      await waitFor(() => expect(input).toHaveValue(""));
    });

    it("ignores a code of only spaces", async () => {
      api.get("/coupons", []);
      const { user, onApply } = setup();
      await user.type(screen.getByPlaceholderText("Coupon code"), "   {enter}");
      expect(onApply).not.toHaveBeenCalled();
    });

    it("shows Checking… and blocks a second submit while a code is being checked", async () => {
      api.get("/coupons", []);
      // Callers (useCart) report a refused code by resolving { ok: false }, not by rejecting.
      let refuse: (result: unknown) => void = () => undefined;
      const onApply = vi.fn(() => new Promise((resolve) => { refuse = resolve; }));
      const { user } = renderUI(<CouponForm applied={null} subtotal={500} onApply={onApply} onRemove={vi.fn()} />);
      const input = screen.getByPlaceholderText("Coupon code");
      await user.type(input, "BAD");
      await user.click(screen.getByRole("button", { name: "Apply" }));
      expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
      refuse({ ok: false, reason: "Invalid code" });
      await waitFor(() => expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument());
    });
  });

  describe("available coupons", () => {
    it("loads the shopper's coupons with their token and offers to view them all", async () => {
      window.localStorage.setItem("dcz:auth-token", "cust");
      api.get("/coupons", [SAVE10]);
      setup();
      expect(await screen.findByRole("button", { name: /View all coupons \(1\)/ })).toBeInTheDocument();
      expect(api.last("GET", "/coupons")!.headers.authorization).toBe("Bearer cust");
    });

    it("shows nothing extra when the coupons can't be loaded", async () => {
      api.get("/coupons", fail(500));
      setup();
      await waitFor(() => expect(api.requests("GET", "/coupons")).toHaveLength(1));
      expect(screen.queryByRole("button", { name: /View all coupons/ })).not.toBeInTheDocument();
    });
  });

  describe("an applied coupon", () => {
    it("shows it with a remove button instead of the form", async () => {
      api.get("/coupons", [SAVE10]);
      const { user, onRemove } = setup({ applied: SAVE10 });
      expect(screen.getByText("SAVE10 applied")).toBeInTheDocument();
      expect(screen.queryByPlaceholderText("Coupon code")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Remove coupon SAVE10" }));
      expect(onRemove).toHaveBeenCalledOnce();
      expect(await screen.findByRole("button", { name: /See other coupons/ })).toBeInTheDocument();
    });
  });

  describe("a saved code that doesn't apply", () => {
    it("explains why and lets the shopper remove it", async () => {
      api.get("/coupons", []);
      const { user, onRemove } = setup({ pendingCode: "BIG500", error: "Add ₹200 more to use it." });
      expect(screen.getByRole("status")).toHaveTextContent("BIG500 isn’t applied: Add ₹200 more to use it.");
      await user.click(screen.getByRole("button", { name: "Remove" }));
      expect(onRemove).toHaveBeenCalledOnce();
    });

    it("says nothing when there is no reason given", () => {
      api.get("/coupons", []);
      setup({ pendingCode: "BIG500" });
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
  });
});
