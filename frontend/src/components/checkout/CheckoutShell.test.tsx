import { describe, expect, it } from "vitest";

import type { OrderLine } from "@/types";
import { api } from "@/test/api";
import { setLocation, router } from "@/test/navigation";
import { renderUI, screen, waitFor, within } from "@/test/render";
import { makeBreakdown, makeProduct, makeServerCart, makeServerItem, makeTotals, signInCustomer } from "@/test/sliceD-cart-fixtures";

import { CheckoutShell, summaryLinesFromOrder, type CheckoutSummary } from "./CheckoutShell";

function orderLine(overrides: Partial<OrderLine> = {}): OrderLine {
  return {
    productId: "P1",
    name: "Linen Shirt",
    slug: "linen-shirt",
    image: "/img/shirt.jpg",
    brand: "Daily Choice",
    size: "M",
    color: "Blue",
    quantity: 2,
    unitPrice: 1000,
    lineTotal: 2000,
    ...overrides,
  };
}

describe("summaryLinesFromOrder", () => {
  it("maps each order line to a summary line, joining size and colour", () => {
    expect(summaryLinesFromOrder([orderLine()])).toEqual([
      { key: "P1-M-Blue-0", name: "Linen Shirt", image: "/img/shirt.jpg", detail: "M · Blue", quantity: 2, lineTotal: 2000 },
    ]);
  });

  it("falls back to the brand when there is no size or colour", () => {
    expect(summaryLinesFromOrder([orderLine({ size: null, color: null })])[0]?.detail).toBe("Daily Choice");
  });

  it("uses only the size, or only the colour, when just one is set", () => {
    expect(summaryLinesFromOrder([orderLine({ size: "M", color: null })])[0]?.detail).toBe("M");
    expect(summaryLinesFromOrder([orderLine({ size: null, color: "Blue" })])[0]?.detail).toBe("Blue");
  });

  it("keys lines by index so two identical variants both render", () => {
    const lines = summaryLinesFromOrder([orderLine(), orderLine()]);
    expect(lines.map((l) => l.key)).toEqual(["P1-M-Blue-0", "P1-M-Blue-1"]);
  });

  it("is empty for no lines", () => {
    expect(summaryLinesFromOrder([])).toEqual([]);
  });
});

describe("CheckoutShell", () => {
  describe("guest", () => {
    it("sends the shopper to sign in, with this page as next", async () => {
      setLocation("/checkout/address?step=1");
      renderUI(
        <CheckoutShell title="Delivery">
          <p>Body</p>
        </CheckoutShell>,
      );
      await waitFor(() =>
        expect(router.replace).toHaveBeenCalledWith(`/account?next=${encodeURIComponent("/checkout/address?step=1")}`),
      );
    });
  });

  describe("signed in, empty bag", () => {
    it("redirects to the bag", async () => {
      signInCustomer();
      api.get(/^\/cart/, makeServerCart({ items: [] }));
      renderUI(
        <CheckoutShell title="Delivery">
          <p>Body</p>
        </CheckoutShell>,
      );
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/cart"));
    });

    it("does not redirect when the guard is suppressed", async () => {
      signInCustomer();
      api.get(/^\/cart/, makeServerCart({ items: [] }));
      renderUI(
        <CheckoutShell title="Payment" suppressEmptyRedirect>
          <p>Body</p>
        </CheckoutShell>,
      );
      await screen.findByRole("heading", { name: "Payment" });
      expect(router.replace).not.toHaveBeenCalled();
    });
  });

  describe("signed in, with items", () => {
    it("shows the title, description, back link, children and the bag's lines", async () => {
      signInCustomer();
      const product = makeProduct({ id: "P1", name: "Linen Shirt" });
      api.get(/^\/cart/, makeServerCart({ items: [makeServerItem(1, product, 2)] }));

      renderUI(
        <CheckoutShell title="Delivery" description="Where should this go?">
          <p>Address form</p>
        </CheckoutShell>,
      );

      expect(screen.getByRole("heading", { name: "Delivery" })).toBeInTheDocument();
      expect(screen.getByText("Where should this go?")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Back to bag/ })).toHaveAttribute("href", "/cart");
      expect(screen.getByText("Address form")).toBeInTheDocument();
      expect(await screen.findByText("Linen Shirt")).toBeInTheDocument();
      expect(router.replace).not.toHaveBeenCalled();
    });

    it("shows the coupon form (compact) and the member perks note when there is no order summary override", async () => {
      signInCustomer();
      const product = makeProduct({ id: "P1" });
      api.get(/^\/cart/, makeServerCart({
        items: [makeServerItem(1, product, 1)],
        membership: { name: "Choice Circle", planName: "Annual", endsAt: "2027-01-01", discountPercent: 5, freeDelivery: true, freeDeliveriesLeft: null },
      }));
      api.get("/coupons", []);

      renderUI(<CheckoutShell title="Review"><p /></CheckoutShell>);
      expect(await screen.findByPlaceholderText("Coupon code")).toBeInTheDocument();
      expect(await screen.findByText("Choice Circle member")).toBeInTheDocument();
    });

    it("shows a skeleton instead of the order summary while the cart is loading", async () => {
      signInCustomer();
      api.get(/^\/cart/, () => new Promise(() => undefined));
      renderUI(<CheckoutShell title="Delivery"><p /></CheckoutShell>);
      expect(screen.queryByRole("heading", { name: "Order summary" })).not.toBeInTheDocument();
      // The coupon form and member note also wait for the cart to settle.
      expect(screen.queryByPlaceholderText("Coupon code")).not.toBeInTheDocument();
    });

    it("passes detailedTax through to the order summary", async () => {
      signInCustomer();
      const product = makeProduct({ id: "P1" });
      api.get(/^\/cart/, makeServerCart({
        items: [makeServerItem(1, product, 1)],
        breakdown: makeBreakdown({ tax: { mode: "intra-state", taxableAmount: 84746, cgst: 7627, sgst: 7627, igst: 0, totalTax: 15254, ratePercent: 18 } }),
      }));

      renderUI(<CheckoutShell title="Review" detailedTax><p /></CheckoutShell>);
      expect(await screen.findByText(/CGST \(9%\)/)).toBeInTheDocument();
    });
  });

  describe("with an order summary override (payment step)", () => {
    function summary(overrides: Partial<CheckoutSummary> = {}): CheckoutSummary {
      return {
        lines: summaryLinesFromOrder([orderLine()]),
        totals: makeTotals({ total: 2000 }),
        breakdown: makeBreakdown({ grandTotal: 200000 }),
        ...overrides,
      };
    }

    it("shows the order's own lines and totals instead of the (now empty) bag, with no coupon form or member note", async () => {
      signInCustomer();
      // The bag is genuinely empty once the order is placed; suppressEmptyRedirect keeps the page up.
      api.get(/^\/cart/, makeServerCart({ items: [] }));

      renderUI(
        <CheckoutShell title="Payment" suppressEmptyRedirect summary={summary()}>
          <p />
        </CheckoutShell>,
      );

      expect(await screen.findByText("Linen Shirt")).toBeInTheDocument();
      // The line price (₹2,000) and the grand total (from the override breakdown, also ₹2,000) both show.
      expect(screen.getAllByText("₹2,000")).toHaveLength(2);
      expect(screen.queryByPlaceholderText("Coupon code")).not.toBeInTheDocument();
      expect(router.replace).not.toHaveBeenCalled();
    });

    it("shows a skeleton while summary is null (order still loading)", async () => {
      signInCustomer();
      api.get(/^\/cart/, makeServerCart({ items: [] }));
      renderUI(
        <CheckoutShell title="Payment" suppressEmptyRedirect summary={null}>
          <p />
        </CheckoutShell>,
      );
      await waitFor(() => expect(api.requests("GET", /^\/cart/)).toHaveLength(1));
      expect(screen.queryByRole("heading", { name: "Order summary" })).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText("Coupon code")).not.toBeInTheDocument();
    });
  });

  describe("checkout steps", () => {
    it("renders the progress indicator for the current path", async () => {
      setLocation("/checkout/review");
      signInCustomer();
      api.get(/^\/cart/, makeServerCart({ items: [makeServerItem(1, makeProduct(), 1)] }));
      renderUI(<CheckoutShell title="Review"><p /></CheckoutShell>);
      const nav = screen.getByRole("navigation", { name: "Checkout progress" });
      expect(within(nav).getByText("Review")).toBeInTheDocument();
    });
  });
});
