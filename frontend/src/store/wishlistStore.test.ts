import { describe, expect, it, vi } from "vitest";

import { useWishlistStore } from "./wishlistStore";

const KEY = "dcz:wishlist";
const wishlist = () => useWishlistStore.getState();

describe("useWishlistStore", () => {
  it("starts empty", () => {
    expect(wishlist().productIds).toEqual([]);
    expect(wishlist().pending).toEqual([]);
    expect(wishlist().has("A")).toBe(false);
  });

  describe("toggle / add / remove", () => {
    it("toggles on and off, returning the state after the toggle", () => {
      expect(wishlist().toggle("A")).toBe(true);
      expect(wishlist().has("A")).toBe(true);
      expect(wishlist().toggle("A")).toBe(false);
      expect(wishlist().has("A")).toBe(false);
    });

    it("adds in order without duplicates", () => {
      wishlist().add("A");
      wishlist().add("B");
      wishlist().add("A");
      expect(wishlist().productIds).toEqual(["A", "B"]);
    });

    it("removes from both the list and the pending queue", () => {
      wishlist().add("A");
      wishlist().add("B");
      wishlist().stage("A");
      wishlist().remove("A");
      expect(wishlist().productIds).toEqual(["B"]);
      expect(wishlist().pending).toEqual([]);
    });
  });

  describe("replace", () => {
    it("mirrors the server's list", () => {
      wishlist().add("A");
      wishlist().replace(["B", "C"]);
      expect(wishlist().productIds).toEqual(["B", "C"]);
    });

    it("writes nothing when the list is unchanged", () => {
      wishlist().replace(["A", "B"]);
      const listener = vi.fn();
      const unsubscribe = useWishlistStore.subscribe(listener);
      wishlist().replace(["A", "B"]);
      expect(listener).not.toHaveBeenCalled();
      unsubscribe();
    });

    it.each([[["B", "A"]], [["A"]], [[]]])("treats a different order or length (%j) as a change", (next) => {
      wishlist().replace(["A", "B"]);
      wishlist().replace(next);
      expect(wishlist().productIds).toEqual(next);
    });
  });

  describe("stage and drain", () => {
    it("stages ids once each and drains them exactly once", () => {
      wishlist().stage("A");
      wishlist().stage("A");
      wishlist().stage("B");
      expect(wishlist().pending).toEqual(["A", "B"]);
      expect(wishlist().drain()).toEqual(["A", "B"]);
      expect(wishlist().pending).toEqual([]);
      expect(wishlist().drain()).toEqual([]);
    });

    it("draining nothing writes nothing", () => {
      const listener = vi.fn();
      const unsubscribe = useWishlistStore.subscribe(listener);
      wishlist().drain();
      expect(listener).not.toHaveBeenCalled();
      unsubscribe();
    });
  });

  it("clear empties both lists", () => {
    wishlist().add("A");
    wishlist().stage("B");
    wishlist().clear();
    expect(wishlist().productIds).toEqual([]);
    expect(wishlist().pending).toEqual([]);
  });

  describe("persistence", () => {
    it("persists both lists as version 2", () => {
      wishlist().add("A");
      wishlist().stage("B");
      expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ state: { productIds: ["A"], pending: ["B"] }, version: 2 });
    });

    it("rehydrates a saved wishlist", async () => {
      localStorage.setItem(KEY, JSON.stringify({ state: { productIds: ["X"], pending: ["Y"] }, version: 2 }));
      await useWishlistStore.persist.rehydrate();
      expect(wishlist().productIds).toEqual(["X"]);
      expect(wishlist().pending).toEqual(["Y"]);
      expect(wishlist().has("X")).toBe(true);
    });

    it("does not adopt a version-1 wishlist", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      localStorage.setItem(KEY, JSON.stringify({ state: { productIds: ["OLD"] }, version: 1 }));
      await useWishlistStore.persist.rehydrate();
      expect(wishlist().productIds).toEqual([]);
    });

    it("ignores corrupt data", async () => {
      localStorage.setItem(KEY, "nope{");
      await useWishlistStore.persist.rehydrate();
      expect(wishlist().productIds).toEqual([]);
    });
  });
});
