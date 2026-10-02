import { beforeEach, describe, expect, it } from "vitest";

import { api } from "@/test/api";
import { setUpAdmin } from "@/test/sliceB-admin";

import * as coupons from "./couponAdminService";

beforeEach(() => {
  setUpAdmin();
  api.get("/admin/coupons", []);
});

describe("listCoupons", () => {
  it("GETs /admin/coupons", async () => {
    await coupons.listCoupons();
    expect(api.last("GET", "/admin/coupons")!.headers.authorization).toBe("Bearer test-token");
  });
});

describe("effectiveStatus", () => {
  const now = new Date("2024-06-15T00:00:00Z");
  const base = { id: "C1", code: "SAVE10", description: "", type: "percent" as const, value: 10, minSubtotal: 0, maxDiscount: null, startsAt: "2024-01-01", endsAt: null, usageLimit: null, usageCount: 0, status: "active" as const, createdAt: "2024-01-01" };

  it("disabled always wins regardless of dates", () => {
    expect(coupons.effectiveStatus({ ...base, status: "disabled", startsAt: "2030-01-01" }, now)).toBe("disabled");
  });

  it("is scheduled before its start date", () => {
    expect(coupons.effectiveStatus({ ...base, startsAt: "2030-01-01" }, now)).toBe("scheduled");
  });

  it("is expired after its end date", () => {
    expect(coupons.effectiveStatus({ ...base, endsAt: "2024-01-01" }, now)).toBe("expired");
  });

  it("is expired once the usage limit is reached", () => {
    expect(coupons.effectiveStatus({ ...base, usageLimit: 10, usageCount: 10 }, now)).toBe("expired");
  });

  it("is active otherwise", () => {
    expect(coupons.effectiveStatus(base, now)).toBe("active");
  });
});

describe("saveCoupon", () => {
  const base = { id: "", code: "save10", description: "", type: "percent" as const, value: 10, minSubtotal: 0, maxDiscount: null, startsAt: "2024-01-01", endsAt: null, usageLimit: null, usageCount: 0, status: "active" as const, createdAt: "2024-01-01" };

  it.each([
    ["", "Use 4 to 20 letters and numbers, with no spaces."],
    ["ab", "Use 4 to 20 letters and numbers, with no spaces."],
    ["has space", "Use 4 to 20 letters and numbers, with no spaces."],
  ])("refuses an invalid code %j", async (code, reason) => {
    const result = await coupons.saveCoupon({ ...base, code });
    expect(result).toEqual({ ok: false, reason });
  });

  it.each([0, -5, 91])("refuses a percent value of %i", async (value) => {
    const result = await coupons.saveCoupon({ ...base, value });
    expect(result).toEqual({ ok: false, reason: "A percentage discount must be between 1 and 90." });
  });

  it("refuses a non-positive flat value", async () => {
    const result = await coupons.saveCoupon({ ...base, type: "flat", value: 0 });
    expect(result).toEqual({ ok: false, reason: "Enter a discount amount above zero." });
  });

  it("refuses an end date before the start date", async () => {
    const result = await coupons.saveCoupon({ ...base, startsAt: "2024-06-01", endsAt: "2024-01-01" });
    expect(result).toEqual({ ok: false, reason: "The end date must be after the start date." });
  });

  it("refuses a code already used by another coupon", async () => {
    api.get("/admin/coupons", [{ id: "C1", code: "SAVE10" }]);
    const result = await coupons.saveCoupon({ ...base, code: "save10" });
    expect(result).toEqual({ ok: false, reason: "The code SAVE10 is already in use." });
  });

  it("allows keeping its own code on an edit", async () => {
    api.get("/admin/coupons", [{ id: "C1", code: "SAVE10" }]);
    api.put("/admin/coupons/C1", {});
    const result = await coupons.saveCoupon({ ...base, id: "C1", code: "save10" });
    expect(result.ok).toBe(true);
  });

  it("upper-cases and trims the code before saving", async () => {
    api.post("/admin/coupons", (req) => req.body);
    const result = await coupons.saveCoupon({ ...base, code: "  save10  " });
    expect(result).toMatchObject({ ok: true, data: { code: "SAVE10" } });
  });
});

describe("setCouponStatus", () => {
  it("refuses when the coupon no longer exists", async () => {
    const result = await coupons.setCouponStatus("missing", "disabled");
    expect(result).toEqual({ ok: false, reason: "That coupon no longer exists." });
  });

  it("writes the new status", async () => {
    // The server reflects the write on the next read; a stateful fixture
    // mirrors that so the service's own re-read-after-write is meaningful.
    const stored = [{ id: "CPN1", code: "SAVE10", status: "active" }];
    api.get("/admin/coupons", () => stored);
    api.put("/admin/coupons/CPN1", (req) => {
      Object.assign(stored[0]!, req.body);
      return stored[0];
    });
    const result = await coupons.setCouponStatus("CPN1", "disabled");
    expect(result).toMatchObject({ ok: true, data: { status: "disabled" } });
    expect(api.last("PUT", "/admin/coupons/CPN1")!.body).toMatchObject({ status: "disabled" });
  });
});

describe("deleteCoupon", () => {
  it("refuses when missing, deletes and reports the code otherwise", async () => {
    await expect(coupons.deleteCoupon("missing")).resolves.toEqual({ ok: false, reason: "That coupon no longer exists." });

    api.get("/admin/coupons", [{ id: "CPN1", code: "SAVE10" }]);
    api.delete("/admin/coupons/CPN1", {});
    await expect(coupons.deleteCoupon("CPN1")).resolves.toEqual({ ok: true, data: "SAVE10" });
  });
});

describe("emptyCoupon", () => {
  it("is a sensible, active, percent-type starting point", () => {
    const coupon = coupons.emptyCoupon();
    expect(coupon).toMatchObject({ code: "", type: "percent", value: 10, status: "active", audience: "everyone" });
    expect(coupon.id).toMatch(/^coupon_/);
  });
});
