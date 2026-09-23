"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Download, Search, X } from "lucide-react";

import type { CreditNote, CreditNoteStatus } from "@/types";

import { AdminButton, AdminPageHeader, ConfirmDialog } from "@/components/admin/ui/AdminChrome";
import { DataTable, type Column } from "@/components/admin/ui/DataTable";
import { BillingStatusBadge } from "@/components/billing/BillingStatusBadge";
import { useAdminResource } from "@/hooks/useAdminResource";
import { datedFilename, downloadCsv, toCsv } from "@/lib/billing/csv";
import { formatMoney } from "@/lib/money";
import { formatDate } from "@/lib/utils/format";
import { getCreditNotes, setCreditNoteStatus } from "@/services/billing/creditNoteService";
import { toast } from "@/store/toastStore";

/**
 * Credit notes.
 *
 * A draft can be issued and an issued one cancelled; neither is deleted,
 * because a numbered document that vanishes leaves a hole in a sequence
 * somebody will eventually have to explain.
 */

const STATUSES: CreditNoteStatus[] = ["draft", "issued", "cancelled"];

export function AdminCreditNotesView() {
  const { data, isLoading, reload } = useAdminResource(() => getCreditNotes(), []);

  const [term, setTerm] = useState("");
  const [status, setStatus] = useState<CreditNoteStatus | "all">("all");
  const [pending, setPending] = useState<{ note: CreditNote; next: CreditNoteStatus } | null>(null);
  const [busy, setBusy] = useState(false);

  const notes = data ?? [];

  const filtered = useMemo(() => {
    const terms = term.trim().toLowerCase().split(/\s+/).filter(Boolean);

    return notes.filter((note) => {
      if (status !== "all" && note.status !== status) return false;

      if (terms.length > 0) {
        const haystack = [
          note.creditNoteNumber,
          note.invoiceNumber,
          note.orderNumber,
          note.customerName,
          note.reason,
        ]
          .join(" ")
          .toLowerCase();
        if (!terms.every((token) => haystack.includes(token))) return false;
      }

      return true;
    });
  }, [notes, term, status]);

  const issuedValue = filtered
    .filter((note) => note.status === "issued")
    .reduce((sum, note) => sum + note.total, 0);

  const applyStatus = async () => {
    if (!pending) return;
    setBusy(true);
    await setCreditNoteStatus(pending.note, pending.next);
    setBusy(false);
    toast.success(`${pending.note.creditNoteNumber} ${pending.next}`);
    setPending(null);
    void reload();
  };

  const exportCsv = () => {
    const csv = toCsv(filtered, [
      { header: "Credit note", value: (row) => row.creditNoteNumber },
      { header: "Invoice", value: (row) => row.invoiceNumber },
      { header: "Order", value: (row) => row.orderNumber },
      { header: "Customer", value: (row) => row.customerName },
      { header: "Reason", value: (row) => row.reason },
      { header: "Taxable value", value: (row) => formatMoney(row.amount, { showDecimals: true }) },
      { header: "Tax", value: (row) => formatMoney(row.tax, { showDecimals: true }) },
      { header: "Total", value: (row) => formatMoney(row.total, { showDecimals: true }) },
      { header: "Issued", value: (row) => formatDate(row.issuedAt) },
      { header: "Status", value: (row) => row.status },
    ]);
    downloadCsv(datedFilename("credit-notes"), csv);
    toast.success(`${filtered.length} credit notes exported`);
  };

  const columns: Column<CreditNote>[] = [
    {
      id: "number",
      header: "Credit note",
      sortValue: (note) => note.creditNoteNumber,
      cell: (note) => (
        <span className="font-medium tabular-nums text-admin-ink">{note.creditNoteNumber}</span>
      ),
    },
    {
      id: "invoice",
      header: "Invoice",
      sortValue: (note) => note.invoiceNumber,
      cell: (note) => (
        <Link
          href={`/admin/billing/invoices/detail?id=${note.invoiceId}`}
          className="tabular-nums text-admin-muted hover:text-copper-700"
        >
          {note.invoiceNumber}
        </Link>
      ),
    },
    {
      id: "order",
      header: "Order",
      hideBelow: "xl",
      sortValue: (note) => note.orderNumber,
      cell: (note) => (
        <Link
          href={`/admin/orders/detail?id=${note.orderId}`}
          className="tabular-nums text-admin-muted hover:text-copper-700"
        >
          {note.orderNumber}
        </Link>
      ),
    },
    {
      id: "customer",
      header: "Customer",
      sortValue: (note) => note.customerName,
      cell: (note) => (
        <span className="block max-w-[10rem] truncate text-admin-ink">{note.customerName}</span>
      ),
    },
    {
      id: "reason",
      header: "Reason",
      hideBelow: "lg",
      sortValue: (note) => note.reason,
      cell: (note) => (
        <span className="block max-w-[14rem] truncate text-xs text-admin-muted">{note.reason}</span>
      ),
    },
    {
      id: "tax",
      header: "Tax",
      align: "right",
      hideBelow: "md",
      sortValue: (note) => note.tax,
      cell: (note) => (
        <span className="whitespace-nowrap tabular-nums text-admin-muted">
          {formatMoney(note.tax)}
        </span>
      ),
    },
    {
      id: "total",
      header: "Total",
      align: "right",
      sortValue: (note) => note.total,
      cell: (note) => (
        <span className="whitespace-nowrap font-medium tabular-nums">{formatMoney(note.total)}</span>
      ),
    },
    {
      id: "date",
      header: "Issued",
      hideBelow: "lg",
      sortValue: (note) => note.issuedAt,
      cell: (note) => (
        <span className="whitespace-nowrap text-xs text-admin-muted">
          {formatDate(note.issuedAt)}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      sortValue: (note) => note.status,
      cell: (note) => <BillingStatusBadge domain="credit-note" status={note.status} />,
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (note) =>
        note.status === "draft" ? (
          <button
            type="button"
            onClick={() => setPending({ note, next: "issued" })}
            className="text-[0.6875rem] font-medium text-copper-700 hover:text-admin-ink"
          >
            Issue
          </button>
        ) : note.status === "issued" ? (
          <button
            type="button"
            onClick={() => setPending({ note, next: "cancelled" })}
            className="text-[0.6875rem] text-admin-muted hover:text-status-critical"
          >
            Cancel
          </button>
        ) : (
          <span className="text-[0.6875rem] text-admin-faint">Cancelled</span>
        ),
    },
  ];

  return (
    <div>
      <AdminPageHeader
        title="Credit notes"
        description={`${notes.length} credit notes on record.`}
        breadcrumbs={[
          { label: "Admin", href: "/admin/dashboard" },
          { label: "Billing", href: "/admin/billing" },
          { label: "Credit notes" },
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
            <label htmlFor="credit-note-search" className="sr-only">
              Search credit notes by number, invoice, order or customer
            </label>
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-admin-faint"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <input
              id="credit-note-search"
              type="search"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Credit note, invoice, customer…"
              className="h-8 w-full rounded-[3px] border border-admin-border bg-admin-raised pl-8 pr-2 text-xs text-admin-ink placeholder:text-admin-faint focus:border-copper-500 focus:bg-admin-surface"
            />
          </div>

          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as CreditNoteStatus | "all")}
            aria-label="Filter by credit note status"
            className="h-8 rounded-[3px] border border-admin-border bg-admin-surface px-2 text-xs text-admin-ink hover:border-admin-border-strong focus:border-copper-500"
          >
            <option value="all">All statuses</option>
            {STATUSES.map((option) => (
              <option key={option} value={option}>
                {option.charAt(0).toUpperCase() + option.slice(1)}
              </option>
            ))}
          </select>

          {status !== "all" || term !== "" ? (
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
            : `${filtered.length} of ${notes.length} credit notes · ${formatMoney(issuedValue)} issued`}
        </p>
      </div>

      <DataTable
        rows={filtered}
        columns={columns}
        getRowId={(note) => note.id}
        isLoading={isLoading}
        pageSize={15}
        initialSort={{ columnId: "date", direction: "desc" }}
        emptyTitle="No credit notes match"
        emptyDescription="Adjust the search or filter above."
      />

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={pending?.next === "issued" ? "Issue this credit note?" : "Cancel this credit note?"}
        confirmLabel={pending?.next === "issued" ? "Issue" : "Cancel credit note"}
        destructive={pending?.next === "cancelled"}
        loading={busy}
        onConfirm={() => void applyStatus()}
        message={
          pending ? (
            pending.next === "issued" ? (
              <>
                {pending.note.creditNoteNumber} becomes a live document for{" "}
                {formatMoney(pending.note.total)} against {pending.note.invoiceNumber}.
              </>
            ) : (
              <>
                {pending.note.creditNoteNumber} will be marked cancelled. It keeps its number — a
                gap in the sequence is harder to explain than a cancelled document.
              </>
            )
          ) : null
        }
      />
    </div>
  );
}
