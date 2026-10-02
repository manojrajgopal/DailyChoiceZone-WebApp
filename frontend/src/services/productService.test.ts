import { describe, expect, it } from "vitest";

import { makeProduct } from "@/test/sliceA-fixtures";
import { api, fail, ok } from "@/test/api";

import {
  getAllProducts,
  getBestSellingProducts,
  getDeals,
  getFacets,
  getFeaturedProducts,
  getNewArrivals,
  getProduct,
  getProducts,
  getProductsByCategory,
  getProductsByIds,
  getRecommendedProducts,
  getRelatedProducts,
  getTrendingProducts,
} from "./productService";

describe("getProducts / getProduct / getProductsByIds / getFacets", () => {
  it("getProducts delegates straight to the data source", async () => {
    api.get("/products", ok([makeProduct()], { page: 1, total: 1 }));
    const result = await getProducts({ sort: "price-asc" });
    expect(result.items).toHaveLength(1);
    expect(api.last()!.query.get("sort")).toBe("price-asc");
  });

  it("getProduct resolves by id/slug, or null", async () => {
    api.get("/products/abc", makeProduct({ id: "abc" }));
    expect((await getProduct("abc"))?.id).toBe("abc");
    api.get("/products/missing", fail(404));
    expect(await getProduct("missing")).toBeNull();
  });

  it("getProductsByIds resolves each id", async () => {
    api.get("/products/A", makeProduct({ id: "A" }));
    api.get("/products/B", makeProduct({ id: "B" }));
    expect((await getProductsByIds(["A", "B"])).map((p) => p.id)).toEqual(["A", "B"]);
  });

  it("getFacets passes the scope through", async () => {
    api.get("/products/facets", ok({}));
    await getFacets({ category: ["men"] });
    expect(api.last()!.query.get("category")).toBe("men");
  });
});

describe("getProductsByCategory", () => {
  it("sets the category filter alongside any other filters", async () => {
    api.get("/products", ok([]));
    await getProductsByCategory("men", { sort: "rating" });
    const request = api.last()!;
    expect(request.query.get("category")).toBe("men");
    expect(request.query.get("sort")).toBe("rating");
  });
});

describe("getAllProducts", () => {
  it("pages through until the last page, concatenating items", async () => {
    let call = 0;
    api.get("/products", () => {
      call += 1;
      if (call === 1) return ok([makeProduct({ id: "P1" }), makeProduct({ id: "P2" })], { page: 1, page_size: 2, total: 3, total_pages: 2 });
      return ok([makeProduct({ id: "P3" })], { page: 2, page_size: 2, total: 3, total_pages: 2 });
    });
    const result = await getAllProducts();
    expect(result.map((p) => p.id)).toEqual(["P1", "P2", "P3"]);
    expect(api.requests("GET", "/products")).toHaveLength(2);
  });

  it("requests pages of 100", async () => {
    api.get("/products", ok([], { page: 1, total: 0, total_pages: 1 }));
    await getAllProducts();
    expect(api.last()!.query.get("pageSize")).toBe("100");
  });

  it("stops if a page comes back empty even though totalPages says more", async () => {
    api.get("/products", ok([], { page: 1, total: 0, total_pages: 5 }));
    const result = await getAllProducts();
    expect(result).toEqual([]);
    expect(api.requests("GET", "/products")).toHaveLength(1);
  });
});

describe("merchandising rails", () => {
  it.each([
    ["getNewArrivals", getNewArrivals, { isNew: "true", sort: "newest" }],
    ["getTrendingProducts", getTrendingProducts, { isTrending: "true", sort: "popular" }],
    ["getBestSellingProducts", getBestSellingProducts, { isBestSeller: "true", sort: "popular" }],
    ["getFeaturedProducts", getFeaturedProducts, { isFeatured: "true", sort: "recommended" }],
  ] as [string, (limit?: number) => Promise<unknown>, Record<string, string>][])("%s queries with the right flags and default limit 6", async (_name, fn, expectedParams) => {
    api.get("/products", ok([]));
    await fn();
    const request = api.last()!;
    expect(request.query.get("pageSize")).toBe("6");
    Object.entries(expectedParams).forEach(([key, value]) => expect(request.query.get(key)).toBe(value));
  });

  it("honours a custom limit", async () => {
    api.get("/products", ok([]));
    await getNewArrivals(3);
    expect(api.last()!.query.get("pageSize")).toBe("3");
  });

  it("getDeals filters by minDiscount and inStockOnly, sorted by discount", async () => {
    api.get("/products", ok([]));
    await getDeals();
    const request = api.last()!;
    expect(request.query.get("minDiscount")).toBe("20");
    expect(request.query.get("inStockOnly")).toBe("true");
    expect(request.query.get("sort")).toBe("discount");
  });
});

describe("getRelatedProducts", () => {
  it("delegates to the data source with the given limit", async () => {
    api.get(/\/products\/P1\/related/, []);
    await getRelatedProducts("P1", 4);
    expect(api.last()!.url).toContain("limit=4");
  });
});

describe("getRecommendedProducts", () => {
  it("falls back to featured products with no viewing history", async () => {
    api.get("/products", ok([makeProduct({ id: "F1", isFeatured: true })]));
    const result = await getRecommendedProducts([]);
    expect(result.map((p) => p.id)).toEqual(["F1"]);
    expect(api.last()!.query.get("isFeatured")).toBe("true");
  });

  it("scores candidates from the shopper's recently viewed categories", async () => {
    api.get("/products/V1", makeProduct({ id: "V1", category: "men", subcategory: "shirts" }));
    api.get("/products", (req) => {
      if (req.query.get("isFeatured") === "true") return ok([]);
      return ok([makeProduct({ id: "C1", category: "men", subcategory: "shirts" })]);
    });
    const result = await getRecommendedProducts(["V1"], 5);
    expect(result.map((p) => p.id)).toContain("C1");
  });

  it("returns recommendations as-is, without topping up, once they meet the limit", async () => {
    api.get("/products/V1", makeProduct({ id: "V1", category: "men", subcategory: "shirts" }));
    const candidates = Array.from({ length: 5 }, (_, i) => makeProduct({ id: `C${i}`, category: "men", subcategory: "shirts" }));
    let askedForFeatured = false;
    api.get("/products", (req) => {
      if (req.query.get("isFeatured") === "true") {
        askedForFeatured = true;
        return ok([]);
      }
      return ok(candidates);
    });
    const result = await getRecommendedProducts(["V1"], 5);
    expect(result).toHaveLength(5);
    expect(askedForFeatured).toBe(false);
  });

  it("tops up with featured products when recommendations fall short of the limit", async () => {
    api.get("/products/V1", makeProduct({ id: "V1", category: "men" }));
    api.get("/products", (req) => {
      if (req.query.get("isFeatured") === "true") return ok([makeProduct({ id: "FEATURED" })]);
      return ok([makeProduct({ id: "C1", category: "men" })]);
    });
    const result = await getRecommendedProducts(["V1"], 5);
    expect(result.map((p) => p.id)).toEqual(expect.arrayContaining(["C1", "FEATURED"]));
  });

  it("does not duplicate a product already recommended or already viewed", async () => {
    api.get("/products/V1", makeProduct({ id: "V1", category: "men" }));
    api.get("/products", (req) => {
      if (req.query.get("isFeatured") === "true") return ok([makeProduct({ id: "V1" }), makeProduct({ id: "FEATURED" })]);
      return ok([]);
    });
    const result = await getRecommendedProducts(["V1"], 5);
    expect(result.filter((p) => p.id === "V1")).toHaveLength(0);
  });
});
