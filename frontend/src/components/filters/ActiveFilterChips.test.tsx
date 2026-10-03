import { describe, expect, it, vi } from "vitest";

import type { ProductQuery } from "@/types";

import { makeFacets } from "@/test/search-fixtures";
import { renderUI, screen } from "@/test/render";

import { ActiveFilterChips } from "./ActiveFilterChips";

function setup(query: ProductQuery, withFacets = true) {
  const onChange = vi.fn();
  const onClearAll = vi.fn();
  const utils = renderUI(
    <ActiveFilterChips
      query={query}
      facets={withFacets ? makeFacets() : null}
      onChange={onChange}
      onClearAll={onClearAll}
    />,
  );
  const lastQuery = () => onChange.mock.calls.at(-1)?.[0] as ProductQuery;
  return { ...utils, onChange, onClearAll, lastQuery };
}

describe("ActiveFilterChips", () => {
  it("renders nothing without filters", () => {
    const { container } = setup({ page: 1 });
    expect(container).toBeEmptyDOMElement();
  });

  it("labels attribute values from the facets and removes one", async () => {
    const { user, lastQuery } = setup({ page: 2, attributes: { material: ["steel", "glass"] } });
    await user.click(screen.getByRole("button", { name: "Remove filter: Material: Steel" }));
    expect(lastQuery()).toEqual({ page: 1, attributes: { material: ["glass"] } });
  });

  it("shows boolean attributes as Yes / No", () => {
    setup({ attributes: { dishwasher_safe: ["true"] } }, false);
    expect(screen.getByRole("button", { name: /^Remove filter: Dishwasher safe: Yes$/i })).toBeInTheDocument();
  });

  it("labels an attribute range with its unit and removes it", async () => {
    const { user, lastQuery } = setup({
      attributeRanges: { capacity: { min: 500, max: 1000 }, weight: { min: 2 } },
    });
    expect(screen.getByRole("button", { name: "Remove filter: Weight: 2 or more" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove filter: Capacity: 500 – 1,000 ml" }));
    expect(lastQuery()).toEqual({ page: 1, attributeRanges: { weight: { min: 2 } } });
  });

  it("labels an upper-bound-only range", () => {
    setup({ attributeRanges: { capacity: { max: 750 } } });
    expect(screen.getByRole("button", { name: "Remove filter: Capacity: up to 750 ml" })).toBeInTheDocument();
  });

  it("shows and removes the availability filter", async () => {
    const { user, lastQuery } = setup({ availability: "out-of-stock" });
    await user.click(screen.getByRole("button", { name: "Remove filter: Out of stock" }));
    expect(lastQuery()).not.toHaveProperty("availability");
  });

  it("still shows the legacy in-stock flag", async () => {
    const { user, lastQuery } = setup({ inStockOnly: true });
    await user.click(screen.getByRole("button", { name: "Remove filter: In stock only" }));
    expect(lastQuery()).not.toHaveProperty("inStockOnly");
  });

  it("covers the standard filters, with facet labels", async () => {
    const { user, lastQuery } = setup({
      category: ["kitchen"],
      brand: ["Anvi"],
      size: ["M"],
      minPrice: 500,
      maxPrice: 1000,
      minRating: 4,
      minDiscount: 20,
    });
    expect(screen.getByRole("button", { name: "Remove filter: Kitchen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove filter: Size: M" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Remove filter: ₹500 – ₹1,000/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove filter: 4★ & above" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove filter: 20% off or more" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove filter: Anvi" }));
    expect(lastQuery()).not.toHaveProperty("brand");
    expect(lastQuery()).toMatchObject({ category: ["kitchen"], minRating: 4 });
  });

  it("offers clear all with more than one chip", async () => {
    const { user, onClearAll } = setup({ brand: ["Anvi"], availability: "in-stock" });
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });
});
