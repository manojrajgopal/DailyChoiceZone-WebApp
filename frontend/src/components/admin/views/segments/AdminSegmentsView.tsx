"use client";

import Link from "next/link";
import { useState } from "react";
import { Archive, Eye, Pencil, Plus, RefreshCw, RotateCcw, SlidersHorizontal, X } from "lucide-react";

import { AdminButton, AdminButtonLink, AdminCard, AdminPageHeader, ConfirmDialog } from "@/components/admin/ui/AdminChrome";
import { LogFooter, LogSearch, StatusTabs, useUrlFilters } from "@/components/admin/ui/LogPage";
import { TD, TH, TableState } from "@/components/admin/views/operations/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDateTime } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import { archiveSegment, listSegments, refreshSegmentMetrics, restoreSegment } from "@/services/segmentsService";
import { toast } from "@/store/toastStore";
import type { SegmentSummary } from "@/types/segments";

import {
  ADMIN_CRUMB,
  CUSTOMERS_CRUMB,
  SegmentKindBadge,
  SegmentStatusBadge,
  SegmentsNoAccess,
  editHref,
  friendlyError,
  isForbidden,
  segmentHref,
} from "./shared";

const KEYS = ["q", "status"] as const;
const STATUSES = ["active", "archived", "all"] as const;

const ICON_BUTTON =
  "inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-admin-raised hover:text-admin-ink disabled:cursor-not-allowed disabled:opacity-40";

/** Customers → Segments: every saved segment, its size and freshness. */
export function AdminSegmentsView() {
  const { filters, page, pageSize, setFilters, setPage, setPageSize, clear } = useUrlFilters(KEYS);
  const status = (STATUSES as readonly string[]).includes(filters.status) ? (filters.status as (typeof STATUSES)[number]) : "active";
  const segments = useAdminResource(
    () => listSegments({ q: filters.q, status, page, pageSize }),
    [filters.q, status, page, pageSize],
  );
  const data = segments.data;
  const counts = data?.counts;

  const [archiving, setArchiving] = useState<SegmentSummary | null>(null);
  const [confirmRefresh, setConfirmRefresh] = useState(false);
  const [busy, setBusy] = useState<string>("");

  const onArchive = async () => {
    if (!archiving) return;
    setBusy(`archive-${archiving.id}`);
    try {
      await archiveSegment(archiving.id);
      toast.success(`${archiving.name} archived`);
      setArchiving(null);
      await segments.reload();
    } catch (error) {
      toast.error(friendlyError(error, "The segment wasn't archived. Please try again."));
    } finally {
      setBusy("");
    }
  };

  const onRestore = async (segment: SegmentSummary) => {
    setBusy(`restore-${segment.id}`);
    try {
      await restoreSegment(segment.id);
      toast.success(`${segment.name} restored`);
      await segments.reload();
    } catch (error) {
      toast.error(friendlyError(error, "The segment wasn't restored. Please try again."));
    } finally {
      setBusy("");
    }
  };

  const onRefresh = async () => {
    setBusy("refresh");
    try {
      const result = await refreshSegmentMetrics();
      toast.success(
        `Metrics refreshed for ${result.refreshed.toLocaleString("en-IN")} customers; ${result.segments.toLocaleString("en-IN")} segments recalculated.`,
      );
      setConfirmRefresh(false);
      await segments.reload();
    } catch (error) {
      toast.error(friendlyError(error, "The metrics weren't refreshed. Please try again."));
    } finally {
      setBusy("");
    }
  };

  if (isForbidden(segments.error)) {
    return (
      <div>
        <AdminPageHeader title="Segments" breadcrumbs={[ADMIN_CRUMB, CUSTOMERS_CRUMB, { label: "Segments" }]} />
        <SegmentsNoAccess />
      </div>
    );
  }

  const filtered = Boolean(filters.q || status !== "active");

  return (
    <div>
      <AdminPageHeader
        title="Segments"
        description="Groups of customers defined by rules. Target them with campaigns and coupons."
        breadcrumbs={[ADMIN_CRUMB, CUSTOMERS_CRUMB, { label: "Segments" }]}
        actions={
          <>
            <AdminButton size="sm" onClick={() => setConfirmRefresh(true)} disabled={busy === "refresh"}>
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              Refresh metrics
            </AdminButton>
            <AdminButtonLink size="sm" href="/admin/customers/segments/settings">
              <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              RFM settings
            </AdminButtonLink>
            <AdminButtonLink size="sm" variant="primary" href="/admin/customers/segments/edit">
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              New segment
            </AdminButtonLink>
          </>
        }
      />

      <StatusTabs
        label="Filter segments by status"
        value={status}
        onChange={(next) => setFilters({ status: next === "active" ? "" : next })}
        tabs={[
          { value: "active", label: "Active", count: counts?.active },
          { value: "archived", label: "Archived", count: counts?.archived },
          { value: "all", label: "All", count: counts ? counts.active + counts.archived : undefined },
        ]}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <LogSearch label="Search segments" value={filters.q} onChange={(q) => setFilters({ q })} placeholder="Segment name" />
        {filtered ? (
          <AdminButton size="sm" variant="ghost" onClick={clear}>
            <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Clear filters
          </AdminButton>
        ) : null}
      </div>

      <AdminCard padded={false}>
        <div className="overflow-x-auto">
          <table className={cn("w-full min-w-[48rem] text-left text-xs", segments.isRefreshing && "opacity-60")}>
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr>
                <th className={TH}>Segment</th>
                <th className={TH}>Kind</th>
                <th className={TH}>Status</th>
                <th className={cn(TH, "text-right")}>Members</th>
                <th className={TH}>Last calculated</th>
                <th className={cn(TH, "text-right")}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState
                columns={6}
                loading={segments.isLoading && !data}
                failed={Boolean(segments.error && !data)}
                empty={Boolean(data && data.items.length === 0)}
                onRetry={() => void segments.reload()}
                title={filtered ? "No segments match" : "No segments yet"}
                hint={filtered ? "Try a different search or status." : "Create one to group customers by what they do."}
              />
              {data?.items.map((row) => (
                <tr key={row.id} className="align-top hover:bg-admin-raised">
                  <td className={TD}>
                    <Link href={segmentHref(row.id)} className="block font-medium text-admin-ink hover:text-copper-700">
                      {row.name}
                    </Link>
                    {row.description ? (
                      <span className="block max-w-[22rem] truncate text-admin-muted">{row.description}</span>
                    ) : null}
                    <span className="block text-[0.6875rem] text-admin-faint">
                      {row.conditionCount} {row.conditionCount === 1 ? "condition" : "conditions"} · match {row.match}
                    </span>
                  </td>
                  <td className={TD}>
                    <SegmentKindBadge kind={row.kind} />
                  </td>
                  <td className={TD}>
                    <SegmentStatusBadge status={row.status} />
                  </td>
                  <td className={cn(TD, "text-right font-medium tabular-nums text-admin-ink")}>
                    {row.memberCount.toLocaleString("en-IN")}
                  </td>
                  <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>
                    {row.lastCalculatedAt ? formatDateTime(row.lastCalculatedAt) : "Not yet"}
                  </td>
                  <td className={cn(TD, "text-right")}>
                    <span className="flex items-center justify-end gap-0.5">
                      <Link href={segmentHref(row.id)} aria-label={`View ${row.name}`} title="View" className={ICON_BUTTON}>
                        <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />
                      </Link>
                      {row.status === "active" ? (
                        <>
                          <Link href={editHref(row.id)} aria-label={`Edit ${row.name}`} title="Edit" className={ICON_BUTTON}>
                            <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                          </Link>
                          <button
                            type="button"
                            onClick={() => setArchiving(row)}
                            aria-label={`Archive ${row.name}`}
                            title="Archive"
                            className={cn(ICON_BUTTON, "hover:bg-[#fbeaea] hover:text-[#a32424]")}
                          >
                            <Archive className="h-3.5 w-3.5" strokeWidth={1.75} />
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void onRestore(row)}
                          disabled={busy === `restore-${row.id}`}
                          aria-label={`Restore ${row.name}`}
                          title="Restore"
                          className={ICON_BUTTON}
                        >
                          <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
                        </button>
                      )}
                    </span>
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

      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => !open && setArchiving(null)}
        title="Archive segment?"
        confirmLabel="Archive segment"
        loading={busy.startsWith("archive-")}
        message={
          <>
            Archive <strong className="text-admin-ink">{archiving?.name}</strong>? It stops being recalculated, campaigns
            can&rsquo;t target it, and coupons restricted to it stop working. You can restore it later.
          </>
        }
        onConfirm={() => void onArchive()}
      />

      <ConfirmDialog
        open={confirmRefresh}
        onOpenChange={setConfirmRefresh}
        title="Refresh customer metrics now?"
        confirmLabel="Refresh metrics"
        destructive={false}
        loading={busy === "refresh"}
        message="This recomputes every customer's metrics and then recalculates every active segment. It can take a minute on a large store; the job also does this on its own every few hours."
        onConfirm={() => void onRefresh()}
      />
    </div>
  );
}
