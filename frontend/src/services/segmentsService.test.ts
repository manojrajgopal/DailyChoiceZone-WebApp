import { describe, expect, it, vi } from "vitest";

import { api, fail, file } from "@/test/api";
import { signIn } from "@/test/render";
import { paged, registry, segment, segmentDetail, settingsResponse } from "@/test/segments-fixtures";

import {
  archiveSegment,
  createSegment,
  exportSegment,
  getSegment,
  getSegmentFields,
  getSegmentationSettings,
  getSegmentationSummary,
  listSegmentMembers,
  listSegments,
  previewSegment,
  recalculateSegment,
  refreshSegmentMetrics,
  restoreSegment,
  saveSegmentationSettings,
  updateSegment,
} from "./segmentsService";

describe("segmentsService", () => {
  it("lists segments with the filters as a query string and the admin token", async () => {
    signIn("admin", "adm");
    api.get("/admin/segments", { ...paged([segment()]), counts: { active: 1, archived: 0 } });
    const page = await listSegments({ q: "vip", status: "all", kind: "default", page: 2, pageSize: 50 });
    const request = api.last("GET", "/admin/segments")!;
    expect(Object.fromEntries(request.query.entries())).toEqual({ q: "vip", status: "all", kind: "default", page: "2", pageSize: "50" });
    expect(request.headers.authorization).toBe("Bearer adm");
    expect(page.items[0]!.name).toBe("VIP");
    expect(page.counts.active).toBe(1);
  });

  it("drops unset filters", async () => {
    api.get("/admin/segments", { ...paged([]), counts: { active: 0, archived: 0 } });
    await listSegments({ q: "", status: "" });
    expect(api.last("GET", "/admin/segments")!.url).not.toContain("?");
  });

  it("reads the field registry", async () => {
    api.get("/admin/segments/fields", registry());
    const fields = await getSegmentFields();
    expect(fields.limits.maxConditions).toBe(30);
  });

  it("previews unsaved rules with paging", async () => {
    api.post("/admin/segments/preview", { count: 3, items: [], page: 1, pageSize: 10, masked: true });
    const result = await previewSegment({ match: "any", rules: [{ field: "totalOrders", operator: "gte", value: 2 }] }, { page: 1, pageSize: 10 });
    expect(api.last("POST", "/admin/segments/preview")!.body).toEqual({
      match: "any",
      rules: [{ field: "totalOrders", operator: "gte", value: 2 }],
      page: 1,
      pageSize: 10,
    });
    expect(result.count).toBe(3);
  });

  it("creates, reads and updates a segment", async () => {
    api.post("/admin/segments", segmentDetail({ id: 9 }));
    api.get("/admin/segments/9", segmentDetail({ id: 9 }));
    api.put("/admin/segments/9", segmentDetail({ id: 9, name: "Renamed" }));

    await createSegment({ name: "Big", description: "", match: "all", rules: [] });
    expect(api.last("POST", "/admin/segments")!.body).toEqual({ name: "Big", description: "", match: "all", rules: [] });

    expect((await getSegment(9)).id).toBe(9);

    const updated = await updateSegment(9, { name: "Renamed" });
    expect(api.last("PUT", "/admin/segments/9")!.body).toEqual({ name: "Renamed" });
    expect(updated.name).toBe("Renamed");
  });

  it("recalculates, archives and restores with POSTs", async () => {
    api.post("/admin/segments/3/recalculate", segmentDetail());
    api.post("/admin/segments/3/archive", segmentDetail({ status: "archived" }));
    api.post("/admin/segments/3/restore", segmentDetail());
    await recalculateSegment(3);
    expect((await archiveSegment(3)).status).toBe("archived");
    await restoreSegment(3);
    expect(api.requests("POST").map((call) => call.path)).toEqual([
      "/admin/segments/3/recalculate",
      "/admin/segments/3/archive",
      "/admin/segments/3/restore",
    ]);
  });

  it("pages and searches members", async () => {
    api.get("/admin/segments/3/members", { ...paged([]), masked: true });
    const result = await listSegmentMembers(3, { q: "asha", page: 2, pageSize: 25 });
    expect(Object.fromEntries(api.last("GET", "/admin/segments/3/members")!.query.entries())).toEqual({ q: "asha", page: "2", pageSize: "25" });
    expect(result.masked).toBe(true);
  });

  it("downloads the export with the admin token", async () => {
    signIn("admin", "adm");
    api.get("/admin/segments/3/export", file("id,name\n", { "content-disposition": 'attachment; filename="segment-vip-2026-10-08.csv"' }));
    const objectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:segment");
    let saved = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved = this.download;
    });
    await exportSegment(3, "vip");
    expect(saved).toBe("segment-vip-2026-10-08.csv");
    const request = api.last("GET", "/admin/segments/3/export")!;
    expect(request.headers.authorization).toBe("Bearer adm");
    expect(objectUrl).toHaveBeenCalledTimes(1);
  });

  it("explains a refused export", async () => {
    api.get("/admin/segments/3/export", fail(403, "Your role can't export segments.", "FORBIDDEN"));
    await expect(exportSegment(3)).rejects.toMatchObject({ status: 403, message: "Your role can't export segments." });
  });

  it("reads and saves the RFM settings", async () => {
    api.get("/admin/segments/settings", settingsResponse());
    api.put("/admin/segments/settings", settingsResponse());
    const current = await getSegmentationSettings();
    await saveSegmentationSettings(current.settings);
    expect(api.last("PUT", "/admin/segments/settings")!.body).toEqual(settingsResponse().settings);
  });

  it("refreshes metrics and reads the summary", async () => {
    api.post("/admin/segments/metrics/refresh", { refreshed: 120, segments: 15 });
    api.get("/admin/segments/summary", { totalCustomers: 1, newCustomers30d: 0, returningCustomers: 0, vip: 0, atRisk: 0, activeSegments: 15, oldestRefreshAt: null });
    expect(await refreshSegmentMetrics()).toEqual({ refreshed: 120, segments: 15 });
    expect((await getSegmentationSummary()).activeSegments).toBe(15);
  });
});
