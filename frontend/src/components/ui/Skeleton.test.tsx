import { describe, expect, it } from "vitest";

import { renderUI, screen } from "@/test/render";

import { ProductCardSkeleton, ProductGridSkeleton, Skeleton } from "./Skeleton";

describe("Skeleton", () => {
  it("is hidden from assistive tech and takes a class", () => {
    const { container } = renderUI(<Skeleton className="h-4" />);
    expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
    expect(container.firstChild).toHaveClass("h-4", "bg-cream-deep");
  });

  it("ProductCardSkeleton draws an image block and three text lines", () => {
    const { container } = renderUI(<ProductCardSkeleton />);
    expect(container.querySelectorAll("[aria-hidden='true']")).toHaveLength(4);
    expect(container.querySelector(".aspect-\\[3\\/4\\]")).not.toBeNull();
  });

  describe("ProductGridSkeleton", () => {
    it("renders eight busy cards by default", () => {
      renderUI(<ProductGridSkeleton />);
      const grid = screen.getByLabelText("Loading products");
      expect(grid).toHaveAttribute("aria-busy", "true");
      expect(grid.children).toHaveLength(8);
    });

    it.each([0, 1, 24])("renders %i cards when asked", (count) => {
      renderUI(<ProductGridSkeleton count={count} />);
      expect(screen.getByLabelText("Loading products").children).toHaveLength(count);
    });
  });
});
