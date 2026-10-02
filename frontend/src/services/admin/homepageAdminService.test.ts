import { beforeEach, describe, expect, it } from "vitest";

import type { AdminHomeSection } from "@/types/admin";

import { api } from "@/test/api";
import { setUpAdmin } from "@/test/sliceB-admin";

import * as homepage from "./homepageAdminService";

const SECTIONS: AdminHomeSection[] = [
  { id: "S1", type: "product-carousel", title: "New in", subtitle: "", source: "new-arrivals", limit: 6, active: true, displayOrder: 1 },
  { id: "S2", type: "product-grid", title: "Trending", subtitle: "", source: "trending", limit: 6, active: false, displayOrder: 2 },
];

beforeEach(() => {
  setUpAdmin();
  api.get("/admin/homepage", SECTIONS);
});

describe("getSections / saveSections", () => {
  it("GETs and PUTs /admin/homepage", async () => {
    await homepage.getSections();
    expect(api.last("GET", "/admin/homepage")!.headers.authorization).toBe("Bearer test-token");

    api.put("/admin/homepage", SECTIONS);
    await homepage.saveSections(SECTIONS);
    // Only the editable fields travel — see the adapter's own `saveHomepage`.
    expect(api.last("PUT", "/admin/homepage")!.body).toEqual(
      SECTIONS.map((s) => ({ id: s.id, active: s.active, displayOrder: s.displayOrder, title: s.title, subtitle: s.subtitle })),
    );
  });
});

describe("moveSection", () => {
  it("does nothing at the edges or for a missing id", async () => {
    await expect(homepage.moveSection("S1", "up")).resolves.toEqual(SECTIONS);
    await expect(homepage.moveSection("S2", "down")).resolves.toEqual(SECTIONS);
    await expect(homepage.moveSection("missing", "up")).resolves.toEqual(SECTIONS);
    expect(api.requests("PUT")).toHaveLength(0);
  });

  it("swaps two sections and saves the whole reordered list", async () => {
    api.put("/admin/homepage", (req) => req.body);
    const result = await homepage.moveSection("S2", "up");
    expect((result as AdminHomeSection[]).map((s) => s.id)).toEqual(["S2", "S1"]);
  });
});

describe("toggleSection", () => {
  it("flips active and saves the whole list", async () => {
    api.put("/admin/homepage", (req) => req.body);
    const result = await homepage.toggleSection("S1");
    expect((result as AdminHomeSection[]).find((s) => s.id === "S1")?.active).toBe(false);
    expect((result as AdminHomeSection[]).find((s) => s.id === "S2")?.active).toBe(false);
  });
});

describe("saveSection", () => {
  const draft: AdminHomeSection = { id: "S9", type: "product-grid", title: "Deals", subtitle: "", source: "deals", limit: 6, active: true, displayOrder: 3 };

  it("refuses a title shorter than 2 characters", async () => {
    const result = await homepage.saveSection({ ...draft, title: "D" });
    expect(result).toEqual({ ok: false, reason: "Enter a section title." });
  });

  it("refuses a source-needing kind with no source chosen", async () => {
    homepage.setSectionKinds([{ value: "product-grid", label: "Product grid", needsSource: true }]);
    const result = await homepage.saveSection({ ...draft, source: null });
    expect(result).toEqual({ ok: false, reason: "Choose which products feed this section." });
  });

  it("refuses a source-needing kind with a limit below one", async () => {
    homepage.setSectionKinds([{ value: "product-grid", label: "Product grid", needsSource: true }]);
    const result = await homepage.saveSection({ ...draft, limit: 0 });
    expect(result).toEqual({ ok: false, reason: "Show at least one product." });
  });

  it("is unaffected by needsSource for a kind that doesn't need one", async () => {
    homepage.setSectionKinds([{ value: "promo-banner", label: "Promo banner", needsSource: false }]);
    api.put("/admin/homepage", {});
    const result = await homepage.saveSection({ ...draft, type: "promo-banner", source: null, limit: 0 });
    expect(result.ok).toBe(true);
  });

  it("appends a new section and saves", async () => {
    api.put("/admin/homepage", (req) => req.body);
    const result = await homepage.saveSection(draft);
    expect(result).toEqual({ ok: true, data: draft });
    expect(api.last("PUT", "/admin/homepage")!.body).toHaveLength(3);
  });

  it("replaces an existing section in place", async () => {
    const updated = { ...SECTIONS[0]!, title: "New arrivals" };
    api.put("/admin/homepage", (req) => req.body);
    await homepage.saveSection(updated);
    const saved = api.last("PUT", "/admin/homepage")!.body as AdminHomeSection[];
    expect(saved).toHaveLength(2);
    expect(saved.find((s) => s.id === "S1")?.title).toBe("New arrivals");
  });
});

describe("deleteSection", () => {
  it("refuses when missing", async () => {
    const result = await homepage.deleteSection("missing");
    expect(result).toEqual({ ok: false, reason: "That section no longer exists." });
  });

  it("removes it and reports its title", async () => {
    api.put("/admin/homepage", (req) => req.body);
    const result = await homepage.deleteSection("S1");
    expect(result).toEqual({ ok: true, data: "New in" });
    const saved = api.last("PUT", "/admin/homepage")!.body as { id: string }[];
    expect(saved.map((s) => s.id)).toEqual(["S2"]);
  });
});

describe("emptySection", () => {
  it("is active, a product carousel of new arrivals, at the given order", () => {
    const section = homepage.emptySection(4);
    expect(section).toMatchObject({ type: "product-carousel", source: "new-arrivals", limit: 6, active: true, displayOrder: 4 });
    expect(section.id).toMatch(/^section_/);
  });
});
