import { beforeEach, describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { setUpAdmin } from "@/test/sliceB-admin";

import * as documents from "./documentAdminService";

beforeEach(() => {
  setUpAdmin();
});

describe("site document", () => {
  it("getSiteDocument GETs /admin/settings/site", async () => {
    api.get("/admin/settings/site", { legalName: "DCZ" });
    await expect(documents.getSiteDocument()).resolves.toEqual({ legalName: "DCZ" });
    expect(api.last("GET", "/admin/settings/site")!.headers.authorization).toBe("Bearer test-token");
  });

  it("saveSiteDocument PUTs and resolves ok on success", async () => {
    const value = { legalName: "DCZ Pvt Ltd" };
    api.put("/admin/settings/site", value);
    const result = await documents.saveSiteDocument(value as never);
    expect(result).toEqual({ ok: true, data: value });
    expect(api.last("PUT", "/admin/settings/site")!.body).toEqual(value);
  });

  it("saveSiteDocument surfaces the server's error message", async () => {
    api.put("/admin/settings/site", fail(422, "The logo URL is not valid"));
    const result = await documents.saveSiteDocument({} as never);
    expect(result).toEqual({ ok: false, reason: "The logo URL is not valid" });
  });

  it("falls back to a generic message when the server gives none", async () => {
    api.put("/admin/settings/site", fail(500, ""));
    const result = await documents.saveSiteDocument({} as never);
    expect(result).toEqual({ ok: false, reason: "Those settings could not be saved." });
  });
});

describe("content document", () => {
  it("getContentDocument / saveContentDocument use /admin/settings/content", async () => {
    api.get("/admin/settings/content", { states: ["Kerala"] });
    await expect(documents.getContentDocument()).resolves.toEqual({ states: ["Kerala"] });

    api.put("/admin/settings/content", { states: ["Kerala", "Tamil Nadu"] });
    const result = await documents.saveContentDocument({ states: ["Kerala", "Tamil Nadu"] } as never);
    expect(result).toEqual({ ok: true, data: { states: ["Kerala", "Tamil Nadu"] } });
  });
});

describe("storefront menu", () => {
  it("getStorefrontMenu unwraps items, defaulting to an empty array", async () => {
    api.get("/admin/settings/navigation", { items: [{ label: "Shop", href: "/shop" }] });
    await expect(documents.getStorefrontMenu()).resolves.toEqual([{ label: "Shop", href: "/shop" }]);

    api.get("/admin/settings/navigation", {});
    await expect(documents.getStorefrontMenu()).resolves.toEqual([]);
  });

  it("saveStorefrontMenu wraps the array as { items }", async () => {
    api.put("/admin/settings/navigation", {});
    const items = [{ label: "Shop", href: "/shop" }];
    await documents.saveStorefrontMenu(items as never);
    expect(api.last("PUT", "/admin/settings/navigation")!.body).toEqual({ items });
  });
});

describe("portal menu", () => {
  it("getPortalMenu unwraps groups, defaulting to an empty array", async () => {
    api.get("/admin/settings/admin_navigation", { groups: [{ label: "Catalogue", items: [] }] });
    await expect(documents.getPortalMenu()).resolves.toEqual([{ label: "Catalogue", items: [] }]);

    api.get("/admin/settings/admin_navigation", {});
    await expect(documents.getPortalMenu()).resolves.toEqual([]);
  });

  it("savePortalMenu wraps the array as { groups }", async () => {
    api.put("/admin/settings/admin_navigation", {});
    const groups = [{ label: "Catalogue", items: [] }];
    await documents.savePortalMenu(groups as never);
    expect(api.last("PUT", "/admin/settings/admin_navigation")!.body).toEqual({ groups });
  });
});
