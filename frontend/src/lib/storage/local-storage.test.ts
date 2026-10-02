import { afterEach, describe, expect, it, vi } from "vitest";

import { STORAGE_KEYS, clearAll, readJson, remove, writeJson } from "./local-storage";

describe("readJson / writeJson", () => {
  it("round-trips a value", () => {
    expect(writeJson("k", { a: 1 })).toBe(true);
    expect(readJson("k", null)).toEqual({ a: 1 });
  });

  it("returns the fallback when the key is absent", () => {
    expect(readJson("missing", "fallback")).toBe("fallback");
  });

  it("returns the fallback for corrupt JSON instead of throwing", () => {
    window.localStorage.setItem("bad", "{not json");
    expect(readJson("bad", "fallback")).toBe("fallback");
  });

  it("stores primitives, arrays and null", () => {
    writeJson("num", 42);
    expect(readJson("num", 0)).toBe(42);
    writeJson("arr", [1, 2, 3]);
    expect(readJson<number[]>("arr", [])).toEqual([1, 2, 3]);
    writeJson("nil", null);
    expect(readJson("nil", "fallback")).toBeNull();
  });
});

describe("remove", () => {
  it("deletes a single key, leaving others", () => {
    writeJson("a", 1);
    writeJson("b", 2);
    remove("a");
    expect(readJson("a", null)).toBeNull();
    expect(readJson("b", null)).toBe(2);
  });

  it("does nothing for a key that doesn't exist", () => {
    expect(() => remove("nope")).not.toThrow();
  });
});

describe("clearAll", () => {
  it("removes every namespaced key, but not unrelated ones", () => {
    Object.values(STORAGE_KEYS).forEach((key) => window.localStorage.setItem(key, "1"));
    window.localStorage.setItem("unrelated-key", "keep-me");
    clearAll();
    Object.values(STORAGE_KEYS).forEach((key) => expect(window.localStorage.getItem(key)).toBeNull());
    expect(window.localStorage.getItem("unrelated-key")).toBe("keep-me");
  });
});

describe("degraded storage (private browsing / blocked)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("readJson returns the fallback instead of throwing when getItem throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readJson("k", "fallback")).toBe("fallback");
  });

  it("writeJson returns false instead of throwing when setItem throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(writeJson("k", "v")).toBe(false);
  });

  it("remove and clearAll do not throw when removeItem throws", () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => remove("k")).not.toThrow();
    expect(() => clearAll()).not.toThrow();
  });

  it("treats a window.localStorage getter that throws (some private-browsing modes) as unavailable", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      expect(readJson("k", "fallback")).toBe("fallback");
      expect(writeJson("k", "v")).toBe(false);
    } finally {
      if (original) Object.defineProperty(window, "localStorage", original);
    }
  });

  it("treats a missing window.localStorage as unavailable", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", { value: undefined, configurable: true });
    try {
      expect(readJson("k", "fallback")).toBe("fallback");
      expect(writeJson("k", "v")).toBe(false);
      expect(() => remove("k")).not.toThrow();
      expect(() => clearAll()).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, "localStorage", original);
    }
  });
});

describe("STORAGE_KEYS", () => {
  it("namespaces every key under dcz:", () => {
    Object.values(STORAGE_KEYS).forEach((key) => expect(key).toMatch(/^dcz:/));
  });
});
