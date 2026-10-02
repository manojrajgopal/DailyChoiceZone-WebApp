import { describe, expect, it } from "vitest";

import type { Category, Collection } from "@/types";
import { makeProduct } from "@/test/sliceA-fixtures";
import { api, fail, ok } from "@/test/api";

import {
  getCategories,
  getCategoryBySlug,
  getCollectionBySlug,
  getCollectionWithProducts,
  getCollections,
  getFeaturedCategories,
  getFeaturedCollections,
  getSubcategories,
} from "./categoryService";

function makeCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: "C1",
    slug: "men",
    name: "Men",
    description: "",
    image: "",
    groups: [{ name: "Clothing", items: [{ slug: "shirts", name: "Shirts" }, { slug: "pants", name: "Pants" }] }],
    order: 1,
    featured: false,
    ...overrides,
  };
}

function makeCollection(overrides: Partial<Collection> = {}): Collection {
  return {
    id: "COL1",
    slug: "summer",
    name: "Summer Edit",
    description: "",
    image: "",
    productIds: ["P1", "P2"],
    featured: false,
    ...overrides,
  };
}

describe("getCategories", () => {
  it("GETs every category with counts", async () => {
    api.get("/categories", ok([makeCategory()]));
    const result = await getCategories();
    expect(result).toHaveLength(1);
    expect(api.last()!.url).toContain("withCounts=true");
  });
});

describe("getFeaturedCategories", () => {
  it("filters to featured categories only", async () => {
    api.get("/categories", ok([makeCategory({ id: "A", featured: true }), makeCategory({ id: "B", featured: false })]));
    const result = await getFeaturedCategories();
    expect(result.map((c) => c.id)).toEqual(["A"]);
  });

  it("applies a limit when given", async () => {
    api.get("/categories", ok([
      makeCategory({ id: "A", featured: true }),
      makeCategory({ id: "B", featured: true }),
      makeCategory({ id: "C", featured: true }),
    ]));
    const result = await getFeaturedCategories(2);
    expect(result).toHaveLength(2);
  });

  it("returns every featured category when no limit is given", async () => {
    api.get("/categories", ok([makeCategory({ id: "A", featured: true }), makeCategory({ id: "B", featured: true })]));
    expect(await getFeaturedCategories()).toHaveLength(2);
  });
});

describe("getCategoryBySlug", () => {
  it("GETs a category by slug", async () => {
    api.get("/categories/men", makeCategory());
    expect(await getCategoryBySlug("men")).toMatchObject({ slug: "men" });
  });

  it("is null for an unknown slug", async () => {
    api.get("/categories/missing", fail(404));
    expect(await getCategoryBySlug("missing")).toBeNull();
  });
});

describe("getSubcategories", () => {
  it("flattens every group's items", async () => {
    api.get("/categories/men", makeCategory({
      groups: [
        { name: "Clothing", items: [{ slug: "shirts", name: "Shirts" }] },
        { name: "Accessories", items: [{ slug: "belts", name: "Belts" }] },
      ],
    }));
    const result = await getSubcategories("men");
    expect(result).toEqual([{ slug: "shirts", name: "Shirts" }, { slug: "belts", name: "Belts" }]);
  });

  it("is empty for an unknown category", async () => {
    api.get("/categories/missing", fail(404));
    expect(await getSubcategories("missing")).toEqual([]);
  });

  it("is empty when the category has no groups", async () => {
    api.get("/categories/men", makeCategory({ groups: [] }));
    expect(await getSubcategories("men")).toEqual([]);
  });
});

describe("collections", () => {
  it("lists collections", async () => {
    api.get("/collections", ok([makeCollection()]));
    expect(await getCollections()).toHaveLength(1);
  });

  it("filters featured collections, honouring a limit", async () => {
    api.get("/collections", ok([
      makeCollection({ id: "A", featured: true }),
      makeCollection({ id: "B", featured: false }),
      makeCollection({ id: "C", featured: true }),
    ]));
    expect((await getFeaturedCollections()).map((c) => c.id)).toEqual(["A", "C"]);
    api.get("/collections", ok([
      makeCollection({ id: "A", featured: true }),
      makeCollection({ id: "C", featured: true }),
    ]));
    expect(await getFeaturedCollections(1)).toHaveLength(1);
  });

  it("gets a collection by slug, or null", async () => {
    api.get("/collections/summer", makeCollection());
    expect(await getCollectionBySlug("summer")).toMatchObject({ slug: "summer" });
    api.get("/collections/missing", fail(404));
    expect(await getCollectionBySlug("missing")).toBeNull();
  });
});

describe("getCollectionWithProducts", () => {
  it("resolves the collection's product ids", async () => {
    api.get("/collections/summer", makeCollection({ productIds: ["P1", "P2"] }));
    api.get("/products/P1", makeProduct({ id: "P1" }));
    api.get("/products/P2", makeProduct({ id: "P2" }));
    const result = await getCollectionWithProducts("summer");
    expect(result?.collection.slug).toBe("summer");
    expect(result?.products.map((p) => p.id)).toEqual(["P1", "P2"]);
  });

  it("is null for an unknown collection, without resolving any products", async () => {
    api.get("/collections/missing", fail(404));
    const result = await getCollectionWithProducts("missing");
    expect(result).toBeNull();
    expect(api.requests("GET", /\/products\//)).toHaveLength(0);
  });
});
