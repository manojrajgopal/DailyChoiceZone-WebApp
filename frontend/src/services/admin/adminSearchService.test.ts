import { beforeEach, describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { setUpAdmin } from "@/test/sliceB-admin";

import { EMPTY_SEARCH_RESULTS, listNotifications, markAllNotificationsRead, markNotificationRead, search } from "./adminSearchService";

const FOUND = {
  query: "DCZ1",
  total: 3,
  groups: [
    { entity: "order", label: "Order", idLabel: "Order ID", query: "DCZ1", hasMore: true, items: [{ id: "DCZ10001" }, { id: "DCZ10002" }] },
    { entity: "product", label: "Product", idLabel: "Product ID", query: "DCZ1", hasMore: false, items: [{ id: "PRD007", match: "DCZ-AC0140" }] },
  ],
};

beforeEach(() => {
  setUpAdmin();
});

describe("search", () => {
  it("is empty for a term shorter than two characters, without calling anything", async () => {
    expect(await search("D")).toEqual(EMPTY_SEARCH_RESULTS);
    expect(api.requests()).toHaveLength(0);
  });

  it("asks the ID lookup once — never a list download", async () => {
    api.get("/admin/lookup", FOUND);
    await search(" DCZ1 ", 4);
    expect(api.requests()).toHaveLength(1);
    const request = api.last("GET", "/admin/lookup")!;
    expect(request.query.get("q")).toBe("DCZ1");
    expect(request.query.get("perEntity")).toBe("4");
    expect(api.requests("GET", /^\/admin\/(orders|customers|products|billing)/)).toHaveLength(0);
  });

  it("groups the IDs by entity and totals them", async () => {
    api.get("/admin/lookup", FOUND);
    const results = await search("DCZ1");
    expect(results.total).toBe(3);
    expect(results.groups.map((g) => g.entity)).toEqual(["order", "product"]);
    expect(results.groups[1]!.items[0]).toEqual({ entity: "product", label: "Product", id: "PRD007", match: "DCZ-AC0140" });
  });

  it("lets a failure reach the caller", async () => {
    api.get("/admin/lookup", fail(500, "boom"));
    await expect(search("DCZ1")).rejects.toThrow();
  });
});

describe("notifications", () => {
  it("lists, marks one read and marks all read", async () => {
    api.get("/admin/notifications", []);
    await listNotifications();
    expect(api.last("GET", "/admin/notifications")).toBeTruthy();

    api.put("/admin/notifications/N1/read", {});
    await markNotificationRead("N1");
    expect(api.last("PUT", "/admin/notifications/N1/read")).toBeTruthy();

    api.put("/admin/notifications/read-all", {});
    await markAllNotificationsRead();
    expect(api.last("PUT", "/admin/notifications/read-all")).toBeTruthy();
  });
});
