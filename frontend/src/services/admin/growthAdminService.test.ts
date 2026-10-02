import { beforeEach, describe, expect, it, vi } from "vitest";

import { api, file } from "@/test/api";
import { setUpAdmin } from "@/test/sliceB-admin";

import * as growth from "./growthAdminService";

beforeEach(() => {
  setUpAdmin();
});

describe("referrals", () => {
  it("lists, reads metrics and settings, decides and sets a code", async () => {
    await growth.listReferrals({ status: "pending", q: "REF1" });
    expect(api.last("GET", "/admin/referrals")!.query.get("status")).toBe("pending");

    await growth.getReferralMetrics(14);
    expect(api.last("GET", "/admin/referrals/metrics")!.query.get("days")).toBe("14");

    await growth.getReferralMetrics();
    expect(api.last("GET", "/admin/referrals/metrics")!.query.get("days")).toBe("30");

    await growth.getReferralSettings();
    expect(api.last("GET", "/admin/referrals/settings")).toBeTruthy();

    const settings = { enabled: true, rewardType: "points" as const, referrerReward: 50, refereeReward: 50, minOrderAmount: 500, rewardOn: "paid" as const, windowDays: 30, maxRewardsPerMonth: 10, holdSuspicious: true };
    await growth.saveReferralSettings(settings);
    expect(api.last("PUT", "/admin/referrals/settings")!.body).toEqual(settings);

    await growth.decideReferral(1, "approve", "Looks fine");
    expect(api.last("POST", "/admin/referrals/1/approve")!.body).toEqual({ note: "Looks fine" });

    await growth.setReferralCode("C1", "disable");
    expect(api.last("POST", "/admin/referrals/codes/C1/disable")!.body).toEqual({});
  });
});

describe("flash sales", () => {
  const input = { name: "Flash Friday", description: "", startsAt: "2024-01-01", endsAt: "2024-01-02", allowCoupons: false, items: [{ productId: "P1", salePrice: 100, stockLimit: 10, perCustomerLimit: 1 }] };

  it("covers the full lifecycle of calls", async () => {
    await growth.listFlashSales({ phase: "live" });
    expect(api.last("GET", "/admin/flash-sales")!.query.get("phase")).toBe("live");

    await growth.getFlashSale(1);
    expect(api.last("GET", "/admin/flash-sales/1")).toBeTruthy();

    await growth.createFlashSale(input);
    expect(api.last("POST", "/admin/flash-sales")!.body).toEqual(input);

    await growth.updateFlashSale(1, input);
    expect(api.last("PUT", "/admin/flash-sales/1")!.body).toEqual(input);

    await growth.flashSaleAction(1, "publish");
    expect(api.last("POST", "/admin/flash-sales/1/publish")!.body).toEqual({});

    await growth.deleteFlashSale(1);
    expect(api.last("DELETE", "/admin/flash-sales/1")).toBeTruthy();
  });
});

describe("bundles", () => {
  const input = { name: "Combo", description: "", image: "", status: "active" as const, pricing: "fixed" as const, fixedPrice: 999, discountPercent: null, maxPerOrder: 2, startsAt: null, endsAt: null, items: [{ productId: "P1", quantity: 1 }] };

  it("covers listing, reading, writing, deleting and the product picker", async () => {
    await growth.listBundles({ status: "active" });
    expect(api.last("GET", "/admin/bundles")!.query.get("status")).toBe("active");

    await growth.getBundle(1);
    expect(api.last("GET", "/admin/bundles/1")).toBeTruthy();

    await growth.createBundle(input);
    expect(api.last("POST", "/admin/bundles")!.body).toEqual(input);

    await growth.updateBundle(1, input);
    expect(api.last("PUT", "/admin/bundles/1")!.body).toEqual(input);

    await growth.deleteBundle(1);
    expect(api.last("DELETE", "/admin/bundles/1")).toBeTruthy();

    await growth.searchProducts("kurta");
    const request = api.last("GET", "/admin/products")!;
    expect(request.query.get("search")).toBe("kurta");
    expect(request.query.get("pageSize")).toBe("20");
  });
});

describe("analytics", () => {
  const params = { range: "30d", compare: "previous" as const, unit: "auto" as const };

  it("getAnalytics reads the section-scoped endpoint with every param", async () => {
    await growth.getAnalytics("sales", params);
    const request = api.last("GET", "/admin/analytics/sales")!;
    expect(request.query.get("range")).toBe("30d");
    expect(request.query.get("compare")).toBe("previous");
  });

  it("exportAnalytics downloads a csv named after the kind", async () => {
    api.get(/^\/admin\/analytics\/export\/sales/, file("date,revenue\n2024-01-01,100"));
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    let downloaded = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloaded = this.download;
    });
    await growth.exportAnalytics("sales", params);
    expect(create).toHaveBeenCalled();
    expect(downloaded).toBe("sales.csv");
  });
});

describe("audit log", () => {
  it("lists, reads an entry, reads facets, and exports without page/pageSize", async () => {
    await growth.listAuditLog({ q: "login", action: "sign_in", page: 2, pageSize: 20 });
    const request = api.last("GET", "/admin/audit-logs")!;
    expect(request.query.get("q")).toBe("login");
    expect(request.query.get("page")).toBe("2");

    await growth.getAuditEntry(1);
    expect(api.last("GET", "/admin/audit-logs/1")).toBeTruthy();

    await growth.getAuditFacets();
    expect(api.last("GET", "/admin/audit-logs/facets")).toBeTruthy();

    api.get(/^\/admin\/audit-logs\/export/, file("a,b\n1,2"));
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    void create;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await growth.exportAuditLog({ q: "login", page: 2, pageSize: 20 });
    expect(api.last("GET")!.query.get("page")).toBeNull();
    expect(api.last("GET")!.query.get("q")).toBe("login");
  });
});

describe("health", () => {
  it("getHealth GETs with an hours parameter, runHealth POSTs", async () => {
    await growth.getHealth(48);
    expect(api.last("GET", "/admin/health")!.query.get("hours")).toBe("48");

    await growth.getHealth();
    expect(api.last("GET", "/admin/health")!.query.get("hours")).toBe("24");

    await growth.runHealth();
    expect(api.last("POST", "/admin/health/run")!.body).toEqual({});
  });
});
