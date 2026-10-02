import { describe, expect, it, vi } from "vitest";

import { renderUI, screen } from "@/test/render";
import { makeBundle } from "@/test/sliceD-cart-fixtures";

import { CartBundleRow } from "./CartBundleRow";

function setup(overrides: Parameters<typeof makeBundle>[0] = {}) {
  const onQuantityChange = vi.fn();
  const onRemove = vi.fn();
  const bundle = makeBundle(overrides);
  const view = renderUI(
    <ul>
      <CartBundleRow bundle={bundle} onQuantityChange={onQuantityChange} onRemove={onRemove} />
    </ul>,
  );
  return { ...view, bundle, onQuantityChange, onRemove };
}

describe("CartBundleRow", () => {
  describe("rendering", () => {
    it("shows the name linked to the bundle page and every component with its variant", () => {
      setup();
      expect(screen.getByText("Bundle")).toBeInTheDocument();
      const links = screen.getAllByRole("link", { name: "Summer Set" });
      expect(links).toHaveLength(2);
      for (const link of links) expect(link).toHaveAttribute("href", "/bundles/summer-set");
      expect(screen.getByText("Linen Shirt · M · White")).toBeInTheDocument();
      expect(screen.getByText("2 × Shorts")).toBeInTheDocument();
    });

    it("prices the set and shows the saving and the struck regular price", () => {
      setup({ quantity: 2, unitPrice: 150000, regularUnitPrice: 200000, lineTotal: 300000 });
      expect(screen.getByText("₹3,000")).toBeInTheDocument();
      expect(screen.getByText("₹4,000")).toHaveClass("line-through");
      expect(screen.getByText("You save ₹1,000")).toBeInTheDocument();
      expect(screen.getByText("₹1,500 each")).toBeInTheDocument();
    });

    it("shows no saving and no per-unit price for a single full-price bundle", () => {
      setup({ quantity: 1, unitPrice: 200000, regularUnitPrice: 200000, lineTotal: 200000 });
      expect(screen.getByText("₹2,000")).toBeInTheDocument();
      expect(screen.queryByText(/You save/)).not.toBeInTheDocument();
      expect(screen.queryByText(/each/)).not.toBeInTheDocument();
    });

    it("shows the problem instead of the saving when the bundle can't be bought", () => {
      setup({ problem: "Shorts is sold out" });
      expect(screen.getByText("Shorts is sold out")).toBeInTheDocument();
      expect(screen.queryByText(/You save/)).not.toBeInTheDocument();
    });
  });

  describe("quantity", () => {
    it("increases and decreases by one, passing the bag entry id", async () => {
      const { user, onQuantityChange } = setup({ quantity: 2 });
      await user.click(screen.getByRole("button", { name: "Increase quantity" }));
      expect(onQuantityChange).toHaveBeenLastCalledWith(7, 3);
      await user.click(screen.getByRole("button", { name: "Decrease quantity" }));
      expect(onQuantityChange).toHaveBeenLastCalledWith(7, 1);
    });

    it("caps at the per-order limit when it is lower than what's available", () => {
      setup({ quantity: 5, maxPerOrder: 5, available: 10 });
      expect(screen.getByRole("spinbutton", { name: "Quantity" })).toHaveAttribute("aria-valuemax", "5");
      expect(screen.getByRole("button", { name: "Increase quantity" })).toBeDisabled();
    });

    it("caps at what's available when it is lower than the per-order limit", () => {
      setup({ quantity: 2, maxPerOrder: 5, available: 2 });
      expect(screen.getByRole("spinbutton", { name: "Quantity" })).toHaveAttribute("aria-valuemax", "2");
      expect(screen.getByRole("button", { name: "Increase quantity" })).toBeDisabled();
    });

    it("never lets the ceiling fall below one, and can't decrease below one", () => {
      setup({ quantity: 1, available: 0 });
      expect(screen.getByRole("spinbutton", { name: "Quantity" })).toHaveAttribute("aria-valuemax", "1");
      expect(screen.getByRole("button", { name: "Decrease quantity" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Increase quantity" })).toBeDisabled();
    });
  });

  it("removes the bundle by entry id and name", async () => {
    const { user, onRemove } = setup();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalledWith(7, "Summer Set");
  });
});
