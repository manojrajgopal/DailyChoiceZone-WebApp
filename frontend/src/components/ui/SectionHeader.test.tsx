import { describe, expect, it } from "vitest";

import { renderUI, screen } from "@/test/render";

import { SectionHeader } from "./SectionHeader";

describe("SectionHeader", () => {
  it("renders an h2 title with no eyebrow or link by default", () => {
    renderUI(<SectionHeader title="New in" />);
    expect(screen.getByRole("heading", { level: 2, name: "New in" })).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders the subtitle, an h1 with an id, and a View all link", () => {
    const { container } = renderUI(
      <SectionHeader title="Dresses" subtitle="The edit" as="h1" id="dresses" viewAllHref="/c/dresses" className="mb-4" />,
    );
    const heading = screen.getByRole("heading", { level: 1, name: "Dresses" });
    expect(heading).toHaveAttribute("id", "dresses");
    expect(screen.getByText("The edit")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View all" })).toHaveAttribute("href", "/c/dresses");
    expect(container.firstChild).toHaveClass("mb-4");
  });

  it("uses a custom link label", () => {
    renderUI(<SectionHeader title="Sale" viewAllHref="/sale" viewAllLabel="Shop the sale" />);
    expect(screen.getByRole("link", { name: "Shop the sale" })).toHaveAttribute("href", "/sale");
  });
});
