/**
 * An invoice as a spreadsheet: CSV and Excel.
 *
 * Both are built from `invoiceSheet` below, so the two files always carry the
 * same facts in the same order — everything the printed invoice shows: the
 * seller, the invoice and order references, both addresses, the tax details,
 * every line item, every total, the payment and the notes.
 *
 * Why two formats: a CSV file is plain text. It has no way to store a colour,
 * a bold cell or a column width, so it is the portable, importable copy. The
 * Excel file carries the same data colour-coded — header rows, alternating
 * item rows and highlighted amounts — for reading.
 *
 * Amounts are numbers in rupees, not formatted strings, so a spreadsheet can
 * add them up. Money on the invoice is held in paise; see `@/lib/money`.
 */

import type { BillingAddress, BillingConfig, Invoice } from "@/types";

import { escapeCell } from "@/lib/billing/csv";
import { formatDate } from "@/lib/utils/format";
import { paymentMethodLabel } from "@/services/billing/paymentService";

/* -------------------------------------------------------------- the model */

type Cell = string | number;

interface KeyValueSection {
  title: string;
  rows: [label: string, value: Cell][];
}

export interface InvoiceSheet {
  title: string;
  sections: KeyValueSection[];
  items: { headers: string[]; rows: Cell[][]; moneyColumns: number[] };
  totals: { rows: [label: string, value: Cell][]; grandTotal: number };
  closing: KeyValueSection[];
}

const rupees = (paise: number) => Math.round(paise) / 100;

function address(prefix: string, value: BillingAddress): KeyValueSection {
  return {
    title: prefix,
    rows: [
      ["Name", value.fullName],
      ["Address line 1", value.line1],
      ["Address line 2", value.line2 || ""],
      ["City", value.city],
      ["State", value.state],
      ["Postal code", value.postalCode],
      ["Country", value.country],
      ["Phone", value.phone || ""],
      ["Email", value.email || ""],
    ],
  };
}

export function paymentStatusLabel(invoice: Invoice): string {
  if (invoice.paymentStatus === "paid") return "Paid in full";
  if (invoice.paymentStatus === "pending") return "Payable on delivery";
  if (invoice.paymentStatus === "partially-refunded") return "Partially refunded";
  if (invoice.paymentStatus === "refunded") return "Refunded";
  if (invoice.paymentStatus === "failed") return "Payment failed";
  return "Authorised";
}

export function invoiceSheet(invoice: Invoice, config: BillingConfig, gstin = ""): InvoiceSheet {
  const { breakdown } = invoice;
  const tax = breakdown.tax;
  const intraState = tax.mode === "intra-state";
  const half = tax.ratePercent / 2;
  const business = config.business;

  const totals: [string, Cell][] = [["Subtotal", rupees(breakdown.subtotal)]];
  if (breakdown.productDiscount > 0) totals.push(["Product discount", -rupees(breakdown.productDiscount)]);
  if (breakdown.couponDiscount > 0) {
    totals.push([
      `Coupon${breakdown.couponCode ? ` (${breakdown.couponCode})` : ""}`,
      -rupees(breakdown.couponDiscount),
    ]);
  }
  totals.push(["Shipping", breakdown.shipping === 0 ? "Free" : rupees(breakdown.shipping)]);
  if (breakdown.otherCharges > 0) totals.push(["Other charges", rupees(breakdown.otherCharges)]);
  totals.push(["Taxable value", rupees(tax.taxableAmount)]);
  if (intraState) {
    totals.push([`CGST @ ${half}%`, rupees(tax.cgst)]);
    totals.push([`SGST @ ${half}%`, rupees(tax.sgst)]);
  } else {
    totals.push([`IGST @ ${tax.ratePercent}%`, rupees(tax.igst)]);
  }
  totals.push(["Total tax", rupees(tax.totalTax)]);

  const closing: KeyValueSection[] = [
    {
      title: "Payment",
      rows: [
        ["Method", paymentMethodLabel(invoice.paymentMethod)],
        ["Status", paymentStatusLabel(invoice)],
        ["Amount paid", rupees(invoice.amountPaid)],
        ["Amount refunded", rupees(invoice.amountRefunded)],
        ["Payment terms", invoice.terms || ""],
      ],
    },
    { title: "Notes", rows: [["Notes", invoice.notes || ""], ["Footer", config.invoice.footer || ""]] },
  ];

  return {
    title: `Tax Invoice ${invoice.invoiceNumber}`,
    sections: [
      {
        title: "Seller",
        rows: [
          ["Store", business.storeName],
          ["Legal name", business.legalName],
          ["Address", [business.addressLine1, business.addressLine2].filter(Boolean).join(", ")],
          ["City", business.city],
          ["State", business.state],
          ["Postal code", business.postalCode],
          ["Country", business.country],
          ["Email", business.email],
          ["Phone", business.phone],
          ["Website", business.website],
          ["GSTIN", gstin],
        ],
      },
      {
        title: "Invoice",
        rows: [
          ["Invoice number", invoice.invoiceNumber],
          ["Invoice date", formatDate(invoice.issuedAt)],
          ["Order number", invoice.orderNumber],
          ["Due date", formatDate(invoice.dueAt)],
          ["Invoice status", invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)],
          ["Payment status", paymentStatusLabel(invoice)],
          ["Currency", breakdown.currency || "INR"],
        ],
      },
      address("Bill to", invoice.billingAddress),
      address("Ship to", invoice.shippingAddress),
      {
        title: "Tax details",
        rows: [
          ["Place of supply", invoice.placeOfSupply],
          ["Tax treatment", intraState ? "Intra-state (CGST + SGST)" : "Inter-state (IGST)"],
          ["Prices include tax", breakdown.pricesIncludeTax ? "Yes" : "No"],
        ],
      },
    ],
    items: {
      headers: [
        "#", "Item", "SKU", "Size", "Colour", "HSN", "Qty", "Rate", "Line subtotal",
        "Discount", "Taxable value", "Tax rate %", "CGST", "SGST", "IGST", "Total tax", "Amount",
      ],
      rows: invoice.lines.map((line, index) => [
        index + 1,
        line.name,
        line.sku,
        line.size ?? "",
        line.color ?? "",
        line.hsn,
        line.quantity,
        rupees(line.unitPrice),
        rupees(line.lineSubtotal),
        rupees(line.discount),
        rupees(line.taxableAmount),
        line.taxRatePercent,
        rupees(line.cgst),
        rupees(line.sgst),
        rupees(line.igst),
        rupees(line.tax),
        rupees(line.lineTotal),
      ]),
      // Zero-based columns holding rupee amounts: Rate … Amount, except tax rate.
      moneyColumns: [7, 8, 9, 10, 12, 13, 14, 15, 16],
    },
    totals: { rows: totals, grandTotal: rupees(breakdown.grandTotal) },
    closing,
  };
}

/* -------------------------------------------------------------------- CSV */

export function invoiceCsv(sheet: InvoiceSheet): string {
  const lines: string[] = [];
  // Numbers this code computed go out as they are: `escapeCell` guards typed
  // text against formula injection by prefixing a leading "-" with a tab,
  // which would turn "-398.00" into text a spreadsheet cannot add up.
  const NUMERIC = /^-?\d+(\.\d+)?$/;
  const cell = (value: Cell) =>
    typeof value === "number" || (typeof value === "string" && NUMERIC.test(value))
      ? String(value)
      : escapeCell(value);
  const row = (...cells: Cell[]) => lines.push(cells.map(cell).join(","));
  const money = (value: Cell) => (typeof value === "number" ? value.toFixed(2) : value);

  row(sheet.title);
  for (const section of sheet.sections) {
    lines.push("");
    row(section.title.toUpperCase());
    for (const [label, value] of section.rows) row(label, value);
  }

  lines.push("");
  row("ITEMS");
  row(...sheet.items.headers);
  for (const item of sheet.items.rows) {
    row(...item.map((cell, index) => (sheet.items.moneyColumns.includes(index) ? money(cell) : cell)));
  }

  lines.push("");
  row("TOTALS");
  for (const [label, value] of sheet.totals.rows) row(label, money(value));
  row("Grand total", money(sheet.totals.grandTotal));

  for (const section of sheet.closing) {
    lines.push("");
    row(section.title.toUpperCase());
    for (const [label, value] of section.rows) {
      row(label, section.title === "Payment" && typeof value === "number" ? money(value) : value);
    }
  }

  return lines.join("\r\n");
}

/* ------------------------------------------------------------------ Excel */

/** Light fills, as ARGB. Header and amounts are distinct from both row fills. */
const FILL = {
  title: "FF1C1917", // ink — the one dark band
  header: "FF3F3A36", // table header row
  section: "FFF3E4D7", // copper-50: section headings
  even: "FFFBF8F3", // cream
  odd: "FFEEF4EF", // sage-50
  amount: "FFFFF3D6", // amber-50: money cells
  grand: "FFFDE2B8", // grand total
} as const;

export async function invoiceWorkbook(sheet: InvoiceSheet): Promise<Blob> {
  const ExcelJS = (await import("exceljs")).default;
  const book = new ExcelJS.Workbook();
  book.creator = "Daily Choice Zone";
  const ws = book.addWorksheet("Invoice", { views: [{ state: "frozen", ySplit: 1 }] });

  const width = sheet.items.headers.length;
  ws.columns = [
    { width: 6 }, { width: 30 }, { width: 16 }, { width: 8 }, { width: 12 }, { width: 10 },
    { width: 7 }, { width: 12 }, { width: 14 }, { width: 12 }, { width: 14 }, { width: 11 },
    { width: 11 }, { width: 11 }, { width: 11 }, { width: 12 }, { width: 14 },
  ];

  const MONEY = '"₹"#,##0.00;-"₹"#,##0.00';
  const solid = (argb: string) => ({ type: "pattern" as const, pattern: "solid" as const, fgColor: { argb } });
  const thin = { style: "thin" as const, color: { argb: "FFE2DBD2" } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };

  const title = ws.addRow([sheet.title]);
  ws.mergeCells(title.number, 1, title.number, width);
  title.height = 26;
  title.getCell(1).font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
  title.getCell(1).fill = solid(FILL.title);
  title.getCell(1).alignment = { vertical: "middle", indent: 1 };

  const sectionHeading = (text: string) => {
    ws.addRow([]);
    const heading = ws.addRow([text]);
    ws.mergeCells(heading.number, 1, heading.number, width);
    heading.getCell(1).font = { bold: true, color: { argb: "FF7A4A2A" } };
    heading.getCell(1).fill = solid(FILL.section);
  };

  /** Label in B, value in C onwards — alternating fills, money highlighted. */
  const keyValues = (rows: [string, Cell][], moneyLabels: (label: string) => boolean) => {
    rows.forEach(([label, value], index) => {
      const row = ws.addRow(["", label, value]);
      ws.mergeCells(row.number, 3, row.number, 8);
      const fill = solid(index % 2 ? FILL.odd : FILL.even);
      for (let col = 1; col <= 8; col++) row.getCell(col).fill = fill;
      row.getCell(2).font = { bold: true, color: { argb: "FF57514B" } };
      if (typeof value === "number" && moneyLabels(label)) {
        row.getCell(3).numFmt = MONEY;
        row.getCell(3).alignment = { horizontal: "left" };
        row.getCell(3).fill = solid(FILL.amount);
        row.getCell(3).font = { bold: true };
      }
    });
  };

  for (const section of sheet.sections) {
    sectionHeading(section.title);
    keyValues(section.rows, () => false);
  }

  // Items: a proper table.
  sectionHeading("Items");
  const header = ws.addRow(sheet.items.headers);
  header.height = 20;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = solid(FILL.header);
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = border;
  });

  sheet.items.rows.forEach((values, index) => {
    const row = ws.addRow(values);
    const fill = solid(index % 2 ? FILL.odd : FILL.even);
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.border = border;
      cell.fill = fill;
      if (sheet.items.moneyColumns.includes(col - 1)) cell.numFmt = MONEY;
    });
    // The amount column stands out from the stripes.
    const amount = row.getCell(width);
    amount.fill = solid(FILL.amount);
    amount.font = { bold: true };
  });

  sectionHeading("Totals");
  keyValues(sheet.totals.rows, () => true);
  const grand = ws.addRow(["", "Grand total", sheet.totals.grandTotal]);
  ws.mergeCells(grand.number, 3, grand.number, 8);
  for (let col = 1; col <= 8; col++) grand.getCell(col).fill = solid(FILL.grand);
  grand.getCell(2).font = { bold: true, size: 12 };
  grand.getCell(3).font = { bold: true, size: 12 };
  grand.getCell(3).numFmt = MONEY;
  grand.getCell(3).alignment = { horizontal: "left" };

  for (const section of sheet.closing) {
    sectionHeading(section.title);
    keyValues(section.rows, (label) => label.startsWith("Amount"));
  }

  const buffer = await book.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

/* ------------------------------------------------------------------ saving */

export function saveBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
