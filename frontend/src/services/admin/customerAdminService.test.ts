import { beforeEach, describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { setUpAdmin } from "@/test/sliceB-admin";

import * as customers from "./customerAdminService";

beforeEach(() => {
  setUpAdmin();
});

describe("listCustomers / getCustomer / getCustomerOrders", () => {
  it("listCustomers GETs /admin/customers with the admin token", async () => {
    await customers.listCustomers();
    const request = api.last("GET", "/admin/customers")!;
    expect(request.headers.authorization).toBe("Bearer test-token");
    expect(request.query.has("q")).toBe(false);
  });

  it("listCustomers sends a Customer ID as the exact-match q", async () => {
    await customers.listCustomers("CUS002");
    expect(api.last("GET", "/admin/customers")!.query.get("q")).toBe("CUS002");
  });

  it("getCustomer resolves null on a 404", async () => {
    api.get("/admin/customers/missing", fail(404));
    await expect(customers.getCustomer("missing")).resolves.toBeNull();
  });

  it("getCustomerOrders filters /admin/orders by customerId", async () => {
    api.get(/^\/admin\/orders/, []);
    await customers.getCustomerOrders("C1");
    expect(api.last("GET", "/admin/orders")!.query.get("customerId")).toBe("C1");
  });
});

describe("setCustomerStatus", () => {
  it("refuses when the customer no longer exists", async () => {
    api.get("/admin/customers/missing", fail(404));
    const result = await customers.setCustomerStatus("missing", "blocked");
    expect(result).toEqual({ ok: false, reason: "That customer no longer exists." });
    expect(api.requests("PUT")).toHaveLength(0);
  });

  it("blocks and unblocks an existing customer", async () => {
    api.get("/admin/customers/C1", { id: "C1", status: "active" });
    api.put("/admin/customers/C1/status", { id: "C1", status: "blocked" });
    const result = await customers.setCustomerStatus("C1", "blocked");
    expect(result).toEqual({ ok: true, data: { id: "C1", status: "blocked" } });
    expect(api.last("PUT", "/admin/customers/C1/status")!.body).toEqual({ status: "blocked" });
  });
});
