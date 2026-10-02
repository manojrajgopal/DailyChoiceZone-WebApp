import { describe, expect, it } from "vitest";

import type { Product, ProductFilters, ProductQuery, SortOption } from "@/types/product";
import { makeProduct } from "@/test/sliceA-fixtures";

import {
  DEFAULT_PAGE_SIZE,
  buildFacets,
  countActiveFilters,
  matchesFilters,
  paginate,
  queryProducts,
  sortProducts,
} from "./apply-filters";

describe("matchesFilters", () => {
  const base = makeProduct({
    category: "women",
    subcategory: "dresses",
    brand: "Zara",
    sizes: ["S", "M"],
    colors: [{ name: "Red", hex: "#f00" }, { name: "Blue", hex: "#00f" }],
    price: 1500,
    rating: 4,
    discount: 20,
    stock: 5,
    name: "Summer dress",
    description: "A light cotton dress",
    tags: ["summer", "cotton"],
  });

  it.each([
    ["category", { category: ["women"] }, true],
    ["category case-insensitive", { category: ["WOMEN"] }, true],
    ["non-matching category", { category: ["men"] }, false],
    ["empty category filter matches anything", { category: [] }, true],
    ["subcategory", { subcategory: ["dresses"] }, true],
    ["non-matching subcategory", { subcategory: ["shirts"] }, false],
    ["brand", { brand: ["Zara"] }, true],
    ["non-matching brand", { brand: ["H&M"] }, false],
    ["size present", { size: ["M"] }, true],
    ["size case-insensitive", { size: ["m"] }, true],
    ["size absent", { size: ["XL"] }, false],
    ["color present", { color: ["Red"] }, true],
    ["color absent", { color: ["Green"] }, false],
    ["minPrice satisfied", { minPrice: 1000 }, true],
    ["minPrice violated", { minPrice: 2000 }, false],
    ["maxPrice satisfied", { maxPrice: 2000 }, true],
    ["maxPrice violated", { maxPrice: 1000 }, false],
    ["minRating satisfied", { minRating: 4 }, true],
    ["minRating violated", { minRating: 4.5 }, false],
    ["minDiscount satisfied", { minDiscount: 20 }, true],
    ["minDiscount violated", { minDiscount: 30 }, false],
    ["inStockOnly satisfied", { inStockOnly: true }, true],
    ["query matches name", { query: "summer" }, true],
    ["query requires every term", { query: "summer winter" }, false],
    ["query no match", { query: "jacket" }, false],
  ] as [string, ProductFilters, boolean][])("%s", (_label, filters, expected) => {
    expect(matchesFilters(base, filters)).toBe(expected);
  });

  it("excludes out-of-stock products when inStockOnly is set", () => {
    const outOfStock = makeProduct({ stock: 0 });
    expect(matchesFilters(outOfStock, { inStockOnly: true })).toBe(false);
  });

  it("matches a query term found in tags or color names", () => {
    expect(matchesFilters(base, { query: "cotton" })).toBe(true);
    expect(matchesFilters(base, { query: "red" })).toBe(true);
  });

  it("treats an empty-string query as no filter", () => {
    expect(matchesFilters(base, { query: "" })).toBe(true);
  });
});

describe("sortProducts", () => {
  const cheap = makeProduct({ id: "A", price: 100, rating: 3, reviewCount: 1, discount: 0, stock: 1 });
  const expensive = makeProduct({ id: "B", price: 900, rating: 5, reviewCount: 50, discount: 40, stock: 1 });
  const outOfStock = makeProduct({ id: "C", price: 50, rating: 5, reviewCount: 999, discount: 0, stock: 0 });

  it.each([
    ["price-asc", ["C", "A", "B"]],
    ["price-desc", ["B", "A", "C"]],
    ["rating", ["C", "B", "A"]],
    ["discount", ["B", "A", "C"]],
  ] as [SortOption, string[]][])("sorts by %s", (sort, order) => {
    const result = sortProducts([cheap, expensive, outOfStock], sort);
    expect(result.map((p) => p.id)).toEqual(order);
  });

  it("puts in-stock products ahead under recommended", () => {
    const result = sortProducts([outOfStock, cheap, expensive], "recommended");
    expect(result.at(-1)!.id).toBe("C");
  });

  it("does not mutate the input array", () => {
    const input = [expensive, cheap];
    const sorted = sortProducts(input, "price-asc");
    expect(input).toEqual([expensive, cheap]);
    expect(sorted).not.toBe(input);
  });

  it("falls back to recommended for an unknown sort", () => {
    const result = sortProducts([cheap, outOfStock], "bogus" as SortOption);
    expect(result[0]!.id).toBe("A");
  });

  it("defaults to recommended when no sort is given", () => {
    const result = sortProducts([outOfStock, cheap]);
    expect(result.at(-1)!.id).toBe("C");
  });

  it("breaks popular ties on rating", () => {
    const sameReviews1 = makeProduct({ id: "X", reviewCount: 10, rating: 3 });
    const sameReviews2 = makeProduct({ id: "Y", reviewCount: 10, rating: 5 });
    const result = sortProducts([sameReviews1, sameReviews2], "popular");
    expect(result[0]!.id).toBe("Y");
  });

  it("breaks newest ties on the recommended blend, prioritising isNew", () => {
    const newer = makeProduct({ id: "N", isNew: true, rating: 1 });
    const older = makeProduct({ id: "O", isNew: false, rating: 5 });
    const result = sortProducts([older, newer], "newest");
    expect(result[0]!.id).toBe("N");
  });
});

describe("paginate", () => {
  const items = Array.from({ length: 10 }, (_, i) => i);

  it.each([
    [1, 3, [0, 1, 2], 1, 4],
    [2, 3, [3, 4, 5], 2, 4],
    [4, 3, [9], 4, 4],
    [0, 3, [0, 1, 2], 1, 4], // clamped up
    [-5, 3, [0, 1, 2], 1, 4], // clamped up
    [99, 3, [9], 4, 4], // clamped down to last page
    [1.9, 3, [0, 1, 2], 1, 4], // truncated
  ])("page %s of size %s", (page, pageSize, expectedItems, expectedPage, expectedTotalPages) => {
    const result = paginate(items, page, pageSize);
    expect(result.items).toEqual(expectedItems);
    expect(result.page).toBe(expectedPage);
    expect(result.totalPages).toBe(expectedTotalPages);
    expect(result.total).toBe(10);
  });

  it("treats a pageSize of 0 or negative as 1", () => {
    expect(paginate(items, 1, 0).pageSize).toBe(1);
    expect(paginate(items, 1, -5).pageSize).toBe(1);
  });

  it("is a single empty page for an empty list", () => {
    const result = paginate([], 1, 10);
    expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 10, totalPages: 1 });
  });

  it("defaults to page 1 and DEFAULT_PAGE_SIZE", () => {
    const result = paginate(items);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(result.items).toEqual(items);
  });
});

describe("queryProducts", () => {
  const products: Product[] = [
    makeProduct({ id: "1", category: "men", price: 500 }),
    makeProduct({ id: "2", category: "women", price: 1500 }),
    makeProduct({ id: "3", category: "men", price: 2500 }),
  ];

  it("filters, sorts and paginates together", () => {
    const result = queryProducts(products, { category: ["men"], sort: "price-asc", page: 1, pageSize: 1 } as ProductQuery);
    expect(result.items.map((p) => p.id)).toEqual(["1"]);
    expect(result.total).toBe(2);
    expect(result.totalPages).toBe(2);
  });

  it("defaults to every product, recommended order, page 1 when given no query", () => {
    const result = queryProducts(products);
    expect(result.items).toHaveLength(3);
    expect(result.page).toBe(1);
  });
});

describe("buildFacets", () => {
  it("counts categories, brands, sizes and colors, and the price range", () => {
    const products: Product[] = [
      makeProduct({ category: "men", subcategory: "shirts", brand: "A", sizes: ["M", "L"], colors: [{ name: "Red", hex: "#f00" }], price: 100 }),
      makeProduct({ category: "men", subcategory: "shirts", brand: "A", sizes: ["M"], colors: [{ name: "Red", hex: "#f00" }], price: 300 }),
      makeProduct({ category: "women", subcategory: "dresses", brand: "B", sizes: ["S"], colors: [{ name: "Blue", hex: "#00f" }], price: 200 }),
    ];
    const facets = buildFacets(products);
    expect(facets.categories).toEqual(
      expect.arrayContaining([
        { value: "men", label: "Men", count: 2 },
        { value: "women", label: "Women", count: 1 },
      ]),
    );
    expect(facets.brands.find((b) => b.value === "A")?.count).toBe(2);
    expect(facets.sizes.map((s) => s.value)).toEqual(["S", "M", "L"]);
    expect(facets.colors.find((c) => c.value === "Red")?.count).toBe(2);
    expect(facets.priceRange).toEqual({ min: 100, max: 300 });
  });

  it("is all empty with a zero price range for an empty catalogue", () => {
    const facets = buildFacets([]);
    expect(facets.categories).toEqual([]);
    expect(facets.priceRange).toEqual({ min: 0, max: 0 });
  });

  it("orders numeric sizes by their numeric value, after named sizes", () => {
    const products: Product[] = [
      makeProduct({ sizes: ["10", "8", "M"] }),
    ];
    const facets = buildFacets(products);
    expect(facets.sizes.map((s) => s.value)).toEqual(["M", "8", "10"]);
  });

  it("falls back to alphabetical for sizes that are neither named nor numeric", () => {
    const products: Product[] = [makeProduct({ sizes: ["Z-size", "A-size"] })];
    const facets = buildFacets(products);
    expect(facets.sizes.map((s) => s.value)).toEqual(["A-size", "Z-size"]);
  });
});

describe("countActiveFilters", () => {
  it.each([
    [{}, 0],
    [{ category: ["men"] }, 1],
    [{ category: ["men", "women"] }, 2],
    [{ minPrice: 100 }, 1],
    [{ minPrice: 100, maxPrice: 200 }, 1], // counted together as one "price" filter
    [{ minRating: 4 }, 1],
    [{ minDiscount: 10 }, 1],
    [{ inStockOnly: true }, 1],
    [{ inStockOnly: false }, 0],
    [{ category: ["a"], brand: ["b"], size: ["c"], color: ["d"], subcategory: ["e"], minPrice: 1, minRating: 1, minDiscount: 1, inStockOnly: true }, 9],
  ] as [ProductFilters, number][])("counts %j as %s", (filters, expected) => {
    expect(countActiveFilters(filters)).toBe(expected);
  });
});
