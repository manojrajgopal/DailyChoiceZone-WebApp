import { describe, expect, it } from "vitest";

import type { SavedItem } from "@/services/discoveryService";
import { api, fail } from "@/test/api";
import { renderUI, screen, waitFor, within } from "@/test/render";
import { makeProduct, makeServerCart, makeServerItem, signInCustomer } from "@/test/sliceD-cart-fixtures";
import { useCartStore } from "@/store/cartStore";
import { useSavedForLaterStore } from "@/store/savedForLaterStore";
import { useToastStore } from "@/store/toastStore";

import { CartView } from "./CartView";

function savedItem(overrides: Partial<SavedItem> = {}): SavedItem {
  const product = overrides.product ?? makeProduct({ id: "P2", name: "Silk Scarf", sizes: [] });
  return {
    id: 7,
    productId: product.id,
    size: null,
    color: null,
    quantity: 1,
    savedAt: "2026-10-01T10:00:00",
    unitPrice: product.price * 100,
    savedUnitPrice: product.price * 100,
    priceDrop: null,
    priceRise: false,
    status: "available",
    message: "",
    maxQuantity: 10,
    canMoveToCart: true,
    inWishlist: false,
    product,
    ...overrides,
  };
}

function savedSection() {
  return screen.getByRole("region", { name: /Saved for later/ });
}

describe("Saved for later, on the bag page", () => {
  describe("signed in", () => {
    it("moves a bag line to saved and redraws both from one answer", async () => {
      signInCustomer();
      const shirt = makeProduct({ id: "P1", name: "Linen Shirt" });
      api.get(/^\/cart/, makeServerCart({ items: [makeServerItem(11, shirt, 2)] }));
      api.get("/cart/saved", { items: [], limit: 100 });
      api.post("/cart/items/11/save-for-later", {
        saved: { items: [savedItem({ product: shirt, productId: "P1", quantity: 2 })], limit: 100 },
        cart: makeServerCart({ items: [] }),
      });

      const { user } = renderUI(<CartView />);
      await screen.findByText("Linen Shirt");
      await user.click(screen.getByRole("button", { name: "Save for later" }));

      await waitFor(() => expect(within(savedSection()).getByText("Linen Shirt")).toBeInTheDocument());
      expect(within(savedSection()).getByText("Qty: 2")).toBeInTheDocument();
      expect(screen.getByText("Your bag is empty")).toBeInTheDocument();
      expect(api.last("POST", "/cart/items/11/save-for-later")?.headers.authorization).toBe("Bearer test-token");
    });

    it("moves a saved line back to the bag", async () => {
      signInCustomer();
      const scarf = makeProduct({ id: "P2", name: "Silk Scarf", sizes: [] });
      api.get(/^\/cart/, makeServerCart({ items: [] }));
      api.get("/cart/saved", { items: [savedItem()], limit: 100 });
      api.post("/cart/saved/7/move-to-cart", {
        saved: { items: [], limit: 100 },
        cart: makeServerCart({ items: [makeServerItem(12, scarf, 1)] }),
      });

      const { user } = renderUI(<CartView />);
      await user.click(await screen.findByRole("button", { name: "Move to bag" }));
      await waitFor(() => expect(screen.queryByRole("region", { name: /Saved for later/ })).not.toBeInTheDocument());
      expect(screen.getByText("Silk Scarf")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Proceed to checkout" })).toBeInTheDocument();
    });

    it("keeps an unavailable line saved and offers to be told when it's back", async () => {
      signInCustomer();
      api.get(/^\/cart/, makeServerCart({ items: [] }));
      api.get("/cart/saved", {
        items: [savedItem({ status: "out-of-stock", message: "Currently unavailable", canMoveToCart: false,
          maxQuantity: 0, product: makeProduct({ id: "P2", name: "Silk Scarf", stock: 0, sizes: [] }) })],
        limit: 100,
      });
      api.get(/^\/alerts/, { stock: [], price: null });
      renderUI(<CartView />);
      await screen.findByText("Silk Scarf");
      expect(within(savedSection()).getByText("Currently unavailable")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Move to bag" })).not.toBeInTheDocument();
      expect(within(savedSection()).getByRole("button", { name: /notify|tell me|back in stock/i })).toBeInTheDocument();
    });

    it("says the price dropped, from what to what", async () => {
      signInCustomer();
      api.get(/^\/cart/, makeServerCart({ items: [] }));
      api.get("/cart/saved", { items: [savedItem({ unitPrice: 80000, savedUnitPrice: 100000,
        priceDrop: { from: 100000, to: 80000 } })], limit: 100 });
      renderUI(<CartView />);
      expect(await screen.findByText("Price dropped from ₹1,000 to ₹800")).toBeInTheDocument();
    });

    it("explains a refused move and keeps the line", async () => {
      signInCustomer();
      api.get(/^\/cart/, makeServerCart({ items: [] }));
      api.get("/cart/saved", { items: [savedItem()], limit: 100 });
      api.post("/cart/saved/7/move-to-cart", fail(409, "Silk Scarf is currently unavailable. We'll keep it here for you.",
        "OUT_OF_STOCK"));
      const { user } = renderUI(<CartView />);
      await user.click(await screen.findByRole("button", { name: "Move to bag" }));
      await waitFor(() =>
        expect(useToastStore.getState().toasts.at(-1)?.message).toMatch(/We'll keep it here for you/));
      expect(within(savedSection()).getByText("Silk Scarf")).toBeInTheDocument();
    });

    it("asks before removing everything", async () => {
      signInCustomer();
      api.get(/^\/cart/, makeServerCart({ items: [] }));
      api.get("/cart/saved", { items: [savedItem()], limit: 100 });
      api.delete("/cart/saved", { items: [], limit: 100 });
      const { user } = renderUI(<CartView />);
      await user.click(await screen.findByRole("button", { name: "Remove all" }));
      const dialog = screen.getByRole("dialog", { name: "Remove every saved item?" });
      expect(api.requests("DELETE", "/cart/saved")).toHaveLength(0);
      await user.click(within(dialog).getByRole("button", { name: "Remove all" }));
      await waitFor(() => expect(api.requests("DELETE", "/cart/saved")).toHaveLength(1));
    });

    it("says so when the saved list can't be read", async () => {
      signInCustomer();
      api.get(/^\/cart/, makeServerCart({ items: [] }));
      api.get("/cart/saved", fail(500));
      renderUI(<CartView />);
      expect(await screen.findByText("We couldn't load your saved items.")).toBeInTheDocument();
    });
  });

  describe("signed out", () => {
    it("keeps a guest's saved line in the browser, then moves it back", async () => {
      const shirt = makeProduct({ id: "P1", name: "Linen Shirt", sizes: [] });
      api.get("/products/P1", shirt);
      useCartStore.getState().addItem({ productId: "P1", quantity: 2 });

      const { user } = renderUI(<CartView />);
      await user.click(await screen.findByRole("button", { name: "Save for later" }));

      expect(useCartStore.getState().lines).toHaveLength(0);
      expect(useSavedForLaterStore.getState().lines).toMatchObject([{ productId: "P1", quantity: 2 }]);
      await waitFor(() => expect(within(savedSection()).getByText("Linen Shirt")).toBeInTheDocument());
      // Nothing about a guest's saved list reaches the server.
      expect(api.requests("POST", /save-for-later/)).toHaveLength(0);

      await user.click(within(savedSection()).getByRole("button", { name: "Move to bag" }));
      expect(useSavedForLaterStore.getState().lines).toHaveLength(0);
      expect(useCartStore.getState().lines).toMatchObject([{ productId: "P1", quantity: 2 }]);
    });

    it("marks a guest's line whose size has gone", async () => {
      api.get("/products/P1", makeProduct({ id: "P1", name: "Linen Shirt", sizes: ["L"] }));
      useSavedForLaterStore.getState().save({ productId: "P1", size: "M" });
      renderUI(<CartView />);
      expect(await screen.findByText("This option is no longer available — choose another.")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Choose another option" })).toBeInTheDocument();
    });
  });
});
