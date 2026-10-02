import { describe, expect, it } from "vitest";

import { renderUI, screen, within } from "@/test/render";
import { makeBreakdown, makeTotals } from "@/test/sliceD-cart-fixtures";

import { OrderSummary } from "./OrderSummary";

/** The value printed next to a row label in the breakdown list. */
function rowValue(label: string | RegExp): string {
  const term = screen.getByText(label, { selector: "dt" });
  return term.nextElementSibling?.textContent ?? "";
}

function grandTotal(): string {
  const label = screen.getByText("Grand total");
  return label.nextElementSibling?.textContent ?? "";
}

describe("OrderSummary", () => {
  describe("the bill", () => {
    it("prints subtotal, shipping and grand total from the breakdown (paise → rupees)", () => {
      renderUI(
        <OrderSummary
          breakdown={makeBreakdown({ itemCount: 3, subtotal: 249900, shipping: 9900, grandTotal: 259800 })}
          totals={makeTotals()}
        />,
      );
      expect(screen.getByRole("heading", { name: "Order summary" })).toBeInTheDocument();
      expect(rowValue("Subtotal (3 items)")).toBe("₹2,499");
      expect(rowValue("Shipping")).toBe("₹99");
      expect(grandTotal()).toBe("₹2,598");
    });

    it("uses the singular for one item and says Free for zero shipping", () => {
      renderUI(<OrderSummary breakdown={makeBreakdown({ itemCount: 1, shipping: 0 })} totals={makeTotals()} />);
      expect(rowValue("Subtotal (1 item)")).toBe("₹1,000");
      expect(rowValue("Shipping")).toBe("Free");
    });

    it("lists product, coupon and member discounts and the total saving", () => {
      renderUI(
        <OrderSummary
          breakdown={makeBreakdown({
            subtotal: 300000,
            productDiscount: 50000,
            couponDiscount: 30000,
            couponCode: "SAVE10",
            memberDiscount: 10000,
            grandTotal: 260000,
          })}
          totals={makeTotals()}
        />,
      );
      expect(rowValue("Product discount")).toBe("− ₹500");
      expect(rowValue("Coupon discount (SAVE10)")).toBe("− ₹300");
      expect(rowValue("Member savings")).toBe("− ₹100");
      expect(grandTotal()).toBe("₹2,600");
      // The saving line counts product and coupon discounts only.
      expect(screen.getByText("You are saving ₹800 on this order.")).toBeInTheDocument();
    });

    it("shows a coupon discount without a code", () => {
      renderUI(<OrderSummary breakdown={makeBreakdown({ couponDiscount: 5000 })} totals={makeTotals()} />);
      expect(rowValue("Coupon discount")).toBe("− ₹50");
      expect(screen.getByText("You are saving ₹50 on this order.")).toBeInTheDocument();
    });

    it("has no discount rows and no saving line when nothing is discounted", () => {
      renderUI(<OrderSummary breakdown={makeBreakdown()} totals={makeTotals()} />);
      expect(screen.queryByText("Product discount")).not.toBeInTheDocument();
      expect(screen.queryByText(/Coupon discount/)).not.toBeInTheDocument();
      expect(screen.queryByText(/You are saving/)).not.toBeInTheDocument();
    });

    it("shows other charges only when there are some", () => {
      renderUI(<OrderSummary breakdown={makeBreakdown({ otherCharges: 4900 })} totals={makeTotals()} />);
      expect(rowValue("Other charges")).toBe("₹49");
    });
  });

  describe("tax", () => {
    const tax = { mode: "intra-state" as const, taxableAmount: 84746, cgst: 7627, sgst: 7627, igst: 0, totalTax: 15254, ratePercent: 18 };

    it("shows a single 'Tax (included)' line by default for tax-inclusive prices", () => {
      renderUI(<OrderSummary breakdown={makeBreakdown({ tax })} totals={makeTotals()} />);
      expect(rowValue("Tax (included)")).toBe("₹153");
      expect(screen.queryByText(/CGST/)).not.toBeInTheDocument();
    });

    it("labels tax without '(included)' when prices exclude it", () => {
      renderUI(<OrderSummary breakdown={makeBreakdown({ tax, pricesIncludeTax: false })} totals={makeTotals()} />);
      expect(rowValue("Tax")).toBe("₹153");
    });

    it("splits CGST / SGST when detailedTax is on for an intra-state order", () => {
      renderUI(<OrderSummary breakdown={makeBreakdown({ tax })} totals={makeTotals()} detailedTax />);
      expect(rowValue("Taxable value")).toBe("₹847");
      expect(rowValue("CGST (9%)")).toBe("₹76");
      expect(rowValue("SGST (9%)")).toBe("₹76");
    });

    it("shows IGST for an inter-state order with detailedTax", () => {
      renderUI(
        <OrderSummary
          breakdown={makeBreakdown({ tax: { ...tax, mode: "inter-state", cgst: 0, sgst: 0, igst: 15254 } })}
          totals={makeTotals()}
          detailedTax
        />,
      );
      expect(rowValue("IGST (18%)")).toBe("₹153");
    });

    it("prints a fractional half-rate for odd rates", () => {
      renderUI(<OrderSummary breakdown={makeBreakdown({ tax: { ...tax, ratePercent: 5 } })} totals={makeTotals()} detailedTax />);
      expect(screen.getByText("CGST (2.50%)")).toBeInTheDocument();
    });

    it("omits tax rows when no tax is charged", () => {
      renderUI(<OrderSummary breakdown={makeBreakdown()} totals={makeTotals()} detailedTax />);
      expect(screen.queryByText(/Tax|GST|Taxable/)).not.toBeInTheDocument();
    });
  });

  describe("free delivery nudge", () => {
    it("nudges while delivery is charged and the shortfall is reachable", () => {
      renderUI(
        <OrderSummary breakdown={makeBreakdown({ shipping: 9900 })} totals={makeTotals({ freeDeliveryShortfall: 249, itemCount: 2 })} />,
      );
      expect(screen.getByText("Add ₹249 more to get free delivery.")).toBeInTheDocument();
    });

    it.each([
      ["no shortfall", { freeDeliveryShortfall: 0, itemCount: 2 }, 9900],
      ["an empty bag", { freeDeliveryShortfall: 999, itemCount: 0 }, 9900],
      ["delivery already free (coupon / membership)", { freeDeliveryShortfall: 249, itemCount: 2 }, 0],
    ])("does not nudge with %s", (_name, totals, shipping) => {
      renderUI(<OrderSummary breakdown={makeBreakdown({ shipping })} totals={makeTotals(totals)} />);
      expect(screen.queryByText(/more to get free delivery/)).not.toBeInTheDocument();
    });
  });

  describe("layout props", () => {
    it("renders children above the figures and applies a className", () => {
      const { container } = renderUI(
        <OrderSummary breakdown={makeBreakdown()} totals={makeTotals()} className="custom-panel">
          <p>Delivering to 560001</p>
        </OrderSummary>,
      );
      const panel = container.firstElementChild as HTMLElement;
      expect(panel).toHaveClass("custom-panel");
      expect(within(panel).getByText("Delivering to 560001")).toBeInTheDocument();
      const childPos = screen.getByText("Delivering to 560001").compareDocumentPosition(screen.getByText("Grand total"));
      expect(childPos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });
});
