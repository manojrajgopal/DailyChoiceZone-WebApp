import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Product } from "@/types";

import { api, fail } from "@/test/api";
import { useRecentlyViewedStore } from "@/store/recentlyViewedStore";

import { useRecentlyViewed, useRecordProductView } from "./useRecentlyViewed";

function product(id: string): Product {
  return {
    id,
    slug: id,
    name: `Product ${id}`,
    brand: "Brand",
    category: "women",
    subcategory: "kurtas",
    price: 100,
    originalPrice: 100,
    discount: 0,
    currency: "INR",
    rating: 4,
    reviewCount: 0,
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
    sku: id,
    care: "",
    specifications: [],
  };
}

describe("useRecentlyViewed", () => {
  it("is empty with nothing recorded", () => {
    const { result } = renderHook(() => useRecentlyViewed());
    expect(result.current.products).toEqual([]);
    expect(result.current.ids).toEqual([]);
    expect(result.current.isEmpty).toBe(true);
    expect(result.current.isLoading).toBe(false);
  });

  it("resolves the recorded ids into full products", async () => {
    useRecentlyViewedStore.setState({ productIds: ["P1", "P2"] });
    api.get(/^\/products\/P1$/, product("P1"));
    api.get(/^\/products\/P2$/, product("P2"));

    const { result } = renderHook(() => useRecentlyViewed());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.products.map((p) => p.id)).toEqual(["P1", "P2"]);
    expect(result.current.isEmpty).toBe(false);
  });

  it("excludes the product currently on screen", () => {
    useRecentlyViewedStore.setState({ productIds: ["P1", "P2"] });
    const { result } = renderHook(() => useRecentlyViewed({ excludeId: "P1" }));
    expect(result.current.ids).toEqual(["P2"]);
  });

  it("caps the ids at the given limit", () => {
    useRecentlyViewedStore.setState({ productIds: ["P1", "P2", "P3"] });
    const { result } = renderHook(() => useRecentlyViewed({ limit: 2 }));
    expect(result.current.ids).toEqual(["P1", "P2"]);
  });

  it("resolves to an empty product list when the fetch fails", async () => {
    useRecentlyViewedStore.setState({ productIds: ["P1"] });
    api.get(/^\/products\/P1$/, fail(500));
    const { result } = renderHook(() => useRecentlyViewed());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.products).toEqual([]);
  });

  it("clear empties the recently-viewed store", () => {
    useRecentlyViewedStore.setState({ productIds: ["P1"] });
    const { result } = renderHook(() => useRecentlyViewed());
    result.current.clear();
    expect(useRecentlyViewedStore.getState().productIds).toEqual([]);
  });
});

describe("useRecordProductView", () => {
  it("records the product once per mount", () => {
    renderHook(() => useRecordProductView("P9"));
    expect(useRecentlyViewedStore.getState().productIds).toContain("P9");
  });

  it("does nothing without a product id", () => {
    renderHook(() => useRecordProductView(undefined));
    expect(useRecentlyViewedStore.getState().productIds).toEqual([]);
  });

  it("records again when the product id changes", () => {
    const { rerender } = renderHook(({ id }) => useRecordProductView(id), { initialProps: { id: "P1" } });
    rerender({ id: "P2" });
    const ids = useRecentlyViewedStore.getState().productIds;
    expect(ids).toContain("P1");
    expect(ids).toContain("P2");
  });
});
