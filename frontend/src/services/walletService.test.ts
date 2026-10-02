import { describe, expect, it } from "vitest";

import { api, ok } from "@/test/api";

import {
  abandonGiftCard,
  buyGiftCard,
  checkGiftCard,
  getGiftCardOptions,
  getMyGiftCards,
  getRewards,
  getStoreCredit,
  previewTenders,
  verifyGiftCardPayment,
} from "./walletService";

describe("gift cards", () => {
  it("getGiftCardOptions GETs without auth", async () => {
    api.get("/gift-cards/options", { enabled: true, minAmount: 100, maxAmount: 5000, denominations: [500, 1000], allowCustomAmount: true, validityMonths: 12 });
    const result = await getGiftCardOptions();
    expect(result.enabled).toBe(true);
    expect(api.last()!.headers.authorization).toBeUndefined();
  });

  it("buyGiftCard POSTs the purchase details with customer auth", async () => {
    window.localStorage.setItem("dcz:auth-token", "cust");
    api.post("/gift-cards/purchase", (req) => ({ giftCard: { id: 1, ...(req.body as object) }, gateway: null }));
    const result = await buyGiftCard({ amount: 1000, recipientName: "Asha", recipientEmail: "a@b.com" });
    expect(result.gateway).toBeNull();
    expect(api.last()!.headers.authorization).toBe("Bearer cust");
  });

  it("verifyGiftCardPayment POSTs the gateway response", async () => {
    api.post("/gift-cards/1/verify", (req) => ({ id: 1, status: "active", ...(req.body as object) }));
    const result = await verifyGiftCardPayment(1, { razorpay_payment_id: "p1" });
    expect(result.status).toBe("active");
  });

  it("abandonGiftCard POSTs to the abandon endpoint", async () => {
    api.post("/gift-cards/1/abandon", {});
    await abandonGiftCard(1);
    expect(api.requests("POST", "/gift-cards/1/abandon")).toHaveLength(1);
  });

  it("checkGiftCard POSTs the code", async () => {
    api.post("/gift-cards/check", { valid: true, reason: "" });
    const result = await checkGiftCard("GC-1234");
    expect(result.valid).toBe(true);
    expect(api.last()!.body).toEqual({ code: "GC-1234" });
  });

  it("getMyGiftCards GETs the shopper's cards", async () => {
    api.get("/gift-cards/mine", ok([]));
    expect(await getMyGiftCards()).toEqual([]);
  });
});

describe("store credit", () => {
  it("GETs with a page query param, defaulting to 1", async () => {
    api.get(/\/account\/store-credit/, ok({ items: [], pagination: {}, balance: 0, lifetimeCredited: 0, lifetimeSpent: 0 }));
    await getStoreCredit();
    expect(api.last()!.query.get("page")).toBe("1");
    await getStoreCredit(3);
    expect(api.last()!.query.get("page")).toBe("3");
  });
});

describe("rewards", () => {
  it("GETs with a page query param, defaulting to 1", async () => {
    api.get(/\/account\/rewards/, ok({ items: [], pagination: {}, enabled: true, available: 0, debt: 0, availableValue: 0, pending: 0, nextReleaseAt: null, lifetimeEarned: 0, lifetimeRedeemed: 0, lifetimeExpired: 0, lifetimeReversed: 0, nextExpiry: null, rules: {} }));
    await getRewards();
    expect(api.last()!.query.get("page")).toBe("1");
    await getRewards(2);
    expect(api.last()!.query.get("page")).toBe("2");
  });
});

describe("previewTenders", () => {
  it("POSTs the checkout inputs and returns the preview", async () => {
    api.post("/checkout/tenders", (req) => ({ grandTotal: 10000, giftCards: [], giftCardTotal: 0, storeCredit: { available: 0, applied: 0 }, points: {}, tenderTotal: 0, amountDue: 10000, messages: [], echo: req.body }));
    const input = { giftCardCodes: ["GC1"], useStoreCredit: true, points: 100 };
    const result = await previewTenders(input);
    expect(result.amountDue).toBe(10000);
    expect(api.last()!.body).toMatchObject(input);
  });
});
