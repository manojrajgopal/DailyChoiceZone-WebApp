import { beforeEach, describe, expect, it } from "vitest";

import { api } from "@/test/api";
import { setUpAdmin } from "@/test/sliceB-admin";

import * as reviews from "./reviewAdminService";

beforeEach(() => {
  setUpAdmin();
});

describe("listReviews", () => {
  it("GETs /admin/reviews", async () => {
    await reviews.listReviews();
    expect(api.last("GET", "/admin/reviews")!.headers.authorization).toBe("Bearer test-token");
  });
});

describe("setReviewStatus", () => {
  it("refuses a review id that no longer exists", async () => {
    api.get("/admin/reviews", []);
    const result = await reviews.setReviewStatus("R1", "approved");
    expect(result).toEqual({ ok: false, reason: "That review no longer exists." });
  });

  it("sets the status on an existing review", async () => {
    api.get("/admin/reviews", [{ id: "R1", status: "approved", title: "Great fit" }]);
    api.put("/admin/reviews/R1", {});
    const result = await reviews.setReviewStatus("R1", "approved");
    expect(result).toEqual({ ok: true, data: { id: "R1", status: "approved", title: "Great fit" } });
    expect(api.last("PUT", "/admin/reviews/R1")!.body).toEqual({ status: "approved" });
  });
});

describe("deleteReview", () => {
  it("refuses a review id that no longer exists", async () => {
    api.get("/admin/reviews", []);
    const result = await reviews.deleteReview("R1");
    expect(result).toEqual({ ok: false, reason: "That review no longer exists." });
    expect(api.requests("DELETE")).toHaveLength(0);
  });

  it("deletes an existing review and reports its title", async () => {
    api.get("/admin/reviews", [{ id: "R1", title: "Great fit" }]);
    api.delete("/admin/reviews/R1", {});
    const result = await reviews.deleteReview("R1");
    expect(result).toEqual({ ok: true, data: "Great fit" });
    expect(api.last("DELETE", "/admin/reviews/R1")).toBeTruthy();
  });
});
