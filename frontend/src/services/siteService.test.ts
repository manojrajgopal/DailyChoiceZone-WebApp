import { beforeEach, describe, expect, it } from "vitest";

import type { SiteContent } from "@/types";
import { api, ok } from "@/test/api";

import { getPaymentMethod } from "./orderService";
import {
  getBanners,
  getHomeSectionLayout,
  getHomepageConfig,
  getNavigation,
  getSiteConfig,
  getSiteContent,
  refreshSiteContent,
} from "./siteService";

function siteContent(overrides: Partial<SiteContent> = {}): SiteContent {
  return {
    states: ["Karnataka"],
    contactTopics: [],
    popularSearches: [],
    sortOptions: [],
    ratingFilters: [],
    discountFilters: [],
    deliveryMethods: [{ id: "standard", name: "Standard", description: "", fee: 0, estimate: "" }],
    paymentMethods: [{ id: "upi", name: "UPI", description: "", label: "UPI" }],
    enabledPaymentMethods: ["upi"],
    faqs: [],
    sizeGuide: { intro: "", charts: [] },
    accountNavigation: [],
    adminRoles: [],
    stockAdjustmentReasons: [],
    analyticsRanges: [],
    homeSectionKinds: [],
    homeSectionSources: [],
    ...overrides,
  };
}

beforeEach(() => {
  // getSiteContent is cached per "page" (per document in the browser); drop
  // any value a previous test left behind so each test observes its own fetch.
  refreshSiteContent();
});

describe("getNavigation", () => {
  it("GETs the nav items", async () => {
    api.get("/site/navigation", ok([{ label: "Shop", href: "/shop" }]));
    const result = await getNavigation();
    expect(result).toEqual([{ label: "Shop", href: "/shop" }]);
  });
});

describe("getSiteConfig / getHomepageConfig / getHomeSectionLayout / getBanners", () => {
  it("delegate to the data source's endpoints", async () => {
    api.get("/site/config", { theme: "light" });
    expect(await getSiteConfig()).toEqual({ theme: "light" });

    api.get("/site/homepage", { sections: [{ id: "hero" }] });
    expect(await getHomepageConfig()).toEqual({ sections: [{ id: "hero" }] });

    api.get("/site/homepage", { sections: [{ id: "hero", active: false }] });
    expect(await getHomeSectionLayout()).toEqual([{ id: "hero", active: false }]);

    api.get("/site/banners", ok([{ id: "B1" }]));
    expect(await getBanners()).toEqual([{ id: "B1" }]);
  });
});

describe("getSiteContent", () => {
  it("GETs /site/content and adopts delivery/payment methods as module state", async () => {
    api.get("/site/content", siteContent());
    const content = await getSiteContent();
    expect(content.states).toEqual(["Karnataka"]);
    // Adopted into orderService's module state, usable synchronously elsewhere.
    expect(getPaymentMethod("upi")).toMatchObject({ id: "upi", name: "UPI" });
  });

  it("caches the result for the rest of the page: a second read makes no new request", async () => {
    api.get("/site/content", siteContent());
    await getSiteContent();
    const callsBefore = api.requests("GET", "/site/content").length;
    await getSiteContent();
    expect(api.requests("GET", "/site/content")).toHaveLength(callsBefore);
  });

  it("refreshSiteContent drops the cache so the next read fetches again", async () => {
    api.get("/site/content", siteContent());
    await getSiteContent();
    refreshSiteContent();
    await getSiteContent();
    expect(api.requests("GET", "/site/content")).toHaveLength(2);
  });

  it("defaults every adopted list to empty when the API omits it", async () => {
    const bare = { ...siteContent() } as Partial<SiteContent>;
    delete bare.deliveryMethods;
    delete bare.paymentMethods;
    delete bare.analyticsRanges;
    delete bare.homeSectionKinds;
    api.get("/site/content", bare);
    await expect(getSiteContent()).resolves.toMatchObject({});
    expect(getPaymentMethod("anything")).toMatchObject({ id: "anything" });
  });
});
