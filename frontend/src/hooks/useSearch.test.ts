import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SearchSuggestions } from "@/types";

import { api, fail, hang, ok } from "@/test/api";

import { useDebounced, usePopularSearches, useSearchSuggestions } from "./useSearch";

const SUGGEST: SearchSuggestions = {
  query: "kurta",
  correctedTerm: null,
  products: [{ id: "P1", slug: "p1", name: "Kurta", brand: "Brand", image: "", price: 100, originalPrice: 120 }],
  categories: [{ slug: "women", name: "Women" }],
  brands: [{ value: "Brand", label: "Brand" }],
  popular: ["linen"],
};

const EMPTY: SearchSuggestions = {
  query: "",
  correctedTerm: null,
  products: [],
  categories: [],
  brands: [],
  popular: [],
};

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useSearchSuggestions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing for a term shorter than two characters", () => {
    const { result } = renderHook(() => useSearchSuggestions("a"));
    expect(result.current.isSearching).toBe(false);
    expect(result.current.suggestions).toEqual(EMPTY);
    expect(api.calls).toHaveLength(0);
  });

  it("debounces, then fetches suggestions from /search/suggest for a long enough term", async () => {
    api.get("/search/suggest", ok(SUGGEST));
    const { result } = renderHook(() => useSearchSuggestions("kurta", 200));
    expect(result.current.isSearching).toBe(true);

    await tick(199);
    expect(api.calls).toHaveLength(0);
    await tick(1);

    expect(result.current.isSearching).toBe(false);
    expect(api.last("GET", "/search/suggest")!.query.get("q")).toBe("kurta");
    expect(result.current.suggestions).toEqual(SUGGEST);
  });

  it("cancels the pending fetch when the term changes before the debounce fires", async () => {
    api.get("/search/suggest", ok(SUGGEST));
    const { rerender } = renderHook(({ term }) => useSearchSuggestions(term, 200), {
      initialProps: { term: "ku" },
    });
    await tick(100);
    rerender({ term: "kurta" });
    await tick(100);
    // The first debounce window elapsed without firing a request.
    expect(api.calls).toHaveLength(0);
    await tick(100);
    expect(api.calls).toHaveLength(1);
    expect(api.last()!.query.get("q")).toBe("kurta");
  });

  it("aborts a request in flight that a newer term made stale, and never shows its answer", async () => {
    api.get("/search/suggest", (request) =>
      request.query.get("q") === "ku" ? hang() : ok({ ...SUGGEST, query: "kurta" }),
    );
    const { result, rerender } = renderHook(({ term }) => useSearchSuggestions(term, 50), {
      initialProps: { term: "ku" },
    });
    await tick(50);
    expect(api.calls).toHaveLength(1);

    rerender({ term: "kurta" });
    expect(result.current.isSearching).toBe(true);
    await tick(50);

    expect(api.calls).toHaveLength(2);
    expect(result.current.isSearching).toBe(false);
    expect(result.current.suggestions.query).toBe("kurta");
  });

  it("clears back to empty when the term drops below two characters again", async () => {
    api.get("/search/suggest", ok(SUGGEST));
    const { result, rerender } = renderHook(({ term }) => useSearchSuggestions(term, 200), {
      initialProps: { term: "kurta" },
    });
    await tick(200);
    expect(result.current.suggestions.products).toHaveLength(1);

    rerender({ term: "k" });
    expect(result.current.suggestions).toEqual(EMPTY);
    expect(result.current.isSearching).toBe(false);
  });

  it("resolves to empty suggestions when the request fails", async () => {
    api.get("/search/suggest", fail(500));
    const { result } = renderHook(() => useSearchSuggestions("kurta", 10));
    await tick(10);
    expect(result.current.isSearching).toBe(false);
    expect(result.current.suggestions).toEqual(EMPTY);
  });
});

describe("usePopularSearches", () => {
  it("shows the fallback, then the server's popular searches", async () => {
    api.get("/search/suggest", ok({ ...EMPTY, popular: ["steel bottle"] }));
    const { result } = renderHook(() => usePopularSearches(["linen"]));
    expect(result.current).toEqual(["linen"]);
    await waitFor(() => expect(result.current).toEqual(["steel bottle"]));
    expect(api.last()!.query.has("q")).toBe(false);
  });

  it("keeps the fallback when the server has none or fails", async () => {
    api.get("/search/suggest", ok(EMPTY));
    const { result } = renderHook(() => usePopularSearches(["linen"]));
    await waitFor(() => expect(api.calls).toHaveLength(1));
    expect(result.current).toEqual(["linen"]);

    api.get("/search/suggest", fail(500));
    const failed = renderHook(() => usePopularSearches(["wool"]));
    await waitFor(() => expect(api.calls).toHaveLength(2));
    expect(failed.result.current).toEqual(["wool"]);
  });

  it("fetches nothing when disabled", () => {
    renderHook(() => usePopularSearches([], false));
    expect(api.calls).toHaveLength(0);
  });
});

describe("useDebounced", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the initial value until the delay elapses after a change", async () => {
    const { result, rerender } = renderHook(({ value }) => useDebounced(value, 300), {
      initialProps: { value: "a" },
    });
    expect(result.current).toBe("a");

    rerender({ value: "b" });
    expect(result.current).toBe("a");

    await tick(299);
    expect(result.current).toBe("a");
    await tick(1);
    expect(result.current).toBe("b");
  });

  it("only reflects the final value when it changes rapidly", async () => {
    const { result, rerender } = renderHook(({ value }) => useDebounced(value, 300), {
      initialProps: { value: 1 },
    });
    rerender({ value: 2 });
    await tick(100);
    rerender({ value: 3 });
    await tick(299);
    expect(result.current).toBe(1);
    await tick(1);
    expect(result.current).toBe(3);
  });
});
