import { describe, expect, it } from "vitest";

import { makeProduct } from "@/test/sliceA-fixtures";
import { api, ok } from "@/test/api";

import { getSearchSuggestions, searchProducts } from "./searchService";

describe("searchProducts", () => {
  it("queries the catalogue with the term as `query`", async () => {
    api.get("/products", ok([]));
    await searchProducts("kurta", { sort: "price-asc" });
    const request = api.last()!;
    expect(request.query.get("search")).toBe("kurta");
    expect(request.query.get("sort")).toBe("price-asc");
  });
});

describe("getSearchSuggestions", () => {
  it("is empty without a request for a too-short term", async () => {
    expect(await getSearchSuggestions("k")).toEqual({ products: [], categories: [], brands: [], total: 0 });
    expect(await getSearchSuggestions(" ")).toEqual({ products: [], categories: [], brands: [], total: 0 });
    expect(api.calls).toHaveLength(0);
  });

  it("trims the term before checking its length", async () => {
    expect(await getSearchSuggestions(" a ")).toEqual({ products: [], categories: [], brands: [], total: 0 });
  });

  it("queries, then limits products and collects distinct categories/brands", async () => {
    api.get("/products", ok(
      [
        makeProduct({ id: "P1", category: "men", brand: "A" }),
        makeProduct({ id: "P2", category: "men", brand: "B" }),
        makeProduct({ id: "P3", category: "women", brand: "A" }),
      ],
      { total: 20 },
    ));
    const result = await getSearchSuggestions("shirt", 2);
    expect(result.products).toHaveLength(2);
    expect(result.categories).toEqual(["men", "women"]);
    expect(result.brands).toEqual(["A", "B"]);
    expect(result.total).toBe(20);
    expect(api.last()!.query.get("search")).toBe("shirt");
    expect(api.last()!.query.get("pageSize")).toBe("40");
  });

  it("caps categories and brands at 4 distinct values", async () => {
    api.get("/products", ok(
      ["a", "b", "c", "d", "e"].map((cat) => makeProduct({ id: cat, category: cat, brand: cat })),
    ));
    const result = await getSearchSuggestions("xx");
    expect(result.categories).toHaveLength(4);
    expect(result.brands).toHaveLength(4);
  });
});
