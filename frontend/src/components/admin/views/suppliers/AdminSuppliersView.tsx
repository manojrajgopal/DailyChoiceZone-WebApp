"use client";

import Link from "next/link";
import { Plus, X } from "lucide-react";

import { AdminButton, AdminButtonLink, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { IdFilter } from "@/components/admin/ui/IdFilter";
import { FilterSelect, LogFooter, StatusTabs, useUrlFilters } from "@/components/admin/ui/LogPage";
import { TD, TH, TableState } from "@/components/admin/views/operations/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";
import { listSuppliers } from "@/services/suppliersService";
import type { SupplierSort } from "@/types/suppliers";

import { ADMIN_CRUMB, NoAccess, SupplierStatusBadge, isForbidden } from "./shared";

const KEYS = ["q", "status", "sort"] as const;

const SORTS: { value: SupplierSort; label: string }[] = [
  { value: "name", label: "Sort: name" },
  { value: "code", label: "Sort: code" },
  { value: "createdAt", label: "Sort: newest" },
];

/**
 * The supplier directory. Archived suppliers are hidden unless their tab is
 * chosen. One supplier is found by its Supplier ID (or code), never by a name,
 * GSTIN or email (docs/id-lookup.md).
 */
export function AdminSuppliersView() {
  const { filters, page, pageSize, setFilters, setPage, setPageSize, clear } = useUrlFilters(KEYS);
  const sort = (SORTS.some((entry) => entry.value === filters.sort) ? filters.sort : "name") as SupplierSort;
  const suppliers = useAdminResource(
    () => listSuppliers({ q: filters.q, status: filters.status, sort, page, pageSize }),
    [filters.q, filters.status, sort, page, pageSize],
  );
  const data = suppliers.data;
  const counts = data?.counts ?? {};
  const filtered = Boolean(filters.q || filters.status);

  const header = (
    <AdminPageHeader
      title="Suppliers"
      description="Who you buy from, what they supply, and at what cost."
      breadcrumbs={[ADMIN_CRUMB, { label: "Suppliers" }]}
      actions={
        <AdminButtonLink href="/admin/suppliers/new" variant="primary" size="sm">
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
          New supplier
        </AdminButtonLink>
      }
    />
  );

  if (isForbidden(suppliers.error)) {
    return (
      <div>
        <AdminPageHeader title="Suppliers" breadcrumbs={[ADMIN_CRUMB, { label: "Suppliers" }]} />
        <NoAccess area="suppliers" />
      </div>
    );
  }

  const countOf = (key: string) => (data ? (counts[key] ?? 0) : undefined);

  return (
    <div>
      {header}

      <StatusTabs
        label="Filter suppliers by status"
        value={filters.status}
        onChange={(status) => setFilters({ status })}
        tabs={[
          { value: "", label: "All current", count: data ? countOf("active")! + countOf("inactive")! : undefined },
          { value: "active", label: "Active", count: countOf("active") },
          { value: "inactive", label: "Inactive", count: countOf("inactive") },
          { value: "archived", label: "Archived", count: countOf("archived") },
        ]}
      />

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <IdFilter entity="supplier" value={filters.q} onChange={(q) => setFilters({ q })} className="w-56" />
        <FilterSelect label="Sort suppliers" value={sort} onChange={(value) => setFilters({ sort: value === "name" ? "" : value })} options={SORTS} />
        {filtered ? (
          <AdminButton size="sm" variant="ghost" onClick={clear}>
            <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Clear filters
          </AdminButton>
        ) : null}
      </div>

      <AdminCard padded={false}>
        <div className="overflow-x-auto">
          <table className={cn("w-full min-w-[48rem] text-left text-xs", suppliers.isRefreshing && "opacity-60")}>
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr>
                <th className={TH}>Supplier</th>
                <th className={TH}>Contact</th>
                <th className={TH}>GSTIN</th>
                <th className={TH}>Terms</th>
                <th className={TH}>Status</th>
                <th className={cn(TH, "text-right")}>Added</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState
                columns={6}
                loading={suppliers.isLoading && !data}
                failed={Boolean(suppliers.error && !data)}
                empty={Boolean(data && data.items.length === 0)}
                onRetry={() => void suppliers.reload()}
                title={filtered ? "No suppliers match" : "No suppliers yet"}
                hint={filtered ? "Try a different search or status." : "Add the businesses you buy stock from."}
              />
              {data && data.items.length === 0 && !filtered ? (
                <tr>
                  <td colSpan={6} className="pb-10 text-center">
                    <AdminButtonLink href="/admin/suppliers/new" size="sm" variant="primary">
                      Add your first supplier
                    </AdminButtonLink>
                  </td>
                </tr>
              ) : null}
              {data?.items.map((row) => (
                <tr key={row.id} className="align-top hover:bg-admin-raised">
                  <td className={TD}>
                    <Link
                      href={`/admin/suppliers/detail?id=${encodeURIComponent(row.id)}`}
                      className="block font-medium text-admin-ink hover:text-copper-700"
                    >
                      {row.name}
                    </Link>
                    <span className="block font-mono text-[0.6875rem] text-admin-muted">{row.code}</span>
                  </td>
                  <td className={TD}>
                    <span className="block text-admin-ink">{row.contactPerson || "—"}</span>
                    <span className="block text-admin-muted">{[row.phone, row.email].filter(Boolean).join(" · ")}</span>
                  </td>
                  <td className={cn(TD, "font-mono text-admin-muted")}>{row.gstin || "—"}</td>
                  <td className={cn(TD, "text-admin-muted")}>
                    {row.paymentTerms || (row.creditDays ? `${row.creditDays} days` : "—")}
                  </td>
                  <td className={TD}>
                    <SupplierStatusBadge status={row.status} />
                  </td>
                  <td className={cn(TD, "whitespace-nowrap text-right text-admin-muted")}>
                    {row.createdAt ? formatDate(row.createdAt) : "—"}
                  </td>
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
