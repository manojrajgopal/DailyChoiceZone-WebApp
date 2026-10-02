import { beforeEach, describe, expect, it } from "vitest";

import { api } from "@/test/api";
import { setUpAdmin } from "@/test/sliceB-admin";

import * as inventory from "./inventoryAdminService";

beforeEach(() => {
  setUpAdmin();
});

describe("listInventory / listStockLog", () => {
  it("GET their own endpoints with the admin token", async () => {
    api.get("/admin/inventory", []);
    await inventory.listInventory();
    expect(api.last("GET", "/admin/inventory")!.headers.authorization).toBe("Bearer test-token");

    api.get("/admin/inventory/log", []);
    await inventory.listStockLog();
    expect(api.last("GET", "/admin/inventory/log")).toBeTruthy();
  });
});

describe("adjustStock", () => {
  it.each([
    [-1, "Enter a stock quantity of zero or more."],
    [NaN, "Enter a stock quantity of zero or more."],
  ])("refuses an invalid quantity of %p", async (newStock, reason) => {
    const result = await inventory.adjustStock({ productId: "P1", newStock, reason: "correction", note: "", by: "A1" });
    expect(result).toEqual({ ok: false, reason });
    expect(api.requests("PUT")).toHaveLength(0);
  });

  it("accepts zero", async () => {
    api.put("/admin/inventory/P1", { productId: "P1", stock: 0 });
    const result = await inventory.adjustStock({ productId: "P1", newStock: 0, reason: "correction", note: "Recount", by: "A1" });
    expect(result.ok).toBe(true);
  });

  it("stamps the adjustment with the current time and sends it to the adapter", async () => {
    api.put("/admin/inventory/P1", { productId: "P1", stock: 10 });
    await inventory.adjustStock({ productId: "P1", newStock: 10, reason: "restock", note: "Refilled", by: "A1" });
    expect(api.last("PUT", "/admin/inventory/P1")!.body).toEqual({ quantity: 10, reason: "restock", note: "Refilled" });
  });
});
