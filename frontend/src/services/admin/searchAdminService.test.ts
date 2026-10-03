import { describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { signIn } from "@/test/render";
import { ApiError } from "@/services/api/client";

import {
  createAttribute,
  deleteAttribute,
  getAttribute,
  getProductAttributes,
  getSearchAnalytics,
  getSearchSettings,
  listAttributes,
  rebuildSearchIndex,
  saveSearchSettings,
  setProductAttributes,
  updateAttribute,
} from "./searchAdminService";

describe("searchAdminService", () => {
  it("lists, reads, creates, updates and deletes attributes with the admin token", async () => {
    signIn("admin", "adm");
    api.get("/admin/attributes", []);
    api.get("/admin/attributes/4", { id: 4 });
    api.post("/admin/attributes", { id: 5 });
    api.put("/admin/attributes/5", { id: 5 });
    api.delete("/admin/attributes/5", null);

    await listAttributes("archived");
    expect(api.last("GET", "/admin/attributes")!.query.get("status")).toBe("archived");
    expect(api.last("GET", "/admin/attributes")!.headers.authorization).toBe("Bearer adm");
    await listAttributes();
    expect(api.last("GET", "/admin/attributes")!.query.get("status")).toBe("all");

    expect(await getAttribute(4)).toEqual({ id: 4 });
    await createAttribute({ code: "fit", label: "Fit", type: "select", options: [{ label: "Slim" }] });
    expect(api.last("POST", "/admin/attributes")!.body).toEqual({ code: "fit", label: "Fit", type: "select", options: [{ label: "Slim" }] });
    await updateAttribute(5, { status: "archived" });
    expect(api.last("PUT", "/admin/attributes/5")!.body).toEqual({ status: "archived" });
    await deleteAttribute(5);
    expect(api.requests("DELETE", "/admin/attributes/5")).toHaveLength(1);
  });

  it("reads and writes a product's values, encoding the id", async () => {
    api.get("/admin/products/P%201/attributes", { productId: "P 1", attributes: [] });
    api.put("/admin/products/P%201/attributes", { productId: "P 1", attributes: [] });
    await getProductAttributes("P 1");
    expect(api.last("GET")!.url).toContain("/admin/products/P%201/attributes");
    await setProductAttributes("P 1", { material: "cotton", weight: null });
    expect(api.last("PUT")!.body).toEqual({ values: { material: "cotton", weight: null } });
  });

  it("calls the search analytics, settings and rebuild endpoints", async () => {
    api.get("/admin/search/analytics", { range: "7d" });
    api.get("/admin/search/settings", { popularMode: "auto" });
    api.put("/admin/search/settings", { popularMode: "curated" });
    api.post("/admin/search/rebuild", { terms: 1, products: 2, unitsSold: 3 });

    await getSearchAnalytics("7d");
    expect(api.last("GET", "/admin/search/analytics")!.query.get("range")).toBe("7d");
    await getSearchAnalytics();
    expect(api.last("GET", "/admin/search/analytics")!.query.get("range")).toBe("30d");
    expect(await getSearchSettings()).toEqual({ popularMode: "auto" });
    await saveSearchSettings({ synonyms: [["a", "b"]] });
    expect(api.last("PUT", "/admin/search/settings")!.body).toEqual({ synonyms: [["a", "b"]] });
    expect(await rebuildSearchIndex()).toEqual({ terms: 1, products: 2, unitsSold: 3 });
  });

  it("surfaces the server's error code", async () => {
    api.delete("/admin/attributes/1", fail(409, "In use.", "ATTRIBUTE_IN_USE"));
    const error = await deleteAttribute(1).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ATTRIBUTE_IN_USE");
  });
});
