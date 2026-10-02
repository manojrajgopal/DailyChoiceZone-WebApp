import { describe, expect, it } from "vitest";

import { makeBillingConfig } from "@/test/sliceA-fixtures";
import { api, fail, ok } from "@/test/api";

import {
  createRefund,
  getRefundById,
  getRefunds,
  getRefundsForOrder,
  refundReasons,
  setRefundStatus,
} from "./refundService";

const REFUND = { id: "R1", invoiceId: "INV1", status: "requested" as const } as never;

describe("reading", () => {
  it("getRefunds / getRefundById / getRefundsForOrder delegate correctly", async () => {
    api.get("/admin/billing/refunds", ok([{ id: "R1" }]));
    expect(await getRefunds({ status: "requested" })).toEqual([{ id: "R1" }]);
    expect(api.last()!.query.get("status")).toBe("requested");

    api.get("/admin/billing/refunds", ok([{ id: "R1" }]));
    expect(await getRefundById("R1")).toEqual({ id: "R1" });
    expect(await getRefundById("missing")).toBeNull();

    api.get("/admin/billing/refunds", ok([]));
    await getRefundsForOrder("ORD1");
    expect(api.last()!.query.get("orderId")).toBe("ORD1");
  });
});

describe("refundReasons", () => {
  it("reads the reasons from the billing config", async () => {
    api.get("/site/billing-config", makeBillingConfig({ refund: { windowDays: 7, refundShipping: false, reasons: ["Damaged", "Wrong item"] } }));
    expect(await refundReasons()).toEqual(["Damaged", "Wrong item"]);
  });
});

describe("createRefund", () => {
  it("rejects a zero or negative amount without a request", async () => {
    expect(await createRefund({ invoiceId: "INV1", amount: 0, reason: "x" })).toEqual({ ok: false, reason: "Enter a refund amount above zero." });
    expect(api.calls).toHaveLength(0);
  });

  it("rejects a blank reason without a request", async () => {
    expect(await createRefund({ invoiceId: "INV1", amount: 500, reason: "  " })).toEqual({ ok: false, reason: "Choose a reason for the refund." });
    expect(api.calls).toHaveLength(0);
  });

  it("trims the reason and succeeds, defaulting lines/status", async () => {
    api.post("/admin/billing/refunds", (req) => ({ id: "R1", ...(req.body as object) }));
    const result = await createRefund({ invoiceId: "INV1", amount: 500, reason: "  Damaged  " });
    expect(result).toEqual({ ok: true, refund: expect.objectContaining({ id: "R1", reason: "Damaged" }) });
    expect(api.last()!.body).toEqual({ invoiceId: "INV1", amount: 500, reason: "Damaged", lines: [], status: "completed" });
  });

  it("reports the server's reason on failure", async () => {
    api.post("/admin/billing/refunds", fail(409, "Nothing left on this payment to refund."));
    const result = await createRefund({ invoiceId: "INV1", amount: 500, reason: "x" });
    expect(result).toEqual({ ok: false, reason: "Nothing left on this payment to refund." });
  });

  it("falls back to a generic reason for a non-API error", async () => {
    api.post("/admin/billing/refunds", fail(500, ""));
    const result = await createRefund({ invoiceId: "INV1", amount: 500, reason: "x" });
    expect(result).toEqual({ ok: false, reason: "The refund could not be raised." });
  });
});

describe("setRefundStatus", () => {
  it("PUTs the new status and reports ok", async () => {
    api.put("/admin/billing/refunds/R1", (req) => ({ id: "R1", ...(req.body as object) }));
    const result = await setRefundStatus(REFUND, "completed");
    expect(result).toEqual({ ok: true, refund: expect.objectContaining({ status: "completed" }) });
  });

  it("reports a failure reason", async () => {
    api.put("/admin/billing/refunds/R1", fail(500, ""));
    const result = await setRefundStatus(REFUND, "completed");
    expect(result).toEqual({ ok: false, reason: "The refund could not be updated." });
  });
});
