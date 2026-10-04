"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Archive, BadgePercent, Download, Megaphone, Pencil, RefreshCw, RotateCcw } from "lucide-react";

import { AdminButton, AdminButtonLink, AdminCard, AdminPageHeader, ConfirmDialog } from "@/components/admin/ui/AdminChrome";
import { AdminPagination } from "@/components/admin/ui/AdminPagination";
import { IdFilter } from "@/components/admin/ui/IdFilter";
import { BarList } from "@/components/admin/charts/BarList";
import { Tile } from "@/components/admin/views/operations/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDateTime } from "@/lib/support/format";
import {
  archiveSegment,
  exportSegment,
  getSegment,
  getSegmentFields,
  listSegmentMembers,
  recalculateSegment,
  restoreSegment,
} from "@/services/segmentsService";
import { toast } from "@/store/toastStore";
import type { RfmScoreCount, SegmentDetail, SegmentHistoryEntry } from "@/types/segments";

import { MemberTable } from "./MemberTable";
import {
  ADMIN_CRUMB,
  CUSTOMERS_CRUMB,
  LoadFailed,
  PageSkeleton,
  RFM_LABELS,
  RulesSummary,
  SEGMENTS_CRUMB,
  SegmentKindBadge,
  SegmentStatusBadge,
  SegmentsNoAccess,
  countConditions,
  editHref,
  friendlyError,
  isForbidden,
  isNotFound,
} from "./shared";

const MEMBERS_PAGE_SIZE = 25;

/** `/admin/customers/segments/detail?id=3`: who's in a segment, how they score, and what happened to it. */
export function AdminSegmentDetailView() {
  const params = useSearchParams();
  const id = Number(params.get("id")) || 0;
  const segment = useAdminResource(() => getSegment(id), [id], { enabled: id > 0 });
  // The registry turns rule keys into words; the summary still renders (with keys) if it fails.
  const registry = useAdminResource(() => getSegmentFields(), []);

  const crumbs = [ADMIN_CRUMB, CUSTOMERS_CRUMB, SEGMENTS_CRUMB, { label: segment.data?.name ?? "Segment" }];

  if (!id || isNotFound(segment.error)) {
    return (
      <div>
        <AdminPageHeader title="Segment" breadcrumbs={crumbs} />
        <AdminCard>
          <p className="text-sm text-admin-ink">That segment doesn&apos;t exist.</p>
          <AdminButtonLink href="/admin/customers/segments" size="sm" className="mt-3">
            Back to segments
          </AdminButtonLink>
        </AdminCard>
      </div>
    );
  }
  if (isForbidden(segment.error)) {
    return (
      <div>
        <AdminPageHeader title="Segment" breadcrumbs={crumbs} />
        <SegmentsNoAccess />
      </div>
    );
  }
  if (segment.error && !segment.data) {
    return (
      <div>
        <AdminPageHeader title="Segment" breadcrumbs={crumbs} />
        <LoadFailed onRetry={() => void segment.reload()} />
      </div>
    );
  }
  if (!segment.data) return <PageSkeleton label="Loading the segment" />;

  return <SegmentDetailBody detail={segment.data} registry={registry.data} onChanged={() => segment.reload()} />;
}

function SegmentDetailBody({
  detail,
  registry,
  onChanged,
}: {
  detail: SegmentDetail;
  registry: Parameters<typeof RulesSummary>[0]["registry"];
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState("");
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const members = useAdminResource(
    () => listSegmentMembers(detail.id, { q, page, pageSize: MEMBERS_PAGE_SIZE }),
    [detail.id, q, page, detail.memberCount, detail.lastCalculatedAt],
  );
  const { actions } = detail;
  const active = detail.status === "active";

  const run = async (key: string, action: () => Promise<unknown>, done: string, failed: string) => {
    setBusy(key);
    try {
      await action();
      toast.success(done);
      await onChanged();
      return true;
    } catch (error) {
      toast.error(friendlyError(error, failed));
      return false;
    } finally {
      setBusy("");
    }
  };

  const recalculate = async () => {
    setBusy("recalculate");
    try {
      const next = await recalculateSegment(detail.id);
      toast.success(
        `Recalculated: ${detail.memberCount.toLocaleString("en-IN")} → ${next.memberCount.toLocaleString("en-IN")} members.`,
      );
      await onChanged();
    } catch (error) {
      toast.error(friendlyError(error, "The segment wasn't recalculated. Please try again."));
    } finally {
      setBusy("");
    }
  };

  const download = async () => {
    setBusy("export");
    try {
      await exportSegment(detail.id, detail.slug);
      toast.success("Export downloaded.");
      await onChanged();
    } catch (error) {
      toast.error(friendlyError(error, "The export didn't download. Please try again."));
    } finally {
      setBusy("");
    }
  };

  return (
    <div>
      <AdminPageHeader
        title={detail.name}
        description={detail.description || undefined}
        breadcrumbs={[ADMIN_CRUMB, CUSTOMERS_CRUMB, SEGMENTS_CRUMB, { label: detail.name }]}
        actions={
          <>
            <SegmentKindBadge kind={detail.kind} />
            <SegmentStatusBadge status={detail.status} />
            {actions.edit ? (
              <AdminButtonLink size="sm" href={editHref(detail.id)}>
                <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                Edit
              </AdminButtonLink>
            ) : null}
            {actions.recalculate ? (
              <AdminButton size="sm" onClick={() => void recalculate()} loading={busy === "recalculate"} disabled={Boolean(busy)}>
                {busy === "recalculate" ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
                Recalculate
              </AdminButton>
            ) : null}
            {actions.export ? (
              <AdminButton size="sm" onClick={() => void download()} loading={busy === "export"} disabled={Boolean(busy)}>
                {busy === "export" ? null : <Download className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
                Export CSV
              </AdminButton>
            ) : null}
            {actions.archive ? (
              <AdminButton size="sm" variant="ghost" onClick={() => setConfirmArchive(true)} disabled={Boolean(busy)}>
                <Archive className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                Archive
              </AdminButton>
            ) : null}
            {actions.restore ? (
              <AdminButton
                size="sm"
                onClick={() => void run("restore", () => restoreSegment(detail.id), `${detail.name} restored`, "The segment wasn't restored. Please try again.")}
                loading={busy === "restore"}
                disabled={Boolean(busy)}
              >
                {busy === "restore" ? null : <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
                Restore
              </AdminButton>
            ) : null}
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Members" value={detail.memberCount.toLocaleString("en-IN")} />
        <Tile label="Last calculated" value={detail.lastCalculatedAt ? formatDateTime(detail.lastCalculatedAt) : "Not yet"} />
        <Tile label="Conditions" value={String(detail.conditionCount ?? countConditions(detail.rules))} hint={`Match ${detail.match}`} />
        <Tile label="Created by" value={detail.createdBy || "—"} hint={detail.updatedBy ? `Last changed by ${detail.updatedBy}` : undefined} />
      </div>

      {active ? (
        <div className="mb-5 flex flex-wrap gap-2">
          <AdminButtonLink size="sm" variant="primary" href={`/admin/marketing/campaigns/detail?segmentId=${detail.id}`}>
            <Megaphone className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Send campaign to this segment
          </AdminButtonLink>
          <AdminButtonLink size="sm" href={`/admin/coupons?new=1&segmentId=${detail.id}`}>
            <BadgePercent className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Create coupon for this segment
          </AdminButtonLink>
        </div>
      ) : (
        <p className="mb-5 rounded-[3px] bg-admin-raised p-3 text-xs text-admin-muted">
          Archived: it isn&apos;t recalculated, and campaigns and coupons can&apos;t use it. Restore it to use it again.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <AdminCard title="Rules">
            <RulesSummary match={detail.match} rules={detail.rules} registry={registry} />
          </AdminCard>

          <AdminCard
            title="Customers in this segment"
            description={members.data?.masked ? "Contact details are masked for your role." : undefined}
            padded={false}
          >
            <div className="px-4 py-3">
              <IdFilter
                entity="customer"
                value={q}
                onChange={(next) => {
                  setQ(next);
                  setPage(1);
                }}
                className="max-w-sm"
              />
            </div>
            <MemberTable
              label="Members"
              members={members.data?.items ?? null}
              loading={members.isLoading && !members.data}
              failed={Boolean(members.error && !members.data)}
              refreshing={members.isRefreshing}
              onRetry={() => void members.reload()}
              emptyTitle={q ? `${q} is not in this segment` : "No members yet"}
              emptyHint={q ? "Remove the Customer ID filter to see every member." : "Nobody matches the rules right now. Recalculate after metrics refresh."}
            />
            {members.data && members.data.pagination.total > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-admin-border px-4 py-2.5">
                <span className="text-xs tabular-nums text-admin-muted">
                  {members.data.pagination.total.toLocaleString("en-IN")} {members.data.pagination.total === 1 ? "member" : "members"}
                </span>
                <AdminPagination page={members.data.pagination.page} totalPages={members.data.pagination.total_pages} onPageChange={setPage} />
              </div>
            ) : null}
          </AdminCard>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <RfmCard detail={detail} />
          <HistoryCard history={detail.history} />
        </div>
      </div>

      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title="Archive segment?"
        confirmLabel="Archive segment"
        loading={busy === "archive"}
        message={
          <>
            Archive <strong className="text-admin-ink">{detail.name}</strong>? It stops being recalculated, campaigns can&rsquo;t
            target it, and coupons restricted to it stop working. You can restore it later.
          </>
        }
        onConfirm={async () => {
          if (await run("archive", () => archiveSegment(detail.id), `${detail.name} archived`, "The segment wasn't archived. Please try again.")) {
            setConfirmArchive(false);
          }
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------- RFM */

const DIMENSIONS = [
  { key: "recency", label: "Recency" },
  { key: "frequency", label: "Frequency" },
  { key: "monetary", label: "Monetary" },
] as const;

function RfmCard({ detail }: { detail: SegmentDetail }) {
  const rfm = detail.rfm;
  const labels = (rfm?.labels ?? []).filter((entry) => entry.count > 0);
  return (
    <AdminCard title="RFM distribution" description="How this segment's members score on recency, frequency and spend.">
      <BarList
        data={labels.map((entry) => ({ label: entry.label || RFM_LABELS[entry.key] || entry.key, value: entry.count }))}
        emptyMessage="No members to score yet."
      />
      <div className="mt-4 grid grid-cols-3 gap-3" aria-label="Score distribution">
        {DIMENSIONS.map((dimension) => (
          <ScoreBars key={dimension.key} label={dimension.label} scores={rfm?.[dimension.key] ?? []} />
        ))}
      </div>
    </AdminCard>
  );
}

/** Five tiny columns, score 1 to 5, each as tall as its share. */
function ScoreBars({ label, scores }: { label: string; scores: RfmScoreCount[] }) {
  const counts = [1, 2, 3, 4, 5].map((score) => scores.find((entry) => entry.score === score)?.count ?? 0);
  const max = Math.max(...counts, 1);
  return (
    <figure className="min-w-0">
      <figcaption className="mb-1 text-[0.6875rem] font-medium text-admin-muted">{label}</figcaption>
      <ul className="flex h-14 items-end gap-1" aria-label={`${label} scores`}>
        {counts.map((count, index) => (
          <li
            key={index}
            className="flex h-full flex-1 flex-col justify-end"
            aria-label={`${label} ${index + 1}: ${count}`}
            title={`Score ${index + 1}: ${count}`}
          >
            <span
              className={count ? "block w-full rounded-t-[2px]" : "block w-full rounded-t-[2px] bg-admin-border"}
              style={{
                height: `${Math.max((count / max) * 100, count ? 6 : 2)}%`,
                ...(count ? { backgroundColor: "var(--color-chart-1)" } : {}),
              }}
            />
          </li>
        ))}
      </ul>
      <div className="mt-0.5 flex gap-1 text-center text-[0.625rem] tabular-nums text-admin-faint" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((score) => (
          <span key={score} className="flex-1">
            {score}
          </span>
        ))}
      </div>
    </figure>
  );
}

/* ---------------------------------------------------------------- history */

/** "40 → 42", "120 rows", "3 → 4 conditions" — the change an event made. */
export function historyDetail(entry: SegmentHistoryEntry): string {
  const details = entry.details ?? {};
  const before = details.before;
  const after = details.after;
  if (typeof before === "number" && typeof after === "number") {
    return `${before.toLocaleString("en-IN")} → ${after.toLocaleString("en-IN")} members`;
  }
  if (Array.isArray(before) || Array.isArray(after)) {
    return `${countConditions(before)} → ${countConditions(after)} conditions`;
  }
  if (typeof details.rows === "number") return `${details.rows.toLocaleString("en-IN")} ${details.rows === 1 ? "row" : "rows"}`;
  if (before && after && typeof before === "object" && typeof after === "object") {
    const changed = Object.keys(after as Record<string, unknown>).filter(
      (key) => (before as Record<string, unknown>)[key] !== (after as Record<string, unknown>)[key],
    );
    return changed.length ? `Changed ${changed.join(", ")}` : "";
  }
  return "";
}

function HistoryCard({ history }: { history: SegmentHistoryEntry[] }) {
  return (
    <AdminCard title="History">
      {history.length === 0 ? (
        <p className="text-xs text-admin-muted">Nothing has happened yet.</p>
      ) : (
        <ol className="relative flex flex-col gap-3 border-l border-admin-border pl-4" aria-label="History">
          {history.map((entry) => {
            const change = historyDetail(entry);
            return (
              <li key={entry.id} className="relative text-xs">
                <span className="absolute -left-[1.3rem] top-1 h-2 w-2 rounded-full bg-copper-600 ring-2 ring-admin-surface" aria-hidden="true" />
                <p className="font-medium text-admin-ink">
                  {entry.label}
                  {change ? <span className="ml-1.5 font-normal tabular-nums text-admin-muted">{change}</span> : null}
                </p>
                <p className="text-admin-muted">
                  {entry.actorName || (entry.actor === "system" ? "System" : entry.actor)} · {formatDateTime(entry.at)}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </AdminCard>
  );
}
