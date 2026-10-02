import { beforeEach, describe, expect, it } from "vitest";

import { api } from "@/test/api";
import { setUpAdmin } from "@/test/sliceB-admin";

import * as analytics from "./analyticsAdminService";

beforeEach(() => {
  setUpAdmin();
});

describe("getAnalytics / getDashboard", () => {
  it("getAnalytics GETs /admin/reports with the range in the query", async () => {
    api.get("/admin/reports", { revenue: 0, orders: 0, customers: 0, unitsSold: 0, averageOrderValue: 0, revenueDelta: null, ordersDelta: null, series: [], byCategory: [], topProducts: [], orderStatus: [] });
    await analytics.getAnalytics("7d");
    expect(api.last("GET")!.url).toContain("range=7d");
  });

  it("getDashboard GETs /admin/dashboard", async () => {
    await analytics.getDashboard();
    expect(api.last("GET", "/admin/dashboard")).toBeTruthy();
  });
});

describe("rangeLabel", () => {
  it("falls back to the raw range value before the ranges are set", () => {
    expect(analytics.rangeLabel("3m")).toBe("3m");
  });

  it("looks up the label once the ranges have been set by siteService", () => {
    analytics.setAnalyticsRanges([{ value: "30d", label: "Last 30 days", shortLabel: "30d" }]);
    expect(analytics.rangeLabel("30d")).toBe("Last 30 days");
    expect(analytics.rangeLabel("3m")).toBe("3m");
  });
});
