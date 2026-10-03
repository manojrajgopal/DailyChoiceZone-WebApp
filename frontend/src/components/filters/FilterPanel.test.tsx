import { describe, expect, it, vi } from "vitest";

import type { ProductQuery } from "@/types";

import { makeFacets } from "@/test/search-fixtures";
import { renderUI, screen, within } from "@/test/render";

import { FilterPanel } from "./FilterPanel";

const content = vi.hoisted(() => ({
  value: { ratingFilters: [4, 2], discountFilters: [25], popularSearches: [], sortOptions: [] } as unknown,
}));
vi.mock("@/hooks/useSiteContent", () => ({ useSiteContent: () => content.value }));

function setup(query: ProductQuery = { page: 1 }, facets = makeFacets(), showCategoryFilter = true) {
  const onChange = vi.fn();
  const utils = renderUI(
    <FilterPanel facets={facets} query={query} onChange={onChange} showCategoryFilter={showCategoryFilter} />,
  );
  const lastQuery = () => onChange.mock.calls.at(-1)?.[0] as ProductQuery;
  return { ...utils, onChange, lastQuery };
}

/** Open a collapsed section by its title. */
async function open(user: ReturnType<typeof setup>["user"], title: string) {
  const header = screen.getByRole("button", { name: new RegExp(`^${title}`) });
  if (header.getAttribute("aria-expanded") !== "true") await user.click(header);
}

describe("FilterPanel", () => {
  it("toggles a category with its count, resetting to page 1", async () => {
    const { user, lastQuery } = setup({ page: 3 });
    const kitchen = screen.getByRole("checkbox", { name: /kitchen/i });
    expect(kitchen.closest("label")).toHaveTextContent("41");
    await user.click(kitchen);
    expect(lastQuery()).toMatchObject({ category: ["kitchen"], page: 1 });
  });

  it("disables a zero-count option unless it is selected", () => {
    const first = setup({ page: 1 });
    expect(screen.getByRole("checkbox", { name: /home/i })).toBeDisabled();
    first.unmount();

    setup({ page: 1, category: ["home"] });
    const home = screen.getByRole("checkbox", { name: /home/i });
    expect(home).not.toBeDisabled();
    expect(home).toBeChecked();
  });

  it("hides the category section on a category page", () => {
    setup({ page: 1 }, makeFacets(), false);
    expect(screen.queryByRole("button", { name: /^Category/ })).not.toBeInTheDocument();
  });

  it("uses the server's price buckets with counts, and selects one", async () => {
    const { user, lastQuery } = setup();
    const under = screen.getByRole("button", { name: /under ₹500/i });
    expect(under).toHaveTextContent("10");
    expect(screen.getByRole("button", { name: /over ₹5,000/i })).toBeDisabled();
    await user.click(under);
    expect(lastQuery()).toMatchObject({ minPrice: 0, maxPrice: 500 });
  });

  it("keeps a selected empty bucket enabled so it can be cleared", async () => {
    const { user, lastQuery } = setup({ page: 1, minPrice: 5000 });
    const over = screen.getByRole("button", { name: /over ₹5,000/i });
    expect(over).toHaveAttribute("aria-pressed", "true");
    expect(over).not.toBeDisabled();
    await user.click(over);
    expect(lastQuery()).not.toHaveProperty("minPrice");
  });

  it("falls back to fixed price bands without server buckets", () => {
    setup({ page: 1 }, makeFacets({ priceBuckets: [] }));
    expect(screen.getByRole("button", { name: /₹5,000\+/ })).toBeInTheDocument();
  });

  it("commits typed prices on Enter", async () => {
    const { user, lastQuery } = setup();
    await user.type(screen.getByLabelText("Minimum price"), "200");
    await user.type(screen.getByLabelText("Maximum price"), "800{Enter}");
    expect(lastQuery()).toMatchObject({ minPrice: 200, maxPrice: 800 });
  });

  it("offers the server's ratings and discounts with counts, disabling empty ones", async () => {
    const { user, lastQuery } = setup();
    await open(user, "Customer rating");
    expect(screen.getByRole("button", { name: "3 stars and above (0)" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "4 stars and above (20)" }));
    expect(lastQuery()).toMatchObject({ minRating: 4 });

    await open(user, "Discount");
    expect(screen.getByRole("button", { name: /50% and above/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /10% and above/ }));
    expect(lastQuery()).toMatchObject({ minDiscount: 10 });
  });

  it("falls back to the content document's ratings and discounts", async () => {
    const { user } = setup({ page: 1 }, makeFacets({ ratings: [], discounts: [] }));
    await open(user, "Customer rating");
    expect(screen.getByRole("button", { name: "2 stars and above" })).toBeEnabled();
    await open(user, "Discount");
    expect(screen.getByRole("button", { name: /25% and above/ })).toBeEnabled();
  });

  it("filters by availability with counts", async () => {
    const { user, lastQuery } = setup();
    const inStock = screen.getByRole("checkbox", { name: /^in stock/i });
    expect(inStock.closest("label")).toHaveTextContent("35");
    await user.click(screen.getByRole("checkbox", { name: /out of stock/i }));
    expect(lastQuery()).toMatchObject({ availability: "out-of-stock" });
  });

  it("treats the legacy in-stock flag as in stock, and unticking clears both", async () => {
    const { user, lastQuery } = setup({ page: 1, inStockOnly: true });
    const inStock = screen.getByRole("checkbox", { name: /^in stock/i });
    expect(inStock).toBeChecked();
    await user.click(inStock);
    expect(lastQuery()).not.toHaveProperty("availability");
    expect(lastQuery()).not.toHaveProperty("inStockOnly");
  });

  it("renders a multi attribute as checkboxes with counts", async () => {
    const { user, lastQuery } = setup();
    await open(user, "Material");
    expect(screen.getByRole("checkbox", { name: /glass/i })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /steel/i }));
    expect(lastQuery()).toMatchObject({ attributes: { material: ["steel"] } });
  });

  it("opens an attribute section that has a selection, and unticks it", async () => {
    const { user, lastQuery } = setup({ page: 1, attributes: { material: ["steel"] } });
    const steel = screen.getByRole("checkbox", { name: /steel/i });
    expect(steel).toBeChecked();
    await user.click(steel);
    expect(lastQuery()).not.toHaveProperty("attributes");
  });

  it("renders a boolean attribute as Yes / No checkboxes", async () => {
    const { user, lastQuery } = setup();
    await open(user, "Dishwasher safe");
    await user.click(screen.getByRole("checkbox", { name: /yes/i }));
    expect(lastQuery()).toMatchObject({ attributes: { dishwasher_safe: ["true"] } });
  });

  it("applies a number attribute's range with the Apply button", async () => {
    const { user, lastQuery } = setup();
    await open(user, "Capacity");
    const min = screen.getByLabelText("Minimum Capacity (ml)");
    expect(min).toHaveAttribute("placeholder", "250 ml");
    await user.type(min, "500");
    await user.type(screen.getByLabelText("Maximum Capacity (ml)"), "1000");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(lastQuery()).toMatchObject({ attributeRanges: { capacity: { min: 500, max: 1000 } } });
  });

  it("refuses an inverted range and says why", async () => {
    const { user, onChange } = setup();
    await open(user, "Capacity");
    await user.type(screen.getByLabelText("Minimum Capacity (ml)"), "900");
    await user.type(screen.getByLabelText("Maximum Capacity (ml)"), "100{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent(/minimum must not be more/i);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clears an applied range", async () => {
    const { user, lastQuery } = setup({ page: 1, attributeRanges: { capacity: { min: 500 } } });
    expect(screen.getByLabelText("Minimum Capacity (ml)")).toHaveValue(500);
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(lastQuery()).not.toHaveProperty("attributeRanges");
  });

  it("collapses and expands sections, showing how many are ticked", async () => {
    const { user } = setup({ page: 1, brand: ["Anvi", "Meridian"] });
    const brand = screen.getByRole("button", { name: /^Brand/ });
    expect(brand).toHaveAttribute("aria-expanded", "true");
    expect(within(brand).getByText("2")).toBeInTheDocument();
    await user.click(brand);
    expect(brand).toHaveAttribute("aria-expanded", "false");
  });

  it("disables an empty size but toggles a stocked one", async () => {
    const { user, lastQuery } = setup();
    await open(user, "Size");
    expect(screen.getByRole("button", { name: "L (0)" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "M (4)" }));
    expect(lastQuery()).toMatchObject({ size: ["M"] });
  });

  it("skips attribute sections with nothing to offer", () => {
    setup({ page: 1 }, makeFacets({
      attributes: [
        { code: "finish", label: "Finish", type: "select", unit: "", options: [], range: null },
        { code: "length", label: "Length", type: "number", unit: "cm", options: [], range: null },
      ],
    }));
    expect(screen.queryByRole("button", { name: /^Finish/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Length/ })).not.toBeInTheDocument();
  });
});
