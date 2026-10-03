import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_RECENT_SEARCHES,
  RECENT_SEARCHES_KEY,
  addRecentSearch,
  clearRecentSearches,
  readRecentSearches,
  removeRecentSearch,
} from "./recent-searches";

describe("recent searches", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts empty", () => {
    expect(readRecentSearches()).toEqual([]);
  });

  it("keeps the newest first, de-duplicated case-insensitively, trimmed", () => {
    addRecentSearch("linen shirt");
    addRecentSearch("  Bottle  ");
    expect(addRecentSearch("LINEN   shirt")).toEqual(["LINEN shirt", "Bottle"]);
    expect(readRecentSearches()).toEqual(["LINEN shirt", "Bottle"]);
  });

  it("keeps only the last eight", () => {
    for (let i = 1; i <= 10; i += 1) addRecentSearch(`term ${i}`);
    const recent = readRecentSearches();
    expect(recent).toHaveLength(MAX_RECENT_SEARCHES);
    expect(recent[0]).toBe("term 10");
    expect(recent.at(-1)).toBe("term 3");
  });

  it("ignores a blank term", () => {
    expect(addRecentSearch("   ")).toEqual([]);
    expect(window.localStorage.getItem(RECENT_SEARCHES_KEY)).toBeNull();
  });

  it("removes one, and clears all", () => {
    addRecentSearch("a1");
    addRecentSearch("b2");
    expect(removeRecentSearch("A1")).toEqual(["b2"]);
    clearRecentSearches();
    expect(readRecentSearches()).toEqual([]);
    expect(window.localStorage.getItem(RECENT_SEARCHES_KEY)).toBeNull();
  });

  it("treats a corrupt or foreign value as empty", () => {
    window.localStorage.setItem(RECENT_SEARCHES_KEY, "{not json");
    expect(readRecentSearches()).toEqual([]);
    window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify({ a: 1 }));
    expect(readRecentSearches()).toEqual([]);
    window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(["ok", 3, null, ""]));
    expect(readRecentSearches()).toEqual(["ok"]);
  });

  it("never throws when storage does", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readRecentSearches()).toEqual([]);
    expect(() => addRecentSearch("x1")).not.toThrow();
    expect(() => clearRecentSearches()).not.toThrow();
  });
});
