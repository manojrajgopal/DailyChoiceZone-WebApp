import { describe, expect, it, vi } from "vitest";

import type { Coupon } from "@/types";
import { renderUI, screen, within } from "@/test/render";

import { CouponListDialog, couponBenefit, couponBlocker } from "./CouponListDialog";

function coupon(overrides: Partial<Coupon> = {}): Coupon {
  return { code: "SAVE10", description: "10% off your order", type: "percent", value: 10, minSubtotal: 0, ...overrides };
}

function setup(props: Partial<Parameters<typeof CouponListDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onApply = vi.fn();
  const view = renderUI(
    <CouponListDialog
      open
      onOpenChange={onOpenChange}
      coupons={props.coupons ?? [coupon()]}
      subtotal={props.subtotal ?? 1000}
      appliedCode={props.appliedCode ?? null}
      busy={props.busy ?? false}
      onApply={onApply}
    />,
  );
  return { ...view, onOpenChange, onApply };
}

describe("couponBenefit", () => {
  it.each([
    [coupon({ type: "free-shipping" }), "Free delivery"],
    [coupon({ type: "flat", value: 150 }), "₹150 off"],
    [coupon({ type: "percent", value: 10 }), "10% off"],
    [coupon({ type: "percent", value: 10, maxDiscount: 200 }), "10% off, up to ₹200"],
  ])("describes %j as %s", (c, text) => {
    expect(couponBenefit(c)).toBe(text);
  });
});

describe("couponBlocker", () => {
  it.each([
    [coupon({ soldOut: true }), 500, "All claimed"],
    [coupon({ perCustomerLimit: 1, timesUsed: 1 }), 500, "You've used this one"],
    [coupon({ perCustomerLimit: 2, timesUsed: 1 }), 500, null],
    [coupon({ minSubtotal: 1000 }), 500, "Add ₹500 more"],
    [coupon({ minSubtotal: 500 }), 500, null],
    [coupon(), 0, null],
  ])("for %j at subtotal %i returns %s", (c, subtotal, expected) => {
    expect(couponBlocker(c, subtotal)).toBe(expected);
  });
});

describe("CouponListDialog", () => {
  describe("empty", () => {
    it("says there are no coupons right now", () => {
      setup({ coupons: [] });
      expect(screen.getByText("No coupons right now — check back soon.")).toBeInTheDocument();
      expect(screen.getByText("0 offers you can use. Your bag: ₹1,000.")).toBeInTheDocument();
    });
  });

  describe("listing coupons", () => {
    it("shows the benefit, code, description, minimum order and end date", () => {
      setup({ coupons: [coupon({ minSubtotal: 500, endsAt: "2026-12-31" })] });
      expect(screen.getByText("10% off")).toBeInTheDocument();
      expect(screen.getByText("SAVE10")).toBeInTheDocument();
      expect(screen.getByText("10% off your order")).toBeInTheDocument();
      expect(screen.getByText("Minimum order ₹500")).toBeInTheDocument();
      expect(screen.getByText("Valid until 31 Dec 2026")).toBeInTheDocument();
    });

    it("says no minimum order and no end date when neither is set", () => {
      setup({ coupons: [coupon({ minSubtotal: 0, endsAt: null })] });
      expect(screen.getByText("No minimum order")).toBeInTheDocument();
      expect(screen.getByText("No end date")).toBeInTheDocument();
    });

    it("uses the singular 'offer' for exactly one coupon", () => {
      setup({ coupons: [coupon()] });
      expect(screen.getByText("1 offer you can use. Your bag: ₹1,000.")).toBeInTheDocument();
    });

    it.each([
      ["members", "Members only"],
      ["selected", "Just for you"],
      ["first-order", "First order only"],
    ] as const)("labels the %s audience as %s", (audience, label) => {
      setup({ coupons: [coupon({ audience })] });
      expect(screen.getByText(label)).toBeInTheDocument();
    });

    it("omits the audience line when none is set", () => {
      setup({ coupons: [coupon()] });
      expect(screen.queryByText("Members only")).not.toBeInTheDocument();
    });

    it.each([
      [1, "Usable once per customer"],
      [3, "Usable 3 times per customer"],
    ])("shows the usage limit (%i) without a used count when unknown", (limit, text) => {
      setup({ coupons: [coupon({ perCustomerLimit: limit })] });
      expect(screen.getByText(text)).toBeInTheDocument();
    });

    it("shows uses left when some remain", () => {
      setup({ coupons: [coupon({ perCustomerLimit: 3, timesUsed: 1 })] });
      expect(screen.getByText("Usable 3 times per customer — 2 uses left for you")).toBeInTheDocument();
    });

    it("shows a single use left in the singular", () => {
      setup({ coupons: [coupon({ perCustomerLimit: 3, timesUsed: 2 })] });
      expect(screen.getByText("Usable 3 times per customer — 1 use left for you")).toBeInTheDocument();
    });

    it("says the limit is used up rather than a negative number left", () => {
      setup({ coupons: [coupon({ perCustomerLimit: 2, timesUsed: 5 })] });
      expect(screen.getByText("Usable 2 times per customer — you've used it")).toBeInTheDocument();
    });

    it("omits the usage line when there is no per-customer limit", () => {
      setup({ coupons: [coupon({ perCustomerLimit: null })] });
      expect(screen.queryByText(/Usable/)).not.toBeInTheDocument();
    });

    it("omits the description paragraph when there is none", () => {
      setup({ coupons: [coupon({ description: "" })] });
      expect(screen.queryByText("10% off your order")).not.toBeInTheDocument();
    });
  });

  describe("applying", () => {
    it("applies a usable coupon by its code", async () => {
      const { user, onApply } = setup({ coupons: [coupon()] });
      await user.click(screen.getByRole("button", { name: "Apply" }));
      expect(onApply).toHaveBeenCalledWith("SAVE10");
    });

    it("disables Apply and explains why for a coupon below the minimum", () => {
      setup({ coupons: [coupon({ minSubtotal: 2000 })], subtotal: 500 });
      expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
      expect(screen.getByText("Add ₹1,500 more")).toBeInTheDocument();
    });

    it("shows Applied, disabled, for the currently-applied coupon and hides its blocker", () => {
      setup({ coupons: [coupon({ minSubtotal: 2000 })], subtotal: 500, appliedCode: "SAVE10" });
      const button = screen.getByRole("button", { name: "Applied" });
      expect(button).toBeDisabled();
      expect(screen.queryByText("Add ₹1,500 more")).not.toBeInTheDocument();
    });

    it("disables every Apply button while busy", () => {
      setup({ coupons: [coupon(), coupon({ code: "SAVE20" })], busy: true });
      for (const button of screen.getAllByRole("button", { name: "Apply" })) {
        expect(button).toBeDisabled();
      }
    });

    it("disables a sold-out coupon and shows why", () => {
      setup({ coupons: [coupon({ soldOut: true })] });
      expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
      expect(screen.getByText("All claimed")).toBeInTheDocument();
    });
  });

  describe("the dialog chrome", () => {
    it("is labelled, with each coupon as a list item", () => {
      setup({ coupons: [coupon(), coupon({ code: "SAVE20" })] });
      const dialog = screen.getByRole("dialog", { name: "Coupons for you" });
      expect(within(dialog).getAllByRole("listitem")).toHaveLength(2);
    });
  });
});
