import { describe, expect, it } from "vitest";

import { renderUI, screen } from "@/test/render";

import { Price } from "./Price";

describe("Price", () => {
  describe("success cases", () => {
    it("shows the price, the struck original and the discount when reduced", () => {
      renderUI(<Price price={1299} originalPrice={1799} discount={28} />);
      expect(screen.getByText("₹1,299")).toBeInTheDocument();
      expect(screen.getByText("₹1,799")).toHaveClass("line-through");
      expect(screen.getByText("28% off")).toBeInTheDocument();
    });

    it("shows only the price when there is no original price", () => {
      const { container } = renderUI(<Price price={999} />);
      expect(screen.getByText("₹999")).toBeInTheDocument();
      expect(container.querySelector(".line-through")).toBeNull();
      expect(screen.queryByText(/off/)).not.toBeInTheDocument();
    });
  });

  describe("edge cases", () => {
    it.each([
      ["equal to", 1000],
      ["lower than", 800],
    ])("does not strike an original price %s the price", (_, original) => {
      const { container } = renderUI(<Price price={1000} originalPrice={original} discount={10} />);
      expect(container.querySelector(".line-through")).toBeNull();
      expect(screen.queryByText("10% off")).not.toBeInTheDocument();
    });

    it("hides the discount when asked, or when it is zero or missing", () => {
      const { rerender } = renderUI(<Price price={500} originalPrice={1000} discount={50} showDiscount={false} />);
      expect(screen.queryByText("50% off")).not.toBeInTheDocument();
      expect(screen.getByText("₹1,000")).toBeInTheDocument();
      rerender(<Price price={500} originalPrice={1000} discount={0} />);
      expect(screen.queryByText(/off/)).not.toBeInTheDocument();
      rerender(<Price price={500} originalPrice={1000} />);
      expect(screen.queryByText(/off/)).not.toBeInTheDocument();
    });

    it("formats zero, rounds paise and groups large amounts the Indian way", () => {
      const { rerender } = renderUI(<Price price={0} />);
      expect(screen.getByText("₹0")).toBeInTheDocument();
      rerender(<Price price={1299.6} />);
      expect(screen.getByText("₹1,300")).toBeInTheDocument();
      rerender(<Price price={12345678} />);
      expect(screen.getByText("₹1,23,45,678")).toBeInTheDocument();
    });

    it.each([
      ["sm", "text-[0.8125rem]"],
      ["md", "text-[0.9375rem]"],
      ["lg", "text-xl"],
    ] as const)("sizes the current price for %s", (size, cls) => {
      renderUI(<Price price={10} size={size} className="pp" />);
      expect(screen.getByText("₹10")).toHaveClass(cls);
      expect(screen.getByText("₹10").parentElement).toHaveClass("pp");
    });
  });
});
