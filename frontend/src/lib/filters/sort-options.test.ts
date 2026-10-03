import { describe, expect, it } from "vitest";

import { VALID_SORTS } from "./search-params";
import { SORT_LABELS, sortOptionsFor } from "./sort-options";

describe("sortOptionsFor", () => {
  it("offers every order the API accepts, relevance first, when there is a search term", () => {
    const options = sortOptionsFor(true);
    expect(options.map((option) => option.value).sort()).toEqual([...VALID_SORTS].sort());
    expect(options[0]).toEqual({ value: "relevance", label: "Relevance" });
  });

  it("drops relevance without a search term", () => {
    const values = sortOptionsFor(false).map((option) => option.value);
    expect(values).not.toContain("relevance");
    expect(values).toHaveLength(VALID_SORTS.length - 1);
    expect(values[0]).toBe("recommended");
  });

  it("has a friendly label for every order", () => {
    for (const sort of VALID_SORTS) expect(SORT_LABELS[sort]).toMatch(/\w/);
    expect(SORT_LABELS["price-asc"]).toBe("Price: low to high");
  });

  it("uses the store's own labels, but never adds an order the API would reject", () => {
    const options = sortOptionsFor(false, [
      { value: "newest", label: "Just in" },
      { value: "bogus", label: "Nope" },
      { value: "rating", label: "   " },
    ]);
    expect(options.find((option) => option.value === "newest")?.label).toBe("Just in");
    expect(options.find((option) => option.value === "rating")?.label).toBe(SORT_LABELS.rating);
    expect(options.map((option) => option.value)).not.toContain("bogus");
  });
});
