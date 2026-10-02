import { describe, expect, it } from "vitest";

import { makeInvoice } from "@/test/sliceA-fixtures";
import { api, fail, ok } from "@/test/api";

import {
  amountDue,
  getInvoiceById,
  getInvoiceByOrderId,
  getInvoices,
  getMyInvoice,
  getMyInvoices,
  isOverdue,
  markInvoicePaid,
  setInvoiceStatus,
  updateInvoice,
} from "./invoiceService";

describe("reading", () => {
  it("getInvoices / getInvoiceById / getInvoiceByOrderId / getMyInvoices / getMyInvoice delegate to the admin or customer endpoints", async () => {
    api.get("/admin/billing/invoices", ok([makeInvoice()]));
    await getInvoices({ status: "issued" });
    expect(api.last()!.query.get("status")).toBe("issued");

    api.get("/admin/billing/invoices/INV1", makeInvoice({ id: "INV1" }));
    expect((await getInvoiceById("INV1"))?.id).toBe("INV1");

    api.get(/\/admin\/billing\/invoices/, ok([makeInvoice({ id: "INV1" })]));
    expect((await getInvoiceByOrderId("ORD1"))?.id).toBe("INV1");

    window.localStorage.setItem("dcz:auth-token", "cust");
    api.get("/invoices", ok([makeInvoice()]));
    await getMyInvoices();
    expect(api.last()!.headers.authorization).toBe("Bearer cust");

    api.get("/invoices/INV1", makeInvoice({ id: "INV1" }));
    expect((await getMyInvoice("INV1"))?.id).toBe("INV1");
  });
});

describe("writing", () => {
  it("updateInvoice POSTs the amount paid to mark-paid", async () => {
    api.post("/admin/billing/invoices/INV1/mark-paid", (req) => makeInvoice({ id: "INV1", amountPaid: (req.body as { amount: number }).amount }));
    const result = await updateInvoice(makeInvoice({ id: "INV1", amountPaid: 99900 }));
    expect(result.amountPaid).toBe(99900);
  });

  it("markInvoicePaid adds the given amount, capped at the grand total", async () => {
    api.post("/admin/billing/invoices/INV1/mark-paid", (req) => makeInvoice({ id: "INV1", amountPaid: (req.body as { amount: number }).amount }));
    const invoice = makeInvoice({ id: "INV1", amountPaid: 0, breakdown: { ...makeInvoice().breakdown, grandTotal: 100000 } });
    await markInvoicePaid(invoice, 30000);
    expect(api.last()!.body).toEqual({ amount: 30000 });

    await markInvoicePaid(invoice, 999999); // caps at the grand total
    expect(api.last()!.body).toEqual({ amount: 100000 });

    await markInvoicePaid(invoice, -500); // never negative
    expect(api.last()!.body).toEqual({ amount: 0 });
  });

  it("markInvoicePaid defaults the amount to what's still owed", async () => {
    api.post("/admin/billing/invoices/INV1/mark-paid", (req) => makeInvoice({ id: "INV1", amountPaid: (req.body as { amount: number }).amount }));
    const invoice = makeInvoice({ id: "INV1", amountPaid: 40000, breakdown: { ...makeInvoice().breakdown, grandTotal: 100000 } });
    await markInvoicePaid(invoice);
    expect(api.last()!.body).toEqual({ amount: 100000 }); // 40000 existing + 60000 default = capped at 100000
  });

  it("setInvoiceStatus updates just the status", async () => {
    api.post("/admin/billing/invoices/INV1/mark-paid", () => makeInvoice({ id: "INV1", status: "cancelled" }));
    const result = await setInvoiceStatus(makeInvoice({ id: "INV1" }), "cancelled");
    expect(result.status).toBe("cancelled");
  });

  it("propagates a server failure", async () => {
    api.post("/admin/billing/invoices/INV1/mark-paid", fail(500));
    await expect(updateInvoice(makeInvoice({ id: "INV1" }))).rejects.toMatchObject({ status: 500 });
  });
});

describe("isOverdue", () => {
  const now = new Date("2026-09-20T00:00:00Z");
  const PAST_DUE = "2026-09-01T00:00:00Z";
  const NOT_YET_DUE = "2026-12-01T00:00:00Z";

  it.each([
    ["a paid invoice, even past its due date", "paid", 0, 100, PAST_DUE, false],
    ["a cancelled invoice, even past its due date", "cancelled", 0, 100, PAST_DUE, false],
    ["fully paid even though status still says issued", "issued", 100, 100, PAST_DUE, false],
    ["unpaid and past its due date", "issued", 0, 100, PAST_DUE, true],
    ["unpaid but not yet due", "issued", 0, 100, NOT_YET_DUE, false],
  ] as [string, string, number, number, string, boolean][])("%s", (_label, status, amountPaid, grandTotal, dueAt, expected) => {
    const invoice = makeInvoice({ status: status as never, amountPaid, breakdown: { ...makeInvoice().breakdown, grandTotal }, dueAt });
    expect(isOverdue(invoice, now)).toBe(expected);
  });
});

describe("amountDue", () => {
  it.each([
    [100000, 0, 0, 100000],
    [100000, 40000, 0, 60000],
    [100000, 40000, 60000, 0],
    [100000, 0, 150000, 0], // never negative
  ])("grandTotal %s, paid %s, refunded %s => due %s", (grandTotal, amountPaid, amountRefunded, expected) => {
    const invoice = makeInvoice({ amountPaid, amountRefunded, breakdown: { ...makeInvoice().breakdown, grandTotal } });
    expect(amountDue(invoice)).toBe(expected);
  });
});
