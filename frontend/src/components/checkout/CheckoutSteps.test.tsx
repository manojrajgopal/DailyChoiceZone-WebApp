import { describe, expect, it } from "vitest";

import { setLocation } from "@/test/navigation";
import { renderUI, screen, within } from "@/test/render";

import { CHECKOUT_STEPS, CheckoutSteps } from "./CheckoutSteps";

function steps() {
  const nav = screen.getByRole("navigation", { name: "Checkout progress" });
  return within(nav).getAllByRole("listitem");
}

describe("CheckoutSteps", () => {
  it("lists the four steps in order, payment last", () => {
    expect(CHECKOUT_STEPS.map((step) => step.label)).toEqual(["Contact", "Delivery", "Review", "Payment"]);
    expect(CHECKOUT_STEPS.map((step) => step.href)).toEqual([
      "/checkout",
      "/checkout/address",
      "/checkout/review",
      "/checkout/payment",
    ]);
  });

  describe("the current step", () => {
    it.each([
      ["/checkout", 0],
      ["/checkout/address", 1],
      ["/checkout/review", 2],
      ["/checkout/payment", 3],
    ])("on %s marks step %i as current, links back to earlier steps and not ahead", (path, active) => {
      setLocation(path);
      renderUI(<CheckoutSteps />);
      const items = steps();
      expect(items).toHaveLength(4);

      items.forEach((item, index) => {
        const label = CHECKOUT_STEPS[index]!.label;
        expect(item).toHaveTextContent(label);
        const link = within(item).queryByRole("link");
        if (index < active) {
          expect(link).toHaveAttribute("href", CHECKOUT_STEPS[index]!.href);
          // A finished step shows a tick, not its number.
          expect(item).not.toHaveTextContent(String(index + 1));
        } else {
          expect(link).toBeNull();
          expect(item).toHaveTextContent(String(index + 1));
        }
      });

      const current = document.querySelectorAll('[aria-current="step"]');
      expect(current).toHaveLength(1);
      expect(current[0]).toHaveTextContent(CHECKOUT_STEPS[active]!.label);
    });

    it("has no back links on the first step", () => {
      setLocation("/checkout");
      renderUI(<CheckoutSteps />);
      expect(screen.queryAllByRole("link")).toHaveLength(0);
    });

    it("links back to all three earlier steps on payment", () => {
      setLocation("/checkout/payment?payment=PAY1");
      renderUI(<CheckoutSteps />);
      expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
        "/checkout",
        "/checkout/address",
        "/checkout/review",
      ]);
    });
  });

  describe("edge cases", () => {
    it.each(["/checkout/unknown", "/", "/checkout/address/extra"])(
      "treats an unrecognised path (%s) as the first step",
      (path) => {
        setLocation(path);
        renderUI(<CheckoutSteps />);
        expect(document.querySelector('[aria-current="step"]')).toHaveTextContent("Contact");
        expect(screen.queryAllByRole("link")).toHaveLength(0);
      },
    );
  });
});
