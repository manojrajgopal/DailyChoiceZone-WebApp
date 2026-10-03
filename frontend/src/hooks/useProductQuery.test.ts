import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { router, setLocation } from "@/test/navigation";

import { useProductQuery } from "./useProductQuery";

describe("useProductQuery", () => {
  it("parses the current URL into a query", () => {
    setLocation("/shop?page=2&sort=newest&brand=Nike,Adidas");
    const { result } = renderHook(() => useProductQuery({ basePath: "/shop" }));
    expect(result.current.urlQuery).toMatchObject({ page: 2, sort: "newest", brand: ["Nike", "Adidas"] });
  });

  it("merges in route-locked filters without exposing them as removable", () => {
    setLocation("/category/women?brand=Nike");
    const { result } = renderHook(() =>
      useProductQuery({ basePath: "/category/women", locked: { category: ["women"] } }),
    );
    expect(result.current.query.category).toEqual(["women"]);
    expect(result.current.urlQuery.category).toBeUndefined();
    expect(result.current.activeFilterCount).toBe(1); // only brand counts, not the locked category
  });

  it("locked query (a search term) is also merged into the effective query", () => {
    setLocation("/shop");
    const { result } = renderHook(() =>
      useProductQuery({ basePath: "/shop", locked: { query: "kurta" } }),
    );
    expect(result.current.query.query).toBe("kurta");
  });

  describe("setSort", () => {
    it("pushes the new sort and resets to page 1", () => {
      setLocation("/shop?page=3");
      const { result } = renderHook(() => useProductQuery({ basePath: "/shop" }));
      result.current.setSort("price-asc");
      expect(router.push).toHaveBeenCalledWith(expect.stringContaining("sort=price-asc"), { scroll: false });
      expect(router.push).toHaveBeenCalledWith(expect.not.stringContaining("page=3"), { scroll: false });
    });
  });

  describe("toggleFilter", () => {
    it("adds a value that isn't selected yet", () => {
      setLocation("/shop");
      const { result } = renderHook(() => useProductQuery({ basePath: "/shop" }));
      result.current.toggleFilter("brand", "Nike");
      expect(router.push).toHaveBeenCalledWith(expect.stringContaining("brand=Nike"), { scroll: false });
    });

    it("removes a value that is already selected", () => {
      setLocation("/shop?brand=Nike");
      const { result } = renderHook(() => useProductQuery({ basePath: "/shop" }));
      result.current.toggleFilter("brand", "Nike");
      expect(router.push).toHaveBeenCalledWith(expect.not.stringContaining("brand"), { scroll: false });
    });
  });

  describe("setPriceRange", () => {
    it("sets both bounds", () => {
      setLocation("/shop");
      const { result } = renderHook(() => useProductQuery({ basePath: "/shop" }));
      result.current.setPriceRange(100, 500);
      const url = (router.push as unknown as { mock: { calls: [string][] } }).mock.calls.at(-1)![0];
      expect(url).toContain("minPrice=100");
      expect(url).toContain("maxPrice=500");
    });

    it("clears a bound left undefined", () => {
      setLocation("/shop?minPrice=100&maxPrice=500");
      const { result } = renderHook(() => useProductQuery({ basePath: "/shop" }));
      result.current.setPriceRange(undefined, 500);
      const url = (router.push as unknown as { mock: { calls: [string][] } }).mock.calls.at(-1)![0];
      expect(url).not.toContain("minPrice");
      expect(url).toContain("maxPrice=500");
    });

    it("clears the upper bound too when it is left undefined", () => {
      setLocation("/shop?minPrice=100&maxPrice=500");
      const { result } = renderHook(() => useProductQuery({ basePath: "/shop" }));
      result.current.setPriceRange(100, undefined);
      const url = (router.push as unknown as { mock: { calls: [string][] } }).mock.calls.at(-1)![0];
      expect(url).toContain("minPrice=100");
      expect(url).not.toContain("maxPrice");
    });
  });

  describe("setMinRating", () => {
    it("sets a rating filter", () => {
      setLocation("/shop");
      const { result } = renderHook(() => useProductQuery({ basePath: "/shop" }));
      result.current.setMinRating(4);
      expect(router.push).toHaveBeenCalledWith(expect.stringContaining("minRating=4"), { scroll: false });
    });

    it("clears the rating when the same value is passed again (toggle off)", () => {
      setLocation("/shop?minRating=4");
      const { result } = renderHook(() => useProductQuery({ basePath: "/shop" }));
      result.current.setMinRating(4);
      expect(router.push).toHaveBeenCalledWith(expect.not.stringContaining("minRating"), { scroll: false });
    });
  });

  describe("setMinDiscount", () => {
    it("sets and toggles off a discount filter", () => {
      setLocation("/shop");
      const { result, rerender } = renderHook(() => useProductQuery({ basePath: "/shop" }));
      result.current.setMinDiscount(20);
      expect(router.push).toHaveBeenCalledWith(expect.stringContaining("minDiscount=20"), { scroll: false });

      setLocation("/shop?minDiscount=20");
      rerender();
      result.current.setMinDiscount(20);
      expect(router.push).toHaveBeenCalledWith(expect.not.stringContaining("minDiscount"), { scroll: false });
    });
  });

  describe("setInStockOnly", () => {
    it("sets and clears the flag", () => {
      setLocation("/shop");
      const { result, rerender } = renderHook(() => useProductQuery({ basePath: "/shop" }));
      result.current.setInStockOnly(true);
      expect(router.push).toHaveBeenCalledWith(expect.stringContaining("inStock=1"), { scroll: false });

      setLocation("/shop?inStock=1");
      rerender();
      result.current.setInStockOnly(false);
      expect(router.push).toHaveBeenCalledWith(expect.not.stringContaining("inStock"), { scroll: false });
    });
  });

  describe("setPage", () => {
    it("pushes the page and scrolls, unlike every other setter", () => {
      setLocation("/shop");
      const { result } = renderHook(() => useProductQuery({ basePath: "/shop" }));
      result.current.setPage(3);
      expect(router.push).toHaveBeenCalledWith(expect.stringContaining("page=3"), { scroll: true });
    });
  });

  describe("clearAll", () => {
    it("clears every user-chosen filter", () => {
      setLocation("/shop?brand=Nike&minPrice=100&sort=newest");
      const { result } = renderHook(() => useProductQuery({ basePath: "/shop" }));
      result.current.clearAll();
      const url = (router.push as unknown as { mock: { calls: [string][] } }).mock.calls.at(-1)![0];
      expect(url).not.toContain("brand");
      expect(url).not.toContain("minPrice");
    });
  });

  describe("activeFilterCount", () => {
    it("counts zero with no filters applied", () => {
      setLocation("/shop");
      const { result } = renderHook(() => useProductQuery({ basePath: "/shop" }));
      expect(result.current.activeFilterCount).toBe(0);
    });

    it("counts multiple active filters", () => {
      setLocation("/shop?brand=Nike&minPrice=100&minRating=4");
      const { result } = renderHook(() => useProductQuery({ basePath: "/shop" }));
      expect(result.current.activeFilterCount).toBeGreaterThanOrEqual(3);
    });
  });

  describe("search & filters setters", () => {
    it("sets and clears availability", () => {
      setLocation("/shop?page=2");
      const { result, rerender } = renderHook(() => useProductQuery({ basePath: "/shop" }));
      result.current.setAvailability("in-stock");
      expect(router.push).toHaveBeenLastCalledWith("/shop?availability=in-stock", { scroll: false });

      setLocation("/shop?availability=in-stock");
      rerender();
      result.current.setAvailability("in-stock");
      expect(router.push).toHaveBeenLastCalledWith("/shop", { scroll: false });
    });

    it("toggles an attribute value", () => {
      setLocation("/shop?attr.material=steel");
      const { result } = renderHook(() => useProductQuery({ basePath: "/shop" }));
      result.current.toggleAttribute("material", "glass");
      expect(router.push).toHaveBeenLastCalledWith("/shop?attr.material=steel%2Cglass", { scroll: false });
    });

    it("sets and clears an attribute range", () => {
      setLocation("/shop");
      const { result, rerender } = renderHook(() => useProductQuery({ basePath: "/shop" }));
      result.current.setAttributeRange("capacity", 250, 1000);
      expect(router.push).toHaveBeenLastCalledWith("/shop?attr.capacity.min=250&attr.capacity.max=1000", { scroll: false });

      setLocation("/shop?attr.capacity.min=250");
      rerender();
      result.current.setAttributeRange("capacity", undefined, undefined);
      expect(router.push).toHaveBeenLastCalledWith("/shop", { scroll: false });
    });

    it("applies a whole query with push, or replace while typing", () => {
      setLocation("/shop");
      const { result } = renderHook(() => useProductQuery({ basePath: "/shop" }));
      result.current.apply({ brand: ["Anvi"], page: 1 });
      expect(router.push).toHaveBeenLastCalledWith("/shop?brand=Anvi", { scroll: false });
      result.current.apply({ minPrice: 15 }, { replace: true });
      expect(router.replace).toHaveBeenLastCalledWith("/shop?minPrice=15", { scroll: false });
      expect(router.push).toHaveBeenCalledTimes(1);
    });

    it("counts attribute filters and ranges as active", () => {
      setLocation("/shop?attr.material=steel,glass&attr.capacity.min=1&availability=in-stock");
      const { result } = renderHook(() => useProductQuery({ basePath: "/shop" }));
      expect(result.current.activeFilterCount).toBe(4);
    });
  });
});
