import { describe, expect, it, vi } from "vitest";

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
    expect(recent().viewedAt).toEqual({});
  });

  it("persists and rehydrates the list, with when each was viewed", async () => {
    vi.setSystemTime(new Date("2026-10-02T10:00:00Z"));
    recent().record("A");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({
      state: { productIds: ["A"], viewedAt: { A: Date.parse("2026-10-02T10:00:00Z") } },
      version: 2,
    });
    localStorage.setItem(KEY, JSON.stringify({ state: { productIds: ["Z", "Y"], viewedAt: { Z: 2, Y: 1 } }, version: 2 }));
    await useRecentlyViewedStore.persist.rehydrate();
    expect(recent().productIds).toEqual(["Z", "Y"]);
    expect(recent().viewedAt).toEqual({ Z: 2, Y: 1 });
    vi.useRealTimers();
  });

  it("still reads a list saved before views were timed (version 1)", async () => {
    localStorage.setItem(KEY, JSON.stringify({ state: { productIds: ["Z", "Y"] }, version: 1 }));
    await useRecentlyViewedStore.persist.rehydrate();
    expect(recent().productIds).toEqual(["Z", "Y"]);
    expect(recent().viewedAt).toEqual({});
  });

  it("times each view and forgets the times of what fell off", () => {
    for (let i = 1; i <= 13; i++) recent().record(`P${i}`);
    expect(Object.keys(recent().viewedAt)).toHaveLength(12);
    expect(recent().viewedAt.P1).toBeUndefined();
    expect(recent().viewedAt.P13).toBeGreaterThan(0);
  });

  it("removes one product", () => {
    recent().record("A");
    recent().record("B");
    recent().remove("A");
    expect(recent().productIds).toEqual(["B"]);
    expect(recent().viewedAt.A).toBeUndefined();
  });
});
