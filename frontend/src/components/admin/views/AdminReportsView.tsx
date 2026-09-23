"use client";

import { useState } from "react";

import type { AnalyticsRange } from "@/types/admin";

import { BarList } from "@/components/admin/charts/BarList";
import { TimeSeriesChart } from "@/components/admin/charts/TimeSeriesChart";
import { AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
import { formatCompactINR, formatPrice, humanize } from "@/lib/utils/format";
import { RANGES, getAnalytics, rangeLabel } from "@/services/admin/analyticsAdminService";

/**
 * Reports.
 *
 * Deliberately the same data the dashboard shows, presented for reading rather
 * than glancing: the headline numbers sit above tables you can actually read
 * values off, which is also what discharges the palette's contrast caveat —
 * nothing here depends on distinguishing two hues.
 */
export function AdminReportsView() {
  const [range, setRange] = useState<AnalyticsRange>("30d");
  const { data, isLoading } = useAdminResource(() => getAnalytics(range), [range]);

  const summary = [
    { label: "Revenue", value: data ? formatPrice(data.revenue) : "—", delta: data?.revenueDelta },
    { label: "Orders", value: data ? data.orders.toLocaleString("en-IN") : "—", delta: data?.ordersDelta },
    { label: "Average order value", value: data ? formatPrice(data.averageOrderValue) : "—" },
    { label: "Units sold", value: data ? data.unitsSold.toLocaleString("en-IN") : "—" },
    { label: "Customers who ordered", value: data ? data.customers.toLocaleString("en-IN") : "—" },
  ];

  return (
    <div>
      <AdminPageHeader
        title="Reports"
        description={`Sales, orders, products and customers for ${rangeLabel(range).toLowerCase()}.`}
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Reports" }]}
        actions={
          <div
            role="group"
            aria-label="Reporting period"
            className="flex overflow-hidden rounded-[3px] border border-admin-border"
          >
            {RANGES.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setRange(option.value)}
                aria-pressed={range === option.value}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium transition-colors",
                  range === option.value
                    ? "bg-admin-ink text-white"
                    : "bg-admin-surface text-admin-muted hover:bg-admin-raised",
                )}
              >
                {option.shortLabel}
              </button>
            ))}
          </div>
        }
      />

      {/* --------------------------------------------------------- summary */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {summary.map((entry) => (
          <div
            key={entry.label}
            className="rounded-[3px] border border-admin-border bg-admin-surface p-4"
          >
            <p className="text-[0.625rem] font-medium uppercase tracking-[0.1em] text-admin-muted">
              {entry.label}
            </p>
            <p className="mt-2 text-lg font-semibold text-admin-ink tabular-nums">{entry.value}</p>
            {typeof entry.delta === "number" ? (
              <p
                className={cn(
                  "mt-1 text-[0.6875rem] tabular-nums",
                  entry.delta >= 0 ? "text-[#0a6b0a]" : "text-[#a32424]",
                )}
              >
                {entry.delta >= 0 ? "▲ +" : "▼ "}
                {entry.delta}% vs previous period
              </p>
            ) : null}
          </div>
        ))}
      </div>

      {/* ------------------------------------------------------ sales report */}
      <AdminCard
        title="Sales report"
        description="Revenue and orders plotted separately — they share no scale."
        className="mt-4"
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <p className="mb-3 text-xs font-medium text-admin-ink">Revenue over time</p>
            {data ? (
              <TimeSeriesChart points={data.series} metric="revenue" height={240} />
            ) : (
              <div className="h-[240px] animate-pulse rounded-[3px] bg-admin-raised" />
            )}
          </div>
          <div>
            <p className="mb-3 text-xs font-medium text-admin-ink">Orders over time</p>
            {data ? (
              <TimeSeriesChart points={data.series} metric="orders" height={240} />
            ) : (
              <div className="h-[240px] animate-pulse rounded-[3px] bg-admin-raised" />
            )}
          </div>
        </div>
      </AdminCard>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {/* -------------------------------------------- products report */}
        <AdminCard title="Products report" description="Best performers by revenue.">
          {isLoading || !data ? (
            <div className="h-48 animate-pulse rounded-[3px] bg-admin-raised" />
          ) : data.topProducts.length === 0 ? (
            <p className="py-8 text-center text-xs text-admin-muted">
              No sales in this period.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[26rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-admin-border">
                    <th scope="col" className="pb-2 text-left label-wide font-medium text-admin-muted">
                      Product
                    </th>
                    <th scope="col" className="pb-2 text-right label-wide font-medium text-admin-muted">
                      Units
                    </th>
                    <th scope="col" className="pb-2 text-right label-wide font-medium text-admin-muted">
                      Revenue
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.topProducts.map((product) => (
                    <tr key={product.productId} className="border-b border-admin-border last:border-0">
                      <td className="py-2 text-xs text-admin-ink">
                        {product.name}
                        <span className="block text-[0.625rem] text-admin-faint">
                          {humanize(product.category)}
                        </span>
                      </td>
                      <td className="py-2 text-right text-xs tabular-nums">{product.unitsSold}</td>
                      <td className="py-2 text-right text-xs font-medium tabular-nums">
                        {formatPrice(product.revenue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AdminCard>

        {/* ------------------------------------------- category breakdown */}
        <AdminCard title="Revenue by category" description="Where the money came from.">
          <BarList
            data={(data?.byCategory ?? []).map((entry) => ({
              label: humanize(entry.category),
              value: entry.revenue,
              meta: `${entry.units} units`,
            }))}
            scale="nominal"
            valueFormat={formatCompactINR}
          />
        </AdminCard>

        {/* --------------------------------------------- orders breakdown */}
        <AdminCard title="Orders report" description="Where orders sit in the funnel.">
          <BarList
            data={(data?.byStatus ?? []).map((entry) => ({
              label: humanize(entry.status),
              value: entry.count,
            }))}
            scale="ordinal"
          />
        </AdminCard>

        {/* ------------------------------------------- customers report */}
        <AdminCard title="Customers report" description="Buying activity in this period.">
          {isLoading || !data ? (
            <div className="h-32 animate-pulse rounded-[3px] bg-admin-raised" />
          ) : (
            <dl className="flex flex-col gap-3">
              {[
                ["Customers who ordered", data.customers.toLocaleString("en-IN")],
                ["Orders per customer", data.customers > 0 ? (data.orders / data.customers).toFixed(1) : "0"],
                ["Revenue per customer", data.customers > 0 ? formatPrice(Math.round(data.revenue / data.customers)) : "₹0"],
                ["Units per order", data.orders > 0 ? (data.unitsSold / data.orders).toFixed(1) : "0"],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="flex items-baseline justify-between gap-4 border-b border-admin-border pb-2.5 last:border-0 last:pb-0"
                >
                  <dt className="text-xs text-admin-muted">{label}</dt>
                  <dd className="text-sm font-medium text-admin-ink tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </AdminCard>
      </div>

      <p className="mt-4 rounded-[3px] border border-admin-border bg-admin-surface px-3 py-2.5 text-[0.6875rem] leading-relaxed text-admin-muted">
        Figures are aggregated from the demo order history and exclude cancelled orders. Once a
        backend exists these come from <code>GET /admin/analytics</code> with the same shape, so
        this page will not change.
      </p>
    </div>
  );
}
