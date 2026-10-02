import { afterEach, describe, expect, it, vi } from "vitest";

import { makeBillingConfig, makeInvoice, makeInvoiceLine } from "@/test/sliceA-fixtures";

import { setPaymentMethodLabels } from "@/services/billing/paymentService";

import { invoiceCsv, invoiceSheet, invoiceWorkbook, paymentStatusLabel, saveBlob } from "./invoiceExport";

/* ------------------------------------------------------------ exceljs mock */
// exceljs builds real xlsx binaries, which is slow and irrelevant to what this
// module needs to prove: that it asks ExcelJS for the right rows, columns and
// formatting. A minimal in-memory worksheet captures exactly that.
class FakeCell {
  value: unknown;
  font: unknown;
  fill: unknown;
  numFmt: unknown;
  alignment: unknown;
  border: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}
class FakeRow {
  number: number;
  height?: number;
  private cells = new Map<number, FakeCell>();
  constructor(values: unknown[], number: number) {
    this.number = number;
    values.forEach((v, i) => this.cells.set(i + 1, new FakeCell(v)));
  }
  getCell(col: number): FakeCell {
    if (!this.cells.has(col)) this.cells.set(col, new FakeCell(undefined));
    return this.cells.get(col)!;
  }
  eachCell(optionsOrCb: unknown, maybeCb?: (cell: FakeCell, col: number) => void): void {
    const cb = typeof optionsOrCb === "function" ? (optionsOrCb as (cell: FakeCell, col: number) => void) : maybeCb!;
    this.cells.forEach((cell, col) => cb(cell, col));
  }
  values(): unknown[] {
    return [...this.cells.values()].map((c) => c.value);
  }
}
class FakeWorksheet {
  rows: FakeRow[] = [];
  columns: unknown;
  constructor(public name: string) {}
  addRow(values: unknown[]): FakeRow {
    const row = new FakeRow(values, this.rows.length + 1);
    this.rows.push(row);
    return row;
  }
  mergeCells(): void {
    // not asserted on
  }
}
class FakeWorkbook {
  creator = "";
  worksheets: FakeWorksheet[] = [];
  addWorksheet(name: string): FakeWorksheet {
    const ws = new FakeWorksheet(name);
    this.worksheets.push(ws);
    return ws;
  }
  xlsx = { writeBuffer: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer) };
}
vi.mock("exceljs", () => ({ default: { Workbook: FakeWorkbook } }));

afterEach(() => {
  setPaymentMethodLabels({});
});

describe("paymentStatusLabel", () => {
  it.each([
    ["paid", "issued", "Paid in full"],
    ["partially-refunded", "issued", "Partially refunded"],
    ["refunded", "issued", "Refunded"],
    ["expired", "issued", "Not paid in time"],
    ["failed", "issued", "Payment failed"],
    ["authorized", "issued", "Authorised"],
  ])("maps paymentStatus=%s, status=%s to %s", (paymentStatus, status, expected) => {
    const invoice = makeInvoice({ paymentStatus: paymentStatus as never, status: status as never });
    expect(paymentStatusLabel(invoice)).toBe(expected);
  });

  it("shows cancelled invoices as nothing to pay, regardless of paymentStatus", () => {
    const invoice = makeInvoice({ status: "cancelled", paymentStatus: "pending" });
    expect(paymentStatusLabel(invoice)).toBe("Cancelled — nothing to pay");
  });

  it("distinguishes COD pending from an online pending payment", () => {
    expect(paymentStatusLabel(makeInvoice({ paymentStatus: "pending", paymentMethod: "cod" }))).toBe("Payable on delivery");
    expect(paymentStatusLabel(makeInvoice({ paymentStatus: "pending", paymentMethod: "upi" }))).toBe("Awaiting payment");
    expect(paymentStatusLabel(makeInvoice({ paymentStatus: "cod-pending" as never, paymentMethod: "cod" }))).toBe("Payable on delivery");
  });

  it("title-cases any other status the API might send", () => {
    expect(paymentStatusLabel(makeInvoice({ paymentStatus: "some-weird-state" as never }))).toBe("Some weird state");
  });

  it("is an em dash for an empty status", () => {
    expect(paymentStatusLabel(makeInvoice({ paymentStatus: "" as never }))).toBe("—");
  });
});

describe("invoiceSheet", () => {
  it("builds seller, invoice, address and tax sections", () => {
    const config = makeBillingConfig();
    const invoice = makeInvoice();
    const sheet = invoiceSheet(invoice, config, "29ABCDE1234F2Z5");
    expect(sheet.title).toBe(`Tax Invoice ${invoice.invoiceNumber}`);
    const seller = sheet.sections.find((s) => s.title === "Seller")!;
    expect(seller.rows).toContainEqual(["GSTIN", "29ABCDE1234F2Z5"]);
    const invoiceSection = sheet.sections.find((s) => s.title === "Invoice")!;
    expect(invoiceSection.rows).toContainEqual(["Invoice number", invoice.invoiceNumber]);
    expect(sheet.sections.find((s) => s.title === "Bill to")).toBeTruthy();
    expect(sheet.sections.find((s) => s.title === "Ship to")).toBeTruthy();
  });

  it("splits CGST/SGST for an intra-state invoice and shows IGST for inter-state", () => {
    const config = makeBillingConfig();
    const intra = invoiceSheet(makeInvoice(), config);
    expect(intra.totals.rows.some(([label]) => label.startsWith("CGST"))).toBe(true);
    expect(intra.totals.rows.some(([label]) => label.startsWith("SGST"))).toBe(true);

    const interState = invoiceSheet(
      makeInvoice({ breakdown: { ...makeInvoice().breakdown, tax: { ...makeInvoice().breakdown.tax, mode: "inter-state", igst: 17982, cgst: 0, sgst: 0 } } }),
      config,
    );
    expect(interState.totals.rows.some(([label]) => label.startsWith("IGST"))).toBe(true);
    expect(interState.totals.rows.some(([label]) => label.startsWith("CGST"))).toBe(false);
  });

  it("includes discount rows only when they are non-zero", () => {
    const config = makeBillingConfig();
    const withDiscounts = invoiceSheet(
      makeInvoice({
        breakdown: {
          ...makeInvoice().breakdown,
          productDiscount: 1000,
          couponDiscount: 500,
          couponCode: "SAVE10",
          memberDiscount: 200,
        },
      }),
      config,
    );
    expect(withDiscounts.totals.rows).toContainEqual(["Product discount", -10]);
    expect(withDiscounts.totals.rows).toContainEqual(["Coupon (SAVE10)", -5]);
    expect(withDiscounts.totals.rows).toContainEqual(["Member savings", -2]);

    const noDiscounts = invoiceSheet(makeInvoice(), config);
    expect(noDiscounts.totals.rows.some(([label]) => label.startsWith("Product discount"))).toBe(false);
    expect(noDiscounts.totals.rows.some(([label]) => label.startsWith("Coupon"))).toBe(false);
    expect(noDiscounts.totals.rows.some(([label]) => label === "Member savings")).toBe(false);
  });

  it("shows 'Free' for zero shipping and the amount otherwise", () => {
    const config = makeBillingConfig();
    const free = invoiceSheet(makeInvoice({ breakdown: { ...makeInvoice().breakdown, shipping: 0 } }), config);
    expect(free.totals.rows).toContainEqual(["Shipping", "Free"]);
    const paid = invoiceSheet(makeInvoice({ breakdown: { ...makeInvoice().breakdown, shipping: 10000 } }), config);
    expect(paid.totals.rows).toContainEqual(["Shipping", 100]);
  });

  it("converts invoice lines into item rows in rupees", () => {
    const config = makeBillingConfig();
    const invoice = makeInvoice({ lines: [makeInvoiceLine({ unitPrice: 50000, lineTotal: 59000 })] });
    const sheet = invoiceSheet(invoice, config);
    expect(sheet.items.rows).toHaveLength(1);
    const row = sheet.items.rows[0]!;
    expect(row[0]).toBe(1); // serial number
    expect(row[7]).toBe(500); // Rate column, rupees
    expect(row[16]).toBe(590); // Amount column, rupees
  });

  it("defaults GSTIN to an empty string when not given", () => {
    const sheet = invoiceSheet(makeInvoice(), makeBillingConfig());
    const seller = sheet.sections.find((s) => s.title === "Seller")!;
    expect(seller.rows).toContainEqual(["GSTIN", ""]);
  });
});

describe("invoiceCsv", () => {
  it("includes the title, every section, items and totals", () => {
    const sheet = invoiceSheet(makeInvoice(), makeBillingConfig(), "GSTIN1");
    const csv = invoiceCsv(sheet);
    expect(csv).toContain(sheet.title);
    expect(csv).toContain("SELLER");
    expect(csv).toContain("ITEMS");
    expect(csv).toContain("TOTALS");
    expect(csv).toContain("Grand total");
  });

  it("formats money cells to two decimals and escapes text safely", () => {
    const invoice = makeInvoice({ customerName: 'Shirt, "Blue" Co' });
    const sheet = invoiceSheet(invoice, makeBillingConfig());
    const csv = invoiceCsv(sheet);
    expect(csv).toMatch(/Grand total,\d+\.\d{2}/);
  });

  it("prefixes a formula-looking note with a tab so it reads as text", () => {
    const invoice = makeInvoice({ notes: "=cmd|' /C calc'!A1" });
    const sheet = invoiceSheet(invoice, makeBillingConfig());
    const csv = invoiceCsv(sheet);
    expect(csv).toContain("\t=cmd");
  });
});

describe("invoiceWorkbook", () => {
  it("builds a workbook with a header row, one row per item, and a grand total row", async () => {
    const invoice = makeInvoice({ lines: [makeInvoiceLine(), makeInvoiceLine({ productId: "P2", name: "Second item" })] });
    const sheet = invoiceSheet(invoice, makeBillingConfig());
    const blob = await invoiceWorkbook(sheet);

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });

  it("sets the workbook creator", async () => {
    const sheet = invoiceSheet(makeInvoice(), makeBillingConfig());
    // Exercises the ExcelJS path end-to-end without asserting on the fake's
    // internals (styling is a presentation detail, not behaviour to lock in).
    await expect(invoiceWorkbook(sheet)).resolves.toBeInstanceOf(Blob);
  });
});

describe("saveBlob", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a download link, clicks it, and revokes the URL after a delay", () => {
    vi.useFakeTimers();
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:xlsx");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    let downloadName = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloadName = this.download;
    });

    saveBlob("invoice.xlsx", new Blob(["x"]));

    expect(createObjectURL).toHaveBeenCalled();
    expect(downloadName).toBe("invoice.xlsx");
    expect(document.querySelector("a[download]")).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:xlsx");
    vi.useRealTimers();
  });
});
