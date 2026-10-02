import { describe, expect, it, vi } from "vitest";

import { renderUI, screen } from "@/test/render";

import { Pagination, buildPageWindow } from "./Pagination";

describe("buildPageWindow", () => {
  it.each([
    [1, 0, []],
    [1, 1, [1]],
    [3, 5, [1, 2, 3, 4, 5]],
    [1, 7, [1, 2, 3, 4, 5, 6, 7]],
    [1, 8, [1, 2, 3, 4, 5, "gap", 8]],
    [4, 10, [1, 2, 3, 4, 5, "gap", 10]],
    [5, 10, [1, "gap", 4, 5, 6, "gap", 10]],
    [6, 10, [1, "gap", 5, 6, 7, "gap", 10]],
    [7, 10, [1, "gap", 6, 7, 8, 9, 10]],
    [10, 10, [1, "gap", 6, 7, 8, 9, 10]],
    [50, 100, [1, "gap", 49, 50, 51, "gap", 100]],
  ] as const)("page %i of %i is %j", (current, total, expected) => {
    expect(buildPageWindow(current, total)).toEqual(expected);
  });

  it("always yields seven entries once there are more than seven pages", () => {
    for (let page = 1; page <= 20; page += 1) {
      expect(buildPageWindow(page, 20)).toHaveLength(7);
    }
  });
});

describe("Pagination", () => {
  describe("rendering", () => {
    it.each([0, 1])("renders nothing for %i total pages", (totalPages) => {
      const { container } = renderUI(<Pagination page={1} totalPages={totalPages} onPageChange={vi.fn()} />);
      expect(container).toBeEmptyDOMElement();
    });

    it("marks the current page and shows the phone label", () => {
      renderUI(<Pagination page={2} totalPages={3} onPageChange={vi.fn()} className="mt-8" />);
      const nav = screen.getByRole("navigation", { name: "Pagination" });
      expect(nav).toHaveClass("mt-8");
      expect(screen.getByRole("button", { name: "Page 2" })).toHaveAttribute("aria-current", "page");
      expect(screen.getByRole("button", { name: "Page 1" })).not.toHaveAttribute("aria-current");
      expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
    });

    it("shows ellipses for long ranges", () => {
      renderUI(<Pagination page={6} totalPages={12} onPageChange={vi.fn()} />);
      expect(screen.getAllByText("…")).toHaveLength(2);
      expect(screen.getByRole("button", { name: "Page 12" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Page 3" })).not.toBeInTheDocument();
    });
  });

  describe("navigation", () => {
    it("disables Previous on the first page and Next on the last", () => {
      const { rerender } = renderUI(<Pagination page={1} totalPages={4} onPageChange={vi.fn()} />);
      expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
      rerender(<Pagination page={4} totalPages={4} onPageChange={vi.fn()} />);
      expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    });

    it("reports the previous, next and a chosen page", async () => {
      const onPageChange = vi.fn();
      const { user } = renderUI(<Pagination page={3} totalPages={5} onPageChange={onPageChange} />);
      await user.click(screen.getByRole("button", { name: "Previous page" }));
      await user.click(screen.getByRole("button", { name: "Next page" }));
      await user.click(screen.getByRole("button", { name: "Page 5" }));
      expect(onPageChange.mock.calls).toEqual([[2], [4], [5]]);
    });
  });
});
