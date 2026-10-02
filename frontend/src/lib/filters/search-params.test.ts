import { describe, expect, it } from "vitest";

import type { ProductQuery } from "@/types/product";

import { DEFAULT_PAGE_SIZE } from "./apply-filters";
import { buildQueryString, clearFilters, parseProductQuery, toggleFilterValue } from "./search-params";

describe("parseProductQuery", () => {
  it("parses from URLSearchParams", () => {
    const params = new URLSearchParams("category=men&category=women&size=M,L&sort=price-asc&page=2&pageSize=10&minPrice=100&maxPrice=500&minRating=4&minDiscount=10&inStock=1&q=shirt");
    expect(parseProductQuery(params)).toEqual({
      page: 2,
      pageSize: 10,
      sort: "price-asc",
      category: ["men", "women"],
      size: ["M", "L"],
      minPrice: 100,
      maxPrice: 500,
      minRating: 4,
      minDiscount: 10,
      inStockOnly: true,
      query: "shirt",
    });
  });

  it("parses from a plain record (Next's searchParams shape)", () => {
    expect(parseProductQuery({ category: ["men"], q: "shoes" })).toEqual({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      category: ["men"],
      query: "shoes",
    });
  });

  it("splits a single comma-joined value from a record", () => {
    expect(parseProductQuery({ brand: "A,B,C" })).toEqual({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      brand: ["A", "B", "C"],
    });
  });

  it("defaults page to 1 and pageSize to the default with nothing given", () => {
    expect(parseProductQuery({})).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE });
    expect(parseProductQuery(new URLSearchParams())).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE });
  });

  it("ignores an invalid sort value", () => {
    expect(parseProductQuery({ sort: "bogus" })).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE });
  });

  it("rejects a non-numeric page/pageSize/price and falls back", () => {
    expect(parseProductQuery({ page: "abc", pageSize: "xyz", minPrice: "nope" })).toEqual({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    });
  });

  it("clamps a page below 1 up to 1", () => {
    expect(parseProductQuery({ page: "-5" }).page).toBe(1);
    expect(parseProductQuery({ page: "0" }).page).toBe(1);
  });

  it("treats inStock other than '1' as not set", () => {
    expect(parseProductQuery({ inStock: "true" }).inStockOnly).toBeUndefined();
    expect(parseProductQuery({ inStock: "0" }).inStockOnly).toBeUndefined();
  });

  it("drops an empty q", () => {
    expect(parseProductQuery({ q: "" }).query).toBeUndefined();
  });

  it("ignores undefined array entries in a record", () => {
    expect(parseProductQuery({ category: undefined })).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE });
  });
});

describe("buildQueryString", () => {
  it("omits defaults for a clean /shop URL", () => {
    expect(buildQueryString({})).toBe("");
    expect(buildQueryString({ sort: "recommended", page: 1, pageSize: DEFAULT_PAGE_SIZE })).toBe("");
  });

  it("serialises lists, numbers, flags and non-default sort/page/pageSize", () => {
    const query: ProductQuery = {
      category: ["men", "women"],
      minPrice: 100,
      maxPrice: 500,
      minRating: 4,
      minDiscount: 10,
      inStockOnly: true,
      query: "shirt",
      sort: "price-asc",
      page: 2,
      pageSize: 48,
    };
    const qs = buildQueryString(query);
    const params = new URLSearchParams(qs.slice(1));
    expect(params.get("category")).toBe("men,women");
    expect(params.get("minPrice")).toBe("100");
    expect(params.get("maxPrice")).toBe("500");
    expect(params.get("minRating")).toBe("4");
    expect(params.get("minDiscount")).toBe("10");
    expect(params.get("inStock")).toBe("1");
    expect(params.get("q")).toBe("shirt");
    expect(params.get("sort")).toBe("price-asc");
    expect(params.get("page")).toBe("2");
    expect(params.get("pageSize")).toBe("48");
  });

  it("omits empty-array filters", () => {
    expect(buildQueryString({ category: [] })).toBe("");
  });

  it("round-trips through parseProductQuery", () => {
    const query: ProductQuery = { category: ["men"], sort: "rating", page: 3, pageSize: 10 };
    const parsed = parseProductQuery(new URLSearchParams(buildQueryString(query).slice(1)));
    expect(parsed).toEqual(query);
  });
});

describe("toggleFilterValue", () => {
  it("adds a value not yet selected and resets to page 1", () => {
    const result = toggleFilterValue({ category: ["men"], page: 5 }, "category", "women");
    expect(result.category).toEqual(["men", "women"]);
    expect(result.page).toBe(1);
  });

  it("removes a value already selected, case-insensitively", () => {
    const result = toggleFilterValue({ category: ["Men", "Women"] }, "category", "men");
    expect(result.category).toEqual(["Women"]);
  });

  it("deletes the key entirely once the last value is removed", () => {
    const result = toggleFilterValue({ category: ["Men"] }, "category", "men");
    expect(result.category).toBeUndefined();
    expect("category" in result).toBe(false);
  });

  it("starts a new list when the key had nothing selected", () => {
    const result = toggleFilterValue({}, "brand", "Zara");
    expect(result.brand).toEqual(["Zara"]);
  });

  it("does not mutate the original query", () => {
    const original: ProductQuery = { category: ["men"] };
    toggleFilterValue(original, "category", "women");
    expect(original.category).toEqual(["men"]);
  });
});

describe("clearFilters", () => {
  it("drops filters but keeps sort, pageSize and search term, resetting to page 1", () => {
    const result = clearFilters({ category: ["men"], minPrice: 100, sort: "rating", pageSize: 48, query: "shirt", page: 3 });
    expect(result).toEqual({ page: 1, pageSize: 48, sort: "rating", query: "shirt" });
  });

  it("omits sort and query when unset", () => {
    expect(clearFilters({ page: 2, pageSize: 24 })).toEqual({ page: 1, pageSize: 24 });
  });
});
