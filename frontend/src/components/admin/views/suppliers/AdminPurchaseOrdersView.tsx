"use client";

import Link from "next/link";
import { Plus, X } from "lucide-react";

import { AdminButton, AdminButtonLink, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { IdFilter } from "@/components/admin/ui/IdFilter";
import { LogFooter, StatusTabs, useUrlFilters } from "@/components/admin/ui/LogPage";
import { TD, TH, TableState } from "@/components/admin/views/operations/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";
import { listPurchaseOrders } from "@/services/purchaseOrdersService";
import type { PurchaseOrderStatus } from "@/types/suppliers";

import { ADMIN_CRUMB, NoAccess, PO_STATUS_LABELS, PoStatusBadge, isForbidden, rupees } from "./shared";

const KEYS = ["q", "status", "supplier", "from", "to"] as const;

const STATUSES = Object.keys(PO_STATUS_LABELS) as PurchaseOrderStatus[];

const DATE_INPUT =
  "h-9 rounded-[3px] border border-admin-border bg-admin-surface px-2 text-[0.8125rem] text-admin-ink hover:border-admin-border-strong";

/**
 * Every purchase order, filterable by status, supplier and date. A purchase
 * order and a supplier are each chosen by ID (docs/id-lookup.md) — never by a
 * supplier's name — so any supplier can be filtered on, not just the first 100.
 */
export function AdminPurchaseOrdersView() {
  const { filters, page, pageSize, setFilters, setPage, setPageSize, clear } = useUrlFilters(KEYS);
  const orders = useAdminResource(
    () => listPurchaseOrders({ ...filters, page, pageSize }),
    [filters.q, filters.status, filters.supplier, filters.from, filters.to, page, pageSize],
  );
  const data = orders.data;
  const counts = data?.counts ?? {};
  const filtered = Boolean(filters.q || filters.status || filters.supplier || filters.from || filters.to);

  if (isForbidden(orders.error)) {
    return (
      <div>
        <AdminPageHeader title="Purchase orders" breadcrumbs={[ADMIN_CRUMB, { label: "Purchase orders" }]} />
        <NoAccess area="purchasing" />
      </div>
    );
  }

  return (
    <div>
      <AdminPageHeader
        title="Purchase orders"
        description="Stock ordered from suppliers, and what has arrived."
        breadcrumbs={[ADMIN_CRUMB, { label: "Purchase orders" }]}
        actions={
          <AdminButtonLink
            href={`/admin/purchase-orders/new${filters.supplier ? `?supplier=${encodeURIComponent(filters.supplier)}` : ""}`}
            variant="primary"
            size="sm"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            New purchase order
          </AdminButtonLink>
        }
      />

      <StatusTabs
        label="Filter purchase orders by status"
        value={filters.status}
        onChange={(status) => setFilters({ status })}
        tabs={[
          { value: "", label: "All" },
          ...STATUSES.map((status) => ({ value: status, label: PO_STATUS_LABELS[status], count: data ? (counts[status] ?? 0) : undefined })),
        ]}
      />

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <IdFilter entity="purchase_order" value={filters.q} onChange={(q) => setFilters({ q })} className="w-64" />
        <IdFilter entity="supplier" value={filters.supplier} onChange={(supplier) => setFilters({ supplier })} className="w-56" />
        <label className="flex items-center gap-1.5 text-xs text-admin-muted">
          From
          <input type="date" aria-label="Raised from" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilters({ from: e.target.value })} className={DATE_INPUT} />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-admin-muted">
          To
          <input type="date" aria-label="Raised to" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilters({ to: e.target.value })} className={DATE_INPUT} />
        </label>
        {filtered ? (
          <AdminButton size="sm" variant="ghost" onClick={clear}>
            <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Clear filters
          </AdminButton>
        ) : null}
      </div>

      <AdminCard padded={false}>
        <div className="overflow-x-auto">
          <table className={cn("w-full min-w-[46rem] text-left text-xs", orders.isRefreshing && "opacity-60")}>
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr>
                <th className={TH}>PO</th>
                <th className={TH}>Supplier</th>
                <th className={TH}>Status</th>
                <th className={cn(TH, "text-right")}>Items</th>
                <th className={cn(TH, "text-right")}>Total</th>
                <th className={TH}>Expected</th>
                <th className={cn(TH, "text-right")}>Raised</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState
                columns={7}
                loading={orders.isLoading && !data}
                failed={Boolean(orders.error && !data)}
                empty={Boolean(data && data.items.length === 0)}
                onRetry={() => void orders.reload()}
                title={filtered ? "No purchase orders match" : "No purchase orders yet"}
                hint={filtered ? "Try a different filter or search." : "Raise one to order stock from a supplier."}
              />
              {data && data.items.length === 0 && !filtered ? (
                <tr>
                  <td colSpan={7} className="pb-10 text-center">
                    <AdminButtonLink href="/admin/purchase-orders/new" size="sm" variant="primary">
                      Raise a purchase order
                    </AdminButtonLink>
                  </td>
                </tr>
              ) : null}
              {data?.items.map((row) => (
                <tr key={row.id} className="hover:bg-admin-raised">
                  <td className={TD}>
                    <Link href={`/admin/purchase-orders/detail?id=${encodeURIComponent(row.id)}`} className="font-medium text-admin-ink hover:text-copper-700">
                      {row.poNumber}
                    </Link>
                  </td>
                  <td className={TD}>
                    <Link href={`/admin/suppliers/detail?id=${encodeURIComponent(row.supplierId)}`} className="text-admin-ink hover:text-copper-700">
                      {row.supplierName}
                    </Link>
                  </td>
                  <td className={TD}>
                    <PoStatusBadge status={row.status} label={row.statusLabel} />
                  </td>
                  <td className={cn(TD, "text-right tabular-nums")}>{row.itemCount}</td>
                  <td className={cn(TD, "text-right tabular-nums text-admin-ink")}>{rupees(row.total)}</td>
                  <td className={cn(TD, "text-admin-muted")}>{row.expectedAt ? formatDate(row.expectedAt) : "—"}</td>
                  <td className={cn(TD, "whitespace-nowrap text-right text-admin-muted")}>{formatDate(row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminCard>

      {data ? (
        <LogFooter
          page={data.pagination.page}
          pageSize={pageSize}
          total={data.pagination.total}
          totalPages={data.pagination.total_pages}
          onPage={setPage}
          onPageSize={setPageSize}
        />
      ) : null}
    </div>
  );
}
