import { afterEach, describe, expect, it, vi } from "vitest";

import { api, networkError, ok } from "@/test/api";

import {
  addBundleToCart,
  checkReferralCode,
  forgetReferralCode,
  getBundle,
  getBundles,
  getFlashSales,
  getMyReferrals,
  rememberReferralCode,
  rememberedReferralCode,
  removeBundle,
  setBundleQuantity,
  trackEvent,
} from "./growthService";

describe("flash sales", () => {
  it("GETs live and upcoming flash sales", async () => {
    api.get("/flash-sales", { live: [], upcoming: [], serverTime: "2026-01-01T00:00:00Z" });
    const result = await getFlashSales();
    expect(result.serverTime).toBe("2026-01-01T00:00:00Z");
  });
});

describe("bundles", () => {
  it("getBundles includes a productId filter only when given", async () => {
    api.get("/bundles", ok([]));
    await getBundles();
    expect(api.last()!.url).not.toContain("productId");
    await getBundles("P1");
    expect(api.last()!.query.get("productId")).toBe("P1");
  });

  it("getBundle GETs by slug", async () => {
    api.get("/bundles/summer-set", { slug: "summer-set" });
    expect(await getBundle("summer-set")).toMatchObject({ slug: "summer-set" });
  });

  it("addBundleToCart POSTs bundleId, quantity and selections", async () => {
    api.post("/cart/bundles", (req) => ({ breakdown: { itemCount: 1 }, ...(req.body as object) }));
    await addBundleToCart(5, 2, [{ productId: "P1", size: "M" }]);
    expect(api.last()!.body).toEqual({ bundleId: 5, quantity: 2, selections: [{ productId: "P1", size: "M" }] });
  });

  it("setBundleQuantity PUTs the quantity", async () => {
    api.put("/cart/bundles/9", { breakdown: { itemCount: 1 } });
    await setBundleQuantity(9, 3);
    expect(api.last()!.body).toEqual({ quantity: 3 });
  });

  it("removeBundle DELETEs the entry", async () => {
    api.delete("/cart/bundles/9", { breakdown: { itemCount: 0 } });
    await removeBundle(9);
    expect(api.requests("DELETE", "/cart/bundles/9")).toHaveLength(1);
  });
});

describe("referrals", () => {
  it("getMyReferrals GETs with customer auth", async () => {
    window.localStorage.setItem("dcz:auth-token", "cust");
    api.get("/account/referrals", {
      rules: {}, code: "ABC123", codeDisabled: false, shareUrl: null,
      stats: { invited: 0, pending: 0, rewarded: 0, earnedCredit: 0, earnedPoints: 0 },
      referrals: [], joinedWith: null, unit: "credit",
    });
    await getMyReferrals();
    expect(api.last()!.headers.authorization).toBe("Bearer cust");
  });

  it("checkReferralCode GETs with the code as a query param", async () => {
    api.get(/\/referrals\/check/, { valid: true, code: "ABC123", rules: null });
    const result = await checkReferralCode("ABC123");
    expect(result.valid).toBe(true);
    expect(api.last()!.query.get("code")).toBe("ABC123");
  });

  it("rememberReferralCode sanitises and caps the code, then rememberedReferralCode reads it back", () => {
    rememberReferralCode("abc-123!!! extra-long-code-that-is-too-long");
    expect(rememberedReferralCode()).toBe("ABC123EXTRALONGC");
    expect(rememberedReferralCode().length).toBeLessThanOrEqual(16);
  });

  it("rememberedReferralCode is an empty string when nothing is saved", () => {
    expect(rememberedReferralCode()).toBe("");
  });

  it("forgetReferralCode clears it", () => {
    rememberReferralCode("ABC123");
    forgetReferralCode();
    expect(rememberedReferralCode()).toBe("");
  });

  it("degrades silently when storage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => rememberReferralCode("ABC")).not.toThrow();
    expect(rememberedReferralCode()).toBe("");
    vi.restoreAllMocks();
  });
});

describe("trackEvent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs the event with a generated visitor id, without awaiting", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-1111-1111-111111111111");
    api.post("/analytics/events", {});
    trackEvent("visit");
    await Promise.resolve(); // let the fire-and-forget microtask run
    await Promise.resolve();
    const request = api.last("POST", "/analytics/events");
    expect(request?.body).toMatchObject({ event: "visit", visitorId: "11111111-1111-1111-1111-111111111111" });
  });

  it("reuses a previously generated visitor id", async () => {
    window.localStorage.setItem("dcz:visitor", "existing-id-123");
    api.post("/analytics/events", {});
    trackEvent("product_view", { productId: "P1" });
    await Promise.resolve();
    await Promise.resolve();
    expect(api.last()!.body).toMatchObject({ visitorId: "existing-id-123", productId: "P1", event: "product_view" });
  });

  it("generates a new id when the stored one doesn't match the expected shape", async () => {
    window.localStorage.setItem("dcz:visitor", "!!!");
    vi.spyOn(crypto, "randomUUID").mockReturnValue("22222222-2222-2222-2222-222222222222");
    api.post("/analytics/events", {});
    trackEvent("visit");
    await Promise.resolve();
    await Promise.resolve();
    expect(api.last()!.body).toMatchObject({ visitorId: "22222222-2222-2222-2222-222222222222" });
  });

  it("includes the customer auth header only when signed in", async () => {
    api.post("/analytics/events", {});
    trackEvent("visit");
    await Promise.resolve();
    await Promise.resolve();
    expect(api.last()!.headers.authorization).toBeUndefined();

    window.localStorage.setItem("dcz:auth-token", "cust");
    trackEvent("checkout_start");
    await Promise.resolve();
    await Promise.resolve();
    expect(api.last()!.headers.authorization).toBe("Bearer cust");
  });

  it("truncates a long utmSource to 60 characters", async () => {
    api.post("/analytics/events", {});
    trackEvent("visit", { utmSource: "x".repeat(100) });
    await Promise.resolve();
    await Promise.resolve();
    expect((api.last()!.body as { utmSource: string }).utmSource).toHaveLength(60);
  });

  it("does not throw when the request fails", async () => {
    api.post("/analytics/events", networkError());
    expect(() => trackEvent("visit")).not.toThrow();
  });

  it("sends nothing when localStorage is blocked (private browsing)", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    api.post("/analytics/events", {});
    trackEvent("visit");
    await Promise.resolve();
    await Promise.resolve();
    expect(api.calls).toHaveLength(0);
  });
});
