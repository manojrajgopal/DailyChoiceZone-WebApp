"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Download, Search, X } from "lucide-react";

import type { BillingPaymentStatus, Payment, PaymentMethodKey } from "@/types";

import { AdminButton, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { DataTable, type Column } from "@/components/admin/ui/DataTable";
import { BillingStatusBadge } from "@/components/billing/BillingStatusBadge";
import { useAdminResource } from "@/hooks/useAdminResource";
import { datedFilename, downloadCsv, toCsv } from "@/lib/billing/csv";
import { formatMoney } from "@/lib/money";
import { formatDate } from "@/lib/utils/format";
import { PAYMENT_METHOD_LABELS, getPayments, paymentMethodLabel } from "@/services/billing/paymentService";
import { toast } from "@/store/toastStore";

/** Every transaction, and what happened to it. */

const STATUSES: BillingPaymentStatus[] = [
  "pending", "authorized", "paid", "failed", "refunded", "partially-refunded",
];

const METHODS = Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethodKey[];

type DateWindow = "all" | "7d" | "30d" | "3m";

export function AdminPaymentsView() {
  const { data, isLoading } = useAdminResource(() => getPayments(), []);

  const [term, setTerm] = useState("");
  const [status, setStatus] = useState<BillingPaymentStatus | "all">("all");
  const [method, setMethod] = useState<PaymentMethodKey | "all">("all");
  const [dateWindow, setDateWindow] = useState<DateWindow>("all");

  const payments = data ?? [];
  const [now] = useState(() => Date.now());

  const filtered = useMemo(() => {
    const terms = term.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const days = dateWindow === "7d" ? 7 : dateWindow === "30d" ? 30 : dateWindow === "3m" ? 90 : null;
    const cutoff = days ? now - days * 86400000 : null;

    return payments.filter((payment) => {
      if (status !== "all" && payment.status !== status) return false;
      if (method !== "all" && payment.method !== method) return false;
      if (cutoff && new Date(payment.createdAt).getTime() < cutoff) return false;

      if (terms.length > 0) {
        const haystack = [
          payment.transactionId,
          payment.orderNumber,
          payment.invoiceNumber,
          payment.customerName,
          payment.customerEmail,
          payment.id,
        ]
          .join(" ")
          .toLowerCase();
        if (!terms.every((token) => haystack.includes(token))) return false;
      }

      return true;
    });
  }, [payments, term, status, method, dateWindow, now]);

  // Failed payments were never collected, so they do not count as taken.
  const collected = filtered
    .filter((payment) => payment.status !== "failed" && payment.status !== "pending")
    .reduce((sum, payment) => sum + payment.amount - payment.refundedAmount, 0);

  const hasFilters = status !== "all" || method !== "all" || dateWindow !== "all" || term !== "";

  const clear = () => {
    setStatus("all");
    setMethod("all");
    setDateWindow("all");
    setTerm("");
  };

  const exportCsv = () => {
    const csv = toCsv(filtered, [
      { header: "Transaction ID", value: (row) => row.transactionId },
      { header: "Payment ID", value: (row) => row.id },
      { header: "Order", value: (row) => row.orderNumber },
      { header: "Invoice", value: (row) => row.invoiceNumber },
      { header: "Customer", value: (row) => row.customerName },
      { header: "Date", value: (row) => formatDate(row.createdAt) },
      { header: "Amount", value: (row) => formatMoney(row.amount, { showDecimals: true }) },
      { header: "Refunded", value: (row) => formatMoney(row.refundedAmount, { showDecimals: true }) },
      { header: "Method", value: (row) => paymentMethodLabel(row.method) },
      { header: "Status", value: (row) => row.status },
      { header: "Provider", value: (row) => row.provider },
    ]);
    downloadCsv(datedFilename("payments"), csv);
    toast.success(`${filtered.length} payments exported`);
  };

  const columns: Column<Payment>[] = [
    {
      id: "transactionId",
      header: "Transaction",
      sortValue: (payment) => payment.transactionId,
      cell: (payment) => (
        <Link
          href={`/admin/billing/payments/detail?id=${payment.id}`}
          className="font-medium tabular-nums text-admin-ink hover:text-copper-700"
        >
          {payment.transactionId}
        </Link>
      ),
    },
    {
      id: "order",
      header: "Order",
      hideBelow: "md",
      sortValue: (payment) => payment.orderNumber,
      cell: (payment) => (
        <Link
          href={`/admin/orders/detail?id=${payment.orderId}`}
          className="tabular-nums text-admin-muted hover:text-copper-700"
        >
          {payment.orderNumber}
        </Link>
      ),
    },
    {
      id: "invoice",
      header: "Invoice",
      hideBelow: "xl",
      sortValue: (payment) => payment.invoiceNumber,
      cell: (payment) => (
        <Link
          href={`/admin/billing/invoices/detail?id=${payment.invoiceId}`}
          className="tabular-nums text-admin-muted hover:text-copper-700"
        >
          {payment.invoiceNumber}
        </Link>
      ),
    },
    {
      id: "customer",
      header: "Customer",
      sortValue: (payment) => payment.customerName,
      cell: (payment) => (
        <span className="block max-w-[10rem] truncate text-admin-ink">{payment.customerName}</span>
      ),
    },
    {
      id: "date",
      header: "Date",
      hideBelow: "lg",
      sortValue: (payment) => payment.createdAt,
      cell: (payment) => (
        <span className="whitespace-nowrap text-xs text-admin-muted">
          {formatDate(payment.createdAt)}
        </span>
      ),
    },
    {
      id: "amount",
      header: "Amount",
      align: "right",
      sortValue: (payment) => payment.amount,
      cell: (payment) => (
        <span className="whitespace-nowrap">
          <span className="block font-medium tabular-nums">{formatMoney(payment.amount)}</span>
          {payment.refundedAmount > 0 ? (
            <span className="block text-[0.625rem] tabular-nums text-admin-faint">
              − {formatMoney(payment.refundedAmount)}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "method",
      header: "Method",
      hideBelow: "sm",
      sortValue: (payment) => payment.method,
      cell: (payment) => (
        <span className="flex flex-col gap-0.5">
          <span className="text-xs text-admin-ink">{paymentMethodLabel(payment.method)}</span>
          {/* A masked remnant only — never a full instrument. */}
          <span className="text-[0.5625rem] text-admin-faint">{payment.instrumentHint}</span>
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      sortValue: (payment) => payment.status,
      cell: (payment) => <BillingStatusBadge domain="payment" status={payment.status} />,
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (payment) => (
        <Link
          href={`/admin/billing/payments/detail?id=${payment.id}`}
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
        title="Payments"
        description={`${payments.length} transactions recorded.`}
        breadcrumbs={[
          { label: "Admin", href: "/admin/dashboard" },
          { label: "Billing", href: "/admin/billing" },
          { label: "Payments" },
        ]}
        actions={
          <AdminButton size="sm" variant="secondary" onClick={exportCsv}>
            <Download className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
            Export CSV
          </AdminButton>
        }
      />

      <div className="mb-4 rounded-[3px] border border-admin-border bg-admin-surface p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-xs">
            <label htmlFor="payment-search" className="sr-only">
              Search payments by transaction, order, invoice or customer
            </label>
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-admin-faint"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <input
              id="payment-search"
              type="search"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="TXN…, order, invoice, customer"
              className="h-8 w-full rounded-[3px] border border-admin-border bg-admin-raised pl-8 pr-2 text-xs text-admin-ink placeholder:text-admin-faint focus:border-copper-500 focus:bg-admin-surface"
            />
          </div>

          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as BillingPaymentStatus | "all")}
            aria-label="Filter by payment status"
            className={selectClass}
          >
            <option value="all">All statuses</option>
            {STATUSES.map((option) => (
              <option key={option} value={option}>
                {option.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase())}
              </option>
            ))}
          </select>

          <select
            value={method}
            onChange={(event) => setMethod(event.target.value as PaymentMethodKey | "all")}
            aria-label="Filter by payment method"
            className={selectClass}
          >
            <option value="all">Any method</option>
            {METHODS.map((option) => (
              <option key={option} value={option}>
                {PAYMENT_METHOD_LABELS[option]}
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
            : `${filtered.length} of ${payments.length} payments · ${formatMoney(collected)} net of refunds`}
        </p>
      </div>

      <DataTable
        rows={filtered}
        columns={columns}
        getRowId={(payment) => payment.id}
        isLoading={isLoading}
        pageSize={15}
        initialSort={{ columnId: "date", direction: "desc" }}
        emptyTitle="No payments match"
        emptyDescription="Adjust the search or filters above."
      />
    </div>
  );
}
