"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { Download, Search, X } from "lucide-react";

import type { Refund, RefundStatus } from "@/types";

import { AdminButton, AdminPageHeader, ConfirmDialog } from "@/components/admin/ui/AdminChrome";
import { DataTable, type Column } from "@/components/admin/ui/DataTable";
import { BillingStatusBadge } from "@/components/billing/BillingStatusBadge";
import { useAdminResource } from "@/hooks/useAdminResource";
import { datedFilename, downloadCsv, toCsv } from "@/lib/billing/csv";
import { formatMoney } from "@/lib/money";
import { formatDate } from "@/lib/utils/format";
import { getRefunds, setRefundStatus } from "@/services/billing/refundService";
import { toast } from "@/store/toastStore";

/**
 * Refunds.
 *
 * A refund can be moved along from here — completing one calls the provider and
 * adjusts the payment and invoice, rejecting one leaves the money where it is.
 * Both are confirmed first, because neither can be undone from this screen.
 */

const STATUSES: RefundStatus[] = ["requested", "processing", "completed", "rejected"];

export function AdminRefundsView() {
  const { data, isLoading, reload } = useAdminResource(() => getRefunds(), []);

  const [term, setTerm] = useState("");
  const [status, setStatus] = useState<RefundStatus | "all">("all");
  const [pending, setPending] = useState<{ refund: Refund; next: RefundStatus } | null>(null);
  const [busy, setBusy] = useState(false);

  const refunds = data ?? [];

  const filtered = useMemo(() => {
    const terms = term.trim().toLowerCase().split(/\s+/).filter(Boolean);

    return refunds.filter((refund) => {
      if (status !== "all" && refund.status !== status) return false;

      if (terms.length > 0) {
        const haystack = [
          refund.refundNumber,
          refund.orderNumber,
          refund.invoiceNumber,
          refund.customerName,
          refund.reason,
          refund.id,
        ]
          .join(" ")
          .toLowerCase();
        if (!terms.every((token) => haystack.includes(token))) return false;
      }

      return true;
    });
  }, [refunds, term, status]);

  const completedValue = filtered
    .filter((refund) => refund.status === "completed")
    .reduce((sum, refund) => sum + refund.amount, 0);

  const hasFilters = status !== "all" || term !== "";

  /**
   * Move a refund on.
   *
   * Completing one adjusts the payment, the invoice and the order — records
   * this table never loaded. All of that happens in one transaction on the
   * server, so nothing here has to fetch them, and no stale copy can be
   * written back.
   */
  const applyStatus = useCallback(async () => {
    if (!pending) return;
    const { refund, next } = pending;

    setBusy(true);
    const result = await setRefundStatus(refund, next);
    setBusy(false);
    setPending(null);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success(
      next === "completed"
        ? `${formatMoney(refund.amount)} refunded — ${refund.refundNumber}`
        : `${refund.refundNumber} ${next}`,
    );
    void reload();
  }, [pending, reload]);

  const exportCsv = () => {
    const csv = toCsv(filtered, [
      { header: "Refund number", value: (row) => row.refundNumber },
      { header: "Refund ID", value: (row) => row.id },
      { header: "Order", value: (row) => row.orderNumber },
      { header: "Invoice", value: (row) => row.invoiceNumber },
      { header: "Customer", value: (row) => row.customerName },
      { header: "Amount", value: (row) => formatMoney(row.amount, { showDecimals: true }) },
      { header: "Reason", value: (row) => row.reason },
      { header: "Requested", value: (row) => formatDate(row.requestedAt) },
      { header: "Processed", value: (row) => (row.processedAt ? formatDate(row.processedAt) : "") },
      { header: "Status", value: (row) => row.status },
      { header: "Scope", value: (row) => (row.lines.length > 0 ? "Partial" : "Whole order") },
      { header: "Credit note", value: (row) => row.creditNoteId ?? "" },
      { header: "Initiated by", value: (row) => row.initiatedBy },
    ]);
    downloadCsv(datedFilename("refunds"), csv);
    toast.success(`${filtered.length} refunds exported`);
  };

  const columns: Column<Refund>[] = [
    {
      id: "refundNumber",
      header: "Refund",
      sortValue: (refund) => refund.refundNumber,
      cell: (refund) => (
        <span className="min-w-0">
          <span className="block font-medium tabular-nums text-admin-ink">{refund.refundNumber}</span>
          <span className="block text-[0.625rem] text-admin-faint">
            {refund.lines.length > 0 ? `${refund.lines.length} item` : "Whole order"}
            {refund.lines.length > 1 ? "s" : ""}
          </span>
        </span>
      ),
    },
    {
      id: "order",
      header: "Order",
      hideBelow: "md",
      sortValue: (refund) => refund.orderNumber,
      cell: (refund) => (
        <Link
          href={`/admin/orders/detail?id=${refund.orderId}`}
          className="tabular-nums text-admin-muted hover:text-copper-700"
        >
          {refund.orderNumber}
        </Link>
      ),
    },
    {
      id: "invoice",
      header: "Invoice",
      hideBelow: "xl",
      sortValue: (refund) => refund.invoiceNumber,
      cell: (refund) => (
        <Link
          href={`/admin/billing/invoices/detail?id=${refund.invoiceId}`}
          className="tabular-nums text-admin-muted hover:text-copper-700"
        >
          {refund.invoiceNumber}
        </Link>
      ),
    },
    {
      id: "customer",
      header: "Customer",
      sortValue: (refund) => refund.customerName,
      cell: (refund) => (
        <span className="block max-w-[10rem] truncate text-admin-ink">{refund.customerName}</span>
      ),
    },
    {
      id: "reason",
      header: "Reason",
      hideBelow: "lg",
      sortValue: (refund) => refund.reason,
      cell: (refund) => (
        <span className="block max-w-[13rem] truncate text-xs text-admin-muted">
          {refund.reason}
        </span>
      ),
    },
    {
      id: "amount",
      header: "Amount",
      align: "right",
      sortValue: (refund) => refund.amount,
      cell: (refund) => (
        <span className="whitespace-nowrap font-medium tabular-nums">
          {formatMoney(refund.amount)}
        </span>
      ),
    },
    {
      id: "date",
      header: "Requested",
      hideBelow: "lg",
      sortValue: (refund) => refund.requestedAt,
      cell: (refund) => (
        <span className="whitespace-nowrap text-xs text-admin-muted">
          {formatDate(refund.requestedAt)}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      sortValue: (refund) => refund.status,
      cell: (refund) => <BillingStatusBadge domain="refund" status={refund.status} />,
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (refund) =>
        refund.status === "completed" || refund.status === "rejected" ? (
          <span className="text-[0.6875rem] text-admin-faint">Settled</span>
        ) : (
          <span className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setPending({ refund, next: "completed" })}
              className="text-[0.6875rem] font-medium text-copper-700 hover:text-admin-ink"
            >
              Complete
            </button>
            <button
              type="button"
              onClick={() => setPending({ refund, next: "rejected" })}
              className="text-[0.6875rem] text-admin-muted hover:text-status-critical"
            >
              Reject
            </button>
          </span>
        ),
    },
  ];

  return (
    <div>
      <AdminPageHeader
        title="Refunds"
        description={`${refunds.length} refunds raised.`}
        breadcrumbs={[
          { label: "Admin", href: "/admin/dashboard" },
          { label: "Billing", href: "/admin/billing" },
          { label: "Refunds" },
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
            <label htmlFor="refund-search" className="sr-only">
              Search refunds by number, order, invoice or customer
            </label>
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-admin-faint"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <input
              id="refund-search"
              type="search"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Refund, order, invoice, customer…"
              className="h-8 w-full rounded-[3px] border border-admin-border bg-admin-raised pl-8 pr-2 text-xs text-admin-ink placeholder:text-admin-faint focus:border-copper-500 focus:bg-admin-surface"
            />
          </div>

          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as RefundStatus | "all")}
            aria-label="Filter by refund status"
            className="h-8 rounded-[3px] border border-admin-border bg-admin-surface px-2 text-xs text-admin-ink hover:border-admin-border-strong focus:border-copper-500"
          >
            <option value="all">All statuses</option>
            {STATUSES.map((option) => (
              <option key={option} value={option}>
                {option.charAt(0).toUpperCase() + option.slice(1)}
              </option>
            ))}
          </select>

          {hasFilters ? (
            <AdminButton
              size="sm"
              variant="ghost"
              onClick={() => {
                setStatus("all");
                setTerm("");
              }}
            >
              <X className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
              Clear
            </AdminButton>
          ) : null}
        </div>

        <p className="mt-2.5 text-[0.6875rem] text-admin-muted tabular-nums">
          {isLoading
            ? "Loading…"
            : `${filtered.length} of ${refunds.length} refunds · ${formatMoney(completedValue)} returned`}
        </p>
      </div>

      <DataTable
        rows={filtered}
        columns={columns}
        getRowId={(refund) => refund.id}
        isLoading={isLoading}
        pageSize={15}
        initialSort={{ columnId: "date", direction: "desc" }}
        emptyTitle="No refunds match"
        emptyDescription="Adjust the search or filter above."
      />

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={pending?.next === "completed" ? "Complete this refund?" : "Reject this refund?"}
        confirmLabel={pending?.next === "completed" ? "Complete refund" : "Reject refund"}
        destructive={pending?.next === "rejected"}
        loading={busy}
        onConfirm={() => void applyStatus()}
        message={
          pending ? (
            pending.next === "completed" ? (
              <>
                {formatMoney(pending.refund.amount)} will be returned against{" "}
                {pending.refund.invoiceNumber} and the payment marked refunded. This cannot be
                undone here.
              </>
            ) : (
              <>
                {pending.refund.refundNumber} will be closed without returning any money. This
                cannot be undone here.
              </>
            )
          ) : null
        }
      />
    </div>
  );
}
