import { beforeEach, describe, expect, it } from "vitest";

import { api } from "@/test/api";
import { setUpAdmin } from "@/test/sliceB-admin";

import * as collections from "./collectionAdminService";

beforeEach(() => {
  setUpAdmin();
  api.get("/collections", []);
  api.get("/admin/products", []);
});

describe("listCollections / getCollection", () => {
  it("listCollections GETs /collections", async () => {
    await collections.listCollections();
    expect(api.last("GET", "/collections")!.headers.authorization).toBeUndefined();
  });

  it("getCollection finds by id, or null when missing", async () => {
    api.get("/collections", [{ id: "COL1", name: "Sale" }]);
    await expect(collections.getCollection("COL1")).resolves.toMatchObject({ id: "COL1" });
    await expect(collections.getCollection("missing")).resolves.toBeNull();
  });
});

describe("saveCollection", () => {
  const base = { id: "", name: "Summer Sale", slug: "", description: "", image: "", productIds: ["P1"], featured: false };

  it("refuses a name shorter than 2 characters", async () => {
    const result = await collections.saveCollection({ ...base, name: "S" });
    expect(result).toEqual({ ok: false, reason: "Enter a collection name." });
  });

  it("refuses an empty product list", async () => {
    const result = await collections.saveCollection({ ...base, productIds: [] });
    expect(result).toEqual({ ok: false, reason: "Add at least one product to the collection." });
  });

  it("derives the slug from the name when none is given", async () => {
    api.post("/admin/collections", (req) => ({ id: "COL9", ...req.body }));
    const result = await collections.saveCollection(base);
    expect(result).toMatchObject({ ok: true, data: { slug: "summer-sale" } });
  });

  it("refuses a slug already used by another collection", async () => {
    api.get("/collections", [{ id: "COL1", slug: "summer-sale", name: "Existing" }]);
    const result = await collections.saveCollection({ ...base, slug: "summer-sale" });
    expect(result).toEqual({ ok: false, reason: "That web address is already used by Existing. Please choose another." });
  });

  it("allows keeping its own slug on an edit", async () => {
    api.get("/collections", [{ id: "COL1", slug: "summer-sale", name: "Summer Sale" }]);
    api.put("/admin/collections/COL1", {});
    const result = await collections.saveCollection({ ...base, id: "COL1", slug: "summer-sale" });
    expect(result.ok).toBe(true);
  });

  it("drops product ids that no longer exist in the catalogue", async () => {
    api.get("/admin/products", [{ id: "P1" }]);
    api.post("/admin/collections", (req) => ({ id: "COL9", ...req.body }));
    const result = await collections.saveCollection({ ...base, productIds: ["P1", "P2"] });
    expect(result).toMatchObject({ ok: true, data: { productIds: ["P1"] } });
  });
});

describe("deleteCollection", () => {
  it("refuses when the collection no longer exists", async () => {
    const result = await collections.deleteCollection("missing");
    expect(result).toEqual({ ok: false, reason: "That collection no longer exists." });
  });

  it("deletes an existing collection and reports its name", async () => {
    api.get("/collections", [{ id: "COL1", name: "Sale" }]);
    api.delete("/admin/collections/COL1", {});
    const result = await collections.deleteCollection("COL1");
    expect(result).toEqual({ ok: true, data: "Sale" });
  });
});
