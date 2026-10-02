import { describe, expect, it } from "vitest";

import { useRecentlyViewedStore } from "./recentlyViewedStore";

const KEY = "dcz:recently-viewed";
const recent = () => useRecentlyViewedStore.getState();

describe("useRecentlyViewedStore", () => {
  it("starts empty", () => {
    expect(recent().productIds).toEqual([]);
  });

  it("puts the latest view first", () => {
    recent().record("A");
    recent().record("B");
    expect(recent().productIds).toEqual(["B", "A"]);
  });

  it("moves a re-viewed product to the front instead of duplicating it", () => {
    ["A", "B", "C"].forEach((id) => recent().record(id));
    recent().record("A");
    expect(recent().productIds).toEqual(["A", "C", "B"]);
  });

  it("remembers at most 12 products, dropping the oldest", () => {
    for (let i = 1; i <= 15; i++) recent().record(`P${i}`);
    expect(recent().productIds).toHaveLength(12);
    expect(recent().productIds[0]).toBe("P15");
    expect(recent().productIds.at(-1)).toBe("P4");
  });

  it("keeps exactly 12 at the boundary", () => {
    for (let i = 1; i <= 12; i++) recent().record(`P${i}`);
    expect(recent().productIds).toHaveLength(12);
    expect(recent().productIds.at(-1)).toBe("P1");
  });

  it("clears", () => {
    recent().record("A");
    recent().clear();
    expect(recent().productIds).toEqual([]);
  });

  it("persists and rehydrates the list", async () => {
    recent().record("A");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ state: { productIds: ["A"] }, version: 1 });
    localStorage.setItem(KEY, JSON.stringify({ state: { productIds: ["Z", "Y"] }, version: 1 }));
    await useRecentlyViewedStore.persist.rehydrate();
    expect(recent().productIds).toEqual(["Z", "Y"]);
  });
});
