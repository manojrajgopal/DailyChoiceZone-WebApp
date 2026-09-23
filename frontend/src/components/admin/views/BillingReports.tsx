"use client";

import { useState } from "react";
import { Download } from "lucide-react";

import type { AnalyticsRange } from "@/types/admin";
import type { BillingStats, TaxReportRow } from "@/types";

import { AdminButton, AdminCard } from "@/components/admin/ui/AdminChrome";
import { useAdminResource } from "@/hooks/useAdminResource";
import { datedFilename, downloadCsv, toCsv } from "@/lib/billing/csv";
import { cn } from "@/lib/utils/cn";
import { formatMoney } from "@/lib/money";
import { billingDataSource } from "@/services/billing/billing-data-source.instance";
import { toast } from "@/store/toastStore";

/**
 * The billing half of the reports page.
 *
 * Revenue, tax, payments and refunds, over the same range the page's other
 * reports use — a page where two halves answer for different periods is a page
 * that produces wrong conclusions.
 *
 * Gross, net and collected are shown separately because they are different
 * questions: gross is what was invoiced, collected is what arrived, net is what
 * was kept after refunds. Collapsing them into one "revenue" figure is how a
 * business ends up surprised by its own bank balance.
 */

const RANGE_DAYS: Record<AnalyticsRange, number | null> = {
  today: 1,
  "7d": 7,
  "30d": 30,
  "3m": 90,
  "1y": 365,
};

export function BillingReports({ range }: { range: AnalyticsRange }) {
  /**
   * "Now", captured once per mount.
   *
   * Reading the clock during render makes the component impure and lets the
   * reporting window drift while the page is open — a report whose period
   * moves as you read it is not a report.
   */
  const [now] = useState(() => Date.now());

  const days = RANGE_DAYS[range] ?? null;
  const from = days === null ? undefined : new Date(now - days * 86400000).toISOString();

  const { data: stats, isLoading } = useAdminResource<BillingStats>(
    () => billingDataSource.getStats(from),
    [from],
  );
  const { data: taxRows } = useAdminResource<TaxReportRow[]>(
    () => billingDataSource.getTaxReport(from),
    [from],
  );

  const exportRevenue = () => {
    if (!stats) return;
    const rows = [
      ["Gross sales (invoiced)", stats.revenue],
      ["Collected", stats.paid],
      ["Outstanding", stats.pending],
      ["Refunds", stats.refunded],
      ["Net sales", stats.netSales],
      ["Tax collected", stats.taxCollected],
      ["Shipping revenue", stats.shippingRevenue],
      ["Coupon discounts", stats.discountsGiven],
    ] as const;

    const csv = toCsv(
      rows.map(([metric, value]) => ({ metric, value })),
      [
        { header: "Metric", value: (row) => row.metric },
        { header: "Amount", value: (row) => formatMoney(row.value, { showDecimals: true }) },
      ],
    );
    downloadCsv(datedFilename(`revenue-report-${range}`), csv);
    toast.success("Revenue report exported");
  };

  const exportTax = () => {
    if (!taxRows) return;
    const csv = toCsv(taxRows, [
      { header: "Rate", value: (row) => `${row.ratePercent}%` },
      { header: "Taxable value", value: (row) => formatMoney(row.taxableAmount, { showDecimals: true }) },
      { header: "CGST", value: (row) => formatMoney(row.cgst, { showDecimals: true }) },
      { header: "SGST", value: (row) => formatMoney(row.sgst, { showDecimals: true }) },
      { header: "IGST", value: (row) => formatMoney(row.igst, { showDecimals: true }) },
      { header: "Total tax", value: (row) => formatMoney(row.totalTax, { showDecimals: true }) },
      { header: "Invoices", value: (row) => row.invoiceCount },
    ]);
    downloadCsv(datedFilename(`tax-report-${range}`), csv);
    toast.success("Tax report exported");
  };

  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      {/* ------------------------------------------------- revenue report */}
      <AdminCard
        title="Revenue report"
        description="Invoiced, collected and what was kept."
        action={
          <AdminButton size="sm" variant="ghost" onClick={exportRevenue} disabled={!stats}>
            <Download className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
            CSV
          </AdminButton>
        }
      >
        {isLoading || !stats ? (
          <div className="h-48 animate-pulse rounded-[3px] bg-admin-raised" />
        ) : (
          <dl className="flex flex-col gap-3">
            <Metric label="Gross sales (invoiced)" value={stats.revenue} />
            <Metric label="Collected" value={stats.paid} tone="good" />
            <Metric label="Outstanding" value={stats.pending} tone="warning" />
            <Metric label="Refunds" value={stats.refunded} tone="critical" negative />
            <Metric label="Net sales" value={stats.netSales} emphasis />
            <Metric label="Shipping revenue" value={stats.shippingRevenue} />
            <Metric label="Coupon discounts" value={stats.discountsGiven} negative />
          </dl>
        )}
      </AdminCard>

      {/* ----------------------------------------------------- tax report */}
      <AdminCard
        title="Tax report"
        description="By rate, the way a return is filed."
        action={
          <AdminButton size="sm" variant="ghost" onClick={exportTax} disabled={!taxRows}>
            <Download className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
            CSV
          </AdminButton>
        }
      >
        {!taxRows || taxRows.length === 0 ? (
          <p className="py-8 text-center text-xs text-admin-muted">No tax collected in range.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[26rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-admin-border text-left">
                  <th scope="col" className="pb-2 text-[0.625rem] font-medium uppercase tracking-[0.1em] text-admin-muted">
                    Rate
                  </th>
                  {["Taxable", "CGST", "SGST", "IGST", "Total", "Invoices"].map((header) => (
                    <th
                      key={header}
                      scope="col"
                      className="pb-2 text-right text-[0.625rem] font-medium uppercase tracking-[0.1em] text-admin-muted"
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {taxRows.map((row) => (
                  <tr key={row.ratePercent} className="border-b border-admin-border last:border-0">
                    <td className="py-2 text-xs tabular-nums text-admin-ink">{row.ratePercent}%</td>
                    <Cell>{formatMoney(row.taxableAmount, { showDecimals: true })}</Cell>
                    <Cell>{formatMoney(row.cgst, { showDecimals: true })}</Cell>
                    <Cell>{formatMoney(row.sgst, { showDecimals: true })}</Cell>
                    <Cell>{formatMoney(row.igst, { showDecimals: true })}</Cell>
                    <Cell strong>{formatMoney(row.totalTax, { showDecimals: true })}</Cell>
                    <Cell>{row.invoiceCount}</Cell>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3 border-t border-admin-border pt-3 text-[0.6875rem] leading-relaxed text-admin-faint">
          A representation of GST for demonstration, not a compliance report. Do not file from it.
        </p>
      </AdminCard>

      {/* ------------------------------------------------ payments + refunds */}
      <AdminCard title="Payment report" description="Transactions in this period.">
        {isLoading || !stats ? (
          <div className="h-24 animate-pulse rounded-[3px] bg-admin-raised" />
        ) : (
          <dl className="flex flex-col gap-3">
            <Count label="Payments recorded" value={stats.paymentCount} />
            <Metric label="Total collected" value={stats.paid} tone="good" />
            <Count label="Invoices raised" value={stats.invoiceCount} />
          </dl>
        )}
      </AdminCard>

      <AdminCard title="Refund report" description="What went back out.">
        {isLoading || !stats ? (
          <div className="h-24 animate-pulse rounded-[3px] bg-admin-raised" />
        ) : (
          <dl className="flex flex-col gap-3">
            <Count label="Refunds raised" value={stats.refundCount} />
            <Metric label="Refunded" value={stats.refunded} tone="critical" negative />
            <Count label="Credit notes" value={stats.creditNoteCount} />
            <Metric
              label="Refund rate"
              value={0}
              override={
                stats.revenue > 0
                  ? `${((stats.refunded / stats.revenue) * 100).toFixed(1)}%`
                  : "0%"
              }
            />
          </dl>
        )}
      </AdminCard>
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function Metric({
  label,
  value,
  tone,
  emphasis,
  negative,
  override,
}: {
  label: string;
  value: number;
  tone?: "good" | "warning" | "critical";
  emphasis?: boolean;
  negative?: boolean;
  override?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-admin-border pb-2.5 last:border-0 last:pb-0">
      <dt className="text-xs text-admin-muted">{label}</dt>
      <dd
        className={cn(
          "tabular-nums",
          emphasis ? "text-base font-semibold" : "text-sm font-medium",
          tone === "good"
            ? "text-status-good"
            : tone === "warning"
              ? "text-status-serious"
              : tone === "critical"
                ? "text-status-critical"
                : "text-admin-ink",
        )}
      >
        {override ?? `${negative && value > 0 ? "− " : ""}${formatMoney(value)}`}
      </dd>
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-admin-border pb-2.5 last:border-0 last:pb-0">
      <dt className="text-xs text-admin-muted">{label}</dt>
      <dd className="text-sm font-medium tabular-nums text-admin-ink">
        {value.toLocaleString("en-IN")}
      </dd>
    </div>
  );
}

function Cell({ children, strong }: { children: React.ReactNode; strong?: boolean }) {
  return (
    <td
      className={cn(
        "py-2 text-right text-xs tabular-nums",
        strong ? "font-medium text-admin-ink" : "text-admin-muted",
      )}
    >
      {children}
    </td>
  );
}
