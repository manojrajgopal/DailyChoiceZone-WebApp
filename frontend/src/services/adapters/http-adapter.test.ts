import { describe, expect, it } from "vitest";

import { makeProduct } from "@/test/sliceA-fixtures";
import { api, fail, ok, raw } from "@/test/api";

import { httpAdapter } from "./http-adapter";

describe("queryProducts", () => {
  it("GETs /products with mapped query parameters", async () => {
    api.get("/products", ok([makeProduct()], { page: 1, total: 1 }));
    await httpAdapter.queryProducts({
      page: 2,
      pageSize: 24,
      query: "shirt",
      category: ["men"],
      subcategory: ["shirts"],
      collection: "summer",
      brand: ["A", "B"],
      size: ["M", "L"],
      color: ["Red"],
      minPrice: 100,
      maxPrice: 500,
      minRating: 4,
      minDiscount: 10,
      inStockOnly: true,
      isNew: true,
      isTrending: true,
      isBestSeller: true,
      isFeatured: true,
      sort: "price-asc",
    });

    const request = api.last("GET", "/products")!;
    expect(request.query.get("page")).toBe("2");
    expect(request.query.get("pageSize")).toBe("24");
    expect(request.query.get("search")).toBe("shirt");
    expect(request.query.get("category")).toBe("men");
    expect(request.query.get("subcategory")).toBe("shirts");
    expect(request.query.get("collection")).toBe("summer");
    expect(request.query.get("brands")).toBe("A,B");
    expect(request.query.get("sizes")).toBe("M,L");
    expect(request.query.get("colors")).toBe("Red");
    expect(request.query.get("minPrice")).toBe("100");
    expect(request.query.get("maxPrice")).toBe("500");
    expect(request.query.get("minRating")).toBe("4");
    expect(request.query.get("minDiscount")).toBe("10");
    expect(request.query.get("inStockOnly")).toBe("true");
    expect(request.query.get("isNew")).toBe("true");
    expect(request.query.get("isTrending")).toBe("true");
    expect(request.query.get("isBestSeller")).toBe("true");
    expect(request.query.get("isFeatured")).toBe("true");
    expect(request.query.get("sort")).toBe("price-asc");
  });

  it("sends every category and subcategory as CSV, availability and the attribute filters", async () => {
    api.get("/products", ok([]));
    await httpAdapter.queryProducts({
      category: ["men", "women"],
      subcategory: ["shirts", "kurtas"],
      availability: "out-of-stock",
      attributes: { material: ["steel", "glass"], dishwasher_safe: ["true"] },
      attributeRanges: { capacity: { min: 250, max: 1500 }, weight: { max: 2 } },
      sort: "best-selling",
    });
    const request = api.last("GET", "/products")!;
    expect(request.query.get("category")).toBe("men,women");
    expect(request.query.get("subcategory")).toBe("shirts,kurtas");
    expect(request.query.get("availability")).toBe("out-of-stock");
    expect(request.query.get("attr.material")).toBe("steel,glass");
    expect(request.query.get("attr.dishwasher_safe")).toBe("true");
    expect(request.query.get("attr.capacity.min")).toBe("250");
    expect(request.query.get("attr.capacity.max")).toBe("1500");
    expect(request.query.get("attr.weight.max")).toBe("2");
    expect(request.query.has("attr.weight.min")).toBe(false);
    expect(request.query.get("sort")).toBe("best-selling");
  });

  it("sends the visitor id with a search, and only with a search", async () => {
    window.localStorage.setItem("dcz:visitor", "visitor-abc123");
    api.get("/products", ok([]));
    await httpAdapter.queryProducts({ query: "bottle" });
    expect(api.last("GET", "/products")!.query.get("visitorId")).toBe("visitor-abc123");

    await httpAdapter.queryProducts({ category: ["men"] });
    expect(api.last("GET", "/products")!.query.has("visitorId")).toBe(false);
  });

  it("returns the search meta the listing carries", async () => {
    api.get("/products", raw(200, {
      success: true,
      data: [],
      pagination: { page: 1, page_size: 24, total: 0, total_pages: 1 },
      search: { term: "stel botle", correctedTerm: "steel bottle", searchId: 812 },
    }));
    const result = await httpAdapter.queryProducts({ query: "stel botle" });
    expect(result.search).toEqual({ term: "stel botle", correctedTerm: "steel bottle", searchId: 812 });
  });

  it("has no search meta without a term", async () => {
    api.get("/products", ok([]));
    expect((await httpAdapter.queryProducts({})).search).toBeUndefined();
  });

  it("omits inStockOnly entirely when false", async () => {
    api.get("/products", ok([]));
    await httpAdapter.queryProducts({ inStockOnly: false });
    expect(api.last("GET", "/products")!.query.has("inStockOnly")).toBe(false);
  });

  it("maps the paginated envelope into a Paginated<Product>", async () => {
    api.get("/products", ok([makeProduct({ id: "P1" })], { page: 1, page_size: 24, total: 1, total_pages: 1 }));
    const result = await httpAdapter.queryProducts({});
    expect(result).toEqual({ items: [expect.objectContaining({ id: "P1" })], page: 1, pageSize: 24, total: 1, totalPages: 1 });
  });

  it("propagates a server error", async () => {
    api.get("/products", fail(500));
    await expect(httpAdapter.queryProducts({})).rejects.toMatchObject({ status: 500 });
  });
});

describe("getProduct", () => {
  it("GETs the product by id, URL-encoded", async () => {
    api.get("/products/abc%2Fdef", makeProduct({ id: "abc/def" }));
    const result = await httpAdapter.getProduct("abc/def");
    expect(result?.id).toBe("abc/def");
  });

  it("is null on 404", async () => {
    api.get("/products/missing", fail(404));
    expect(await httpAdapter.getProduct("missing")).toBeNull();
  });

  it("rethrows a non-404 failure", async () => {
    api.get("/products/x", fail(500));
    await expect(httpAdapter.getProduct("x")).rejects.toMatchObject({ status: 500 });
  });
});

describe("getProductsByIds", () => {
  it("resolves one request per id and preserves the given order", async () => {
    api.get("/products/A", makeProduct({ id: "A" }));
    api.get("/products/B", makeProduct({ id: "B" }));
    const result = await httpAdapter.getProductsByIds(["B", "A"]);
    expect(result.map((p) => p.id)).toEqual(["B", "A"]);
  });

  it("drops ids that resolve to null (404)", async () => {
    api.get("/products/A", makeProduct({ id: "A" }));
    api.get("/products/missing", fail(404));
    const result = await httpAdapter.getProductsByIds(["A", "missing"]);
    expect(result.map((p) => p.id)).toEqual(["A"]);
  });

  it("makes no request at all for an empty id list", async () => {
    const result = await httpAdapter.getProductsByIds([]);
    expect(result).toEqual([]);
    expect(api.calls).toHaveLength(0);
  });
});

describe("getRelatedProducts", () => {
  it("GETs related products with the default limit", async () => {
    api.get(/\/products\/P1\/related/, [makeProduct({ id: "R1" })]);
    const result = await httpAdapter.getRelatedProducts("P1");
    expect(result).toHaveLength(1);
    expect(api.last()!.url).toContain("/products/P1/related?limit=6");
  });

  it("honours a custom limit", async () => {
    api.get(/\/products\/P1\/related/, []);
    await httpAdapter.getRelatedProducts("P1", 3);
    expect(api.last()!.url).toContain("limit=3");
  });
});

describe("getFacets", () => {
  it("GETs facets scoped by category, subcategory and search", async () => {
    api.get("/products/facets", ok({}));
    await httpAdapter.getFacets({ category: ["men"], subcategory: ["shirts"], query: "blue" });
    const request = api.last("GET", "/products/facets")!;
    expect(request.query.get("search")).toBe("blue");
    expect(request.query.get("category")).toBe("men");
    expect(request.query.get("subcategory")).toBe("shirts");
  });

  it("passes the full current query so the counts reflect active filters", async () => {
    api.get("/products/facets", ok({}));
    await httpAdapter.getFacets({
      query: "bottle",
      category: ["kitchen", "home"],
      brand: ["Anvi"],
      size: ["M"],
      color: ["Red"],
      minPrice: 100,
      maxPrice: 900,
      minRating: 4,
      minDiscount: 20,
      availability: "in-stock",
      attributes: { material: ["steel"] },
      attributeRanges: { capacity: { min: 500 } },
    });
    const request = api.last("GET", "/products/facets")!;
    expect(Object.fromEntries(request.query)).toEqual({
      search: "bottle",
      category: "kitchen,home",
      brands: "Anvi",
      sizes: "M",
      colors: "Red",
      minPrice: "100",
      maxPrice: "900",
      minRating: "4",
      minDiscount: "20",
      availability: "in-stock",
      "attr.material": "steel",
      "attr.capacity.min": "500",
    });
  });

  it("GETs unscoped facets when called with nothing", async () => {
    api.get("/products/facets", ok({}));
    await httpAdapter.getFacets();
    expect(api.last()!.query.toString()).toBe("");
  });
});

describe("categories and collections", () => {
  it("lists categories with counts", async () => {
    api.get("/categories", ok([]));
    await httpAdapter.listCategories();
    expect(api.last()!.url).toContain("withCounts=true");
  });

  it("gets a category by slug, or null on 404", async () => {
    api.get("/categories/men", { slug: "men" });
    expect(await httpAdapter.getCategoryBySlug("men")).toEqual({ slug: "men" });
    api.get("/categories/missing", fail(404));
    expect(await httpAdapter.getCategoryBySlug("missing")).toBeNull();
  });

  it("lists collections", async () => {
    api.get("/collections", ok([{ slug: "summer" }]));
    expect(await httpAdapter.listCollections()).toEqual([{ slug: "summer" }]);
  });

  it("gets a collection by slug, or null on 404", async () => {
    api.get("/collections/summer", { slug: "summer" });
    expect(await httpAdapter.getCollectionBySlug("summer")).toEqual({ slug: "summer" });
    api.get("/collections/missing", fail(404));
    expect(await httpAdapter.getCollectionBySlug("missing")).toBeNull();
  });
});

describe("reviews", () => {
  it("lists reviews filtered by productId", async () => {
    api.get("/reviews", ok([{ id: "R1" }]));
    await httpAdapter.listReviews("P1");
    expect(api.last()!.query.get("productId")).toBe("P1");
  });

  it("gets a review summary for a product", async () => {
    api.get("/reviews/summary", { average: 4.5, count: 10 });
    const result = await httpAdapter.getReviewSummary("P1");
    expect(result).toEqual({ average: 4.5, count: 10 });
    expect(api.last()!.query.get("productId")).toBe("P1");
  });
});

describe("listCoupons", () => {
  it("sends the customer's auth token", async () => {
    window.localStorage.setItem("dcz:auth-token", "cust-token");
    api.get("/coupons", ok([]));
    await httpAdapter.listCoupons();
    expect(api.last()!.headers.authorization).toBe("Bearer cust-token");
  });
});

describe("site configuration", () => {
  it("gets the site config", async () => {
    api.get("/site/config", { theme: "light" });
    expect(await httpAdapter.getSiteConfig()).toEqual({ theme: "light" });
  });

  it("gets the homepage config", async () => {
    api.get("/site/homepage", { sections: [] });
    expect(await httpAdapter.getHomepageConfig()).toEqual({ sections: [] });
  });

  it("lists banners", async () => {
    api.get("/site/banners", ok([{ id: "B1" }]));
    expect(await httpAdapter.listBanners()).toEqual([{ id: "B1" }]);
  });
});

describe("getHomeSectionLayout", () => {
  it("projects the homepage sections, defaulting active to true", async () => {
    api.get("/site/homepage", { sections: [{ id: "hero", active: false }, { id: "trending" }] });
    const layout = await httpAdapter.getHomeSectionLayout();
    expect(layout).toEqual([
      { id: "hero", active: false },
      { id: "trending", active: true },
    ]);
  });

  it("is an empty layout when there are no sections", async () => {
    api.get("/site/homepage", { sections: [] });
    expect(await httpAdapter.getHomeSectionLayout()).toEqual([]);
  });
});
