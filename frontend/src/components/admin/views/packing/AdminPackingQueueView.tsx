"use client";

import Link from "next/link";
import { AlertTriangle, RefreshCw, X } from "lucide-react";

import { AdminButton, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { FilterSelect, LogFooter, LogSearch, StatusTabs, useUrlFilters } from "@/components/admin/ui/LogPage";
import { TD, TH, TableState, Tile } from "@/components/admin/views/operations/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
import { formatDate, formatPrice } from "@/lib/utils/format";
import { getPackingSummary, listPackingQueue, listPackingStaff } from "@/services/admin/packingAdminService";
import { PACKING_STATUSES, PACKING_STATUS_LABELS } from "@/types/packing";

import { PackingStatusBadge, PriorityBadge, agingLabel } from "./shared";

const KEYS = ["status", "q", "scope", "from", "to", "paymentStatus", "courier", "priority", "assignedTo",
  "shippingType", "overdue"] as const;

const DATE_INPUT =
  "h-9 rounded-[3px] border border-admin-border bg-admin-surface px-2 text-[0.8125rem] text-admin-ink hover:border-admin-border-strong";

/**
 * The packing queue: every order waiting to be picked and packed, most urgent
 * first, then oldest. Filters live in the address bar, so a view ("my urgent
 * orders, overdue") can be bookmarked or shared.
 */
export function AdminPackingQueueView() {
  const { filters, page, pageSize, setFilters, setPage, setPageSize, clear } = useUrlFilters(KEYS);
  const { status, q, scope, from, to, paymentStatus, courier, priority, assignedTo, shippingType, overdue } = filters;

  const queue = useAdminResource(
    () => listPackingQueue({
      status, q, scope: scope === "all" ? "all" : "open", from, to, paymentStatus, courier, priority, assignedTo,
      shippingType, overdue: overdue === "1", page, pageSize,
    }),
    [status, q, scope, from, to, paymentStatus, courier, priority, assignedTo, shippingType, overdue, page, pageSize],
  );
  const summary = useAdminResource(() => getPackingSummary(), []);
  const staff = useAdminResource(() => listPackingStaff(), []);

  const data = queue.data;
  const counts = data?.counts ?? {};
  const total = Object.values(counts).reduce((sum, value) => sum + (value ?? 0), 0);
  const filtered = Boolean(status || q || from || to || paymentStatus || courier || priority || assignedTo
    || shippingType || overdue || scope);
  const s = summary.data;

  return (
    <div>
      <AdminPageHeader
        title="Packing"
        description="Orders to pick and pack, most urgent first. Open one to pick its items, pack it into parcels and print the packing slip."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Packing" }]}
        actions={
          <AdminButton size="sm" onClick={() => { void queue.reload(); void summary.reload(); }}
            loading={queue.isRefreshing}>
            {queue.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
            Refresh
          </AdminButton>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Waiting to pick" value={s ? String(s.waitingToPick) : null} />
        <Tile label="Waiting to pack" value={s ? String(s.waitingToPack) : null} />
        <Tile label="Packed today" value={s ? String(s.packedToday) : null} tone="good" />
        <Tile label="Overdue" value={s ? String(s.overdue) : null} tone={s && s.overdue > 0 ? "bad" : undefined}
          hint={s ? `Not packed within ${s.slaHours} h` : undefined} />
      </div>

      <StatusTabs
        label="Filter by packing status"
        value={status}
        onChange={(next) => setFilters({ status: next })}
        tabs={[
          { value: "", label: "All open", count: data ? total : undefined },
          ...PACKING_STATUSES.filter((value) => value !== "cancelled").map((value) => ({
            value, label: PACKING_STATUS_LABELS[value], count: data ? (counts[value] ?? 0) : undefined,
          })),
          { value: "cancelled", label: "Cancelled" },
        ]}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <LogSearch label="Search the queue" value={q} onChange={(next) => setFilters({ q: next })}
          placeholder="Order number, customer name or email" />
        <FilterSelect label="Assigned to" value={assignedTo} onChange={(next) => setFilters({ assignedTo: next })}
          options={[{ value: "", label: "Anyone" }, { value: "me", label: "Me" }, { value: "unassigned", label: "Unassigned" },
            ...(staff.data ?? []).map((person) => ({ value: person.id, label: person.name }))]} />
        <FilterSelect label="Priority" value={priority} onChange={(next) => setFilters({ priority: next })}
          options={[{ value: "", label: "Any priority" }, { value: "urgent", label: "Urgent" },
            { value: "high", label: "High" }, { value: "normal", label: "Normal" }]} />
        <FilterSelect label="Payment" value={paymentStatus} onChange={(next) => setFilters({ paymentStatus: next })}
          options={[{ value: "", label: "Any payment" }, { value: "paid", label: "Paid" },
            { value: "cod-pending", label: "Cash on delivery" }, { value: "pending", label: "Awaiting payment" }]} />
        <FilterSelect label="Shipping" value={shippingType} onChange={(next) => setFilters({ shippingType: next })}
          options={[{ value: "", label: "Any shipping" }, { value: "standard", label: "Standard" },
            { value: "express", label: "Express" }]} />
        <LogSearch label="Courier" value={courier} onChange={(next) => setFilters({ courier: next })}
          placeholder="Courier" />
        <label className="flex items-center gap-1.5 text-xs text-admin-muted">
          From
          <input type="date" aria-label="Placed from" value={from} max={to || undefined}
            onChange={(event) => setFilters({ from: event.target.value })} className={DATE_INPUT} />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-admin-muted">
          To
          <input type="date" aria-label="Placed to" value={to} min={from || undefined}
            onChange={(event) => setFilters({ to: event.target.value })} className={DATE_INPUT} />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-admin-ink">
          <input type="checkbox" checked={overdue === "1"} onChange={(event) =>
            setFilters({ overdue: event.target.checked ? "1" : "" })} />
          Overdue only
        </label>
        <label className="flex items-center gap-1.5 text-xs text-admin-ink">
          <input type="checkbox" checked={scope === "all"} onChange={(event) =>
            setFilters({ scope: event.target.checked ? "all" : "" })} />
          Include shipped
        </label>
        {filtered ? (
          <AdminButton size="sm" variant="ghost" onClick={clear}>
            <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Clear filters
          </AdminButton>
        ) : null}
      </div>

      <AdminCard padded={false}>
        <div className="relative overflow-x-auto">
          <table className={cn("w-full min-w-[64rem] text-left text-xs", queue.isRefreshing && "opacity-60")}>
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr>
                <th className={TH}>Order</th>
                <th className={TH}>Customer</th>
                <th className={TH}>Placed</th>
                <th className={TH}>Payment</th>
                <th className={cn(TH, "text-right")}>Total</th>
                <th className={cn(TH, "text-right")}>Items</th>
                <th className={TH}>Priority</th>
                <th className={TH}>Shipping</th>
                <th className={TH}>Status</th>
                <th className={TH}>Assigned</th>
                <th className={cn(TH, "text-right")}>Waiting</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState
                columns={11}
                loading={queue.isLoading && !data}
                failed={Boolean(queue.error && !data)}
                empty={Boolean(data && data.items.length === 0)}
                onRetry={() => void queue.reload()}
                title={filtered ? "No orders match" : "Nothing to pack"}
                hint={filtered ? "Try a different filter or search." : "Confirmed orders appear here to be picked and packed."}
              />
              {data?.items.map((row) => (
                <tr key={row.id} className="align-top hover:bg-admin-raised">
                  <td className={cn(TD, "whitespace-nowrap")}>
                    <Link href={`/admin/packing/job?id=${row.id}`} className="font-medium text-admin-ink hover:text-copper-700">
                      #{row.orderNumber}
                    </Link>
                  </td>
                  <td className={cn(TD, "text-admin-ink")}>{row.customerName || "—"}</td>
                  <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>{formatDate(row.placedAt)}</td>
                  <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>
                    {row.paymentStatus === "cod-pending" ? "COD" : row.paymentStatus.replace(/-/g, " ")}
                  </td>
                  <td className={cn(TD, "text-right tabular-nums text-admin-ink")}>{formatPrice(row.total)}</td>
                  <td className={cn(TD, "text-right tabular-nums text-admin-ink")}>{row.itemCount}</td>
                  <td className={TD}><PriorityBadge priority={row.priority} /></td>
                  <td className={cn(TD, "text-admin-muted")}>
                    {row.shippingMethod}
                    {row.courierName ? <span className="block text-[0.625rem]">{row.courierName}</span> : null}
                  </td>
                  <td className={TD}><PackingStatusBadge status={row.status} label={row.statusLabel} /></td>
                  <td className={cn(TD, "text-admin-ink")}>{row.assignedTo?.name || <span className="text-admin-muted">—</span>}</td>
                  <td className={cn(TD, "whitespace-nowrap text-right tabular-nums",
                    row.aging.overdue ? "font-medium text-[#a12b2b]" : "text-admin-muted")}>
                    {row.aging.overdue ? (
                      <span className="inline-flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                        <span className="sr-only">Overdue: </span>
                      </span>
                    ) : null}
                    {agingLabel(row.aging.hours)}
                  </td>
                </tr>
              ))}
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
