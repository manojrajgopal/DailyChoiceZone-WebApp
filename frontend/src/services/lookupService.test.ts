import { beforeEach, describe, expect, it } from "vitest";

import { lookupErrorMessage } from "@/lib/lookup/errors";
import { entityHref, idLabel, idPlaceholder, LOOKUP_ENTITIES } from "@/lib/lookup/entities";
import { ApiError } from "@/services/api/client";
import { api, fail } from "@/test/api";
import { signIn } from "@/test/render";

import { clearIdCache, normaliseId, resolveId, searchAllIds, suggestIds } from "./lookupService";

const preview = (entity: string, id: string, volatile: boolean) => ({ entity, id, key: id, volatile, fields: [], related: [] });

beforeEach(() => {
  clearIdCache();
  signIn("admin", "admin-token");
  signIn("customer", "shopper-token");
});

describe("suggestIds", () => {
  it("asks the entity's ID endpoint with the admin token and caps the limit", async () => {
    api.get("/admin/lookup/order", { items: [] });
    await suggestIds("admin", "order", "  DCZ1 ", { limit: 50 });
    const request = api.last("GET", "/admin/lookup/order")!;
    expect(request.query.get("q")).toBe("DCZ1");
    expect(request.query.get("limit")).toBe("20");
    expect(request.headers.authorization).toBe("Bearer admin-token");
  });

  it("uses the customer's own endpoint and token for account lookups", async () => {
    api.get("/account/lookup/order", { items: [] });
    await suggestIds("account", "order", "DCZ");
    expect(api.last("GET", "/account/lookup/order")!.headers.authorization).toBe("Bearer shopper-token");
  });
});

describe("resolveId", () => {
  it("asks for exactly that ID, URL-encoded", async () => {
    api.get(/^\/admin\/lookup\/webhook_event\//, preview("webhook_event", "evt 1", true));
    await resolveId("admin", "webhook_event", "evt 1");
    expect(api.last("GET")!.url).toContain("/admin/lookup/webhook_event/evt%201");
  });

  it("never caches volatile records", async () => {
    api.get("/admin/lookup/order/DCZ1", preview("order", "DCZ1", true));
    await resolveId("admin", "order", "DCZ1");
    await resolveId("admin", "order", "DCZ1");
    expect(api.requests("GET", "/admin/lookup/order/DCZ1")).toHaveLength(2);
  });

  it("reuses slow-moving records, under either spelling, and shares an in-flight request", async () => {
    api.get(/^\/admin\/lookup\/category\//, preview("category", "CAT001", false));
    await Promise.all([resolveId("admin", "category", "cat001"), resolveId("admin", "category", "CAT001")]);
    await resolveId("admin", "category", "CAT001");
    expect(api.requests("GET", /^\/admin\/lookup\/category\//)).toHaveLength(1);
    await resolveId("admin", "category", "CAT001", { fresh: true });
    expect(api.requests("GET", /^\/admin\/lookup\/category\//)).toHaveLength(2);
  });

  it("does not cache a failure", async () => {
    api.once("GET", "/admin/lookup/category/CAT009", fail(500, "x"));
    await expect(resolveId("admin", "category", "CAT009")).rejects.toThrow();
    api.get("/admin/lookup/category/CAT009", preview("category", "CAT009", false));
    await expect(resolveId("admin", "category", "CAT009")).resolves.toMatchObject({ id: "CAT009" });
  });
});

describe("searchAllIds", () => {
  it("asks the global endpoint", async () => {
    api.get("/admin/lookup", { query: "PRD", groups: [], total: 0 });
    await searchAllIds("PRD", { perEntity: 5 });
    expect(api.last("GET", "/admin/lookup")!.query.get("perEntity")).toBe("5");
  });
});

describe("helpers", () => {
  it("normalises like the server", () => {
    expect(normaliseId(" #prd 001 ")).toBe("PRD001");
  });

  it("names the ID a field wants", () => {
    expect(idLabel("purchase_order")).toBe("Purchase order ID");
    expect(idPlaceholder("customer")).toBe("Search Customer ID…");
  });

  it("links every entity somewhere sensible", () => {
    expect(entityHref("admin", "shipment", "42", "DCZ-SH-2026-000001")).toBe("/admin/shipments/detail?id=42");
    expect(entityHref("account", "order", "ORD001", "DCZ10001")).toBe("/account/order?number=DCZ10001");
    expect(entityHref("account", "product", "PRD001", "PRD001")).toBeUndefined();
    expect(entityHref("admin", "packing_job", "8", "8")).toBe("/admin/packing/job?id=8");
    expect(entityHref("admin", "referral_code", "ASHA2026", "ASHA2026")).toBe("/admin/referrals?q=ASHA2026");
    // One per backend registry entry (app/services/lookup/registry.py).
    expect(Object.keys(LOOKUP_ENTITIES)).toHaveLength(39);
  });

  it.each([
    [new ApiError("Product ID PRD9 was not found.", 404, "LOOKUP_NOT_FOUND"), "Product ID PRD9 was not found."],
    [new ApiError("", 404, "NOT_FOUND"), "Product ID PRD9 was not found."],
    [new ApiError("Invalid Product ID.", 422, "LOOKUP_INVALID_ID"), "Invalid Product ID."],
    [new ApiError("x", 400, "BAD"), "x"],
    [new ApiError("x", 401, "TOKEN_INVALID"), "Your session has ended. Sign in again to look IDs up."],
    [new ApiError("x", 403, "PERMISSION_DENIED"), "You don't have access to product records."],
    [new ApiError("x", 409, "CONFLICT"), "That record changed while it was loading. Please try again."],
    [new ApiError("x", 429, "RATE_LIMITED"), "That's a lot of lookups in a short time. Please wait a moment and try again."],
    [new ApiError("Traceback: boom", 500, "INTERNAL"), "Something went wrong looking that ID up. Please try again."],
    [new ApiError("Too slow", 0, "TIMEOUT"), "Too slow"],
    [new ApiError("Offline", 0, "NETWORK_ERROR"), "Offline"],
    [new Error("weird"), "Something went wrong looking that ID up. Please try again."],
  ])("explains %s in plain words", (error, message) => {
    expect(lookupErrorMessage(error, { idLabel: "Product ID", id: "PRD9" })).toBe(message);
  });
});
