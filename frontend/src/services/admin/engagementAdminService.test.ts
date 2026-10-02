import { beforeEach, describe, expect, it } from "vitest";

import { api } from "@/test/api";
import { setUpAdmin } from "@/test/sliceB-admin";

import * as engagement from "./engagementAdminService";

beforeEach(() => {
  setUpAdmin();
});

describe("alerts", () => {
  it("listAlerts GETs the kind-scoped endpoint with filters", async () => {
    await engagement.listAlerts("stock", { status: "active", q: "kurta", page: 2 });
    const request = api.last("GET", "/admin/alerts/stock")!;
    expect(request.query.get("status")).toBe("active");
    expect(request.query.get("page")).toBe("2");
    expect(request.headers.authorization).toBe("Bearer test-token");
  });

  it("resendAlert POSTs to /admin/alerts/:kind/:id/resend", async () => {
    await engagement.resendAlert("price", 7);
    expect(api.last("POST", "/admin/alerts/price/7/resend")!.body).toEqual({});
  });
});

describe("questions", () => {
  it("lists, reads, approves, rejects, answers, edits and deletes", async () => {
    await engagement.listQuestions({ status: "pending" });
    expect(api.last("GET", "/admin/questions")!.query.get("status")).toBe("pending");

    await engagement.getQuestion(1);
    expect(api.last("GET", "/admin/questions/1")).toBeTruthy();

    await engagement.approveQuestion(1);
    expect(api.last("POST", "/admin/questions/1/approve")!.body).toEqual({});

    await engagement.rejectQuestion(1, "Spam");
    expect(api.last("POST", "/admin/questions/1/reject")!.body).toEqual({ reason: "Spam" });

    await engagement.answerQuestion(1, "It runs small.", true, true);
    expect(api.last("PUT", "/admin/questions/1/answer")!.body).toEqual({ answer: "It runs small.", publish: true, approve: true });

    await engagement.editQuestion(1, "Does it run small?");
    expect(api.last("PUT", "/admin/questions/1")!.body).toEqual({ question: "Does it run small?" });

    await engagement.deleteQuestion(1);
    expect(api.last("DELETE", "/admin/questions/1")).toBeTruthy();
  });
});

describe("gift cards", () => {
  it("lists, reads, issues, acts on and configures", async () => {
    await engagement.listGiftCards({ status: "active", q: "GC" });
    expect(api.last("GET", "/admin/gift-cards")!.query.get("status")).toBe("active");

    await engagement.getGiftCard(1);
    expect(api.last("GET", "/admin/gift-cards/1")).toBeTruthy();

    const issue = { amount: 500, recipientName: "A", recipientEmail: "a@b.com", message: "Enjoy!", reason: "goodwill" };
    await engagement.issueGiftCard(issue);
    expect(api.last("POST", "/admin/gift-cards")!.body).toEqual(issue);

    await engagement.giftCardAction(1, "disable", "Fraud suspected");
    expect(api.last("POST", "/admin/gift-cards/1/disable")!.body).toEqual({ reason: "Fraud suspected" });

    await engagement.getGiftCardSettings();
    expect(api.last("GET", "/admin/gift-cards/settings")).toBeTruthy();

    const settings = { enabled: true, minAmount: 100, maxAmount: 5000, denominations: [500, 1000], allowCustomAmount: true, validityMonths: 12, maxCardsPerOrder: 5, allowWithCoupons: true, storeCreditEnabled: true, storeCreditWithGiftCards: true, storeCreditWithCoupons: true };
    await engagement.saveGiftCardSettings(settings);
    expect(api.last("PUT", "/admin/gift-cards/settings")!.body).toEqual(settings);
  });
});

describe("store credit", () => {
  it("lists balances, reads a ledger and posts an adjustment", async () => {
    await engagement.listStoreCredit({ q: "a@b.com", withBalance: true });
    expect(api.last("GET", "/admin/store-credit")!.query.get("withBalance")).toBe("true");

    await engagement.getCreditLedger("C1", 2);
    expect(api.last("GET", "/admin/store-credit/C1")!.query.get("page")).toBe("2");

    const input = { kind: "manual_credit", amount: 100, reason: "Goodwill", requestKey: "req-1" };
    await engagement.adjustStoreCredit("C1", input);
    expect(api.last("POST", "/admin/store-credit/C1")!.body).toEqual(input);
  });

  it("encodes the customer id in the path", async () => {
    await engagement.getCreditLedger("cust/weird id");
    expect(api.last("GET")!.path).toBe("/admin/store-credit/cust%2Fweird%20id");
  });
});

describe("loyalty", () => {
  it("covers metrics, balances, ledger, adjustments, settings and housekeeping", async () => {
    await engagement.getLoyaltyMetrics(7);
    expect(api.last("GET", "/admin/loyalty/metrics")!.query.get("days")).toBe("7");

    await engagement.listLoyaltyBalances({ q: "a" });
    expect(api.last("GET", "/admin/loyalty/balances")!.query.get("q")).toBe("a");

    await engagement.listLoyaltyLedger({ kind: "manual_credit" });
    expect(api.last("GET", "/admin/loyalty/ledger")!.query.get("kind")).toBe("manual_credit");

    const input = { kind: "manual_credit" as const, points: 100, reason: "Goodwill", requestKey: "req-2" };
    await engagement.adjustPoints("C1", input);
    expect(api.last("POST", "/admin/loyalty/customers/C1/adjust")!.body).toEqual(input);

    await engagement.getLoyaltySettings();
    expect(api.last("GET", "/admin/loyalty/settings")).toBeTruthy();

    const settings = {
      enabled: true, pointsPer100: 5, redeemPoints: 1, redeemValue: 1, minRedeemPoints: 100,
      maxPointsPerOrder: 500, maxOrderPercent: 50, expiryMonths: 12, pendingDays: 7, expiryWarningDays: 7,
      excludeTax: false, excludeTenderPaid: false, excludeDiscountedItems: false, eligibleCategories: [],
      excludedCategories: [], excludedProducts: [], memberMultiplier: 1, planMultipliers: {},
      allowWithCoupons: true, allowWithGiftCards: true, allowWithStoreCredit: true,
    };
    await engagement.saveLoyaltySettings(settings);
    expect(api.last("PUT", "/admin/loyalty/settings")!.body).toEqual(settings);

    await engagement.runLoyaltyHousekeeping();
    expect(api.last("POST", "/admin/loyalty/housekeeping")!.body).toEqual({});
  });
});
