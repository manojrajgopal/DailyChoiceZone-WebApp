import { describe, expect, it, vi } from "vitest";

import { makeProduct } from "@/test/sliceA-fixtures";
import { makeFacets } from "@/test/search-fixtures";
import { api, ok, raw } from "@/test/api";
import { setLocation } from "@/test/navigation";
import { renderUI, screen, waitFor } from "@/test/render";
import { RECENT_SEARCHES_KEY } from "@/lib/search/recent-searches";

import { SearchView } from "./SearchView";

vi.mock("@/hooks/useSiteContent", () => ({
  useSiteContent: () => ({ popularSearches: ["content term"], sortOptions: [], ratingFilters: [], discountFilters: [] }),
}));

function suggest(popular: string[]) {
  api.get("/search/suggest", ok({ query: "", correctedTerm: null, products: [], categories: [], brands: [], popular }));
}

describe("SearchView", () => {
  it("shows popular searches before a search", async () => {
    setLocation("/search");
    suggest(["steel bottle"]);
    renderUI(<SearchView />);
    expect(await screen.findByRole("link", { name: "steel bottle" })).toHaveAttribute("href", "/search?q=steel%20bottle");
  });

  it("falls back to the content document's popular searches", async () => {
    setLocation("/search");
    suggest([]);
    renderUI(<SearchView />);
    await waitFor(() => expect(api.requests("GET", "/search/suggest")).toHaveLength(1));
    expect(screen.getByRole("link", { name: "content term" })).toBeInTheDocument();
  });

  it("remembers the term as a recent search and lists the results", async () => {
    setLocation("/search?q=bottle");
    api.get("/products", ok([makeProduct({ id: "PRD1", name: "Steel Bottle" })], { total: 1 }));
    api.get("/products/facets", ok(makeFacets()));
    suggest([]);
    renderUI(<SearchView />);
    expect(await screen.findByText("Steel Bottle")).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(RECENT_SEARCHES_KEY) ?? "[]")).toEqual(["bottle"]);
    expect(api.last("GET", "/products")!.query.get("search")).toBe("bottle");
  });

  it("shows popular searches on a zero-result search", async () => {
    setLocation("/search?q=zzz");
    api.get("/products", raw(200, {
      success: true,
      data: [],
      pagination: { page: 1, page_size: 24, total: 0, total_pages: 1 },
      search: { term: "zzz", correctedTerm: null, searchId: 4 },
    }));
    api.get("/products/facets", ok(makeFacets()));
    suggest(["lunch box"]);
    renderUI(<SearchView />);
    expect(await screen.findByText("No results for “zzz”")).toBeInTheDocument();
    expect(screen.getByText("Try a popular search")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "lunch box" })).toBeInTheDocument();
  });
});
