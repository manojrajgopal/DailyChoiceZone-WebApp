import { describe, expect, it } from "vitest";

import { api, fail, ok } from "@/test/api";

import {
  cancelReturn,
  getOrderReturns,
  getReturn,
  listReturns,
  moveReturn,
  requestReturn,
} from "./returnsService";

describe("customer", () => {
  it("getOrderReturns GETs eligibility and requests with customer auth", async () => {
    window.localStorage.setItem("dcz:auth-token", "cust");
    api.get("/orders/O1/returns", { eligibility: { eligible: true }, requests: [] });
    await getOrderReturns("O1");
    expect(api.last()!.headers.authorization).toBe("Bearer cust");
  });

  it("requestReturn POSTs the input and reports ok on success", async () => {
    api.post("/orders/O1/returns", (req) => ({ id: "R1", ...(req.body as object) }));
    const input = { kind: "return" as const, reason: "Damaged", comment: "Box was crushed", items: [{ orderItemId: 1, quantity: 1 }] };
    const result = await requestReturn("O1", input);
    expect(result).toMatchObject({ ok: true, data: { id: "R1" } });
    expect(api.last()!.body).toMatchObject({ reason: "Damaged" });
  });

  it("requestReturn reports the server's message on failure", async () => {
    api.post("/orders/O1/returns", fail(422, "This item is outside the return window."));
    const result = await requestReturn("O1", { kind: "return", reason: "x", comment: "", items: [] });
    expect(result).toEqual({ ok: false, reason: "This item is outside the return window." });
  });

  it("requestReturn falls back to a generic reason for a non-API error", async () => {
    api.post("/orders/O1/returns", fail(500, ""));
    const result = await requestReturn("O1", { kind: "return", reason: "x", comment: "", items: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("We couldn't send your request. Please try again.");
  });

  it("cancelReturn POSTs to the cancel endpoint", async () => {
    api.post("/returns/R1/cancel", { id: "R1", status: "cancelled" });
    const result = await cancelReturn("R1");
    expect(result).toMatchObject({ status: "cancelled" });
  });
});

describe("admin", () => {
  it("listReturns builds a query string only from set filters", async () => {
    api.get(/\/admin\/returns/, ok([]));
    await listReturns({ status: "pending" });
    expect(api.last()!.query.get("status")).toBe("pending");
    expect(api.last()!.query.has("kind")).toBe(false);
  });

  it("listReturns includes the kind filter when given", async () => {
    api.get(/\/admin\/returns/, ok([]));
    await listReturns({ kind: "exchange" });
    expect(api.last()!.query.get("kind")).toBe("exchange");
  });

  it("listReturns sends no query string with no filters", async () => {
    api.get(/\/admin\/returns/, ok([]));
    await listReturns();
    expect(api.last()!.url).not.toContain("?");
  });

  it("getReturn GETs a single return", async () => {
    api.get("/admin/returns/R1", { id: "R1" });
    expect(await getReturn("R1")).toMatchObject({ id: "R1" });
  });

  it("moveReturn PUTs the new status and note, reporting ok on success", async () => {
    api.put("/admin/returns/R1/status", (req) => ({ id: "R1", ...(req.body as object) }));
    const result = await moveReturn("R1", "approved" as never, "Looks good");
    expect(result).toMatchObject({ ok: true, data: { status: "approved" } });
    expect(api.last()!.body).toEqual({ status: "approved", note: "Looks good" });
  });

  it("moveReturn reports a failure reason", async () => {
    api.put("/admin/returns/R1/status", fail(409, "Already resolved"));
    const result = await moveReturn("R1", "approved" as never, "");
    expect(result).toEqual({ ok: false, reason: "Already resolved" });
  });

  it("moveReturn falls back to a generic reason for a non-API error", async () => {
    api.put("/admin/returns/R1/status", fail(500, ""));
    const result = await moveReturn("R1", "approved" as never, "");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("That update couldn't be saved. Please try again.");
  });
});
