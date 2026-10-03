import { describe, expect, it, vi } from "vitest";

import type { ResolvedCartLine } from "@/types";
import { api } from "@/test/api";
import { renderUI, screen, waitFor } from "@/test/render";
import { makeLine, makeProduct, signInCustomer } from "@/test/sliceD-cart-fixtures";
import { useToastStore } from "@/store/toastStore";
import { useWishlistStore } from "@/store/wishlistStore";

import { CartLineRow } from "./CartLineRow";

function setup(line: ResolvedCartLine = makeLine()) {
  const onQuantityChange = vi.fn();
  const onRemove = vi.fn();
  const view = renderUI(
    <ul>
      <CartLineRow line={line} onQuantityChange={onQuantityChange} onRemove={onRemove} />
    </ul>,
  );
  return { ...view, onQuantityChange, onRemove };
}

describe("CartLineRow", () => {
  describe("rendering", () => {
    it("shows category, name, brand, variant and links to the product", () => {
      setup(makeLine({ size: "L", color: "Navy" }));
      expect(screen.getByText("Casual shirts")).toBeInTheDocument();
      expect(screen.getByText("Daily Choice")).toBeInTheDocument();
      expect(screen.getByText("Size: L")).toBeInTheDocument();
      expect(screen.getByText("Colour: Navy")).toBeInTheDocument();
      for (const link of screen.getAllByRole("link", { name: "Linen Shirt" })) {
        expect(link).toHaveAttribute("href", "/product/P1");
      }
    });

    it("links to the chosen colourway when the product comes in several", () => {
      const product = makeProduct({
        colors: [
          { name: "Navy", hex: "#000080", images: ["/img/navy.jpg"] },
          { name: "Sky Blue", hex: "#87ceeb" },
        ],
      });
      const { container } = setup(makeLine({ product, color: "Sky Blue" }));
      expect(screen.getAllByRole("link", { name: "Linen Shirt" })[0]).toHaveAttribute("href", "/product/P1?color=Sky%20Blue");
      // Sky Blue has no photographs of its own, so the shared images stand in.
      expect(container.querySelector("img")).toHaveAttribute("src", "/img/p1.jpg");
    });

    it("shows the colour's own photograph", () => {
      const product = makeProduct({ colors: [{ name: "Navy", hex: "#000080", images: ["/img/navy.jpg"] }, { name: "Red", hex: "#f00" }] });
      const { container } = setup(makeLine({ product, color: "Navy" }));
      expect(container.querySelector("img")).toHaveAttribute("src", "/img/navy.jpg");
    });

    it("omits size and colour when the line has neither", () => {
      setup(makeLine());
      expect(screen.queryByText(/Size:/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Colour:/)).not.toBeInTheDocument();
    });
  });

  describe("price", () => {
    it("shows the line total and the unit price for more than one", () => {
      setup(makeLine({ product: makeProduct({ price: 799, originalPrice: 799 }), quantity: 3 }));
      expect(screen.getByText("₹2,397")).toBeInTheDocument();
      expect(screen.getByText("₹799 each")).toBeInTheDocument();
    });

    it("shows no per-unit price for a single item", () => {
      setup(makeLine({ quantity: 1 }));
      expect(screen.queryByText(/each/)).not.toBeInTheDocument();
    });

    it("strikes through the list total when the line is discounted", () => {
      setup(makeLine({ product: makeProduct({ price: 800, originalPrice: 1000 }), quantity: 2 }));
      expect(screen.getByText("₹1,600")).toBeInTheDocument();
      expect(screen.getByText("₹2,000")).toHaveClass("line-through");
      // showDiscount is off in the bag.
      expect(screen.queryByText(/% off/)).not.toBeInTheDocument();
    });

    it("does not strike anything at full price", () => {
      setup(makeLine());
      expect(document.querySelector(".line-through")).toBeNull();
    });

    it("labels a flash sale price", () => {
      setup(makeLine({ product: makeProduct({ flashSale: {
        saleId: 1, itemId: 1, name: "Midnight Sale", price: 700, regularPrice: 1000, startsAt: "", endsAt: "",
        stockLimit: null, remaining: null, perCustomerLimit: null, allowCoupons: true,
      } }) }));
      expect(screen.getByText("Midnight Sale: flash sale price")).toBeInTheDocument();
    });
  });

  describe("stock", () => {
    it.each([
      [0, "Out of stock — remove to check out"],
      [-3, "Out of stock — remove to check out"],
      [1, "Only 1 left"],
      [5, "Only 5 left"],
    ])("stock %i shows “%s”", (stock, text) => {
      setup(makeLine({ product: makeProduct({ stock }) }));
      expect(screen.getByText(text)).toBeInTheDocument();
    });

    it("says nothing about stock above five", () => {
      setup(makeLine({ product: makeProduct({ stock: 6 }) }));
      expect(screen.queryByText(/left|Out of stock/)).not.toBeInTheDocument();
    });
  });

  describe("quantity", () => {
    it("increases and decreases, passing the stock as the ceiling", async () => {
      const { user, onQuantityChange } = setup(makeLine({ quantity: 2, product: makeProduct({ stock: 4 }) }));
      await user.click(screen.getByRole("button", { name: "Increase quantity" }));
      expect(onQuantityChange).toHaveBeenLastCalledWith("L1", 3, 4);
      await user.click(screen.getByRole("button", { name: "Decrease quantity" }));
      expect(onQuantityChange).toHaveBeenLastCalledWith("L1", 1, 4);
    });

    it("won't go above the live stock", () => {
      setup(makeLine({ quantity: 3, product: makeProduct({ stock: 3 }) }));
      expect(screen.getByRole("spinbutton", { name: "Quantity" })).toHaveAttribute("aria-valuemax", "3");
      expect(screen.getByRole("button", { name: "Increase quantity" })).toBeDisabled();
    });

    it("won't go below one (removal is a separate action)", () => {
      setup(makeLine({ quantity: 1 }));
      expect(screen.getByRole("button", { name: "Decrease quantity" })).toBeDisabled();
    });

    it("keeps a ceiling of one for an out-of-stock line", () => {
      setup(makeLine({ quantity: 1, product: makeProduct({ stock: 0 }) }));
      expect(screen.getByRole("spinbutton", { name: "Quantity" })).toHaveAttribute("aria-valuemax", "1");
      expect(screen.getByRole("button", { name: "Increase quantity" })).toBeDisabled();
    });
  });

  describe("remove and save", () => {
    it("removes the line by id with the product name", async () => {
      const { user, onRemove } = setup();
      await user.click(screen.getByRole("button", { name: "Remove" }));
      expect(onRemove).toHaveBeenCalledWith("L1", "Linen Shirt");
    });

    it("saves a guest's item to the local wishlist, then un-saves it", async () => {
      const { user } = setup();
      const save = screen.getByRole("button", { name: "Wishlist" });
      expect(save).toHaveAttribute("aria-pressed", "false");

      await user.click(save);
      expect(screen.getByRole("button", { name: "In wishlist" })).toHaveAttribute("aria-pressed", "true");
      expect(useWishlistStore.getState().productIds).toContain("P1");
      expect(useToastStore.getState().toasts.at(-1)?.message).toBe("Linen Shirt saved to wishlist");
      // A guest's save never reaches the server.
      expect(api.requests("POST", /^\/wishlist/)).toHaveLength(0);

      await user.click(screen.getByRole("button", { name: "In wishlist" }));
      expect(useWishlistStore.getState().productIds).not.toContain("P1");
      expect(useToastStore.getState().toasts.at(-1)?.message).toBe("Linen Shirt removed from wishlist");
    });

    it("saves a signed-in shopper's item on the server", async () => {
      signInCustomer();
      api.get("/wishlist/ids", []);
      api.post("/wishlist/P1", ["P1"]);
      const { user } = setup();
      await waitFor(() => expect(api.requests("GET", "/wishlist/ids")).toHaveLength(1));
      await user.click(screen.getByRole("button", { name: "Wishlist" }));
      await waitFor(() => expect(api.last("POST", "/wishlist/P1")?.headers.authorization).toBe("Bearer test-token"));
    });
  });
});
