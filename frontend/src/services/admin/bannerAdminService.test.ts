import { beforeEach, describe, expect, it } from "vitest";

import { api } from "@/test/api";
import { setUpAdmin } from "@/test/sliceB-admin";

import * as banners from "./bannerAdminService";

beforeEach(() => {
  setUpAdmin();
  api.get("/admin/banners", []);
});

describe("listBanners", () => {
  it("GETs /admin/banners", async () => {
    await banners.listBanners();
    expect(api.last("GET", "/admin/banners")!.headers.authorization).toBe("Bearer test-token");
  });
});

describe("isLive", () => {
  const now = new Date("2024-06-15T00:00:00Z");

  const cases: [{ active: boolean; startsAt: string; endsAt: string | null }, boolean, string][] = [
    [{ active: false, startsAt: "2024-01-01", endsAt: null }, false, "inactive"],
    [{ active: true, startsAt: "2024-07-01", endsAt: null }, false, "not started yet"],
    [{ active: true, startsAt: "2024-01-01", endsAt: "2024-05-01" }, false, "already ended"],
    [{ active: true, startsAt: "2024-01-01", endsAt: null }, true, "active, started, no end"],
    [{ active: true, startsAt: "2024-01-01", endsAt: "2024-12-31" }, true, "active and within its window"],
  ];

  it.each(cases)("%j -> %s (%s)", (partial, expected) => {
    expect(banners.isLive(partial as never, now)).toBe(expected);
  });
});

describe("saveBanner", () => {
  const base = { id: "", title: "Big summer sale", subtitle: "", image: "", buttonText: "", buttonLink: "", startsAt: "2024-01-01", endsAt: null, active: true, displayOrder: 1 };

  it("refuses a message shorter than 4 characters", async () => {
    const result = await banners.saveBanner({ ...base, title: "Hi" });
    expect(result).toEqual({ ok: false, reason: "Enter a banner message of at least four characters." });
  });

  it("refuses a button with text but no link", async () => {
    const result = await banners.saveBanner({ ...base, buttonText: "Shop now", buttonLink: "" });
    expect(result).toEqual({ ok: false, reason: "A button needs a link." });
  });

  it("refuses a link that isn't a path on the store", async () => {
    const result = await banners.saveBanner({ ...base, buttonText: "Shop now", buttonLink: "https://elsewhere.com" });
    expect(result).toEqual({ ok: false, reason: "Please link to a page on your store, for example /shop/sale." });
  });

  it("refuses an end date before the start date", async () => {
    const result = await banners.saveBanner({ ...base, startsAt: "2024-06-01", endsAt: "2024-01-01" });
    expect(result).toEqual({ ok: false, reason: "The end date must be after the start date." });
  });

  it("saves a valid banner", async () => {
    api.post("/admin/banners", (req) => req.body);
    const result = await banners.saveBanner(base);
    expect(result).toEqual({ ok: true, data: base });
  });
});

describe("toggleBanner", () => {
  it("refuses when the banner no longer exists", async () => {
    const result = await banners.toggleBanner("missing");
    expect(result).toEqual({ ok: false, reason: "That banner no longer exists." });
  });

  it("flips active to its opposite", async () => {
    api.get("/admin/banners", [{ id: "BNR1", title: "Sale", active: true, startsAt: "2024-01-01", endsAt: null, buttonText: "", buttonLink: "" }]);
    api.put("/admin/banners/BNR1", (req) => req.body);
    const result = await banners.toggleBanner("BNR1");
    expect(result).toMatchObject({ ok: true, data: { active: false } });
  });
});

describe("moveBanner", () => {
  const rows = [
    { id: "BNR1", title: "A", displayOrder: 1, active: true, startsAt: "2024-01-01", endsAt: null, buttonText: "", buttonLink: "" },
    { id: "BNR2", title: "B", displayOrder: 2, active: true, startsAt: "2024-01-01", endsAt: null, buttonText: "", buttonLink: "" },
  ];

  it("does nothing at the top edge", async () => {
    api.get("/admin/banners", rows);
    const result = await banners.moveBanner("BNR1", "up");
    expect(result).toEqual(rows);
    expect(api.requests("POST")).toHaveLength(0);
  });

  it("does nothing at the bottom edge", async () => {
    api.get("/admin/banners", rows);
    const result = await banners.moveBanner("BNR2", "down");
    expect(result).toEqual(rows);
  });

  it("does nothing for an id that doesn't exist", async () => {
    api.get("/admin/banners", rows);
    const result = await banners.moveBanner("missing", "up");
    expect(result).toEqual(rows);
  });

  it("swaps display order with its neighbour and re-reads the list", async () => {
    api.get("/admin/banners", rows);
    api.put(/^\/admin\/banners\//, {});
    await banners.moveBanner("BNR2", "up");
    const saves = api.requests("PUT", /^\/admin\/banners\//);
    expect(saves).toHaveLength(2);
    expect(saves[0]!.body).toMatchObject({ id: "BNR2", displayOrder: 1 });
    expect(saves[1]!.body).toMatchObject({ id: "BNR1", displayOrder: 2 });
  });
});

describe("deleteBanner", () => {
  it("refuses when missing, deletes and reports the title otherwise", async () => {
    await expect(banners.deleteBanner("missing")).resolves.toEqual({ ok: false, reason: "That banner no longer exists." });

    api.get("/admin/banners", [{ id: "BNR1", title: "Sale" }]);
    api.delete("/admin/banners/BNR1", {});
    await expect(banners.deleteBanner("BNR1")).resolves.toEqual({ ok: true, data: "Sale" });
  });
});

describe("emptyBanner", () => {
  it("is active, with the given display order and blank fields", () => {
    const banner = banners.emptyBanner(3);
    expect(banner).toMatchObject({ title: "", active: true, displayOrder: 3, endsAt: null });
    expect(banner.id).toMatch(/^banner_/);
  });
});
