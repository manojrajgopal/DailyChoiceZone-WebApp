import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SiteContent } from "@/types";

import { api, fail } from "@/test/api";

const CONTENT = {
  states: ["Kerala"],
  contactTopics: [],
  popularSearches: [],
  sortOptions: [],
  ratingFilters: [],
  discountFilters: [],
  deliveryMethods: [],
  paymentMethods: [],
  enabledPaymentMethods: [],
  faqs: [],
  sizeGuide: { intro: "", charts: [] },
  accountNavigation: [],
  adminRoles: [],
  stockAdjustmentReasons: [],
  analyticsRanges: [],
  homeSectionKinds: [],
  homeSectionSources: [],
} as unknown as SiteContent;

/**
 * `getSiteContent` caches its result for the life of the module (see
 * `pageCache`), so each test resets the module graph and re-imports fresh —
 * otherwise only the first test's request would ever reach the fake API.
 */
async function freshHook() {
  vi.resetModules();
  const mod = await import("./useSiteContent");
  return mod.useSiteContent;
}

describe("useSiteContent", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it("is null until the content arrives, then holds it", async () => {
    api.get("/site/content", CONTENT);
    const useSiteContent = await freshHook();
    const { result } = renderHook(() => useSiteContent());
    expect(result.current).toBeNull();

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.states).toEqual(["Kerala"]);
  });

  it("stays null when the request fails, without throwing", async () => {
    api.get("/site/content", fail(500));
    const useSiteContent = await freshHook();
    const { result } = renderHook(() => useSiteContent());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current).toBeNull();
  });

  it("shares one request between several callers on the same page", async () => {
    api.get("/site/content", CONTENT);
    const useSiteContent = await freshHook();
    renderHook(() => useSiteContent());
    const { result } = renderHook(() => useSiteContent());
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(api.requests("GET", "/site/content")).toHaveLength(1);
  });

  it("does not update state after unmount", async () => {
    api.get("/site/content", CONTENT);
    const useSiteContent = await freshHook();
    const { unmount } = renderHook(() => useSiteContent());
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
