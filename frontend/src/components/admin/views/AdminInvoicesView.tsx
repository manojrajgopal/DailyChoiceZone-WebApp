"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Download, Printer, Search, X } from "lucide-react";

import type { Invoice, InvoiceStatus, BillingPaymentStatus } from "@/types";

import { AdminButton, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { DataTable, type Column } from "@/components/admin/ui/DataTable";
import { BillingStatusBadge } from "@/components/billing/BillingStatusBadge";
import { useAdminResource } from "@/hooks/useAdminResource";
import { datedFilename, downloadCsv, toCsv } from "@/lib/billing/csv";
import { formatMoney } from "@/lib/money";
import { formatDate } from "@/lib/utils/format";
import { getInvoices, isOverdue } from "@/services/billing/invoiceService";
import { paymentMethodLabel } from "@/services/billing/paymentService";
import { toast } from "@/store/toastStore";

/**
 * Invoice management.
 *
 * Filtering happens here and the result is handed to the shared `DataTable`,
 * which owns sorting, paging and selection — the same split every other list in
 * the portal uses. Filter controls differ on every page; table mechanics do not.
 */

const INVOICE_STATUSES: InvoiceStatus[] = ["draft", "issued", "paid", "overdue", "cancelled"];
const PAYMENT_STATUSES: BillingPaymentStatus[] = [
  "pending", "authorized", "paid", "failed", "refunded", "partially-refunded",
];

type DateWindow = "all" | "7d" | "30d" | "3m";

export function AdminInvoicesView() {
  const { data, isLoading } = useAdminResource(() => getInvoices(), []);

  const [term, setTerm] = useState("");
  const [status, setStatus] = useState<InvoiceStatus | "all">("all");
  const [payment, setPayment] = useState<BillingPaymentStatus | "all">("all");
  const [dateWindow, setDateWindow] = useState<DateWindow>("all");
  const [minAmount, setMinAmount] = useState("");

  const invoices = data ?? [];

  /** "Now", captured once per mount — see `AdminOrdersView`. */
  const [now] = useState(() => Date.now());

  const filtered = useMemo(() => {
    const terms = term.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const floor = Number(minAmount);
    const days = dateWindow === "7d" ? 7 : dateWindow === "30d" ? 30 : dateWindow === "3m" ? 90 : null;
    const cutoff = days ? now - days * 86400000 : null;

    return invoices.filter((invoice) => {
      // "Overdue" is derived, not stored — an invoice becomes overdue while
      // nobody is looking, and no job runs overnight to relabel it.
      const effectiveStatus = isOverdue(invoice, new Date(now)) ? "overdue" : invoice.status;

      if (status !== "all" && effectiveStatus !== status) return false;
      if (payment !== "all" && invoice.paymentStatus !== payment) return false;
      if (cutoff && new Date(invoice.issuedAt).getTime() < cutoff) return false;
      // The filter is typed in rupees; amounts are stored in paise.
      if (Number.isFinite(floor) && minAmount !== "" && invoice.breakdown.grandTotal < floor * 100) {
        return false;
      }

      if (terms.length > 0) {
        const haystack = [
          invoice.invoiceNumber,
          invoice.orderNumber,
          invoice.customerName,
          invoice.customerEmail,
        ]
          .join(" ")
          .toLowerCase();
        if (!terms.every((token) => haystack.includes(token))) return false;
      }

      return true;
    });
  }, [invoices, term, status, payment, dateWindow, minAmount, now]);

  const billed = filtered.reduce((sum, invoice) => sum + invoice.breakdown.grandTotal, 0);
  const collected = filtered.reduce((sum, invoice) => sum + invoice.amountPaid, 0);

  const hasFilters =
    status !== "all" || payment !== "all" || dateWindow !== "all" || minAmount !== "" || term !== "";

  const clear = () => {
    setStatus("all");
    setPayment("all");
    setDateWindow("all");
    setMinAmount("");
    setTerm("");
  };

  const exportCsv = () => {
    const csv = toCsv(filtered, [
      { header: "Invoice number", value: (row) => row.invoiceNumber },
      { header: "Order number", value: (row) => row.orderNumber },
      { header: "Customer", value: (row) => row.customerName },
      { header: "Email", value: (row) => row.customerEmail },
      { header: "Invoice date", value: (row) => formatDate(row.issuedAt) },
      { header: "Due date", value: (row) => formatDate(row.dueAt) },
      { header: "Place of supply", value: (row) => row.placeOfSupply },
      { header: "Taxable value", value: (row) => formatMoney(row.breakdown.taxableAmount, { showDecimals: true }) },
      { header: "CGST", value: (row) => formatMoney(row.breakdown.tax.cgst, { showDecimals: true }) },
      { header: "SGST", value: (row) => formatMoney(row.breakdown.tax.sgst, { showDecimals: true }) },
      { header: "IGST", value: (row) => formatMoney(row.breakdown.tax.igst, { showDecimals: true }) },
      { header: "Total tax", value: (row) => formatMoney(row.breakdown.tax.totalTax, { showDecimals: true }) },
      { header: "Shipping", value: (row) => formatMoney(row.breakdown.shipping, { showDecimals: true }) },
      { header: "Grand total", value: (row) => formatMoney(row.breakdown.grandTotal, { showDecimals: true }) },
      { header: "Amount paid", value: (row) => formatMoney(row.amountPaid, { showDecimals: true }) },
      { header: "Amount refunded", value: (row) => formatMoney(row.amountRefunded, { showDecimals: true }) },
      { header: "Invoice status", value: (row) => row.status },
      { header: "Payment status", value: (row) => row.paymentStatus },
      { header: "Payment method", value: (row) => paymentMethodLabel(row.paymentMethod) },
    ]);

    downloadCsv(datedFilename("invoices"), csv);
    toast.success(`${filtered.length} invoices exported`);
  };

  const columns: Column<Invoice>[] = [
    {
      id: "invoiceNumber",
      header: "Invoice",
      sortValue: (invoice) => invoice.invoiceNumber,
      cell: (invoice) => (
        <Link
          href={`/admin/billing/invoices/detail?id=${invoice.id}`}
          className="font-medium tabular-nums text-admin-ink hover:text-copper-700"
        >
          {invoice.invoiceNumber}
        </Link>
      ),
    },
    {
      id: "order",
      header: "Order",
      hideBelow: "md",
      sortValue: (invoice) => invoice.orderNumber,
      cell: (invoice) => (
        <Link
          href={`/admin/orders/detail?id=${invoice.orderId}`}
          className="tabular-nums text-admin-muted hover:text-copper-700"
        >
          {invoice.orderNumber}
        </Link>
      ),
    },
    {
      id: "customer",
      header: "Customer",
      sortValue: (invoice) => invoice.customerName,
      cell: (invoice) => (
        <span className="min-w-0">
          <Link
            href={`/admin/customers/detail?id=${invoice.customerId}`}
            className="block max-w-[11rem] truncate text-admin-ink hover:text-copper-700"
          >
            {invoice.customerName}
          </Link>
          <span className="block max-w-[11rem] truncate text-[0.625rem] text-admin-faint">
            {invoice.customerEmail}
          </span>
        </span>
      ),
    },
    {
      id: "date",
      header: "Date",
      hideBelow: "lg",
      sortValue: (invoice) => invoice.issuedAt,
      cell: (invoice) => (
        <span className="whitespace-nowrap text-xs text-admin-muted">
          {formatDate(invoice.issuedAt)}
        </span>
      ),
    },
    {
      id: "amount",
      header: "Amount",
      align: "right",
      sortValue: (invoice) => invoice.breakdown.grandTotal,
      cell: (invoice) => (
        <span className="whitespace-nowrap font-medium tabular-nums">
          {formatMoney(invoice.breakdown.grandTotal)}
        </span>
      ),
    },
    {
      id: "tax",
      header: "Tax",
      align: "right",
      hideBelow: "xl",
      sortValue: (invoice) => invoice.breakdown.tax.totalTax,
      cell: (invoice) => (
        <span className="whitespace-nowrap tabular-nums text-admin-muted">
          {formatMoney(invoice.breakdown.tax.totalTax)}
        </span>
      ),
    },
    {
      id: "paymentStatus",
      header: "Payment",
      hideBelow: "sm",
      sortValue: (invoice) => invoice.paymentStatus,
      cell: (invoice) => <BillingStatusBadge domain="payment" status={invoice.paymentStatus} />,
    },
    {
      id: "status",
      header: "Invoice",
      sortValue: (invoice) => invoice.status,
      cell: (invoice) => (
        <BillingStatusBadge
          domain="invoice"
          status={isOverdue(invoice, new Date(now)) ? "overdue" : invoice.status}
        />
      ),
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (invoice) => (
        <Link
          href={`/admin/billing/invoices/detail?id=${invoice.id}`}
          className="text-[0.6875rem] font-medium text-copper-700 hover:text-admin-ink"
        >
          View
        </Link>
      ),
    },
  ];

  const selectClass =
    "h-8 rounded-[3px] border border-admin-border bg-admin-surface px-2 text-xs text-admin-ink hover:border-admin-border-strong focus:border-copper-500";

  return (
    <div>
      <AdminPageHeader
        title="Invoices"
        description={`${invoices.length} invoices raised.`}
        breadcrumbs={[
          { label: "Admin", href: "/admin/dashboard" },
          { label: "Billing", href: "/admin/billing" },
          { label: "Invoices" },
        ]}
        actions={
          <div className="flex gap-2">
            <AdminButton size="sm" variant="secondary" onClick={exportCsv}>
              <Download className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
              Export CSV
            </AdminButton>
            <AdminButton size="sm" variant="ghost" onClick={() => window.print()}>
              <Printer className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
              Print
            </AdminButton>
          </div>
        }
      />

      <div className="mb-4 rounded-[3px] border border-admin-border bg-admin-surface p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-xs">
            <label htmlFor="invoice-search" className="sr-only">
              Search invoices by number, order or customer
            </label>
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-admin-faint"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <input
              id="invoice-search"
              type="search"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Invoice, order, customer…"
              className="h-8 w-full rounded-[3px] border border-admin-border bg-admin-raised pl-8 pr-2 text-xs text-admin-ink placeholder:text-admin-faint focus:border-copper-500 focus:bg-admin-surface"
            />
          </div>

          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as InvoiceStatus | "all")}
            aria-label="Filter by invoice status"
            className={selectClass}
          >
            <option value="all">All invoice statuses</option>
            {INVOICE_STATUSES.map((option) => (
              <option key={option} value={option}>
                {option.charAt(0).toUpperCase() + option.slice(1)}
              </option>
            ))}
          </select>

          <select
            value={payment}
            onChange={(event) => setPayment(event.target.value as BillingPaymentStatus | "all")}
            aria-label="Filter by payment status"
            className={selectClass}
          >
            <option value="all">Any payment status</option>
            {PAYMENT_STATUSES.map((option) => (
              <option key={option} value={option}>
                {option.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase())}
              </option>
            ))}
          </select>

          <select
            value={dateWindow}
            onChange={(event) => setDateWindow(event.target.value as DateWindow)}
            aria-label="Filter by date"
            className={selectClass}
          >
            <option value="all">Any date</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="3m">Last 3 months</option>
          </select>

          <label className="flex items-center gap-1.5">
            <span className="text-xs text-admin-muted">Min ₹</span>
            <input
              type="number"
              min={0}
              value={minAmount}
              onChange={(event) => setMinAmount(event.target.value)}
              placeholder="0"
              className="h-8 w-20 rounded-[3px] border border-admin-border bg-admin-surface px-2 text-xs text-admin-ink focus:border-copper-500"
            />
          </label>

          {hasFilters ? (
            <AdminButton size="sm" variant="ghost" onClick={clear}>
              <X className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
              Clear
            </AdminButton>
          ) : null}
        </div>

        <p className="mt-2.5 text-[0.6875rem] text-admin-muted tabular-nums">
          {isLoading
            ? "Loading…"
            : `${filtered.length} of ${invoices.length} invoices · ${formatMoney(billed)} billed · ${formatMoney(collected)} collected`}
        </p>
      </div>

      <DataTable
        rows={filtered}
        columns={columns}
        getRowId={(invoice) => invoice.id}
        isLoading={isLoading}
        pageSize={15}
        initialSort={{ columnId: "date", direction: "desc" }}
        emptyTitle="No invoices match"
        emptyDescription="Adjust the search or filters above."
      />
    </div>
  );
}
