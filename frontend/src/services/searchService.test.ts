import { afterEach, describe, expect, it, vi } from "vitest";

import { api, fail, hang, networkError, ok } from "@/test/api";
import { signIn } from "@/test/render";

import { getSearchSuggestions, resultPosition, searchProducts, trackSearchClick } from "./searchService";

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
  const SUGGEST = {
    query: "bot",
    correctedTerm: null,
    products: [
      { id: "PRD007", slug: "steel-bottle", name: "Steel Bottle", brand: "Anvi", image: "https://x/i.jpg", price: 499, originalPrice: 699 },
    ],
    categories: [{ slug: "kitchen", name: "Kitchen" }],
    brands: [{ value: "Botanica", label: "Botanica" }],
    popular: ["steel bottle", "lunch box"],
  };

  it("GETs /search/suggest with the trimmed term and limit, and returns the payload", async () => {
    api.get("/search/suggest", ok(SUGGEST));
    const result = await getSearchSuggestions("  bot ", { limit: 4 });
    const request = api.last("GET", "/search/suggest")!;
    expect(request.query.get("q")).toBe("bot");
    expect(request.query.get("limit")).toBe("4");
    expect(result).toEqual(SUGGEST);
  });

  it("clamps the limit to the API's 1-10", async () => {
    api.get("/search/suggest", ok(SUGGEST));
    await getSearchSuggestions("bot", { limit: 50 });
    expect(api.last()!.query.get("limit")).toBe("10");
    await getSearchSuggestions("bot", { limit: 0 });
    expect(api.last()!.query.get("limit")).toBe("1");
  });

  it("asks with a blank term for the popular searches only", async () => {
    api.get("/search/suggest", ok({ ...SUGGEST, query: "", products: [], categories: [], brands: [] }));
    const result = await getSearchSuggestions("");
    expect(api.last()!.query.has("q")).toBe(false);
    expect(result.popular).toEqual(["steel bottle", "lunch box"]);
    expect(result.products).toEqual([]);
  });

  it("fills missing lists so callers can map over them safely", async () => {
    api.get("/search/suggest", ok({ query: "x" }));
    expect(await getSearchSuggestions("xx")).toEqual({
      query: "x",
      correctedTerm: null,
      products: [],
      categories: [],
      brands: [],
      popular: [],
    });
  });

  it("passes the correction through", async () => {
    api.get("/search/suggest", ok({ ...SUGGEST, query: "botle", correctedTerm: "bottle" }));
    expect((await getSearchSuggestions("botle")).correctedTerm).toBe("bottle");
  });

  it("rejects when the request fails", async () => {
    api.get("/search/suggest", fail(500));
    await expect(getSearchSuggestions("bot")).rejects.toMatchObject({ status: 500 });
  });

  it("stops when its signal is aborted", async () => {
    api.get("/search/suggest", hang());
    const controller = new AbortController();
    const pending = getSearchSuggestions("bot", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeTruthy();
  });
});

describe("resultPosition", () => {
  it("is 1-based over the whole result list", () => {
    expect(resultPosition(1, 24, 0)).toBe(1);
    expect(resultPosition(1, 24, 2)).toBe(3);
    expect(resultPosition(2, 24, 0)).toBe(25);
    expect(resultPosition(3, 10, 4)).toBe(25);
  });

  it("never goes below 1 for a junk page", () => {
    expect(resultPosition(0, 24, 0)).toBe(1);
  });
});

describe("trackSearchClick", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs the click as a keepalive request with the visitor id", async () => {
    window.localStorage.setItem("dcz:visitor", "visitor-abc123");
    const spy = vi.spyOn(globalThis, "fetch");
    trackSearchClick({ searchId: 812, productId: "PRD007", position: 3 });
    await vi.waitFor(() => expect(api.last("POST", "/search/click")).toBeDefined());

    expect(api.last("POST", "/search/click")!.body).toEqual({
      searchId: 812,
      productId: "PRD007",
      position: 3,
      visitorId: "visitor-abc123",
    });
    const init = spy.mock.calls.at(-1)![1] as RequestInit;
    expect(init.keepalive).toBe(true);
    expect(init.method).toBe("POST");
  });

  it("sends the shopper's token when signed in", async () => {
    signIn("customer", "tok");
    trackSearchClick({ searchId: 1, productId: "P1", position: 1 });
    await vi.waitFor(() => expect(api.last("POST", "/search/click")).toBeDefined());
    expect(api.last("POST", "/search/click")!.headers.authorization).toBe("Bearer tok");
  });

  it("swallows a failure, a network error and a throwing fetch", async () => {
    api.post("/search/click", fail(429));
    expect(() => trackSearchClick({ searchId: 1, productId: "P1", position: 1 })).not.toThrow();

    api.post("/search/click", networkError());
    expect(() => trackSearchClick({ searchId: 1, productId: "P1", position: 1 })).not.toThrow();

    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => trackSearchClick({ searchId: 1, productId: "P1", position: 1 })).not.toThrow();
    // Let the rejected promises settle: none may surface as unhandled.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("sends nothing without a valid search id, product or position", () => {
    trackSearchClick({ searchId: 0, productId: "P1", position: 1 });
    trackSearchClick({ searchId: 1, productId: "", position: 1 });
    trackSearchClick({ searchId: 1, productId: "P1", position: 0 });
    expect(api.requests("POST", "/search/click")).toHaveLength(0);
  });
});
