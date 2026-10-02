import { describe, expect, it } from "vitest";

import { makeInvoice, makePayment } from "@/test/sliceA-fixtures";
import { api, fail, ok } from "@/test/api";

import { httpBillingAdapter } from "./http-billing-adapter";

describe("invoices", () => {
  it("listInvoices builds a query from the given filters, with admin auth", async () => {
    window.localStorage.setItem("dcz:admin-token", "adm");
    api.get("/admin/billing/invoices", ok([makeInvoice()]));
    await httpBillingAdapter.listInvoices({ search: "DCZ-1", status: "issued", minAmount: 1000 });
    const request = api.last()!;
    expect(request.headers.authorization).toBe("Bearer adm");
    expect(request.query.get("search")).toBe("DCZ-1");
    expect(request.query.get("status")).toBe("issued");
    expect(request.query.get("minAmount")).toBe("1000");
  });

  it("getInvoice is null rather than throwing on any failure", async () => {
    api.get("/admin/billing/invoices/INV1", makeInvoice({ id: "INV1" }));
    expect((await httpBillingAdapter.getInvoice("INV1"))?.id).toBe("INV1");
    api.get("/admin/billing/invoices/missing", fail(500));
    expect(await httpBillingAdapter.getInvoice("missing")).toBeNull();
  });

  it("getInvoiceByOrderId filters by orderId and takes the first match", async () => {
    api.get(/\/admin\/billing\/invoices/, ok([makeInvoice({ id: "INV1" })]));
    const result = await httpBillingAdapter.getInvoiceByOrderId("ORD1");
    expect(result?.id).toBe("INV1");
    expect(api.last()!.query.get("orderId")).toBe("ORD1");
  });

  it("getInvoiceByOrderId is null when nothing matches", async () => {
    api.get(/\/admin\/billing\/invoices/, ok([]));
    expect(await httpBillingAdapter.getInvoiceByOrderId("missing")).toBeNull();
  });

  it("listMyInvoices / getMyInvoice use customer auth and are null on failure", async () => {
    window.localStorage.setItem("dcz:auth-token", "cust");
    api.get("/invoices", ok([makeInvoice()]));
    await httpBillingAdapter.listMyInvoices();
    expect(api.last()!.headers.authorization).toBe("Bearer cust");

    api.get("/invoices/INV1", makeInvoice({ id: "INV1" }));
    expect((await httpBillingAdapter.getMyInvoice("INV1"))?.id).toBe("INV1");
    api.get("/invoices/missing", fail(404));
    expect(await httpBillingAdapter.getMyInvoice("missing")).toBeNull();
  });

  it("updateInvoice POSTs the amount paid to mark-paid", async () => {
    api.post("/admin/billing/invoices/INV1/mark-paid", (req) => makeInvoice({ id: "INV1", amountPaid: (req.body as { amount: number }).amount }));
    const result = await httpBillingAdapter.updateInvoice(makeInvoice({ id: "INV1", amountPaid: 50000 }));
    expect(result.amountPaid).toBe(50000);
    expect(api.last()!.body).toEqual({ amount: 50000 });
  });
});

describe("payments", () => {
  it("listPayments builds a query from the given filters", async () => {
    api.get("/admin/billing/payments", ok([makePayment()]));
    await httpBillingAdapter.listPayments({ search: "TXN1", status: "paid", method: "upi" });
    const request = api.last()!;
    expect(request.query.get("search")).toBe("TXN1");
    expect(request.query.get("status")).toBe("paid");
    expect(request.query.get("method")).toBe("upi");
  });

  it("getPayment is null on failure", async () => {
    api.get("/admin/billing/payments/PAY1", makePayment({ id: "PAY1" }));
    expect((await httpBillingAdapter.getPayment("PAY1"))?.id).toBe("PAY1");
    api.get("/admin/billing/payments/missing", fail(500));
    expect(await httpBillingAdapter.getPayment("missing")).toBeNull();
  });

  it("getPaymentByOrderId filters and takes the first match, or null", async () => {
    api.get(/\/admin\/billing\/payments/, ok([makePayment({ id: "PAY1" })]));
    expect((await httpBillingAdapter.getPaymentByOrderId("ORD1"))?.id).toBe("PAY1");
    api.get(/\/admin\/billing\/payments/, ok([]));
    expect(await httpBillingAdapter.getPaymentByOrderId("ORD2")).toBeNull();
  });

  it("updatePayment POSTs to capture with no body", async () => {
    api.post("/admin/billing/payments/PAY1/capture", (req) => makePayment({ id: "PAY1", echo: req.body } as never));
    await httpBillingAdapter.updatePayment(makePayment({ id: "PAY1" }));
    expect(api.last()!.body).toEqual({});
  });
});

describe("refunds", () => {
  it("listRefunds builds a query from the given filters", async () => {
    api.get("/admin/billing/refunds", ok([]));
    await httpBillingAdapter.listRefunds({ status: "requested", orderId: "ORD1" });
    const request = api.last()!;
    expect(request.query.get("status")).toBe("requested");
    expect(request.query.get("orderId")).toBe("ORD1");
  });

  it("getRefund finds a refund by id out of the full list, or null", async () => {
    api.get("/admin/billing/refunds", ok([{ id: "R1" }]));
    expect(await httpBillingAdapter.getRefund("R1")).toEqual({ id: "R1" });
    expect(await httpBillingAdapter.getRefund("missing")).toBeNull();
  });

  it("createRefund defaults lines to [] and status to 'completed'", async () => {
    api.post("/admin/billing/refunds", (req) => ({ id: "R1", ...(req.body as object) }));
    await httpBillingAdapter.createRefund({ invoiceId: "INV1", amount: 5000, reason: "Damaged" });
    expect(api.last()!.body).toEqual({ invoiceId: "INV1", amount: 5000, reason: "Damaged", lines: [], status: "completed" });
  });

  it("createRefund honours given lines and status", async () => {
    api.post("/admin/billing/refunds", (req) => ({ id: "R1", ...(req.body as object) }));
    await httpBillingAdapter.createRefund({
      invoiceId: "INV1", amount: 5000, reason: "Damaged", status: "requested",
      lines: [{ productId: "P1", name: "Shirt", quantity: 1, amount: 5000 }],
    });
    expect(api.last()!.body).toMatchObject({ status: "requested", lines: [{ productId: "P1" }] });
  });

  it("updateRefund PUTs only the status", async () => {
    api.put("/admin/billing/refunds/R1", (req) => ({ id: "R1", ...(req.body as object) }));
    const refund = { id: "R1", status: "completed" } as never;
    await httpBillingAdapter.updateRefund(refund);
    expect(api.last()!.body).toEqual({ status: "completed" });
  });
});

describe("credit notes", () => {
  it("listCreditNotes includes orderId only when given", async () => {
    api.get(/\/admin\/billing\/credit-notes/, ok([]));
    await httpBillingAdapter.listCreditNotes();
    expect(api.last()!.url).not.toContain("orderId");
    await httpBillingAdapter.listCreditNotes("ORD1");
    expect(api.last()!.query.get("orderId")).toBe("ORD1");
  });

  it("getCreditNote finds by id out of the full list, or null", async () => {
    api.get("/admin/billing/credit-notes", ok([{ id: "CN1" }]));
    expect(await httpBillingAdapter.getCreditNote("CN1")).toEqual({ id: "CN1" });
    expect(await httpBillingAdapter.getCreditNote("missing")).toBeNull();
  });

  it("createCreditNote defaults refundId to null and status to 'issued'", async () => {
    api.post("/admin/billing/credit-notes", (req) => ({ id: "CN1", ...(req.body as object) }));
    await httpBillingAdapter.createCreditNote({ invoiceId: "INV1", total: 5000, reason: "Returned" });
    expect(api.last()!.body).toEqual({ invoiceId: "INV1", total: 5000, reason: "Returned", refundId: null, status: "issued" });
  });

  it("updateCreditNote PUTs only the status", async () => {
    api.put("/admin/billing/credit-notes/CN1", (req) => ({ id: "CN1", ...(req.body as object) }));
    await httpBillingAdapter.updateCreditNote({ id: "CN1", status: "cancelled" } as never);
    expect(api.last()!.body).toEqual({ status: "cancelled" });
  });
});

describe("overview / stats / tax report", () => {
  it("getOverview GETs the three-panel summary", async () => {
    api.get("/admin/billing/overview", { recentInvoices: [], openRefunds: [], paymentsByMethod: [] });
    const result = await httpBillingAdapter.getOverview();
    expect(result.recentInvoices).toEqual([]);
  });

  it("getStats / getTaxReport include from/to only when given", async () => {
    api.get(/\/admin\/billing\/stats/, {});
    await httpBillingAdapter.getStats();
    expect(api.last()!.url).not.toContain("?");
    await httpBillingAdapter.getStats("2026-01-01", "2026-01-31");
    expect(api.last()!.query.get("from")).toBe("2026-01-01");
    expect(api.last()!.query.get("to")).toBe("2026-01-31");

    api.get(/\/admin\/billing\/tax-report/, ok([]));
    await httpBillingAdapter.getTaxReport("2026-01-01");
    expect(api.last()!.query.get("from")).toBe("2026-01-01");
    expect(api.last()!.query.has("to")).toBe(false);
  });
});
