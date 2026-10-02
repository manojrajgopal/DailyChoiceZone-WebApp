import { describe, expect, it, vi } from "vitest";

import { renderUI, screen } from "@/test/render";

import { AdminPagination } from "./AdminPagination";

function setup(page: number, totalPages: number) {
  const onPageChange = vi.fn();
  const view = renderUI(<AdminPagination page={page} totalPages={totalPages} onPageChange={onPageChange} />);
  return { ...view, onPageChange };
}

describe("AdminPagination", () => {
  it.each([0, 1, -3])("renders nothing for %i total pages", (total) => {
    const { container } = setup(1, total);
    expect(container).toBeEmptyDOMElement();
  });

  it("disables Previous on the first page and moves forward", async () => {
    const { user, onPageChange } = setup(1, 3);
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Page 1" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Page 2" })).not.toHaveAttribute("aria-current");
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(onPageChange).toHaveBeenCalledWith(2);
    await user.click(screen.getByRole("button", { name: "Page 3" }));
    expect(onPageChange).toHaveBeenLastCalledWith(3);
  });

  it("disables Next on the last page and moves back", async () => {
    const { user, onPageChange } = setup(3, 3);
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("collapses a long range with gaps around the current page", () => {
    setup(10, 20);
    const labels = screen.getAllByRole("button", { name: /^Page / }).map((b) => b.textContent);
    expect(labels).toEqual(["1", "9", "10", "11", "20"]);
    expect(screen.getAllByText("…")).toHaveLength(2);
  });
});
