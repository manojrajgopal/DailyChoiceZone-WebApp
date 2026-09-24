"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Download } from "lucide-react";

import type { Invoice } from "@/types";

import { BillingStatusBadge } from "@/components/billing/BillingStatusBadge";
import { downloadInvoiceCsv } from "@/components/billing/InvoiceActions";
import { EmptyState } from "@/components/common/States";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatMoney } from "@/lib/money";
import { formatDate } from "@/lib/utils/format";
import { getMyInvoices } from "@/services/billing/invoiceService";
import { toast } from "@/store/toastStore";

/**
 * A customer's invoices.
 *
 * `GET /invoices` — whose they are is decided by the token, not by a customer
 * id this page could name. It used to walk the orders in this browser's
 * storage and look each invoice up, which is two requests per row and an
 * answer that changed with the device.
 */
export function InvoicesView() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;

    getMyInvoices()
      .then((result) => {
        if (active) setInvoices(result);
      })
      .catch(() => {
        if (active) setInvoices([]);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (invoices.length === 0) {
    return (
      <EmptyState
        title="No invoices yet"
        description="An invoice is raised for every order you place. Once you have ordered, it will appear here to view, print or download."
        action={{ label: "Start shopping", href: "/shop" }}
      />
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {invoices.map((invoice) => (
        <li
          key={invoice.id}
          className="rounded-card border border-ink-200 bg-shell p-4 transition-colors hover:border-ink-300"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <Link
                href={`/account/invoice?id=${invoice.id}`}
                className="font-medium tabular-nums text-ink transition-colors hover:text-copper-700"
              >
                {invoice.invoiceNumber}
              </Link>
              <p className="mt-1 text-xs text-ink-500">
                Order{" "}
                <Link
                  href={`/account/order?number=${invoice.orderNumber}`}
                  className="text-ink-700 underline decoration-ink-200 underline-offset-2 hover:decoration-ink"
                >
                  {invoice.orderNumber}
                </Link>{" "}
                · {formatDate(invoice.issuedAt)}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-3">
              <span className="font-display text-lg tabular-nums text-ink">
                {formatMoney(invoice.breakdown.grandTotal)}
              </span>
              <BillingStatusBadge domain="invoice" status={invoice.status} />
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-ink-100 pt-3 text-xs">
            <Link
              href={`/account/invoice?id=${invoice.id}`}
              className="font-medium text-copper-700 transition-colors hover:text-ink"
            >
              View invoice
            </Link>

            <button
              type="button"
              onClick={() => {
                downloadInvoiceCsv(invoice);
                toast.success(`${invoice.invoiceNumber} downloaded`);
              }}
              className="inline-flex items-center gap-1.5 text-ink-500 transition-colors hover:text-ink"
            >
              <Download className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
              Download
            </button>

            <span className="text-ink-400">
              {invoice.breakdown.itemCount}{" "}
              {invoice.breakdown.itemCount === 1 ? "item" : "items"}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
