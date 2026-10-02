import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Product, ProductFacets } from "@/types";

import { api, fail, ok } from "@/test/api";

import { useFacets, useProducts, useRelatedProducts } from "./useProducts";

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

describe("useProducts", () => {
  it("fetches the query and resolves with a paginated result", async () => {
    api.get(/^\/products/, ok([PRODUCT], { total: 1, total_pages: 1 }));
    const { result } = renderHook(() => useProducts({ page: 1 }));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.items).toEqual([PRODUCT]);
    expect(api.last("GET")!.query.get("page")).toBe("1");
  });

  it("re-fetches when the query object changes", async () => {
    api.get(/^\/products/, ok([PRODUCT], { total: 1 }));
    const { result, rerender } = renderHook(({ query }) => useProducts(query), {
      initialProps: { query: { page: 1 } },
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    rerender({ query: { page: 2 } });
    await waitFor(() => expect(api.requests("GET").length).toBe(2));
    expect(api.last("GET")!.query.get("page")).toBe("2");
  });

  it("surfaces a request failure", async () => {
    api.get(/^\/products/, fail(500, "Server error"));
    const { result } = renderHook(() => useProducts({}));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toBe("Server error");
  });
});

describe("useFacets", () => {
  const FACETS = { categories: [], brands: [], sizes: [], colors: [], priceRange: { min: 0, max: 1000 } } as unknown as ProductFacets;

  it("fetches facets for the given scope", async () => {
    api.get(/^\/products\/facets/, FACETS);
    const { result } = renderHook(() => useFacets({ category: ["women"] }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual(FACETS);
  });

  it("fetches unscoped facets when none is given", async () => {
    api.get(/^\/products\/facets/, FACETS);
    const { result } = renderHook(() => useFacets());
    await waitFor(() => expect(result.current.data).toEqual(FACETS));
  });
});

describe("useRelatedProducts", () => {
  it("fetches related products for a given id", async () => {
    api.get(/\/products\/P1\/related/, [PRODUCT]);
    const { result } = renderHook(() => useRelatedProducts("P1"));
    await waitFor(() => expect(result.current.data).toEqual([PRODUCT]));
    expect(api.last("GET")!.path).toBe("/products/P1/related");
  });

  it("is disabled, with an empty array, when there is no product id", () => {
    const { result } = renderHook(() => useRelatedProducts(undefined));
    expect(result.current.data).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(api.calls).toHaveLength(0);
  });

  it("passes a custom limit through", async () => {
    api.get(/\/related/, []);
    renderHook(() => useRelatedProducts("P1", 3));
    await waitFor(() => expect(api.calls.length).toBeGreaterThan(0));
    expect(api.last("GET")!.query.get("limit")).toBe("3");
  });
});
