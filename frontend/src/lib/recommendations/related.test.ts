import { describe, expect, it } from "vitest";

import { makeProduct } from "@/test/sliceA-fixtures";

import { findRecommended, findRelated } from "./related";

describe("findRelated", () => {
  const seed = makeProduct({ id: "SEED", subcategory: "shirts", category: "men", brand: "Zara", price: 1000, tags: ["cotton", "formal"], rating: 4 });

  it("excludes the seed itself", () => {
    const result = findRelated(seed, [seed]);
    expect(result).toEqual([]);
  });

  it("ranks a same-subcategory product above an unrelated one", () => {
    const sameSub = makeProduct({ id: "A", subcategory: "shirts", category: "men", brand: "Other", price: 1000, tags: [], rating: 3 });
    const unrelated = makeProduct({ id: "B", subcategory: "shoes", category: "footwear", brand: "Other", price: 50, tags: [], rating: 3 });
    const result = findRelated(seed, [unrelated, sameSub]);
    expect(result.map((p) => p.id)).toEqual(["A", "B"]);
  });

  it("scores shared tags, brand, price band and stock", () => {
    const highMatch = makeProduct({ id: "A", subcategory: "shirts", category: "men", brand: "Zara", price: 1100, tags: ["cotton", "formal"], rating: 5, stock: 5 });
    const lowMatch = makeProduct({ id: "B", subcategory: "pants", category: "women", brand: "Other", price: 50000, tags: [], rating: 1, stock: 0 });
    const result = findRelated(seed, [lowMatch, highMatch]);
    expect(result[0]!.id).toBe("A");
  });

  it("respects the limit", () => {
    const candidates = Array.from({ length: 20 }, (_, i) => makeProduct({ id: `P${i}` }));
    expect(findRelated(seed, candidates, 3)).toHaveLength(3);
  });

  it("defaults to a limit of 8", () => {
    const candidates = Array.from({ length: 20 }, (_, i) => makeProduct({ id: `P${i}` }));
    expect(findRelated(seed, candidates)).toHaveLength(8);
  });

  it("breaks ties by rating, then id", () => {
    const a = makeProduct({ id: "B", rating: 3 });
    const b = makeProduct({ id: "A", rating: 3 });
    const result = findRelated(seed, [a, b]);
    expect(result.map((p) => p.id)).toEqual(["A", "B"]);
  });

  it("is empty for an empty catalogue", () => {
    expect(findRelated(seed, [])).toEqual([]);
  });

  it("never matches the price band when the seed is free", () => {
    const free = makeProduct({ id: "SEED", price: 0 });
    const candidate = makeProduct({ id: "A", price: 0 });
    // Should not throw and should still return candidates, just without the price-band bonus.
    expect(() => findRelated(free, [candidate])).not.toThrow();
  });
});

describe("findRecommended", () => {
  const catalogue = [
    makeProduct({ id: "A", subcategory: "shirts", category: "men", brand: "Zara" }),
    makeProduct({ id: "B", subcategory: "shoes", category: "footwear", brand: "Other" }),
    makeProduct({ id: "C", subcategory: "shirts", category: "men", brand: "Zara" }),
  ];

  it("is empty with no recently viewed history", () => {
    expect(findRecommended([], catalogue)).toEqual([]);
  });

  it("excludes products already in the recently-viewed list", () => {
    const viewed = [makeProduct({ id: "A", subcategory: "shirts", category: "men" })];
    const result = findRecommended(viewed, catalogue);
    expect(result.map((p) => p.id)).not.toContain("A");
  });

  it("weighs the most recent view higher than older ones", () => {
    const recent = makeProduct({ id: "SEED1", subcategory: "shirts", category: "men", brand: "Zara" });
    const older = makeProduct({ id: "SEED2", subcategory: "shoes", category: "footwear", brand: "Other" });
    const shirtLike = makeProduct({ id: "X", subcategory: "shirts", category: "men", brand: "Zara" });
    const shoeLike = makeProduct({ id: "Y", subcategory: "shoes", category: "footwear", brand: "Other" });
    const result = findRecommended([recent, older], [shirtLike, shoeLike]);
    expect(result[0]!.id).toBe("X");
  });

  it("only considers the five most recent views", () => {
    const manyViews = Array.from({ length: 10 }, (_, i) => makeProduct({ id: `V${i}`, subcategory: "shirts" }));
    const candidate = makeProduct({ id: "CAND", subcategory: "shirts" });
    // Should not throw with more than 5 recently-viewed items.
    expect(() => findRecommended(manyViews, [candidate, ...manyViews])).not.toThrow();
  });

  it("respects the limit", () => {
    const viewed = [makeProduct({ id: "SEED" })];
    const candidates = Array.from({ length: 20 }, (_, i) => makeProduct({ id: `P${i}` }));
    expect(findRecommended(viewed, candidates, 2)).toHaveLength(2);
  });

  it("is empty when the catalogue only contains already-viewed products", () => {
    const viewed = [makeProduct({ id: "A" })];
    expect(findRecommended(viewed, [makeProduct({ id: "A" })])).toEqual([]);
  });
});
