import { describe, expect, it } from "vitest";

import { renderUI, screen } from "@/test/render";

import { Breadcrumb } from "./Breadcrumb";

describe("Breadcrumb", () => {
  it("renders nothing for an empty trail", () => {
    const { container } = renderUI(<Breadcrumb items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("links every crumb but the last, which is marked as the current page", () => {
    renderUI(
      <Breadcrumb
        items={[
          { label: "Home", href: "/" },
          { label: "Women", href: "/women" },
          { label: "Silk Dress", href: "/p/silk-dress" },
        ]}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(nav.querySelectorAll("li")).toHaveLength(3);
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Women" })).toHaveAttribute("href", "/women");
    expect(screen.queryByRole("link", { name: "Silk Dress" })).not.toBeInTheDocument();
    expect(screen.getByText("Silk Dress")).toHaveAttribute("aria-current", "page");
    expect(nav.querySelectorAll("svg")).toHaveLength(2);
  });

  it("renders a crumb without an href as plain text, not the current page", () => {
    renderUI(<Breadcrumb items={[{ label: "Shop" }, { label: "Sale" }]} />);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByText("Shop")).not.toHaveAttribute("aria-current");
    expect(screen.getByText("Sale")).toHaveAttribute("aria-current", "page");
  });

  it("renders a single crumb as the current page with no separator", () => {
    renderUI(<Breadcrumb items={[{ label: "Home", href: "/" }]} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Home")).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("navigation").querySelector("svg")).toBeNull();
  });
});
