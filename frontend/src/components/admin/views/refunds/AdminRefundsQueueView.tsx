"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, Download, RefreshCw, X } from "lucide-react";

import { AdminButton, AdminButtonLink, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { FilterSelect, LogFooter, LogSearch, StatusTabs, useUrlFilters } from "@/components/admin/ui/LogPage";
import { TD, TH, TableState, Tile, problem } from "@/components/admin/views/operations/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { datedFilename, downloadCsv, toCsv } from "@/lib/billing/csv";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";
import { getRefundSummary, listRefunds, type RefundListFilters } from "@/services/admin/refundsAdminService";
import { toast } from "@/store/toastStore";
import type { RefundRecord } from "@/types/refunds";
import { REFUND_METHOD_LABELS } from "@/types/refunds";

import { RefundActions, RefundStatusBadge } from "./RefundActions";

const KEYS = ["status", "q", "method", "reasonCode", "awaiting"] as const;
const money = (paise: number) => formatMoney(paise, { showDecimals: true });

const REASONS = [
  ["customer-requested", "Requested by customer"], ["wrong-product", "Wrong product sent"], ["damaged", "Arrived damaged"],
  ["defective", "Defective"], ["missing-item", "Item missing"], ["price-adjustment", "Price adjustment"],
  ["duplicate-payment", "Duplicate payment"], ["cancellation", "Order cancelled"], ["return-approved", "Return approved"],
  ["other", "Other"],
] as const;

/**
 * Every refund, newest first, filtered on the server: by status, method,
 * reason, or those waiting for a manager's approval, and searchable by
 * refund, order, invoice or customer. Each row opens to its items, notes and
 * the steps it allows next. Refunds are raised from an order's page, where
 * the items and amounts are worked out.
 */
export function AdminRefundsQueueView() {
  const { filters, page, pageSize, setFilters, setPage, setPageSize, clear } = useUrlFilters(KEYS);
  const { status, q, method, reasonCode, awaiting } = filters;
  const request: RefundListFilters = {
    status, q, method, reasonCode, awaitingApproval: awaiting === "1", page, pageSize,
  };
  const refunds = useAdminResource(() => listRefunds(request),
    [status, q, method, reasonCode, awaiting, page, pageSize]);
  const summary = useAdminResource(() => getRefundSummary(), []);
  const [open, setOpen] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const data = refunds.data;
  const s = summary.data;
  const filtered = Boolean(status || q || method || reasonCode || awaiting);
  const changed = () => {
    void refunds.reload();
    void summary.reload();
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      // Every matching refund, not just this page: up to 50 pages of 100.
      const rows: RefundRecord[] = [];
      for (let next = 1; next <= 50; next += 1) {
        const batch = await listRefunds({ ...request, page: next, pageSize: 100 });
        rows.push(...batch.items);
        if (next >= batch.pagination.total_pages) break;
      }
      downloadCsv(datedFilename("refunds"), toCsv(rows, [
        { header: "Refund number", value: (row) => row.refundNumber },
        { header: "Order", value: (row) => row.orderNumber },
        { header: "Invoice", value: (row) => row.invoiceNumber },
        { header: "Customer", value: (row) => row.customerName },
        { header: "Amount", value: (row) => money(row.amount) },
        { header: "Delivery", value: (row) => money(row.shippingAmount) },
        { header: "Tax", value: (row) => money(row.taxAmount) },
        { header: "Method", value: (row) => row.methodLabel },
        { header: "Reason", value: (row) => row.reasonLabel },
        { header: "Status", value: (row) => row.statusLabel },
        { header: "Requested", value: (row) => formatDate(row.requestedAt) },
        { header: "Processed", value: (row) => (row.processedAt ? formatDate(row.processedAt) : "") },
        { header: "Items", value: (row) => row.items.map((item) => `${item.quantity} x ${item.name}`).join("; ") },
        { header: "Gateway reference", value: (row) => row.gatewayReference },
        { header: "Manual reference", value: (row) => row.manualReference },
      ]));
      toast.success(`${rows.length} refunds exported.`);
    } catch (error) {
      toast.error(problem(error, "The export didn't finish. Please try again."));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <AdminPageHeader
        title="Refunds"
        description="Every refund, with the ones waiting for approval or a retry. Refund items from an order's page."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Billing", href: "/admin/billing" },
          { label: "Refunds" }]}
        actions={
          <>
            <AdminButtonLink href="/admin/settings/billing" size="sm" variant="ghost">Refund rules</AdminButtonLink>
            <AdminButton size="sm" loading={exporting} disabled={!data || data.pagination.total === 0}
              onClick={() => void exportCsv()}>
              <Download className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Export CSV
            </AdminButton>
            <AdminButton size="sm" onClick={changed} loading={refunds.isRefreshing}>
              {refunds.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
              Refresh
            </AdminButton>
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Waiting for approval" value={s ? String(s.awaitingApproval) : null}
          tone={s && s.awaitingApproval > 0 ? "bad" : undefined} />
        <Tile label="Processing" value={s ? String(s.processing) : null} />
        <Tile label="Failed" value={s ? String(s.failed) : null} tone={s && s.failed > 0 ? "bad" : undefined} />
        <Tile label="Refunded today" value={s ? money(s.refundedToday) : null}
          hint={s ? `${s.refundedTodayCount} refund(s)` : undefined} tone="good" />
      </div>

      <StatusTabs
        label="Filter refunds by status"
        value={awaiting === "1" ? "awaiting" : status}
        onChange={(next) => setFilters(next === "awaiting" ? { status: "", awaiting: "1" } : { status: next, awaiting: "" })}
        tabs={[
          { value: "", label: "All" },
          { value: "awaiting", label: "Needs approval", count: s?.awaitingApproval },
          { value: "requested", label: "Requested", count: s?.requested },
          { value: "processing", label: "Processing", count: s?.processing },
          { value: "failed", label: "Failed", count: s?.failed },
          { value: "completed", label: "Completed" },
          { value: "rejected", label: "Rejected" },
          { value: "cancelled", label: "Cancelled" },
        ]}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <LogSearch label="Search refunds" value={q} onChange={(next) => setFilters({ q: next })}
          placeholder="Refund, order or invoice number, customer" />
        <FilterSelect label="Method" value={method} onChange={(next) => setFilters({ method: next })}
          options={[{ value: "", label: "Any method" },
            ...Object.entries(REFUND_METHOD_LABELS).map(([value, label]) => ({ value, label }))]} />
        <FilterSelect label="Reason" value={reasonCode} onChange={(next) => setFilters({ reasonCode: next })}
          options={[{ value: "", label: "Any reason" }, ...REASONS.map(([value, label]) => ({ value, label }))]} />
        {filtered ? (
          <AdminButton size="sm" variant="ghost" onClick={clear}>
            <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Clear filters
          </AdminButton>
        ) : null}
      </div>

      <AdminCard padded={false}>
        <div className="relative overflow-x-auto">
          <table className={cn("w-full min-w-[60rem] text-left text-xs", refunds.isRefreshing && "opacity-60")}>
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr>
                <th className={cn(TH, "w-8")}><span className="sr-only">Details</span></th>
                <th className={TH}>Refund</th>
                <th className={TH}>Order</th>
                <th className={TH}>Customer</th>
                <th className={TH}>Reason</th>
                <th className={TH}>Method</th>
                <th className={cn(TH, "text-right")}>Amount</th>
                <th className={TH}>Requested</th>
                <th className={TH}>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState
                columns={9}
                loading={refunds.isLoading && !data}
                failed={Boolean(refunds.error && !data)}
                empty={Boolean(data && data.items.length === 0)}
                onRetry={() => void refunds.reload()}
                title={filtered ? "No refunds match" : "No refunds yet"}
                hint={filtered ? "Try a different filter or search." : "Refunds raised from orders and returns appear here."}
              />
              {data?.items.map((row) => {
                const expanded = open === row.id;
                return (
                  <Fragment key={row.id}>
                    <tr className="align-top hover:bg-admin-raised">
                      <td className={TD}>
                        <button type="button" aria-expanded={expanded} aria-label={`Details of ${row.refundNumber}`}
                          onClick={() => setOpen(expanded ? null : row.id)} className="text-admin-muted hover:text-admin-ink">
                          {expanded ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                            : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
                        </button>
                      </td>
                      <td className={cn(TD, "whitespace-nowrap font-medium text-admin-ink")}>{row.refundNumber}</td>
                      <td className={cn(TD, "whitespace-nowrap")}>
                        <Link href={`/admin/orders/detail?id=${encodeURIComponent(row.orderId)}`}
                          className="text-admin-muted hover:text-copper-700">#{row.orderNumber}</Link>
                      </td>
                      <td className={cn(TD, "text-admin-ink")}>{row.customerName || "—"}</td>
                      <td className={cn(TD, "text-admin-muted")}>{row.reasonLabel}</td>
                      <td className={cn(TD, "text-admin-muted")}>{row.methodLabel}</td>
                      <td className={cn(TD, "text-right tabular-nums text-admin-ink")}>{money(row.amount)}</td>
                      <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>{formatDate(row.requestedAt)}</td>
                      <td className={TD}>
                        <span className="flex flex-col items-start gap-1">
                          <RefundStatusBadge refund={row} />
                          {row.status === "requested" && row.requiresApproval ? (
                            <span className="text-[0.625rem] text-[#8a5a12]">Needs approval</span>
                          ) : null}
                        </span>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr className="bg-admin-raised">
                        <td className={TD} />
                        <td className={TD} colSpan={8}>
                          <RefundDetails refund={row} onChanged={changed} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </AdminCard>

      {data ? (
        <LogFooter page={data.pagination.page} pageSize={pageSize} total={data.pagination.total}
          totalPages={data.pagination.total_pages} onPage={setPage} onPageSize={setPageSize} />
      ) : null}
    </div>
  );
}

function RefundDetails({ refund, onChanged }: { refund: RefundRecord; onChanged: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      {refund.items.length ? (
        <ul aria-label="Refunded items" className="flex flex-col gap-0.5">
          {refund.items.map((item) => (
            <li key={`${item.orderItemId}`} className="flex justify-between gap-3">
              <span className="text-admin-ink">{item.quantity} × {item.name}</span>
              <span className="tabular-nums text-admin-muted">{money(item.amount)} (tax {money(item.tax)})</span>
            </li>
          ))}
        </ul>
      ) : null}
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-3">
        {refund.shippingAmount ? <Pair label="Delivery" value={money(refund.shippingAmount)} /> : null}
        {refund.tenderAmount ? <Pair label="To gift card / credit / points" value={money(refund.tenderAmount)} /> : null}
        <Pair label="Invoice" value={refund.invoiceNumber || "—"} />
        {refund.gatewayReference ? <Pair label="Gateway reference" value={refund.gatewayReference} /> : null}
        {refund.manualReference ? <Pair label="Transfer reference" value={refund.manualReference} /> : null}
        {refund.approvedAt ? <Pair label="Approved" value={formatDate(refund.approvedAt)} /> : null}
        {refund.processedAt ? <Pair label="Processed" value={formatDate(refund.processedAt)} /> : null}
        {refund.attempts ? <Pair label="Attempts" value={String(refund.attempts)} /> : null}
      </dl>
      {refund.reason ? <p className="text-admin-muted">Note to the customer: {refund.reason}</p> : null}
      {refund.internalNote ? <p className="text-admin-muted">Internal note: {refund.internalNote}</p> : null}
      {refund.failureReason ? <p className="text-[#a12b2b]">{refund.failureReason}</p> : null}
      <RefundActions refund={refund} onChanged={onChanged} />
    </div>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[0.625rem] text-admin-muted">{label}</dt>
      <dd className="text-admin-ink">{value}</dd>
    </div>
  );
}
