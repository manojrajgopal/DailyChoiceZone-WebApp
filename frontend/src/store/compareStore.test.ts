import { describe, expect, it, vi } from "vitest";

import { useCompareStore } from "./compareStore";

const KEY = "dcz:compare";
const compare = () => useCompareStore.getState();

describe("useCompareStore", () => {
  it("starts with nothing compared or pending", () => {
    expect(compare().productIds).toEqual([]);
    expect(compare().pending).toEqual([]);
  });

  describe("set", () => {
    it("replaces the list", () => {
      compare().set(["A", "B"]);
      expect(compare().productIds).toEqual(["A", "B"]);
    });

    it("writes nothing when the list is identical, so subscribers aren't re-run", () => {
      compare().set(["A", "B"]);
      const listener = vi.fn();
      const unsubscribe = useCompareStore.subscribe(listener);
      compare().set(["A", "B"]);
      expect(listener).not.toHaveBeenCalled();
      unsubscribe();
    });

    it.each([
      [["A", "B"], ["B", "A"]],
      [["A", "B"], ["A"]],
      [["A"], ["A", "B"]],
      [["A"], []],
    ])("treats %j → %j as a change", (first, next) => {
      compare().set(first);
      compare().set(next);
      expect(compare().productIds).toEqual(next);
    });
  });

  describe("stage and drain", () => {
    it("stages ids and drains them exactly once", () => {
      compare().stage(["A", "B"]);
      expect(compare().pending).toEqual(["A", "B"]);
      expect(compare().drain()).toEqual(["A", "B"]);
      expect(compare().pending).toEqual([]);
      expect(compare().drain()).toEqual([]);
    });

    it("draining an empty list writes nothing", () => {
      const listener = vi.fn();
      const unsubscribe = useCompareStore.subscribe(listener);
      compare().drain();
      expect(listener).not.toHaveBeenCalled();
      unsubscribe();
    });
  });

  it("clear empties both lists", () => {
    compare().set(["A"]);
    compare().stage(["B"]);
    compare().clear();
    expect(compare().productIds).toEqual([]);
    expect(compare().pending).toEqual([]);
  });

  describe("persistence", () => {
    it("persists both lists", () => {
      compare().set(["A"]);
      compare().stage(["B"]);
      expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ state: { productIds: ["A"], pending: ["B"] }, version: 1 });
    });

    it("rehydrates, then ignores corrupt data", async () => {
      localStorage.setItem(KEY, JSON.stringify({ state: { productIds: ["X", "Y"], pending: ["Z"] }, version: 1 }));
      await useCompareStore.persist.rehydrate();
      expect(compare().productIds).toEqual(["X", "Y"]);
      expect(compare().pending).toEqual(["Z"]);
      localStorage.setItem(KEY, "{");
      await useCompareStore.persist.rehydrate();
      expect(compare().productIds).toEqual(["X", "Y"]);
    });
  });
});
