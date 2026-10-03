import { describe, expect, it } from "vitest";

import { api, fail, hang } from "@/test/api";
import { renderUI, screen, waitFor } from "@/test/render";
import {
  makeBundle,
  makeProduct,
  makeServerCart,
  makeServerItem,
  signInCustomer,
} from "@/test/sliceD-cart-fixtures";
import { useCartStore } from "@/store/cartStore";

import { CartView } from "./CartView";

/**
 * The signed-in bag, at every `/cart…` read — and an empty "saved for later"
 * list, which the bag page reads too and which isn't a bag.
 */
function serveBag(cart: Parameters<typeof api.get>[1]) {
  api.get(/^\/cart/, cart);
  api.get("/cart/saved", { items: [], limit: 100 });
}

describe("CartView", () => {
  describe("guest, empty bag", () => {
    it("shows the empty state with a link back to the shop", async () => {
      renderUI(<CartView />);
      expect(await screen.findByText("Your bag is empty")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Start shopping" })).toHaveAttribute("href", "/shop");
      expect(screen.queryByText(/item(s)?$/)).not.toBeInTheDocument();
    });
  });

  describe("guest, with items", () => {
    it("resolves the staged line against the catalogue and shows it", async () => {
      const product = makeProduct({ id: "P1", name: "Linen Shirt", price: 1000 });
      api.get("/products/P1", product);
      useCartStore.getState().addItem({ productId: "P1", quantity: 2 });

      renderUI(<CartView />);
      expect(await screen.findByText("Linen Shirt")).toBeInTheDocument();
      expect(screen.getByText("2 items")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Proceed to checkout" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Continue shopping" })).toHaveAttribute("href", "/shop");
    });

    it("increments the guest line's quantity in the cart store", async () => {
      const product = makeProduct({ id: "P1", stock: 10 });
      api.get("/products/P1", product);
      useCartStore.getState().addItem({ productId: "P1", quantity: 1 });

      const { user } = renderUI(<CartView />);
      await screen.findByText(product.name);
      await user.click(screen.getByRole("button", { name: "Increase quantity" }));
      await waitFor(() => expect(useCartStore.getState().lines[0]?.quantity).toBe(2));
    });

    it("removes a guest line from the cart store", async () => {
      const product = makeProduct({ id: "P1" });
      api.get("/products/P1", product);
      useCartStore.getState().addItem({ productId: "P1", quantity: 1 });

      const { user } = renderUI(<CartView />);
      await screen.findByText(product.name);
      await user.click(screen.getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(useCartStore.getState().lines).toHaveLength(0));
      expect(await screen.findByText("Your bag is empty")).toBeInTheDocument();
    });

    it("validates a coupon code through the API and clears the field, though the guest total never shows it as applied", async () => {
      // BUG (src/hooks/useCart.ts, the guest branch of the `totals` useMemo):
      // guest totals always spread from EMPTY_TOTALS without setting
      // `appliedCoupon`, so `coupon` passed to CouponForm is always null for a
      // guest even after a successful apply (which does update the cart
      // store's `couponCode` and fire a success toast). The code only becomes
      // visibly "applied" once the shopper signs in and the server prices it.
      // This test documents today's behaviour, not the intended one.
      const product = makeProduct({ id: "P1", price: 2000 });
      api.get("/products/P1", product);
      useCartStore.getState().addItem({ productId: "P1", quantity: 1 });
      api.post("/coupons/validate", { valid: true, code: "SAVE10", type: "percent", value: 10, minSubtotal: 0, discount: 20000 });
      api.get("/coupons", []);

      const { user } = renderUI(<CartView />);
      await screen.findByText(product.name);
      const input = screen.getByPlaceholderText("Coupon code");
      await user.type(input, "save10");
      await user.click(screen.getByRole("button", { name: "Apply" }));

      await waitFor(() => expect(api.last("POST", "/coupons/validate")!.body).toMatchObject({ code: "SAVE10" }));
      await waitFor(() => expect(input).toHaveValue(""));
      expect(screen.queryByText("SAVE10 applied")).not.toBeInTheDocument();
      expect(useCartStore.getState().couponCode).toBe("SAVE10");
    });
  });

  describe("signed in", () => {
    it("blocks nothing while the cart is loading", async () => {
      signInCustomer();
      serveBag(hang());
      renderUI(<CartView />);
      expect(screen.getByRole("heading", { name: "Shopping bag" })).toBeInTheDocument();
      expect(screen.queryByText("Your bag is empty")).not.toBeInTheDocument();
      expect(screen.queryByText(/\d+ items?$/)).not.toBeInTheDocument();
    });

    it("shows server lines, bundles, the item count and a working checkout link", async () => {
      signInCustomer();
      const product = makeProduct({ id: "P1", name: "Linen Shirt" });
      serveBag(makeServerCart({
        items: [makeServerItem(1, product, 2)],
        bundles: [makeBundle()],
        breakdown: makeServerCart().breakdown,
      }));

      renderUI(<CartView />);
      expect(await screen.findByText("Linen Shirt")).toBeInTheDocument();
      expect(screen.getByText("Summer Set")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Proceed to checkout" })).toBeInTheDocument();
    });

    it("shows the empty state when the server cart has nothing", async () => {
      signInCustomer();
      serveBag(makeServerCart({ items: [] }));
      renderUI(<CartView />);
      expect(await screen.findByText("Your bag is empty")).toBeInTheDocument();
    });

    it("blocks checkout and explains when an item is out of stock", async () => {
      signInCustomer();
      const outOfStock = makeProduct({ id: "P1", name: "Sold Out Shirt", stock: 0 });
      serveBag(makeServerCart({ items: [makeServerItem(1, outOfStock, 1)] }));

      renderUI(<CartView />);
      await screen.findByText("Sold Out Shirt");
      expect(screen.getByRole("alert")).toHaveTextContent("One or more items in your bag are out of stock. Remove them to continue.");
      expect(screen.queryByRole("link", { name: "Proceed to checkout" })).not.toBeInTheDocument();
    });

    it("blocks checkout and lists each bag issue (e.g. a flash sale limit)", async () => {
      signInCustomer();
      const product = makeProduct({ id: "P1" });
      serveBag(makeServerCart({
        items: [makeServerItem(1, product, 1)],
        issues: [{ code: "FLASH_SALE_LIMIT", message: "Only 1 of this flash sale item per order.", productId: "P1" }],
      }));

      renderUI(<CartView />);
      await screen.findByText(product.name);
      expect(screen.getByRole("alert")).toHaveTextContent("Only 1 of this flash sale item per order.");
      expect(screen.queryByRole("link", { name: "Proceed to checkout" })).not.toBeInTheDocument();
    });

    it("shows the member perks note when the cart carries a membership", async () => {
      signInCustomer();
      const product = makeProduct({ id: "P1" });
      serveBag(makeServerCart({
        items: [makeServerItem(1, product, 1)],
        membership: { name: "Choice Circle", planName: "Annual", endsAt: "2027-01-01", discountPercent: 10, freeDelivery: true, freeDeliveriesLeft: 2 },
      }));

      renderUI(<CartView />);
      expect(await screen.findByText("Choice Circle member")).toBeInTheDocument();
    });

    it("falls back to an empty cart (and does not crash) when the server read fails", async () => {
      signInCustomer();
      serveBag(fail(500));
      renderUI(<CartView />);
      expect(await screen.findByText("Your bag is empty")).toBeInTheDocument();
    });
  });
});
