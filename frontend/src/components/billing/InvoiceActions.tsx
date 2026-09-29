"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, FileSpreadsheet, FileText, Loader2, Printer, Table } from "lucide-react";

import type { BillingConfig, Invoice } from "@/types";

import { Button } from "@/components/ui/Button";
import { invoiceCsv, invoiceSheet, invoiceWorkbook, saveBlob } from "@/lib/billing/invoiceExport";
import { cn } from "@/lib/utils/cn";
import { toast } from "@/store/toastStore";

/**
 * Print and download, for a single invoice.
 *
 * **Print** copies the invoice into `#invoice-print-root`, a direct child of
 * the body, and marks the body so the print stylesheet shows that copy and
 * nothing else — no site chrome, no browser header or footer, no blank pages
 * after it. See the printing section of `globals.css`.
 *
 * **Download** offers three files:
 * - **PDF** — the printed document, exactly. See `lib/billing/invoicePdf`.
 * - **Excel** — every detail, colour-coded.
 * - **CSV** — every detail, as plain text. CSV cannot hold colours; that is
 *   what the Excel file is for.
 */

/**
 * Put a print-only copy of the invoice on the page. Returns the undo, or null
 * when there is no invoice on the page to copy.
 */
export function prepareInvoicePrint(): (() => void) | null {
  const source = document.querySelector<HTMLElement>(".invoice-document");
  if (!source) return null;

  document.getElementById("invoice-print-root")?.remove();
  const root = document.createElement("div");
  root.id = "invoice-print-root";
  const copy = source.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(".print-hidden").forEach((node) => node.remove());
  root.appendChild(copy);
  document.body.appendChild(root);
  document.body.classList.add("printing-invoice");

  return () => {
    document.body.classList.remove("printing-invoice");
    root.remove();
  };
}

export function useInvoicePrint() {
  return useCallback(() => {
    if (typeof document === "undefined") return;

    const undo = prepareInvoicePrint();
    if (!undo) {
      window.print();
      return;
    }

    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      undo();
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);

    window.print();

    // Safari does not always fire afterprint; this is the belt to that braces.
    window.setTimeout(restore, 1500);
  }, []);
}

type Format = "pdf" | "xlsx" | "csv";

/** Generate and save one invoice file. Returns false when it could not be made. */
export async function downloadInvoice(
  format: Format,
  invoice: Invoice,
  config: BillingConfig,
  gstin = "",
): Promise<boolean> {
  const name = invoice.invoiceNumber;

  if (format === "pdf") {
    const source = document.querySelector<HTMLElement>(".invoice-document");
    if (!source) return false;
    const { downloadInvoicePdf } = await import("@/lib/billing/invoicePdf");
    await downloadInvoicePdf(source, `${name}.pdf`);
    return true;
  }

  const sheet = invoiceSheet(invoice, config, gstin);

  if (format === "xlsx") {
    saveBlob(`${name}.xlsx`, await invoiceWorkbook(sheet));
    return true;
  }

  // A BOM, or Excel on Windows reads the file as the system codepage and ₹
  // turns to mojibake.
  saveBlob(
    `${name}.csv`,
    new Blob([`﻿${invoiceCsv(sheet)}`], { type: "text/csv;charset=utf-8;" }),
  );
  return true;
}

const OPTIONS: { format: Format; label: string; hint: string; icon: typeof FileText }[] = [
  { format: "pdf", label: "PDF", hint: "The invoice, exactly as printed", icon: FileText },
  { format: "xlsx", label: "Excel (.xlsx)", hint: "Every detail, colour-coded", icon: FileSpreadsheet },
  { format: "csv", label: "CSV", hint: "Every detail, plain data", icon: Table },
];

/**
 * The Download button and its menu of formats.
 *
 * `renderTrigger` lets the storefront and the admin portal each use their own
 * button. When the invoice document is not on the page (the invoice list),
 * `pdfHref` is where the PDF option goes instead: the invoice page, which
 * starts the download itself.
 */
export function InvoiceDownloadMenu({
  invoice,
  config,
  gstin = "",
  pdfHref,
  align = "start",
  renderTrigger,
}: {
  invoice: Invoice;
  config: BillingConfig | null;
  gstin?: string;
  pdfHref?: string;
  align?: "start" | "end";
  renderTrigger: (props: {
    onClick: () => void;
    "aria-haspopup": "menu";
    "aria-expanded": boolean;
    "aria-controls": string;
    busy: boolean;
  }) => React.ReactNode;
}) {
  const router = useRouter();
  const menuId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Format | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    // Focus the first option, so the menu is usable from the keyboard at once.
    wrapper.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = async (format: Format) => {
    setOpen(false);
    if (!config) {
      toast.error("The invoice is still loading. Please try again in a moment.");
      return;
    }
    if (format === "pdf" && pdfHref && !document.querySelector(".invoice-document")) {
      router.push(pdfHref);
      return;
    }

    setBusy(format);
    try {
      const done = await downloadInvoice(format, invoice, config, gstin);
      if (done) toast.success(`${invoice.invoiceNumber} downloaded`);
      else toast.error("Open the invoice to download it as a PDF.");
    } catch {
      toast.error("That file could not be created. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  const onMenuKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]"),
    );
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div ref={wrapper} className="relative inline-block">
      {renderTrigger({
        onClick: () => setOpen((value) => !value),
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": menuId,
        busy: busy !== null,
      })}

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label="Download format"
          onKeyDown={onMenuKey}
          // A sheet along the bottom on a phone, where a menu anchored to a
          // button mid-row would run off the screen; a dropdown from 640px.
          className={cn(
            "fixed inset-x-4 bottom-4 z-50 overflow-hidden rounded-card border border-ink-200 bg-white py-1 shadow-lg",
            "sm:absolute sm:inset-x-auto sm:bottom-auto sm:z-40 sm:mt-2 sm:w-64",
            align === "end" ? "sm:right-0" : "sm:left-0",
          )}
        >
          {OPTIONS.map(({ format, label, hint, icon: Icon }) => (
            <button
              key={format}
              type="button"
              role="menuitem"
              onClick={() => void choose(format)}
              className="flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors sm:py-2.5 hover:bg-ink-50 focus:bg-ink-50 focus:outline-none"
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-copper-700" strokeWidth={1.75} aria-hidden="true" />
              <span>
                <span className="block text-sm font-medium text-ink">{label}</span>
                <span className="block text-xs text-ink-500">{hint}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function InvoiceActions({
  invoice,
  config,
  gstin = "",
  className,
}: {
  invoice: Invoice;
  config: BillingConfig;
  gstin?: string;
  className?: string;
}) {
  const print = useInvoicePrint();

  return (
    <div className={className}>
      <Button variant="outline" size="sm" onClick={print}>
        <Printer className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
        Print invoice
      </Button>

      <InvoiceDownloadMenu
        invoice={invoice}
        config={config}
        gstin={gstin}
        renderTrigger={({ busy, ...props }) => (
          <Button size="sm" {...props} disabled={busy}>
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Download className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            )}
            Download
          </Button>
        )}
      />
    </div>
  );
}
