import { describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";

import { getReviewSummary, getReviews } from "./reviewService";

describe("getReviews", () => {
  it("lists reviews filtered by productId", async () => {
    api.get("/reviews", [{ id: "R1" }]);
    const result = await getReviews("P1");
    expect(result).toEqual([{ id: "R1" }]);
    expect(api.last()!.query.get("productId")).toBe("P1");
  });

  it("propagates a server failure", async () => {
    api.get("/reviews", fail(500));
    await expect(getReviews("P1")).rejects.toMatchObject({ status: 500 });
  });
});

describe("getReviewSummary", () => {
  it("gets the ratings breakdown for a product", async () => {
    api.get("/reviews/summary", { average: 4.2, count: 18 });
    const result = await getReviewSummary("P1");
    expect(result).toEqual({ average: 4.2, count: 18 });
    expect(api.last()!.query.get("productId")).toBe("P1");
  });
});
