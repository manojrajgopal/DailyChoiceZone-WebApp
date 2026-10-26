"use client";

import Link from "next/link";
import { RefreshCw } from "lucide-react";

import { AdminButton, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { FilterSelect, useUrlFilters } from "@/components/admin/ui/LogPage";
import { StatusBadge } from "@/components/admin/ui/StatusBadge";
import { TD, TH, Tile } from "@/components/admin/views/operations/shared";
import { Bar, CRUMBS, RequestBadge, TryOnTabs, seconds } from "@/components/admin/views/tryon/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDateTime } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import { type Breakdown, type RequestBrief, getOverview, listModels, listProviders } from "@/services/admin/tryOnAdminService";

const KEYS = ["from", "to", "providerId", "modelId", "status", "granularity", "customerId", "planId", "capability", "credentialId", "categoryId"] as const;

/**
 * Virtual try-on at a glance: every number counted from recorded requests,
 * attempts and credentials, filterable by date, provider, model and status.
 */
export function AdminTryOnOverviewView() {
  const { filters, setFilters, clear } = useUrlFilters(KEYS);
  const overview = useAdminResource(() => getOverview({ ...filters, granularity: filters.granularity || "day" }), [filters]);
  const providers = useAdminResource(listProviders, []);
  const models = useAdminResource(listModels, []);
  const data = overview.data;
  const t = data?.totals;
  const filtered = Object.values(filters).some(Boolean);

  return (
    <div>
      <AdminPageHeader
        title="Virtual try-on"
        description="Requests, results, failures and the AI providers behind them."
        breadcrumbs={[CRUMBS[0]!, { label: "Virtual try-on" }]}
        actions={
          <AdminButton size="sm" onClick={() => void overview.reload()} loading={overview.isRefreshing}>
            {overview.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />} Refresh
          </AdminButton>
        }
      />
      <TryOnTabs />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-admin-muted">
          From
          <input type="date" value={filters.from} onChange={(e) => setFilters({ from: e.target.value })}
            className="h-9 rounded-[3px] border border-admin-border bg-admin-surface px-2 text-xs text-admin-ink" />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-admin-muted">
          To
          <input type="date" value={filters.to} onChange={(e) => setFilters({ to: e.target.value })}
            className="h-9 rounded-[3px] border border-admin-border bg-admin-surface px-2 text-xs text-admin-ink" />
        </label>
        <FilterSelect label="Provider" value={filters.providerId} onChange={(providerId) => setFilters({ providerId })}
          options={[{ value: "", label: "All providers" }, ...(providers.data ?? []).map((p) => ({ value: p.id, label: p.name }))]} />
        <FilterSelect label="Model" value={filters.modelId} onChange={(modelId) => setFilters({ modelId })}
          options={[{ value: "", label: "All models" }, ...(models.data ?? []).map((m) => ({ value: m.id, label: m.name }))]} />
        <FilterSelect label="Status" value={filters.status} onChange={(status) => setFilters({ status })}
          options={[{ value: "", label: "Any status" }, { value: "succeeded", label: "Success" }, { value: "failed", label: "Failed" },
            { value: "active", label: "In progress" }, { value: "cancelled", label: "Cancelled" }, { value: "expired", label: "Expired" }]} />
        <FilterSelect label="Trend by" value={filters.granularity || "day"} onChange={(granularity) => setFilters({ granularity })}
          options={[{ value: "day", label: "Daily (30 days)" }, { value: "week", label: "Weekly (12 weeks)" }, { value: "month", label: "Monthly (12 months)" }]} />
        {filtered ? <AdminButton size="sm" variant="ghost" onClick={clear}>Clear filters</AdminButton> : null}
      </div>

      {overview.error && !data ? (
        <AdminCard><p className="text-sm text-admin-ink">The dashboard didn&rsquo;t load.</p>
          <AdminButton size="sm" className="mt-3" onClick={() => void overview.reload()}>Try again</AdminButton></AdminCard>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <Tile label="Requests" value={t ? String(t.requests) : null} />
            <Tile label="Successful" value={t ? String(t.succeeded) : null} tone="good" />
            <Tile label="Failed" value={t ? String(t.failed) : null} tone={t?.failed ? "bad" : undefined} />
            <Tile label="Success rate" value={t ? `${t.successRate}%` : null} hint={t ? `${t.failureRate}% failed` : undefined} />
            <Tile label="In progress" value={t ? String(t.inProgress) : null} />
            <Tile label="Queued" value={t ? String(t.queued) : null} tone={t && t.queued > 10 ? "warn" : undefined} />
            <Tile label="Average time" value={t ? (t.averageSeconds === null ? "—" : `${t.averageSeconds}s`) : null} />
            <Tile label="Estimated cost" value={t ? (t.estimatedCost === null ? "—" : `${t.costCurrency} ${t.estimatedCost}`) : null}
              hint={t && t.estimatedCost === null ? "Set a cost per call on a model" : undefined} />
          </div>

          <div className="mb-5 grid gap-4 lg:grid-cols-3">
            <AdminCard title="Providers" description={data ? `${data.providers.active} active, ${data.providers.inactive} inactive` : undefined}>
              <ul className="space-y-2 text-xs">
                {data?.providers.items.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2">
                    <span><span className="font-medium text-admin-ink">{p.name}</span>
                      <span className="block text-admin-muted">{p.enabledModels} of {p.models} models in use{p.healthDetail ? ` · ${p.healthDetail}` : ""}</span></span>
                    <StatusBadge tone={!p.enabled ? "neutral" : p.health === "healthy" ? "good" : p.health === "degraded" ? "warning" : p.health === "down" ? "critical" : "neutral"}>
                      {!p.enabled ? "Inactive" : p.health === "unknown" ? "Not checked" : p.health}
                    </StatusBadge>
                  </li>
                ))}
              </ul>
            </AdminCard>
            <AdminCard title="Credentials" action={<Link href="/admin/try-on/credentials" className="text-xs text-copper-700 hover:underline">Manage</Link>}>
              {data ? (
                <dl className="grid grid-cols-3 gap-2 text-xs">
                  {([["Configured", data.credentials.total], ["Healthy", data.credentials.healthy], ["Not checked", data.credentials.unvalidated],
                    ["Disabled", data.credentials.disabled], ["Hidden", data.credentials.hidden], ["Invalid", data.credentials.invalid],
                    ["Rate limited", data.credentials.rate_limited], ["Failing", data.credentials.unhealthy], ["Dedicated", data.credentials.dedicated]] as const).map(([label, value]) => (
                    <div key={label}><dt className="text-admin-muted">{label}</dt><dd className="text-sm font-semibold tabular-nums text-admin-ink">{value}</dd></div>
                  ))}
                </dl>
              ) : null}
            </AdminCard>
            <AdminCard title="Storage">
              {data ? (
                <div className="space-y-1 text-xs text-admin-muted">
                  <p><span className="font-medium text-admin-ink">{data.storage.active === "s3" ? "Private S3 bucket" : data.storage.active === "ephemeral" ? "Ephemeral (nothing kept)" : "Unavailable"}</span></p>
                  {data.storage.active === "ephemeral" ? <p>Results last {data.storage.ephemeralTtlMinutes} minutes. Configure S3 to keep them.</p> : null}
                  {data.storage.s3Problem && data.storage.configured !== "ephemeral" ? <p>{data.storage.s3Problem}</p> : null}
                  {data.pendingCleanup ? <p className="text-[#8a5a12]">{data.pendingCleanup} deletions waiting to be confirmed.</p> : <p>No deletions pending.</p>}
                </div>
              ) : null}
            </AdminCard>
          </div>

          <AdminCard title="Trend" className="mb-5">
            <Trend points={data?.trend.points ?? []} />
          </AdminCard>

          <div className="mb-5 grid gap-4 lg:grid-cols-2">
            <BreakdownCard title="By model" rows={data?.byModel} showCost />
            <BreakdownCard title="By kind of item" rows={data?.byCapability} />
            <BreakdownCard title="By category" rows={data?.byCategory} />
            <BreakdownCard title="By plan" rows={data?.byPlan} />
            <BreakdownCard title="By provider" rows={data?.byProvider} />
            <BreakdownCard title="Top customers" rows={data?.byCustomer} link={(key) => `/admin/customers/detail?id=${encodeURIComponent(key)}`} />
          </div>

          <div className="mb-5 grid gap-4 lg:grid-cols-2">
            <AdminCard title="Why requests failed" padded={false}>
              <table className="w-full text-left text-xs">
                <thead className="border-b border-admin-border bg-admin-raised text-admin-muted"><tr><th className={TH}>Reason</th><th className={cn(TH, "text-right")}>Requests</th></tr></thead>
                <tbody className="divide-y divide-admin-border">
                  {data?.byError.length ? data.byError.map((row) => (
                    <tr key={row.key}><td className={TD}><RequestBadge status="failed" badge={row.badge} /><span className="mt-1 block text-admin-muted">{row.label}</span></td>
                      <td className={cn(TD, "text-right tabular-nums")}><Link href={`/admin/try-on/requests?status=failed&errorCode=${row.key}`} className="hover:text-copper-700">{row.requests}</Link></td></tr>
                  )) : <tr><td className={TD} colSpan={2}><span className="text-admin-muted">No failures in this period.</span></td></tr>}
                </tbody>
              </table>
            </AdminCard>
            <AdminCard title="Credential usage" padded={false}>
              <table className="w-full text-left text-xs">
                <thead className="border-b border-admin-border bg-admin-raised text-admin-muted"><tr><th className={TH}>Credential</th><th className={cn(TH, "text-right")}>Calls</th><th className={cn(TH, "text-right")}>Failed</th><th className={TH}>Last used</th></tr></thead>
                <tbody className="divide-y divide-admin-border">
                  {data?.byCredential.length ? data.byCredential.map((row) => (
                    <tr key={row.key || "none"}><td className={TD}>{row.label}<span className="block text-admin-muted">{row.provider}</span></td>
                      <td className={cn(TD, "text-right tabular-nums")}>{row.attempts}</td><td className={cn(TD, "text-right tabular-nums")}>{row.failed}</td>
                      <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>{formatDateTime(row.lastUsedAt)}</td></tr>
                  )) : <tr><td className={TD} colSpan={4}><span className="text-admin-muted">No calls yet.</span></td></tr>}
                </tbody>
              </table>
            </AdminCard>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <RecentCard title="Recent successful" rows={data?.recentSucceeded} />
            <RecentCard title="Recent failures" rows={data?.recentFailed} />
          </div>
        </>
      )}
    </div>
  );
}

function BreakdownCard({ title, rows, showCost, link }: { title: string; rows?: Breakdown[]; showCost?: boolean; link?: (key: string) => string }) {
  const max = Math.max(1, ...(rows ?? []).map((r) => r.requests));
  return (
    <AdminCard title={title}>
      {!rows ? <span className="block h-16 animate-pulse rounded-[2px] bg-admin-raised" /> : rows.length === 0 ? (
        <p className="text-xs text-admin-muted">Nothing yet.</p>
      ) : (
        <ul className="space-y-2.5 text-xs">
          {rows.map((row) => (
            <li key={row.key || "none"}>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="truncate text-admin-ink">{link && row.key ? <Link href={link(row.key)} className="hover:text-copper-700">{row.label}</Link> : row.label}</span>
                <span className="whitespace-nowrap tabular-nums text-admin-muted">
                  {row.requests} · {row.successRate}% ok{showCost && row.cost !== undefined ? ` · ${row.cost}` : ""}
                </span>
              </div>
              <Bar value={row.requests} max={max} />
            </li>
          ))}
        </ul>
      )}
    </AdminCard>
  );
}

function Trend({ points }: { points: { period: string; requests: number; succeeded: number; failed: number }[] }) {
  if (!points.length) return <p className="text-xs text-admin-muted">No requests in this period.</p>;
  const max = Math.max(1, ...points.map((p) => p.requests));
  return (
    <div>
      <div className="flex h-36 items-end gap-1" role="img" aria-label={`Requests per period: ${points.map((p) => `${p.period} ${p.requests}`).join(", ")}`}>
        {points.map((p) => (
          <div key={p.period} className="flex h-full flex-1 flex-col justify-end" title={`${p.period}: ${p.requests} requests, ${p.succeeded} successful, ${p.failed} failed`}>
            <div className="w-full rounded-t-[2px] bg-[#d03b3b]" style={{ height: `${(p.failed / max) * 100}%` }} />
            <div className="w-full bg-copper-500" style={{ height: `${(p.succeeded / max) * 100}%` }} />
            <div className="w-full bg-admin-border-strong" style={{ height: `${(Math.max(0, p.requests - p.succeeded - p.failed) / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[0.625rem] text-admin-muted"><span>{points[0]!.period}</span><span>{points[points.length - 1]!.period}</span></div>
      <p className="mt-2 flex gap-4 text-[0.6875rem] text-admin-muted">
        <span className="flex items-center gap-1"><span className="h-2 w-2 bg-copper-500" /> Successful</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 bg-[#d03b3b]" /> Failed</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 bg-admin-border-strong" /> Other</span>
      </p>
    </div>
  );
}

function RecentCard({ title, rows }: { title: string; rows?: RequestBrief[] }) {
  return (
    <AdminCard title={title} padded={false} action={<Link href="/admin/try-on/requests" className="text-xs text-copper-700 hover:underline">View all</Link>}>
      <table className="w-full text-left text-xs">
        <tbody className="divide-y divide-admin-border">
          {!rows ? null : rows.length === 0 ? (
            <tr><td className={TD}><span className="text-admin-muted">None yet.</span></td></tr>
          ) : rows.map((row) => (
            <tr key={row.id} className="hover:bg-admin-raised">
              <td className={TD}><Link href={`/admin/try-on/requests/detail?id=${row.id}`} className="font-medium text-admin-ink hover:text-copper-700">{row.id}</Link>
                <span className="block text-admin-muted">{row.productName} · {row.capability}</span></td>
              <td className={TD}><RequestBadge status={row.status} badge={row.badge} />{row.error ? <span className="mt-1 block text-admin-muted">{row.error}</span> : null}</td>
              <td className={cn(TD, "whitespace-nowrap text-right text-admin-muted")}>{formatDateTime(row.createdAt)}<span className="block">{seconds(row.durationMs)}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </AdminCard>
  );
}
