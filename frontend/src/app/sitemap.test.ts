import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, fail, ok } from "@/test/api";
import { category, collection, product, siteConfig } from "@/test/sliceE-fixtures";

import sitemap, { dynamic } from "./sitemap";

const NOW = new Date("2026-10-02T10:00:00Z");

function serveCatalogue({
  categories = [category()],
  collections = [collection()],
  pages = [[product()]],
}: { categories?: ReturnType<typeof category>[]; collections?: ReturnType<typeof collection>[]; pages?: ReturnType<typeof product>[][] } = {}) {
  api.get("/site/config", siteConfig({ url: "https://dcz.example" }));
  api.get("/categories", categories);
  api.get("/collections", collections);
  api.get("/products", (req) => {
    const page = Number(req.query.get("page") ?? "1");
    return ok(pages[page - 1] ?? [], { page, page_size: 100, total_pages: pages.length });
  });
}

describe("sitemap", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("is generated per request", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  describe("success cases", () => {
    it("lists the static pages first with their priorities", async () => {
      serveCatalogue({ categories: [], collections: [], pages: [[]] });
      const entries = await sitemap();
      expect(entries.map((entry) => [entry.url, entry.priority])).toEqual([
        ["https://dcz.example", 1],
        ["https://dcz.example/shop", 0.9],
        ["https://dcz.example/about", 0.5],
        ["https://dcz.example/contact", 0.5],
        ["https://dcz.example/faq", 0.5],
        ["https://dcz.example/shipping", 0.4],
        ["https://dcz.example/returns", 0.4],
        ["https://dcz.example/privacy", 0.3],
        ["https://dcz.example/terms", 0.3],
      ]);
      for (const entry of entries) {
        expect(entry.changeFrequency).toBe("weekly");
        expect(entry.lastModified).toEqual(NOW);
      }
    });

    it("adds every category, collection and product with their frequencies", async () => {
      serveCatalogue({
        categories: [category({ slug: "men" }), category({ id: "C2", slug: "home" })],
        collections: [collection({ slug: "summer" })],
        pages: [[product({ id: "PRD1" }), product({ id: "PRD2" })]],
      });
      const entries = (await sitemap()).slice(9);
      expect(entries).toEqual([
        { url: "https://dcz.example/category/men", lastModified: NOW, changeFrequency: "daily", priority: 0.8 },
        { url: "https://dcz.example/category/home", lastModified: NOW, changeFrequency: "daily", priority: 0.8 },
        { url: "https://dcz.example/collection/summer", lastModified: NOW, changeFrequency: "weekly", priority: 0.7 },
        { url: "https://dcz.example/product/PRD1", lastModified: NOW, changeFrequency: "weekly", priority: 0.6 },
        { url: "https://dcz.example/product/PRD2", lastModified: NOW, changeFrequency: "weekly", priority: 0.6 },
      ]);
      expect(api.last("GET", "/categories")!.query.get("withCounts")).toBe("true");
    });

    it("pages through the whole catalogue 100 at a time", async () => {
      serveCatalogue({
        categories: [],
        collections: [],
        pages: [[product({ id: "A" })], [product({ id: "B" })], [product({ id: "C" })]],
      });
      const urls = (await sitemap()).map((entry) => entry.url);
      expect(urls.slice(9)).toEqual([
        "https://dcz.example/product/A",
        "https://dcz.example/product/B",
        "https://dcz.example/product/C",
      ]);
      const requests = api.requests("GET", "/products");
      expect(requests.map((req) => req.query.get("page"))).toEqual(["1", "2", "3"]);
      expect(requests.every((req) => req.query.get("pageSize") === "100")).toBe(true);
    });
  });

  describe("error cases", () => {
    it("fails when the catalogue cannot be read", async () => {
      serveCatalogue();
      api.get("/collections", fail(500));
      await expect(sitemap()).rejects.toMatchObject({ status: 500 });
    });
  });
});
