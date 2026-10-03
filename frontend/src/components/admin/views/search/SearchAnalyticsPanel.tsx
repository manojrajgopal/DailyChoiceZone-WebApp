"use client";

import { TimeSeriesChart } from "@/components/admin/charts/TimeSeriesChart";
import { AdminCard } from "@/components/admin/ui/AdminChrome";
import { StatusTabs } from "@/components/admin/ui/LogPage";
import { TD, TH, TableState, Tile } from "@/components/admin/views/operations/shared";
import { LoadFailed } from "@/components/admin/views/suppliers/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";
import { getSearchAnalytics } from "@/services/admin/searchAdminService";
import type { SearchAnalytics, SearchRange } from "@/types/searchAdmin";

import { NoAccess, count, isForbidden, percent } from "./shared";

const RANGES: { value: SearchRange; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

function toRange(value: string): SearchRange {
  return value === "7d" || value === "90d" ? value : "30d";
}

export function SearchAnalyticsPanel({ range: rawRange, onRange }: { range: string; onRange: (range: SearchRange) => void }) {
  const range = toRange(rawRange);
  const report = useAdminResource(() => getSearchAnalytics(range), [range]);
  const data = report.data;

  if (isForbidden(report.error)) return <NoAccess permission="search" />;

  return (
    <div className={cn("flex flex-col gap-4", report.isRefreshing && "opacity-70")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StatusTabs
          label="Date range"
          value={range}
          onChange={(next) => onRange(toRange(next))}
          tabs={RANGES}
        />
        {data ? (
          <p className="mb-3 text-xs text-admin-muted">
            {formatDate(data.from)} – {formatDate(data.to)}
          </p>
        ) : null}
      </div>

      {report.error && !data ? (
        <LoadFailed message="The search analytics didn't load." onRetry={() => void report.reload()} />
      ) : (
        <>
          <Totals data={data} />
          <div className="grid gap-4 lg:grid-cols-2">
            <AdminCard title="Searches per day">
              {data ? (
                <TimeSeriesChart
                  metric="orders"
                  seriesName="Searches"
                  points={data.series.map((point) => ({ label: point.date, revenue: 0, orders: point.searches }))}
                />
              ) : (
                <span className="block h-[220px] animate-pulse rounded-[2px] bg-admin-border/60" />
              )}
            </AdminCard>
            <AdminCard title="Searches with no results per day">
              {data ? (
                <TimeSeriesChart
                  metric="orders"
                  seriesName="Searches with no results"
                  points={data.series.map((point) => ({ label: point.date, revenue: 0, orders: point.zeroResults }))}
                />
              ) : (
                <span className="block h-[220px] animate-pulse rounded-[2px] bg-admin-border/60" />
              )}
            </AdminCard>
          </div>
          <TopSearches data={data} loading={report.isLoading} />
          <div className="grid gap-4 lg:grid-cols-2">
            <ZeroResults data={data} loading={report.isLoading} />
            <Trending data={data} loading={report.isLoading} />
          </div>
        </>
      )}
    </div>
  );
}

function Totals({ data }: { data: SearchAnalytics | null }) {
  const totals = data?.totals;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <Tile label="Searches" value={totals ? count(totals.searches) : null} />
      <Tile label="Unique terms" value={totals ? count(totals.uniqueTerms) : null} />
      <Tile
        label="No results"
        value={totals ? percent(totals.zeroResultRate) : null}
        hint={totals ? `${count(totals.zeroResultSearches)} searches` : undefined}
        tone={totals && totals.zeroResultRate >= 20 ? "warn" : undefined}
      />
      <Tile
        label="Click-through"
        value={totals ? percent(totals.ctr) : null}
        hint={totals ? `${count(totals.clicks)} clicks` : undefined}
      />
      <Tile
        label="Conversion"
        value={totals ? percent(totals.conversionRate) : null}
        hint={totals ? `${count(totals.conversions)} orders` : undefined}
      />
    </div>
  );
}

function TopSearches({ data, loading }: { data: SearchAnalytics | null; loading: boolean }) {
  const rows = data?.topSearches ?? [];
  return (
    <AdminCard title="Top searches" description="The most searched terms, with how often a result was opened." padded={false}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-left text-xs">
          <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
            <tr>
              <th className={TH}>Term</th>
              <th className={cn(TH, "text-right")}>Searches</th>
              <th className={cn(TH, "text-right")}>Clicks</th>
              <th className={cn(TH, "text-right")}>CTR</th>
              <th className={cn(TH, "text-right")}>Orders</th>
              <th className={cn(TH, "text-right")}>Avg. results</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-admin-border">
            <TableState
              columns={6}
              loading={loading && !data}
              failed={false}
              empty={Boolean(data && rows.length === 0)}
              onRetry={() => undefined}
              title="No searches yet"
              hint="Searches made on the storefront in this period show here."
            />
            {rows.map((row) => (
              <tr key={row.term}>
                <td className={cn(TD, "font-medium text-admin-ink")}>{row.term}</td>
                <td className={cn(TD, "text-right tabular-nums")}>{count(row.searches)}</td>
                <td className={cn(TD, "text-right tabular-nums")}>{count(row.clicks)}</td>
                <td className={cn(TD, "text-right tabular-nums")}>{percent(row.ctr)}</td>
                <td className={cn(TD, "text-right tabular-nums")}>{count(row.conversions)}</td>
                <td className={cn(TD, "text-right tabular-nums text-admin-muted")}>
                  {row.avgResults.toLocaleString("en-IN", { maximumFractionDigits: 1 })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminCard>
  );
}

function ZeroResults({ data, loading }: { data: SearchAnalytics | null; loading: boolean }) {
  const rows = data?.zeroResults ?? [];
  return (
    <AdminCard
      title="Searches with no results"
      description="Worth a synonym, a product, or better product names."
      padded={false}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
            <tr>
              <th className={TH}>Term</th>
              <th className={cn(TH, "text-right")}>Searches</th>
              <th className={TH}>Last searched</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-admin-border">
            <TableState
              columns={3}
              loading={loading && !data}
              failed={false}
              empty={Boolean(data && rows.length === 0)}
              onRetry={() => undefined}
              title="Every search found something"
              hint="Searches that find nothing show here."
            />
            {rows.map((row) => (
              <tr key={row.term}>
                <td className={cn(TD, "font-medium text-admin-ink")}>{row.term}</td>
                <td className={cn(TD, "text-right tabular-nums")}>{count(row.searches)}</td>
                <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>
                  {row.lastSearchedAt ? formatDate(row.lastSearchedAt) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminCard>
  );
}

function Trending({ data, loading }: { data: SearchAnalytics | null; loading: boolean }) {
  const rows = data?.trending ?? [];
  return (
    <AdminCard title="Trending" description="Searched more than in the period before." padded={false}>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
            <tr>
              <th className={TH}>Term</th>
              <th className={cn(TH, "text-right")}>Searches</th>
              <th className={cn(TH, "text-right")}>Before</th>
              <th className={cn(TH, "text-right")}>Change</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-admin-border">
            <TableState
              columns={4}
              loading={loading && !data}
              failed={false}
              empty={Boolean(data && rows.length === 0)}
              onRetry={() => undefined}
              title="Nothing trending"
              hint="Terms searched at least three times, and more than before, show here."
            />
            {rows.map((row) => (
              <tr key={row.term}>
                <td className={cn(TD, "font-medium text-admin-ink")}>{row.term}</td>
                <td className={cn(TD, "text-right tabular-nums")}>{count(row.searches)}</td>
                <td className={cn(TD, "text-right tabular-nums text-admin-muted")}>{count(row.previous)}</td>
                <td className={cn(TD, "text-right tabular-nums text-[#0a6b0a]")}>
                  {row.change === null ? "New" : `+${percent(row.change)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminCard>
  );
}
