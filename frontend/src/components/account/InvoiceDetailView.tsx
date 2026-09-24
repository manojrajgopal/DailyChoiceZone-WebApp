"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import type { Invoice } from "@/types";

import { AccountShell } from "@/components/account/AccountShell";
import { InvoiceActions } from "@/components/billing/InvoiceActions";
import { InvoiceDocument } from "@/components/billing/InvoiceDocument";
import { EmptyState } from "@/components/common/States";
import { Skeleton } from "@/components/ui/Skeleton";
import { useBillingConfig, useTaxConfig } from "@/hooks/useBillingConfig";
import { getMyInvoice } from "@/services/billing/invoiceService";

/**
 * One invoice, as a document.
 *
 * Reached by query parameter rather than a path segment: an invoice raised
 * five minutes ago has no prerendered page, and the document is read on the
 * client anyway. The portal's detail pages use the same convention.
 */
function InvoiceDetail() {
  const searchParams = useSearchParams();
  const id = searchParams?.get("id") ?? "";

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const config = useBillingConfig();
  const taxConfig = useTaxConfig();

  useEffect(() => {
    if (!id) {
      setIsLoading(false);
      return;
    }

    let active = true;
    getMyInvoice(id)
      .then((result) => {
        if (active) setInvoice(result);
      })
      .catch(() => {
        if (active) setInvoice(null);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [id]);

  if (isLoading || !config) {
    return (
      <AccountShell title="Invoice" breadcrumb={[{ label: "Invoices", href: "/account/invoices" }]}>
        <Skeleton className="h-[40rem] w-full" />
      </AccountShell>
    );
  }

  if (!invoice) {
    return (
      <AccountShell title="Invoice" breadcrumb={[{ label: "Invoices", href: "/account/invoices" }]}>
        <EmptyState
          title="We could not find that invoice"
          description="The link may be out of date, or the invoice belongs to an order placed in a different browser. Sample orders are stored on the device that placed them."
          action={{ label: "Your invoices", href: "/account/invoices" }}
        />
      </AccountShell>
    );
  }

  return (
    <AccountShell
      title={invoice.invoiceNumber}
      description={`Order ${invoice.orderNumber}`}
      breadcrumb={[
        { label: "Invoices", href: "/account/invoices" },
        { label: invoice.invoiceNumber },
      ]}
    >
      <InvoiceActions
        invoice={invoice}
        config={config}
        className="print-hidden mb-5 flex flex-wrap gap-2.5"
      />

      <div className="overflow-hidden rounded-card border border-ink-200 print:rounded-none print:border-0">
        <InvoiceDocument invoice={invoice} config={config} gstin={taxConfig?.gstin ?? ""} />
      </div>
    </AccountShell>
  );
}

export function InvoiceDetailView() {
  return (
    <Suspense
      fallback={
        <div className="page-shell py-10">
          <Skeleton className="h-[40rem] w-full" />
        </div>
      }
    >
      <InvoiceDetail />
    </Suspense>
  );
}
