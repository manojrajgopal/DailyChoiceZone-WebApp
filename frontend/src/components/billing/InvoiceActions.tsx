"use client";

import { useCallback } from "react";
import { Download, Printer } from "lucide-react";

import type { BillingConfig, Invoice } from "@/types";

import { Button } from "@/components/ui/Button";
import { toCsv, downloadCsv } from "@/lib/billing/csv";
import { formatMoney } from "@/lib/money";
import { formatDate } from "@/lib/utils/format";
import { toast } from "@/store/toastStore";

/**
 * Print and download, for a single invoice.
 *
 * **Print** marks the document body so the print stylesheet can drop everything
 * except the invoice, then restores it afterwards — including if the print
 * dialog is cancelled, which `afterprint` covers on every browser that matters.
 *
 * **Download** produces a CSV of the invoice's lines and totals. It is
 * deliberately not a PDF: generating a faithful PDF in the browser means
 * shipping a rendering library, and the output still would not match the
 * printed document. A real implementation renders the PDF server-side from the
 * same data — the invoice is a document of record, and the server is the only
 * party that can vouch for it. Until then, print-to-PDF produces the exact
 * document, and the CSV gives the figures in a form a spreadsheet can read.
 *
 * When that endpoint exists this component changes in one place: the download
 * handler becomes a fetch of `GET /billing/invoices/:id/pdf`.
 */

export function useInvoicePrint() {
  return useCallback(() => {
    if (typeof document === "undefined") return;

    const body = document.body;
    body.classList.add("printing-invoice");

    const restore = () => {
      body.classList.remove("printing-invoice");
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);

    window.print();

    // Safari does not always fire afterprint; this is the belt to that braces.
    window.setTimeout(restore, 1500);
  }, []);
}

export function downloadInvoiceCsv(invoice: Invoice): void {
  const rows = invoice.lines.map((line) => ({
    invoice: invoice.invoiceNumber,
    order: invoice.orderNumber,
    date: formatDate(invoice.issuedAt),
    sku: line.sku,
    item: line.name,
    hsn: line.hsn,
    quantity: line.quantity,
    unitPrice: formatMoney(line.unitPrice, { showDecimals: true }),
    discount: formatMoney(line.discount, { showDecimals: true }),
    taxable: formatMoney(line.taxableAmount, { showDecimals: true }),
    taxRate: `${line.taxRatePercent}%`,
    cgst: formatMoney(line.cgst, { showDecimals: true }),
    sgst: formatMoney(line.sgst, { showDecimals: true }),
    igst: formatMoney(line.igst, { showDecimals: true }),
    total: formatMoney(line.lineTotal, { showDecimals: true }),
  }));

  const csv = toCsv(rows, [
    { header: "Invoice", value: (row) => row.invoice },
    { header: "Order", value: (row) => row.order },
    { header: "Date", value: (row) => row.date },
    { header: "SKU", value: (row) => row.sku },
    { header: "Item", value: (row) => row.item },
    { header: "HSN", value: (row) => row.hsn },
    { header: "Qty", value: (row) => row.quantity },
    { header: "Unit price", value: (row) => row.unitPrice },
    { header: "Discount", value: (row) => row.discount },
    { header: "Taxable value", value: (row) => row.taxable },
    { header: "Tax rate", value: (row) => row.taxRate },
    { header: "CGST", value: (row) => row.cgst },
    { header: "SGST", value: (row) => row.sgst },
    { header: "IGST", value: (row) => row.igst },
    { header: "Line total", value: (row) => row.total },
  ]);

  downloadCsv(`${invoice.invoiceNumber}.csv`, csv);
}

export function InvoiceActions({
  invoice,
  config,
  className,
}: {
  invoice: Invoice;
  config: BillingConfig;
  className?: string;
}) {
  void config;
  const print = useInvoicePrint();

  return (
    <div className={className}>
      <Button variant="outline" size="sm" onClick={print}>
        <Printer className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
        Print invoice
      </Button>

      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          downloadInvoiceCsv(invoice);
          toast.success(`${invoice.invoiceNumber} downloaded`);
        }}
      >
        <Download className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
        Download
      </Button>
    </div>
  );
}
