import { describe, expect, it } from "vitest";

import { api, fail, ok } from "@/test/api";

import {
  createCreditNote,
  getCreditNoteById,
  getCreditNotes,
  getCreditNotesForOrder,
  setCreditNoteStatus,
} from "./creditNoteService";

const NOTE = { id: "CN1", invoiceId: "INV1", status: "issued" as const } as never;

describe("reading", () => {
  it("getCreditNotes / getCreditNoteById / getCreditNotesForOrder delegate correctly", async () => {
    api.get("/admin/billing/credit-notes", ok([{ id: "CN1" }]));
    expect(await getCreditNotes()).toEqual([{ id: "CN1" }]);

    api.get("/admin/billing/credit-notes", ok([{ id: "CN1" }]));
    expect(await getCreditNoteById("CN1")).toEqual({ id: "CN1" });
    expect(await getCreditNoteById("missing")).toBeNull();

    api.get(/\/admin\/billing\/credit-notes/, ok([]));
    await getCreditNotesForOrder("ORD1");
    expect(api.last()!.query.get("orderId")).toBe("ORD1");
  });
});

describe("createCreditNote", () => {
  it("rejects a zero or negative amount without a request", async () => {
    const result = await createCreditNote({ invoiceId: "INV1", total: 0, reason: "x" });
    expect(result).toEqual({ ok: false, reason: "Enter an amount above zero." });
    expect(api.calls).toHaveLength(0);
  });

  it("rejects a blank reason without a request", async () => {
    const result = await createCreditNote({ invoiceId: "INV1", total: 500, reason: "   " });
    expect(result).toEqual({ ok: false, reason: "Give a reason for the credit note." });
    expect(api.calls).toHaveLength(0);
  });

  it("trims the reason and succeeds", async () => {
    api.post("/admin/billing/credit-notes", (req) => ({ id: "CN1", ...(req.body as object) }));
    const result = await createCreditNote({ invoiceId: "INV1", total: 500, reason: "  Damaged item  " });
    expect(result).toEqual({ ok: true, creditNote: expect.objectContaining({ id: "CN1", reason: "Damaged item" }) });
    expect(api.last()!.body).toMatchObject({ reason: "Damaged item" });
  });

  it("reports the server's reason on failure", async () => {
    api.post("/admin/billing/credit-notes", fail(422, "This invoice is already fully credited."));
    const result = await createCreditNote({ invoiceId: "INV1", total: 500, reason: "x" });
    expect(result).toEqual({ ok: false, reason: "This invoice is already fully credited." });
  });

  it("falls back to a generic reason for a non-API error", async () => {
    api.post("/admin/billing/credit-notes", fail(500, ""));
    const result = await createCreditNote({ invoiceId: "INV1", total: 500, reason: "x" });
    expect(result).toEqual({ ok: false, reason: "The credit note could not be issued." });
  });
});

describe("setCreditNoteStatus", () => {
  it("PUTs the new status", async () => {
    api.put("/admin/billing/credit-notes/CN1", (req) => ({ id: "CN1", ...(req.body as object) }));
    const result = await setCreditNoteStatus(NOTE, "cancelled");
    expect(result.status).toBe("cancelled");
    expect(api.last()!.body).toEqual({ status: "cancelled" });
  });
});
