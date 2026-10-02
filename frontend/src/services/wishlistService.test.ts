import { describe, expect, it } from "vitest";

import { makeProduct } from "@/test/sliceA-fixtures";
import { api, fail } from "@/test/api";

import {
  addToWishlist,
  fetchWishlist,
  fetchWishlistIds,
  mergeGuestWishlist,
  removeFromWishlist,
  resolveWishlist,
} from "./wishlistService";

describe("fetchWishlist / fetchWishlistIds", () => {
  it("GETs with customer auth", async () => {
    window.localStorage.setItem("dcz:auth-token", "cust");
    api.get("/wishlist", [makeProduct()]);
    await fetchWishlist();
    expect(api.last()!.headers.authorization).toBe("Bearer cust");

    api.get("/wishlist/ids", ["P1"]);
    expect(await fetchWishlistIds()).toEqual(["P1"]);
  });
});

describe("addToWishlist / removeFromWishlist", () => {
  it("POSTs and DELETEs by product id, URL-encoded", async () => {
    api.post("/wishlist/abc%2Fdef", ["abc/def"]);
    expect(await addToWishlist("abc/def")).toEqual(["abc/def"]);

    api.delete("/wishlist/abc%2Fdef", []);
    expect(await removeFromWishlist("abc/def")).toEqual([]);
  });
});

describe("mergeGuestWishlist", () => {
  it("adds every id, skipping one that fails", async () => {
    api.post("/wishlist/P1", (req) => [req]); // success shape doesn't matter
    api.post("/wishlist/P2", fail(409, "Already withdrawn"));
    api.post("/wishlist/P3", []);
    await expect(mergeGuestWishlist(["P1", "P2", "P3"])).resolves.toBeUndefined();
    expect(api.requests("POST")).toHaveLength(3);
  });
});

describe("resolveWishlist", () => {
  it("is empty for no ids, with no request", async () => {
    expect(await resolveWishlist([])).toEqual([]);
    expect(api.calls).toHaveLength(0);
  });

  it("resolves ids and reverses to show most recently added first", async () => {
    api.get("/products/A", makeProduct({ id: "A" }));
    api.get("/products/B", makeProduct({ id: "B" }));
    const result = await resolveWishlist(["A", "B"]);
    expect(result.map((p) => p.id)).toEqual(["B", "A"]);
  });

  it("drops an id that no longer resolves", async () => {
    api.get("/products/A", makeProduct({ id: "A" }));
    api.get("/products/missing", fail(404));
    const result = await resolveWishlist(["A", "missing"]);
    expect(result.map((p) => p.id)).toEqual(["A"]);
  });
});
