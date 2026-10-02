import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Product } from "@/types";

import { api, fail, ok } from "@/test/api";

import { useDebounced, useSearchSuggestions } from "./useSearch";

const PRODUCT: Product = {
  id: "P1",
  slug: "p1",
  name: "Kurta",
  brand: "Brand",
  category: "women",
  subcategory: "kurtas",
  price: 100,
  originalPrice: 120,
  discount: 17,
  currency: "INR",
  rating: 4,
  reviewCount: 2,
  images: [],
  colors: [],
  sizes: [],
  description: "",
  material: "",
  tags: [],
  isNew: false,
  isTrending: false,
  isBestSeller: false,
  isFeatured: false,
  stock: 5,
  sku: "SKU1",
  care: "",
  specifications: [],
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
    expect(result.current.suggestions).toEqual({ products: [], categories: [], brands: [], total: 0 });
    expect(api.calls).toHaveLength(0);
  });

  it("debounces, then fetches suggestions for a long enough term", async () => {
    api.get(/^\/products/, ok([PRODUCT], { total: 1 }));
    const { result } = renderHook(() => useSearchSuggestions("kurta", 200));
    expect(result.current.isSearching).toBe(true);

    await tick(199);
    expect(api.calls).toHaveLength(0);
    await tick(1);

    expect(result.current.isSearching).toBe(false);
    expect(result.current.suggestions.products).toEqual([PRODUCT]);
    expect(result.current.suggestions.categories).toEqual(["women"]);
    expect(result.current.suggestions.brands).toEqual(["Brand"]);
    expect(result.current.suggestions.total).toBe(1);
  });

  it("cancels the pending fetch when the term changes before the debounce fires", async () => {
    api.get(/^\/products/, ok([PRODUCT], { total: 1 }));
    const { rerender } = renderHook(({ term }) => useSearchSuggestions(term, 200), {
      initialProps: { term: "ku" },
    });
    await tick(100);
    rerender({ term: "kurta" });
    await tick(100);
    // The first debounce window elapsed without firing a request.
    expect(api.calls).toHaveLength(0);
    await tick(100);
    expect(api.calls.length).toBeGreaterThan(0);
  });

  it("clears back to empty when the term drops below two characters again", async () => {
    api.get(/^\/products/, ok([PRODUCT], { total: 1 }));
    const { result, rerender } = renderHook(({ term }) => useSearchSuggestions(term, 200), {
      initialProps: { term: "kurta" },
    });
    await tick(200);
    expect(result.current.suggestions.total).toBe(1);

    rerender({ term: "k" });
    expect(result.current.suggestions).toEqual({ products: [], categories: [], brands: [], total: 0 });
    expect(result.current.isSearching).toBe(false);
  });

  it("resolves to empty suggestions when the request fails", async () => {
    api.get(/^\/products/, fail(500));
    const { result } = renderHook(() => useSearchSuggestions("kurta", 10));
    await tick(10);
    expect(result.current.isSearching).toBe(false);
    expect(result.current.suggestions).toEqual({ products: [], categories: [], brands: [], total: 0 });
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
