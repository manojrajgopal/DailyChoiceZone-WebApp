"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, Download, RefreshCw, X } from "lucide-react";

import { AdminButton, AdminButtonLink, AdminCard, AdminPageHeader, ConfirmDialog } from "@/components/admin/ui/AdminChrome";
import {
  FilterSelect,
  LogFooter,
  LogSearch,
  StatusTabs,
  collectPages,
  downloadCsv,
  useUrlFilters,
} from "@/components/admin/ui/LogPage";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
import { formatDate, formatPrice } from "@/lib/utils/format";
import { ApiError } from "@/services/api/client";
import { cancelMembership, searchMembers, type MemberRow } from "@/services/membershipService";
import { toast } from "@/store/toastStore";

import { Badge, MEMBER_STATUS } from "./AdminMembershipView";

const KEYS = ["status", "plan", "q"] as const;

/**
 * Every member — the full list behind "Members" on the membership page.
 * Filtered, searched and paged on the server, with the filters in the
 * address bar so a view can be shared.
 */
export function AdminMembersDirectoryView() {
  const { filters, page, pageSize, setFilters, setPage, setPageSize, clear } = useUrlFilters(KEYS);
  const [ending, setEnding] = useState<MemberRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  const members = useAdminResource(
    () => searchMembers({ status: filters.status, plan: filters.plan, q: filters.q, page, pageSize }),
    [filters, page, pageSize],
  );
  const data = members.data;
  const counts = data?.counts;
  const all = counts ? counts.active + counts.expired + counts.cancelled : undefined;
  const filtered = Boolean(filters.plan || filters.q);
  const who = (row: MemberRow) => row.customerName || row.customerEmail || row.customerId;

  const end = async () => {
    if (!ending) return;
    setBusy(true);
    try {
      await cancelMembership(ending.id);
      toast.success(`Membership ended for ${who(ending)}.`);
      setEnding(null);
      await members.reload();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "We couldn't end this membership. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const { rows, truncated } = await collectPages((p) =>
        searchMembers({ status: filters.status, plan: filters.plan, q: filters.q, page: p, pageSize: 100 }),
      );
      downloadCsv(
        `members-${new Date().toISOString().slice(0, 10)}.csv`,
        ["Membership", "Customer", "Email", "Plan", "Status", "Paid (INR)", "Paid on", "Starts", "Ends", "Saved on orders (INR)", "Free-delivery orders"],
        rows.map((row) => [
          row.id,
          row.customerName,
          row.customerEmail,
          row.planName,
          MEMBER_STATUS[row.status]?.label ?? row.status,
          (row.amount / 100).toFixed(2),
          row.paidAt ? formatDate(row.paidAt) : "",
          row.startsAt ? formatDate(row.startsAt) : "",
          row.endsAt ? formatDate(row.endsAt) : "",
          row.savedOnOrders.toFixed(2),
          row.freeDeliveryOrders,
        ]),
      );
      toast.success(truncated ? `Exported the newest ${rows.length.toLocaleString("en-IN")} members.` : `Exported ${rows.length.toLocaleString("en-IN")} members.`);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "The export didn't work. Please try again.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <AdminPageHeader
        title="Member directory"
        description="Everyone who has bought a membership plan: what they paid, when it runs, and what it has saved them."
        breadcrumbs={[
          { label: "Admin", href: "/admin/dashboard" },
          { label: "Membership", href: "/admin/membership" },
          { label: "Members" },
        ]}
        actions={
          <>
            <AdminButtonLink href="/admin/membership" size="sm">
              <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              Programme & plans
            </AdminButtonLink>
            <AdminButton size="sm" onClick={() => void members.reload()} loading={members.isRefreshing}>
              {members.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
              Refresh
            </AdminButton>
            <AdminButton size="sm" variant="primary" onClick={() => void exportCsv()} loading={exporting} disabled={!data || data.pagination.total === 0}>
              {exporting ? null : <Download className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
              Export CSV
            </AdminButton>
          </>
        }
      />

      <StatusTabs
        label="Filter members by status"
        value={filters.status}
        onChange={(status) => setFilters({ status })}
        tabs={[
          { value: "", label: "All", count: all },
          { value: "active", label: "Active", count: counts?.active },
          { value: "pending", label: "Awaiting payment", count: counts?.pending },
          { value: "expired", label: "Ended", count: counts?.expired },
          { value: "cancelled", label: "Cancelled", count: counts?.cancelled },
        ]}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <LogSearch label="Search members" value={filters.q} onChange={(q) => setFilters({ q })} placeholder="Search name, email, plan or membership ID" />
        <FilterSelect
          label="Plan"
          value={filters.plan}
          onChange={(plan) => setFilters({ plan })}
          options={[{ value: "", label: "All plans" }, ...(data?.plans ?? []).map((plan) => ({ value: plan.id, label: plan.name }))]}
        />
        {filtered || filters.status ? (
          <AdminButton size="sm" variant="ghost" onClick={clear}>
            <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Clear filters
          </AdminButton>
        ) : null}
      </div>

      <AdminCard padded={false}>
        {members.error && !data ? (
          <div className="py-10 text-center">
            <p className="text-sm text-admin-ink">The members didn&rsquo;t load.</p>
            <AdminButton size="sm" className="mt-3" onClick={() => void members.reload()}>
              Try again
            </AdminButton>
          </div>
        ) : (
          <div className="relative overflow-x-auto">
            <table className={cn("w-full min-w-[64rem] text-left text-xs", members.isRefreshing && "opacity-60")}>
              <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
                <tr>
                  <th className="px-3 py-2.5 font-medium">Customer</th>
                  <th className="px-3 py-2.5 font-medium">Plan</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 text-right font-medium">Paid</th>
                  <th className="px-3 py-2.5 font-medium">Runs</th>
                  <th className="px-3 py-2.5 text-right font-medium">Saved</th>
                  <th className="px-3 py-2.5 text-right font-medium">Free deliveries</th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-admin-border">
                {members.isLoading && !data ? (
                  Array.from({ length: 8 }, (_, index) => (
                    <tr key={index}>
                      {Array.from({ length: 8 }, (__, cell) => (
                        <td key={cell} className="px-3 py-3.5">
                          <span className="block h-3 w-full max-w-28 animate-pulse rounded-[2px] bg-admin-border" />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : !data || data.items.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-14 text-center">
                      <p className="text-sm font-medium text-admin-ink">{filtered || filters.status ? "No members match" : "No members yet"}</p>
                      <p className="mt-1 text-xs text-admin-muted">
                        {filtered || filters.status ? "Try a different filter or search." : "Members appear here as soon as someone buys a plan."}
                      </p>
                    </td>
                  </tr>
                ) : (
                  data.items.map((row) => {
                    const status = MEMBER_STATUS[row.status] ?? MEMBER_STATUS.expired;
                    return (
                      <tr key={row.id} className="align-top hover:bg-admin-raised">
                        <td className="px-3 py-3">
                          <Link href={`/admin/customers/detail?id=${encodeURIComponent(row.customerId)}`} className="block font-medium text-admin-ink hover:text-copper-700">
                            {row.customerName || "—"}
                          </Link>
                          <span className="block text-admin-muted">{row.customerEmail}</span>
                          <span className="block text-[0.625rem] text-admin-faint">{row.id}</span>
                        </td>
                        <td className="px-3 py-3 text-admin-ink">{row.planName}</td>
                        <td className="px-3 py-3">
                          <Badge tone={status.tone}>{status.label}</Badge>
                        </td>
                        <td className="px-3 py-3 text-right">
                          <span className="block tabular-nums text-admin-ink">{formatPrice(row.amount / 100)}</span>
                          <span className="text-[0.6875rem] text-admin-muted">{row.paidAt ? formatDate(row.paidAt) : "Not paid"}</span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-admin-muted">
                          {row.startsAt ? `${formatDate(row.startsAt)} – ${row.endsAt ? formatDate(row.endsAt) : "…"}` : "—"}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums text-admin-ink">{formatPrice(row.savedOnOrders)}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-admin-ink">
                          {row.freeDeliveryOrders}
                          {row.status === "active" && row.freeDeliveriesLeftThisMonth !== null ? (
                            <span className="block text-[0.6875rem] text-admin-muted">{row.freeDeliveriesLeftThisMonth} left this month</span>
                          ) : null}
                        </td>
                        <td className="px-3 py-3 text-right">
                          {row.status === "active" ? (
                            <AdminButton variant="ghost" size="sm" onClick={() => setEnding(row)} aria-label={`End membership for ${who(row)}`}>
                              End membership
                            </AdminButton>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
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

      <ConfirmDialog
        open={ending !== null}
        onOpenChange={(open) => !open && setEnding(null)}
        title="End this membership now?"
        message={
          ending
            ? `${who(ending)} loses their ${ending.planName} benefits straight away. Any refund is made separately, from the payment's own page.`
            : ""
        }
        confirmLabel="End membership"
        loading={busy}
        onConfirm={() => void end()}
      />
    </div>
  );
}
