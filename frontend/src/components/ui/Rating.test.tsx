import { describe, expect, it } from "vitest";

import { renderUI, screen } from "@/test/render";

import { Rating } from "./Rating";

function fills(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[style]")).map((el) => el.style.width);
}

describe("Rating", () => {
  describe("accessible label", () => {
    it("announces the value and the review count", () => {
      renderUI(<Rating value={4.5} reviewCount={128} />);
      expect(screen.getByLabelText("Rated 4.5 out of 5 from 128 reviews")).toBeInTheDocument();
      expect(screen.getByText("4.5")).toBeInTheDocument();
      expect(screen.getByText("(128)")).toBeInTheDocument();
    });

    it("omits the count from the label when it is zero but still shows (0)", () => {
      renderUI(<Rating value={0} reviewCount={0} />);
      expect(screen.getByLabelText("Rated 0 out of 5")).toBeInTheDocument();
      expect(screen.getByText("(0)")).toBeInTheDocument();
      expect(screen.getByText("0.0")).toBeInTheDocument();
    });

    it("has no count when none is given and can hide the value", () => {
      renderUI(<Rating value={3} showValue={false} />);
      expect(screen.getByLabelText("Rated 3 out of 5")).toBeInTheDocument();
      expect(screen.queryByText("3.0")).not.toBeInTheDocument();
      expect(screen.queryByText(/\(/)).not.toBeInTheDocument();
    });
  });

  describe("stars", () => {
    it.each([
      [0, []],
      [1, ["100%"]],
      [2.5, ["100%", "100%", "50%"]],
      [5, ["100%", "100%", "100%", "100%", "100%"]],
    ])("fills stars for %s", (value, expected) => {
      const { container } = renderUI(<Rating value={value} />);
      expect(fills(container)).toEqual(expected);
    });

    it.each([
      [-2, "Rated 0 out of 5", 0],
      [9, "Rated 5 out of 5", 5],
    ])("clamps %s into range", (value, label, filled) => {
      const { container } = renderUI(<Rating value={value} />);
      expect(screen.getByLabelText(label)).toBeInTheDocument();
      expect(fills(container)).toHaveLength(filled);
    });

    it("uses larger stars at md size and formats large counts", () => {
      const { container } = renderUI(<Rating value={4} size="md" reviewCount={12500} className="r" />);
      expect(container.querySelector("svg")).toHaveClass("h-4", "w-4");
      expect(container.firstChild).toHaveClass("r");
      expect(screen.getByText(/^\(.+\)$/).textContent).not.toBe("(12500)");
    });
  });
});
