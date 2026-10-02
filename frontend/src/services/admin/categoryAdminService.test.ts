import { beforeEach, describe, expect, it } from "vitest";

import { api } from "@/test/api";
import { setUpAdmin } from "@/test/sliceB-admin";

import * as categories from "./categoryAdminService";

beforeEach(() => {
  setUpAdmin();
  api.get("/categories", []);
});

describe("listCategories", () => {
  it("GETs /categories with withCounts=true", async () => {
    await categories.listCategories();
    expect(api.last("GET", "/categories")!.url).toContain("withCounts=true");
  });
});

describe("countProductsByCategory", () => {
  it("maps slug to productCount, defaulting to zero", async () => {
    api.get("/categories", [
      { id: "C1", slug: "women", productCount: 12 },
      { id: "C2", slug: "men" },
    ]);
    await expect(categories.countProductsByCategory()).resolves.toEqual({ women: 12, men: 0 });
  });
});

describe("saveCategory", () => {
  const base = { id: "", name: "Women", slug: "", description: "", image: "", groups: [], order: 1, featured: false };

  it("refuses a name shorter than 2 characters", async () => {
    const result = await categories.saveCategory({ ...base, name: "W" });
    expect(result).toEqual({ ok: false, reason: "Enter a category name." });
  });

  it("derives the slug when none is given, and saves", async () => {
    api.post("/admin/categories", (req) => ({ id: "CAT9", ...req.body }));
    const result = await categories.saveCategory(base);
    expect(result).toMatchObject({ ok: true, data: { slug: "women" } });
  });

  it("refuses a slug clash with another category", async () => {
    api.get("/categories", [{ id: "CAT1", slug: "women", name: "Existing" }]);
    const result = await categories.saveCategory({ ...base, slug: "women" });
    expect(result).toEqual({ ok: false, reason: "That web address is already used by Existing. Please choose another." });
  });

  it("does not clash against itself when editing", async () => {
    api.get("/categories", [{ id: "CAT1", slug: "women", name: "Women" }]);
    api.put("/admin/categories/CAT1", {});
    const result = await categories.saveCategory({ ...base, id: "CAT1", slug: "women" });
    expect(result.ok).toBe(true);
  });
});

describe("deleteCategory", () => {
  it("refuses when the category no longer exists", async () => {
    const result = await categories.deleteCategory("missing");
    expect(result).toEqual({ ok: false, reason: "That category no longer exists." });
  });

  it("refuses while products still reference it, with correct singular/plural wording", async () => {
    api.get("/categories", [{ id: "CAT1", slug: "women", name: "Women", productCount: 1 }]);
    const result = await categories.deleteCategory("CAT1");
    expect(result).toEqual({ ok: false, reason: "Women still has 1 product. Move them first." });
  });

  it("uses the plural form for more than one product", async () => {
    api.get("/categories", [{ id: "CAT1", slug: "women", name: "Women", productCount: 3 }]);
    const result = await categories.deleteCategory("CAT1");
    expect(result).toEqual({ ok: false, reason: "Women still has 3 products. Move them first." });
  });

  it("deletes an empty category and reports its name", async () => {
    api.get("/categories", [{ id: "CAT1", slug: "women", name: "Women", productCount: 0 }]);
    api.delete("/admin/categories/CAT1", {});
    const result = await categories.deleteCategory("CAT1");
    expect(result).toEqual({ ok: true, data: "Women" });
  });
});
