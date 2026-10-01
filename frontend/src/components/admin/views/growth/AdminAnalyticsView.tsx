"use client";

import { useState } from "react";
import { Download, RefreshCw } from "lucide-react";

import { BarList } from "@/components/admin/charts/BarList";
import { TimeSeriesChart } from "@/components/admin/charts/TimeSeriesChart";
import { AdminButton, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect } from "@/components/admin/ui/AdminForm";
import { StatusTabs, useUrlFilters } from "@/components/admin/ui/LogPage";
import { rupees } from "@/components/admin/views/growth/shared";
import { TD, TH, Tile, problem } from "@/components/admin/views/operations/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
import {
  type AnalyticsParams,
  type AnalyticsSection,
  type CustomersReport,
  type FunnelReport,
  type MarketingReport,
  type Metric,
  type ProductsReport,
  type SalesReport,
  exportAnalytics,
  getAnalytics,
} from "@/services/admin/growthAdminService";
import { toast } from "@/store/toastStore";

const RANGES = [
  { value: "today", label: "Today" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" }, { value: "12m", label: "12 months" }, { value: "ytd", label: "Year to date" },
  { value: "custom", label: "Custom" },
];
const SECTIONS: { value: AnalyticsSection; label: string }[] = [
  { value: "sales", label: "Sales" }, { value: "customers", label: "Customers" }, { value: "products", label: "Products" },
  { value: "marketing", label: "Marketing" }, { value: "funnel", label: "Conversion funnel" },
];
const KEYS = ["section", "range", "start", "end", "compare", "unit"] as const;

function format(metric: Metric | number, kind?: Metric["format"]): string {
  const value = typeof metric === "number" ? metric : metric.value;
  const f = typeof metric === "number" ? kind : metric.format;
  if (f === "currency") return rupees(Math.round(value * 100) / 100);
  if (f === "percent") return `${value}%`;
  if (f === "decimal") return value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return value.toLocaleString("en-IN");
}

function DeltaTile({ label, metric, invert = false }: { label: string; metric?: Metric; invert?: boolean }) {
  if (!metric) return <Tile label={label} value={null} />;
  const { delta, isNew, previous } = metric;
  const hint = metric.previous === null ? undefined
    : isNew ? "New — nothing in the period before"
    : delta === null ? "No change to compare"
    : `${delta > 0 ? "▲" : delta < 0 ? "▼" : "■"} ${Math.abs(delta)}% vs ${format(previous ?? 0, metric.format)}`;
  const good = delta !== null && delta !== 0 ? (delta > 0) !== invert : null;
  return <Tile label={label} value={format(metric)} hint={hint} tone={good === null ? undefined : good ? "good" : "bad"} />;
}

/**
 * Advanced analytics. Every number is worked out by the server from the order,
 * customer and event records for the chosen period; nothing is estimated.
 */
export function AdminAnalyticsView() {
  const { filters, setFilters } = useUrlFilters(KEYS);
  const section = (filters.section || "sales") as AnalyticsSection;
  const params: AnalyticsParams = {
    range: filters.range || "30d",
    start: filters.range === "custom" ? filters.start : undefined,
    end: filters.range === "custom" ? filters.end : undefined,
    compare: (filters.compare || "previous") as AnalyticsParams["compare"],
    unit: (filters.unit || "auto") as AnalyticsParams["unit"],
  };
  const customIncomplete = params.range === "custom" && !(params.start && params.end);
  const report = useAdminResource(() => getAnalytics(section, params), [section, JSON.stringify(params)], { enabled: !customIncomplete });
  const [exporting, setExporting] = useState("");

  const download = async (kind: string) => {
    setExporting(kind);
    try {
      await exportAnalytics(kind, params);
    } catch (error) {
      toast.error(problem(error, "The export didn't work."));
    } finally {
      setExporting("");
    }
  };

  const ExportButton = ({ kind, label = "CSV" }: { kind: string; label?: string }) => (
    <AdminButton size="sm" variant="ghost" loading={exporting === kind} onClick={() => void download(kind)}>
      {exporting === kind ? null : <Download className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />} {label}
    </AdminButton>
  );

  const data = report.data;

  return (
    <div>
      <AdminPageHeader
        title="Analytics"
        description={data ? `${data.period.label}${data.comparison ? `, compared with ${data.comparison.label.toLowerCase()}` : ""}. Days run midnight to midnight, India time.` : "Sales, customers, products, marketing and the conversion funnel."}
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Analytics" }]}
        actions={
          <AdminButton size="sm" onClick={() => void report.reload()} loading={report.isRefreshing}>
            {report.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />} Refresh
          </AdminButton>
        }
      />

      <AdminCard className="mb-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <AdminSelect label="Period" value={params.range} onChange={(e) => setFilters({ range: e.target.value })} options={RANGES} />
          {params.range === "custom" ? (
            <>
              <AdminInput label="From" type="date" value={filters.start} onChange={(e) => setFilters({ start: e.target.value })} />
              <AdminInput label="To" type="date" value={filters.end} onChange={(e) => setFilters({ end: e.target.value })} />
            </>
          ) : null}
          <AdminSelect label="Compare with" value={params.compare} onChange={(e) => setFilters({ compare: e.target.value })}
            options={[{ value: "previous", label: "The period before" }, { value: "year", label: "Same period last year" }, { value: "none", label: "Nothing" }]} />
          <AdminSelect label="Group by" value={params.unit} onChange={(e) => setFilters({ unit: e.target.value })}
            options={[{ value: "auto", label: "Automatic" }, { value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "month", label: "Month" }]} />
        </div>
      </AdminCard>

      <StatusTabs label="Report" value={section} onChange={(value) => setFilters({ section: value })} tabs={SECTIONS} />

      {customIncomplete ? <p className="py-10 text-center text-sm text-admin-muted">Choose both dates.</p>
        : report.error && !data ? (
          <div className="py-10 text-center">
            <p className="text-sm text-admin-ink">{problem(report.error, "This report didn't load.")}</p>
            <AdminButton size="sm" className="mt-3" onClick={() => void report.reload()}>Try again</AdminButton>
          </div>
        ) : !data || data.section !== section ? <p className="py-10 text-center text-sm text-admin-muted">Working it out…</p>
        : (
          <div className={cn(report.isRefreshing && "opacity-60")}>
            {section === "sales" ? <Sales data={data as SalesReport} ExportButton={ExportButton} /> : null}
            {section === "customers" ? <Customers data={data as CustomersReport} ExportButton={ExportButton} /> : null}
            {section === "products" ? <Products data={data as ProductsReport} ExportButton={ExportButton} /> : null}
            {section === "marketing" ? <Marketing data={data as MarketingReport} ExportButton={ExportButton} /> : null}
            {section === "funnel" ? <Funnel data={data as FunnelReport} ExportButton={ExportButton} /> : null}
          </div>
        )}
    </div>
  );
}

type Exporter = (props: { kind: string; label?: string }) => React.ReactElement;

function Card({ title, actions, children, className }: { title: string; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <AdminCard className={className}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-admin-ink">{title}</h2>
        {actions}
      </div>
      {children}
    </AdminCard>
  );
}

function Sales({ data, ExportButton }: { data: SalesReport; ExportButton: Exporter }) {
  const m = data.metrics;
  const [metric, setMetric] = useState<"revenue" | "orders">("revenue");
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <DeltaTile label="Revenue" metric={m.revenue} />
        <DeltaTile label="Net of refunds" metric={m.netRevenue} />
        <DeltaTile label="Orders" metric={m.orders} />
        <DeltaTile label="Average order" metric={m.averageOrderValue} />
        <DeltaTile label="Units sold" metric={m.units} />
        <DeltaTile label="Buyers" metric={m.buyers} />
        <DeltaTile label="Refunded" metric={m.refunds} invert />
        <DeltaTile label="Discounts given" metric={m.discounts} invert />
        <DeltaTile label="Tax collected" metric={m.tax} />
        <DeltaTile label="Delivery charged" metric={m.shipping} />
        <DeltaTile label="Cancelled orders" metric={m.cancelled} invert />
      </div>
      <Card title={`${metric === "revenue" ? "Revenue" : "Orders"} by ${data.granularity}`} actions={
        <div className="flex items-center gap-1">
          <AdminButton size="sm" variant={metric === "revenue" ? "secondary" : "ghost"} onClick={() => setMetric("revenue")}>Revenue</AdminButton>
          <AdminButton size="sm" variant={metric === "orders" ? "secondary" : "ghost"} onClick={() => setMetric("orders")}>Orders</AdminButton>
          <ExportButton kind="sales" />
        </div>
      }>
        <TimeSeriesChart points={data.series} metric={metric} />
        {data.previousSeries ? (
          <p className="mt-2 text-[0.6875rem] text-admin-muted">
            {data.comparison?.label}: {metric === "revenue" ? rupees(data.previousSeries.reduce((s, p) => s + p.revenue, 0)) : data.previousSeries.reduce((s, p) => s + p.orders, 0).toLocaleString("en-IN")}
          </p>
        ) : null}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="By category" actions={<ExportButton kind="categories" />}>
          <BarList data={data.breakdowns.category.map((b) => ({ label: b.label, value: b.revenue ?? 0, meta: `${b.share}% · ${b.units ?? 0} units` }))} valueFormat={rupees} />
        </Card>
        <Card title="By payment method" actions={<ExportButton kind="payment-methods" />}>
          <BarList data={data.breakdowns.paymentMethod.map((b) => ({ label: b.label, value: b.revenue ?? 0, meta: `${b.orders} orders` }))} valueFormat={rupees} />
        </Card>
        <Card title="By delivery state" actions={<ExportButton kind="states" />}>
          <BarList data={data.breakdowns.state.slice(0, 12).map((b) => ({ label: b.label, value: b.revenue ?? 0, meta: `${b.orders} orders` }))} valueFormat={rupees} />
        </Card>
        <Card title="Orders by status">
          <BarList data={data.breakdowns.status.map((b) => ({ label: b.label, value: b.orders ?? 0 }))} />
        </Card>
      </div>
    </div>
  );
}

function Customers({ data, ExportButton }: { data: CustomersReport; ExportButton: Exporter }) {
  const m = data.metrics;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <DeltaTile label="New accounts" metric={m.signups} />
        <DeltaTile label="Buyers" metric={m.buyers} />
        <DeltaTile label="First-time buyers" metric={m.newBuyers} />
        <DeltaTile label="Returning buyers" metric={m.returningBuyers} />
        <DeltaTile label="Bought twice or more" metric={m.repeatRate} />
        <DeltaTile label="Orders per buyer" metric={m.ordersPerBuyer} />
        <Tile label="Lifetime value" value={rupees(data.lifetimeValue)} hint="Average spend per customer, all time" />
      </div>
      <Card title={`New accounts by ${data.granularity}`}>
        <BarList data={data.signupSeries.filter((p) => p.value).map((p) => ({ label: p.label, value: p.value }))} emptyMessage="No new accounts in this period." />
      </Card>
      <Card title="Top customers" actions={<ExportButton kind="customers" />}>
        <SimpleTable head={["Customer", "Orders", "Spent"]} rows={data.topCustomers.map((c) => [<span key="n"><span className="font-medium text-admin-ink">{c.name}</span><span className="block text-admin-muted">{c.email}</span></span>, c.orders, rupees(c.revenue)])} empty="No orders in this period." />
      </Card>
    </div>
  );
}

function Products({ data, ExportButton }: { data: ProductsReport; ExportButton: Exporter }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Tile label="Products that sold" value={String(data.productsSold)} />
        <Tile label="Products without a sale" value={String(data.productsWithoutSales)} tone={data.productsWithoutSales ? "warn" : undefined} />
        <Tile label="Low on stock" value={String(data.lowStock.length)} tone={data.lowStock.length ? "warn" : undefined} />
      </div>
      <Card title="Best sellers" actions={<ExportButton kind="products" />}>
        <SimpleTable head={["Product", "Units", "Revenue", "Viewers", "Bought ÷ viewed", "Returned"]}
          rows={data.topByRevenue.map((p) => [p.name, p.units, rupees(p.revenue), p.views || "—", p.conversion === null ? "—" : `${p.conversion}%`, p.returned ? `${p.returned} (${p.returnRate}%)` : "—"])}
          empty="Nothing sold in this period." />
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Most viewed">
          <BarList data={data.mostViewed.map((p) => ({ label: p.name, value: p.views, meta: `${p.buyers} bought` }))} emptyMessage="No product views recorded in this period." />
        </Card>
        <Card title="Viewed but not bought">
          <BarList data={data.viewedNotBought.map((p) => ({ label: p.name, value: p.views, meta: `${p.addedToBag} added to bag` }))} emptyMessage="Nothing here for this period." />
        </Card>
        <Card title="Most returned">
          <SimpleTable head={["Product", "Returned", "Rate"]} rows={data.highestReturns.map((p) => [p.name, p.returned, `${p.returnRate}%`])} empty="No returns in this period." />
        </Card>
        <Card title="Low on stock now">
          <SimpleTable head={["Product", "Available", "Alert at"]} rows={data.lowStock.map((p) => [p.name, p.available, p.threshold])} empty="Nothing is low." />
        </Card>
      </div>
    </div>
  );
}

function Marketing({ data, ExportButton }: { data: MarketingReport; ExportButton: Exporter }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile label="Referral sign-ups" value={String(data.referrals.signups)} hint={`${data.referrals.rewarded} rewarded`} />
        <Tile label="Referral credit paid" value={rupees(data.referrals.creditCost)} />
        <Tile label="Gift cards sold" value={String(data.giftCards.sold)} hint={rupees(data.giftCards.value)} />
        <Tile label="Paid with credit & points" value={rupees(data.tenders.storeCredit + data.tenders.points)} hint={`Gift cards ${rupees(data.tenders.giftCards)}`} />
        <Tile label="Bags abandoned" value={String(data.abandonedCarts.abandoned)} />
        <Tile label="Bags recovered" value={String(data.abandonedCarts.recovered)} hint={rupees(data.abandonedCarts.recoveredValue)} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Coupons" actions={<ExportButton kind="coupons" />}>
          <SimpleTable head={["Code", "Orders", "Discount", "Revenue"]} rows={data.coupons.map((c) => [c.code, c.orders, rupees(c.discount), rupees(c.revenue)])} empty="No coupons used in this period." />
        </Card>
        <Card title="Flash sales" actions={<ExportButton kind="flash-sales" />}>
          <SimpleTable head={["Sale", "Units", "Revenue", "Customers saved"]} rows={data.flashSales.map((s) => [s.name, s.units, rupees(s.revenue), rupees(s.savings)])} empty="No flash sale orders in this period." />
        </Card>
        <Card title="Bundles" actions={<ExportButton kind="bundles" />}>
          <SimpleTable head={["Bundle", "Orders", "Bundles", "Revenue"]} rows={data.bundles.map((b) => [b.name, b.orders, b.units, rupees(b.revenue)])} empty="No bundles ordered in this period." />
        </Card>
        <Card title="Where visitors came from">
          <BarList data={data.trafficSources.map((s) => ({ label: s.label, value: s.visits }))} emptyMessage="No visits recorded in this period." />
          {data.devices.length ? <p className="mt-3 text-[0.6875rem] text-admin-muted">Devices: {data.devices.map((d) => `${d.label} ${d.visits}`).join(" · ")}</p> : null}
        </Card>
      </div>
    </div>
  );
}

function Funnel({ data, ExportButton }: { data: FunnelReport; ExportButton: Exporter }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Visitor to purchase" value={data.conversionRate === null ? "—" : `${data.conversionRate}%`} />
      </div>
      <Card title="From visit to purchase" actions={<ExportButton kind="funnel" />}>
        <BarList scale="ordinal" data={data.stages.map((s) => ({
          label: s.label, value: s.count,
          meta: [s.fromPrevious !== null ? `${s.fromPrevious}% of the step before` : null, s.previous !== undefined ? `before: ${s.previous}` : null].filter(Boolean).join(" · "),
        }))} />
        <p className="mt-3 text-[0.6875rem] text-admin-muted">{data.note}</p>
      </Card>
    </div>
  );
}

function SimpleTable({ head, rows, empty }: { head: string[]; rows: React.ReactNode[][]; empty: string }) {
  if (!rows.length) return <p className="py-6 text-center text-xs text-admin-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[28rem] text-left text-xs">
        <thead className="text-admin-muted"><tr>{head.map((h, i) => <th key={h} className={cn(TH, "px-2", i && "text-right")}>{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-admin-border">
          {rows.map((row, r) => <tr key={r}>{row.map((cell, i) => <td key={i} className={cn(TD, "px-2", i && "text-right tabular-nums")}>{cell}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}
